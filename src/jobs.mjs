import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stateDir, ensureDir, readJson, writeJson, newId, expandHome, truncate, humanDuration, run, resolveBin } from "./util.mjs";
import { loadConfig } from "./config.mjs";
import { resolveModel, openrouterCatalog, modelsDevCatalog, installedModelsSmart, budgetCheck, spentToday, recordSpend, estimateCost, priceInfo } from "./models.mjs";
import { classifyFailure } from "./failover.mjs";
import { record as recordHealth } from "./health.mjs";
import { killTree, isAlive } from "./process.mjs";
import { gitBin } from "./util.mjs";
import { createWorktree, commitAll, diffSummary, repoRoot, headSha, removeWorktree } from "./worktree.mjs";
import { buildWorkerPrompt, buildFollowupPrompt } from "./prompt.mjs";

export const jobsDir = () => ensureDir(path.join(stateDir(), "jobs"));
export const jobDir = (id) => path.join(jobsDir(), id);
const metaFile = (id) => path.join(jobDir(id), "job.json");

export function readJob(id) {
  if (!id || typeof id !== "string") return null;
  const m = readJson(metaFile(id));
  if (!m) return null;
  return m;
}
function saveJob(job) { writeJson(metaFile(job.id), job); return job; }

export function listJobIds() {
  try { return fs.readdirSync(jobsDir()).filter((d) => fs.existsSync(metaFile(d))).sort().reverse(); }
  catch { return []; }
}

const alive = isAlive;

// ---- event parsing --------------------------------------------------------

/** Turn opencode's NDJSON event stream into something a manager can act on.
 *  `dir` matters: a follow-up round or a failover attempt writes into its own
 *  subdirectory, and reading the base directory would replay the previous
 *  attempt's outcome forever. */
export function parseEvents(id, dir) {
  const file = path.join(dir ?? jobDir(id), "events.ndjson");
  const out = { sessionId: null, text: "", tools: [], tokens: { input: 0, output: 0, reasoning: 0 }, cost: 0, steps: 0, errors: [], eventCount: 0 };
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let e; try { e = JSON.parse(s); } catch { continue; }
    out.eventCount++;
    if (e.sessionID && !out.sessionId) out.sessionId = e.sessionID;
    const p = e.part ?? {};
    switch (e.type) {
      case "text":
        if (p.text) out.text += (out.text ? "\n" : "") + p.text;
        break;
      case "tool_use": {
        const input = p.state?.input ?? {};
        const target = input.filePath ?? input.path ?? input.pattern ?? input.command ?? input.description ?? "";
        out.tools.push({ tool: p.tool, status: p.state?.status, target: truncate(String(target), 160, "…") });
        if (p.state?.status === "error") out.errors.push(`tool ${p.tool}: ${truncate(String(p.state?.error ?? p.state?.output ?? ""), 300)}`);
        break;
      }
      case "step_finish":
        out.steps++;
        if (p.tokens) {
          out.tokens.input += p.tokens.input ?? 0;
          out.tokens.output += p.tokens.output ?? 0;
          out.tokens.reasoning += p.tokens.reasoning ?? 0;
          if (p.tokens.cache) {
            out.tokens.cacheRead = (out.tokens.cacheRead ?? 0) + (p.tokens.cache.read ?? 0);
            out.tokens.cacheWrite = (out.tokens.cacheWrite ?? 0) + (p.tokens.cache.write ?? 0);
          }
        }
        out.cost += p.cost ?? 0;
        break;
      case "error":
        out.errors.push(truncate(JSON.stringify(e.part ?? e), 500));
        break;
    }
  }
  return out;
}

export function toolSummary(tools) {
  const counts = {};
  for (const t of tools) counts[t.tool] = (counts[t.tool] ?? 0) + 1;
  return Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(", ") || "none";
}

// ---- lifecycle ------------------------------------------------------------

