import { promises as fs, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolCall, ToolDefinition } from './types.js';

const execAsync = promisify(exec);

// Every one of these exists because an unbounded value reached the
// prompt and cost a turn. The window is 8,192 tokens; at roughly three
// characters per token a single 25,000 character tool result is an
// eighth of it.
const READ_CHAR_CAP = 24_000;
const BASH_OUTPUT_CAP = 12_000;
const GLOB_RESULT_CAP = 200;
const BASH_TIMEOUT_MS = 30_000;

/** Keeps the start and the end of command output; the middle of a long
 *  run is rarely where the answer is, and the ends carry the command
 *  echo and the error. */
function clampOutput(text: string): string {
  if (text.length <= BASH_OUTPUT_CAP) return text;
  const head = text.slice(0, Math.floor(BASH_OUTPUT_CAP * 0.6));
  const tail = text.slice(-Math.floor(BASH_OUTPUT_CAP * 0.4));
  return `${head}\n...[${text.length - head.length - tail.length} characters omitted from the middle]...\n${tail}`;
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'read',
    description: 'Read the full contents of a file.',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  },
  {
    name: 'write',
    description: "Write content to a file, creating it (and any parent directories) if it doesn't exist, or replacing it entirely if it does.",
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'edit',
    description: 'Replace an exact substring in a file with new text. The file must have been read in this session first. old_string must match exactly once in the file.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'bash',
    description: 'Run a shell command in the working directory. 30 second timeout by default - a command that never exits on its own (a server, a watcher) will be killed when it hits that timeout, not left running. For anything meant to keep running after this call returns, pass background:true instead: it starts detached and returns immediately with its PID and a log file path.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        background: {
          type: 'boolean',
          description: 'Set true for long-running commands (starting a server, etc). Without this, a command that never exits gets killed after 30 seconds - which can look like it "started" from its stdout right before being killed, when it did not actually keep running.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'glob',
    description: 'Find files matching a glob pattern (supports * and **) relative to the working directory.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents for a regular expression pattern, recursively from the working directory (or a given subpath).',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['pattern'],
    },
  },
];

// Matches what ripgrep/fd/git treat as noise by default - without this,
// "what's in this repo" on any real Node project returns hundreds of
// node_modules lines before ever reaching the actual source files.
const IGNORED_DIR_SEGMENTS = new Set(['node_modules', '.git', 'dist', 'build', '.cache']);
function isIgnoredPath(relPath: string): boolean {
  return relPath.split(path.sep).some((segment) => IGNORED_DIR_SEGMENTS.has(segment));
}

// Builds just the regex body (no anchors) so it can recurse into
// {a,b} alternatives without double-anchoring them.
function globToRegExpBody(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') {
      // "**/" - zero or more path segments, including none - so
      // "**/*" matches root-level files too, not just nested ones.
      out += '(?:.*/)?';
      i += 2;
    } else if (c === '*' && pattern[i + 1] === '*') {
      out += '.*';
      i++;
    } else if (c === '*') {
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      // Brace expansion: "*.{test,spec}.js" is a real, commonly-used
      // glob feature - without this, patterns using it silently
      // matched nothing (an empty result reads as "no such files",
      // not "your pattern was invalid"), a dead end any model reaches
      // for without knowing it doesn't work here.
      const close = pattern.indexOf('}', i);
      if (close === -1) {
        out += '\\{';
      } else {
        const alternatives = pattern.slice(i + 1, close).split(',').map(globToRegExpBody);
        out += `(?:${alternatives.join('|')})`;
        i = close;
      }
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return out;
}

/** A cheap parse check on the languages this harness sees most.
 *
 *  "verified by reading it back" was a narrower promise than it
 *  sounded: it proved the bytes landed, not that the file was usable.
 *  A model can write JSON with a trailing comma or JavaScript with an
 *  unclosed brace, get told the write verified, and only find out
 *  several rounds later when something fails to start. This does not
 *  judge whether the code is correct - nothing here can - it only
 *  catches a file that cannot be parsed at all.
 *
 *  Returns null when the file parses, or when the type is not one we
 *  can check. */
