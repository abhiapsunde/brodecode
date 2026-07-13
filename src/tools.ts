import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
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
    description: 'Run a shell command in the working directory. 30 second timeout.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
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

function globToRegExp(pattern: string): RegExp {
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
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}

export class ToolExecutor {
  readonly workingDir: string;
  private readonly readFiles = new Set<string>();

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
          return await this.bash(String(call.arguments.command));
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
    return `wrote ${verify.length} bytes to ${filePath}, verified by reading it back`;
  }

  private async edit(filePath: string, oldString: string, newString: string): Promise<string> {
    const resolved = this.resolvePath(filePath);
    if (!this.readFiles.has(resolved)) {
      return `error: ${filePath} must be read before it can be edited`;
    }
    const content = await fs.readFile(resolved, 'utf-8');
    const occurrences = content.split(oldString).length - 1;
    if (occurrences === 0) {
      // A whitespace-insensitive check turns a dead end into an
      // actionable hint. Trailing spaces on an otherwise "blank" line
      // are invisible when a model re-reads a file and reproduces it
      // from memory, but they break an exact match every time -
      // observed directly: a model retried the identical failing
      // old_string a dozen times in a row without this signal.
      const normalize = (s: string) => s.split('\n').map((l) => l.trim()).join('\n');
      if (normalize(content).includes(normalize(oldString))) {
        return `error: old_string not found in ${filePath} - but it matches once whitespace is ignored, so the mismatch is likely trailing/leading spaces or indentation rather than the visible text. Re-read the file and copy the exact text around that area, including whitespace, instead of retyping it from memory.`;
      }
      return `error: old_string not found in ${filePath} - it must match the file's current exact content. Re-read the file if unsure, try a shorter/more distinctive anchor, or use write() to replace the whole file if repeated attempts keep failing.`;
    }
    if (occurrences > 1) {
      return `error: old_string appears ${occurrences} times in ${filePath} - must match exactly once`;
    }
    const updated = content.replace(oldString, newString);
    await fs.writeFile(resolved, updated, 'utf-8');
    const verify = await fs.readFile(resolved, 'utf-8');
    if (verify !== updated) {
      return `error: edit to ${filePath} did not verify - disk content does not match what was written`;
    }
    return `edited ${filePath}, verified by reading it back`;
  }

  private async bash(command: string): Promise<string> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workingDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      return `stdout:\n${stdout}${stderr ? `\nstderr:\n${stderr}` : ''}`;
    } catch (err: any) {
      // Real command failures are real information the model needs to see,
      // not something to swallow into a generic "it worked" - this is
      // exactly the kind of result today's failures never actually got.
      return `command failed (exit ${err.code ?? 'unknown'}):\nstdout:\n${err.stdout ?? ''}\nstderr:\n${err.stderr ?? ''}`;
    }
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
    const startDir = this.resolvePath(subPath);
    const entries = await fs.readdir(startDir, { recursive: true, withFileTypes: true });
    const hits: string[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const full = path.join(e.parentPath ?? startDir, e.name);
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
