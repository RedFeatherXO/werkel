import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, execFileSync } from "node:child_process";

export const HOME = os.homedir();

export function expandHome(p) {
  if (!p) return p;
  return p.startsWith("~") ? path.join(HOME, p.slice(1)) : p;
}

export function stateDir() {
  return expandHome(process.env.OPENCODE_FLEET_HOME || "~/.opencode-fleet");
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** Short, sortable, human-friendly job id: 20260831-153901-a4f2 */
export function newId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 6);
  return `${stamp}-${rand}`;
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout ?? "", stderr: stderr ?? "", error: err?.message });
    });
  });
}

export function runSync(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, { maxBuffer: 64 * 1024 * 1024, encoding: "utf8", ...opts });
    return { ok: true, stdout, stderr: "" };
  } catch (e) {
    return { ok: false, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "", error: e.message };
  }
}

export function which(bin) {
  const r = runSync(process.platform === "win32" ? "where" : "which", [bin]);
  return r.ok ? r.stdout.trim().split("\n")[0] : null;
}

export function truncate(str, max, note = "\n… [truncated]") {
  if (typeof str !== "string") str = String(str ?? "");
  return str.length <= max ? str : str.slice(0, max) + note;
}

export function humanDuration(ms) {
  if (ms == null) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

export function usd(n) {
  if (n == null || Number.isNaN(n)) return "?";
  if (n === 0) return "$0";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Deep merge b into a (objects only, arrays replaced). */
export function merge(a, b) {
  if (!b) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === "object" && !Array.isArray(v) && a?.[k] && typeof a[k] === "object" && !Array.isArray(a[k])) {
      out[k] = merge(a[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Glob-ish matcher supporting '*' only. Used for model allow/deny lists. */
export function globMatch(pattern, value) {
  const rx = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
  return rx.test(value);
}