function syntaxProblem(filePath: string, content: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.json') {
      JSON.parse(content);
      return null;
    }
    if (ext === '.js' || ext === '.cjs' || ext === '.mjs') {
      // Compiles without running: catches unclosed braces, stray
      // tokens, duplicate const in the same scope.
      new Function(content);
      return null;
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp('^' + globToRegExpBody(pattern) + '$');
}

export class ToolExecutor {
  readonly workingDir: string;
  private readonly readFiles = new Set<string>();
  // Tracks (filePath + old_string) signatures of failed edits, so a
  // second identical failure can say so explicitly - observed
  // directly: a model can reach a correct diagnosis and still retry
  // the exact same failing tool call verbatim rather than adapting,
  // burning the turn budget on a call that already proved it doesn't
  // work.
  private readonly failedEdits = new Set<string>();
  // Bumped on every successful write/edit. Paired with
  // bashRunAtMutation below to catch a different loop: re-running the
  // exact same read-only command (a test/coverage check, say) with
  // nothing having changed since the last time - observed directly,
  // six times in a row with zero edits in between, burning an entire
  // turn budget on a command that could not possibly give a new
  // answer.
  private mutationCount = 0;
  private readonly bashRunAtMutation = new Map<string, number>();
  private readonly changed = new Set<string>();

  constructor(workingDir: string) {
    this.workingDir = path.resolve(workingDir);
  }

  /** Files written or edited in this session, relative to the working
   *  directory. Answering "what did it touch?" used to mean scrolling
   *  the whole transcript. */
  changedFiles(): string[] {
    return [...this.changed].sort();
  }

  /** Resolves a user-supplied path against the working dir and refuses anything that escapes it. */
  private resolvePath(userPath: string): string {
    const resolved = path.resolve(this.workingDir, userPath);
    if (resolved !== this.workingDir && !resolved.startsWith(this.workingDir + path.sep)) {
      throw new Error(`refused: "${userPath}" resolves outside the working directory`);
    }
    return resolved;
  }

