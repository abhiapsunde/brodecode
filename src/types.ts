export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; thinking?: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ParsedResponse {
  thinking?: string;
  text: string;
  toolCalls: ToolCall[];
}
