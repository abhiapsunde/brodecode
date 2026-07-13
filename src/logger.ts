import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// One JSONL file per session, deliberately terser than what the CLI
// prints to the terminal (which is itself already trimmed for a human
// watching live) - this exists so a session can be tailed and judged
// after the fact without re-reading spinner/ANSI noise: what did the
// model actually do, in what order, and how big was each step.
const THINKING_LOG_CHARS = 300;
const TOOL_RESULT_LOG_CHARS = 500;

export interface LoggableEvent {
  type: string;
  content: string;
}

export class SessionLogger {
  readonly filePath: string;

  constructor(workingDir: string, label?: string) {
    const logDir = process.env.BRODECODE_LOG_DIR ?? path.join(os.homedir(), '.brodecode', 'logs');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.basename(workingDir);
    const labelPart = label ? `-${label.replace(/[^a-zA-Z0-9_-]+/g, '_')}` : '';
    this.filePath = path.join(logDir, `${stamp}-${base}${labelPart}.jsonl`);
  }

  async init(workingDir: string, label?: string): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.write({ type: 'session_start', content: JSON.stringify({ workingDir, label: label ?? null }) });
  }

  async logUser(content: string): Promise<void> {
    await this.write({ type: 'user', content });
  }

  async logEvent(event: LoggableEvent): Promise<void> {
    let content = event.content;
    if (event.type === 'thinking' && content.length > THINKING_LOG_CHARS) {
      content = content.slice(0, THINKING_LOG_CHARS) + '...';
    }
    if (event.type === 'tool_result' && content.length > TOOL_RESULT_LOG_CHARS) {
      content = content.slice(0, TOOL_RESULT_LOG_CHARS) + `...(truncated for log, ${event.content.length} chars total)`;
    }
    await this.write({ type: event.type, content });
  }

  async logError(content: string): Promise<void> {
    await this.write({ type: 'error', content });
  }

  private async write(event: LoggableEvent): Promise<void> {
    const line = JSON.stringify({ t: new Date().toISOString(), ...event });
    await fs.appendFile(this.filePath, line + '\n', 'utf-8');
  }
}
