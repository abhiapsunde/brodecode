import type { ParsedResponse, ToolCall } from './types.js';

let toolCallCounter = 0;

/** Splits raw model output into thinking, real tool calls, and leftover text. */
export function parseResponse(raw: string): ParsedResponse {
  let text = raw;

  // Tool calls are extracted first, from the full raw text, before
  // thinking is touched. Qwen3 sometimes emits <tool_call> nested
  // inside its own <think>...</think> block instead of after it -
  // observed repeatedly once a session loops on a failing command
  // ("<think> ... <tool_call>{...}</tool_call> ...</think>"). Matching
  // <think> first and discarding its whole span would silently eat
  // those calls: the model genuinely decided to act, but the harness
  // would never run anything, and the turn burns down to the maxTurns
  // limit with no new information each time.
  const toolCalls: ToolCall[] = [];
  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match: RegExpExecArray | null;
  while ((match = toolCallRegex.exec(text)) !== null) {
    const body = match[1].trim();
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.name === 'string' && typeof parsed.arguments === 'object') {
        toolCalls.push({
          id: `call_${++toolCallCounter}`,
          name: parsed.name,
          arguments: parsed.arguments ?? {},
        });
      }
    } catch {
      // Malformed tool_call JSON - deliberately not silently dropped.
      // Surfaced as plain text below so it's visible instead of
      // vanishing, since a model producing this at all is itself a
      // signal worth seeing during development.
    }
  }
  text = text.replace(toolCallRegex, '').trim();

  let thinking: string | undefined;
  const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/);
  if (thinkMatch) {
    thinking = thinkMatch[1].trim();
    text = text.replace(thinkMatch[0], '');
  } else {
    // Generation can get cut off mid-reasoning (hit the per-turn token
    // budget before closing the tag). Without this, the raw, unclosed
    // "<think>" text - reasoning, not an answer - falls straight
    // through as the final response instead of being recognized as
    // thinking. See agent.ts for how a resulting empty final answer
    // gets treated as a cue to let the model continue instead of
    // showing the user a blank result.
    const openIdx = text.indexOf('<think>');
    if (openIdx !== -1) {
      thinking = text.slice(openIdx + '<think>'.length).trim();
      text = text.slice(0, openIdx);
    }
  }

  text = text.trim();
  return { thinking, text, toolCalls };
}