export function runningJobs() {
  return listJobIds().map(readJob).filter((j) => j && j.state === "running" && alive(j.pid));
}

export function queuedJobs() {
  return listJobIds().map(readJob).filter((j) => j?.state === "queued")
    .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
}

/**
 * Start a delegated job. Returns immediately — opencode keeps running detached,
 * so a long job survives an MCP server restart and never blocks a tool call.
 *
 * Past the concurrency limit a job is queued, not refused. The limit protects the
 * machine (one opencode process and one full working copy per job, plus provider
 * rate limits), not the wallet — the budget guard does that. So the honest answer
 * to an eleventh job is "in a moment", not "no": whoever sends ten tasks wants ten
 * tasks done, not six confirmations and four rejections to keep track of.
 */
export async function delegate(input) {
  const dirIn = expandHome(input.repo || input.dir || process.cwd());
  if (!fs.existsSync(dirIn)) return { error: `directory not found: ${dirIn}` };
  const cfg = loadConfig(dirIn);
  const d = cfg.defaults;

  if (!input.task?.trim()) return { error: "task is required" };
  if (input.task.length > cfg.limits.promptCharsMax) return { error: `task too long (${input.task.length} chars, max ${cfg.limits.promptCharsMax})` };

  // Settle every job first: this fires pending failovers, so the count below
  // reflects what will actually be running a moment from now, not what was
  // running before the last worker died. No queue draining here — this job
  // takes its place in line like any other.
  await refreshAll({ fillQueue: false });
  const running = runningJobs();
  const maxConc = input.maxConcurrent ?? d.maxConcurrentJobs;

  const spend = spentToday();
  const orCatalog = await openrouterCatalog().catch(() => ({}));
  const mdCatalog = await modelsDevCatalog().catch(() => ({}));
  const bin = resolveBin(cfg);
  const installed = await installedModelsSmart(cfg, { bin, cwd: dirIn });
  const picked = await resolveModel(
    { model: input.model, profile: input.profile },
    cfg, { bin, cwd: dirIn, orCatalog, installed, spentToday: spend.total ?? 0 }
  );
  if (picked.error) return { error: picked.error, rejected: picked.rejected, hint: picked.hint, spentToday: spend.total };

  // Fallbacks come from the profile, in its own order, minus what the guard refuses.
  // An explicitly named model means "this one" — we do not silently swap it out.
  const profileName = input.model ? null : (input.profile ?? cfg.defaults.profile);
  const candidates = [picked.model];
  if (profileName && (input.failover ?? cfg.defaults.failover)) {
    for (const cand of cfg.profiles?.[profileName]?.candidates ?? []) {
      if (candidates.includes(cand)) continue;
      if (budgetCheck(cand, cfg, orCatalog, { spentToday: spend.total ?? 0, mdCatalog }).allowed) candidates.push(cand);
    }
  }

  const id = newId();
  const dir0 = ensureDir(jobDir(id));

  // Pin the base commit now rather than at start time. Ten jobs sent against one
  // state should all see that state, however long the last of them waits.
  const useWorktree = input.worktree ?? d.worktree;
  const root = await repoRoot(dirIn);
  const baseRef = input.baseRef ?? (useWorktree && root ? await headSha(dirIn) : null);

  const job = {
    id,
    state: "queued",
    title: input.title || truncate(input.task.split("\n")[0], 70, "…"),
    task: input.task,
    context: input.context ?? null,
    files: input.files ?? [],
    constraints: input.constraints ?? [],
    verify: input.verify ?? null,
    done: input.done ?? null,
    readOnly: !!input.readOnly,
    // A verify command is a request to run a command, so asking for one implies
    // the permission. Anything else has to be asked for on purpose.
    allowBash: !input.readOnly ? true : (input.allowBash ?? !!input.verify),
    model: picked.model,
    candidates,
    attemptIndex: 0,
    attempts: [],
    failover: profileName ? (input.failover ?? cfg.defaults.failover) : false,
    maxAttempts: input.maxAttempts ?? cfg.defaults.maxAttempts ?? 3,
    profile: input.profile ?? (input.model ? null : cfg.defaults.profile),
    price: picked.price,
    // Everything startJob() needs later, so a queued job never has to reach back
    // into the call that created it.
    useWorktree,
    baseRef,
    autoApprove: input.autoApprove ?? d.autoApprove,
    attach: input.attach ?? [],
    // A cap named on the call belongs to the job, not to the moment: the drainer
    // has to honour it later too, or the limit would only hold until the first refresh.
    maxConcurrent: maxConc,
    repoDir: dirIn,
    dir: dirIn,                 // replaced by the worktree path when the job starts
    sourceRepo: root ?? dirIn,
    worktree: null,
    agent: input.agent ?? d.agent,
    variant: input.variant ?? d.variant,
    timeoutSec: input.timeoutSec ?? d.timeoutSec,
    autoCommit: input.autoCommit ?? d.autoCommit,
    createdAt: new Date().toISOString(),
    queuedAt: Date.now(),
    startedMs: null,
    jobDir: dir0
  };
  saveJob(job);

  // Say out loud what this job is allowed to do. The isolation story is "the
  // worktree is the sandbox" — so when there is no worktree, there is no sandbox,
  // and --auto means nobody is asked before a command runs.
  const notices = [];
  if (!useWorktree) {
    notices.push(root
      ? `no worktree: the worker works directly in ${dirIn} on the current branch — its changes are not isolated and there is no diff to review`
      : `no worktree: the worker works directly in ${dirIn}`);
  }
  if (job.readOnly && job.allowBash) {
    notices.push(input.allowBash
      ? "readOnly + allowBash: file edits are denied, but shell commands run auto-approved — the worker can still change things through bash"
      : "readOnly with a verify command: file edits are denied, but bash is allowed so the command can run. Pass allowBash:false for a job that may not run commands at all");
  }

  const common = {
    jobId: id,
    model: job.model,
    why: picked.why,
    price: picked.price ? `$${picked.price.prompt}/$${picked.price.completion} per Mtok` : "unknown",
    timeoutSec: job.timeoutSec,
    fallbacks: candidates.length > 1 ? candidates.slice(1) : undefined,
    warning: picked.warning,
    notices: notices.length ? notices : undefined,
    note2: picked.deprioritised,
    spentTodayUsd: spend.total ?? 0
  };

  if (running.length >= maxConc) {
    const ahead = queuedJobs().filter((j) => j.id !== id && (j.queuedAt ?? 0) < job.queuedAt).length;
    return {
      ...common,
      state: "queued",
      queuePosition: ahead + 1,
      runningNow: running.length,
      note: `all ${maxConc} worker slots are busy — this job starts by itself as soon as one frees up; poll with fleet_status / fleet_wait`,
      // Say where the number comes from. Otherwise the only way to find out why it
      // is 4 and not 8 is to go looking for a config file you may not know exists.
      limitFrom: input.maxConcurrent != null
        ? "maxConcurrent on this call"
        : `defaults.maxConcurrentJobs in ${cfg._sources?.length ? cfg._sources[cfg._sources.length - 1] : "the built-in defaults"}`
    };
  }

  const err = await startJob(job, cfg);
  if (err) return { error: err, jobId: id };

  const wt = job.worktree ?? { mode: "in-place", path: job.dir };
  return {
    ...common,
    state: "running",
    worktree: wt.mode === "worktree"
      ? { path: wt.path, branch: wt.branch, base: wt.base }
      : { mode: wt.mode, path: wt.path, warning: wt.warning },
    note: "job runs detached — poll with fleet_status / fleet_wait, then review with fleet_diff"
  };
}

