import fs from "node:fs";
import path from "node:path";
import { which, run, stateDir, readJson, humanDuration } from "./util.mjs";
import { loadConfig } from "./config.mjs";
import { installedModels, installedModelsSmart, openrouterCatalog, budgetCheck, spentToday } from "./models.mjs";
import { listJobIds, readJob, refreshAll } from "./jobs.mjs";

export async function doctor({ repo = process.cwd(), warmup = false } = {}) {
  const cfg = loadConfig(repo);
  const out = { ok: true, problems: [], warnings: [], info: {} };
  const fail = (m, fix) => { out.ok = false; out.problems.push(fix ? `${m} → ${fix}` : m); };
  const warn = (m) => out.warnings.push(m);

  // 1. binaries
  const bin = which(cfg.opencodeBin);
  out.info.opencode = bin ?? "NOT FOUND";
  if (!bin) fail(`opencode binary "${cfg.opencodeBin}" not found`, "npm i -g opencode-ai");
  else {
    const v = await run(cfg.opencodeBin, ["--version"], { timeout: 20000 });
    out.info.opencodeVersion = v.stdout.trim() || "?";
  }
  out.info.git = which("git") ?? "NOT FOUND";
  if (!which("git")) fail("git not found", "install git — worktree isolation needs it");
  out.info.node = process.version;

  // 2. config
  out.info.configSources = cfg._sources?.length ? cfg._sources : ["built-in defaults only"];
  out.info.stateDir = stateDir();
  out.info.budget = cfg.budget;

  // 3. models
  let installed = [];
  if (bin) {
    installed = await installedModelsSmart(cfg, { bin: cfg.opencodeBin, cwd: repo, refresh: true });
    out.info.installedModelCount = installed.length;
    if (!installed.length) fail("opencode reports no models", "run: opencode auth login (pick openrouter / zai / deepseek)");
  }
  let orCatalog = {};
  try { orCatalog = await openrouterCatalog(); out.info.openrouterCatalogue = Object.keys(orCatalog).length + " models"; }
  catch (e) { warn(`OpenRouter price catalogue unavailable: ${e.message} — prices for openrouter/* cannot be checked`); }

  const known = new Set(installed);
  out.info.profiles = {};
  for (const [name, prof] of Object.entries(cfg.profiles ?? {})) {
    const rows = (prof.candidates ?? []).map((c) => {
      const present = known.has(c);
      const chk = budgetCheck(c, cfg, orCatalog, {});
      return { model: c, available: present, allowed: chk.allowed, reason: present ? (chk.allowed ? "ok" : chk.reason) : "provider not configured" };
    });
    const usable = rows.find((r) => r.available && r.allowed);
    out.info.profiles[name] = { usable: usable?.model ?? null, candidates: rows };
    if (!usable) warn(`profile "${name}" has no usable model — configure a provider or adjust budget/candidates`);
  }
  if (!Object.values(out.info.profiles).some((p) => p.usable)) {
    fail("no profile can route anywhere", "opencode auth login, then `ocfleet models` to see what is allowed");
  }

  // 4. spend
  const spend = spentToday();
  out.info.spentTodayUsd = Number((spend.total ?? 0).toFixed(4));
  out.info.dailyLimitUsd = cfg.budget.maxDailyUsd;
  if (cfg.budget.maxDailyUsd && spend.total >= cfg.budget.maxDailyUsd) fail("daily budget exhausted", "raise budget.maxDailyUsd or wait for tomorrow");

  // 5. jobs
  const jobs = await refreshAll();
  const running = jobs.filter((j) => j.state === "running");
  out.info.jobs = { total: jobs.length, running: running.length,
    stale: running.filter((j) => Date.now() - j.startedMs > (j.timeoutSec + 120) * 1000).map((j) => j.id) };
  if (out.info.jobs.stale.length) warn(`stale jobs past their timeout: ${out.info.jobs.stale.join(", ")} — fleet_cancel them`);

  // 6. warm up provider packages (first real run downloads npm packages and can look like a hang)
  if (warmup && bin) {
    const model = Object.values(out.info.profiles).map((p) => p.usable).find(Boolean);
    if (model) {
      const t0 = Date.now();
      const r = await run(cfg.opencodeBin, ["run", "--format", "json", "--model", model, "reply with the single word: ready"], { timeout: 240000, cwd: repo });
      out.info.warmup = { model, duration: humanDuration(Date.now() - t0), ok: r.ok, output: (r.stdout || r.stderr).slice(-300) };
      if (!r.ok) warn("warmup run failed — check credentials for " + model);
    } else out.info.warmup = "skipped, no usable model";
  }

  if (out.ok && !out.warnings.length) out.summary = "fleet ready";
  else out.summary = `${out.problems.length} problem(s), ${out.warnings.length} warning(s)`;
  return out;
}