  async execute(call: ToolCall): Promise<string> {
    try {
      switch (call.name) {
        case 'read':
          return await this.read(String(call.arguments.file_path));
        case 'write':
          return await this.write(String(call.arguments.file_path), String(call.arguments.content));
        case 'edit':
          return await this.edit(
            String(call.arguments.file_path),
            String(call.arguments.old_string),
            String(call.arguments.new_string),
          );
        case 'bash':
          return call.arguments.background
            ? this.bashBackground(String(call.arguments.command))
            : await this.bash(String(call.arguments.command));
        case 'glob':
          return await this.glob(String(call.arguments.pattern));
        case 'grep':
          return await this.grep(String(call.arguments.pattern), call.arguments.path ? String(call.arguments.path) : '.');
        default:
          return `error: unknown tool "${call.name}"`;
      }
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async read(filePath: string): Promise<string> {
    const resolved = this.resolvePath(filePath);
    const content = await fs.readFile(resolved, 'utf-8');
    this.readFiles.add(resolved);

    // An unbounded read is the fastest way to end a turn. A 480KB log
    // is about 161,000 tokens against an 8,192 token window, so the
    // request is rejected outright and the whole turn is lost - and
    // the model has no way to know a file is too big before asking
    // for it. Head and tail keep it useful (a log's interesting part
    // is usually at one end) and the middle is reported, not hidden.
    if (content.length <= READ_CHAR_CAP) return content;
    const head = content.slice(0, Math.floor(READ_CHAR_CAP * 0.7));
    const tail = content.slice(-Math.floor(READ_CHAR_CAP * 0.3));
    const skippedLines = content.slice(head.length, content.length - tail.length).split('\n').length;
    return `${head}\n\n...[${filePath} is ${content.length} chars, too large for the context window. `
      + `${skippedLines} lines omitted from the middle. Use grep() to find a specific part, `
      + `or bash("sed -n 'START,ENDp' ${filePath}") to read a range.]...\n\n${tail}`;
  }

  private async write(filePath: string, content: string): Promise<string> {
    const resolved = this.resolvePath(filePath);
    // Whether this replaced something, and how much, is the single
    // most useful fact about a write and it was not being reported.
    const previous = await fs.readFile(resolved, 'utf-8').catch(() => null);
    const existed = previous !== null;
    const previousLength = previous?.length ?? 0;
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf-8');
    this.readFiles.add(resolved);
    // Verification-first: never report success on the model's say-so.
    // Re-read what's actually on disk and confirm it matches before
    // this result ever goes back into the conversation.
    const verify = await fs.readFile(resolved, 'utf-8');
    if (verify !== content) {
      return `error: write to ${filePath} did not verify - disk content does not match what was written`;
    }
    this.mutationCount++;
    this.changed.add(path.relative(this.workingDir, resolved));
    const problem = syntaxProblem(filePath, verify);
    const before = existed ? `, replacing ${previousLength} bytes` : ' (new file)';
    if (problem) {
      return `wrote ${verify.length} bytes to ${filePath}${before}, but the file does not parse: `
        + `${problem}. The bytes are on disk; the file is not usable as it stands. Fix it before `
        + `relying on it.`;
    }
    return `wrote ${verify.length} bytes to ${filePath}${before}, verified by reading it back and parsing it`;
  }

  private async edit(filePath: string, oldString: string, newString: string): Promise<string> {
    const resolved = this.resolvePath(filePath);
    if (!this.readFiles.has(resolved)) {
      return `error: ${filePath} must be read before it can be edited`;
    }
    const content = await fs.readFile(resolved, 'utf-8');
    const occurrences = content.split(oldString).length - 1;
    const signature = `${resolved} ${oldString}`;

    if (occurrences !== 1) {
      // A second identical failure means the model reached a
      // diagnosis but is retrying the exact same call rather than
      // adapting to it - observed directly, twice in a row, right up
      // against the turn limit. Say so plainly instead of repeating
      // the same unhelpful error a third time.
      const repeated = this.failedEdits.has(signature);
      this.failedEdits.add(signature);
      const retryNote = repeated
        ? ' This exact old_string was already tried and failed - retrying it again will fail the same way. Use write() to replace the whole file instead.'
        : '';

      if (occurrences === 0) {
        const normalize = (s: string) => s.split('\n').map((l) => l.trim()).join('\n');
        if (normalize(content).includes(normalize(oldString))) {
          return `error: old_string not found in ${filePath} - but it matches once whitespace is ignored, so the mismatch is likely trailing/leading spaces or indentation rather than the visible text. Re-read the file and copy the exact text around that area, including whitespace, instead of retyping it from memory.${retryNote}`;
        }
        return `error: old_string not found in ${filePath} - it must match the file's current exact content. Re-read the file if unsure, try a shorter/more distinctive anchor, or use write() to replace the whole file if repeated attempts keep failing.${retryNote}`;
      }
      return `error: old_string appears ${occurrences} times in ${filePath} - must match exactly once. Include more surrounding context to make it unique, or use write() to replace the whole file.${retryNote}`;
    }

    const updated = content.replace(oldString, newString);
    await fs.writeFile(resolved, updated, 'utf-8');
    const verify = await fs.readFile(resolved, 'utf-8');
    if (verify !== updated) {
      return `error: edit to ${filePath} did not verify - disk content does not match what was written`;
    }
    this.mutationCount++;
    this.changed.add(path.relative(this.workingDir, resolved));
    const problem = syntaxProblem(filePath, verify);
    if (problem) {
      return `edited ${filePath}, but the file no longer parses: ${problem}. The edit is on disk; `
        + `the file is not usable as it stands. Fix it before relying on it.`;
    }
    return `edited ${filePath}, verified by reading it back and parsing it`;
  }

  private async bash(command: string): Promise<string> {
    // A repeat of the exact same command, with no file change since
    // the last time it ran, cannot produce a different result -
    // observed directly, six times in a row (a coverage check),
    // burning an entire turn budget on nothing. This doesn't block
    // the repeat (re-running a command is often exactly right, e.g.
    // after a real edit), it just makes the "nothing changed" case
    // explicit instead of silently returning the same output again.
    const isNoOpRepeat = this.bashRunAtMutation.get(command) === this.mutationCount;
    this.bashRunAtMutation.set(command, this.mutationCount);
    const repeatNote = isNoOpRepeat
      ? '\n\n(note: this exact command was already run since the last file change - the result above is the same as last time and running it again without changing any files first will not produce a different one. If this result isn\'t what you want, change the code or tests, then re-run it.)'
      : '';

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workingDir,
        timeout: BASH_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      return `stdout:\n${clampOutput(stdout)}${stderr ? `\nstderr:\n${clampOutput(stderr)}` : ''}${repeatNote}`;
    } catch (err: any) {
      // Three different things arrive here and they used to read
      // identically as "command failed (exit unknown)" with empty
      // output, which tells the model nothing it can act on.
      if (err.killed && err.signal === 'SIGTERM') {
        return `the command was killed after ${BASH_TIMEOUT_MS / 1000}s, which is the timeout for a `
          + `foreground command. It did not finish, and whatever it printed before being killed is `
          + `below - that output does not mean it succeeded. If this is meant to keep running `
          + `(a server, a watcher), call bash again with background:true.\n`
          + `stdout:\n${clampOutput(err.stdout ?? '')}\nstderr:\n${clampOutput(err.stderr ?? '')}${repeatNote}`;
      }
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        // The command very likely succeeded; it just printed more than
        // was captured. Reporting that as a failure sent a model off
        // debugging a command that had worked.
        return `the command produced more output than can be captured, so it was cut off. This is `
          + `not a failure of the command itself. Narrow it (grep, head, tail, --quiet) and run it `
          + `again if you need the content.\nfirst part of stdout:\n${clampOutput(err.stdout ?? '')}${repeatNote}`;
      }
      return `command failed (exit ${err.code ?? 'unknown'}):\nstdout:\n${clampOutput(err.stdout ?? '')}`
        + `\nstderr:\n${clampOutput(err.stderr ?? '')}${repeatNote}`;
    }
  }