/**
 * Take a queued job and actually run it: create the working copy, write the
 * prompt, spawn the worker. Mutates and saves `job`. Returns an error string on
 * failure, otherwise nothing — the caller decides how loudly to report it.
 *
 * The worktree is created here, not at delegate() time, so a hundred queued jobs
 * cost a hundred small JSON files rather than a hundred checkouts of the repo.
 */
async function startJob(job, cfg) {
  const dir0 = job.jobDir;

  let wt = { mode: "in-place", path: job.repoDir ?? job.dir, branch: null };
  if (job.useWorktree) {
    wt = await createWorktree(job.repoDir ?? job.dir, job.id, cfg, { baseRef: job.baseRef });
    if (wt.mode === "error") {
      job.state = "failed";
      job.error = wt.error;
      job.endedMs = Date.now();
      saveJob(job);
      return wt.error;
    }
  }
  job.worktree = wt;
  job.dir = wt.path;
  job.sourceRepo = wt.repo ?? job.sourceRepo ?? job.repoDir;

  const prompt = buildWorkerPrompt(job);
  const promptFile = path.join(dir0, "prompt.md");
  fs.writeFileSync(promptFile, prompt);

  const args = ["run", "--format", "json", "--dir", job.dir, "--title", `fleet ${job.id}`];
  if (job.autoApprove) args.push("--auto");
  if (job.model) args.push("--model", job.model);
  if (job.agent) args.push("--agent", job.agent);
  if (job.variant) args.push("--variant", job.variant);
  for (const f of job.attach ?? []) args.push("-f", f);
  // no prompt in argv — it arrives on stdin

  const started = launch(job, cfg, args, { readOnly: job.readOnly, allowBash: job.allowBash, stdinFile: promptFile });
  if (!started?.pid) {
    job.state = "failed";
    job.error = "could not spawn the worker process";
    job.endedMs = Date.now();
    saveJob(job);
    return job.error;
  }

  job.pid = started.pid;
  job.specFile = started.script;
  job.state = "running";
  job.startedMs = Date.now();
  job.startedAt = new Date().toISOString();
  job.waitedMs = job.queuedAt ? job.startedMs - job.queuedAt : 0;
  saveJob(job);
  return null;
}

