import { promises as fs, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolCall, ToolDefinition } from './types.js';

const execAsync = promisify(exec);

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

  constructor(workingDir: string) {
    this.workingDir = path.resolve(workingDir);
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
    return content;
  }

  private async write(filePath: string, content: string): Promise<string> {
    const resolved = this.resolvePath(filePath);
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
    return `wrote ${verify.length} bytes to ${filePath}, verified by reading it back`;
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
    return `edited ${filePath}, verified by reading it back`;
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
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      return `stdout:\n${stdout}${stderr ? `\nstderr:\n${stderr}` : ''}${repeatNote}`;
    } catch (err: any) {
      // Real command failures are real information the model needs to see,
      // not something to swallow into a generic "it worked" - this is
      // exactly the kind of result today's failures never actually got.
      return `command failed (exit ${err.code ?? 'unknown'}):\nstdout:\n${err.stdout ?? ''}\nstderr:\n${err.stderr ?? ''}${repeatNote}`;
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
  private bashBackground(command: string): string {
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
    return `started in background (pid ${child.pid}), not waited on - it keeps running after this call returns. Output is being logged to ${logPath}. Verify it's actually working (e.g. curl a server it starts) before assuming it did - a background process can still fail moments after starting. To stop it: bash("kill ${child.pid}").`;
  }

  private async glob(pattern: string): Promise<string> {
    const regex = globToRegExp(pattern);
    const entries = await fs.readdir(this.workingDir, { recursive: true, withFileTypes: true });
    const matches = entries
      .filter((e) => e.isFile())
      .map((e) => path.relative(this.workingDir, path.join(e.parentPath ?? this.workingDir, e.name)))
      .filter((rel) => !isIgnoredPath(rel) && regex.test(rel));
    return matches.length ? matches.join('\n') : '(no matches)';
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
