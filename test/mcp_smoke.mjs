import { spawn } from "node:child_process";
import path from "node:path";
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
    models: { "mock-coder": { name: "Mock Coder" } } } }
}, null, 2));
g("add", "-A"); g("commit", "-qm", "init");

// The suite must never touch the user's fleet config or spend real money:
// its own state dir, its own profiles, and an explicit mock model everywhere.
const TEST_HOME = "/tmp/opencode-fleet-teststate";
{
  const fsx = await import("node:fs");
  fsx.rmSync(TEST_HOME, { recursive: true, force: true });
  fsx.mkdirSync(TEST_HOME, { recursive: true });
  fsx.writeFileSync(path.join(TEST_HOME, "fleet.config.json"), JSON.stringify({
    budget: { allow: ["mock/*"], maxDailyUsd: 100 },
    staticPricing: { "mock/mock-coder": { prompt: 0.05, completion: 0.2, context: 200000, tools: true } },
    profiles: {
      cheap: { description: "test", candidates: ["mock/mock-coder"] },
      balanced: { description: "test", candidates: ["mock/mock-coder"] }
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
const WARM_DIR = "/tmp/opencode-fleet-warmup";
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
  const inv = [];
  for (const prov of ["openrouter", "opencode"]) for (const m of Object.keys(md[prov] ?? {})) inv.push(prov + "/" + m);
  const cfg = { ...(await import(path.join(ROOT, "src/config.mjs"))).DEFAULTS };
  const sug = await M.suggestProfiles(cfg, { cwd: "/tmp", installedOverride: inv, authOverride: ["openrouter", "opencode"] });
  const names = (t) => (sug.profiles[t]?.candidates ?? []).join(" ");
  ok("suggest: all tiers filled", ["free","cheap","balanced","strong","longcontext"].every(t => sug.profiles[t]?.candidates?.length),
     Object.keys(sug.profiles).join(","));
  ok("suggest: no mini/nano in paid tiers", !/nano|mini|tiny|-3b|-8b/i.test(names("cheap") + names("balanced") + names("strong")),
     names("cheap").split(" ")[0]);
  const price = (ref) => M.priceInfo(ref, cfg, {}, md).prompt ?? 0;
  const avg = (t) => (sug.profiles[t]?.candidates ?? []).reduce((s, r) => s + price(r), 0) / (sug.profiles[t]?.candidates?.length || 1);
  ok("suggest: tiers ordered by capability", avg("cheap") < avg("balanced") && avg("balanced") <= avg("strong"),
     `cheap $${avg("cheap").toFixed(2)} < balanced $${avg("balanced").toFixed(2)} <= strong $${avg("strong").toFixed(2)}`);
  ok("suggest: longcontext is cheap and wide", (sug.profiles.longcontext.candidates ?? []).some(r => price(r) < 0.3),
     sug.profiles.longcontext.candidates[0]);
}

const status = await call("fleet_status", {});
ok("status lists history", status.recent?.length >= 2, `${status.recent?.length} recent, spent $${status.spentTodayUsd}`);

srv.kill(); shutdown();
console.log("\n(a FAIL above means the harness regressed — see README > Development)");
process.exit(0);
