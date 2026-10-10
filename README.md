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

What that investigation actually measured, before any of this was
written: Claude Code's real outbound request was **101KB with 25 tool
definitions**, one of which (`Workflow`) had a description 18,997
characters long on its own. Scoping it down to
`--tools Read,Write,Edit,Bash,Glob,Grep` took multi-step reliability
from roughly 0% to 3 out of 4. The model was capable the whole time.
It was being handed a toolset built for a much larger job than the one
being asked of it.

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

You supply your own. The harness speaks to one endpoint,
`POST /completion` on a `llama-server` (llama.cpp), and nothing else.

```
Model:   Qwen3-14B, Q4_K_M GGUF (~9GB)
Context: 8192 tokens
Port:    8090
```

```bash
llama-server \
  --model /path/to/Qwen3-14B-Q4_K_M.gguf \
  --n-gpu-layers 999 \
  --ctx-size 8192 \
  --port 8090 \
  --host 0.0.0.0
```

Sized for a 12GB card: the weights and an 8192-token KV cache land at
about 9.8GB of VRAM, and `--ctx-size 32768` does not fit. Loading takes
roughly 20 seconds. Both numbers are from an RTX 3080 Ti with the
Vulkan backend.

Another model will need `prompt.ts` adjusted. The prompt renderer emits
ChatML by hand and `parse.ts` expects Qwen3's actual `<think>` and
`<tool_call>` output, neither of which is negotiated with the server.
That is the tradeoff this project is making on purpose.

## Running it

```bash
npm install
npm run build
node dist/cli.js /path/to/some/project
```

With no argument it uses the current directory, and it refuses to run
against its own repo. `/exit` or Ctrl-D to quit.

| Variable | Default | What it does |
|---|---|---|
| `BRODECODE_SERVER_URL` | `http://127.0.0.1:8090` | Where llama-server is |
| `BRODECODE_CTX_SIZE` | `8192` | Must match the server's `--ctx-size` |
| `BRODECODE_MAX_TURNS` | `20` | Tool-call rounds before giving up |
| `BRODECODE_LOG_DIR` | `~/.brodecode/logs` | Where session JSONL goes |
| `BRODECODE_SESSION_LABEL` | unset | Tags a session log for later review |

Every session writes unabridged JSONL alongside the terminal output:
`session_start`, `user`, `thinking`, `tool_call` (full, never
truncated), `tool_result`, `final`, `error`. Reviewing a session with
`jq` over that file is considerably easier than re-reading ANSI
terminal scrollback, which is why it exists.

## Scope

This is one person's harness for one model, published because the
failure modes it documents are more useful than the code. It is not
trying to be a general coding agent, and several things it lacks are
deliberate rather than pending: no multi-model support, no MCP, no
plugin system, no permission prompts, no sandbox. `bash()` runs what
the model asks for, scoped to the working directory and nothing
stronger, so point it at a project you can afford to have edited and
keep it off anything you cannot restore from git.

Six tools, a short system prompt, and a parser that handles exactly
one model's output format. Adding a seventh tool is a decision with a
measured cost, which is the whole premise.

## Status

Working end to end as of 2026-07-12, verified independently (not just
by trusting the CLI's own output) against the two scenarios that broke
every general-purpose harness tried earlier the same day: writing and
reading back a file, and writing/starting/curling a real HTTP service.
Both produced real, correct results with no fabrication.

Streaming output and token-budget-aware history truncation are both
now in place (see "Driving log" below - both were built and hardened
against real failures, not written speculatively). Still not done:
automated tests (everything so far has been verified by hand, against
real usage).

## Driving log

Bugs found and fixed by actually running the harness against a real,
messy project and watching what happened, rather than reasoning about
the code in the abstract. Kept here because several of these were
non-obvious and worth not re-discovering later.

**2026-07-12**

- `glob("**/*")` never matched root-level files - the pattern compiled
  to a regex requiring a literal `/`, so `**/*` only matched nested
  files. A model asked "what's in this repo" on a project with files
  in the root directory would see only its subdirectories and
  conclude the wrong thing about what the project even was. Fixed by
  giving `**/` its own case: zero-or-more path segments, including
  none.
- A response truncated mid-`<think>` block (hit the per-turn token
  limit before closing the tag) fell through the parser's `<think>`
  regex entirely and got dumped raw - literal `<think>` tag and all -
  as if it were the final answer. Fixed by falling back to
  "everything after the last `<think>`, unterminated" instead of
  requiring a matched pair. Paired with a fix in `agent.ts`: when a
  turn produces no answer and no tool call but does have reasoning,
  that reasoning is kept as context and the loop continues instead of
  showing the user a blank result.
- History had no token-budget management at all - a multi-round
  session (several file reads/edits/command outputs) would eventually
  exceed `llama-server`'s context window and the whole turn would fail
  outright with a 400, silently losing progress since the bloated
  history never got cleaned up for the next attempt either. First fix
  only dropped whole completed user-turns, which turned out to help
  nothing for the actual common case: **one** open-ended task ("fix
  the failing tests") racking up 15-20 tool-call rounds without a
  second user message ever being sent. Rewrote trimming to work at
  exchange granularity (assistant reply + its tool results as one
  droppable unit) instead of turn granularity, always preserving the
  first exchange (the task statement itself) and the most recent
  ones, falling back to shrinking oversized individual tool results if
  even that isn't enough.
- The parser matched `<think>...</think>` and discarded the *entire*
  matched span before ever looking for `<tool_call>` blocks - but
  Qwen3 sometimes emits `<tool_call>` nested inside its own `<think>`
  block, especially once a session has looped a couple of times on a
  failing command. Those tool calls were silently thrown away with the
  thinking text around them: the model had genuinely decided what to
  do, and the harness just never did it, then re-prompted with no new
  information and got the same "decision" again. This was the actual
  root cause behind a session that looked like the model was
  helplessly stuck repeating itself - it wasn't; the harness was
  dropping its output on the floor. Fixed by extracting tool calls
  from the full raw text first, before touching `<think>` at all.
- Piped/non-interactive stdin only ever processed the first line. Node
  readline's `close` event fires as soon as the input stream hits EOF,
  which happens almost immediately for a pipe - and since that landed
  *during* the long async model call for the first line, a
  `closed`-flag check at the top of the loop killed the session before
  ever asking for line two. Invisible in normal manual typing (a live
  TTY doesn't hit EOF mid-session), but silently truncated any
  scripted or automated use, including testing the harness itself.
  Fixed by switching to `for await (const line of rl)`, which doesn't
  have the race.
- `edit()`'s "old_string not found" error gave no signal on *why*, so
  a model whose guess was one wrong whitespace character away from
  the real file kept retrying the identical failing edit. Added a
  whitespace-insensitive fallback check: if the edit would match once
  whitespace differences are ignored, say so explicitly, rather than
  leaving the model to guess blindly.
- Not a harness bug, but worth recording: the model can still lose the
  thread on a genuinely hard, compounding task (a test file it had
  already mangled across several earlier failed edits, combined with a
  real breaking API change between chai-http v4 and v5) - it thrashed
  between incompatible module systems and mutually exclusive
  assumptions about the installed library's API rather than converging
  and gave up at the turn limit. Every tool call it made was executed
  correctly and reported accurately; the harness's job is to make sure
  nothing gets in the model's way, not to make the model smarter than
  it is. That's a real ceiling on what a 14B Q4 model can hold
  together across ~20 tool-call rounds, not a defect in the
  plumbing.
