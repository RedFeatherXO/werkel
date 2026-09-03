# werkel

**Claude plans and reviews. Cheap models type.**

An MCP server that lets any Claude agent hand coding jobs to [OpenCode](https://opencode.ai)
workers running whatever model you point them at — Qwen3-Coder, GLM, DeepSeek, a local
Ollama model — while Claude stays the manager: it writes the work order, reviews every
diff, and decides what lands.

Every job runs in its own **git worktree on its own branch**, so eight workers can run at
once without stepping on each other, and nothing reaches your working tree until you merge
it. A **price guard** refuses any model above your ceiling and stops work at a daily spend
limit.

## Quick start

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/RedFeatherXO/werkel/main/scripts/bootstrap.sh | bash
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/RedFeatherXO/werkel/main/scripts/bootstrap.ps1 | iex
```

Then three commands, once:

```bash
opencode auth login       # openrouter (recommended), zai, deepseek, opencode zen …
werkel suggest --write    # build model profiles from the providers you just logged into
werkel doctor --warmup    # verify, and pre-download the provider package
```

Restart Claude, and ask it in plain language:

> Delegate the retry-wrapper refactor in `src/api/` to a cheap worker, add tests for the
> parser in parallel, and show me the diffs before anything lands.

That is the whole setup. No npm dependencies — plain Node ≥18, git, and the `opencode` CLI.

<details>
<summary>What the one-liner does, and how to do it by hand instead</summary>

Both bootstrap scripts clone into `~/werkel` (override with `WERKEL_DIR`), check node and
git, and run the installer for your platform. Run either again later and it pulls and
re-installs instead of cloning — the same line is also the updater.

Piping a script from the internet into a shell means running code you have not read, which
is a reasonable thing to object to. The two-step version does exactly the same work and
lets you look first:

```bash
git clone https://github.com/RedFeatherXO/werkel && cd werkel
bash scripts/install.sh
# Windows: powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

`--warmup` matters on the first run: OpenCode downloads a provider package the first time
it really runs, which otherwise looks like a hang.
</details>

<details>
<summary>If <code>werkel</code> is not found</summary>

The installer symlinks it into `~/.local/bin`. If that directory is new, your shell does not
know about it yet — open a new terminal, or run the linker on its own:

```bash
node bin/werkel.mjs link                 # also repairs the executable bits
node bin/werkel.mjs link --dir ~/bin     # somewhere else on your PATH
```

`./werkel` from the repo folder always works and needs no setup at all. Copying this repo
through a zip, an editor or a file-sync bridge tends to drop the executable bit; `link` puts
it back, which is why it is safe to re-run. On Windows it prints the PATH line to add,
because there is no symlink to make.
</details>

<details>
<summary>Registering with Claude by hand</summary>

```json
{ "mcpServers": {
    "werkel": { "command": "node", "args": ["/abs/path/werkel/bin/werkel.mjs", "mcp"] } } }
```

Claude Code: `claude mcp add --scope user werkel -- node /abs/path/bin/werkel.mjs mcp`

The manager skill (`skills/werkel/SKILL.md`) teaches Claude when to delegate, how to brief a
worker and what to look for in a review. Copy it to `~/.claude/skills/` — the installer does
this for you.
</details>

<details>
<summary>Windows notes</summary>

Jobs are started by a small node runner rather than a shell script, so there is one code path
everywhere: no `/bin/sh`, no POSIX quoting, and paths with spaces are handled by passing an
argv array instead of a command line. On Windows the runner stops a job's process tree with
`taskkill /T`; on POSIX it signals the process group. The test suite runs on Linux, Windows
and macOS in CI.

One caveat that is not ours: **opencode itself recommends WSL on Windows** for full
compatibility. werkel runs natively either way, but if workers behave strangely there, try
the same setup inside WSL before suspecting werkel — `werkel doctor` prints this note on
Windows for the same reason.
</details>

## How it works

```
   Claude (manager)                    werkel (MCP)              OpenCode workers
   ─────────────────                   ────────────────────      ─────────────────
   splits the work        ──delegate──▶  budget guard        ──▶ job A · qwen3-coder
   writes work orders                    git worktree per job ──▶ job B · glm-5.3-flash
   reviews the diffs      ◀──result───   detached runs, cost log ─▶ job C · deepseek
   merges what is good    ──apply────▶   merge / squash / patch
```

1. `werkel_delegate` resolves a model through the budget guard and pins the base commit.
2. If a worker slot is free the job starts at once: branch `werkel/<jobId>` plus a worktree
   under `~/.werkel/worktrees/`. If all slots are busy the job is **queued**, not refused —
   it comes back with a `queuePosition` and starts on its own when a slot frees up. Send as
   many jobs as the work has.
3. The task becomes a structured work order (`prompt.md`): task, manager context, files,
   constraints, verification command, definition of done, and a fixed report format.
4. OpenCode runs **detached**; a runner process enforces the timeout and records the exit
   code, so a job survives an MCP restart and can never hang a tool call.
5. On completion werkel commits the worker's changes on its branch, parses tokens and cost
   from the event stream, and hands the freed slot to whichever job has waited longest.
6. You review, then merge, squash, or export a patch.

The concurrency limit is about the machine, not the money: each worker is an opencode process
plus a full working copy on disk, and providers rate-limit parallel requests from one key. The
daily spend cap and the price ceilings are separate, and they refuse rather than queue.

Job state lives in `~/.werkel/jobs/<id>/`: `prompt.md`, `events.ndjson`, `stderr.log`,
`run.json`, `job.json`. Nothing is hidden.

## From a shell

Claude drives the tools itself, but the same engine is a CLI:

```bash
werkel dashboard --open             # every worker as a card, locally, no setup
werkel board                        # every routable model ranked, with what werkel learned
werkel delegate "Wrap every fetch in src/api/*.ts in withRetry" \
   --repo . --profile cheap \
   --context "withRetry lives in src/lib/retry.ts and takes (fn, opts)" \
   --verify "npx tsc --noEmit" --wait
werkel status                       # all jobs, cost, duration
werkel diff  <jobId>                # review
werkel apply <jobId> --mode squash  # land it
werkel cleanup <jobId>
```

Three equivalent ways to call it: `werkel …` once it is on your PATH, `./werkel …` from the
repo folder, or `node bin/werkel.mjs …` which always works. On Windows: `.\werkel` or
`node bin\werkel.mjs`.

## The tools Claude gets

| Tool | What it does |
|---|---|
| `werkel_delegate` | Start a job (returns immediately with a jobId; queues it if every slot is busy) |
| `werkel_wait` | Block until jobs finish — starts waiting jobs as slots free up |
| `werkel_status` | Running + queued + recent jobs, cost, duration |
| `werkel_result` | Worker report + changed files + diffstat |
| `werkel_diff` | The patch |
| `werkel_logs` | Every tool call the worker made (catches fake "tests pass") |
| `werkel_followup` | Send review feedback into the same session/worktree |
| `werkel_apply` | merge / squash / write a .patch |
| `werkel_rate` | Record how a job actually turned out, so routing learns |
| `werkel_cancel`, `werkel_cleanup` | Kill a job, remove worktree + branch |
| `werkel_models` | Routable models with prices and guard verdicts |
| `werkel_doctor` | Binaries, providers, profiles, budget, stuck jobs |

## Configuration

`~/.werkel/werkel.config.json` (global) or `.werkel.json` in a repo. Start from
[`config/werkel.config.example.json`](config/werkel.config.example.json).

```jsonc
{
  "budget": {
    "maxPromptUsdPerMTok": 1.0,      // hard ceiling, input
    "maxCompletionUsdPerMTok": 4.0,  // hard ceiling, output
    "maxDailyUsd": 10.0,             // werkel stops for the day
    "requireToolSupport": true,      // a model without tool calling cannot edit files
    "deny": ["*gpt-5*", "*claude*"]  // never route here
  }
}
```

A model whose price cannot be established is refused rather than silently billed. Prices come
from [models.dev](https://models.dev) — the same catalogue OpenCode resolves against — plus
OpenRouter's live API for `openrouter/*`, both cached 24 h.

**Don't hand-write candidate lists.** `werkel suggest --write` builds them from the providers
you actually hold credentials for (read from opencode's auth store — keys are never read, only
provider names), so a profile cannot point at something that would hang on first use. Profiles
older than a week re-rank themselves against the current catalogue on the next delegation.

<details>
<summary>How models are ranked</summary>

On published benchmarks, not guesswork. The OpenRouter catalogue carries Artificial Analysis
indices for many of its models, and werkel scores a worker as
`0.6 × coding_index + 0.4 × agentic_index` — a worker has to write the code *and* drive the
tools. `value = capability / (1 + blended price)` with `blended = (3 × input + output) / 4`,
since a coding turn reads far more than it writes. Models without published numbers are
estimated from their name, deliberately below a measured mid-tier model, so an unknown never
outranks a proven one on a guess. `werkel board` prints both (`~` marks an estimate).

On top of that sits what *your* jobs did: whether you merged the diff, whether it needed a
second round, whether it claimed a verification it never ran. That moves a model by at most
±10 points, scaled by how much evidence there is — zero evidence moves it exactly zero, and
one lucky job cannot outweigh a hundred. Weight halves every 45 days and every 30 jobs, so a
model that gets worse loses its lead within a few dozen jobs rather than coasting on history.

Free endpoints go down for minutes at a time, and collapse under parallel load: a measured run
of ten simultaneous jobs on a free model produced three HTTP 429s and a vanished worker. werkel
remembers a provider failure and skips that model for 30 minutes rather than rediscovering the
outage on every job. `werkel health` shows what it learned; `werkel probe` tests every candidate
before you rely on them. Use free models for sequential bulk work, not for fan-out.
</details>

## Safety notes

Workers run with `--auto` (auto-approved permissions) because the worktree is the sandbox: a
job can only damage its own branch, and you see the diff before it lands.

**`--auto` is also why "ask" is not a restriction.** It answers every permission prompt with
yes, so `ask` and `allow` behave identically. Only `deny` restricts anything, and
`readOnly: true` denies all four: edit, write, patch — and bash. A read-only worker gets
`read`, `grep`, `glob` and `webfetch`, and cannot change a byte.

That costs you test runs, so there is an opt-out: pass a `verify` command (or
`allowBash: true`) and the shell comes back, edits stay denied, and the job result says so in
`notices`. Useful for "investigate this failure and run the suite" — but be honest about what
it is: a shell that can write files even though the file tools cannot.

**No worktree means no sandbox.** `worktree: false` puts the worker in your actual directory on
your actual branch, with auto-approved permissions and no diff to review. Right for read-only
investigation, wrong for almost everything else; `werkel_delegate` says so in `notices` every
time.

## Development

```bash
npm test              # unit tests, mock provider, then the full end-to-end suite
npm run test:unit     # fast: no opencode, no network
npm run test:dashboard
```

The end-to-end suite drives the MCP server over real stdio JSON-RPC against a mock
OpenAI-compatible model (`test/mock_llm.py`), so it exercises delegation, parallel worktrees,
follow-up rounds, merge conflicts, failover and the budget guard without spending anything.
CI runs it on Linux, Windows and macOS.

MIT licensed.
