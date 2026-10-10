#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message, ToolCall } from './types.js';
import { runTurn } from './agent.js';
import { serverInfo } from './runner.js';
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

  const info = await serverInfo();
  console.log(`brodecode - working dir: ${workingDir}`);
  console.log(dim(info
    ? `model: ${info.model} · ${info.ctx} ctx · ${config.llamaServerUrl}`
    : `model runner: ${config.llamaServerUrl} (not responding to /props)`));
  console.log(dim(`session log: ${logger.filePath}\n`));
  // Short enough to sit in a status line redrawn several times a
  // second without the line wrapping on a narrow terminal.
  const modelLabel = (info?.model ?? 'model').split(/[-_.]/).slice(0, 2).join('-').toLowerCase();

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

    // Third attempt at this. Attempt one printed the reasoning
    // permanently, which buried every session in a transcript nobody
    // reads. Attempt two showed a live tail of the generated text in
    // one line that grew to 100 chars and then reset, which is a
    // marquee: text slides past too fast to read, and resetting makes
    // it worse, so the one thing on screen is the one thing you
    // cannot use.
    //
    // The mistake both times was treating the model's output as the
    // progress indicator. What you actually want to know while
    // waiting is whether it is stuck, and that question is answered
    // by a phase and two counters, not by prose. So: a fixed-width
    // status line where nothing moves except numbers. The reasoning
    // itself is durable in the session log, one summary line in
    // scrollback, and in full on the terminal only if asked for with
    // BRODECODE_SHOW_THINKING=1.
    const showThinking = process.env.BRODECODE_SHOW_THINKING === '1';
    type Phase = 'waiting' | 'thinking' | 'writing' | 'tool call';
    let phase: Phase = 'waiting';
    let tokens = 0;
    let thinkTokens = 0;
    let thinkStartedAt = 0;
    let thinkMs = 0;
    const turnStartedAt = Date.now();
    // Tags can land split across two chunks ("<thi" + "nk>"), so each
    // chunk is searched together with the tail of the previous one.
    let tagTail = '';
    const LONGEST_TAG = '</tool_call>'.length;
    let round = 1;
    // The tool's name arrives in the stream well before the arguments
    // finish, so it can be shown while the model is still writing the
    // call out. Sniffed from a bounded tail of the raw text rather
    // than kept whole: a write() call carries an entire file.
    let pendingTool = '';
    let rawTail = '';
    const RAW_TAIL_CHARS = 400;
    let lastRenderAt = 0;
    const RENDER_INTERVAL_MS = 250;

    const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

    const renderStatus = () => {
      spinnerIdx = (spinnerIdx + 1) % spinnerFrames.length;
      // Phase alone answered "is it stuck" and nothing else. Which
      // model is answering, which tool it is reaching for, and how
      // far into the 20-round limit it is are the three things that
      // turn "something is happening" into "I know what is
      // happening", and all three fit on one line.
      const what = phase === 'tool call' && pendingTool ? `tool call ${pendingTool}` : phase;
      const line = [
        `${spinnerFrames[spinnerIdx]} ${modelLabel}`,
        `round ${round}/${config.maxTurns}`,
        what,
        `${tokens} tok · ${secs(Date.now() - turnStartedAt)}`,
      ].join(' · ');
      process.stdout.write(`\r\x1b[2K${dim(line)}`);
    };

    const enterPhase = (next: Phase) => {
      if (next === phase) return;
      if (phase === 'thinking') thinkMs += Date.now() - thinkStartedAt;
      if (next === 'thinking') thinkStartedAt = Date.now();
      phase = next;
    };

    const onToken = (chunk: string, chunkRound: number) => {
      streaming = true;
      tokens += 1;
      if (phase === 'thinking') thinkTokens += 1;
      if (chunkRound !== round) { round = chunkRound; pendingTool = ''; }

      rawTail = (rawTail + chunk).slice(-RAW_TAIL_CHARS);
      const named = rawTail.match(/"name"\s*:\s*"([a-z_]+)"/i);
      if (named) pendingTool = named[1];

      const window = tagTail + chunk;
      // Later tags win: a single chunk can carry more than one
      // transition, and the last one is the state we are now in.
      let next: Phase | null = null;
      let at = -1;
      for (const [tag, p] of [
        ['<think>', 'thinking'],
        ['</think>', 'writing'],
        ['<tool_call>', 'tool call'],
      ] as [string, Phase][]) {
        const idx = window.lastIndexOf(tag);
        if (idx > at) { at = idx; next = p; }
      }
      if (next) enterPhase(next);
      tagTail = window.slice(-LONGEST_TAG);

      const now = Date.now();
      if (now - lastRenderAt < RENDER_INTERVAL_MS) return;
      lastRenderAt = now;
      renderStatus();
    };

    try {
      for await (const event of runTurn(history, userMessage, tools, onToken)) {
        if (streaming) {
          process.stdout.write('\r\x1b[2K'); // clear the status line entirely
          streaming = false;
        }
        await logger.logEvent(event);
        switch (event.type) {
          case 'thinking': {
            // One durable line, not the transcript. It answers "did
            // it think, and for how long", which is the part worth
            // keeping in scrollback; the reasoning itself is in the
            // session log. BRODECODE_SHOW_THINKING=1 prints the whole
            // thing, wrapped to the terminal rather than dumped as
            // one unbroken line.
            enterPhase('writing'); // closes out the thinking clock if it is still open
            console.log(dim(`  thought for ${secs(thinkMs)} (${thinkTokens} tokens)`));
            if (showThinking && event.content.trim()) {
              const width = Math.max(40, (process.stdout.columns ?? 80) - 4);
              const wrapped = event.content.trim().split(/\s+/).reduce<string[]>((lines, word) => {
                const last = lines[lines.length - 1];
                if (last && (last + ' ' + word).length <= width) lines[lines.length - 1] = last + ' ' + word;
                else lines.push(word);
                return lines;
              }, []);
              for (const line of wrapped) console.log(dim(`  ${line}`));
            }
            break;
          }
          case 'tool_call': {
            // write()/edit() calls carry full file content as a JSON
            // argument - unlike tool_result, this had no cap at all,
            // so a single write() could dump a thousand-plus-char
            // wall of escaped JSON onto one terminal line. The full
            // call still goes to the session log unabridged.
            const preview = event.toolCall ? formatToolCall(event.toolCall) : event.content;
            pendingTool = '';
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
