import type { ParsedResponse, ToolCall } from './types.js';

let toolCallCounter = 0;

/** Splits raw model output into thinking, real tool calls, and leftover text. */
export function parseResponse(raw: string): ParsedResponse {
  let text = raw;
  let thinking: string | undefined;

  const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/);
  if (thinkMatch) {
    thinking = thinkMatch[1].trim();
    text = text.replace(thinkMatch[0], '');
  }

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

  return { thinking, text, toolCalls };
}