/**
 * Start as many waiting jobs as there is room for, oldest first. Called after
 * every refresh, so a finished job pulls the next one in without anybody asking.
 */
export async function startQueued() {
  const waiting = queuedJobs();
  if (!waiting.length) return [];
  const started = [];
  let slots = 0;
  for (const job of waiting) {
    const cfg = loadConfig(job.repoDir ?? job.sourceRepo ?? job.dir);
    const maxConc = job.maxConcurrent ?? cfg.defaults.maxConcurrentJobs;
    // Recount every time: a job spawned a moment ago is already occupying a slot.
    // `continue`, not `break` — a job waiting on a tight cap of its own must not
    // block the ones behind it that were sent with room to spare.
    if (runningJobs().length >= maxConc) continue;
    const err = await startJob(job, cfg);
    if (!err) started.push({ id: job.id, model: job.model, title: job.title });
    // Count starts, not scans: skipping a job with a tight cap of its own must not
    // eat the budget for the ones behind it.
    if (++slots > 32) break;   // paranoia: never turn a full queue into a fork bomb
  }
  return started;
}

/**
 * Start one attempt detached, via the platform-neutral runner. The command is
 * handed over as an argv array in a JSON spec — nothing is ever pasted into a
 * shell, so paths with spaces, quotes or backslashes are simply not a problem.
 */
export function permissionFor({ readOnly, allowBash }) {
  if (!readOnly) return null;                       // the worktree is the sandbox
  // "ask" is not a restriction here: workers run with --auto, which answers every
  // prompt with yes. A read-only job therefore has to *deny* bash outright, or
  // `readOnly` would mean "cannot edit files, but may run rm -rf".
  return { edit: "deny", write: "deny", patch: "deny", bash: allowBash ? "allow" : "deny" };
}

