import fs from "node:fs";
import path from "node:path";
import { run, expandHome, ensureDir, truncate, gitBin } from "./util.mjs";

const git = (dir, args, opts = {}) => run(gitBin(), ["-C", dir, ...args], opts);

export async function repoRoot(dir) {
  const r = await git(dir, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.stdout.trim() : null;
}

export async function currentRef(dir) {
  const b = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return b.ok ? b.stdout.trim() : null;
}

export async function headSha(dir) {
  const r = await git(dir, ["rev-parse", "HEAD"]);
  return r.ok ? r.stdout.trim() : null;
}

export async function isDirty(dir) {
  const r = await git(dir, ["status", "--porcelain"]);
  return r.ok ? r.stdout.trim().length > 0 : false;
}

/**
 * One branch + one working copy per job, so N workers never touch the same files.
 * Falls back to "work in place" when the target is not a git repo.
 */
export async function createWorktree(repo, jobId, cfg, { baseRef } = {}) {
  const root = await repoRoot(repo);
  if (!root) {
    return { mode: "in-place", path: repo, branch: null, base: null,
      warning: "not a git repository — the worker edits files directly, no isolation and no diff" };
  }
  const base = baseRef || (await currentRef(root)) || "HEAD";
  const branch = `${cfg.worktree.branchPrefix}${jobId}`;
  const wtRoot = ensureDir(expandHome(cfg.worktree.root));
  const wtPath = path.join(wtRoot, path.basename(root) + "-" + jobId);

  const r = await git(root, ["worktree", "add", "-b", branch, wtPath, base]);
  if (!r.ok) {
    return { mode: "error", path: null, branch, base,
      error: `git worktree add failed: ${truncate(r.stderr || r.error, 400)}` };
  }
  const baseSha = (await git(wtPath, ["rev-parse", "HEAD"])).stdout.trim();
  return { mode: "worktree", path: wtPath, branch, base, baseSha, repo: root };
}

export async function commitAll(dir, message) {
  const st = await git(dir, ["status", "--porcelain"]);
  if (!st.ok) return { committed: false, error: st.stderr };
  if (!st.stdout.trim()) return { committed: false, empty: true };
  await git(dir, ["add", "-A"]);
  const c = await git(dir, ["-c", "user.name=opencode-fleet", "-c", "user.email=fleet@localhost",
    "commit", "-m", message, "--no-verify"]);
  if (!c.ok) return { committed: false, error: truncate(c.stderr || c.error, 400) };
  const sha = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
  return { committed: true, sha };
}

export async function diffSummary(job, { maxChars = 12000 } = {}) {
  const wt = job.worktree;
  if (!wt?.path) return { error: "job has no working copy" };
  const range = wt.baseSha ? `${wt.baseSha}..HEAD` : "HEAD";
  const stat = await git(wt.path, ["diff", "--stat", range]);
  const names = await git(wt.path, ["diff", "--name-status", range]);
  const patch = await git(wt.path, ["diff", range]);
  const untracked = await git(wt.path, ["ls-files", "--others", "--exclude-standard"]);
  return {
    stat: stat.stdout.trim() || "(no committed changes)",
    files: names.stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => {
      const [status, ...rest] = l.split("\t");
      return { status: status.trim(), path: rest.join("\t").trim() };
    }),
    uncommitted: untracked.stdout.trim().split(/\r?\n/).filter(Boolean),
    patch: truncate(patch.stdout, maxChars, `\n… [diff truncated — full patch: git -C ${wt.path} diff ${range}]`),
    patchBytes: patch.stdout.length,
    worktreePath: wt.path,
    branch: wt.branch
  };
}

/** Bring a reviewed job branch back into the main repo. */
export async function applyJob(job, { mode = "merge", target = null, message = null } = {}) {
  const wt = job.worktree;
  if (!wt?.repo || !wt.branch) return { ok: false, error: "job has no branch to apply (in-place job?)" };
  const repo = wt.repo;

  if (await isDirty(repo)) {
    return { ok: false, error: "main working copy has uncommitted changes — commit or stash them first" };
  }
  const back = await currentRef(repo);
  if (target && target !== back) {
    const co = await git(repo, ["checkout", target]);
    if (!co.ok) return { ok: false, error: `checkout ${target} failed: ${truncate(co.stderr, 300)}` };
  }
  const onto = target || back;
  const msg = message || `fleet: ${job.title || job.id} (${job.model})`;

  if (mode === "patch") {
    const range = `${wt.baseSha}..${wt.branch}`;
    const p = await git(repo, ["diff", range]);
    const file = path.join(path.dirname(wt.path), `${job.id}.patch`);
    fs.writeFileSync(file, p.stdout);
    return { ok: true, mode, patchFile: file, hint: `git -C ${repo} apply ${file}` };
  }
  const args = mode === "squash"
    ? ["merge", "--squash", wt.branch]
    : ["merge", "--no-ff", "-m", msg, wt.branch];
  const m = await git(repo, args);
  if (!m.ok) {
    return { ok: false, error: `merge failed: ${truncate(m.stdout + m.stderr, 800)}`,
      hint: "resolve manually, or use mode:'patch' to get a .patch file" };
  }
  if (mode === "squash") {
    const c = await git(repo, ["-c", "user.name=opencode-fleet", "-c", "user.email=fleet@localhost", "commit", "-m", msg, "--no-verify"]);
    if (!c.ok) return { ok: false, error: truncate(c.stderr, 400) };
  }
  return { ok: true, mode, branch: wt.branch, onto, sha: (await git(repo, ["rev-parse", "HEAD"])).stdout.trim() };
}

export async function removeWorktree(job, { deleteBranch = true, force = false } = {}) {
  const wt = job.worktree;
  if (!wt?.repo || !wt.path) return { ok: true, skipped: "in-place job" };
  const args = ["worktree", "remove", wt.path];
  if (force) args.push("--force");
  const r = await git(wt.repo, args);
  if (!r.ok && !force) {
    return { ok: false, error: truncate(r.stderr || r.error, 300), hint: "pass force:true to discard uncommitted worker changes" };
  }
  if (deleteBranch && wt.branch) await git(wt.repo, ["branch", "-D", wt.branch]);
  return { ok: true, removed: wt.path, branchDeleted: deleteBranch ? wt.branch : null };
}

export async function listFleetBranches(repo) {
  const r = await git(repo, ["branch", "--list", "fleet/*", "--format=%(refname:short)"]);
  return r.ok ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
}
