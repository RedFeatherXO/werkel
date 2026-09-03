import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// This layer decides what a finished job says about the model that ran it. The
// interesting part is not what it records but what it refuses to: a provider
// outage, a read-only investigation and a cancelled job all look like "no diff
// was applied" while saying nothing whatsoever about the model.

process.env.OPENCODE_FLEET_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ocfleet-out-"));
const O = await import("../src/outcome.mjs");
const E = await import("../src/experience.mjs");

const job = (extra = {}) => ({
  id: "20260903-1", model: "openrouter/z-ai/glm-5.3-flash", profile: "cheap",
  state: "done", worktree: { mode: "worktree", path: "/tmp/x", branch: "fleet/x" }, ...extra
});

test("only a job that could produce a reviewable diff is evidence", () => {
  assert.equal(O.isRateable(job()), true);
  // no diff exists, so "never applied" means nothing about the model
  assert.equal(O.isRateable(job({ readOnly: true })), false);
  assert.equal(O.isRateable(job({ worktree: { mode: "in-place", path: "/tmp/x" } })), false);
  assert.equal(O.isRateable(job({ worktree: null })), false);
  // no information either way
  assert.equal(O.isRateable(job({ state: "cancelled" })), false);
  assert.equal(O.isRateable(job({ state: "running" })), false);
  assert.equal(O.isRateable(job({ state: "queued" })), false);
  assert.equal(O.isRateable(null), false);
});

test("a verification claimed but never run is caught", () => {
  const j = job({ verify: "npm test", report: "SUMMARY: done\nVERIFICATION: npm test → 12 passing" });
  assert.equal(O.claimedUnrunVerification(j, "read×3, write×1"), true, "no shell ever opened");
  assert.equal(O.claimedUnrunVerification(j, "read×3, bash×1"), false, "it did run something");
});

test("a worker that admits it did not run the command is not accused of lying", () => {
  const j = job({ verify: "npm test", report: "SUMMARY: done\nVERIFICATION: not run — no test runner in this repo" });
  assert.equal(O.claimedUnrunVerification(j, "read×3"), false);
});

test("no verify command means nothing to fake", () => {
  assert.equal(O.claimedUnrunVerification(job({ report: "VERIFICATION: all good" }), "read×1"), false);
  assert.equal(O.claimedUnrunVerification(job({ verify: "npm test" }), "read×1"), false);  // no report yet
});

test("one job cannot vote twice for the same reason", () => {
  E.save({});
  const j = job({ id: "dup-1" });
  O.noteOutcome(j, "applied");
  O.noteOutcome(j, "applied");
  O.noteOutcome(j, "applied");
  const st = E.statsFor(j.model, j.profile);
  assert.equal(st.n, 1, "re-recording the same outcome must replace it, not stack it");
});

test("different jobs on the same model each count once", () => {
  E.save({});
  O.noteOutcome(job({ id: "a" }), "applied");
  O.noteOutcome(job({ id: "b" }), "applied");
  assert.equal(E.statsFor("openrouter/z-ai/glm-5.3-flash", "cheap").n, 2);
});

test("dropping one job's verdict leaves every other job alone", () => {
  E.save({});
  const a = job({ id: "keep" }), b = job({ id: "drop" });
  O.noteOutcome(a, "applied");
  O.noteOutcome(b, "applied");
  O.noteOutcome(b, "followup");
  assert.equal(O.dropOutcome(b, "applied"), 1);
  const st = E.statsFor(a.model, a.profile);
  assert.equal(st.n, 2, "the other job's verdict and b's follow-up must survive");
});

test("an unrateable job records nothing at all", () => {
  E.save({});
  O.noteOutcome(job({ readOnly: true }), "discarded");
  O.noteOutcome(job({ worktree: null }), "applied");
  assert.deepEqual(E.load(), {});
});

test("a rating is recorded even for a job that produced no diff", () => {
  // the manager may know something the harness cannot observe
  E.save({});
  O.noteOutcome(job({ readOnly: true, id: "ro" }), "rated", { outcome: 1, weight: 1.5 });
  assert.equal(E.statsFor("openrouter/z-ai/glm-5.3-flash", "cheap").n, 1);
});

test("landing the work outweighs throwing it away", () => {
  assert.ok(O.WEIGHTS.applied > O.WEIGHTS.discarded,
    "an accepted diff is a firmer statement than an abandoned one");
  assert.ok(O.WEIGHTS.rated > O.WEIGHTS.applied,
    "a manager who read the diff outranks every proxy the harness computes");
  assert.ok(O.WEIGHTS.followup < O.WEIGHTS.failed,
    "needing a second round is weaker evidence than dying outright");
});