function launch(job, cfg, args, { readOnly, allowBash, stdinFile } = {}) {
  const dir0 = job.jobDir;
  const permission = permissionFor({ readOnly, allowBash });
  const spec = {
    bin: resolveBin(cfg),
    args,
    stdinFile: stdinFile ?? null,
    cwd: job.dir,
    outDir: dir0,
    timeoutSec: Number(job.timeoutSec) || 1200,
    env: permission ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission }) } : {}
  };
  const specFile = path.join(dir0, "run.json");
  fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));

  const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "runner.mjs");
  const child = spawn(process.execPath, [runner, specFile], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: job.dir
  });
  child.unref();
  return { pid: child.pid, script: specFile };
}

/**
 * Start another attempt for an existing job: same id, same worktree, a fresh
 * directory for its output so the previous attempt's exit code cannot be misread.
 */
async function relaunch(job, why) {
  const cfg = loadConfig(job.sourceRepo);
  const dir0 = ensureDir(path.join(jobDir(job.id), `attempt${job.attemptIndex + 1}`));

  // the failed attempt produced nothing, but make sure of it before reusing the tree
  if (job.worktree?.mode === "worktree") {
    const g = gitBin(cfg);
    await run(g, ["-C", job.dir, "reset", "--hard", "-q"]).catch(() => {});
    await run(g, ["-C", job.dir, "clean", "-fdq"]).catch(() => {});
  }

  const prompt = buildWorkerPrompt(job);
  const promptFile = path.join(dir0, "prompt.md");
  fs.writeFileSync(promptFile, prompt);

  const args = ["run", "--format", "json", "--dir", job.dir, "--title", `fleet ${job.id} (attempt ${job.attemptIndex + 1})`];
  if (cfg.defaults.autoApprove) args.push("--auto");
  args.push("--model", job.model);
  if (job.agent) args.push("--agent", job.agent);
  if (job.variant) args.push("--variant", job.variant);

  const started = launch({ ...job, jobDir: dir0 }, cfg, args, { readOnly: job.readOnly, allowBash: job.allowBash, stdinFile: promptFile });
  if (!started?.pid) return false;

  job.jobDir = dir0;
  job.pid = started.pid;
  job.state = "running";
  job.startedMs = Date.now();
  job.endedMs = null;
  job.durationMs = null;
  job.error = null;
  job.exitCode = undefined;
  job.report = null;
  job.sessionId = null;
  job.failoverNote = why;
  return true;
}

