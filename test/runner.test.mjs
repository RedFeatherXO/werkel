import { test } from "node:test";
import { strict as assert } from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { killCommandFor, isAlive } from "../src/process.mjs";
import { rankExecutables, standardBinDirs, whichDeep } from "../src/util.mjs";

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "runner.mjs");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "werkel-runner-"));
}

/** Run the runner against a spec and wait for it to write the exit file. */
function runSpec(spec, { waitMs = 15000 } = {}) {
  const dir = spec.outDir;
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec));
  const child = spawn(process.execPath, [RUNNER, path.join(dir, "spec.json")], { stdio: "ignore" });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + waitMs;
    const poll = setInterval(() => {
      const exitFile = path.join(dir, "exit");
      if (fs.existsSync(exitFile)) {
        clearInterval(poll);
        resolve({
          code: Number(fs.readFileSync(exitFile, "utf8").trim()),
          timedOut: fs.existsSync(path.join(dir, "timeout")),
          out: fs.existsSync(path.join(dir, "events.ndjson")) ? fs.readFileSync(path.join(dir, "events.ndjson"), "utf8") : "",
          err: fs.existsSync(path.join(dir, "stderr.log")) ? fs.readFileSync(path.join(dir, "stderr.log"), "utf8") : ""
        });
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        try { child.kill(); } catch {}
        reject(new Error("runner never wrote an exit file"));
      }
    }, 100);
  });
}

test("captures stdout and the exit code of a successful job", async () => {
  const dir = tmp();
  const r = await runSpec({
    bin: process.execPath, args: ["-e", "process.stdout.write('hello\\n')"],
    cwd: dir, outDir: dir, timeoutSec: 30
  });
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  assert.match(r.out, /hello/);
});

test("reports a non-zero exit code and keeps stderr", async () => {
  const dir = tmp();
  const r = await runSpec({
    bin: process.execPath, args: ["-e", "process.stderr.write('boom\\n'); process.exit(3)"],
    cwd: dir, outDir: dir, timeoutSec: 30
  });
  assert.equal(r.code, 3);
  assert.match(r.err, /boom/);
});

test("the watchdog kills a hanging job and marks it as a timeout", async () => {
  const dir = tmp();
  const started = Date.now();
  const r = await runSpec({
    bin: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],   // never exits
    cwd: dir, outDir: dir, timeoutSec: 2
  });
  assert.equal(r.timedOut, true, "timeout marker must exist");
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - started < 14000, "must not wait far beyond the timeout");
});

test("a missing binary fails fast instead of hanging", async () => {
  const dir = tmp();
  const r = await runSpec({
    bin: path.join(dir, "definitely-not-here"), args: [], cwd: dir, outDir: dir, timeoutSec: 30
  });
  assert.equal(r.code, 97);
  assert.match(r.err, /could not start|failed to start/i);
});

test("a vanished working directory is reported, not ignored", async () => {
  const dir = tmp();
  const r = await runSpec({
    bin: process.execPath, args: ["-e", "0"], cwd: path.join(dir, "gone"), outDir: dir, timeoutSec: 30
  });
  assert.equal(r.code, 97);
  assert.match(r.err, /working directory is gone/);
});

test("arguments survive spaces and quotes — no shell in the way", async () => {
  const dir = tmp();
  const nasty = `a b "c" 'd' \\e$f;g`;
  const r = await runSpec({
    bin: process.execPath, args: ["-e", "process.stdout.write(process.argv[1])", nasty],
    cwd: dir, outDir: dir, timeoutSec: 30
  });
  assert.equal(r.code, 0);
  assert.equal(r.out, nasty);
});

test("environment overrides reach the child (read-only jobs rely on this)", async () => {
  const dir = tmp();
  const r = await runSpec({
    bin: process.execPath, args: ["-e", "process.stdout.write(process.env.OPENCODE_CONFIG_CONTENT || 'unset')"],
    cwd: dir, outDir: dir, timeoutSec: 30, env: { OPENCODE_CONFIG_CONTENT: '{"permission":{"edit":"deny"}}' }
  });
  assert.match(r.out, /"edit":"deny"/);
});

