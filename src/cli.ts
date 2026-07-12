#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message } from './types.js';
import { runTurn } from './agent.js';
import { ToolExecutor } from './tools.js';
import { config } from './config.js';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const THINKING_PREVIEW_CHARS = 180;

/** brodecode's own repo dir, so we can refuse to ever run against it -
 *  the accident this is guarding against: running `node dist/cli.js`
 *  with no argument from inside this project's own directory, which
 *  silently defaulted to cwd and let a tool call run `npm init -y` and
 *  overwrite this project's own package.json. */
const selfDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function resolveWorkingDir(): Promise<string> {
  const arg = process.argv[2];
  if (!arg) {
    console.error(red('usage: brodecode <working-directory>'));
    console.error(dim('a working directory is required - it is never inferred from where you happen to be running this from.'));
    process.exit(1);
  }
  const resolved = path.resolve(arg);
  if (resolved === selfDir || resolved.startsWith(selfDir + path.sep)) {
    console.error(red(`refusing to run against ${resolved} - that's inside brodecode's own repo, not a project directory.`));
    process.exit(1);
  }
  await fs.mkdir(resolved, { recursive: true });
  return resolved;
}

async function main() {
  const workingDir = await resolveWorkingDir();
  const tools = new ToolExecutor(workingDir);
  const history: Message[] = [];

  console.log(`brodecode - working dir: ${workingDir}`);
  console.log(dim(`model runner: ${config.llamaServerUrl}\n`));

  const rl = readline.createInterface({ input: stdin, output: stdout });
  let closed = false;
  rl.on('close', () => { closed = true; });

  for (;;) {
    if (closed) break;
    let userMessage: string;
    try {
      userMessage = await rl.question('> ');
    } catch {
      break; // stdin closed mid-question (e.g. piped input reached EOF)
    }
    if (!userMessage.trim()) continue;
    if (userMessage.trim() === '/exit') break;

    // Live progress while the model is actually generating - the fix
    // for "is it working, stuck, or failed, no idea". A single
    // overwriting status line driven by real streamed tokens (so it's
    // never lying about progress), not a dump of the raw stream -
    // that turned out to be its own kind of noisy and hard to read.
    const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let spinnerIdx = 0;
    let tokenCount = 0;
    let streaming = false;
    const onToken = () => {
      tokenCount++;
      streaming = true;
      spinnerIdx = (spinnerIdx + 1) % spinnerFrames.length;
      process.stdout.write(`\r${dim(`${spinnerFrames[spinnerIdx]} generating... (${tokenCount} tokens)`)}`);
    };

    try {
      for await (const event of runTurn(history, userMessage, tools, onToken)) {
        if (streaming) {
          process.stdout.write('\r\x1b[2K'); // clear the spinner line entirely
          streaming = false;
          tokenCount = 0;
        }
        switch (event.type) {
          case 'thinking': {
            const preview = event.content.length > THINKING_PREVIEW_CHARS
              ? event.content.slice(0, THINKING_PREVIEW_CHARS).trim() + '...'
              : event.content;
            console.log(dim(`[thinking] ${preview.replace(/\n+/g, ' ')}`));
            break;
          }
          case 'tool_call':
            console.log(yellow(`→ ${event.content}`));
            break;
          case 'tool_result': {
            const lines = event.content.split('\n');
            const preview = lines.slice(0, 5).join('\n');
            console.log(dim(preview + (lines.length > 5 ? `\n  ... (${lines.length - 5} more lines)` : '')));
            break;
          }
          case 'final':
            console.log(`\n${green(event.content)}\n`);
            break;
        }
      }
    } catch (err) {
      if (streaming) process.stdout.write('\r\x1b[2K');
      console.error(red(`turn failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error(cyan('brodecode crashed:'), err);
  process.exit(1);
});
