#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Message } from './types.js';
import { runTurn } from './agent.js';
import { ToolExecutor } from './tools.js';
import { config } from './config.js';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

async function main() {
  const workingDir = process.argv[2] ?? process.cwd();
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

    for await (const event of runTurn(history, userMessage, tools)) {
      switch (event.type) {
        case 'thinking':
          console.log(dim(`\n[thinking]\n${event.content}\n`));
          break;
        case 'tool_call':
          console.log(yellow(`\n→ ${event.content}`));
          break;
        case 'tool_result':
          console.log(dim(event.content.split('\n').slice(0, 10).join('\n')));
          break;
        case 'final':
          console.log(`\n${green(event.content)}\n`);
          break;
      }
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error(cyan('brodecode crashed:'), err);
  process.exit(1);
});
