/**
 * Dependency-free MCP stdio server. Node >= 18, no npm install needed.
 * Exposes the fleet as tools so any Claude agent can act as the manager.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { allowedModels, spentToday, openrouterCatalog, installedModels } from "./models.mjs";
import * as J from "./jobs.mjs";
import { applyJob, removeWorktree, diffSummary } from "./worktree.mjs";
import { doctor } from "./doctor.mjs";
import { truncate } from "./util.mjs";

const NAME = "opencode-fleet";
const VERSION = "0.1.0";

const S = {
  jobId: { type: "string", description: "Job id returned by fleet_delegate" }
};

const TOOLS = [
  {
    name: "fleet_delegate",
    description:
      "Hand one self-contained coding task to an OpenCode worker running a cheaper model. Returns a jobId immediately; the worker runs detached in its own git worktree/branch, so several jobs can run in parallel without touching each other. Write the task like a work order for someone who has not seen the repo: what to change, which files matter, what 'done' means, and a verification command. Then poll with fleet_wait/fleet_status, review with fleet_diff, and land it with fleet_apply.",
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
        readOnly: { type: "boolean", description: "Investigation only: file edits are denied, the worker reports findings. Good for cheap models on unclear bugs." },
        worktree: { type: "boolean", description: "Isolate in a new git worktree+branch (default true). false = edit the repo directly." },
        baseRef: { type: "string", description: "Branch/commit the worktree starts from (default: current branch)." },
        timeoutSec: { type: "number", description: "Hard kill after this many seconds (default 1200)." },
        agent: { type: "string", description: "OpenCode agent to run as (e.g. 'build', 'plan', or a custom subagent)." },
        variant: { type: "string", description: "Reasoning effort variant, provider specific (e.g. 'high')." }
      }
    }
  },
  {
    name: "fleet_wait",
    description: "Block until the given jobs finish (or the wait times out). Use this instead of polling in a loop. Returns finished jobs with their report, cost and tool usage.",
    inputSchema: { type: "object", properties: {
      jobIds: { type: "array", items: { type: "string" }, description: "Jobs to wait for. Omit = all running jobs." },
      timeoutSec: { type: "number", description: "How long to wait, default 120. The job itself keeps running if the wait expires." } } }
  },
  {
    name: "fleet_status",
    description: "State of one job or of all recent jobs: running/done/failed/timeout, duration, cost, which tools the worker used.",
    inputSchema: { type: "object", properties: { jobId: S.jobId, limit: { type: "number", description: "How many recent jobs to list (default 15)" }, verbose: { type: "boolean" } } }
  },
  {
    name: "fleet_result",
    description: "Full result of a finished job: the worker's report (SUMMARY/FILES/VERIFICATION/ASSUMPTIONS/BLOCKED), changed files, diffstat and cost. Read this before reviewing the diff.",
    inputSchema: { type: "object", required: ["jobId"], properties: { jobId: S.jobId, includeDiff: { type: "boolean", description: "Also include the patch (default true)" }, maxDiffChars: { type: "number" } } }
  },
  {
    name: "fleet_diff",
    description: "The worker's patch, so you can review it line by line before it touches the main branch.",
    inputSchema: { type: "object", required: ["jobId"], properties: { jobId: S.jobId, maxChars: { type: "number", description: "Truncate the patch at this length (default 12000)" } } }
  },
  {
    name: "fleet_logs",
    description: "Raw activity of a job: every tool call the worker made, plus stderr. Use when a job failed or did something unexpected.",
    inputSchema: { type: "object", required: ["jobId"], properties: { jobId: S.jobId, tail: { type: "number", description: "How many tool calls to show (default 40)" } } }
  },
  {
    name: "fleet_followup",
    description: "Send review feedback to a finished job. The worker continues in the SAME session and worktree, so it keeps its context — much cheaper than re-delegating.",
    inputSchema: { type: "object", required: ["jobId", "message"], properties: { jobId: S.jobId, message: { type: "string", description: "What to fix or change." }, model: { type: "string", description: "Escalate to another model for this round." }, timeoutSec: { type: "number" } } }
  },
  {
    name: "fleet_apply",
    description: "Land a reviewed job in the main repo: merge its branch, squash-merge it, or write a .patch file. Refuses when the main working copy is dirty.",
    inputSchema: { type: "object", required: ["jobId"], properties: { jobId: S.jobId,
      mode: { type: "string", enum: ["merge", "squash", "patch"], description: "merge (default), squash, or patch file" },
      target: { type: "string", description: "Branch to land on (default: current branch of the main repo)" },
      message: { type: "string", description: "Commit message" } } }
  },
  {
    name: "fleet_cancel",
    description: "Kill a running job (its worktree and partial changes stay for inspection).",
    inputSchema: { type: "object", required: ["jobId"], properties: { jobId: S.jobId } }
  },
  {
    name: "fleet_cleanup",
    description: "Remove a job's worktree and branch once you are done with it.",
    inputSchema: { type: "object", required: ["jobId"], properties: { jobId: S.jobId, force: { type: "boolean", description: "Discard uncommitted worker changes" }, deleteBranch: { type: "boolean", description: "Default true" } } }
  },
  {
    name: "fleet_models",
    description: "Which models this machine can actually route to, with price per 1M tokens and whether the budget guard allows them. Check this before picking a model explicitly.",
    inputSchema: { type: "object", properties: { refresh: { type: "boolean", description: "Re-fetch the OpenRouter catalogue and the opencode model list" }, all: { type: "boolean", description: "Include models the guard blocks, with the reason" }, repo: { type: "string", description: "Repo whose local config should apply" } } }
  },
  {
    name: "fleet_doctor",
    description: "Check the setup: opencode binary, authenticated providers, configured profiles, budget limits, today's spend, stuck jobs. Run this first when a delegation fails.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, warmup: { type: "boolean", description: "Also do a tiny real run to pre-install provider packages (first run is slow otherwise)" } } }
  }
];

// ---- handlers -------------------------------------------------------------

async function callTool(name, a = {}) {
  switch (name) {
    case "fleet_delegate": return await J.delegate(a);

    case "fleet_wait": return await J.waitFor(a.jobIds ?? [], { timeoutSec: a.timeoutSec ?? 120 });

    case "fleet_status": {
      if (a.jobId) {
        const j = await J.refresh(a.jobId);
        return j ? J.jobView(j, { verbose: a.verbose ?? true }) : { error: `unknown job ${a.jobId}` };
      }
      const all = await J.refreshAll();
      const spend = spentToday();
      return {
        running: all.filter((j) => j.state === "running").map((j) => J.jobView(j)),
        recent: all.filter((j) => j.state !== "running").slice(0, a.limit ?? 15).map((j) => J.jobView(j)),
        spentTodayUsd: Number((spend.total ?? 0).toFixed(4))
      };
    }

    case "fleet_result": {
      const job = await J.refresh(a.jobId);
      if (!job) return { error: `unknown job ${a.jobId}` };
      const cfg = loadConfig(job.sourceRepo);
      const out = J.jobView(job, { verbose: true });
      if (job.worktree?.mode === "worktree" || job.worktree?.repo) {
        const d = await diffSummary(job, { maxChars: a.maxDiffChars ?? cfg.limits.diffCharsInResult });
        out.changedFiles = d.files;
        out.diffstat = d.stat;
        out.uncommitted = d.uncommitted?.length ? d.uncommitted : undefined;
        if (a.includeDiff !== false) out.patch = d.patch;
      }
      return out;
    }

    case "fleet_diff": {
      const job = await J.refresh(a.jobId);
      if (!job) return { error: `unknown job ${a.jobId}` };
      return await diffSummary(job, { maxChars: a.maxChars ?? 12000 });
    }

    case "fleet_logs": {
      const job = J.readJob(a.jobId);
      if (!job) return { error: `unknown job ${a.jobId}` };
      const ev = J.parseEvents(a.jobId);
      let stderr = "";
      try { stderr = fs.readFileSync(path.join(job.jobDir, "stderr.log"), "utf8"); } catch {}
      return {
        jobId: job.id, state: job.state, events: ev.eventCount,
        toolCalls: ev.tools.slice(-(a.tail ?? 40)),
        summary: J.toolSummary(ev.tools),
        errors: ev.errors,
        stderrTail: truncate(stderr.split("\n").slice(-30).join("\n"), 3000),
        files: { events: path.join(job.jobDir, "events.ndjson"), prompt: path.join(job.jobDir, "prompt.md") }
      };
    }

    case "fleet_followup": return await J.followup(a.jobId, a.message, a);

    case "fleet_apply": {
      const job = await J.refresh(a.jobId);
      if (!job) return { error: `unknown job ${a.jobId}` };
      if (job.state === "running") return { error: "job is still running" };
      return await applyJob(job, { mode: a.mode ?? "merge", target: a.target, message: a.message });
    }

    case "fleet_cancel": return await J.cancel(a.jobId);

    case "fleet_cleanup": {
      const job = J.readJob(a.jobId);
      if (!job) return { error: `unknown job ${a.jobId}` };
      return await removeWorktree(job, { force: a.force, deleteBranch: a.deleteBranch !== false });
    }

    case "fleet_models": {
      const cfg = loadConfig(a.repo);
      const rows = await allowedModels(cfg, { refresh: a.refresh, cwd: a.repo ?? process.cwd() });
      const allowed = rows.filter((r) => r.allowed);
      const view = (r) => ({ model: r.model, usdPerMtokIn: r.prompt, usdPerMtokOut: r.completion, context: r.context, tools: r.tools, ...(r.allowed ? {} : { blocked: r.reason }) });
      return {
        budget: cfg.budget,
        profiles: Object.fromEntries(Object.entries(cfg.profiles).map(([k, v]) => [k, { description: v.description, candidates: v.candidates }])),
        allowed: allowed.map(view),
        blocked: a.all ? rows.filter((r) => !r.allowed).map(view) : `${rows.length - allowed.length} models blocked (pass all:true to see them)`,
        spentTodayUsd: Number((spentToday().total ?? 0).toFixed(4))
      };
    }

    case "fleet_doctor": return await doctor({ repo: a.repo, warmup: a.warmup });

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
      instructions: "You are the manager. Break work into self-contained jobs, delegate them to cheap OpenCode models with fleet_delegate, review every diff before fleet_apply. Never let a worker's report substitute for reading its patch."
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
      try { await handle(msg); } catch (e) { process.stderr.write(`fleet mcp error: ${e}\n`); }
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stderr.write(`${NAME} ${VERSION} ready on stdio\n`);
}

export { TOOLS, callTool };
