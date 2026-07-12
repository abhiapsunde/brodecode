export const config = {
  // llama-server on lallan-u24 (see homelab repo, lallan-u24/README.md
  // for how the model runner itself is set up - this harness only ever
  // talks to its raw /completion endpoint, never the OpenAI/Anthropic
  // compatible chat routes).
  llamaServerUrl: process.env.BRODECODE_SERVER_URL ?? 'http://10.9.9.185:8090',
  maxTurns: 20,
  maxTokensPerTurn: 4096,
};
