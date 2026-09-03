import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A blocking wait survives about fifty seconds before the bridge to the manager
// gives up, so a long batch is polled twenty times or more. These tests pin the
// two things that follow: a poll that has nothing to say must stay cheap, and it
// must never stay quiet about something that actually happened.

let home, J;
function newHome() {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "werkel-wait-"));
  process.env.WERKEL_HOME = home;
}
function writeJob(id, extra = {}) {
  const dir = path.join(home, "jobs", id);
  fs.mkdirSync(dir, { recursive: true });
  const job = { id, state: "running", title: `job ${id}`, model: "mock/m", task: "do the thing",
    startedMs: Date.now() - 5000, jobDir: dir, dir: home, repoDir: home, attemptIndex: 0,
    maxConcurrent: 0, ...extra };
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job));
  // a job the harness considers finished must not look alive
  if (job.state !== "running") fs.writeFileSync(path.join(dir, "exit"), "0");
  return job;
}
function setState(id, patch) {
  const f = path.join(home, "jobs", id, "job.json");
  const job = { ...JSON.parse(fs.readFileSync(f, "utf8")), ...patch };
  fs.writeFileSync(f, JSON.stringify(job));
  return job;
}

newHome();
J = await import("../src/jobs.mjs");

test("jobLine says the useful part in one line", () => {
  const j = { id: "20260903-1", state: "running", title: "a job", startedMs: Date.now() - 65000 };
  const line = J.jobLine(j);
  assert.match(line, /20260903-1 running/);
  assert.match(line, /a job/);
  // the whole point: this must be short enough to repeat twenty times
  assert.ok(line.length < 100, `too long for a poll line: ${line.length} chars`);
});

test("a long title cannot blow the line up", () => {
  const line = J.jobLine({ id: "x", state: "running", title: "t".repeat(500), startedMs: Date.now() });
  assert.ok(line.length < 120, `${line.length} chars`);
});

test("jobPulse changes exactly when a manager would want to be told", () => {
  const base = { state: "running", attemptIndex: 0, model: "a/b" };
  assert.equal(J.jobPulse(base), J.jobPulse({ ...base }));
  assert.notEqual(J.jobPulse(base), J.jobPulse({ ...base, state: "done" }));
  assert.notEqual(J.jobPulse(base), J.jobPulse({ ...base, attemptIndex: 1 }));  // failover
  assert.notEqual(J.jobPulse(base), J.jobPulse({ ...base, model: "c/d" }));     // switched model
});

test("the first wait reports in full, a repeat wait stays quiet", async () => {
  newHome();
  writeJob("j1", { pid: 999999 });   // a pid that is not alive → refresh keeps it running? no: it fails
  const first = await J.waitFor(["j1"], { timeoutSec: 0, pollMs: 1 });
  assert.equal(first.unchanged, undefined, "the first report can never be 'unchanged'");

  const second = await J.waitFor(["j1"], { timeoutSec: 0, pollMs: 1 });
  const third = await J.waitFor(["j1"], { timeoutSec: 0, pollMs: 1 });
  // whatever state it settled into, repeating it must not repeat the payload
  if (third.stillRunning?.length) {
    assert.equal(third.unchanged, true, JSON.stringify(third));
    assert.ok(!third.done, "a quiet poll carries no done list");
  } else {
    assert.equal(second.unchanged, undefined);
  }
});

test("one line beats one view — that is where the polling cost went", () => {
  const job = { id: "20260903-085300-3e65", state: "running", title: "messjob-langer-wait",
    model: "openrouter/z-ai/glm-5.3-flash", dir: "/home/meik/Programs/MCP-Servers/werkel",
    startedMs: Date.now() - 129000, worktree: null, waitedMs: 2 };
  const line = J.jobLine(job).length;
  const view = JSON.stringify(J.jobView(job)).length;
  // measured against the real payload that made twenty polls expensive
  assert.ok(line * 3 < view, `line ${line} vs view ${view} — not worth the change`);
});

test("a quiet poll carries nothing but the fact that nothing happened", async () => {
  newHome();
  for (let i = 0; i < 3; i++) writeJob(`q${i}`, { state: "queued", queuedAt: Date.now() - i * 1000 });
  const ids = ["q0", "q1", "q2"];
  await J.waitFor(ids, { timeoutSec: 0, pollMs: 1 });
  const quiet = await J.waitFor(ids, { timeoutSec: 0, pollMs: 1 });
  assert.equal(quiet.unchanged, true, JSON.stringify(quiet));
  // no done list, no queue count, no prose restating what `unchanged` already says
  assert.deepEqual(Object.keys(quiet).sort(), ["stillRunning", "unchanged"]);
  assert.ok(JSON.stringify(quiet).length < 250, `${JSON.stringify(quiet).length} bytes for 3 jobs`);
});

test("a job that finishes breaks the silence", async () => {
  newHome();
  writeJob("f1", { state: "queued", queuedAt: Date.now() });
  await J.waitFor(["f1"], { timeoutSec: 0, pollMs: 1 });
  const quiet = await J.waitFor(["f1"], { timeoutSec: 0, pollMs: 1 });
  assert.equal(quiet.unchanged, true);

  setState("f1", { state: "done", report: "SUMMARY: did the thing", endedMs: Date.now(), durationMs: 5000 });
  const loud = await J.waitFor(["f1"], { timeoutSec: 0, pollMs: 1 });
  assert.equal(loud.unchanged, undefined, "a finished job must never be reported as 'unchanged'");
  assert.equal(loud.done.length, 1);
  assert.match(loud.done[0].report, /did the thing/, "the report rides along, saving a round trip");
});

test("a failover breaks the silence too", async () => {
  newHome();
  writeJob("v1", { state: "queued", queuedAt: Date.now() });
  await J.waitFor(["v1"], { timeoutSec: 0, pollMs: 1 });
  assert.equal((await J.waitFor(["v1"], { timeoutSec: 0, pollMs: 1 })).unchanged, true);

  setState("v1", { attemptIndex: 1, model: "mock/other" });
  const loud = await J.waitFor(["v1"], { timeoutSec: 0, pollMs: 1 });
  assert.equal(loud.unchanged, undefined, "switching model mid-job is exactly what a manager must hear about");
});

test("a report is truncated, so one finished job cannot flood the poll", async () => {
  newHome();
  writeJob("b1", { state: "done", report: "x".repeat(50000), endedMs: Date.now(), durationMs: 1000 });
  const r = await J.waitFor(["b1"], { timeoutSec: 0, pollMs: 1 });
  assert.ok(r.done[0].report.length < 2000, `${r.done[0].report.length} chars`);
  assert.match(r.done[0].report, /werkel_result/);
});

test("jobView no longer mirrors the work order back at its author", () => {
  const v = J.jobView({ id: "t", state: "done", task: "a very long work order".repeat(50), report: "r" },
    { verbose: true });
  assert.equal(v.task, undefined, "the manager wrote the task; sending it back is pure waste");
  assert.equal(v.report, "r");
});
