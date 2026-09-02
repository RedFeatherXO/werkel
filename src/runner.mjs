#!/usr/bin/env node
/**
 * Job runner. Started detached as its own node process, one per attempt.
 *
 * This used to be a generated shell script, which meant /bin/sh, POSIX quoting
 * and a `sleep`-based watchdog — none of which exist on Windows. Doing it in
 * node keeps one code path on every platform and removes quoting bugs entirely:
 * the command is passed as an argv array, never as a string.
 *
 * Contract with the caller (src/jobs.mjs):
 *   node runner.mjs <spec.json>
 * where spec.json is { bin, args, cwd, outDir, timeoutSec, env, stdinFile }
 * and the runner writes into outDir:
 *   events.ndjson  the worker's stdout
 *   stderr.log     the worker's stderr
 *   timeout        marker file, only if the watchdog fired
 *   exit           the exit code, always written last
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { killTree } from "./process.mjs";

const specFile = process.argv[2];
if (!specFile) {
  process.stderr.write("runner: missing spec file\n");
  process.exit(97);
}

let spec;
try {
  spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
} catch (e) {
  process.stderr.write(`runner: cannot read spec (${e.message})\n`);
  process.exit(97);
}

const outDir = spec.outDir;
fs.mkdirSync(outDir, { recursive: true });

const finish = (code) => {
  try { fs.writeFileSync(path.join(outDir, "exit"), String(code)); } catch {}
  process.exit(0);
};

if (!fs.existsSync(spec.cwd)) {
  try { fs.writeFileSync(path.join(outDir, "stderr.log"), `runner: working directory is gone: ${spec.cwd}\n`); } catch {}
  finish(97);
}

const out = fs.openSync(path.join(outDir, "events.ndjson"), "a");
const err = fs.openSync(path.join(outDir, "stderr.log"), "a");

// The work order goes in on stdin, not as an argument: Windows caps a command
// line at 32767 characters and a briefing can be far longer than that.
let stdin = "ignore";
if (spec.stdinFile) {
  try {
    stdin = fs.openSync(spec.stdinFile, "r");
  } catch (e) {
    try { fs.writeSync(err, `runner: cannot read stdin file ${spec.stdinFile}: ${e.message}\n`); } catch {}
    finish(97);
  }
}

let child;
try {
  child = spawn(spec.bin, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: [stdin, out, err],
    // own process group on POSIX, so the watchdog can take the whole tree down
    detached: process.platform !== "win32",
    windowsHide: true
  });
} catch (e) {
  try { fs.writeSync(err, `runner: could not start ${spec.bin}: ${e.message}\n`); } catch {}
  finish(97);
}

child.on("error", (e) => {
  try { fs.writeSync(err, `runner: ${spec.bin} failed to start: ${e.message}\n`); } catch {}
  finish(97);
});

const timeoutMs = Math.max(1, Number(spec.timeoutSec) || 1200) * 1000;
const watchdog = setTimeout(() => {
  try { fs.writeFileSync(path.join(outDir, "timeout"), "timeout\n"); } catch {}
  killTree(child.pid, "SIGTERM");
  setTimeout(() => killTree(child.pid, "SIGKILL"), 5000).unref();
}, timeoutMs);

child.on("close", (code, signal) => {
  clearTimeout(watchdog);
  finish(code == null ? (signal ? 143 : 1) : code);
});
