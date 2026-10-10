import type { Message, ToolCall, ToolDefinition } from './types.js';
import { renderPrompt } from './prompt.js';
import { complete } from './runner.js';
import { parseResponse } from './parse.js';
import { toolDefinitions, ToolExecutor } from './tools.js';
import { config } from './config.js';

export interface TurnEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'final';
  content: string;
  // Only set for 'tool_call' - the raw call, so a display layer can
  // build a per-tool-aware summary (e.g. "write(file.js, 635 bytes)")
  // instead of the flattened content string, which for write/edit
  // carries a full file as an escaped JSON argument.
  toolCall?: ToolCall;
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

/** Splits history into exchanges: each is either a lone user message,
 *  or an assistant reply plus whatever tool results immediately
 *  followed it. Finer-grained than splitting on user turns alone - a
 *  single open-ended task ("fix the failing tests") can rack up a
 *  dozen-plus tool-call round trips without the user ever sending a
 *  second message, so turn-level dropping has nothing to drop in that
 *  case even though the history has plenty of old, droppable
 *  exchanges in it. Splitting an assistant message from its own tool
 *  results, or vice versa, would leave a dangling reference the model
 *  never asked for and can't make sense of - this keeps each pairing
 *  intact as one unit. */
function splitIntoExchanges(history: Message[]): Message[][] {
  const exchanges: Message[][] = [];
  let current: Message[] = [];
  for (const m of history) {
    if ((m.role === 'user' || m.role === 'assistant') && current.length > 0) {
      exchanges.push(current);
      current = [];
    }
    current.push(m);
  }
  if (current.length > 0) exchanges.push(current);
  return exchanges;
}

/** Drops the oldest exchanges - always keeping the first (whatever
 *  user message actually states the task at hand - losing that turns
 *  "fix the tests" into aimless wandering) and the most recent ones -
 *  until the rendered prompt fits the budget. If even just [first +
 *  most recent] is still over budget, there's nothing structural left
 *  to cut, so fall back to shrinking oversized tool results across
 *  what remains. Mutates `history` in place: once content is out of
 *  the model's context, there's no reason to keep pretending it's
 *  still part of the conversation. */
export function trimToBudget(history: Message[], tools: ToolDefinition[], workingDir: string): void {
  const exchanges = splitIntoExchanges(history);

  while (
    exchanges.length > 2 &&
    estimateTokens(renderPrompt(exchanges.flat(), tools, workingDir)) > PROMPT_TOKEN_BUDGET
  ) {
    exchanges.splice(1, 1); // drop the oldest exchange after the first
  }

  // One-shot truncation to a fixed size isn't guaranteed to be enough
  // (many results each just under the cap can still sum over budget),
  // so shrink the cap and re-check until it actually fits or there's
  // nothing left to cut.
  let cap = INITIAL_TOOL_RESULT_CAP;
  while (
    cap >= MIN_TOOL_RESULT_CAP &&
    estimateTokens(renderPrompt(exchanges.flat(), tools, workingDir)) > PROMPT_TOKEN_BUDGET
  ) {
    for (const group of exchanges) {
      for (const m of group) {
        if (m.role === 'tool' && m.content.length > cap) {
          m.content = m.content.slice(0, cap) + '\n...(truncated - too large to fit in context)';
        }
      }
    }
    cap = Math.floor(cap / 2);
  }

  history.length = 0;
  history.push(...exchanges.flat());
}

/** Runs one user turn to completion (possibly many tool round-trips),
 *  yielding events as they happen so the CLI can print live rather than
 *  waiting for the whole thing to finish. Mutates `history` in place so
 *  the caller's conversation state stays current across turns.
 *
 *  `onToken` fires for every raw chunk the model streams back, before
 *  any parsing, with the 1-based tool-call round it belongs to - this
 *  is what lets the CLI show it's actually doing something, and how
 *  far into the turn limit it is, instead of sitting in silence for
 *  however many seconds a turn takes. */
export async function* runTurn(
  history: Message[],
  userMessage: string,
  tools: ToolExecutor,
  onToken?: (chunk: string, round: number) => void,
): AsyncGenerator<TurnEvent> {
  history.push({ role: 'user', content: userMessage });

  for (let turn = 0; turn < config.maxTurns; turn++) {
    trimToBudget(history, toolDefinitions, tools.workingDir);
    const prompt = renderPrompt(history, toolDefinitions, tools.workingDir);
    // The round number is the single most useful thing the status
    // line can add: "thinking" on round 2 and "thinking" on round 17
    // of a 20-round limit mean very different things about whether
    // this is going to finish.
    const raw = await complete(prompt, onToken && ((chunk) => onToken(chunk, turn + 1)));
    const parsed = parseResponse(raw);

    if (parsed.thinking) {
      yield { type: 'thinking', content: parsed.thinking };
    }

    if (parsed.toolCalls.length === 0) {
      if (!parsed.text.trim() && parsed.thinking) {
        // No answer and no tool call, but there was reasoning - the
        // turn got cut off mid-thought before it reached a
        // conclusion, not a deliberate empty response. Recording it
        // as "final" would show the user a blank result and dead-end
        // the conversation. Keep the partial reasoning in history
        // (closed off, as far as the model can tell) and let the next
        // loop iteration try again instead - it still counts against
        // maxTurns, so this can't loop forever.
        history.push({ role: 'assistant', content: '', thinking: parsed.thinking });
        continue;
      }
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
      yield { type: 'tool_call', content: `${call.name}(${JSON.stringify(call.arguments)})`, toolCall: call };
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
