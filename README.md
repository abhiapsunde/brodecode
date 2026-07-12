# brodecode

A coding harness built by hand for one model, with no borrowed
abstraction layer sitting between the two.

## Why this exists

A day spent trying to get local models (via Ollama) to drive `opencode`
and Claude Code reliably turned up a specific, provable root cause:
those harnesses ship a large, general-purpose default toolset (~25
tools, ~100KB of system prompt) that the *hosted* Claude was trained
against but a local model never was - and separately, Ollama's own
`/api/chat` tools parameter has a confirmed bug for Qwen3 (tool
definitions get serialized as a raw Go struct instead of JSON before
the model ever sees them).

This project is the opposite bet: pick exactly one model
(`Qwen3-14B`, Q4_K_M), run it through the rawest possible interface
(`llama-server`'s `/completion` endpoint, not any chat/tools
abstraction), and hand-write a minimal harness - six tools, a short
system prompt, our own parser for the model's real `<tool_call>` /
`<think>` output - so there is nothing left in the middle to blame.

Full writeup of the investigation that led here: see the `homelab`
repo, `notes/2026-07-12-local-llm-agentic-coding-investigation.md`.

## Architecture

```
src/
  types.ts    shared types (Message, ToolCall, ToolDefinition)
  config.ts   model runner URL, turn limits
  prompt.ts   hand-built ChatML renderer + the (deliberately short) system prompt
  runner.ts   raw HTTP client for llama-server's /completion endpoint
  parse.ts    splits raw model output into <think>/<tool_call>/text
  tools.ts    real read/write/edit/bash/glob/grep, scoped to one working dir
  agent.ts    the tool-call loop
  cli.ts      REPL entrypoint
```

The one design principle that matters most: **the harness verifies, it
doesn't trust.** Every `write` and `edit` is immediately read back from
disk and diffed against what was claimed before that result ever goes
back into the model's context. `edit` refuses to run on a file that
wasn't `read` first in the same session - enforced in code, not hoped
for in a prompt. This came directly out of today's failures: a model
narrating a fake tool-execution trace, claiming a server was running
when nothing had ever been written to disk. The harness is built so
that class of failure has nothing to attach to - it isn't asked to
believe the model, it's asked to check.

## Model runner

`llama-server` (llama.cpp, Vulkan backend) running directly on
`lallan-u24` via systemd, not as a k8s pod - see the `homelab` repo's
`lallan-u24/README.md` for why, and the exact reinstall steps.

```
Model:   Qwen3-14B, Q4_K_M GGUF (~9GB)
Context: 8192 tokens (32768 didn't fit alongside the model weights in
         12GB VRAM - see homelab repo for the OOM detail)
Port:    8090
```

## Running it

```bash
npm install
npm run build
node dist/cli.js /path/to/some/project
```

Set `BRODECODE_SERVER_URL` if the model runner isn't at the default
`http://10.9.9.185:8090`.

## Status

Working end to end as of 2026-07-12, verified independently (not just
by trusting the CLI's own output) against the two scenarios that broke
every general-purpose harness tried earlier the same day: writing and
reading back a file, and writing/starting/curling a real HTTP service.
Both produced real, correct results with no fabrication.

Not yet done: streaming output (currently waits for the full
completion before parsing), token-budget-aware history truncation
(currently just a hard turn-count limit), tests.
