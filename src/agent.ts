import type { Message } from './types.js';
import { renderPrompt } from './prompt.js';
import { complete } from './runner.js';
import { parseResponse } from './parse.js';
import { toolDefinitions, ToolExecutor } from './tools.js';
import { config } from './config.js';

export interface TurnEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'final';
  content: string;
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
    const prompt = renderPrompt(history, toolDefinitions);
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
