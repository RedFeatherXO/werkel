import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = process.argv[2] || "/tmp/demo";
// fresh repo per run so results are not polluted by earlier merges
import { execFileSync } from "node:child_process";
import fs from "node:fs";
fs.rmSync(REPO, { recursive: true, force: true });
fs.mkdirSync(REPO + "/src", { recursive: true });
const g = (...a) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8" });
g("init", "-q"); g("config", "user.email", "t@t.de"); g("config", "user.name", "test");
fs.writeFileSync(REPO + "/src/greet.js", 'export function greet(name) {\n  return "Hello, " + name + "!";\n}\n');
fs.writeFileSync(REPO + "/src/a.js", "export const a = 0;\n");
fs.writeFileSync(REPO + "/src/b.js", "export const b = 0;\n");
fs.writeFileSync(REPO + "/opencode.json", JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  provider: { mock: { npm: "@ai-sdk/openai-compatible", name: "Mock",
    options: { baseURL: "http://127.0.0.1:8099/v1", apiKey: "sk-mock" },
    models: {
      "mock-coder": { name: "Mock Coder" },
      "mock-broken": { name: "Mock Coder (always 503)" },
      "mock-flaky": { name: "Mock Coder (fails once)" }
    } } }
}, null, 2));
g("add", "-A"); g("commit", "-qm", "init");

// The suite must never touch the user's fleet config or spend real money:
// its own state dir, its own profiles, and an explicit mock model everywhere.
const TEST_HOME = path.join(os.tmpdir(), "opencode-fleet-teststate");
{
  const fsx = await import("node:fs");
  fsx.rmSync(TEST_HOME, { recursive: true, force: true });
  fsx.mkdirSync(TEST_HOME, { recursive: true });
  fsx.writeFileSync(path.join(TEST_HOME, "fleet.config.json"), JSON.stringify({
    budget: { allow: ["mock/*"], maxDailyUsd: 100 },
    staticPricing: {
      "mock/mock-coder": { prompt: 0.05, completion: 0.2, context: 200000, tools: true },
      "mock/mock-broken": { prompt: 0.05, completion: 0.2, context: 200000, tools: true },
      "mock/mock-flaky": { prompt: 0.05, completion: 0.2, context: 200000, tools: true }
    },
    profiles: {
      cheap: { description: "test", candidates: ["mock/mock-coder"] },
      balanced: { description: "test", candidates: ["mock/mock-coder"] },
      // first candidate always answers 503 — the fleet must move on by itself
      failovertest: { description: "test", candidates: ["mock/mock-broken", "mock/mock-coder"] }
    }
  }, null, 2));
}
const TEST_ENV = { ...process.env, OPENCODE_FLEET_HOME: TEST_HOME };

// start the mock model server ourselves so the suite is self-contained
const MOCK_LOG = path.join(TEST_HOME, "mock.log");
const mockLogFd = (await import("node:fs")).openSync(MOCK_LOG, "a");
const mock = spawn("python3", [path.join(ROOT, "test/mock_llm.py")], {
  stdio: ["ignore", mockLogFd, mockLogFd], detached: false
});
const showMockLog = async (label) => {
  try {
    const txt = (await import("node:fs")).readFileSync(MOCK_LOG, "utf8").trim();
    if (txt) console.log(`      [mock ${label}] ${txt.split("\n").slice(-8).join("\n      ")}`);
  } catch {}
};
const upBy = Date.now() + 15000;
for (;;) {
  try { const r = await fetch("http://127.0.0.1:8099/v1/models"); if (r.ok) break; } catch {}
  if (Date.now() > upBy) {
    console.error("mock model server did not start (port 8099 in use?)");
    await showMockLog("startup");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 300));
}
// answering /v1/models is not proof it can complete a chat response
{
  const probe = await fetch("http://127.0.0.1:8099/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mock-coder", stream: true, messages: [{ role: "user", content: "ping" }] })
  });
  const text = await probe.text();
  if (!probe.ok || !text.includes("data: [DONE]")) {
    console.error("mock model server answers but cannot complete a chat stream:", probe.status, text.slice(0, 300));
    await showMockLog("probe");
    try { mock.kill(); } catch {}
    process.exit(1);
  }
}

