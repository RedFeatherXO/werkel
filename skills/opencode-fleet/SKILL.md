---
name: opencode-fleet
description: Delegate coding work to OpenCode workers running cheap models while you stay the manager — plan, brief, review every diff, and land it. Use when a task is large, parallelizable, or mechanical enough that a cheaper model can execute it under supervision, or when the user asks to "delegate", "use opencode", "farm this out", "run workers", or to save tokens/cost on bulk changes.
---

# Managing an OpenCode fleet

You are the manager. OpenCode workers on cheap models are the hands. You keep the
plan, the repo knowledge and the judgement; they type. Their output is a proposal
until you have read it.

## When to delegate

Delegate when the work is **specifiable**: you can write down what "done" looks
like and how to check it.

| Delegate | Keep yourself |
|---|---|
| Mechanical refactors across many files | Architecture and API design |
| Adding tests for existing behaviour | Deciding what the behaviour should be |
| Boilerplate: CRUD endpoints, adapters, migrations, fixtures | Security-sensitive code, auth, crypto, payments |
| Applying one pattern to N call sites | The first instance of a new pattern (do it yourself, then delegate the rest) |
| Read-only investigation across a large codebase | Final diagnosis and the fix strategy |
| Doc strings, type annotations, dead-code removal | Anything you cannot verify afterwards |

If writing the work order takes longer than doing the change, do it yourself.

## What a worker is allowed to do

The default is a git worktree with auto-approved permissions: the worker can do
anything inside its own branch, and you review the diff before it lands.

`readOnly: true` denies edit, write, patch **and bash**. The worker gets `read`,
`grep`, `glob` and `webfetch` — enough to investigate a large codebase, not enough
to change it. Use it whenever you want an answer rather than a change, especially
on a cheap model you do not fully trust.

Two things to know before you reach for it:

- **A `verify` command re-enables bash**, because you asked for a command to be
  run. Edits stay denied, and the result says so in `notices`. That combination is
  right for "find out why this test fails, and run it" — but a shell can write
  files even when the file tools cannot. Pass `allowBash: false` if you want the
  investigation without the shell.
- **`worktree: false` removes the sandbox entirely.** The worker acts on the real
  directory and the real branch, with nothing to review afterwards. Pair it with
  `readOnly: true` for investigations; otherwise leave worktrees on.

## The loop

1. **`fleet_doctor`** once per session (or when a delegation fails). It tells you
   which profiles can route anywhere and what today's spend is.
2. **Split the work** into jobs that do not touch the same files. Jobs run in
   separate git worktrees, so file-level independence is what keeps merges clean.
3. **`fleet_delegate`** each job. Start them all before waiting on any — that is
   where the wall-clock win comes from.
4. **`fleet_wait`** on the batch. Poll in short calls (45s or less) rather than one
   long wait — a bridge between you and the fleet may cap how long a single call can
   block (a desktop bridge typically cuts off at 60s, so waiting longer is not an
   option, only waiting more often). A reply of `{unchanged: true, stillRunning: [...]}`
   means literally nothing has happened since your last call: do not reason about it,
   do not report it to the user, just call again. A job that finished brings its
   report with it, so you usually skip straight to step 5's second half.
5. **`fleet_result`** per job. It carries the report, the changed files and the
   diffstat — but **not** the patch, which runs to thousands of tokens. Call
   **`fleet_diff`** when the report gives you a reason to look. The report is a
   claim; the diff is the evidence, and most claims are worth checking.
6. **`fleet_followup`** with specific feedback (same session, same worktree, keeps
   context, cheap) — or fix trivia yourself instead of paying for another round.
7. **`fleet_apply`** to land it, **`fleet_cleanup`** to drop the worktree.

## Writing a work order

A cheap model with a good briefing beats an expensive one with a vague prompt.
The worker has never seen this repo and cannot ask you anything.

Always supply:

- **task** — imperative, complete, one outcome. Not "improve error handling" but
  "wrap every `fetch` in `src/api/*.ts` in the existing `withRetry` helper".
- **context** — what you already learned: conventions, the helper's location, why
  the obvious approach is wrong. This is the cheapest token you will ever spend;
  it replaces exploration the worker would otherwise do badly.
- **files** — the paths that matter, so it does not grep the world.
- **verify** — a command it must run and report (`npm test -- auth`,
  `python -m pytest tests/test_parser.py -q`, `tsc --noEmit`). Without one you
  are trusting a stranger's self-assessment.
- **done** — the acceptance criterion in one sentence.
- **constraints** — what must not change (public API, dependencies, formatting).

`fleet_models` reports each model's `capability` (0.6·coding + 0.4·agentic from
Artificial Analysis, `~` when estimated from the name) and `value` (capability per
dollar). Use `capability` when the task is hard and `value` when it is bulk work.

