import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 7799, BASE = `http://127.0.0.1:${PORT}`, TOKEN = "test-token";
const DATA = "/tmp/fleet-dashboard-test";
fs.rmSync(DATA, { recursive: true, force: true });

const srv = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FLEET_INGEST_TOKEN: TOKEN, HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let out = "";
srv.stdout.on("data", (d) => (out += d));
srv.stderr.on("data", (d) => (out += d));

const fails = [];
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) fails.push(label);
};
const post = (p, body, token = TOKEN) => fetch(BASE + p, {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-fleet-token": token } : {}) },
  body: JSON.stringify(body ?? {})
});

for (let i = 0; i < 50; i++) {
  try { if ((await fetch(BASE + "/healthz")).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

try {
  const snapshot = {
    host: "meik-desktop", ts: Date.now(),
    jobs: [
      { jobId: "20260831-1", state: "running", title: "Refactor auth", model: "openrouter/z-ai/glm-5.3-flash",
        startedMs: Date.now() - 42000, branch: "fleet/1", repo: "/home/meik/proj", tools: "read×3" },
      { jobId: "20260831-2", state: "done", title: "Tests für Parser", model: "openrouter/qwen/qwen3-coder",
        startedMs: Date.now() - 300000, endedMs: Date.now() - 60000, durationMs: 240000, costUsd: 0.0152,
        branch: "fleet/2", report: "SUMMARY: fertig", diffstat: "test/x.mjs | 12 +++",
        changedFiles: [{ status: "A", path: "test/x.mjs" }] },
      { jobId: "20260831-3", state: "failed", title: "Kaputter Job", model: "opencode/glm-4.7",
        startedMs: Date.now() - 90000, durationMs: 30000, error: "provider overloaded",
        attempt: "2/3", previousAttempts: ["opencode/glm-4.7: provider — 503"] }
    ]
  };

  ok("rejects a push without the token", (await post("/api/ingest", snapshot, "")).status === 401);
  ok("rejects a push with a wrong token", (await post("/api/ingest", snapshot, "nope")).status === 401);

  const ing = await post("/api/ingest", snapshot);
  const ingBody = await ing.json();
  ok("accepts a valid push", ing.ok && ingBody.ok === true, `commands: ${ingBody.commands.length}`);

  const list = await (await fetch(BASE + "/api/jobs")).json();
  ok("serves the jobs back", list.jobs.length === 3, `${list.jobs.length} jobs`);
  ok("newest job first", list.jobs[0].jobId === "20260831-1", list.jobs[0].jobId);
  ok("knows the reporting host", !!list.hosts["meik-desktop"], JSON.stringify(list.hosts));

  const key = "meik-desktop:20260831-1";
  const q = await fetch(`${BASE}/api/jobs/${encodeURIComponent(key)}/cancel`, { method: "POST" });
  ok("queues a cancel from the browser", q.status === 202, String(q.status));

  const second = await (await post("/api/ingest", snapshot)).json();
  ok("hands the command to the next push", second.commands.length === 1 && second.commands[0].action === "cancel",
     JSON.stringify(second.commands));
  const third = await (await post("/api/ingest", snapshot)).json();
  ok("does not hand out the same command twice", third.commands.length === 0);

  const cmdId = second.commands[0].id;
  ok("accepts the command result", (await post(`/api/commands/${cmdId}/result`, { ok: true })).status === 200);
  const after = await (await fetch(BASE + "/api/jobs")).json();
  ok("records the result", after.commands.some((c) => c.id === cmdId && c.doneAt), "done marked");

  ok("rejects an unknown action", (await fetch(`${BASE}/api/jobs/${encodeURIComponent(key)}/explode`, { method: "POST" })).status === 400);
  ok("404s an unknown job", (await fetch(`${BASE}/api/jobs/nope%3A1`)).status === 404);

  const page = await (await fetch(BASE + "/")).text();
  ok("serves the page", page.includes("<title>Fleet</title>") && page.includes("EventSource"), `${page.length} bytes`);

  // restart with the same data dir: state must survive
  srv.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 600));
  const srv2 = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FLEET_INGEST_TOKEN: TOKEN, HOST: "127.0.0.1" }, stdio: "ignore"
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + "/healthz")).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const restored = await (await fetch(BASE + "/api/jobs")).json();
  ok("survives a restart", restored.jobs.length === 3, `${restored.jobs.length} jobs restored`);
  srv2.kill("SIGTERM");
} finally {
  srv.kill("SIGTERM");
}

console.log(fails.length ? `\n${fails.length} failing` : "\nall dashboard checks passed");
process.exit(fails.length ? 1 : 0);
