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

// start the mock model server ourselves so the suite is self-contained
const mock = spawn("python3", [path.join(ROOT, "test/mock_llm.py")], { stdio: "ignore", detached: false });
const upBy = Date.now() + 15000;
for (;;) {
  try { const r = await fetch("http://127.0.0.1:8099/v1/models"); if (r.ok) break; } catch {}
  if (Date.now() > upBy) { console.error("mock model server did not start (port 8099 in use?)"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 300));
}
const shutdown = () => { try { mock.kill(); } catch {} };
process.on("exit", shutdown); process.on("SIGINT", () => { shutdown(); process.exit(1); });

const srv = spawn("node", [path.join(ROOT, "bin/ocfleet.mjs"), "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
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

// two parallel jobs, isolated worktrees
const a = await call("fleet_delegate", { task: "Job A: edit TARGET=src/a.js with CONTENT=export const a = 1;", repo: REPO, profile: "cheap", title: "A", timeoutSec: 90 });
const b = await call("fleet_delegate", { task: "Job B: edit TARGET=src/b.js with CONTENT=export const b = 2;", repo: REPO, profile: "cheap", title: "B", timeoutSec: 90 });
ok("two jobs started", !!a.jobId && !!b.jobId, `${a.jobId} / ${b.jobId}`);
ok("separate worktrees", a.worktree.path !== b.worktree.path);

const waited = await call("fleet_wait", { jobIds: [a.jobId, b.jobId], timeoutSec: 180 });
ok("both finished", waited.done?.length === 2 && waited.done.every(j => j.state === "done"), JSON.stringify(waited.done?.map(j => j.state)));

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
const c = await call("fleet_delegate", { task: "Job C: edit TARGET=src/a.js with CONTENT=export const a = 999;", repo: REPO, profile: "cheap", title: "C", timeoutSec: 90, baseRef: "HEAD~2" });
await call("fleet_wait", { jobIds: [c.jobId], timeoutSec: 120 });
const conflicted = await call("fleet_apply", { jobId: c.jobId, mode: "merge" });
ok("conflict reported with hint", conflicted.ok === false && /conflict|merge failed/i.test(conflicted.error ?? ""), (conflicted.error ?? "").slice(0, 90));
await call("fleet_cleanup", { jobId: c.jobId, force: true });

// B now conflicts or merges cleanly; then clean both up
const cleanA = await call("fleet_cleanup", { jobId: a.jobId, force: true });
const cleanB = await call("fleet_cleanup", { jobId: b.jobId, force: true });
ok("cleanup both", cleanA.ok && cleanB.ok);

const status = await call("fleet_status", {});
ok("status lists history", status.recent?.length >= 2, `${status.recent?.length} recent, spent $${status.spentTodayUsd}`);

srv.kill(); shutdown();
console.log("\n(a FAIL above means the harness regressed — see README > Development)");
process.exit(0);
