#!/usr/bin/env node
/**
 * ocfleet — Claude manages, OpenCode workers execute.
 * The same engine the MCP server exposes, usable from a shell or CI.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, DEFAULTS } from "../src/config.mjs";
import { allowedModels, spentToday, suggestProfiles } from "../src/models.mjs";
import * as J from "../src/jobs.mjs";
import { applyJob, removeWorktree, diffSummary } from "../src/worktree.mjs";
import { doctor } from "../src/doctor.mjs";
import { report } from "../src/reporter.mjs";
import { serve } from "../src/mcp.mjs";
import { createRequire } from "node:module";
const require$ = createRequire(import.meta.url);
import { usd, humanDuration, SYM, run } from "../src/util.mjs";

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

function openInBrowser(url) {
  const { spawn } = require$("node:child_process");
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore", windowsHide: true }).unref(); } catch {}
}

function stateIcon(s) {
  return { running: SYM.run, done: SYM.done, failed: SYM.failed, timeout: SYM.timeout, cancelled: SYM.cancelled, queued: SYM.dot }[s] ?? SYM.dot;
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
      --read-only         investigation only: no edits, and no shell either
      --allow-bash        with --read-only: let it run commands (implied by --verify)
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
  ocfleet forget <jobId> [--force]       delete the record too, so it disappears from status
  ocfleet cancel <jobId>                 kill a running job
  ocfleet report --to <url> [opts]       push job state to a remote dashboard
      --token <t>         auth token (env FLEET_INGEST_TOKEN works too)
      --interval <sec>    seconds between cycles (default 5)
      --once              one cycle and exit (for cron and tests)
  ocfleet probe [--profile n] [--all]    check which models actually answer right now
  ocfleet health [--reset]               what the fleet learned about model availability
  ocfleet dashboard [opts]               run the dashboard on this machine, no server needed
      --port <n>          default 7777
      --host <addr>       default 127.0.0.1 (use 0.0.0.0 to reach it from the LAN)
      --open              open it in your browser
      --interval <sec>    how often to refresh, default 3
  ocfleet mcp                            run as an MCP stdio server (for Claude)
  ocfleet install [--scope user|project|print]   register the MCP server with Claude Code
  ocfleet link [--dir <path>]            put ocfleet on your PATH (default ~/.local/bin)
  ocfleet experience [--profile <p>]     what each model actually did here, and why
  ocfleet init-config [--force]          write a starter fleet.config.json
`;

const cmds = {
  async doctor(a) {
    const r = await doctor({ repo: path.resolve(a.flags.repo ?? process.cwd()), warmup: !!a.flags.warmup });
    if (a.flags.json) return jsonOut(r);
    p(`\n${r.ok ? SYM.ok : SYM.fail} ${r.summary}\n`);
    p(`  opencode   ${r.info.opencode} ${r.info.opencodeVersion ?? ""}`);
    p(`  git        ${r.info.git}`);
    p(`  node       ${r.info.node}`);
    p(`  config     ${(r.info.configSources || []).join(", ")}`);
    p(`  state      ${r.info.stateDir}`);
    p(`  models     ${r.info.installedModelCount ?? 0} configured in opencode`);
    if (r.info.defaults) {
      const d = r.info.defaults;
      p(`  defaults   profile ${d.profile}, up to ${d.maxConcurrentJobs} workers at once, ${d.timeoutSec}s timeout, worktree ${d.worktree ? "on" : "off"}, failover ${d.failover ? "on" : "off"}`);
    }
    p(`  budget     ${SYM.le} $${r.info.budget.maxPromptUsdPerMTok}/Mtok in, ${SYM.le} $${r.info.budget.maxCompletionUsdPerMTok}/Mtok out, ${usd(r.info.spentTodayUsd)} spent today of ${usd(r.info.dailyLimitUsd)}`);
    p("\n  profiles:");
    for (const [name, prof] of Object.entries(r.info.profiles ?? {})) {
      p(`    ${name.padEnd(12)} ${prof.usable ? SYM.arrow + " " + prof.usable : SYM.fail + " nothing usable"}`);
      if (!prof.usable) for (const c of prof.candidates) p(`      ${SYM.dot} ${c.model.padEnd(46)} ${c.reason}`);
    }
    if (r.info.jobs) {
      p(`\n  jobs       ${r.info.jobs.running} running${r.info.jobs.queued ? `, ${r.info.jobs.queued} queued` : ""}, ${r.info.jobs.total} total`);
      if (r.info.jobs.note) p(`             ${r.info.jobs.note}`);
    }
    if (r.info.warmup) p(`  warmup     ${JSON.stringify(r.info.warmup)}`);
    for (const w of r.warnings) p(`\n  ${SYM.warn} ${w}`);
    for (const e of r.problems) p(`\n  ${SYM.fail} ${e}`);
    p("");
  },

  async models(a) {
    const cfg = loadConfig(path.resolve(a.flags.repo ?? process.cwd()));
    const rows = await allowedModels(cfg, { refresh: !!a.flags.refresh, cwd: path.resolve(a.flags.repo ?? process.cwd()) });
    if (a.flags.json) return jsonOut(rows);
    const show = a.flags.all ? rows : rows.filter((r) => r.allowed);
    p(`\n  budget: ${SYM.le} $${cfg.budget.maxPromptUsdPerMTok}/Mtok input, ${SYM.le} $${cfg.budget.maxCompletionUsdPerMTok}/Mtok output, tools required: ${cfg.budget.requireToolSupport}\n`);
    p(`  ${"".padEnd(3)}${"model".padEnd(46)} ${"in".padStart(7)} ${"out".padStart(7)} ${"cap".padStart(5)} ${"value".padStart(6)}  ctx`);
    for (const r of show) {
      const cap = r.capabilitySource === "artificial-analysis" ? String(r.capability) : `~${Math.round(r.capability)}`;
      p(`  ${r.allowed ? SYM.ok + " " : SYM.fail + " "} ${r.model.padEnd(46)} ${(r.prompt ?? "?").toString().padStart(7)} ${(r.completion ?? "?").toString().padStart(7)} ${cap.padStart(5)} ${String(r.value ?? "?").padStart(6)}  ${r.context ?? "?"}${r.allowed ? "" : "   " + SYM.arrow + " " + r.reason}`);
    }
    p(`\n  cap = 0.6·coding + 0.4·agentic (Artificial Analysis, via OpenRouter); ~x means estimated from the name`);
    p(`  value = cap / (1 + blended price), blended = (3·input + output)/4`);
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
      allowBash: a.flags["allow-bash"] ? true : undefined,
      worktree: a.flags["no-worktree"] ? false : undefined,
      timeoutSec: a.flags.timeout ? Number(a.flags.timeout) : undefined,
      agent: a.flags.agent
    });
    if (res.error) { jsonOut(res); process.exitCode = 1; return; }
    p(`\n  job ${res.jobId}`);
    p(`  model    ${res.model}  (${res.why}, ${res.price})`);
    // A queued job has no working copy yet — it gets one when it starts.
    if (res.state === "queued") {
      p(`  queued   position ${res.queuePosition}, ${res.runningNow} running — starts by itself`);
      if (res.limitFrom) p(`  limit    ${res.limitFrom}`);
    } else {
      p(`  worktree ${res.worktree?.path ?? "-"}${res.worktree?.branch ? "  [" + res.worktree.branch + "]" : ""}`);
      if (res.worktree?.warning) p(`  ${SYM.warn} ${res.worktree.warning}`);
    }
    for (const n of res.notices ?? []) p(`  ${SYM.warn} ${n}`);
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
    // The stamp is what lets the fleet refresh this list later: without it, an
    // auto-refresh would not know whether these profiles are its own to replace.
    current.profilesWrittenAt = new Date().toISOString();
    writeJson(target, current);
    p(`\n  ${SYM.ok} wrote ${Object.keys(r.profiles).length} profiles to ${target}${fs.existsSync(target + ".bak") ? " (backup: fleet.config.json.bak)" : ""}\n`);
  },

  async status(a) {
    if (a._[0]) {
      const j = await J.refresh(a._[0]);
      return jsonOut(j ? J.jobView(j, { verbose: true }) : { error: "unknown job" });
    }
    const all = await J.refreshAll();
    if (a.flags.json) return jsonOut(all.map((j) => J.jobView(j)));
    const q = all.filter((j) => j.state === "queued").sort((x, y) => (x.queuedAt ?? 0) - (y.queuedAt ?? 0));
    p("\n  running:"); printJobs(all.filter((j) => j.state === "running").map((j) => J.jobView(j)));
    if (q.length) { p(`\n  queued (${q.length} waiting for a free slot):`); printJobs(q.map((j) => J.jobView(j))); }
    p("\n  recent:"); printJobs(all.filter((j) => j.state !== "running" && j.state !== "queued").slice(0, Number(a.flags.limit ?? 12)).map((j) => J.jobView(j)));
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

  async forget(a) {
    jsonOut(await J.forget(a._[0], { force: !!a.flags.force }));
  },

  async cancel(a) { jsonOut(await J.cancel(a._[0])); },

  async report(a) {
    if (!a.flags.to) {
      p("missing --to <dashboard-url>, e.g. ocfleet report --to http://minipc:7777");
      process.exitCode = 1;
      return;
    }
    await report({
      to: a.flags.to,
      token: a.flags.token ?? process.env.FLEET_INGEST_TOKEN,
      intervalSec: Number(a.flags.interval ?? 5),
      once: !!a.flags.once,
      log: (msg) => p(`  ${new Date().toISOString()}  ${msg}`)
    });
  },

  /**
   * Local dashboard: the same server and the same reporter as the remote setup,
   * both in this process, talking over the loopback interface. No second code
   * path means the remote deployment and this share every line of behaviour.
   */
  /**
   * Ask each candidate to answer one trivial prompt. Free endpoints go down for
   * minutes at a time, so knowing *before* a real job which ones respond is
   * worth the few seconds this takes.
   */
  async probe(a) {
    const repo = path.resolve(a.flags.repo ?? process.cwd());
    const cfg = loadConfig(repo);
    const { resolveBin, which } = await import("../src/util.mjs");
    const H = await import("../src/health.mjs");
    const bin = resolveBin(cfg);
    if (!which(bin)) { p("opencode not found — run doctor first"); process.exitCode = 1; return; }

    const names = a.flags.profile ? [a.flags.profile] : Object.keys(cfg.profiles ?? {});
    const targets = [];
    for (const n of names) {
      for (const m of cfg.profiles?.[n]?.candidates ?? []) {
        if (!targets.includes(m)) targets.push(m);
      }
    }
    if (!targets.length) { p("no candidates configured — run `ocfleet suggest --write`"); return; }

    const timeout = Number(a.flags.timeout ?? 90) * 1000;
    p(`\n  probing ${targets.length} model(s), ${Math.round(timeout / 1000)}s each\n`);
    const results = [];
    for (const model of targets) {
      const t0 = Date.now();
      const r = await run(bin, ["run", "--format", "json", "--model", model, "reply with the single word: ok"],
        { timeout, cwd: repo });
      const took = Date.now() - t0;
      const answered = /"type"\s*:\s*"text"/.test(r.stdout || "");
      const why = answered ? "" : (r.stderr || r.error || "no answer").toString().trim().split("\n").pop().slice(0, 90);
      H.record(model, answered ? "ok" : "provider-error", why);
      results.push({ model, answered, took, why });
      p(`  ${answered ? SYM.ok : SYM.fail} ${model.padEnd(46)} ${String(Math.round(took / 1000) + "s").padStart(5)}  ${why}`);
    }
    const good = results.filter((r) => r.answered);
    p(`\n  ${good.length}/${results.length} answered. Broken ones are skipped by the next delegation.\n`);
    if (a.flags.json) jsonOut(results);
  },

  async health(a) {
    const H = await import("../src/health.mjs");
    if (a.flags.reset) {
      const { stateDir } = await import("../src/util.mjs");
      const f = path.join(stateDir(), "health.json");
      if (fs.existsSync(f)) fs.unlinkSync(f);
      p("  health history cleared");
      return;
    }
    const rows = H.summary();
    if (a.flags.json) return jsonOut(rows);
    if (!rows.length) { p("\n  nothing recorded yet — run some jobs or `ocfleet probe`\n"); return; }
    p(`\n  ${"model".padEnd(46)} ${"ok".padStart(4)} ${"fail".padStart(5)}  last trouble`);
    for (const r of rows) {
      const when = r.lastFail ? new Date(r.lastFail).toISOString().replace("T", " ").slice(0, 16) : "-";
      p(`  ${r.coolingDown ? SYM.warn : " "} ${r.model.padEnd(44)} ${String(r.ok).padStart(4)} ${String(r.fail).padStart(5)}  ${when}${r.coolingDown ? "  (skipped for now)" : ""}`);
      if (r.coolingDown && r.lastError) p(`    ${SYM.dot} ${r.lastError.slice(0, 100)}`);
    }
    p("");
  },

  async dashboard(a) {
    const { start } = await import("../dashboard/server.mjs");
    const { report } = await import("../src/reporter.mjs");
    const crypto = await import("node:crypto");

    const port = Number(a.flags.port ?? 7777);
    const host = a.flags.host ?? "127.0.0.1";
    const intervalSec = Number(a.flags.interval ?? 3);
    // even on loopback: a token stops anything else on this machine from writing
    const token = crypto.randomUUID();

    let info;
    try {
      info = await start({
        port, host, ingestToken: token,
        dataDir: path.join((await import("../src/util.mjs")).stateDir(), "dashboard")
      });
    } catch (e) {
      if (e?.code === "EADDRINUSE") {
        p(`  port ${port} is already in use — pick another with --port`);
        process.exitCode = 1;
        return;
      }
      throw e;
    }

    p(`\n  dashboard  ${info.url}`);
    p(`  data       ${info.stateFile}${info.restoredJobs ? ` (${info.restoredJobs} jobs restored)` : ""}`);
    p(`  source     this machine, refreshed every ${intervalSec}s`);
    if (host !== "127.0.0.1" && host !== "localhost") p(`  ${SYM.warn} listening on ${host} — reachable from your network, without a login`);
    p(`\n  press Ctrl+C to stop\n`);

    if (a.flags.open) openInBrowser(info.url);

    let stopping = false;
    const tick = async () => {
      if (stopping) return;
      try { await report({ to: info.url, token, once: true }); }
      catch (e) { p(`  ${SYM.warn} refresh failed: ${e.message}`); }
    };
    await tick();
    const timer = setInterval(tick, Math.max(1, intervalSec) * 1000);

    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      await info.close();
      p("\n  dashboard stopped\n");
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  },

  async mcp() { serve(); },

  /**
   * Put `ocfleet` on the PATH. The docs promised this command for a long time
   * while nothing ever created it, so every example had to be run as
   * `node bin/ocfleet.mjs ...` instead. It also repairs the executable bits,
   * because copying this repo around (through a file-transfer bridge, a zip on
   * Windows, an editor) drops them silently and then the launcher stops working.
   */
  async experience(a) {
    const { summary, forget: forgetExp } = await import("../src/experience.mjs");
    if (a.flags.forget) {
      const n = forgetExp(a.flags.forget, a.flags.profile ?? null);
      p(`\n  ${SYM.ok} cleared ${n} bucket(s) for ${a.flags.forget}\n`);
      return;
    }
    let rows = summary();
    if (a.flags.profile) rows = rows.filter((r) => r.profile === a.flags.profile);
    if (a.flags.json) return jsonOut(rows);
    if (!rows.length) {
      p("\n  nothing recorded yet — the fleet learns from applied diffs, follow-ups and fleet_rate\n");
      return;
    }
    p("");
    for (const r of rows) {
      const rate = r.rate == null ? "  –  " : String(Math.round(r.rate * 100)).padStart(3) + "%";
      const bonus = (r.bonus >= 0 ? "+" : "") + r.bonus.toFixed(1);
      p(`  ${String(r.profile).padEnd(12)} ${r.model.padEnd(42)} ${String(r.n).padStart(3)} jobs  ${rate} good  ` +
        `${String(Math.round(r.confidence * 100)).padStart(3)}% sure  score ${bonus}`);
      for (const nt of (r.notes ?? []).slice(0, 2)) if (nt.note) p(`       ${SYM.dot} ${nt.note}`);
    }
    p(`\n  score is the nudge added to the published benchmark, capped by defaults.experienceMaxShift\n`);
  },

  async link(a) {
    const { chmodSync, existsSync, mkdirSync, symlinkSync, unlinkSync, lstatSync } = fs;
    const launcher = path.join(ROOT, process.platform === "win32" ? "ocfleet.cmd" : "ocfleet");

    for (const f of [path.join(ROOT, "ocfleet"), path.join(ROOT, "bin", "ocfleet.mjs"), path.join(ROOT, "scripts", "install.sh")]) {
      try { if (existsSync(f)) chmodSync(f, 0o755); } catch {}
    }
    if (process.platform !== "win32") p(`  ${SYM.ok} made ${path.relative(ROOT, launcher)} and bin/ocfleet.mjs executable`);

    if (process.platform === "win32") {
      p(`\n  On Windows there is no symlink to make. Either add this folder to your PATH:`);
      p(`      $env:Path += ";${ROOT}"          # this session`);
      p(`      [Environment]::SetEnvironmentVariable("Path", $env:Path + ";${ROOT}", "User")`);
      p(`  or just call .\\ocfleet from here.\n`);
      return;
    }

    const dir = a.flags.dir ?? path.join(os.homedir(), ".local", "bin");
    const dest = path.join(dir, "ocfleet");
    try {
      mkdirSync(dir, { recursive: true });
      try { if (lstatSync(dest)) unlinkSync(dest); } catch {}
      symlinkSync(launcher, dest);
    } catch (e) {
      p(`\n  ${SYM.warn} could not link into ${dir}: ${e.message}`);
      p(`  run it from here instead: ${ROOT}/ocfleet\n`);
      return;
    }
    p(`  ${SYM.ok} linked ${dest} -> ${launcher}`);

    // A link nobody can reach is not an install. Say so instead of claiming success.
    const onPath = (process.env.PATH ?? "").split(":").includes(dir);
    if (onPath) {
      p(`\n  ready: ocfleet doctor\n`);
    } else {
      p(`\n  ${SYM.warn} ${dir} is not on your PATH. Add it, then open a new shell:`);
      p(`      echo 'export PATH="${dir}:$PATH"' >> ~/.bashrc\n`);
    }
  },

  async install(a) {
    const entry = path.join(ROOT, "bin", "ocfleet.mjs");
    const scope = a.flags.scope ?? "user";
    const { runSync, which, stateDir, ensureDir, readJson, writeJson } = await import("../src/util.mjs");

    // A GUI client inherits no shell PATH: nvm/volta node and opencode would be
    // invisible. Pin both to absolute paths at registration time.
    const nodeBin = process.execPath;
    const ocBin = which("opencode");
    const cfgJson = { mcpServers: { "opencode-fleet": { command: nodeBin, args: [entry, "mcp"] } } };

    const gitPath = which("git");
    if (ocBin || gitPath) {
      const target = path.join(ensureDir(stateDir()), "fleet.config.json");
      const current = readJson(target, {});
      let changed = false;
      if (ocBin && current.opencodeBin !== ocBin) {
        current.opencodeBin = ocBin; changed = true;
        p(`  ${SYM.ok} pinned opencodeBin ${SYM.arrow} ${ocBin}`);
      }
      // A GUI client may start the server without git on the PATH; pinning the
      // absolute path is what makes worktrees work there.
      if (gitPath && current.gitBin !== gitPath) {
        current.gitBin = gitPath; changed = true;
        p(`  ${SYM.ok} pinned gitBin ${SYM.arrow} ${gitPath}`);
      }
      if (changed) writeJson(target, current);
    }
    if (!ocBin) {
      p(`  ${SYM.warn} opencode binary not found - install it (npm i -g opencode-ai) before delegating`);
    }

    if (scope === "print") return jsonOut(cfgJson);

    if (which("claude")) {
      const r = runSync("claude", ["mcp", "add", "--scope", scope, "opencode-fleet", "--", nodeBin, entry, "mcp"]);
      p(r.ok ? `  ${SYM.ok} registered with Claude Code (scope: ${scope})` : `  ${SYM.fail} Claude Code registration failed: ${(r.stderr || r.error || "").trim()}`);
    } else {
      p(`  ${SYM.dot} claude CLI not found (npm i -g @anthropic-ai/claude-code to get it)`);
    }

    // `ocfleet` as a global command — nice to have, never required
    if (which("npm") && !which("ocfleet")) {
      const link = runSync("npm", ["link"], { cwd: ROOT });
      if (link.ok && which("ocfleet")) {
        p(`  ${SYM.ok} \`ocfleet\` is now available everywhere`);
      } else {
        p(`  ${SYM.dot} could not register the short command (that is fine)`);
        p(`    use ${process.platform === "win32" ? ".\\ocfleet <command>" : "./ocfleet <command>"} in this folder, or node ${path.join("bin", "ocfleet.mjs")} <command>`);
      }
    } else if (which("ocfleet")) {
      p(`  ${SYM.ok} \`ocfleet\` command available`);
    }

    p("\n  For the Claude desktop app, add this to its MCP config:\n");
    p(JSON.stringify(cfgJson, null, 2).split("\n").map((l) => "    " + l).join("\n"));
    const skillSrc = path.join(ROOT, "skills", "opencode-fleet");
    p(process.platform === "win32"
      ? `\n  Skill: Copy-Item -Recurse -Force "${skillSrc}" "$HOME\\.claude\\skills\\"\n`
      : `\n  Skill: cp -r ${skillSrc} ~/.claude/skills/\n`);
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
