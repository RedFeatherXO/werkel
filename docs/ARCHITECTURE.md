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

**A model ranking that runs once is not a ranking, it is a snapshot.**
The scoring existed only inside `ocfleet suggest`, a command run by hand — so a
candidate list written in August stayed in force indefinitely while new models
appeared weekly. Nothing broke, which is why nobody would notice: the jobs kept
running, just not on the best thing available. Profiles older than
`defaults.profileMaxAgeDays` are now re-ranked on the next delegation.

Two guards make that safe to do unattended. `suggestProfiles` now applies
`budgetCheck` to everything it proposes, so an auto-refresh can only ever produce
models the guard already allows — never a premium one, never a denylisted one.
(It did not before, which is how a denylisted `gpt-5` ended up sitting in a
suggested `balanced` profile, refused on every single job.) And a config without a
`profilesWrittenAt` stamp is never touched: no stamp means the fleet did not write
those profiles, and replacing someone's hand-curated list on their next delegation
would be losing their work, not refreshing it. `suggest --write` stamps the file,
which is what opts a user in.

Ordering within a profile moved to resolve time for the same reason: the stored
order records what was best when the list was written. `resolveModel` sorts by
today's score (recent failures still go last) and hands that order to the failover
chain, so a retry cannot ignore the ranking the first attempt applied.

**Polling is the manager's real cost, so a poll that has nothing to say says nothing.**
A blocking `fleet_wait` survives about fifty seconds before a desktop bridge cuts the
call (measured: 240s fails with "device did not respond within 60s", 52s returns
fine). Waiting longer is therefore impossible and backing off is pointless — there is
no idle time between calls, each already blocks to the ceiling. The number of round
trips is fixed at wall-clock ÷ 50s, so the only lever is what each one returns.

A seventeen-minute batch of three jobs was polled eighteen times, and each reply
carried a full `jobView` per job — id, title, model, worktree path, branch, duration
in two formats, queue wait, null cost — about 280 tokens to say "still running".
`stillRunning` is now one line per job, and when nothing has changed state at all
since the caller's last wait the reply is `{unchanged: true, stillRunning: [...]}`
and nothing else: 4x smaller, and the flag lets the manager skip thinking about it
entirely. `jobPulse()` decides what counts as a change — state, attempt index and
model — so a silent poll can never hide a finished job or a failover.

Three smaller leaks went with it: `fleet_result` echoed the manager's own thousand-word
work order back at them, shipped the full patch by default (now `fleet_diff`'s job,
with the diffstat left behind to decide by), and `fleet_logs` repeated the absolute
worktree path on every one of its forty tool calls.

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
restricts the job via `OPENCODE_CONFIG_CONTENT`.

The first version of that restriction set `bash: "ask"`, which under `--auto` means "allow" —
a ten-job test run showed `tools: bash×1` on jobs that had asked for read-only, in the user's
home directory, with `worktree: false`. `permissionFor()` is now a pure function that never
emits `ask` at all (`test/permission.test.mjs` pins that), and the smoke test reads the mock
provider's request log to assert which tools opencode actually offered the model — the only
place where a denied permission is observable from outside. A `verify` command re-enables
bash on purpose, and the delegate result reports the escalation in `notices` rather than
letting it happen quietly.

## Testing

`test/mcp_smoke.mjs` starts `test/mock_llm.py` (a mock OpenAI-compatible model that emits real
streamed tool calls), builds a throwaway repo, and drives the MCP server over stdio JSON-RPC
through the whole cycle: handshake, tool schemas, doctor, budget rejections, two parallel jobs
in separate worktrees, result and diff, a follow-up round, squash-merge, a deliberate merge
conflict, cleanup, and the spend ledger. It costs nothing and needs no API key.
