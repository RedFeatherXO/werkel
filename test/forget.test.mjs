import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { forget, pruneJobRecords, jobDir } from "../src/jobs.mjs";

// These tests run against a throwaway OPENCODE_FLEET_HOME with hand-written
// job.json files — no worker is ever started. Deleting a record is the one
// operation here that cannot be undone, so most of the suite pins the guards
// that keep active or unmerged work out of the shredder.

let home = null;

function newHome() {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ocfleet-forget-"));
  process.env.OPENCODE_FLEET_HOME = home;
  return home;
}

function writeJob(id, fields = {}) {
  const dir = jobDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({
    id, state: "done", title: `t ${id}`, task: "x",
    queuedAt: 1000, startedMs: 1000, worktree: null, jobDir: dir,
    ...fields
  }));
  return dir;
}

const exists = (id) => fs.existsSync(jobDir(id));

test("forget deletes the job directory", async () => {
  newHome();
  writeJob("f1", { state: "done" });
  fs.writeFileSync(path.join(jobDir("f1"), "prompt.md"), "hello");
  const r = await forget("f1");
  assert.deepEqual(r, { ok: true, jobId: "f1", removedWorktree: null });
  assert.equal(exists("f1"), false);
  // gone means gone: a second forget reports the unknown job
  assert.deepEqual(await forget("f1"), { error: "unknown job f1" });
});

test("forget refuses a running job without force", async () => {
  newHome();
  writeJob("r1", { state: "running", pid: 999999999 });
  const r = await forget("r1");
  assert.match(r.error, /still running/);
  assert.match(r.hint, /force/);
  assert.equal(exists("r1"), true);
});

test("forget with force cancels a running job and deletes the record", async () => {
  newHome();
  writeJob("r2", { state: "running", pid: 999999999, startedMs: 1000 });
  const r = await forget("r2", { force: true });
  assert.equal(r.ok, true);
  assert.equal(r.removedWorktree, null);
  assert.equal(exists("r2"), false);
});

test("pruneJobRecords keeps the newest keepJobs records and deletes older ones", async () => {
  newHome();
  for (let i = 1; i <= 5; i++) writeJob(`p${i}`, { state: "done", queuedAt: i * 1000, startedMs: i * 1000 });
  const deleted = await pruneJobRecords({ defaults: { keepJobs: 2 } });
  assert.equal(deleted, 3);
  assert.equal(exists("p5"), true);
  assert.equal(exists("p4"), true);
  assert.equal(exists("p3"), false);
  assert.equal(exists("p2"), false);
  assert.equal(exists("p1"), false);
});

test("pruneJobRecords never deletes a record whose worktree path still exists", async () => {
  newHome();
  const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocfleet-wt-"));
  // the oldest job holds the only unmerged working copy: it must survive, and it
  // must not push the newer finished jobs past the limit either
  writeJob("w0", { state: "done", queuedAt: 0, startedMs: 0, worktree: { mode: "worktree", path: wtDir, branch: "fleet/w0", repo: home } });
  for (let i = 1; i <= 3; i++) writeJob(`w${i}`, { state: "done", queuedAt: i * 1000, startedMs: i * 1000 });
  const deleted = await pruneJobRecords({ defaults: { keepJobs: 2 } });
  assert.equal(deleted, 1);            // w0 is not counted against the limit: 3 prunable, keep 2
  assert.equal(exists("w0"), true);
  assert.equal(exists("w1"), false);
  assert.equal(exists("w2"), true);
  assert.equal(exists("w3"), true);
  // once the working copy is gone from disk, the record becomes prunable again
  fs.rmSync(wtDir, { recursive: true, force: true });
  assert.equal(await pruneJobRecords({ defaults: { keepJobs: 2 } }), 1);
  assert.equal(exists("w0"), false);
});

test("pruneJobRecords never deletes a running or queued job", async () => {
  newHome();
  writeJob("live1", { state: "running", queuedAt: 100, startedMs: 100, pid: 999999999 });
  writeJob("live2", { state: "queued", queuedAt: 50, startedMs: null });
  for (let i = 1; i <= 4; i++) writeJob(`old${i}`, { state: "done", queuedAt: 1000 + i * 1000, startedMs: 1000 + i * 1000 });
  const deleted = await pruneJobRecords({ defaults: { keepJobs: 2 } });
  assert.equal(deleted, 2);
  assert.equal(exists("live1"), true);
  assert.equal(exists("live2"), true);
  // actives do not count against the limit, so two finished records fit beside them
  assert.equal(exists("old4"), true);
  assert.equal(exists("old3"), true);
  assert.equal(exists("old2"), false);
  assert.equal(exists("old1"), false);
});

test("keepJobs: 0 disables pruning entirely", async () => {
  newHome();
  for (let i = 1; i <= 4; i++) writeJob(`z${i}`, { state: "done", queuedAt: i * 1000, startedMs: i * 1000 });
  assert.equal(await pruneJobRecords({ defaults: { keepJobs: 0 } }), 0);
  assert.equal(await pruneJobRecords({}), 0);
  for (let i = 1; i <= 4; i++) assert.equal(exists(`z${i}`), true);
});

after(() => { if (home) fs.rmSync(home, { recursive: true, force: true }); });