const shutdown = () => { try { mock.kill(); } catch {} };
process.on("exit", shutdown); process.on("SIGINT", () => { shutdown(); process.exit(1); });

const srv = spawn("node", [path.join(ROOT, "bin/ocfleet.mjs"), "mcp"], { stdio: ["pipe", "pipe", "pipe"], env: TEST_ENV });
let buf = "", waiters = new Map(), nextId = 1;
srv.stdout.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    waiters.get(msg.id)?.(msg); waiters.delete(msg.id);
  }
});
srv.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const rpc = (method, params) => new Promise((res) => {
  const id = nextId++;
  waiters.set(id, res);
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const txt = r.result?.content?.[0]?.text ?? "";
  try { return JSON.parse(txt); } catch { return txt; }
};

const ok = (label, cond, extra = "") => console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);

/** A failed job is useless without its stderr — show it right here. */
async function explainFailure(jobId) {
  if (!jobId) return;
  const fsx = await import("node:fs");
  const dir = path.join(TEST_HOME, "jobs", jobId);
  for (const f of ["stderr.log", "events.ndjson"]) {
    try {
      const txt = fsx.readFileSync(path.join(dir, f), "utf8").trim();
      if (txt) console.log(`      [${f}] ${txt.split("\n").slice(-6).join("\n      ")}`);
    } catch {}
  }
  try {
    const meta = JSON.parse(fsx.readFileSync(path.join(dir, "job.json"), "utf8"));
    console.log(`      [job] state=${meta.state} exit=${meta.exitCode} model=${meta.model} error=${(meta.error || "").slice(0, 300)}`);
  } catch {}
}

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
ok("initialize", init.result?.serverInfo?.name === "opencode-fleet", init.result?.serverInfo?.version);
srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const tools = await rpc("tools/list", {});
ok("tools/list", tools.result?.tools?.length >= 12, tools.result.tools.map(t=>t.name).join(","));
ok("schemas valid", tools.result.tools.every(t => t.inputSchema?.type === "object" && t.description?.length > 40));

const doc = await call("fleet_doctor", { repo: REPO });
ok("fleet_doctor", doc.ok === true || doc.problems?.length === 0, doc.summary);

const models = await call("fleet_models", { repo: REPO });
ok("fleet_models", Array.isArray(models.allowed) && models.allowed.length > 0, `${models.allowed?.length} allowed`);

// budget guard must refuse a premium model
const blocked = await call("fleet_delegate", { task: "x", repo: REPO, model: "openrouter/anthropic/claude-sonnet-5" });
ok("budget guard blocks premium", !!blocked.error, blocked.error?.slice(0, 70));

// unknown model must not hang
const unknown = await call("fleet_delegate", { task: "x", repo: REPO, model: "openrouter/nope/nope" });
ok("unknown model refused", !!unknown.error, unknown.error?.slice(0, 60));

// First contact with a provider makes opencode fetch its npm package, which can
// take minutes. Do that once, slowly, before timing anything else — in a scratch
// directory and read-only, so the test repo stays pristine for the apply tests.
const WARM_DIR = path.join(os.tmpdir(), "opencode-fleet-warmup");
{
  const fsx = await import("node:fs");
  fsx.rmSync(WARM_DIR, { recursive: true, force: true });
  fsx.mkdirSync(WARM_DIR, { recursive: true });
  fsx.copyFileSync(path.join(REPO, "opencode.json"), path.join(WARM_DIR, "opencode.json"));
}
const warm = await call("fleet_delegate", { task: "Antworte nur mit: bereit.", repo: WARM_DIR,
  model: "mock/mock-coder", title: "warmup", timeoutSec: 420, worktree: false, readOnly: true });