Picking a profile: `free` for bulk work where a weaker model is acceptable (zero
cost), `cheap` for mechanical work, `balanced` (default) for normal feature work and
bug fixes, `strong` when the logic is tricky or the first attempt failed,
`longcontext` when the job must read a lot at once, `local` for offline models.
Escalate on failure rather than starting expensive.

Profiles keep themselves current: a candidate list older than
`defaults.profileMaxAgeDays` (7) is re-ranked against the live catalogue on the
next delegation, and the result says so in `notices`. Only lists the fleet wrote
itself are refreshed — a hand-written config is never replaced — and nothing the
budget guard would refuse can ever be proposed, so the worst case is a different
model under the same ceiling. Within a profile the better model goes first,
scored against today's catalogue rather than the order the list happens to be in;
`fleet_delegate` reports that as `reordered` when it changed the outcome.

If a profile reports nothing usable, call `fleet_models` with `suggest: true` — it
proposes candidate lists built from the providers this machine is authenticated for,
which the user can apply with `ocfleet suggest --write` (or `node bin/ocfleet.mjs
suggest --write` — the short command exists only if it was registered at install
time, so mention both when you tell someone to run it).

## Reviewing

Read the patch (`fleet_diff`), not the summary. Watch for the classic worker
failure modes:

- **Scope creep** — reformatting, renaming, "while I was here" edits. Reject.
- **Fake verification** — VERIFICATION says "tests pass" but `fleet_logs` shows no
  bash call. Check the tool log when a claim matters.
- **Stubs and TODOs** — `throw new Error("not implemented")` hidden in a large diff.
- **Deleted tests** — a passing suite achieved by removing assertions.
- **Invented APIs** — calls to functions that do not exist in this repo.

`fleet_logs` shows every tool call the worker made; use it whenever the diff and
the report disagree, or a job failed.

## Parallel work, honestly

**Send as many jobs as the work has.** Nothing is ever refused for being the
eleventh: past `defaults.maxConcurrentJobs` (8) a job comes back as
`state: "queued"` with a `queuePosition`, and starts by itself the moment a slot
frees up. `fleet_status` lists the queue separately, and `fleet_wait` moves it
along while you wait — you never have to poke it.

The limit is not a budget guard (that is `budget`, and it is a hard stop). It
protects the machine: every worker is one opencode process **and** one full git
worktree on disk, and providers rate-limit parallel requests from one key. Two
things follow:

- **Free endpoints collapse under parallel load.** A measured run: ten jobs on
  `glm-5.2:free`, three died with HTTP 429 "temporarily rate-limited upstream",
  one worker vanished mid-run. The failover recovered some of them, but the
  throughput was worse than running them one at a time. For anything parallel,
  use `cheap` — ten small jobs on glm-5.3-flash cost a few cents, and they
  actually finish.
- **The limit is per machine, not per profile.** Ten workers means ten opencode
  processes reading files and running tests on the same disk.

A queued job pins its base commit at submission time, so ten jobs sent against
one state all see that state, however long the last one waits. Pass
`maxConcurrent` on a single `fleet_delegate` call to hold that job to a tighter
limit than the config's — the queue honours it later too.

## Cost discipline

The budget guard refuses any model above the configured price ceiling and stops
new jobs once the daily limit is reached — you cannot accidentally route a bulk
refactor to a premium model. Check `fleet_models` before naming a model
explicitly. Prefer one well-briefed job over three vague ones; each retry costs
the full context again.

## Failure playbook

| Symptom | What it means | Do this |
|---|---|---|
| `no candidate of profile X is usable` | provider not authenticated or ids changed | `fleet_doctor`, then `opencode auth login` |
| job state `timeout` | model hung, or the task was too big | split the task, raise `timeoutSec`, or escalate the profile |
| `previousAttempts` non-empty | the provider failed and the job moved to the next candidate by itself | nothing — but if it happens on every job, check `fleet_doctor`; a provider you pay for may be down |
| the model used is not the profile's first candidate | that one failed recently and is in its cooldown | nothing; it is tried again after 30 minutes, or immediately after it succeeds once |
| `no fallback candidate left` | every model in the profile failed | usually not the models: check credentials, network, or the daily budget |
| `merge failed: CONFLICT` | two jobs touched the same file | `fleet_apply` with `mode:"patch"` and resolve, or re-delegate one job on the updated base |
| empty diff but state `done` | worker only talked | read `fleet_logs`; re-delegate with a sharper task and a `verify` command |
| `daily budget exhausted` | spend cap hit | raise `budget.maxDailyUsd` in `~/.opencode-fleet/fleet.config.json` |

## Reporting back to the user

Say what landed, what it cost, and what you rejected. Example:

> Four jobs, all on qwen3-coder ($0.04 total, 6 min wall clock). Three merged:
> retry wrapper in `api/`, tests for the parser, type annotations in `utils/`.
> The fourth deleted two assertions to make the suite pass — I discarded it and
> did that one myself.
