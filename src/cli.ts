#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message, ToolCall } from './types.js';
import { runTurn } from './agent.js';
import { ToolExecutor } from './tools.js';
import { config } from './config.js';
import { SessionLogger } from './logger.js';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

/** The model writes real Markdown in its final answer (**bold**,
 *  `code`) - printed raw, that's just literal asterisks and
 *  backticks cluttering the terminal. Renders the common cases as
 *  ANSI instead. Assumes it's used inside an outer green(...) wrap
 *  (the final-answer case below) - resets restore green rather than
 *  the terminal default, so the surrounding color isn't cut short. */
function renderMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '\x1b[1m$1\x1b[22m')
    .replace(/`([^`]+)`/g, '\x1b[36m$1\x1b[32m');
}

const TOOL_CALL_PREVIEW_CHARS = 200;
const BASH_COMMAND_PREVIEW_CHARS = 150;

/** Per-tool-aware one-line summary for the live terminal display -
 *  write/edit carry a full file's content as a JSON argument, so
 *  blindly printing JSON.stringify(call) either dumps a huge escaped
 *  blob or gets truncated mid-string. Show what a human actually
 *  wants to know at a glance (which file, how much changed) instead.
 *  The full call always still goes to the session log unabridged. */
function formatToolCall(call: ToolCall): string {
  const args = call.arguments as Record<string, unknown>;
  switch (call.name) {
    case 'write':
      return `write(${args.file_path}, ${String(args.content ?? '').length} bytes)`;
    case 'edit':
      return `edit(${args.file_path}, ${String(args.old_string ?? '').length} chars -> ${String(args.new_string ?? '').length} chars)`;
    case 'bash': {
      const command = String(args.command ?? '');
      const preview = command.length > BASH_COMMAND_PREVIEW_CHARS
        ? command.slice(0, BASH_COMMAND_PREVIEW_CHARS) + '...'
        : command;
      return `bash(${preview})`;
    }
    case 'read':
      return `read(${args.file_path})`;
    case 'glob':
      return `glob(${args.pattern})`;
    case 'grep':
      return `grep(${args.pattern}${args.path ? `, ${args.path}` : ''})`;
    default: {
      const raw = `${call.name}(${JSON.stringify(call.arguments)})`;
      return raw.length > TOOL_CALL_PREVIEW_CHARS
        ? raw.slice(0, TOOL_CALL_PREVIEW_CHARS) + `... (${raw.length - TOOL_CALL_PREVIEW_CHARS} more chars)`
        : raw;
    }
  }
}

/** brodecode's own repo dir, so we can refuse to ever run against it -
 *  the accident this is guarding against: running `node dist/cli.js`
 *  with no argument from inside this project's own directory, which
 *  silently defaulted to cwd and let a tool call run `npm init -y` and
 *  overwrite this project's own package.json. */
const selfDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function resolveWorkingDir(): Promise<string> {
  // Standard CLI convention (matches git, npm, etc.): operate on wherever
  // you launched from, unless told otherwise with an explicit argument.
  // The one guardrail that actually matters is refusing to ever run
  // against brodecode's own repo, whether that came from the default or
  // an explicit path - that's the specific accident this is preventing,
  // not "no default at all".
  const arg = process.argv[2];
  const resolved = path.resolve(arg ?? process.cwd());
  if (resolved === selfDir || resolved.startsWith(selfDir + path.sep)) {
    console.error(red(`refusing to run against ${resolved} - that's inside brodecode's own repo, not a project directory.`));
    console.error(dim('cd somewhere else first, or pass an explicit path: brodecode <working-directory>'));
    process.exit(1);
  }
  await fs.mkdir(resolved, { recursive: true });
  return resolved;
}

async function main() {
  const workingDir = await resolveWorkingDir();
  const tools = new ToolExecutor(workingDir);
  const history: Message[] = [];

  const logger = new SessionLogger(workingDir, process.env.BRODECODE_SESSION_LABEL);
  await logger.init(workingDir, process.env.BRODECODE_SESSION_LABEL);

  console.log(`brodecode - working dir: ${workingDir}`);
  console.log(dim(`model runner: ${config.llamaServerUrl}`));
  console.log(dim(`session log: ${logger.filePath}\n`));

  const rl = readline.createInterface({ input: stdin, output: stdout });

  // Deliberately not rl.question() in a loop: readline's 'close' event
  // fires as soon as the input stream hits EOF, which for piped/non-TTY
  // input happens almost immediately - long before a slow async model
  // call for the first line finishes. Polling a "closed" flag at the
  // top of the loop then races that, silently dropping every line
  // after the first for any scripted/piped input (a live TTY never
  // hits EOF mid-session, so this was invisible in normal manual use).
  // The async-iterator form doesn't have that race: each iteration
  // pulls exactly one already-buffered line, however long the
  // previous one took to process.
  process.stdout.write('> ');
  for await (const userMessage of rl) {
    if (!userMessage.trim()) {
      process.stdout.write('> ');
      continue;
    }
    if (userMessage.trim() === '/exit') break;

    await logger.logUser(userMessage);

    // Live progress while the model is actually generating - the fix
    // for "is it working, stuck, or failed, no idea". A single
    // overwriting status line driven by real streamed tokens (so it's
    // never lying about progress), showing a live tail of what's
    // actually being generated rather than just a token count - this
    // is also where thinking becomes visible: live, while it's
    // happening, then gone once it resolves (see the 'thinking' case
    // below, which deliberately prints nothing permanent).
    const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let spinnerIdx = 0;
    let streaming = false;
    // Two rounds of just tuning the interval (200ms, then 600ms)
    // still read as uncomfortable to look at - the actual problem
    // wasn't speed, it was a *sliding* window: every redraw showed a
    // different arbitrary substring, so the start of the line jumped
    // around unpredictably each time, which is what reads as motion/
    // flicker rather than text. Fix: stop sliding. Text only ever
    // grows left-to-right (pure append, nothing at the start ever
    // changes) until it hits a width cap, then does one clean reset -
    // like a page turning, not a window shuffling. Growth-only redraws
    // are calm enough to redraw fairly often; the only "jump" is the
    // occasional full reset, which is rare and reads as a clean
    // transition instead of constant jitter.
    let currentPage = '';
    let lastRenderAt = 0;
    const RENDER_INTERVAL_MS = 300;
    const PAGE_WIDTH_CHARS = 100;
    const onToken = (chunk: string) => {
      streaming = true;
      currentPage += chunk.replace(/\s+/g, ' ');
      if (currentPage.length > PAGE_WIDTH_CHARS) {
        currentPage = '';
      }
      const now = Date.now();
      if (now - lastRenderAt < RENDER_INTERVAL_MS) return;
      lastRenderAt = now;
      spinnerIdx = (spinnerIdx + 1) % spinnerFrames.length;
      process.stdout.write(`\r\x1b[2K${dim(`${spinnerFrames[spinnerIdx]} ${currentPage}`)}`);
    };

    try {
      for await (const event of runTurn(history, userMessage, tools, onToken)) {
        if (streaming) {
          process.stdout.write('\r\x1b[2K'); // clear the spinner line entirely
          streaming = false;
          currentPage = '';
        }
        await logger.logEvent(event);
        switch (event.type) {
          case 'thinking':
            // Deliberately no permanent output here. Thinking was
            // already visible live while it streamed (onToken's tail
            // preview, above) - printing it again now would mean
            // every turn leaves a reasoning transcript in scrollback
            // forever, which is exactly the "too much stays on
            // screen" complaint this is fixing. Reasoning is
            // transient by nature; tool calls, results, and the final
            // answer are what's durable. The full text is still in
            // the session log if it's ever needed later.
            break;
          case 'tool_call': {
            // write()/edit() calls carry full file content as a JSON
            // argument - unlike tool_result, this had no cap at all,
            // so a single write() could dump a thousand-plus-char
            // wall of escaped JSON onto one terminal line. The full
            // call still goes to the session log unabridged.
            const preview = event.toolCall ? formatToolCall(event.toolCall) : event.content;
            console.log(yellow(`→ ${preview}`));
            break;
          }
          case 'tool_result': {
            const lines = event.content.split('\n');
            const preview = lines.slice(0, 5).join('\n');
            console.log(dim(preview + (lines.length > 5 ? `\n  ... (${lines.length - 5} more lines)` : '')));
            break;
          }
          case 'final':
            console.log(`\n${green(renderMarkdown(event.content))}\n`);
            break;
        }
      }
    } catch (err) {
      if (streaming) process.stdout.write('\r\x1b[2K');
      const message = err instanceof Error ? err.message : String(err);
      console.error(red(`turn failed: ${message}`));
      await logger.logError(message);
    }

    process.stdout.write('> ');
  }

  rl.close();
}

main().catch((err) => {
  console.error(cyan('brodecode crashed:'), err);
  process.exit(1);
});