const warmDone = await call("fleet_wait", { jobIds: [warm.jobId], timeoutSec: 420 });
const warmState = warmDone.done?.[0]?.state;
ok("mock provider starts", warmState === "done", warmState ?? "no result");
if (warmState !== "done") {
  await explainFailure(warm.jobId);
  await showMockLog("warmup");
  console.log("\n  The mock provider could not run — everything below would fail for that reason.");
  console.log("  Usually: opencode is still installing @ai-sdk/openai-compatible, or port 8099 is taken.\n");
  srv.kill(); shutdown();
  process.exit(1);
}

// two parallel jobs, isolated worktrees
const a = await call("fleet_delegate", { task: "Job A: edit TARGET=src/a.js with CONTENT=export const a = 1;", repo: REPO, model: "mock/mock-coder", title: "A", timeoutSec: 240 });
const b = await call("fleet_delegate", { task: "Job B: edit TARGET=src/b.js with CONTENT=export const b = 2;", repo: REPO, model: "mock/mock-coder", title: "B", timeoutSec: 240 });
ok("two jobs started", !!a.jobId && !!b.jobId, `${a.jobId} / ${b.jobId}`);
ok("suite stays on the mock model", [a, b].every(j => j.model === "mock/mock-coder"),
   `${a.model} / ${b.model}`);
ok("separate worktrees", a.worktree.path !== b.worktree.path);

const waited = await call("fleet_wait", { jobIds: [a.jobId, b.jobId], timeoutSec: 300 });
const bothDone = waited.done?.length === 2 && waited.done.every(j => j.state === "done");
ok("both finished", bothDone, JSON.stringify(waited.done?.map(j => j.state)));
if (!bothDone) { await explainFailure(a.jobId); await explainFailure(b.jobId); await showMockLog("jobs"); }

const res = await call("fleet_result", { jobId: a.jobId });
ok("result has report", !!res.report, res.report?.slice(0, 50));
ok("result has diff", res.patch?.includes("a.js"), res.diffstat?.split("\n")[0]);
ok("cost tracked", res.costUsd > 0, String(res.costUsd));

const logs = await call("fleet_logs", { jobId: a.jobId });
ok("logs list tool calls", logs.toolCalls?.length > 0, logs.summary);

const fu = await call("fleet_followup", { jobId: a.jobId, message: "Also TARGET=src/a.js with CONTENT=export const a = 42;" });
ok("followup starts", !!fu.round, `round ${fu.round}`);
const fuw = await call("fleet_wait", { jobIds: [a.jobId], timeoutSec: 120 });
ok("followup finishes", fuw.done?.[0]?.state === "done", fuw.done?.[0]?.state);

const applied = await call("fleet_apply", { jobId: a.jobId, mode: "squash" });
ok("apply squash", applied.ok === true, applied.error?.slice(0, 120));
ok("A landed in main repo", fs.readFileSync(REPO + "/src/a.js", "utf8").includes("42"), fs.readFileSync(REPO + "/src/a.js", "utf8").trim());
const appliedB = await call("fleet_apply", { jobId: b.jobId, mode: "merge" });
ok("second job merges too", appliedB.ok === true, appliedB.error?.slice(0, 120));

// a job whose branch conflicts must fail loudly, not silently
const c = await call("fleet_delegate", { task: "Job C: edit TARGET=src/a.js with CONTENT=export const a = 999;", repo: REPO, model: "mock/mock-coder", title: "C", timeoutSec: 240, baseRef: "HEAD~2" });
await call("fleet_wait", { jobIds: [c.jobId], timeoutSec: 120 });
const conflicted = await call("fleet_apply", { jobId: c.jobId, mode: "merge" });
ok("conflict reported with hint", conflicted.ok === false && /conflict|merge failed/i.test(conflicted.error ?? ""), (conflicted.error ?? "").slice(0, 90));
await call("fleet_cleanup", { jobId: c.jobId, force: true });

// B now conflicts or merges cleanly; then clean both up
const cleanA = await call("fleet_cleanup", { jobId: a.jobId, force: true });
const cleanB = await call("fleet_cleanup", { jobId: b.jobId, force: true });
ok("cleanup both", cleanA.ok && cleanB.ok);