/** Refresh a job's state from disk: exit code, events, cost, and (once) auto-commit. */
export async function refresh(id) {
  if (!id || typeof id !== "string") return null;
  const job = readJob(id);
  if (!job) return null;
  if (job.state !== "running") return job;   // queued jobs are started by startQueued()

  const exitFile = path.join(job.jobDir, "exit");
  const timedOut = fs.existsSync(path.join(job.jobDir, "timeout"));
  const finished = fs.existsSync(exitFile);

  if (!finished) {
    if (!alive(job.pid)) {
      // The runner died without writing an exit code. Whatever it managed to say
      // belongs in the error itself — otherwise the only way to find out is to
      // go digging in the job directory.
      let tail = "";
      try {
        tail = fs.readFileSync(path.join(job.jobDir, "stderr.log"), "utf8").trim().split(/\r?\n/).slice(-4).join(" | ");
      } catch {}
      if (!tail) {
        const ev0 = parseEvents(id, job.jobDir);
        tail = ev0.errors.slice(-2).join(" | ") || (ev0.eventCount ? `no error text; ${ev0.eventCount} events, last tools: ${toolSummary(ev0.tools)}` : "no output at all");
      }
      job.state = "failed";
      job.error = `worker process vanished: ${truncate(tail, 600)}`;
      job.endedMs = Date.now();
      job.durationMs = job.endedMs - job.startedMs;
      return saveJob(job);
    }
    return job; // still running
  }

  const code = parseInt(fs.readFileSync(exitFile, "utf8").trim() || "1", 10);
  const ev = parseEvents(id, job.jobDir);
  job.exitCode = code;
  job.sessionId = ev.sessionId ?? job.sessionId;
  job.tokens = ev.tokens;
  job.toolCalls = ev.tools.length;
  job.toolSummary = toolSummary(ev.tools);
  job.report = ev.text?.trim() || null;
  job.endedMs = Date.now();
  job.durationMs = job.endedMs - job.startedMs;

  const cost = ev.cost > 0 ? ev.cost : estimateCost(ev.tokens, job.price);
  job.costUsd = cost ?? null;
  job.costEstimated = !(ev.cost > 0);

  if (timedOut) { job.state = "timeout"; job.error = `killed after ${job.timeoutSec}s`; }
  else if (code !== 0) {
    job.state = "failed";
    let err = "";
    try { err = fs.readFileSync(path.join(job.jobDir, "stderr.log"), "utf8"); } catch {}
    job.error = truncate(err.trim() || ev.errors.join("; ") || `opencode exited with code ${code}`, 1500);
  } else if (ev.errors.length && !ev.text) {
    job.state = "failed";
    job.error = truncate(ev.errors.join("; "), 1500);
  } else {
    job.state = "done";
    recordHealth(job.model, "ok");
  }

  // A job that died before producing anything is usually the provider's fault,
  // not the task's — move to the next candidate instead of surfacing a failure.
  if ((job.state === "failed" || job.state === "timeout") && job.failover) {
    const verdict = classifyFailure(job, ev);
    if (verdict.category === "provider") recordHealth(job.model, "provider-error", verdict.reason);
    const nextModel = (job.candidates ?? [])[job.attemptIndex + 1];
    const attemptsLeft = (job.attempts?.length ?? 0) + 1 < (job.maxAttempts ?? 3);
    if (verdict.retryable && nextModel && attemptsLeft) {
      job.attempts = (job.attempts ?? []).concat([{
        model: job.model, category: verdict.category, reason: verdict.reason,
        durationMs: job.durationMs, at: new Date().toISOString()
      }]);
      job.attemptIndex += 1;
      job.model = nextModel;
      job.price = priceInfo(nextModel, loadConfig(job.sourceRepo), {}, undefined);
      const relaunched = await relaunch(job, `failover to ${nextModel} after ${verdict.category} failure`);
      if (relaunched) return saveJob(job);
    } else if (verdict.retryable && !nextModel) {
      job.error = `${job.error ?? verdict.reason} — no fallback candidate left (tried ${[...(job.attempts ?? []).map((a) => a.model), job.model].join(", ")})`;
    }
  }

  if (job.autoCommit && job.worktree?.mode === "worktree" && !job.committed) {
    const c = await commitAll(job.dir, `fleet(${job.id}): ${job.title}`);
    job.committed = c.committed ? c.sha : false;
    if (c.error) job.commitError = c.error;
  }
  if (job.costUsd) recordSpend(job.id, job.model, job.costUsd);
  return saveJob(job);
}

/** A record may only be pruned when it is finished AND no working copy is left:
 *  a worktree on disk holds unmerged work the user has not landed yet. */
function prunableIds() {
  const out = [];
  for (const id of listJobIds()) {
    const job = readJob(id);
    if (!job) continue;
    if (job.state === "running" || job.state === "queued") continue;
    const wt = job.worktree;
    if (wt?.mode === "worktree" && wt.path && fs.existsSync(wt.path)) continue;
    out.push(id);
  }
  return out;
}

/** Core of pruneJobRecords, returning the ids it removed so refreshAll can drop
 *  them from its result without rescanning the store. */
