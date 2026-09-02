# Architecture

## Parts

| File | Responsibility |
|---|---|
| `src/mcp.mjs` | MCP stdio server: JSON-RPC framing, tool schemas, dispatch. No SDK, no dependencies. |
| `src/jobs.mjs` | Job lifecycle: spawn detached, parse the event stream, refresh state, wait, cancel, follow up. |
| `src/models.mjs` | Price lookup, budget guard, profile resolution, suggestions, spend log. |
| `src/catalog.mjs` | models.dev catalogue (prices/context/tool support for every provider) and which providers hold credentials. |
| `src/worktree.mjs` | git worktree per job, auto-commit, diff extraction, merge/squash/patch, cleanup. |
| `src/prompt.mjs` | Turns a delegation into a structured work order for a model that has never seen the repo. |
| `src/runner.mjs` | One detached node process per attempt: starts the worker, captures its streams, enforces the timeout, records the exit code. |
| `src/process.mjs` | The two things every OS disagrees about: killing a process tree and asking whether a pid is alive. |
| `src/health.mjs` | What the fleet learned about model availability from its own runs, so an outage is not rediscovered on every job. |
| `src/doctor.mjs` | Setup diagnosis: binaries, providers, profiles, budget, stale jobs, optional warmup run. |
| `src/config.mjs` | Layered config: defaults → global → project → `OPENCODE_FLEET_CONFIG`. |
| `bin/ocfleet.mjs` | CLI over the same engine, plus `mcp` and `install`. |

State lives under `~/.opencode-fleet/` (override with `OPENCODE_FLEET_HOME`):

```
jobs/<jobId>/  job.json  prompt.md  events.ndjson  stderr.log  run.json  exit
worktrees/     <repo>-<jobId>/            one checkout per job
spend/         2026-08-31.json            daily cost ledger
cache/         openrouter.json  opencode-models-<dir>.json
```

## Job flow

```
fleet_delegate
  ├─ loadConfig(repo)                    global + project layers
  ├─ resolveModel(profile|model)         budget guard decides before anything runs
  ├─ headSha(repo)                       pin the base now, even if the job waits
  └─ slot free?  ─ no →  state: "queued"  (nothing is refused; startQueued() takes it later)
                 └ yes →  startJob()
                            ├─ createWorktree()      git worktree add -b fleet/<jobId>
                            ├─ buildWorkerPrompt()   → jobDir/prompt.md
                            └─ launch()              node runner.mjs (detached) → opencode run --format json
                                              │
                                              ├─ events.ndjson   (step_start / tool_use / text / step_finish)
                                              └─ exit            (exit code, written by the runner)
fleet_wait / fleet_status
  ├─ refresh()      reads exit + events → state, tokens, cost, report → auto-commit on the job branch
  └─ startQueued()  a finished job frees a slot → the oldest waiting job starts
fleet_result / fleet_diff → review → fleet_apply → fleet_cleanup
```

## Design decisions, and the surprises behind them

**Over the limit means queued, never refused.**
`defaults.maxConcurrentJobs` protects the machine — one opencode process and one full
worktree per job, plus per-key provider rate limits — not the wallet, which `budget`
guards separately. The first version returned an error past the limit, which pushed the
bookkeeping onto the caller: send ten jobs, get six ids and four apologies, and now you
have to remember which four to resend. Jobs past the limit now get `state: "queued"` and a
`queuePosition`; `startQueued()` runs after every refresh **and** inside `waitFor()`, so the
queue moves whether the manager polls or waits. Two details that were not obvious:

- The worktree is created in `startJob()`, not at submission — a hundred queued jobs cost a
  hundred small JSON files instead of a hundred checkouts. The *base commit* is still pinned
  at submission (`headSha`), so queueing never silently changes what a job was written against.
- A `maxConcurrent` passed on one call is stored on the job. The drainer honours it later,
  otherwise the cap would only hold until the next refresh — which is exactly how the
  smoke test caught it.

