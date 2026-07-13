export const config = {
  // llama-server on lallan-u24 (see homelab repo, lallan-u24/README.md
  // for how the model runner itself is set up - this harness only ever
  // talks to its raw /completion endpoint, never the OpenAI/Anthropic
  // compatible chat routes).
  llamaServerUrl: process.env.BRODECODE_SERVER_URL ?? 'http://10.9.9.185:8090',
  maxTurns: 20,
  maxTokensPerTurn: 4096,
  // Must match llama-server's own --ctx-size (see lallan-u24/README.md
  // in the homelab repo - currently 8192, reduced from a planned 32768
  // after a VRAM OOM at full context). History gets trimmed to fit
  // under this before every prompt render - see agent.ts.
  contextSize: 8192,
};