async function pruneJobIds(cfg) {
  const keep = Number(cfg?.defaults?.keepJobs);
  if (!(keep > 0)) return [];   // 0 means unlimited
  // Only prunable records count against the limit, so a pile of unmerged
  // worktrees cannot push finished jobs out of the store.
  const newestFirst = prunableIds().map(readJob).filter(Boolean)
    .sort((a, b) => (b.startedMs ?? b.queuedAt ?? 0) - (a.startedMs ?? a.queuedAt ?? 0));
  const gone = newestFirst.slice(keep);
  for (const job of gone) {
    // The record only — a prunable job has no working copy left, and a branch
    // that still exists may hold committed work, so it is never touched here.
    fs.rmSync(jobDir(job.id), { recursive: true, force: true });
  }
  return gone.map((j) => j.id);
}

/** Delete the oldest finished job records past cfg.defaults.keepJobs. Returns how many. */
export async function pruneJobRecords(cfg) {
  return (await pruneJobIds(cfg)).length;
}

export async function refreshAll({ fillQueue = true } = {}) {
  const out = [];
  for (const id of listJobIds()) {
    const j = await refresh(id);
    if (j) out.push(j);
  }
  // a finished job frees a slot — hand it to whoever has been waiting longest
  if (fillQueue && queuedJobs().length) {
    await startQueued();
    out.length = 0;
    out.push(...listJobIds().map(readJob).filter(Boolean));
  }
  // Prune after the queue drained, so jobs startQueued() just started are running
  // and never prunable. keepJobs bounds the shared jobs store, so it is read once
  // from the fleet home's global config — loading per job (sourceRepo) would be a
  // file read per job, and a per-repo override has no scope over a global store.
  const pruned = await pruneJobIds(loadConfig());
  return pruned.length ? out.filter((j) => !pruned.includes(j.id)) : out;
}

export function jobView(job, { verbose = false } = {}) {
  const v = {
    jobId: job.id,
    state: job.state,
    durationMs: job.durationMs ?? (job.endedMs && job.startedMs ? job.endedMs - job.startedMs : null),
    title: job.title,
    model: job.model,
    dir: job.dir,
    branch: job.worktree?.branch ?? null,
    duration: job.state === "queued"
      ? `waiting ${humanDuration(Date.now() - (job.queuedAt ?? Date.now()))}`
      : humanDuration(job.durationMs ?? (job.state === "running" ? Date.now() - job.startedMs : null)),
    // How long it sat in the queue. Without this a job that waited four minutes and
    // ran for ten looks identical to one that started instantly — and the difference
    // is the whole point of knowing the fleet is saturated.
    waitedMs: job.waitedMs || undefined,
    waited: job.waitedMs > 1000 ? humanDuration(job.waitedMs) : undefined,
    costUsd: job.costUsd != null ? Number(job.costUsd.toFixed(4)) : null,
    costEstimated: job.costEstimated ?? undefined,
    tools: job.toolSummary ?? undefined,
    committed: job.committed ? String(job.committed).slice(0, 8) : undefined
  };
  if (job.error) v.error = job.error;
  if (job.attempts?.length) {
    v.attempt = `${job.attemptIndex + 1}/${job.maxAttempts ?? 3}`;
    v.previousAttempts = job.attempts.map((a) => `${a.model}: ${a.category} — ${String(a.reason).slice(0, 120)}`);
  }
  if (job.failoverNote) v.failover = job.failoverNote;
  if (verbose) {
    v.task = job.task;
    v.report = job.report;
    v.tokens = job.tokens;
    v.sessionId = job.sessionId;
    v.jobDir = job.jobDir;
  }
  return v;
}

