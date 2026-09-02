import path from "node:path";
import { stateDir, ensureDir, readJson, writeJson } from "./util.mjs";

/**
 * What the fleet has learned about model availability from its own runs.
 *
 * Free models on shared endpoints drop out regularly. The failover already
 * recovers from that, but without a memory every job pays the same price again:
 * one wasted attempt on a model that was already down a minute ago. This ledger
 * makes that knowledge survive the job.
 */
const FILE = () => path.join(ensureDir(stateDir()), "health.json");

const DEFAULT_COOLDOWN_MIN = 30;

export function load() {
  return readJson(FILE(), { models: {} });
}

function save(data) {
  writeJson(FILE(), data);
}

/** Record how a model behaved. `kind` is "ok" or "provider-error". */
export function record(model, kind, detail = null) {
  if (!model) return;
  const data = load();
  const e = data.models[model] ?? { ok: 0, fail: 0, lastOk: null, lastFail: null, lastError: null };
  if (kind === "ok") {
    e.ok += 1;
    e.lastOk = Date.now();
  } else {
    e.fail += 1;
    e.lastFail = Date.now();
    e.lastError = detail ? String(detail).slice(0, 200) : null;
  }
  data.models[model] = e;
  save(data);
  return e;
}

/**
 * Should this model be skipped right now? Only a *recent* provider failure
 * counts — a model that broke yesterday deserves another chance today.
 */
export function isCoolingDown(model, { cooldownMin = DEFAULT_COOLDOWN_MIN, now = Date.now(), data = null } = {}) {
  const e = (data ?? load()).models?.[model];
  if (!e?.lastFail) return false;
  if (e.lastOk && e.lastOk > e.lastFail) return false;   // it recovered since
  return now - e.lastFail < cooldownMin * 60_000;
}

/** Order candidates so recently broken ones go last, keeping relative order otherwise. */
export function preferHealthy(models, opts = {}) {
  const data = opts.data ?? load();
  const cold = (m) => (isCoolingDown(m, { ...opts, data }) ? 1 : 0);
  return [...models].sort((a, b) => cold(a) - cold(b) || models.indexOf(a) - models.indexOf(b));
}

/** Human-readable state, newest trouble first. */
export function summary({ cooldownMin = DEFAULT_COOLDOWN_MIN } = {}) {
  const data = load();
  return Object.entries(data.models ?? {})
    .map(([model, e]) => ({
      model, ok: e.ok, fail: e.fail,
      lastOk: e.lastOk, lastFail: e.lastFail, lastError: e.lastError,
      coolingDown: isCoolingDown(model, { cooldownMin, data })
    }))
    .sort((a, b) => (b.lastFail ?? 0) - (a.lastFail ?? 0));
}

export const COOLDOWN_MIN = DEFAULT_COOLDOWN_MIN;
