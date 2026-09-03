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

  // --- the model board travels with the push and merges across machines
  //
  // The point of the board is that it is complete from day one: every routable
  // model with the score it starts from, and an experience column that is zero
  // until something has actually run.
  const boardRow = (model, base, extra = {}) => ({
    model, base, prompt: 0.1, completion: 0.4, context: 200000, capability: base,
    capabilitySource: "artificial-analysis", profiles: ["cheap"],
    experience: 0, total: base, jobs: 0, goodRate: null, confidence: 0, notes: [], ...extra
  });

  await post("/api/ingest", { host: "meik-desktop", ts: Date.now(), jobs: [], models: [
    boardRow("openrouter/never/used", 70),
    // a slightly worse benchmark that the fleet's own evidence lifts past it
    boardRow("openrouter/z-ai/glm-5.3-flash", 68, {
      experience: 5.7, total: 73.7, jobs: 30, goodRate: 0.9, confidence: 0.71,
      notes: [{ at: Date.now(), source: "rated", note: "inverted a default" }] })
  ] });
  const bo = (await (await fetch(BASE + "/api/models")).json()).models;
  ok("serves every routable model, not only the used ones", bo.length === 2, `${bo.length} rows`);
  const unused = bo.find((r) => r.model === "openrouter/never/used");
  ok("an untouched model still has its benchmark score", unused.base === 70, String(unused.base));
  ok("and exactly no adjustment", unused.experience === 0 && unused.total === 70,
     `exp=${unused.experience} total=${unused.total}`);
  ok("the adjustment counts the moment it exists",
     bo[0].model === "openrouter/z-ai/glm-5.3-flash" && bo[0].total > unused.total,
     `${bo[0].model} ${bo[0].total} vs ${unused.total} — 68 + 5.7 must outrank a bare 70`);
  ok("keeps the note that explains the number", bo[0].notes?.[0]?.note === "inverted a default");

  await post("/api/ingest", { host: "laptop", ts: Date.now(), jobs: [], models: [
    boardRow("openrouter/z-ai/glm-5.3-flash", 68, {
      experience: 0.4, total: 68.4, jobs: 10, goodRate: 0.5, confidence: 0.55, notes: [] })
  ] });
  const merged = (await (await fetch(BASE + "/api/models")).json()).models;
  const glm = merged.find((r) => r.model === "openrouter/z-ai/glm-5.3-flash");
  ok("one model across two machines is one row", merged.length === 2, `${merged.length} rows`);
  ok("evidence adds up instead of being averaged", glm.jobs === 40, `jobs=${glm.jobs}`);
  // 0.9 over ~19.6 effective and 0.5 over ~9.8 must weight towards the busier host,
  // not land on the midpoint (0.7) that averaging two rates would give
  ok("the merged rate is weighted by evidence", glm.goodRate > 0.72 && glm.goodRate < 0.79,
     String(glm.goodRate));
  ok("both machines are named", (glm.hosts ?? []).length === 2, JSON.stringify(glm.hosts));

  // --- forget: deleting a job must survive the reporter's full-list pushes
  const fkey = "meik-desktop:20260831-2";
  ok("queues a forget from the browser",
     (await fetch(`${BASE}/api/jobs/${encodeURIComponent(fkey)}/forget`, { method: "POST" })).status === 202);
  const fList = await (await fetch(BASE + "/api/jobs")).json();
  ok("forgetting a job removes it from the list", !fList.jobs.some((j) => j.key === fkey), `${fList.jobs.length} jobs left`);

  const fPush = await (await post("/api/ingest", snapshot)).json();
  ok("hands the forget command to the next push", fPush.commands.length === 1 && fPush.commands[0].action === "forget",
     JSON.stringify(fPush.commands));
  ok("does not hand out the forget command twice", (await (await post("/api/ingest", snapshot)).json()).commands.length === 0);
  const fAfter = await (await fetch(BASE + "/api/jobs")).json();
  ok("a later push does not resurrect the forgotten job", !fAfter.jobs.some((j) => j.key === fkey), `${fAfter.jobs.length} jobs left`);

  const bResp = await post("/api/forget", { keys: ["meik-desktop:20260831-1", "meik-desktop:20260831-3", "meik-desktop:never-seen"] });
  const bBody = await bResp.json();
  ok("bulk forget forgets every known key and counts them",
     bResp.status === 200 && bBody.ok === true && bBody.forgotten === 2 && bBody.commands.length === 2, JSON.stringify(bBody));
  const bList = await (await fetch(BASE + "/api/jobs")).json();
  ok("bulk forget empties the list", bList.jobs.length === 0, `${bList.jobs.length} jobs left`);
  ok("rejects a bulk forget without a keys array", (await post("/api/forget", {})).status === 400);

  // a tombstone older than an hour must no longer block re-ingest: age the
  // saved tombstones past their TTL by rewriting the state file
  srv2.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 600));
  const st = JSON.parse(fs.readFileSync(path.join(DATA, "state.json"), "utf8"));
  const hourAgo = Date.now() - 2 * 60 * 60e3;
  for (const k of Object.keys(st.forgotten ?? {})) st.forgotten[k] = hourAgo;
  fs.writeFileSync(path.join(DATA, "state.json"), JSON.stringify(st));
  const srv3 = spawn(process.execPath, [path.join(HERE, "server.mjs")], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FLEET_INGEST_TOKEN: TOKEN, HOST: "127.0.0.1" }, stdio: "ignore"
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + "/healthz")).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  await post("/api/ingest", snapshot);
  const revived = await (await fetch(BASE + "/api/jobs")).json();
  ok("a tombstone older than an hour no longer blocks re-ingest", revived.jobs.length === 3, `${revived.jobs.length} jobs`);
  srv3.kill("SIGTERM");
} finally {
  srv.kill("SIGTERM");
}

console.log(fails.length ? `\n${fails.length} failing` : "\nall dashboard checks passed");
process.exit(fails.length ? 1 : 0);
