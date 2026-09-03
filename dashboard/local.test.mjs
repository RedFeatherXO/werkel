/**
 * The local dashboard: one process, no external server, no token to configure.
 * Started the way a user starts it — through the CLI — and then queried like a
 * browser would.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 7796;
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = path.join(os.tmpdir(), "fleet-local-dash-home");

fs.rmSync(HOME, { recursive: true, force: true });
const jobId = "20260902-120000-loc1";
fs.mkdirSync(path.join(HOME, "jobs", jobId), { recursive: true });
fs.writeFileSync(path.join(HOME, "jobs", jobId, "job.json"), JSON.stringify({
  id: jobId, state: "done", title: "Lokaler Testjob", model: "openrouter/z-ai/glm-5.3-flash",
  dir: os.tmpdir(), sourceRepo: os.tmpdir(), worktree: { mode: "in-place", path: os.tmpdir() },
  startedMs: Date.now() - 60000, endedMs: Date.now() - 30000, durationMs: 30000,
  costUsd: 0.004, toolSummary: "read×2", report: "SUMMARY: lief lokal durch.",
  jobDir: path.join(HOME, "jobs", jobId)
}));

const fails = [];
const ok = (l, c, e = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${e ? "  — " + e : ""}`); if (!c) fails.push(l); };

const cli = spawn(process.execPath, [path.join(ROOT, "bin/ocfleet.mjs"), "dashboard",
  "--port", String(PORT), "--interval", "1"],
  { env: { ...process.env, OPENCODE_FLEET_HOME: HOME }, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
cli.stdout.on("data", (d) => (out += d));
cli.stderr.on("data", (d) => (out += d));

const until = async (fn, ms = 20000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return true; } catch {}
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
};

try {
  ok("starts and serves the page", await until(async () => (await fetch(BASE)).ok), out.trim().split("\n")[1] ?? "");

  const gotJob = await until(async () => {
    const b = await (await fetch(BASE + "/api/jobs")).json();
    return b.jobs?.length === 1;
  });
  ok("picks up local jobs without any push setup", gotJob);

  const body = await (await fetch(BASE + "/api/jobs")).json();
  const j = body.jobs?.[0];
  ok("the job carries what a card needs", j?.title === "Lokaler Testjob" && j?.costUsd === 0.004,
     `${j?.title} / ${j?.model}`);
  ok("it knows which machine reported", Object.keys(body.hosts ?? {}).length === 1, JSON.stringify(Object.keys(body.hosts ?? {})));

  // ingest stays protected even on loopback: no token, no write
  const spoof = await fetch(BASE + "/api/ingest", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ host: "attacker", jobs: [{ jobId: "fake", state: "running", title: "injected" }] })
  });
  ok("an unauthenticated push is refused", spoof.status === 401, String(spoof.status));

  const after = await (await fetch(BASE + "/api/jobs")).json();
  ok("nothing was injected", !after.jobs.some((x) => x.jobId === "fake"));

  ok("prints the url for the user", /http:\/\/127\.0\.0\.1:7796/.test(out), out.match(/dashboard\s+(\S+)/)?.[1] ?? "");
  // Somebody who starts this and then also runs `ocfleet report` at it gets a 401,
  // because this command mints its own private token — so it has to say, right
  // here, that no second command is wanted.
  ok("says it is already reporting, so nobody starts a second reporter",
     /no second command/i.test(out), out.split("\n").find((l) => /source/.test(l))?.trim() ?? "");
} finally {
  cli.kill("SIGINT");
  await new Promise((r) => setTimeout(r, 800));
  cli.kill("SIGKILL");
}

console.log(fails.length ? `\n${fails.length} failing` : "\nlocal dashboard works standalone");
process.exit(fails.length ? 1 : 0);
