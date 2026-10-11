import { config, configPath } from './config.js';

/** What the runner is actually serving. Asked once at startup so the
 *  terminal can name the model rather than leaving the user to assume
 *  it matches whatever they last configured - the model itself cannot
 *  be trusted to answer "which model are you", since nothing in the
 *  prompt tells it and it will cheerfully guess from training data. */
export async function serverInfo(): Promise<{ model: string; ctx: number } | null> {
  try {
    const res = await fetch(`${config.llamaServerUrl}/props`);
    if (!res.ok) return null;
    const props = await res.json() as {
      model_path?: string;
      default_generation_settings?: { n_ctx?: number };
    };
    const file = (props.model_path ?? '').split('/').pop() ?? '';
    return {
      model: file.replace(/\.gguf$/i, '') || 'unknown',
      ctx: props.default_generation_settings?.n_ctx ?? config.contextSize,
    };
  } catch {
    return null;
  }
}

/** Raw completion call against llama-server - not the OpenAI/Anthropic
 *  compatible chat routes. We control the exact prompt text end to end;
 *  nothing in between us and the model reformats or reinterprets it.
 *
 *  Streams tokens via onToken as they arrive (so the CLI can show real,
 *  live progress instead of silence followed by a wall of text), and
 *  returns the full accumulated response once generation stops. */
export async function complete(prompt: string, onToken?: (chunk: string) => void, signal?: AbortSignal, maxTokens?: number): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${config.llamaServerUrl}/completion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        n_predict: maxTokens ?? config.maxTokensPerTurn,
        stop: ['<|im_end|>', '<|im_start|>'],
        stream: true,
      }),
      signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    // Node's bare "fetch failed" names neither the host nor the
    // reason, which is the single least useful thing to read after
    // typing a prompt and waiting. Connection refused against a
    // correctly configured runner and a default pointing at the wrong
    // machine look identical from the terminal, so say which URL was
    // tried and where that URL came from.
    const cause = (err as { cause?: { code?: string } })?.cause?.code;
    const source = process.env.BRODECODE_SERVER_URL
      ? 'BRODECODE_SERVER_URL'
      : `serverUrl in ${configPath}, or the built-in default`;
    throw new Error(
      `cannot reach llama-server at ${config.llamaServerUrl}`
      + `${cause ? ` (${cause})` : ''}\n`
      + `  the harness does not start the model runner; it has to already be listening there\n`
      + `  that address came from ${source}`,
    );
  }
  if (!res.ok || !res.body) {
    throw new Error(`llama-server returned ${res.status}: ${await res.text()}`);
  }

  let full = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; each has one or more
    // "data: {...}" lines. llama-server sends one JSON chunk per frame.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const payload = JSON.parse(line.slice('data: '.length));
      if (typeof payload.content === 'string') {
        full += payload.content;
        onToken?.(payload.content);
      }
    }
  }

  return full;
}
