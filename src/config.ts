import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Optional ~/.brodecode/config.json, so a runner that lives on another
 *  machine is configured once instead of exported into every shell.
 *  Precedence: environment variable, then this file, then the built-in
 *  default. Missing or malformed file is not an error - it is the
 *  normal case for anyone running the model on the same box. */
function fileConfig(): Record<string, unknown> {
  const configPath = process.env.BRODECODE_CONFIG
    ?? path.join(homedir(), '.brodecode', 'config.json');
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

const file = fileConfig();

export const configPath = process.env.BRODECODE_CONFIG
  ?? path.join(homedir(), '.brodecode', 'config.json');

export const config = {
  // This harness only ever talks to llama-server's raw /completion
  // endpoint, never the OpenAI- or Anthropic-compatible chat routes:
  // the whole point is that nothing sits between the prompt we build
  // and the tokens the model emits.
  llamaServerUrl: process.env.BRODECODE_SERVER_URL
    ?? (file.serverUrl as string | undefined)
    ?? 'http://127.0.0.1:8090',
  maxTurns: Number(process.env.BRODECODE_MAX_TURNS ?? file.maxTurns ?? 20),
  maxTokensPerTurn: 4096,
  // Must match llama-server's own --ctx-size. 8192 is what fits
  // alongside Qwen3-14B Q4_K_M in 12GB of VRAM; 32768 OOMs on that
  // card. History is trimmed to fit under this before every prompt
  // render - see agent.ts.
  contextSize: Number(process.env.BRODECODE_CTX_SIZE ?? file.ctxSize ?? 8192),
};
