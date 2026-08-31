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
| `src/doctor.mjs` | Setup diagnosis: binaries, providers, profiles, budget, stale jobs, optional warmup run. |
| `src/config.mjs` | Layered config: defaults → global → project → `OPENCODE_FLEET_CONFIG`. |
| `bin/ocfleet.mjs` | CLI over the same engine, plus `mcp` and `install`. |

State lives under `~/.opencode-fleet/` (override with `OPENCODE_FLEET_HOME`):

```
jobs/<jobId>/  job.json  prompt.md  events.ndjson  stderr.log  run.sh  exit
worktrees/     <repo>-<jobId>/            one checkout per job
spend/         2026-08-31.json            daily cost ledger
cache/         openrouter.json  opencode-models-<dir>.json
```

## Job flow

```
fleet_delegate
  ├─ loadConfig(repo)                    global + project layers
  ├─ resolveModel(profile|model)         budget guard decides before anything runs
  ├─ createWorktree()                    git worktree add -b fleet/<jobId>
  ├─ buildWorkerPrompt()                 → jobDir/prompt.md
  └─ launch()                            sh run.sh (detached) → opencode run --format json
                                              │
                                              ├─ events.ndjson   (step_start / tool_use / text / step_finish)
                                              └─ exit            (exit code, written by the wrapper)
fleet_wait / fleet_status
  └─ refresh()  reads exit + events → state, tokens, cost, report → auto-commit on the job branch
fleet_result / fleet_diff → review → fleet_apply → fleet_cleanup
```

## Design decisions, and the surprises behind them

**Jobs run detached, not as child processes of the MCP server.**
An MCP tool call that blocks for fifteen minutes is a broken tool call. A shell wrapper
(`run.sh`) owns the process, enforces the timeout with a watchdog, and writes the exit code
to disk. State is therefore reconstructible: restart Claude mid-job and `fleet_status` still
reports it correctly.

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