// suggestion ranking: a cheap tier must not be filled with mini/nano models,
// and a strong tier must not be cheaper than the balanced one
{
  const { loadConfig } = await import(path.join(ROOT, "src/config.mjs"));
  const M = await import(path.join(ROOT, "src/models.mjs"));
  const C = await import(path.join(ROOT, "src/catalog.mjs"));
  const md = await C.modelsDevCatalog();
  const orLive = await M.openrouterCatalog();
  const inv = [];
  for (const prov of ["openrouter", "opencode"]) for (const m of Object.keys(md[prov] ?? {})) inv.push(prov + "/" + m);
  const cfg = { ...(await import(path.join(ROOT, "src/config.mjs"))).DEFAULTS };
  const sug = await M.suggestProfiles(cfg, { cwd: "/tmp", installedOverride: inv, authOverride: ["openrouter", "opencode"] });
  const names = (t) => (sug.profiles[t]?.candidates ?? []).join(" ");
  // a cache written before a schema change must not silently serve old records
  {
    const fsx = await import("node:fs");
    const cf = path.join(TEST_HOME, "cache", "openrouter.json");
    fsx.mkdirSync(path.dirname(cf), { recursive: true });
    fsx.writeFileSync(cf, JSON.stringify({ "z-ai/glm-5.3-flash": { prompt: 0.075, completion: 0.25, context: 1310720, tools: true } }));
    const refetched = await M.openrouterCatalog();
    ok("stale catalogue cache self-heals", refetched["z-ai/glm-5.3-flash"]?.coding != null,
       `coding=${refetched["z-ai/glm-5.3-flash"]?.coding}`);
  }
  ok("suggest: all tiers filled", ["free","cheap","balanced","strong","longcontext"].every(t => sug.profiles[t]?.candidates?.length),
     Object.keys(sug.profiles).join(","));
  const weakest = (t, floor) => (sug.profiles[t]?.candidates ?? [])
    .map((c) => ({ c, cap: M.capabilityOf(c, M.priceInfo(c, cfg, orLive, md)).value }))
    .filter((x) => x.cap < floor);
  const tooWeak = [...weakest("cheap", 35), ...weakest("balanced", 45), ...weakest("strong", 55)];
  ok("suggest: paid tiers only hold capable models", tooWeak.length === 0,
     tooWeak.map((x) => `${x.c} cap ${Math.round(x.cap)}`).join(", ") || "all above their tier floor");
  const price = (ref) => M.priceInfo(ref, cfg, {}, md).prompt ?? 0;
  const avg = (t) => (sug.profiles[t]?.candidates ?? []).reduce((s, r) => s + price(r), 0) / (sug.profiles[t]?.candidates?.length || 1);
  ok("suggest: tiers ordered by capability", avg("cheap") < avg("balanced") && avg("balanced") <= avg("strong"),
     `cheap $${avg("cheap").toFixed(2)} < balanced $${avg("balanced").toFixed(2)} <= strong $${avg("strong").toFixed(2)}`);
  const cheapFirst = sug.profiles.cheap?.candidates?.[0] ?? "";
  const cheapFirstCtx = M.priceInfo(cheapFirst, cfg, {}, md).context ?? 0;
  ok("suggest: near-equal prices lose to more context", cheapFirstCtx >= 1000000,
     `${cheapFirst} @ ${Math.round(cheapFirstCtx / 1000)}k ctx`);
  const benchmarked = (ref) => M.capabilityOf(ref, M.priceInfo(ref, cfg, orLive, md)).source === "artificial-analysis";
  ok("suggest: measured models lead the cheap tier", benchmarked(sug.profiles.cheap.candidates[0]),
     `${sug.profiles.cheap.candidates[0]} (${M.capabilityOf(sug.profiles.cheap.candidates[0], M.priceInfo(sug.profiles.cheap.candidates[0], cfg, orLive, md)).source})`);
  ok("suggest: longcontext is cheap and wide", (sug.profiles.longcontext.candidates ?? []).some(r => price(r) < 0.3),
     sug.profiles.longcontext.candidates[0]);
}

