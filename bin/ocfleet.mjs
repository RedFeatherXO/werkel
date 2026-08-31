#!/usr/bin/env node
/**
 * ocfleet — Claude manages, OpenCode workers execute.
 * The same engine the MCP server exposes, usable from a shell or CI.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, DEFAULTS } from "../src/config.mjs";
import { allowedModels, spentToday, suggestProfiles } from "../src/models.mjs";
import * as J from "../src/jobs.mjs";
import { applyJob, removeWorktree, diffSummary } from "../src/worktree.mjs";
import { doctor } from "../src/doctor.mjs";
import { serve } from "../src/mcp.mjs";
import { usd, humanDuration } from "../src/util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=");
      const next = argv[i + 1];
      if (inline !== undefined) out.flags[k] = inline;
      else if (next && !next.startsWith("--")) { out.flags[k] = next; i++; }
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

const p = (...a) => console.log(...a);
const jsonOut = (o) => p(JSON.stringify(o, null, 2));

function stateIcon(s) {
  return { running: "▶", done: "✓", failed: "✗", timeout: "⏱", cancelled: "⊘" }[s] ?? "·";
}

function printJobs(list) {
  if (!list.length) return p("  (none)");
  for (const j of list) {
    p(`  ${stateIcon(j.state)} ${j.jobId}  ${String(j.state).padEnd(9)} ${String(j.duration).padEnd(7)} ${usd(j.costUsd).padEnd(8)} ${(j.model ?? "").padEnd(38)} ${j.title ?? ""}`);
    if (j.error) p(`      ! ${String(j.error).split("\n")[0].slice(0, 160)}`);
  }
}

const HELP = `
ocfleet — delegate coding jobs from Claude to OpenCode workers on cheaper models

  ocfleet doctor [--warmup]              check binaries, providers, profiles, budget
  ocfleet models [--all] [--refresh]     models this machine can route to, with prices
  ocfleet delegate "<task>" [opts]       start a job (prints the job id)
      --repo <dir>        repository (default: cwd)
      --profile <name>    cheap | balanced | strong | longcontext | local
      --model <ref>       explicit provider/model
      --verify "<cmd>"    command the worker must run and report
      --context "<text>"  what you already know
      --files a,b,c       files the worker should read first
      --done "<text>"     definition of done
      --read-only         investigation only, no edits
      --no-worktree       edit the repo directly instead of an isolated branch
      --timeout <sec>     hard kill (default 1200)
      --wait [sec]        block until it finishes, then print the result
  ocfleet status [jobId] [--json]        state of one job or all recent jobs
  ocfleet wait [jobId...] [--timeout s]  block until jobs finish
  ocfleet result <jobId> [--no-diff]     report + diffstat + patch
  ocfleet diff <jobId> [--max n]         the patch alone
  ocfleet logs <jobId> [--tail n]        every tool call the worker made
  ocfleet followup <jobId> "<feedback>"  continue the same session/worktree
  ocfleet apply <jobId> [--mode merge|squash|patch] [--target branch]
  ocfleet cleanup <jobId> [--force]      remove worktree + branch
  ocfleet cancel <jobId>                 kill a running job
  ocfleet mcp                            run as an MCP stdio server (for Claude)
  ocfleet install [--scope user|project|print]   register the MCP server with Claude Code
  ocfleet init-config [--force]          write a starter fleet.config.json
`;

const cmds = {
  async doctor(a) {
    const r = await doctor({ repo: path.resolve(a.flags.repo ?? process.cwd()), warmup: !!a.flags.warmup });
    if (a.flags.json) return jsonOut(r);
    p(`\n${r.ok ? "✓" : "✗"} ${r.summary}\n`);
    p(`  opencode   ${r.info.opencode} ${r.info.opencodeVersion ?? ""}`);
    p(`  git        ${r.info.git}`);
    p(`  node       ${r.info.node}`);
    p(`  config     ${(r.info.configSources || []).join(", ")}`);
    p(`  state      ${r.info.stateDir}`);
    p(`  models     ${r.info.installedModelCount ?? 0} configured in opencode`);
    p(`  budget     ≤ $${r.info.budget.maxPromptUsdPerMTok}/Mtok in, ≤ $${r.info.budget.maxCompletionUsdPerMTok}/Mtok out, ${usd(r.info.spentTodayUsd)} spent today of ${usd(r.info.dailyLimitUsd)}`);
    p("\n  profiles:");
    for (const [name, prof] of Object.entries(r.info.profiles ?? {})) {
      p(`    ${name.padEnd(12)} ${prof.usable ? "→ " + prof.usable : "✗ nothing usable"}`);
      if (!prof.usable) for (const c of prof.candidates) p(`      · ${c.model.padEnd(46)} ${c.reason}`);
    }
    if (r.info.jobs) p(`\n  jobs       ${r.info.jobs.running} running, ${r.info.jobs.total} total`);
    if (r.info.warmup) p(`  warmup     ${JSON.stringify(r.info.warmup)}`);
    for (const w of r.warnings) p(`\n  ⚠ ${w}`);
    for (const e of r.problems) p(`\n  ✗ ${e}`);
    p("");
  },

  async models(a) {
    const cfg = loadConfig(path.resolve(a.flags.repo ?? process.cwd()));
    const rows = await allowedModels(cfg, { refresh: !!a.flags.refresh, cwd: path.resolve(a.flags.repo ?? process.cwd()) });
    if (a.flags.json) return jsonOut(rows);
    const show = a.flags.all ? rows : rows.filter((r) => r.allowed);
    p(`\n  budget: ≤ $${cfg.budget.maxPromptUsdPerMTok}/Mtok input, ≤ $${cfg.budget.maxCompletionUsdPerMTok}/Mtok output, tools required: ${cfg.budget.requireToolSupport}\n`);
    p(`  ${"".padEnd(3)}${"model".padEnd(48)} ${"in".padStart(7)} ${"out".padStart(7)}  ctx`);
    for (const r of show) {
      p(`  ${r.allowed ? "✓ " : "✗ "} ${r.model.padEnd(48)} ${(r.prompt ?? "?").toString().padStart(7)} ${(r.completion ?? "?").toString().padStart(7)}  ${r.context ?? "?"}${r.allowed ? "" : "   ← " + r.reason}`);
    }
    p(`\n  ${rows.filter((r) => r.allowed).length}/${rows.length} models pass the guard. Spent today: ${usd(spentToday().total ?? 0)}\n`);
  },

  async delegate(a) {
    const task = a._[0];
    if (!task) return p("need a task: ocfleet delegate \"fix the failing auth test\" --repo .");
    const res = await J.delegate({
      task,
      repo: path.resolve(a.flags.repo ?? process.cwd()),
      profile: a.flags.profile,
      model: a.flags.model,
      title: a.flags.title,
      context: a.flags.context,
      verify: a.flags.verify,
      done: a.flags.done,
      files: a.flags.files ? String(a.flags.files).split(",").map((s) => s.trim()) : undefined,
      constraints: a.flags.constraint ? [a.flags.constraint] : undefined,
      readOnly: !!a.flags["read-only"],
      worktree: a.flags["no-worktree"] ? false : undefined,
      timeoutSec: a.flags.timeout ? Number(a.flags.timeout) : undefined,
      agent: a.flags.agent
    });
    if (res.error) { jsonOut(res); process.exitCode = 1; return; }
    p(`\n  job ${res.jobId}`);
    p(`  model    ${res.model}  (${res.why}, ${res.price})`);
    p(`  worktree ${res.worktree.path ?? "-"}${res.worktree.branch ? "  [" + res.worktree.branch + "]" : ""}`);
    if (res.worktree.warning) p(`  ⚠ ${res.worktree.warning}`);
    p(`  follow   ocfleet wait ${res.jobId}   |   ocfleet logs ${res.jobId}\n`);
    if (a.flags.wait) {
      const secs = typeof a.flags.wait === "string" ? Number(a.flags.wait) : 900;
      await cmds.wait({ _: [res.jobId], flags: { timeout: secs } });
      await cmds.result({ _: [res.jobId], flags: {} });
    }
  },

  async suggest(a) {
    const repo = path.resolve(a.flags.repo ?? process.cwd());
    const cfg = loadConfig(repo);
    const r = await suggestProfiles(cfg, { cwd: repo, refresh: !!a.flags.refresh });
    if (a.flags.json) return jsonOut(r);
    if (r.note) { p(`\n  ${r.note}\n`); return; }
    p(`\n  ${r.considered} priced, tool-capable models out of ${r.installed} configured\n`);
    for (const [name, prof] of Object.entries(r.profiles)) {
      p(`  ${name.padEnd(12)} ${prof.description}`);
      for (const c of prof.candidates) p(`      ${c}`);
    }
    if (!a.flags.write) {
      p(`\n  add to your fleet.config.json:\n`);
      p(JSON.stringify({ profiles: r.profiles }, null, 2).split("\n").map((l) => "  " + l).join("\n"));
      p(`\n  or run: ocfleet suggest --write\n`);
      return;
    }
    const { stateDir, ensureDir, readJson, writeJson } = await import("../src/util.mjs");
    const target = path.join(ensureDir(stateDir()), "fleet.config.json");
    const current = readJson(target, {});
    if (fs.existsSync(target)) fs.copyFileSync(target, target + ".bak");
    current.profiles = r.profiles;
    writeJson(target, current);
    p(`\n  ✓ wrote ${Object.keys(r.profiles).length} profiles to ${target}${fs.existsSync(target + ".bak") ? " (backup: fleet.config.json.bak)" : ""}\n`);
  },

  async status(a) {
    if (a._[0]) {
      const j = await J.refresh(a._[0]);
      return jsonOut(j ? J.jobView(j, { verbose: true }) : { error: "unknown job" });
    }
    const all = await J.refreshAll();
    if (a.flags.json) return jsonOut(all.map((j) => J.jobView(j)));
    p("\n  running:"); printJobs(all.filter((j) => j.state === "running").map((j) => J.jobView(j)));
    p("\n  recent:"); printJobs(all.filter((j) => j.state !== "running").slice(0, Number(a.flags.limit ?? 12)).map((j) => J.jobView(j)));
    p(`\n  spent today: ${usd(spentToday().total ?? 0)}\n`);
  },

  async wait(a) {
    const r = await J.waitFor(a._, { timeoutSec: Number(a.flags.timeout ?? 300) });
    if (a.flags.json) return jsonOut(r);
    p("\n  finished:"); printJobs(r.done);
    if (r.stillRunning.length) { p("\n  still running:"); printJobs(r.stillRunning); }
    p("");
  },

  async result(a) {
    const id = a._[0];
    const job = await J.refresh(id);
    if (!job) return p("unknown job");
    const view = J.jobView(job, { verbose: true });
    if (a.flags.json) {
      const d = await diffSummary(job).catch(() => null);
      return jsonOut({ ...view, diff: d });
    }
    p(`\n  ${stateIcon(job.state)} ${job.id}  ${job.state}  ${humanDuration(job.durationMs)}  ${usd(job.costUsd)}${job.costEstimated ? " (est)" : ""}  ${job.model}`);
    p(`  branch ${job.worktree?.branch ?? "-"}   tools: ${job.toolSummary ?? "-"}   tokens in/out: ${job.tokens?.input ?? "?"}/${job.tokens?.output ?? "?"}`);
    if (job.error) p(`\n  ERROR\n  ${String(job.error).split("\n").join("\n  ")}`);
    if (job.report) p(`\n  REPORT\n  ${job.report.split("\n").join("\n  ")}`);
    const d = await diffSummary(job).catch(() => null);
    if (d && !d.error) {
      p(`\n  DIFFSTAT\n  ${d.stat.split("\n").join("\n  ")}`);
      if (d.uncommitted?.length) p(`\n  uncommitted files: ${d.uncommitted.join(", ")}`);
      if (!a.flags["no-diff"] && d.patch.trim()) p(`\n  PATCH\n${d.patch}`);
    }
    p("");
  },

  async diff(a) {
    const job = await J.refresh(a._[0]);
    if (!job) return p("unknown job");
    const d = await diffSummary(job, { maxChars: Number(a.flags.max ?? 12000) });
    p(d.error ? d.error : d.patch || "(no changes)");
  },

  async logs(a) {
    const r = await (await import("../src/mcp.mjs")).callTool("fleet_logs", { jobId: a._[0], tail: Number(a.flags.tail ?? 40) });
    jsonOut(r);
  },

  async followup(a) {
    jsonOut(await J.followup(a._[0], a._.slice(1).join(" "), { model: a.flags.model }));
  },

  async apply(a) {
    const job = await J.refresh(a._[0]);
    if (!job) return p("unknown job");
    jsonOut(await applyJob(job, { mode: a.flags.mode ?? "merge", target: a.flags.target, message: a.flags.message }));
  },

  async cleanup(a) {
    const job = J.readJob(a._[0]);
    if (!job) return p("unknown job");
    jsonOut(await removeWorktree(job, { force: !!a.flags.force, deleteBranch: a.flags["keep-branch"] ? false : true }));
  },

  async cancel(a) { jsonOut(await J.cancel(a._[0])); },

  async mcp() { serve(); },

  async install(a) {
    const entry = path.join(ROOT, "bin", "ocfleet.mjs");
    const scope = a.flags.scope ?? "user";
    const cfgJson = { mcpServers: { "opencode-fleet": { command: "node", args: [entry, "mcp"] } } };
    if (scope === "print") return jsonOut(cfgJson);
    const { runSync, which } = await import("../src/util.mjs");
    if (!which("claude")) {
      p("claude CLI not found. Add this to your MCP client config manually:\n");
      jsonOut(cfgJson);
      return;
    }
    const r = runSync("claude", ["mcp", "add", "--scope", scope, "opencode-fleet", "--", "node", entry, "mcp"]);
    p(r.ok ? `✓ registered with Claude Code (scope: ${scope})\n  ${r.stdout.trim()}` : `✗ ${r.stderr || r.error}\n\nAdd manually:\n${JSON.stringify(cfgJson, null, 2)}`);
    p(`\nSkill (optional): cp -r ${path.join(ROOT, "skills", "opencode-fleet")} ~/.claude/skills/`);
  },

  async "init-config"(a) {
    const { stateDir, ensureDir } = await import("../src/util.mjs");
    const target = path.join(ensureDir(stateDir()), "fleet.config.json");
    if (fs.existsSync(target) && !a.flags.force) return p(`exists: ${target} (use --force to overwrite)`);
    if (fs.existsSync(target)) { fs.copyFileSync(target, target + ".bak"); p(`  backup: ${target}.bak`); }
    const starter = {
      defaults: DEFAULTS.defaults,
      budget: DEFAULTS.budget,
      profiles: DEFAULTS.profiles,
      staticPricing: DEFAULTS.staticPricing
    };
    fs.writeFileSync(target, JSON.stringify(starter, null, 2));
    p(`wrote ${target}`);
  }
};

const argv = process.argv.slice(2);
const cmd = argv[0];
const a = parseArgs(argv.slice(1));
if (!cmd || cmd === "help" || a.flags.help) { p(HELP); process.exit(0); }
if (!cmds[cmd]) { p(`unknown command: ${cmd}`); p(HELP); process.exit(1); }
cmds[cmd](a).catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