test("stdin reaches the child, and survives being longer than a Windows command line", async () => {
  const dir = tmp();
  // 40k characters: past the 32767-character limit a Windows command line has,
  // which is why the work order travels on stdin instead of in argv
  const long = "x".repeat(40000);
  fs.writeFileSync(path.join(dir, "prompt.md"), long);
  const r = await runSpec({
    bin: process.execPath,
    args: ["-e", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(String(d.length)))"],
    cwd: dir, outDir: dir, timeoutSec: 30, stdinFile: path.join(dir, "prompt.md")
  });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), "40000");
});

test("a missing stdin file is an error, not a silent empty prompt", async () => {
  const dir = tmp();
  const r = await runSpec({
    bin: process.execPath, args: ["-e", "0"], cwd: dir, outDir: dir, timeoutSec: 30,
    stdinFile: path.join(dir, "not-there.md")
  });
  assert.equal(r.code, 97);
  assert.match(r.err, /cannot read stdin file/);
});

// --- platform branches, checkable from any OS

test("kill command differs per platform, and is right on both", () => {
  assert.deepEqual(killCommandFor("win32", 4321),
    { command: "taskkill", args: ["/PID", "4321", "/T", "/F"] });
  assert.deepEqual(killCommandFor("linux", 4321),
    { command: "kill", args: ["-TERM", "-4321"] });
  assert.deepEqual(killCommandFor("darwin", 99), { command: "kill", args: ["-TERM", "-99"] });
});

test("windows: a real .exe outranks npm's shims", () => {
  // exactly what `where opencode` printed on a Windows machine
  const hits = [
    "C:\\Users\\klein\\AppData\\Roaming\\npm\\opencode",
    "C:\\Users\\klein\\AppData\\Roaming\\npm\\opencode.cmd",
    "C:\\Users\\klein\\AppData\\Roaming\\npm\\opencode.ps1",
    "C:\\Users\\klein\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe"
  ];
  const ranked = rankExecutables("win32", hits);
  assert.ok(ranked[0].endsWith(".exe"), `expected the .exe first, got ${ranked[0]}`);
  // the extension-less shim is a shell script; it must never be chosen over a real program
  assert.ok(ranked.indexOf(hits[0]) > ranked.indexOf(hits[1]), "extension-less shim must rank below .cmd");
});

test("windows: .cmd beats .ps1 and the bare shim when nothing better exists", () => {
  const ranked = rankExecutables("win32", ["C:\\x\\tool", "C:\\x\\tool.ps1", "C:\\x\\tool.cmd"]);
  assert.ok(ranked[0].endsWith(".cmd"), ranked[0]);
});

test("non-windows ordering is left alone", () => {
  const paths = ["/usr/local/bin/opencode", "/usr/bin/opencode"];
  assert.deepEqual(rankExecutables("linux", paths), paths);
  assert.deepEqual(rankExecutables("darwin", paths), paths);
});

test("windows: the standard locations include git, node and npm globals", () => {
  // A desktop app starts this server with a stripped PATH. If these are missing,
  // git "disappears" on a machine where the shell finds it fine.
  const dirs = standardBinDirs("win32", {
    USERPROFILE: "C:\\Users\\someone",
    APPDATA: "C:\\Users\\someone\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local",
    ProgramFiles: "C:\\Program Files"
  }).map((d) => d.toLowerCase());
  const has = (needle) => dirs.some((d) => d.includes(needle));
  assert.ok(has("git\\cmd"), "Git for Windows install path missing");
  assert.ok(has("nodejs"), "node install path missing");
  assert.ok(has("npm"), "npm global path missing");
  assert.ok(has("scoop") && has("chocolatey"), "scoop/chocolatey paths missing");
});

test("binaries are findable without consulting PATH", () => {
  // whichDeep never looks at PATH — this is what saves a GUI-launched server
  assert.ok(whichDeep("git"), "git should be found in a standard location");
});

test("isAlive says yes for this process and no for a free pid", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(0), false);
});
