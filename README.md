# opencode-fleet

**Claude plans and reviews. Cheap models type.**

An MCP server that lets any Claude agent hand coding jobs to [OpenCode](https://opencode.ai)
workers running whatever model you point them at — Qwen3-Coder, GLM, DeepSeek, a local
Ollama model — while Claude stays the manager: it writes the work order, reviews every
diff, and decides what lands.

```
   Claude (manager)                    opencode-fleet (MCP)              OpenCode workers
   ─────────────────                   ────────────────────              ─────────────────
   splits the work        ──delegate──▶  budget guard                ──▶ job A · qwen3-coder
   writes work orders                    git worktree per job        ──▶ job B · glm-4.7-flash
   reviews the diffs      ◀──result───   detached runs, cost log     ──▶ job C · deepseek
   merges what is good    ──apply────▶   merge / squash / patch
```

Every job runs in its own **git worktree on its own branch**, so four workers can run at
once without stepping on each other, and nothing reaches your working tree until you
merge it. A **price guard** refuses any model above your ceiling and stops the fleet at a
daily spend limit.

## Install

```bash
git clone <your-fork> opencode-fleet && cd opencode-fleet
./scripts/install.sh          # checks node/git/opencode, registers the MCP server, installs the skill
opencode auth login           # openrouter (recommended), zai, deepseek, …
node bin/ocfleet.mjs doctor --warmup
```

No npm dependencies — plain Node ≥18, git, and the `opencode` CLI.

### Platforms

Linux, macOS and Windows. Jobs are started by a small node runner rather than a
shell script, so there is one code path everywhere: no `/bin/sh`, no POSIX
quoting, and paths with spaces are handled by passing an argv array instead of a
command line. On Windows the runner stops a job's process tree with `taskkill /T`;
on POSIX it signals the process group.

On Windows, use `scripts\install.ps1` instead of `install.sh`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

One caveat that is not ours: **opencode itself recommends WSL on Windows** for
full compatibility. The fleet runs natively either way, but if workers behave
strangely there, try the same setup inside WSL before suspecting the fleet —
`ocfleet doctor` prints this note on Windows for the same reason.

`--warmup` matters: OpenCode downloads a provider package on its very first real run, which
otherwise looks like a hang.

### Registering with Claude manually

```json
{ "mcpServers": {
    "opencode-fleet": { "command": "node", "args": ["/abs/path/opencode-fleet/bin/ocfleet.mjs", "mcp"] } } }
```

Claude Code: `claude mcp add --scope user opencode-fleet -- node /abs/path/bin/ocfleet.mjs mcp`

The manager skill (`skills/opencode-fleet/SKILL.md`) teaches Claude when to delegate, how to
brief a worker and what to look for in a review. Copy it to `~/.claude/skills/` (the
installer does this).

## How to call it

Three equivalent ways, pick one:

```bash
ocfleet doctor              # after ./scripts/install.sh registered the command
./ocfleet doctor            # launcher in this folder, works immediately
node bin/ocfleet.mjs doctor # always works, no setup at all
```

On Windows use `.\ocfleet doctor` or `node bin\ocfleet.mjs doctor`. The examples
below write `ocfleet` for brevity.

## Use it

Ask Claude, in plain language:

> Delegate the retry-wrapper refactor in `src/api/` to a cheap worker, add tests for the
> parser in parallel, and show me the diffs before anything lands.

Claude then drives the tools itself. From a shell the same engine is available:

```bash
ocfleet dashboard --open             # every worker as a card, locally, no setup
ocfleet probe                        # which models actually answer right now
ocfleet health                       # what the fleet learned about availability
ocfleet models                       # what you can route to, with prices
ocfleet suggest --write              # build profiles from your authenticated providers
ocfleet delegate "Wrap every fetch in src/api/*.ts in withRetry" \
   --repo . --profile cheap \
   --context "withRetry lives in src/lib/retry.ts and takes (fn, opts)" \
   --verify "npx tsc --noEmit" --wait
ocfleet status                       # all jobs, cost, duration
ocfleet diff  <jobId>                # review
ocfleet apply <jobId> --mode squash  # land it
ocfleet cleanup <jobId>
```

## The tools Claude gets

| Tool | What it does |
|---|---|
| `fleet_delegate` | Start a job (returns immediately with a jobId; queues it if every slot is busy) |
| `fleet_wait` | Block until jobs finish — starts waiting jobs as slots free up |
| `fleet_status` | Running + queued + recent jobs, cost, duration |
| `fleet_result` | Worker report + changed files + patch |
| `fleet_diff` | Just the patch |
| `fleet_logs` | Every tool call the worker made (catches fake "tests pass") |
| `fleet_followup` | Send review feedback into the same session/worktree |
| `fleet_apply` | merge / squash / write a .patch |
| `fleet_cancel`, `fleet_cleanup` | Kill a job, remove worktree + branch |
| `fleet_models` | Routable models with prices and guard verdicts (`suggest:true` proposes profiles) |
| `fleet_doctor` | Binaries, providers, profiles, budget, stuck jobs |

## Configuration

`~/.opencode-fleet/fleet.config.json` (global) or `.opencode-fleet.json` in a repo.
Start from [`config/fleet.config.example.json`](config/fleet.config.example.json).

```jsonc
{
  "budget": {
    "maxPromptUsdPerMTok": 1.0,      // hard ceiling, input
    "maxCompletionUsdPerMTok": 4.0,  // hard ceiling, output
    "maxDailyUsd": 10.0,             // fleet stops for the day
    "requireToolSupport": true,      // a model without tool calling cannot edit files
    "deny": ["*gpt-5*", "*claude*"]  // never route here
  },
  "profiles": {
    "cheap":    { "candidates": ["openrouter/qwen/qwen3-coder-30b-a3b-instruct", "openrouter/z-ai/glm-4.7-flash"] },
    "balanced": { "candidates": ["openrouter/qwen/qwen3-coder", "zai/glm-4.7"] },
    "strong":   { "candidates": ["openrouter/qwen/qwen3-coder-plus", "openrouter/moonshotai/kimi-k2.7-code"] }
  }
}
```

Prices come from [models.dev](https://models.dev) — the same catalogue OpenCode resolves
models against, so every provider it can reach is covered (OpenCode Zen, Z.ai, DeepSeek,
OpenRouter, …) — plus OpenRouter's live API for `openrouter/*`, both cached 24 h. Entries in
`staticPricing` override both. A model whose price cannot be established is refused rather
than silently billed. Provider setup for OpenCode itself:
[`config/opencode.providers.example.json`](config/opencode.providers.example.json).

Models are ranked on published benchmarks, not guesswork. The OpenRouter catalogue
carries Artificial Analysis indices for ~165 of its models, and the fleet scores a
worker as `0.6 × coding_index + 0.4 × agentic_index` — a worker has to write the code
*and* drive the tools. `value = capability / (1 + blended price)` with
`blended = (3 × input + output) / 4`, since a coding turn reads far more than it writes.
Models without published numbers are estimated from their name, deliberately below a
measured mid-tier model, so an unknown never outranks a proven one. `ocfleet models`
prints both numbers (`~` marks an estimate).

Don't hand-write candidate lists — generate them from what you actually have:

```bash
ocfleet suggest           # show proposed profiles, ranked by price and coding fitness
ocfleet suggest --write   # write them into ~/.opencode-fleet/fleet.config.json (keeps a .bak)
```

Free endpoints also collapse under parallel load — a measured run of ten
simultaneous jobs on a free model produced three HTTP 429s and a vanished
worker, while the same jobs on `cheap` cost a few cents and completed. Use free
models for sequential bulk work, not for fan-out.

Free endpoints go down for minutes at a time. The fleet remembers that: a model
that fails with a provider error is skipped for the next 30 minutes and the job
moves straight to the profile's next candidate, instead of rediscovering the
outage every time. `ocfleet health` shows what it learned, `ocfleet probe` tests
every candidate on purpose before you rely on them, and a success clears a
model's record immediately.

It only proposes models from providers you hold credentials for (read from opencode's
auth store and your config — keys are never read, only provider names), so a suggested
profile cannot point at a provider that would hang on first use.

A profile resolves to the first candidate that is both affordable and reachable. If none is
listed by `opencode models` (which can lag right after adding a provider) the first
affordable candidate runs anyway, with a warning — a stale model list never blocks work.

## How a job runs

1. `fleet_delegate` resolves a model through the budget guard and pins the base commit.
2. If a worker slot is free the job starts at once: `fleet/<jobId>` plus a worktree under
   `~/.opencode-fleet/worktrees/`. If all `maxConcurrentJobs` slots are busy the job is
   **queued**, not refused — it comes back with a `queuePosition` and starts on its own when
   a slot frees up. Send as many jobs as the work has.
3. The task becomes a structured work order (`jobDir/prompt.md`): task, manager context,
   files, constraints, verification command, definition of done, and a fixed report format.
4. OpenCode runs **detached** with `--format json`; a runner process enforces the timeout and
   records the exit code, so a job survives an MCP restart and can never hang a tool call.
5. On completion the harness commits the worker's changes on its branch, parses tokens and
   cost from the event stream, and appends to `~/.opencode-fleet/spend/<date>.json` — and
   hands the freed slot to whichever job has been waiting longest.
6. You review, then merge, squash, or export a patch.

The concurrency limit is about the machine, not the money: each worker is an opencode
process plus a full working copy on disk, and providers rate-limit parallel requests from
one key. The daily spend cap and the price ceilings are separate, and they refuse rather
than queue. A queued job keeps the base commit it was submitted against, so a long wait
never silently changes what the worker started from.

Job state lives in `~/.opencode-fleet/jobs/<id>/`: `prompt.md`, `events.ndjson`,
`stderr.log`, `run.json`, `job.json`. Nothing is hidden.

## Safety notes

Workers run with `--auto` (auto-approved permissions) because the worktree is the sandbox:
a job can only damage its own branch, and you see the diff before it lands.

**`--auto` is also why "ask" is not a restriction.** It answers every permission prompt with
yes, so a setting of `ask` and a setting of `allow` behave identically. Only `deny` restricts
anything, and `readOnly: true` denies all four: edit, write, patch — and bash. A read-only
worker gets `read`, `grep`, `glob` and `webfetch`, and cannot change a byte.

That last one costs you test runs, so there is an opt-out: pass a `verify` command (or
`allowBash: true`) and the shell comes back, edits stay denied, and the job result says so
in `notices`. Useful for "investigate this failure and run the suite", but be honest about
what it is — a shell that can write files even though the file tools cannot.

**No worktree means no sandbox.** `worktree: false` puts the worker in your actual directory
on your actual branch, with auto-approved permissions and no diff to review. It is the right
choice for read-only investigation and the wrong one for almost everything else;
`fleet_delegate` says so in `notices` every time, whether the directory is a git repo or not.

## Development

```bash
node test/mcp_smoke.mjs /tmp/opencode-fleet-testrepo
```

The suite drives the MCP server over real stdio JSON-RPC against a mock OpenAI-compatible
model (`test/mock_llm.py`), so it exercises delegation, parallel worktrees, follow-up
rounds, merge conflicts and the budget guard without spending anything.

MIT licensed.
