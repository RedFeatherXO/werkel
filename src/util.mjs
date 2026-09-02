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
  if (bin && (bin.includes("/") || bin.includes("\\"))) {
    if (isRunnable(bin)) return bin;
    // A pinned path may be npm's extension-less shim. Look for the real binary
    // next to it *before* falling back to .cmd — node cannot spawn .cmd without
    // a shell, and on a Windows machine the PATH may hold no .exe at all.
    const real = siblingBinary(bin);
    if (real) return real;
    for (const ext of WIN_EXTS) if (ext && fs.existsSync(bin + ext)) return bin + ext;
    return fs.existsSync(bin) ? bin : null;
  }
  const r = runSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: ["ignore", "pipe", "ignore"] });
  const hits = r.ok ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  const best = pickBest(hits);
  if (best) return best;
  const deep = whichDeep(bin);
  if (deep) return deep;
  // last resort: an unusable hit is still better information than nothing
  return hits[0] ?? null;
}

/**
 * `where opencode` on Windows lists three files npm wrote: an extension-less
 * shell script (for Git Bash), a .cmd and a .ps1. Node can start none of them
 * directly — the first is not a program, and .cmd needs a shell since 18.20.
 * Rank by what actually runs, and prefer a real .exe over any of them.
 */
export function pickBest(paths) {
  if (!paths?.length) return null;
  if (process.platform !== "win32") return paths[0];
  const withSiblings = [];
  for (const p of paths) {
    withSiblings.push(p);
    const sib = siblingBinary(p);
    if (sib && !paths.includes(sib)) withSiblings.push(sib);
  }
  const existing = withSiblings.filter((p) => fs.existsSync(p));
  return rankExecutables("win32", existing.length ? existing : withSiblings)[0] ?? null;
}

/**
 * Order candidates by how well node can actually start them. Pure and
 * platform-parameterised, so the Windows ordering is testable from Linux —
 * this is exactly the logic that cannot be exercised on the machine that
 * writes it.
 */
export function rankExecutables(platform, paths) {
  const list = (paths ?? []).filter(Boolean);
  if (platform !== "win32") return [...list];
  const rank = (p) => {
    const ext = (p.match(/\.[^.\\/]+$/) ?? [""])[0].toLowerCase();
    if (ext === ".exe") return 0;   // a real program: spawn starts it directly
    if (ext === ".com") return 1;
    if (ext === ".cmd") return 3;   // needs a shell since node 18.20
    if (ext === ".bat") return 3;
    if (ext === ".ps1") return 4;   // needs powershell
    return 5;                       // extension-less npm shim: a shell script
  };
  return [...list].sort((a, b) => rank(a) - rank(b) || list.indexOf(a) - list.indexOf(b));
}

/** npm shims live next to node_modules/<pkg>/bin/<name>.exe — find that. */
function siblingBinary(shimPath) {
  if (process.platform !== "win32") return null;
  const dir = path.dirname(shimPath);
  const name = path.basename(shimPath, path.extname(shimPath));
  const candidates = [];
  try {
    const modules = path.join(dir, "node_modules");
    for (const pkg of fs.existsSync(modules) ? fs.readdirSync(modules) : []) {
      if (!pkg.includes(name.split("-")[0])) continue;
      candidates.push(path.join(modules, pkg, "bin", name + ".exe"));
      candidates.push(path.join(modules, pkg, "bin", name));
    }
  } catch {}
  return candidates.find((c) => c.toLowerCase().endsWith(".exe") && fs.existsSync(c)) ?? null;
}

/** Can node spawn this path as a program? */
function isRunnable(p) {
  if (!fs.existsSync(p)) return false;
  if (process.platform !== "win32") return true;
  const ext = path.extname(p).toLowerCase();
  return ext === ".exe" || ext === ".com";
}

// On Windows a "binary" is usually a .cmd shim written by npm.
// .exe first on purpose: npm also writes a .cmd shim, and node refuses to spawn
// .cmd without a shell — which would put argument quoting back in play.
const WIN_EXTS = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];

/**
 * A GUI client (Claude desktop) starts without the shell PATH, so nvm/volta/nodenv
 * installs are invisible to plain `which`. Look where they actually live before
 * declaring a binary missing.
 */
