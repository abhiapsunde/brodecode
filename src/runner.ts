import { config } from './config.js';

/** Raw completion call against llama-server - not the OpenAI/Anthropic
 *  compatible chat routes. We control the exact prompt text end to end;
 *  nothing in between us and the model reformats or reinterprets it. */
export async function complete(prompt: string): Promise<string> {
  const res = await fetch(`${config.llamaServerUrl}/completion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      n_predict: config.maxTokensPerTurn,
      stop: ['<|im_end|>', '<|im_start|>'],
    }),
  });
  if (!res.ok) {
    throw new Error(`llama-server returned ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { content: string };
  return data.content;
}
