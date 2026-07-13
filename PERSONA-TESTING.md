# Persona testing log

Resumable progress log for the "simulate 5 dev personas driving the
harness, log everything, find and fix real gaps" exercise. If this
gets picked up in a fresh session, this file plus the git log is the
full state - nothing else to reconstruct.

## Status: round 1 complete, all 5 personas passing

## What this is

Five small scratch projects, each representing a different kind of
task a real developer would throw at a coding assistant, live at
`/Users/abhi/Documents/Github/tmp/personas/`:

1. `1-explorer-arr-utils` - pure Q&A, no edits expected (array utils,
   no README on purpose - tests real comprehension, not README-parroting)
2. `2-bugfix-temp-convert` - a real formula bug (`9/5` instead of `5/9`
   in `fahrenheitToCelsius`), one failing test pinpoints it
3. `3-feature-todo-cli` - existing passing tests, task asks for a new
   `toggle()` capability plus a test for it
4. `4-refactor-string-utils` - duplicated `trim().toLowerCase()`
   normalization across three functions, task asks to extract it
   without changing behavior (existing tests must still pass)
5. `5-safety-calc-api` - uses raw `eval()` for expression evaluation;
   task is open-ended ("review for safety issues") - no bug pointed
   out explicitly, tests judgment

Each was driven via `BRODECODE_SESSION_LABEL=<name> printf '<prompt>\n/exit\n' | node dist/cli.js <project-dir>`,
output redirected to `/dev/null`, then reviewed via the new JSONL
session logger (`~/.brodecode/logs/*.jsonl`, tailed with `jq`) instead
of re-parsing raw terminal/ANSI noise - this is dramatically more
token-efficient for reviewing a session after the fact, which was
itself one of the deliverables (see "New feature" below).

Every persona's result was checked against **independent ground
truth** (`npm test` run by hand, `cat`ing the actual file), never just
the harness's own claim - same discipline as the rest of this project.

## New feature built: structured session logger

`src/logger.ts` - every session now writes a JSONL log
(`~/.brodecode/logs/<timestamp>-<project>-<label>.jsonl`, dir
overridable via `BRODECODE_LOG_DIR`) alongside the live terminal
output: `session_start`, `user`, `thinking` (truncated to 300 chars),
`tool_call` (full, untruncated - this is the ground truth for "what
did it actually do"), `tool_result` (truncated to 500 chars), `final`,
`error`. `BRODECODE_SESSION_LABEL` tags a session for identification.
Wired into `cli.ts`.

## Results, round 1

| # | Persona | Result | Tool calls | Notes |
|---|---|---|---|---|
| 1 | Explorer | ✅ clean | 2 | Correct trace of `chunk([1,2,3,4,5], 2)`, no wasted calls |
| 2 | Bug-fixer | ✅ clean | 4 | Found and fixed the `9/5`→`5/9` bug, verified |
| 3 | Feature-adder | ❌ deadlocked at 20-turn limit | 20 | See bugs found below - fixed, retried, passed on round 2 |
| 4 | Refactorer | ✅ clean | 15 | Correct `normalizeString` extraction, all tests still pass |
| 5 | Safety | ✅ excellent | 9 | Identified the unstated `eval()` issue itself, fixed with `mathjs`, self-corrected an API mismatch via real test failure, verified |

### Bugs found and fixed from persona 3's failure

1. **`glob` pattern `*.{test,spec}.js` silently matched nothing.**
   Brace expansion wasn't supported at all - `{`/`}` were escaped as
   literal characters, so the pattern could never match a real file.
   The model recovered by falling back to `bash("npm test")`, but this
   is a dead end any model reaches for without knowing it doesn't
   work. Fixed: `globToRegExp` now expands `{a,b,c}` into a real regex
   alternation.
2. **The model hallucinated Ruby file paths** (`lib/todo.rb`,
   `test/test_todo.rb`) purely from the project directory being named
   "3-feature-todo-cli", burning ~8 of the 20-turn budget before ever
   listing the actual directory. Fixed: added a system-prompt line
   telling the model not to guess a language/framework from the
   project's name and to confirm a file exists with `glob` first.
3. **`edit()`'s "appears N times" error gave no recovery guidance**
   (unlike "not found", which already suggested `write()` as a
   fallback) - the model reached the *correct diagnosis* (a missing
   comma) but kept retrying the exact same ambiguous `old_string`
   verbatim, twice, right up to the turn limit. Fixed: both edit error
   paths now suggest concrete next steps, and a new same-signature
   tracking set (`failedEdits`) makes a *second* identical failure say
   explicitly "this exact old_string was already tried and failed -
   use write() instead" rather than repeating the same unhelpful text.

Re-ran persona 3 after these three fixes: converged cleanly, all 4
tests passing, verified independently. (It still hit whitespace
mismatches on the edit tool a few times mid-session, then correctly
escalated to `write()` on its own well within the turn budget - a
reasonable recovery pattern, not a bug.)

### Verbosity/representation gap found (not from a failure - just noticed)

`tool_call` events had **no display cap at all** (unlike
`tool_result`, which was already capped at 5 lines) - a single
`write()` call showing a full file as a JSON argument dumped 1000+
characters onto one raw terminal line. Fixed properly, not just
truncated: `TurnEvent` now carries the structured `ToolCall` alongside
the flattened string, and `cli.ts` has a `formatToolCall()` that
builds a per-tool-aware one-line summary -
`write(file.js, 635 bytes)`, `edit(file.js, 45 chars -> 312 chars)`,
`bash(<command, capped at 150 chars>)` - instead of raw JSON. The full
call still goes to the session log unabridged; only the live terminal
display changed.

## Verification discipline used throughout

- Every persona's final file state checked with `cat`/`npm test`
  independently, not by trusting the harness's own "tests pass" claim.
- Every fix verified in isolation (a direct unit-style Node script
  against the compiled `dist/` output) before re-driving a full
  session, same as prior fixes in this project.
- The two `trimToBudget` regression tests (multi-turn overflow,
  single-long-turn overflow) re-run after every change to `agent.ts`.

## What's NOT done / possible next round

- Personas 1, 2, 4, 5 have only been driven once each. A second round
  (maybe with harder variants - a bigger refactor, a multi-file
  feature) would tell us more, but round 1 didn't surface further
  harness bugs there, only in persona 3.
- No test has yet driven a persona that requires reading/coordinating
  *multiple* files at once (all 5 current personas are single-file).
  That's a plausible next persona if this resumes.
- The `failedEdits` tracking set is per-`ToolExecutor` instance (i.e.
  per CLI process lifetime) and never cleared - fine for a single
  session, but if `brodecode` ever grows a "reset/clear" command this
  would need to be considered.

## Commits this round

- `df3846b` - structured JSONL session logger
- (this round's fixes - brace-expansion glob, edit() loop detection,
  system-prompt path-guessing nudge, tool_call display) - see the git
  log for the actual commit once pushed.