export function whichDeep(bin) {
  const dirs = standardBinDirs(process.platform);
  for (const d of dirs) {
    for (const ext of WIN_EXTS) {
      const f = path.join(d, bin + ext);
      try {
        if (!fs.existsSync(f)) continue;
        if (process.platform === "win32" || (fs.statSync(f).mode & 0o111)) return f;
      } catch {}
    }
  }
  return null;
}

/**
 * Where programs live when there is no usable PATH — which is the normal case
 * for a server started by a desktop app. Pure and platform-parameterised so the
 * Windows list can be checked from any machine.
 */
export function standardBinDirs(platform = process.platform, env = process.env) {
  // join with the *target* platform's separator, not the running one, so the
  // Windows list is correct even when it is built (or tested) on Linux
  const j = platform === "win32" ? path.win32.join : path.posix.join;
  const home = env.HOME || env.USERPROFILE || HOME;
  const dirs = [];
  if (platform === "win32") {
    const appdata = env.APPDATA || j(home, "AppData", "Roaming");
    const local = env.LOCALAPPDATA || j(home, "AppData", "Local");
    const pf = env.ProgramW6432 || env.ProgramFiles || "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    dirs.push(
      j(appdata, "npm"),                       // npm -g (shims)
      j(appdata, "npm", "node_modules", "opencode-ai", "bin"),  // the real binary
      j(local, "Programs", "opencode"),
      j(home, "scoop", "shims"),               // scoop
      j(env.ProgramData || "C:\\ProgramData", "chocolatey", "bin"),
      j(home, ".bun", "bin"),
      j(home, ".volta", "bin"),
      // A GUI client starts this server with a stripped PATH, so the standard
      // install locations have to be searched explicitly — otherwise git and
      // node look "missing" on a machine where the shell finds them fine.
      j(pf, "Git", "cmd"),
      j(pf, "Git", "bin"),
      j(pf86, "Git", "cmd"),
      j(local, "Programs", "Git", "cmd"),
      j(pf, "nodejs"),
      j(pf86, "nodejs")
    );
    // nvm for Windows keeps one directory per version
    for (const base of [env.NVM_HOME, j(appdata, "nvm")].filter(Boolean)) {
      try { for (const v of fs.readdirSync(base).sort().reverse()) dirs.push(j(base, v)); } catch {}
    }
  } else {
    dirs.push(
      "/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", "/snap/bin",
      j(home, ".npm-global/bin"), j(home, ".local/bin"),
      j(home, ".bun/bin"), j(home, ".volta/bin"),
      j(home, "bin")
    );
    for (const base of [j(home, ".nvm/versions/node"), j(home, ".nodenv/versions"), j(home, ".asdf/installs/nodejs")]) {
      try { for (const v of fs.readdirSync(base).sort().reverse()) dirs.push(j(base, v, "bin")); } catch {}
    }
  }
  return dirs;
}

/** Absolute path to the opencode binary, so jobs work no matter who spawned us. */
export function resolveBin(cfg) {
  const configured = cfg?.opencodeBin ?? "opencode";
  return which(configured) ?? configured;
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

/**
 * Console symbols. The classic Windows console (cmd.exe, code page 850) turns
 * "✓" into mojibake, so plain ASCII is used there. Nobody loses information —
 * only decoration.
 */
export const SYM = process.platform === "win32"
  ? { ok: "[ok]", warn: "[!]", fail: "[x]", skip: "[-]", arrow: "->", dot: "*",
      run: ">", done: "[ok]", failed: "[x]", timeout: "[t]", cancelled: "[-]", retry: "^", le: "<=" }
  : { ok: "✓", warn: "⚠", fail: "✗", skip: "·", arrow: "→", dot: "·",
      run: "▶", done: "✓", failed: "✗", timeout: "⏱", cancelled: "⊘", retry: "↻", le: "≤" };

let gitPathCache = null;
/**
 * Absolute path to git. Resolved once and remembered: a GUI-launched server
 * often has no PATH worth speaking of, and every worktree operation depends on
 * finding git anyway.
 */
export function gitBin(cfg) {
  if (cfg?.gitBin) {
    const pinned = which(cfg.gitBin);
    if (pinned) return pinned;
  }
  if (gitPathCache) return gitPathCache;
  gitPathCache = which("git") ?? "git";
  return gitPathCache;
}
