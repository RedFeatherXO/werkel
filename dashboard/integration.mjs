import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 7798, BASE = `http://127.0.0.1:${PORT}`, TOKEN = "integration-token";
const DATA = "/tmp/fleet-dash-integration";
const FLEET_HOME = "/tmp/fleet-home-integration";
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(FLEET_HOME, { recursive: true, force: true });

// a job store as the fleet would leave it behind
const jobId = "20260831-999999-abcd";
fs.mkdirSync(path.join(FLEET_HOME, "jobs", jobId), { recursive: true });
fs.writeFileSync(path.join(FLEET_HOME, "jobs", jobId, "job.json"), JSON.stringify({
  id: jobId, state: "done", title: "Integrationsjob", model: "openrouter/z-ai/glm-5.3-flash",
  dir: "/tmp/nowhere", sourceRepo: "/tmp/nowhere", worktree: { mode: "in-place", path: "/tmp/nowhere" },
  startedMs: Date.now() - 120000, endedMs: Date.now() - 60000, durationMs: 60000,
  costUsd: 0.0137, toolSummary: "read×5, write×2", report: "SUMMARY: erledigt.", jobDir: path.join(FLEET_HOME, "jobs", jobId)
}));

const srv = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FLEET_INGEST_TOKEN: TOKEN, HOST: "127.0.0.1" }, stdio: "ignore"
});
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(BASE + "/healthz")).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

const fails = [];
const ok = (l, c, e = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${e ? "  — " + e : ""}`); if (!c) fails.push(l); };

const runReporter = () => new Promise((resolve) => {
  const r = spawn(process.execPath, [path.join(ROOT, "bin/ocfleet.mjs"), "report", "--to", BASE, "--token", TOKEN, "--once"],
    { env: { ...process.env, OPENCODE_FLEET_HOME: FLEET_HOME }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; r.stdout.on("data", (d) => (out += d)); r.stderr.on("data", (d) => (out += d));
  r.on("close", (code) => resolve({ code, out }));
});

try {
  const first = await runReporter();
  ok("reporter runs and exits cleanly", first.code === 0, first.out.trim().split("\n").pop());

  const list = await (await fetch(BASE + "/api/jobs")).json();
  ok("the job arrived at the dashboard", list.jobs.length === 1, JSON.stringify(list.jobs.map((j) => j.title)));
  const j = list.jobs[0];
  ok("snapshot carries what the card needs", j.model && j.costUsd && j.report && j.host,
     `${j.model} ${j.costUsd} host=${j.host}`);
  ok("the heavy patch is not shipped", j.patch === undefined);

  // queue a cleanup in the browser, the next reporter cycle must pick it up
  await fetch(`${BASE}/api/jobs/${encodeURIComponent(j.key)}/cleanup`, { method: "POST" });
  const second = await runReporter();
  ok("reporter picks up the queued command", /executed 1 commands/.test(second.out), second.out.trim().split("\n").pop());
  const after = await (await fetch(BASE + "/api/jobs")).json();
  const cmd = after.commands.at(-1);
  ok("command result is reported back", cmd?.doneAt != null, `ok=${cmd?.ok} error=${cmd?.error ?? "none"}`);
} finally {
  srv.kill("SIGTERM");
}
console.log(fails.length ? `\n${fails.length} failing` : "\nreporter and dashboard work together");
process.exit(fails.length ? 1 : 0);