/** Block until the given jobs leave the running state (or the deadline passes). */
export async function waitFor(ids, { timeoutSec = 120, pollMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  const clean = (ids ?? []).filter((i) => typeof i === "string" && i);
  const targets = clean.length ? clean : [...runningJobs(), ...queuedJobs()].map((j) => j.id);
  if (!targets.length) return { done: [], stillRunning: [], note: "no running jobs" };
  for (;;) {
    const states = [];
    for (const id of targets) states.push(await refresh(id));
    // Waiting is the one thing a manager does while jobs run, so the queue has to
    // move here too. Without this, waiting on a queued job would wait for someone
    // else to call fleet_status — i.e. forever.
    if (queuedJobs().length) {
      await startQueued();
      for (let i = 0; i < targets.length; i++) states[i] = readJob(targets[i]) ?? states[i];
    }
    const pending = states.filter((j) => j?.state === "running" || j?.state === "queued");
    if (!pending.length || Date.now() > deadline) {
      return {
        done: states.filter((j) => j && j.state !== "running" && j.state !== "queued").map((j) => jobView(j)),
        stillRunning: pending.map((j) => jobView(j)),
        stillQueued: pending.filter((j) => j.state === "queued").length || undefined,
        timedOutWaiting: pending.length > 0
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function cancel(id) {
  const job = readJob(id);
  if (!job) return { error: `unknown job ${id}` };
  if (job.state !== "running") return { ok: true, note: `job already ${job.state}` };
  // the runner is the process group leader; killTree takes the worker with it
  killTree(job.pid, "SIGTERM");
  setTimeout(() => killTree(job.pid, "SIGKILL"), 3000).unref();
  job.state = "cancelled";
  job.endedMs = Date.now();
  job.durationMs = job.endedMs - job.startedMs;
  saveJob(job);
  return { ok: true, jobId: id, state: "cancelled" };
}

/**
 * Forget a job entirely: worktree, branch and the record itself. This is the one
 * operation here that cannot be undone, so it refuses a running job unless forced.
 */
export async function forget(jobId, { force = false } = {}) {
  const job = readJob(jobId);
  if (!job) return { error: `unknown job ${jobId}` };
  if (job.state === "running") {
    if (!force) return { error: `job ${jobId} is still running`, hint: "cancel it first, or pass force" };
    await cancel(jobId);
  }
  // A missing worktree must not stop the record from being deleted.
  let removedWorktree = null;
  try {
    const r = await removeWorktree(job, { force: true });
    if (r?.removed) removedWorktree = r.removed;
  } catch {}
  fs.rmSync(jobDir(jobId), { recursive: true, force: true });
  return { ok: true, jobId, removedWorktree };
}

/** Continue a finished job in the same session and the same worktree. */
export async function followup(id, message, opts = {}) {
  const job = await refresh(id);
  if (!job) return { error: `unknown job ${id}` };
  if (job.state === "running") return { error: "job is still running — wait or cancel it first" };
  if (!job.sessionId) return { error: "no session id recorded for this job (worker never started?)" };

  const cfg = loadConfig(job.sourceRepo);
  const round = (job.rounds ?? 1) + 1;
  const dir0 = ensureDir(path.join(job.jobDir, `round${round}`));
  const prompt = buildFollowupPrompt(message, job);
  const promptFile = path.join(dir0, "prompt.md");
  fs.writeFileSync(promptFile, prompt);

  const args = ["run", "--format", "json", "--dir", job.dir, "--session", job.sessionId];
  if (opts.autoApprove ?? cfg.defaults.autoApprove) args.push("--auto");
  if (opts.model || job.model) args.push("--model", opts.model || job.model);
  if (job.agent) args.push("--agent", job.agent);

  const sub = { ...job, jobDir: dir0, timeoutSec: opts.timeoutSec ?? job.timeoutSec };
  const started = launch(sub, cfg, args, { readOnly: job.readOnly, allowBash: job.allowBash, stdinFile: promptFile });

  job.rounds = round;
  job.state = "running";
  job.pid = started.pid;
  job.jobDir = dir0;
  job.startedMs = Date.now();
  job.endedMs = null; job.durationMs = null; job.error = null; job.committed = false;
  saveJob(job);
  return { jobId: id, round, model: job.model, note: "follow-up running in the same session and worktree" };
}

export { diffSummary };
