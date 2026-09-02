import os from "node:os";
import { refreshAll, jobView, readJob, cancel } from "./jobs.mjs";
import { diffSummary, removeWorktree } from "./worktree.mjs";
import { truncate } from "./util.mjs";

const MAX_JOBS = 100; // newest only — keeps the POST body well under 2 MB
const MAX_REPORT_CHARS = 4000;
const HTTP_TIMEOUT_MS = 10000;

/** One authenticated POST with a hard deadline; throws on any failure. */
async function postJson(url, body, token) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "X-Fleet-Token": token } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}

/** What the dashboard sees per job: the verbose view, minus anything heavy. */
async function snapshot(job) {
  const v = jobView(job, { verbose: true });
  v.repo = job.sourceRepo;
  v.startedMs = job.startedMs;
  v.endedMs = job.endedMs;
  v.queuedAt = job.queuedAt ?? null;
  if (v.report) v.report = truncate(v.report, MAX_REPORT_CHARS);
  // the patch is far too big for the wire — stat and file list suffice.
  // A queued job has no working copy yet, so there is nothing to diff.
  if (job.state !== "running" && job.state !== "queued") {
    const d = await diffSummary(job, { maxChars: 0 }).catch(() => null);
    if (d && !d.error) { v.diffstat = d.stat; v.changedFiles = d.files; }
  }
  return v;
}

/**
 * Push the state of all jobs to a remote dashboard and run the commands it
 * collected. Runs forever unless `once` — a failed cycle is logged and the
 * loop continues, so an unreachable dashboard never kills the process.
 */
export async function report({ to, token, host, intervalSec = 5, once = false, log = () => {} }) {
  if (!to) throw new Error("report: 'to' (dashboard base URL) is required");
  const base = String(to).replace(/\/+$/, "");
  const who = host ?? os.hostname();
  const wait = Math.max(1, Number(intervalSec) || 5) * 1000;

  for (;;) {
    let sent = 0, executed = 0;
    try {
      const jobs = (await refreshAll()).filter(Boolean)
        .sort((a, b) => (b.startedMs ?? 0) - (a.startedMs ?? 0))
        .slice(0, MAX_JOBS);
      const snapshots = [];
      for (const job of jobs) {
        try { snapshots.push(await snapshot(job)); }
        catch (e) { snapshots.push({ jobId: job.id, state: job.state, snapshotError: e.message }); }
      }
      sent = snapshots.length;
      const res = await postJson(`${base}/api/ingest`, { host: who, ts: Date.now(), jobs: snapshots }, token);
      for (const cmd of res?.commands ?? []) {
        let ok = true, error;
        if (cmd.action === "cancel") {
          executed++;
          const r = await cancel(cmd.jobId);
          if (r?.error) { ok = false; error = r.error; }
        } else if (cmd.action === "cleanup") {
          executed++;
          const job = readJob(cmd.jobId);
          if (!job) { ok = false; error = `unknown job ${cmd.jobId}`; }
          else {
            const r = await removeWorktree(job, { force: true });
            if (r?.ok === false) { ok = false; error = r.error; }
          }
        } else {
          // unknown action: acknowledge as failed, do not guess
          ok = false;
          error = `unknown action ${JSON.stringify(cmd.action)}`;
        }
        try {
          await postJson(`${base}/api/commands/${encodeURIComponent(String(cmd.id))}/result`,
            ok ? { ok: true } : { ok: false, error }, token);
        } catch (e) { log(`result for command ${cmd.id} not delivered: ${e.message}`); }
      }
      log(`sent ${sent} jobs, executed ${executed} commands`);
    } catch (e) {
      if (once) throw e;
      log(`cycle failed: ${e?.message ?? e}`);
    }
    if (once) return { sent, commands: executed };
    await new Promise((r) => setTimeout(r, wait));
  }
}
