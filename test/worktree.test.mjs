import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktree } from "../src/worktree.mjs";

// A greenfield build is now a named use case in the skill, and the first thing it
// hits is a repository with no commits. Git's own words for that are "invalid
// reference: HEAD" — correct, and no help at all to anyone who does not already
// know what it means.

const cfg = { worktree: { root: path.join(os.tmpdir(), "werkel-wt-test"), branchPrefix: "werkel/" } };

test("a repository with no commits explains itself", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werkel-empty-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  const r = await createWorktree(dir, "20260101-x", cfg, {});
  assert.equal(r.mode, "error");
  assert.match(r.error, /no commits yet/i, r.error);
  assert.match(r.hint, /commit a baseline/i, r.hint);
  assert.match(r.hint, /worktree:false|worktree: ?false/i, "the other way out belongs in the hint too");
  assert.doesNotMatch(r.error, /invalid reference/i, "git's wording is what we are replacing");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a directory that is not a repository still falls back to working in place", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werkel-nogit-"));
  const r = await createWorktree(dir, "20260101-y", cfg, {});
  assert.equal(r.mode, "in-place");
  assert.match(r.warning, /not a git repository/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a repository with a commit gets a real worktree", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werkel-ok-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "hi\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  const r = await createWorktree(dir, "20260101-z", cfg, {});
  assert.equal(r.mode, "worktree", r.error);
  assert.ok(fs.existsSync(r.path));
  execFileSync("git", ["-C", dir, "worktree", "remove", "--force", r.path]);
  fs.rmSync(dir, { recursive: true, force: true });
});