**Jobs run detached, not as child processes of the MCP server.**
An MCP tool call that blocks for fifteen minutes is a broken tool call. A runner process
(`src/runner.mjs`) owns the worker, enforces the timeout with a watchdog, and writes the exit
code to disk. State is therefore reconstructible: restart Claude mid-job and `fleet_status`
still reports it correctly.

This started life as a generated `run.sh`, which was three platform bugs waiting to happen:
`/bin/sh` does not exist on Windows, the watchdog was a `sleep`-based subshell, and every
path had to survive POSIX quoting. The runner takes an argv array from a JSON spec, so no
string is ever parsed as a command — `test/runner.test.mjs` pins that with an argument
containing spaces, quotes, backslashes, `$` and `;`. Platform-specific behaviour is confined
to `src/process.mjs`, whose branches are unit-tested from any OS via `killCommandFor()`.

**A wrong model id makes OpenCode hang, not fail.**
`opencode run --model does/not-exist` produced no output and never exited in testing. That
is why every job has a hard timeout and why the budget guard validates before spawning.

**The model list is a hint, not a gate.**
`opencode models` answers differently depending on what it has already fetched — 92 entries
on a cold start, 161 a moment later, and project-local providers only appear when the
command runs inside that project. So: the list is queried per directory, short answers are
never cached, a miss triggers exactly one refresh, and a model that is still missing runs
anyway with a warning. Treating that list as authoritative would randomly refuse valid work.

**Auto-commit on the job branch.**
The worker is told not to touch git. The harness commits its changes itself when the job
ends, which makes the diff stable (`baseSha..HEAD`), survives worktree cleanup, and turns
landing the work into an ordinary merge.

**Unpriced means refused.**
A model whose price cannot be established fails the guard instead of running. Anything else
would make the daily limit a suggestion. Prices resolve in this order: `staticPricing`
override → live OpenRouter API → models.dev (which opencode itself resolves against, so ids
match and all 200+ providers are covered) → refuse. Local models are priced at zero in
`staticPricing`.

**Availability is learned, not assumed.**
A provider failure is recorded against the model that caused it; the next
delegation puts that model last in its profile for 30 minutes. The candidate is
never dropped — a single outage should not permanently retire a model — and one
success clears the record immediately. This came from a real run where a free
endpoint died mid-job: the failover recovered, but the knowledge died with the
job, so the next one paid for the same wasted attempt.

**Ranking uses published benchmarks where they exist.**
`capabilityOf()` reads Artificial Analysis' coding and agentic indices out of the
OpenRouter catalogue (about 165 of 395 models carry them) and weights them 60/40;
`valueScore()` divides that by the blended price. Name matching survives only as the
fallback for unmeasured models, capped below the measured mid-field. The name regexes
carry word boundaries for a reason: without them "gemini" matches "mini" and every
Gemini model is penalised as a small variant.

**Suggestions only name providers you can reach.**
`opencode models` happily lists Bedrock and Copilot models on a machine with no such
credentials; a profile built from that list would hang on first use. `ocfleet suggest`
therefore intersects the model list with the providers found in opencode's auth store, your
opencode config, and the usual API-key environment variables — reading provider names only,
never secrets.

**Isolation is what makes `--auto` acceptable.**
Workers auto-approve their own permissions, which would be reckless in your working tree and
is unremarkable in a throwaway branch nobody merges unreviewed. `readOnly: true` additionally
denies edits via `OPENCODE_CONFIG_CONTENT` for investigation-only jobs.

## Testing

`test/mcp_smoke.mjs` starts `test/mock_llm.py` (a mock OpenAI-compatible model that emits real
streamed tool calls), builds a throwaway repo, and drives the MCP server over stdio JSON-RPC
through the whole cycle: handshake, tool schemas, doctor, budget rejections, two parallel jobs
in separate worktrees, result and diff, a follow-up round, squash-merge, a deliberate merge
conflict, cleanup, and the spend ledger. It costs nothing and needs no API key.
