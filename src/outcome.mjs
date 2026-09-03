/**
 * Turn what a job actually did into evidence about the model that did it.
 *
 * The strongest signal here is not an opinion, it is an action: a diff that got
 * merged was read by someone who then let it into their code. That is revealed
 * preference, and it was being thrown away — werkel_apply wrote nothing back to
 * the job record, so five minutes later nobody could tell an accepted job from a
 * discarded one.
 *
 * What deliberately does NOT count:
 *  - provider failures. A 503 says the endpoint was down, not that the model
 *    writes bad code. src/health.mjs already tracks that, and mixing the two
 *    would punish a good model for its provider's bad afternoon.
 *  - read-only and in-place jobs. They produce no diff, so "never applied"
 *    means nothing at all about them.
 *  - jobs the manager cancelled. No information either way.
 */
import { record, load, save } from "./experience.mjs";

/** Weights say how much a signal is worth, and they are opinions worth arguing with. */
export const WEIGHTS = {
  rated: 1.5,        // a manager who read the diff outranks every proxy below
  applied: 1.0,      // it landed in the repo — the strongest thing we observe by ourselves
  fakeVerify: 1.0,   // claimed the tests pass without ever running them
  failed: 0.8,       // died for a reason that was not the provider's fault
  discarded: 0.6,    // finished, was never applied, then cleaned up — weak: plans change
  followup: 0.5      // needed a second round, so the first one was not enough
};

/** Only jobs that could produce a reviewable diff say anything about model quality. */
export function isRateable(job) {
  if (!job) return false;
  if (job.readOnly) return false;
  if (job.worktree?.mode !== "worktree") return false;   // in-place: no diff, no verdict
  if (job.state === "cancelled" || job.state === "queued" || job.state === "running") return false;
  return true;
}

/**
 * A worker that reports a verification it never ran is the single worst thing a
 * cheap model does, because it converts "I could not do it" into "it is done".
 * The report claims a result; the tool log says whether a shell ever opened.
 */
export function claimedUnrunVerification(job, toolSummary) {
  if (!job?.verify || !job?.report) return false;
  const line = String(job.report).split(/\r?\n/).find((l) => /^VERIFICATION:/i.test(l.trim()));
  if (!line) return false;
  if (/\bnot run\b|\bnicht ausgef/i.test(line)) return false;     // honest about not running it
  return !/bash/.test(String(toolSummary ?? job.toolSummary ?? ""));
}

/** The stored source carries the job id, so one job's verdict stays identifiable:
 *  it can be replaced when the manager changes their mind, and recording the same
 *  thing twice cannot make a single job vote twice. */
const tag = (kind, jobId) => `${kind}#${jobId}`;

/** Remove this job's earlier events of one kind. Returns how many went. */
export function dropOutcome(job, kind) {
  const data = load();
  const want = tag(kind, job.id);
  let removed = 0;
  for (const bucket of Object.values(data)) {
    const before = bucket.events?.length ?? 0;
    if (!before) continue;
    bucket.events = bucket.events.filter((e) => e.s !== want);
    removed += before - bucket.events.length;
  }
  if (removed) save(data);
  return removed;
}

/**
 * Record one observation about a finished job. Idempotent per (job, kind): calling
 * werkel_apply twice, or a refresh that runs again over a finished job, must not
 * turn one outcome into two votes.
 */
export function noteOutcome(job, kind, { note, outcome, weight, at, replace = true } = {}) {
  if (!isRateable(job) && kind !== "rated") return null;
  if (replace) dropOutcome(job, kind);
  const w = weight ?? WEIGHTS[kind] ?? 1;
  const o = outcome ?? (kind === "applied" ? 1 : kind === "followup" ? 0.25 : 0);
  return record({
    model: job.model, profile: job.profile ?? null,
    outcome: o, weight: w, source: tag(kind, job.id), note, at
  });
}
