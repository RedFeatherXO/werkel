import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { stateDir, ensureDir, readJson, writeJson, newId, expandHome, truncate, humanDuration, run, resolveBin } from "./util.mjs";
import { loadConfig } from "./config.mjs";
import { resolveModel, openrouterCatalog, installedModelsSmart, spentToday, recordSpend, estimateCost, priceInfo } from "./models.mjs";
import { createWorktree, commitAll, diffSummary, repoRoot } from "./worktree.mjs";
import { buildWorkerPrompt, buildFollowupPrompt } from "./prompt.mjs";

export const jobsDir = () => ensureDir(path.join(stateDir(), "jobs"));
export const jobDir = (id) => path.join(jobsDir(), id);
const metaFile = (id) => path.join(jobDir(id), "job.json");

export function readJob(id) {
  const m = readJson(metaFile(id));
  if (!m) return null;
  return m;
}
function saveJob(job) { writeJson(metaFile(job.id), job); return job; }

export function listJobIds() {
  try { return fs.readdirSync(jobsDir()).filter((d) => fs.existsSync(metaFile(d))).sort().reverse(); }
  catch { return []; }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ---- event parsing --------------------------------------------------------

/** Turn opencode's NDJSON event stream into something a manager can act on. */
export function parseEvents(id) {
  const file = path.join(jobDir(id), "events.ndjson");
  const out = { sessionId: null, text: "", tools: [], tokens: { input: 0, output: 0, reasoning: 0 }, cost: 0, steps: 0, errors: [], eventCount: 0 };
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const line of raw.split("\n")) {
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

/**
 * Start a delegated job. Returns immediately — opencode keeps running detached,
 * so a long job survives an MCP server restart and never blocks a tool call.
 */
export async function delegate(input) {
  const dirIn = expandHome(input.repo || input.dir || process.cwd());
  if (!fs.existsSync(dirIn)) return { error: `directory not found: ${dirIn}` };
  const cfg = loadConfig(dirIn);
  const d = cfg.defaults;

  if (!input.task?.trim()) return { error: "task is required" };
  if (input.task.length > cfg.limits.promptCharsMax) return { error: `task too long (${input.task.length} chars, max ${cfg.limits.promptCharsMax})` };

  const running = runningJobs();
  const maxConc = input.maxConcurrent ?? d.maxConcurrentJobs;
  if (running.length >= maxConc) {
    return { error: `concurrency limit reached (${running.length}/${maxConc} jobs running)`,
      running: running.map((j) => ({ id: j.id, model: j.model, title: j.title })),
      hint: "wait for a job (fleet_wait) or raise defaults.maxConcurrentJobs" };
  }

  const spend = spentToday();
  const orCatalog = await openrouterCatalog().catch(() => ({}));
  const bin = resolveBin(cfg);
  const installed = await installedModelsSmart(cfg, { bin, cwd: dirIn });
  const picked = await resolveModel(
    { model: input.model, profile: input.profile },
    cfg, { bin, cwd: dirIn, orCatalog, installed, spentToday: spend.total ?? 0 }
  );
  if (picked.error) return { error: picked.error, rejected: picked.rejected, hint: picked.hint, spentToday: spend.total };

  const id = newId();
  const dir0 = ensureDir(jobDir(id));

  const useWorktree = input.worktree ?? d.worktree;
  let wt = { mode: "in-place", path: dirIn, branch: null };
  if (useWorktree) {
    wt = await createWorktree(dirIn, id, cfg, { baseRef: input.baseRef });
    if (wt.mode === "error") return { error: wt.error };
  } else if (await repoRoot(dirIn)) {
    wt.repo = await repoRoot(dirIn);
  }

  const job = {
    id,
    state: "running",
    title: input.title || truncate(input.task.split("\n")[0], 70, "…"),
    task: input.task,
    context: input.context ?? null,
    files: input.files ?? [],
    constraints: input.constraints ?? [],
    verify: input.verify ?? null,
    done: input.done ?? null,
    readOnly: !!input.readOnly,
    model: picked.model,
    profile: input.profile ?? (input.model ? null : cfg.defaults.profile),
    price: picked.price,
    dir: wt.path,
    sourceRepo: wt.repo ?? dirIn,
    worktree: wt,
    agent: input.agent ?? d.agent,
    variant: input.variant ?? d.variant,
    timeoutSec: input.timeoutSec ?? d.timeoutSec,
    autoCommit: input.autoCommit ?? d.autoCommit,
    createdAt: new Date().toISOString(),
    startedMs: Date.now(),
    jobDir: dir0
  };

  const prompt = buildWorkerPrompt(job);
  fs.writeFileSync(path.join(dir0, "prompt.md"), prompt);

  const args = ["run", "--format", "json", "--dir", job.dir, "--title", `fleet ${id}`];
  if (input.autoApprove ?? d.autoApprove) args.push("--auto");
  if (job.model) args.push("--model", job.model);
  if (job.agent) args.push("--agent", job.agent);
  if (job.variant) args.push("--variant", job.variant);
  for (const f of input.attach ?? []) args.push("-f", f);
  args.push(prompt);

  const started = launch(job, cfg, args, { readOnly: job.readOnly });
  job.pid = started.pid;
  job.cmdFile = started.script;
  saveJob(job);

  return {
    jobId: id,
    model: job.model,
    why: picked.why,
    price: picked.price ? `$${picked.price.prompt}/$${picked.price.completion} per Mtok` : "unknown",
    worktree: wt.mode === "worktree" ? { path: wt.path, branch: wt.branch, base: wt.base } : { mode: wt.mode, path: wt.path, warning: wt.warning },
    timeoutSec: job.timeoutSec,
    warning: picked.warning,
    spentTodayUsd: spend.total ?? 0,
    note: "job runs detached — poll with fleet_status / fleet_wait, then review with fleet_diff"
  };
}

/** Write a small shell wrapper so the job outlives this process and enforces its own timeout. */
function launch(job, cfg, args, { readOnly } = {}) {
  const dir0 = job.jobDir;
  const script = path.join(dir0, "run.sh");
  const quoted = args.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(" ");
  const env = [];
  if (readOnly) {
    const inline = JSON.stringify({ permission: { edit: "deny", write: "deny", bash: "ask", patch: "deny" } });
    env.push(`export OPENCODE_CONFIG_CONTENT='${inline.replace(/'/g, `'\\''`)}'`);
  }
  const body = `#!/bin/sh
# opencode-fleet job ${job.id}
cd '${job.dir.replace(/'/g, `'\\''`)}' || exit 97
${env.join("\n")}
'${resolveBin(cfg)}' ${quoted} > '${dir0}/events.ndjson' 2> '${dir0}/stderr.log' &
child=$!
( sleep ${Number(job.timeoutSec) || 1200}; kill -TERM $child 2>/dev/null; sleep 5; kill -KILL $child 2>/dev/null; echo timeout > '${dir0}/timeout' ) &
watcher=$!
wait $child
code=$?
kill $watcher 2>/dev/null
echo $code > '${dir0}/exit'
`;
  fs.writeFileSync(script, body, { mode: 0o755 });
  const child = spawn("/bin/sh", [script], { detached: true, stdio: "ignore", cwd: job.dir });
  child.unref();
  return { pid: child.pid, script };
}

/** Refresh a job's state from disk: exit code, events, cost, and (once) auto-commit. */
export async function refresh(id) {
  const job = readJob(id);
  if (!job) return null;
  if (job.state !== "running") return job;

  const exitFile = path.join(job.jobDir, "exit");
  const timedOut = fs.existsSync(path.join(job.jobDir, "timeout"));
  const finished = fs.existsSync(exitFile);

  if (!finished) {
    if (!alive(job.pid)) {
      // wrapper died without writing an exit code
      job.state = "failed";
      job.error = "worker process vanished (check stderr.log)";
      job.endedMs = Date.now();
      return saveJob(job);
    }
    return job; // still running
  }

  const code = parseInt(fs.readFileSync(exitFile, "utf8").trim() || "1", 10);
  const ev = parseEvents(id);
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
  }

  if (job.autoCommit && job.worktree?.mode === "worktree" && !job.committed) {
    const c = await commitAll(job.dir, `fleet(${job.id}): ${job.title}`);
    job.committed = c.committed ? c.sha : false;
    if (c.error) job.commitError = c.error;
  }
  if (job.costUsd) recordSpend(job.id, job.model, job.costUsd);
  return saveJob(job);
}

export async function refreshAll() {
  const out = [];
  for (const id of listJobIds()) {
    const j = await refresh(id);
    if (j) out.push(j);
  }
  return out;
}

export function jobView(job, { verbose = false } = {}) {
  const v = {
    jobId: job.id,
    state: job.state,
    title: job.title,
    model: job.model,
    dir: job.dir,
    branch: job.worktree?.branch ?? null,
    duration: humanDuration(job.durationMs ?? (job.state === "running" ? Date.now() - job.startedMs : null)),
    costUsd: job.costUsd != null ? Number(job.costUsd.toFixed(4)) : null,
    costEstimated: job.costEstimated ?? undefined,
    tools: job.toolSummary ?? undefined,
    committed: job.committed ? String(job.committed).slice(0, 8) : undefined
  };
  if (job.error) v.error = job.error;
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
  const targets = ids?.length ? ids : runningJobs().map((j) => j.id);
  if (!targets.length) return { done: [], stillRunning: [], note: "no running jobs" };
  for (;;) {
    const states = [];
    for (const id of targets) states.push(await refresh(id));
    const pending = states.filter((j) => j?.state === "running");
    if (!pending.length || Date.now() > deadline) {
      return {
        done: states.filter((j) => j && j.state !== "running").map((j) => jobView(j)),
        stillRunning: pending.map((j) => jobView(j)),
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
  try { process.kill(job.pid, "SIGTERM"); } catch {}
  await run("pkill", ["-P", String(job.pid)]).catch(() => {});
  job.state = "cancelled";
  job.endedMs = Date.now();
  job.durationMs = job.endedMs - job.startedMs;
  saveJob(job);
  return { ok: true, jobId: id, state: "cancelled" };
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
  fs.writeFileSync(path.join(dir0, "prompt.md"), prompt);

  const args = ["run", "--format", "json", "--dir", job.dir, "--session", job.sessionId];
  if (opts.autoApprove ?? cfg.defaults.autoApprove) args.push("--auto");
  if (opts.model || job.model) args.push("--model", opts.model || job.model);
  if (job.agent) args.push("--agent", job.agent);
  args.push(prompt);

  const sub = { ...job, jobDir: dir0, timeoutSec: opts.timeoutSec ?? job.timeoutSec };
  const started = launch(sub, cfg, args, { readOnly: job.readOnly });

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
