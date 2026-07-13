import type { Message, ToolDefinition } from './types.js';
import { renderPrompt } from './prompt.js';
import { complete } from './runner.js';
import { parseResponse } from './parse.js';
import { toolDefinitions, ToolExecutor } from './tools.js';
import { config } from './config.js';

export interface TurnEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'final';
  content: string;
}

// Rough chars-per-token estimate, biased conservative (code/JSON tends
// to tokenize denser than prose) - not a real tokenizer, just enough
// to trim proactively before llama-server's own count rejects a
// prompt outright with a 400 and loses the whole turn.
const CHARS_PER_TOKEN = 3;
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Room for the model's own reply plus a small safety margin - not the
// full context window, or a reply that actually uses maxTokensPerTurn
// would itself push the total past n_ctx.
const PROMPT_TOKEN_BUDGET = config.contextSize - config.maxTokensPerTurn - 200;

const INITIAL_TOOL_RESULT_CAP = 4000;
const MIN_TOOL_RESULT_CAP = 200;

/** Splits history into per-user-turn chunks (each starting at a
 *  'user' message) so old turns can be dropped as whole units -
 *  dropping a tool result without the assistant message that called
 *  it, or vice versa, would leave a dangling reference the model
 *  never asked for and can't make sense of. */
function splitIntoTurns(history: Message[]): Message[][] {
  const turns: Message[][] = [];
  let current: Message[] = [];
  for (const m of history) {
    if (m.role === 'user' && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(m);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

/** Drops the oldest completed turns - never the turn in progress -
 *  until the rendered prompt fits the budget. If even the single
 *  in-progress turn is over budget on its own (one huge file read or
 *  command output), there's nothing older left to drop, so instead
 *  truncate that turn's own oversized tool results. Mutates `history`
 *  in place: once content is out of the model's context, there's no
 *  reason to keep pretending it's still part of the conversation. */
export function trimToBudget(history: Message[], tools: ToolDefinition[], workingDir: string): void {
  const turns = splitIntoTurns(history);

  while (turns.length > 1 && estimateTokens(renderPrompt(turns.flat(), tools, workingDir)) > PROMPT_TOKEN_BUDGET) {
    turns.shift();
  }

  // A single turn can still be over budget on its own - several large
  // reads/command outputs in one round-trip, say. One-shot truncation
  // to a fixed size isn't guaranteed to be enough (many results each
  // just under the cap still sum over budget), so shrink the cap and
  // re-check until it actually fits or there's nothing left to cut.
  let cap = INITIAL_TOOL_RESULT_CAP;
  while (
    turns.length === 1 &&
    cap >= MIN_TOOL_RESULT_CAP &&
    estimateTokens(renderPrompt(turns[0], tools, workingDir)) > PROMPT_TOKEN_BUDGET
  ) {
    for (const m of turns[0]) {
      if (m.role === 'tool' && m.content.length > cap) {
        m.content = m.content.slice(0, cap) + '\n...(truncated - too large to fit in context)';
      }
    }
    cap = Math.floor(cap / 2);
  }

  history.length = 0;
  history.push(...turns.flat());
}

/** Runs one user turn to completion (possibly many tool round-trips),
 *  yielding events as they happen so the CLI can print live rather than
 *  waiting for the whole thing to finish. Mutates `history` in place so
 *  the caller's conversation state stays current across turns.
 *
 *  `onToken` fires for every raw chunk the model streams back, before
 *  any parsing - this is what lets the CLI show it's actually doing
 *  something instead of sitting in silence for however many seconds a
 *  turn takes. */
export async function* runTurn(
  history: Message[],
  userMessage: string,
  tools: ToolExecutor,
  onToken?: (chunk: string) => void,
): AsyncGenerator<TurnEvent> {
  history.push({ role: 'user', content: userMessage });

  for (let turn = 0; turn < config.maxTurns; turn++) {
    trimToBudget(history, toolDefinitions, tools.workingDir);
    const prompt = renderPrompt(history, toolDefinitions, tools.workingDir);
    const raw = await complete(prompt, onToken);
    const parsed = parseResponse(raw);

    if (parsed.thinking) {
      yield { type: 'thinking', content: parsed.thinking };
    }

    if (parsed.toolCalls.length === 0) {
      history.push({ role: 'assistant', content: parsed.text });
      yield { type: 'final', content: parsed.text };
      return;
    }

    history.push({
      role: 'assistant',
      content: parsed.text,
      thinking: parsed.thinking,
      toolCalls: parsed.toolCalls,
    });

    for (const call of parsed.toolCalls) {
      yield { type: 'tool_call', content: `${call.name}(${JSON.stringify(call.arguments)})` };
      const result = await tools.execute(call);
      yield { type: 'tool_result', content: result };
      history.push({ role: 'tool', toolCallId: call.id, content: result });
    }
  }

  yield {
    type: 'final',
    content: `(stopped after ${config.maxTurns} tool-call rounds without a final answer - this is a safety limit, not necessarily a completed task)`,
  };
}