  /** For commands that are meant to keep running (a server, etc.) -
   *  the plain bash() above is a blocking exec() with a 30s timeout,
   *  which kills anything that never exits on its own. Observed
   *  directly: "npm start" got killed by that timeout, but its
   *  already-captured stdout ("Server running at...") made it read
   *  as success, so the model reported the server as up when it had
   *  actually already been killed - and every following curl against
   *  it silently failed. spawn+detach+unref here means the process
   *  genuinely outlives this call, instead of looking like it does. */
  private async bashBackground(command: string): Promise<string> {
    const logDir = path.join(os.homedir(), '.brodecode', 'bg');
    mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${Date.now()}.log`);
    const fd = openSync(logPath, 'a');
    const child = spawn(command, {
      cwd: this.workingDir,
      shell: true,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    const pid = child.pid;

    // Telling the model to go and verify this itself was advice, and
    // advice is not a mechanism. A server that dies on EADDRINUSE dies
    // within milliseconds, and reporting that as "started" sent one
    // session into fifteen minutes of editing a file while an older
    // process on the same port served stale code and produced the same
    // error every time. So: wait, then check.
    await new Promise((r) => setTimeout(r, 700));
    let alive = false;
    try {
      process.kill(pid!, 0);
      alive = true;
    } catch {
      alive = false;
    }

    const log = (() => {
      try {
        return readFileSync(logPath, 'utf-8').trim();
      } catch {
        return '';
      }
    })();

    if (!alive) {
      const tail = log.split('\n').slice(-12).join('\n');
      return `the command exited within 700ms of starting, so nothing is running in the background.\n`
        + `output:\n${tail || '(nothing was written to the log)'}\n`
        + `the log is at ${logPath}. Fix the cause before trying again; starting it a second time will fail the same way.`;
    }

    // A port already held by something else is the specific failure
    // that is invisible from inside the project directory.
    const ports = [...command.matchAll(/\b(?:localhost:|:)(\d{2,5})\b/g)].map((m) => m[1]);
    let portNote = '';
    for (const port of new Set(ports)) {
      const owner = await execAsync(`lsof -ti:${port} 2>/dev/null || true`).catch(() => ({ stdout: '' }));
      const pids = String(owner.stdout).split('\n').filter(Boolean);
      if (pids.length > 1 || (pids.length === 1 && pids[0] !== String(pid))) {
        portNote += `\nwarning: port ${port} is held by pid ${pids.join(', ')}, not by the process just started.`
          + ` Requests to that port are being answered by something else, which may be running older code.`;
      }
    }

    const first = log.split('\n').slice(0, 4).join('\n');
    return `started in background (pid ${pid}), still alive after 700ms.`
      + `${first ? `\nfirst output:\n${first}` : ''}`
      + `${portNote}`
      + `\nOutput is being logged to ${logPath}. Still worth curling it before assuming it works. To stop it: bash("kill ${pid}").`;
  }

  private async glob(pattern: string): Promise<string> {
    // Capped for the same reason read is: an unbounded listing of a
    // real repository is thousands of lines straight into an 8k window.
    const regex = globToRegExp(pattern);
    const entries = await fs.readdir(this.workingDir, { recursive: true, withFileTypes: true });
    const matches = entries
      .filter((e) => e.isFile())
      .map((e) => path.relative(this.workingDir, path.join(e.parentPath ?? this.workingDir, e.name)))
      .filter((rel) => !isIgnoredPath(rel) && regex.test(rel));
    if (!matches.length) return '(no matches)';
    if (matches.length > GLOB_RESULT_CAP) {
      return `${matches.slice(0, GLOB_RESULT_CAP).join('\n')}\n`
        + `...[${matches.length - GLOB_RESULT_CAP} more files matched and are not listed. `
        + `Narrow the pattern rather than reading this list.]`;
    }
    return matches.join('\n');
  }

  private async grep(pattern: string, subPath: string): Promise<string> {
    const regex = new RegExp(pattern);
    const start = this.resolvePath(subPath);

    // grep(pattern, "server.js") is a reasonable thing for a model to
    // ask for, and readdir on a file throws ENOTDIR, which told the
    // model nothing about what it had done wrong. Observed burning
    // two rounds and ~56s of reasoning on the same dead end in one
    // session, re-issuing the identical failing call. A path that
    // names a file searches that file.
    let files: string[];
    const stat = await fs.stat(start).catch(() => null);
    if (!stat) return `error: no such file or directory: ${subPath}`;
    if (stat.isFile()) {
      files = [start];
    } else {
      const entries = await fs.readdir(start, { recursive: true, withFileTypes: true });
      files = entries
        .filter((e) => e.isFile())
        .map((e) => path.join(e.parentPath ?? start, e.name));
    }

    const hits: string[] = [];
    for (const full of files) {
      if (isIgnoredPath(path.relative(this.workingDir, full))) continue;
      let content: string;
      try {
        content = await fs.readFile(full, 'utf-8');
      } catch {
        continue; // skip unreadable/binary files
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          hits.push(`${path.relative(this.workingDir, full)}:${i + 1}: ${lines[i]}`);
        }
      }
    }
    return hits.length ? hits.join('\n') : '(no matches)';
  }
}
