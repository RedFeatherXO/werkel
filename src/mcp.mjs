/**
 * Dependency-free MCP stdio server. Node >= 18, no npm install needed.
 * Exposes werkel as tools so any Claude agent can act as the manager.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { allowedModels, spentToday, suggestProfiles } from "./models.mjs";
import * as J from "./jobs.mjs";
import { applyJob, removeWorktree, diffSummary } from "./worktree.mjs";
import { doctor } from "./doctor.mjs";
import { truncate } from "./util.mjs";

const NAME = "werkel";
const VERSION = "0.1.0";

const S = {
  jobId: { type: "string", description: "Job id returned by werkel_delegate" }
};

const TOOLS = [
  {
    name: "werkel_delegate",
    description:
      "Hand one self-contained coding task to an OpenCode worker running a cheaper model. Returns a jobId immediately; the worker runs detached in its own git worktree/branch, so several jobs can run in parallel without touching each other. Write the task like a work order for someone who has not seen the repo: what to change, which files matter, what 'done' means, and a verification command. Then poll with werkel_wait/werkel_status, review with werkel_diff, and land it with werkel_apply.",
    inputSchema: {
      type: "object",
      required: ["task", "repo"],
      properties: {
        task: { type: "string", description: "The work order. Be explicit and complete — the worker cannot ask questions." },
        repo: { type: "string", description: "Absolute path of the git repository (or any directory) to work in." },
        profile: { type: "string", description: "Model tier: cheap | balanced | strong | longcontext | local. Default from config (balanced)." },
        model: { type: "string", description: "Exact provider/model override, e.g. 'openrouter/qwen/qwen3-coder'. Must pass the budget guard." },
        title: { type: "string", description: "Short label for status listings." },
        context: { type: "string", description: "What you already know: architecture, conventions, previous findings, relevant snippets. Saves the worker expensive exploration." },
        files: { type: "array", items: { type: "string" }, description: "Paths the worker should look at first." },
        attach: { type: "array", items: { type: "string" }, description: "Files to attach to the message verbatim (passed to opencode -f)." },
        constraints: { type: "array", items: { type: "string" }, description: "Hard rules, e.g. 'do not change the public API', 'no new dependencies'." },
        verify: { type: "string", description: "Shell command the worker must run and report, e.g. 'npm test -- auth'." },
        done: { type: "string", description: "Definition of done in one or two sentences." },
        readOnly: { type: "boolean", description: "Investigation only: file edits are denied and the worker reports findings instead. Shell commands are denied too, unless you pass a verify command or allowBash. Good for cheap models on unclear bugs." },
        allowBash: { type: "boolean", description: "Only meaningful with readOnly: let the worker run shell commands (tests, builds, git log). They run auto-approved, so a command that writes still writes. Defaults to true when a verify command is given, false otherwise." },
        failover: { type: "boolean", description: "On a provider failure (API error, rate limit, timeout with no work done), retry automatically with the profile's next candidate. Default true for profile jobs, never for an explicitly named model." },
        maxAttempts: { type: "number", description: "Cap on attempts per job including the first (default 3)." },
        worktree: { type: "boolean", description: "Isolate in a new git worktree+branch (default true). false = edit the repo directly." },
        baseRef: { type: "string", description: "Branch/commit the worktree starts from (default: current branch)." },
        timeoutSec: { type: "number", description: "Hard kill after this many seconds (default 1200)." },
        agent: { type: "string", description: "OpenCode agent to run as (e.g. 'build', 'plan', or a custom subagent)." },
        variant: { type: "string", description: "Reasoning effort variant, provider specific (e.g. 'high')." }
      }
    }
  },
  {
    name: "werkel_wait",
    description: "Block until the given jobs finish (or the wait times out), then report what changed. A finished job comes back with its report already attached, so you rarely need werkel_result to find out how it went. A reply of {unchanged:true, stillRunning:[...]} means nothing at all has happened since your last wait — there is nothing to think about, just call again. Keep timeoutSec at or below 45 when this server is reached through a bridge or proxy that caps call duration (a desktop bridge typically cuts off at 60s); call it repeatedly rather than waiting long once.",
    inputSchema: { type: "object", properties: {
      jobIds: { type: "array", items: { type: "string" }, description: "Jobs to wait for. Omit = all running jobs." },
      timeoutSec: { type: "number", description: "How long to wait, default 120. The job itself keeps running if the wait expires." } } }
  },
  {
    name: "werkel_status",
    description: "State of one job or of all recent jobs: running/done/failed/timeout, duration, cost, which tools the worker used.",
    inputSchema: { type: "object", properties: { jobId: S.jobId, limit: { type: "number", description: "How many recent jobs to list (default 15)" }, verbose: { type: "boolean" } } }
  },
  {
    name: "werkel_result",
    description: "Result of a finished job: the worker's report (SUMMARY/FILES/VERIFICATION/ASSUMPTIONS/BLOCKED), changed files, diffstat and cost. The patch is NOT included unless you ask for it — read this first, then werkel_diff when the report gives you a reason to.",
    inputSchema: { type: "object", required: ["jobId"], properties: { jobId: S.jobId, includeDiff: { type: "boolean", description: "Also include the full patch (default false — it is large; use werkel_diff instead once you know you want it)" }, maxDiffChars: { type: "number" } } }
  },
  {
    name: "werkel_diff",
    description: "The worker's patch, so you can review it line by line before it touches the main branch.",
    inputSchema: { type: "object", required: ["jobId"], properties: { jobId: S.jobId, maxChars: { type: "number", description: "Truncate the patch at this length (default 12000)" } } }
  },
  {
    name: "werkel_logs",
    description: "Raw activity of a job: every tool call the worker made, plus stderr. Use when a job failed or did something unexpected.",
    inputSchema: { type: "object", required: ["jobId"], properties: { jobId: S.jobId, tail: { type: "number", description: "How many tool calls to show (default 40)" } } }
  },
  {
    name: "werkel_followup",
    description: "Send review feedback to a finished job. The worker continues in the SAME session and worktree, so it keeps its context — much cheaper than re-delegating.",
    inputSchema: { type: "object", required: ["jobId", "message"], properties: { jobId: S.jobId, message: { type: "string", description: "What to fix or change." }, model: { type: "string", description: "Escalate to another model for this round." }, timeoutSec: { type: "number" } } }
  },
  {
    name: "werkel_apply",
    description: "Land a reviewed job in the main repo: merge its branch, squash-merge it, or write a .patch file. Refuses when the main working copy is dirty.",
    inputSchema: { type: "object", required: ["jobId"], properties: { jobId: S.jobId,
      mode: { type: "string", enum: ["merge", "squash", "patch"], description: "merge (default), squash, or patch file" },
      target: { type: "string", description: "Branch to land on (default: current branch of the main repo)" },
      message: { type: "string", description: "Commit message" } } }
  },
  {
    name: "werkel_cancel",
    description: "Kill a running job (its worktree and partial changes stay for inspection).",
    inputSchema: { type: "object", required: ["jobId"], properties: { jobId: S.jobId } }
  },
  {
    name: "werkel_cleanup",
    description: "Remove a job's worktree and branch once you are done with it. With purge:true the job record itself is deleted too, so the job disappears from werkel_status and the dashboard — use only after the branch is merged or no longer wanted.",
    inputSchema: { type: "object", required: ["jobId"], properties: { jobId: S.jobId, force: { type: "boolean", description: "Discard uncommitted worker changes" }, deleteBranch: { type: "boolean", description: "Default true" }, purge: { type: "boolean", description: "Also delete the job record itself, so it disappears from status and the dashboard" } } }
  },
  {
    name: "werkel_rate",
    description: "Record how a finished job actually turned out, after you have read the diff. This is the one judgement werkel cannot make for itself, and it outweighs every signal it collects on its own. Rate a job once you know — landing it, discarding it or sending a follow-up are already recorded automatically, so rate when you have something those do not capture: work that looked fine and was wrong, a fake verification, or a job that was better than its outcome suggests. Rating the same job again replaces the earlier verdict, which is how you correct one that turned out to be wrong.",
    inputSchema: { type: "object", required: ["jobId", "outcome"], properties: {
      jobId: S.jobId,
      outcome: { type: "string", enum: ["good", "mixed", "bad"], description: "good = you would delegate this again; mixed = usable after fixing; bad = you threw it away or it cost more to fix than to do yourself" },
      why: { type: "string", description: "At most 200 characters, and worth more than the rating: what specifically this model did, so the next manager reads it before delegating. \"Inverted the collapsed-by-default rule while implementing its persistence\" beats \"decent work\"." },
      issue: { type: "string", enum: ["scope-creep", "fake-verification", "stub", "invented-api", "missed-requirement", "broke-tests", "none"], description: "Which classic worker failure this was, when it was one of them." }
    } }
  },
  {
    name: "werkel_models",
    description: "Which models this machine can actually route to, with price per 1M tokens and whether the budget guard allows them. Check this before picking a model explicitly.",
    inputSchema: { type: "object", properties: { refresh: { type: "boolean", description: "Re-fetch the OpenRouter catalogue and the opencode model list" }, all: { type: "boolean", description: "Include models the guard blocks, with the reason" }, repo: { type: "string", description: "Repo whose local config should apply" } } }
  },
  {
    name: "werkel_doctor",
    description: "Check the setup: opencode binary, authenticated providers, configured profiles, budget limits, today's spend, stuck jobs. Run this first when a delegation fails.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, warmup: { type: "boolean", description: "Also do a tiny real run to pre-install provider packages (first run is slow otherwise)" } } }
  }
];

// ---- handlers -------------------------------------------------------------

const NEEDS_JOB = new Set(["werkel_status", "werkel_result", "werkel_diff", "werkel_logs", "werkel_followup", "werkel_apply", "werkel_cancel", "werkel_cleanup", "werkel_rate"]);

async function callTool(name, a = {}) {
  // a missing id used to crash on path.join(undefined); say what is wrong instead
  if (NEEDS_JOB.has(name) && name !== "werkel_status" && (typeof a.jobId !== "string" || !a.jobId)) {
    return { error: `${name} needs a jobId (string). Use werkel_status to list recent jobs.` };
  }
  switch (name) {
    case "werkel_delegate": return await J.delegate(a);

    case "werkel_wait": return await J.waitFor(a.jobIds ?? [], { timeoutSec: a.timeoutSec ?? 120 });

    case "werkel_status": {
      if (a.jobId) {
        const j = await J.refresh(a.jobId);
        return j ? J.jobView(j, { verbose: a.verbose ?? true }) : { error: `unknown job ${a.jobId}` };
      }
      const all = await J.refreshAll();
      const spend = spentToday();
      const queued = all.filter((j) => j.state === "queued")
        .sort((x, y) => (x.queuedAt ?? 0) - (y.queuedAt ?? 0));
      return {
        running: all.filter((j) => j.state === "running").map((j) => J.jobView(j)),
        // waiting jobs get their own list — they are neither running nor history,
        // and showing them under "recent" would read like they had already been tried
        queued: queued.length
          ? queued.map((j, i) => ({ ...J.jobView(j), queuePosition: i + 1 }))
          : undefined,
        recent: all.filter((j) => j.state !== "running" && j.state !== "queued").slice(0, a.limit ?? 15).map((j) => J.jobView(j)),
        spentTodayUsd: Number((spend.total ?? 0).toFixed(4))
      };
    }

    case "werkel_result": {
      const job = await J.refresh(a.jobId);
      if (!job) return { error: `unknown job ${a.jobId}` };
      const cfg = loadConfig(job.sourceRepo);
      const out = J.jobView(job, { verbose: true });
      if (job.worktree?.mode === "worktree" || job.worktree?.repo) {
        const d = await diffSummary(job, { maxChars: a.maxDiffChars ?? cfg.limits.diffCharsInResult });
        out.changedFiles = d.files;
        out.diffstat = d.stat;
        out.uncommitted = d.uncommitted?.length ? d.uncommitted : undefined;
        // The patch runs to thousands of tokens. The report, the diffstat and the
        // file list are enough to decide whether it is worth fetching, so it is
        // opt-in here and werkel_diff exists for when the answer is yes.
        if (a.includeDiff === true) out.patch = d.patch;
        else if (d.patchBytes) out.patchAvailable = `${d.patchBytes} bytes — werkel_diff ${job.id}`;
      }
      return out;
    }

    case "werkel_diff": {
      const job = await J.refresh(a.jobId);
      if (!job) return { error: `unknown job ${a.jobId}` };
      return await diffSummary(job, { maxChars: a.maxChars ?? 12000 });
    }

    case "werkel_logs": {
      const job = J.readJob(a.jobId);
      if (!job) return { error: `unknown job ${a.jobId}` };
      const ev = J.parseEvents(a.jobId, job.jobDir);
      let stderr = "";
      try { stderr = fs.readFileSync(path.join(job.jobDir, "stderr.log"), "utf8"); } catch {}
      // Every tool call names its file by absolute path, so the same seventy
      // characters of worktree prefix are repeated on every line of the log.
      const root = job.dir ?? "";
      const rel = (t) => (root && typeof t === "string" && t.startsWith(root))
        ? (t.slice(root.length).replace(/^[\\/]+/, "") || ".")
        : t;
      return {
        jobId: job.id, state: job.state, events: ev.eventCount, workingDir: root || undefined,
        toolCalls: ev.tools.slice(-(a.tail ?? 40)).map((t) => ({ ...t, target: rel(t.target) })),
        summary: J.toolSummary(ev.tools),
        errors: ev.errors,
        stderrTail: truncate(stderr.split("\n").slice(-30).join("\n"), 3000),
        files: { events: path.join(job.jobDir, "events.ndjson"), prompt: path.join(job.jobDir, "prompt.md") }
      };
    }

    case "werkel_followup": return await J.followup(a.jobId, a.message, a);

    case "werkel_apply": {
      const job = await J.refresh(a.jobId);
      if (!job) return { error: `unknown job ${a.jobId}` };
      if (job.state === "running") return { error: "job is still running" };
      const r = await applyJob(job, { mode: a.mode ?? "merge", target: a.target, message: a.message });
      // Landing the work is the strongest verdict anyone gives a worker, and until
      // now it left no trace at all — five minutes later an accepted job and a
      // discarded one looked identical on disk.
      if (r?.ok) J.markApplied(job, r.mode);
      return r;
    }

    case "werkel_rate": {
      const job = J.readJob(a.jobId);
      if (!job) return { error: `unknown job ${a.jobId}` };
      return J.rate(job, a);
    }

    case "werkel_cancel": return await J.cancel(a.jobId);

    case "werkel_cleanup": {
      const job = J.readJob(a.jobId);
      if (!job) return { error: `unknown job ${a.jobId}` };
      if (a.purge) return await J.forget(a.jobId, { force: a.force });
      J.noteDiscardedIfUnused(job);
      return await removeWorktree(job, { force: a.force, deleteBranch: a.deleteBranch !== false });
    }

    case "werkel_models": {
      const cfg = loadConfig(a.repo);
      const rows = await allowedModels(cfg, { refresh: a.refresh, cwd: a.repo ?? process.cwd() });
      const allowed = rows.filter((r) => r.allowed);
      const view = (r) => ({ model: r.model, usdPerMtokIn: r.prompt, usdPerMtokOut: r.completion, context: r.context, tools: r.tools, ...(r.allowed ? {} : { blocked: r.reason }) });
      return {
        budget: cfg.budget,
        profiles: Object.fromEntries(Object.entries(cfg.profiles).map(([k, v]) => [k, { description: v.description, candidates: v.candidates }])),
        allowed: allowed.map(view),
        blocked: a.all ? rows.filter((r) => !r.allowed).map(view) : `${rows.length - allowed.length} models blocked (pass all:true to see them)`,
        suggestedProfiles: a.suggest ? (await suggestProfiles(cfg, { cwd: a.repo ?? process.cwd() })).profiles : undefined,
        spentTodayUsd: Number((spentToday().total ?? 0).toFixed(4))
      };
    }

    case "werkel_doctor": return await doctor({ repo: a.repo, warmup: a.warmup });

    default: return { error: `unknown tool ${name}` };
  }
}

// ---- JSON-RPC plumbing ----------------------------------------------------

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: NAME, version: VERSION },
      instructions: "You are the manager. Break work into self-contained jobs, delegate them to cheap OpenCode models with werkel_delegate, review every diff before werkel_apply. Never let a worker's report substitute for reading its patch."
    } });
  }
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) return;
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    const tname = params?.name;
    try {
      const result = await callTool(tname, params?.arguments ?? {});
      const isError = !!result?.error;
      return send({ jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError
      } });
    } catch (e) {
      return send({ jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: JSON.stringify({ error: String(e?.stack || e) }, null, 2) }], isError: true } });
    }
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

export function serve() {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      try { await handle(msg); } catch (e) { process.stderr.write(`werkel mcp error: ${e}\n`); }
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stderr.write(`${NAME} ${VERSION} ready on stdio\n`);
}

export { TOOLS, callTool };