// the concurrency guard must hold even while jobs are failing over
{
  const started = [];
  for (let i = 0; i < 6; i++) {
    started.push(await call("fleet_delegate", {
      task: `Concurrency ${i}: edit TARGET=src/c${i}.js with CONTENT=export const c${i} = 1;`,
      repo: REPO, model: "mock/mock-coder", title: `conc-${i}`, timeoutSec: 120, maxConcurrent: 2
    }));
  }
  ok("every job is accepted, none refused", started.every((r) => r.jobId),
     started.map((r) => r.state ?? "running").join(","));
  const queued = started.filter((r) => r.state === "queued");
  ok("the ones past the limit are queued, not lost", queued.length > 0, `${queued.length} queued`);
  ok("the queue tells you where you stand", queued.every((r, i) => r.queuePosition === i + 1),
     queued.map((r) => r.queuePosition).join(","));

  const st = await call("fleet_status", {});
  ok("never more running than the limit allows", (st.running?.length ?? 0) <= 2,
     `${st.running?.length ?? 0} running, ${st.queued?.length ?? 0} queued`);

  // the queue must drain by itself, without anyone poking it
  let allDone = false;
  for (let i = 0; i < 15 && !allDone; i++) {
    const w = await call("fleet_wait", { jobIds: started.map((r) => r.jobId), timeoutSec: 40 });
    allDone = (w.stillRunning?.length ?? 0) === 0;
  }
  const final = await call("fleet_status", { limit: 30 });
  const finished = started.filter((r) => final.recent?.some((x) => x.jobId === r.jobId && x.state === "done"));
  ok("the queue drains on its own", finished.length === started.length,
     `${finished.length}/${started.length} finished`);

  for (const j of started) await call("fleet_cleanup", { jobId: j.jobId, force: true });
}

// a finished job must report a real duration, not zero
{
  const d = await call("fleet_delegate", { task: "Duration: edit TARGET=src/d.js with CONTENT=export const d = 1;",
    repo: REPO, model: "mock/mock-coder", title: "duration", timeoutSec: 90 });
  let fin = null;
  for (let i = 0; i < 6 && !fin; i++) {
    const w = await call("fleet_wait", { jobIds: [d.jobId], timeoutSec: 40 });
    fin = w.done?.[0] ?? null;
  }
  ok("a finished job carries durationMs for the dashboard", typeof fin?.durationMs === "number" && fin.durationMs > 0,
     `durationMs=${fin?.durationMs} duration=${fin?.duration}`);
  await call("fleet_cleanup", { jobId: d.jobId, force: true });
}

// a provider that fails must not end the job: it moves to the next candidate
{
  const f = await call("fleet_delegate", {
    task: "Job F: edit TARGET=src/b.js with CONTENT=export const b = 7;",
    repo: REPO, profile: "failovertest", title: "failover", timeoutSec: 90
  });
  ok("failover: starts on the broken model", f.model === "mock/mock-broken", `${f.model}, fallbacks: ${(f.fallbacks || []).join(",")}`);
  let fin = null;
  for (let i = 0; i < 12 && !fin; i++) {
    const w = await call("fleet_wait", { jobIds: [f.jobId], timeoutSec: 40 });
    fin = w.done?.[0] ?? null;
  }
  ok("failover: job still succeeds", fin?.state === "done", `${fin?.state} on ${fin?.model}`);
  ok("failover: switched to the working model", fin?.model === "mock/mock-coder", fin?.model);
  ok("failover: the failed attempt is reported", (fin?.previousAttempts ?? []).some(a => a.includes("mock-broken")),
     (fin?.previousAttempts ?? [])[0] ?? "none recorded");
  const fres = await call("fleet_result", { jobId: f.jobId });
  ok("failover: work actually landed", fres.patch?.includes("b.js"), fres.diffstat?.split("\n")[0]);
  if (fin?.state !== "done") await explainFailure(f.jobId);
  await call("fleet_cleanup", { jobId: f.jobId, force: true });
}

const status = await call("fleet_status", {});
ok("status lists history", status.recent?.length >= 2, `${status.recent?.length} recent, spent $${status.spentTodayUsd}`);

srv.kill(); shutdown();
console.log("\n(a FAIL above means the harness regressed — see README > Development)");
process.exit(0);
