export const config = {
  // This harness only ever talks to llama-server's raw /completion
  // endpoint, never the OpenAI- or Anthropic-compatible chat routes:
  // the whole point is that nothing sits between the prompt we build
  // and the tokens the model emits. Point BRODECODE_SERVER_URL at a
  // runner on another host if it isn't local.
  llamaServerUrl: process.env.BRODECODE_SERVER_URL ?? 'http://127.0.0.1:8090',
  maxTurns: Number(process.env.BRODECODE_MAX_TURNS ?? 20),
  maxTokensPerTurn: 4096,
  // Must match llama-server's own --ctx-size. 8192 is what fits
  // alongside Qwen3-14B Q4_K_M in 12GB of VRAM; 32768 OOMs on that
  // card. History is trimmed to fit under this before every prompt
  // render - see agent.ts.
  contextSize: Number(process.env.BRODECODE_CTX_SIZE ?? 8192),
};
