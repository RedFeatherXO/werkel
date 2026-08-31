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

## The loop

1. **`fleet_doctor`** once per session (or when a delegation fails). It tells you
   which profiles can route anywhere and what today's spend is.
2. **Split the work** into jobs that do not touch the same files. Jobs run in
   separate git worktrees, so file-level independence is what keeps merges clean.
3. **`fleet_delegate`** each job. Start them all before waiting on any — that is
   where the wall-clock win comes from.
4. **`fleet_wait`** on the batch.
5. **`fleet_result`** per job, then **read the patch**. The report is a claim; the
   diff is the evidence.
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

Picking a profile: `free` for bulk work where a weaker model is acceptable (zero
cost), `cheap` for mechanical work, `balanced` (default) for normal feature work and
bug fixes, `strong` when the logic is tricky or the first attempt failed,
`longcontext` when the job must read a lot at once, `local` for offline models.
Escalate on failure rather than starting expensive.

If a profile reports nothing usable, call `fleet_models` with `suggest: true` — it
proposes candidate lists built from the providers this machine is authenticated for,
which the user can apply with `ocfleet suggest --write`.

## Reviewing

Read the patch, not the summary. Watch for the classic worker failure modes:

- **Scope creep** — reformatting, renaming, "while I was here" edits. Reject.
- **Fake verification** — VERIFICATION says "tests pass" but `fleet_logs` shows no
  bash call. Check the tool log when a claim matters.
- **Stubs and TODOs** — `throw new Error("not implemented")` hidden in a large diff.
- **Deleted tests** — a passing suite achieved by removing assertions.
- **Invented APIs** — calls to functions that do not exist in this repo.

`fleet_logs` shows every tool call the worker made; use it whenever the diff and
the report disagree, or a job failed.

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
| `merge failed: CONFLICT` | two jobs touched the same file | `fleet_apply` with `mode:"patch"` and resolve, or re-delegate one job on the updated base |
| empty diff but state `done` | worker only talked | read `fleet_logs`; re-delegate with a sharper task and a `verify` command |
| `daily budget exhausted` | spend cap hit | raise `budget.maxDailyUsd` in `~/.opencode-fleet/fleet.config.json` |

## Reporting back to the user

Say what landed, what it cost, and what you rejected. Example:

> Four jobs, all on qwen3-coder ($0.04 total, 6 min wall clock). Three merged:
> retry wrapper in `api/`, tests for the parser, type annotations in `utils/`.
> The fourth deleted two assertions to make the suite pass — I discarded it and
> did that one myself.
