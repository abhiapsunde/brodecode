import type { Message, ToolDefinition } from './types.js';

// Deliberately small. Claude Code's real default system prompt runs to
// ~25 tools and ~100KB - that's the thing that overwhelmed every local
// model tried today, not model capability. This is the opposite bet:
// exactly six tools, described once, briefly, and nothing else.
function buildSystemPrompt(tools: ToolDefinition[], workingDir: string): string {
  const toolList = tools
    .map((t) => `- ${t.name}(${JSON.stringify(t.parameters)}): ${t.description}`)
    .join('\n');
  return `You are a coding assistant with direct access to a project's files and a shell. You can call tools to accomplish tasks.

Your entire scope is this one directory: ${workingDir}
When the user says "this repo", "this project", or asks what's in "here", they always mean that directory and nothing else - not wherever this program happens to be installed, not any other project you may know about. All file paths in tool calls are relative to it unless you give an absolute path.

Available tools:
${toolList}

To call a tool, respond with exactly this format and nothing else on that line:
<tool_call>
{"name": "<tool name>", "arguments": {<arguments as JSON>}}
</tool_call>

You may call more than one tool in a single response by using multiple <tool_call> blocks. After a tool result comes back, decide whether to call another tool or give your final answer as plain text. Never describe what a tool call would do instead of making it - always call the real tool. Never claim a file was written, a command ran, or a service is running unless you actually called the tool and saw its result.`;
}

/** Renders the full ChatML prompt text llama-server's raw /completion endpoint expects. */
export function renderPrompt(messages: Message[], tools: ToolDefinition[], workingDir: string): string {
  const parts: string[] = [];
  parts.push(`<|im_start|>system\n${buildSystemPrompt(tools, workingDir)}<|im_end|>`);

  for (const m of messages) {
    if (m.role === 'user') {
      parts.push(`<|im_start|>user\n${m.content}<|im_end|>`);
    } else if (m.role === 'tool') {
      parts.push(`<|im_start|>user\n<tool_response>\n${m.content}\n</tool_response><|im_end|>`);
    } else {
      // assistant turn - only reconstruct what the model actually said,
      // tool_call blocks included, so history stays faithful to what
      // was really sent/received rather than a paraphrase of it.
      let body = '';
      if (m.thinking) body += `<think>\n${m.thinking}\n</think>\n`;
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          body += `<tool_call>\n${JSON.stringify({ name: tc.name, arguments: tc.arguments })}\n</tool_call>\n`;
        }
      } else {
        body += m.content;
      }
      parts.push(`<|im_start|>assistant\n${body}<|im_end|>`);
    }
  }

  parts.push('<|im_start|>assistant\n');
  return parts.join('\n');
}
