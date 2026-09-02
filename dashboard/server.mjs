#!/usr/bin/env node
/**
 * Fleet dashboard — a read-mostly view of every OpenCode worker, meant to run on
 * a small always-on server while the jobs themselves run elsewhere.
 *
 * The machine running the jobs pushes snapshots here (it needs no open port) and
 * picks up queued commands in the response to that same push.
 *
 * No dependencies: node:http, a JSON file, and one HTML page.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Configuration is resolved per start(), not at import time, so the same server
// can be embedded in `ocfleet dashboard` and run standalone in a container.
let PORT, HOST, DATA_DIR, STATE_FILE, INGEST_TOKEN, USER, PASS, RETENTION;
let state = { jobs: {}, commands: {}, hosts: {} };

function configure(opts = {}) {
  PORT = Number(opts.port ?? process.env.PORT ?? 7777);
  HOST = opts.host ?? process.env.HOST ?? "0.0.0.0";
  DATA_DIR = opts.dataDir ?? process.env.DATA_DIR ?? path.join(HERE, "data");
  STATE_FILE = path.join(DATA_DIR, "state.json");
  INGEST_TOKEN = opts.ingestToken ?? process.env.FLEET_INGEST_TOKEN ?? "";
  USER = opts.user ?? process.env.DASHBOARD_USER ?? "";
  PASS = opts.pass ?? process.env.DASHBOARD_PASS ?? "";
  RETENTION = Number(opts.retention ?? process.env.RETENTION_JOBS ?? 300);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  state = loadState();
}

// ---- state ---------------------------------------------------------------

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { jobs: raw.jobs ?? {}, commands: raw.commands ?? [], hosts: raw.hosts ?? {} };
  } catch {
    return { jobs: {}, commands: [], hosts: {} };
  }
}

let saveTimer = null;

/** Write the state out now. Also called on shutdown — a pending debounce would
 *  otherwise be dropped and a restart would lose the last few seconds. */
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error("could not persist state:", e.message);
  }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 1000);
}

function prune() {
  const all = Object.values(state.jobs).sort((a, b) => (b.startedMs ?? 0) - (a.startedMs ?? 0));
  for (const job of all.slice(RETENTION)) delete state.jobs[job.key];
  const cutoff = Date.now() - 24 * 3600e3;
  state.commands = state.commands.filter((c) => !c.doneAt || c.doneAt > cutoff);
}

// ---- live updates --------------------------------------------------------

const clients = new Set();
function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
}

// ---- helpers -------------------------------------------------------------

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
};

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(new Error("invalid JSON: " + e.message)); }
    });
    req.on("error", reject);
  });
}

/** Constant-time compare so a token cannot be guessed byte by byte. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function ingestAllowed(req) {
  if (!INGEST_TOKEN) return true;                 // unset = open, and we warn at boot
  return safeEqual(req.headers["x-fleet-token"] ?? "", INGEST_TOKEN);
}

/** Basic auth, only when both variables are set. */
function viewerAllowed(req, res) {
  if (!USER || !PASS) return true;
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Basic ")) {
    const [u, p] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
    if (safeEqual(u ?? "", USER) && safeEqual(p ?? "", PASS)) return true;
  }
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fleet dashboard"' });
  res.end("authentication required");
  return false;
}

// ---- routes --------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  // --- ingest from the machine that runs the jobs
  if (req.method === "POST" && p === "/api/ingest") {
    if (!ingestAllowed(req)) return json(res, 401, { error: "bad or missing X-Fleet-Token" });
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }

    const host = String(body.host || "unknown").slice(0, 64);
    const seen = [];
    for (const j of Array.isArray(body.jobs) ? body.jobs : []) {
      if (!j?.jobId) continue;
      const key = `${host}:${j.jobId}`;
      const prev = state.jobs[key];
      state.jobs[key] = { ...j, key, host, updatedAt: Date.now() };
      seen.push(key);
      if (!prev || prev.state !== j.state) broadcast("job", state.jobs[key]);
    }
    state.hosts[host] = { lastSeen: Date.now(), jobs: seen.length };
    prune();
    saveSoon();
    broadcast("tick", { host, jobs: seen.length, at: Date.now() });

    // hand back what the operator asked for while we had no way to reach them
    const pending = state.commands.filter((c) => c.host === host && !c.sentAt && !c.doneAt);
    for (const c of pending) c.sentAt = Date.now();
    return json(res, 200, { ok: true, commands: pending.map((c) => ({ id: c.id, action: c.action, jobId: c.jobId })) });
  }

  if (req.method === "POST" && p.startsWith("/api/commands/") && p.endsWith("/result")) {
    if (!ingestAllowed(req)) return json(res, 401, { error: "bad or missing X-Fleet-Token" });
    const id = p.split("/")[3];
    let body = {};
    try { body = await readBody(req); } catch {}
    const cmd = state.commands.find((c) => c.id === id);
    if (!cmd) return json(res, 404, { error: "unknown command" });
    cmd.doneAt = Date.now();
    cmd.ok = body.ok !== false;
    cmd.error = body.error ?? null;
    saveSoon();
    broadcast("command", cmd);
    return json(res, 200, { ok: true });
  }

  // --- everything below is for the browser
  if (!viewerAllowed(req, res)) return;

/** Running first, then the queue in the order it will start, then history.
 *  A waiting job has no startedMs, so plain recency would bury it at the bottom —
 *  exactly the jobs somebody opened the dashboard to look at. */
function byInterest(a, b) {
  const rank = (j) => (j.state === "running" ? 0 : j.state === "queued" ? 1 : 2);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1) return (a.queuedAt ?? 0) - (b.queuedAt ?? 0);   // oldest waits at the top: it goes next
  return (b.startedMs ?? 0) - (a.startedMs ?? 0);
}

  if (req.method === "GET" && p === "/api/jobs") {
    const jobs = Object.values(state.jobs).sort(byInterest);
    return json(res, 200, { jobs, hosts: state.hosts, commands: state.commands.slice(-50) });
  }

  if (req.method === "GET" && p.startsWith("/api/jobs/")) {
    const key = decodeURIComponent(p.slice("/api/jobs/".length));
    const job = state.jobs[key];
    return job ? json(res, 200, job) : json(res, 404, { error: "unknown job" });
  }

  if (req.method === "POST" && p.startsWith("/api/jobs/")) {
    const [, , , rawKey, action] = p.split("/");
    const key = decodeURIComponent(rawKey);
    const job = state.jobs[key];
    if (!job) return json(res, 404, { error: "unknown job" });
    if (!["cancel", "cleanup"].includes(action)) return json(res, 400, { error: "action must be cancel or cleanup" });
    const cmd = {
      id: crypto.randomUUID(), action, jobId: job.jobId, host: job.host,
      createdAt: Date.now(), sentAt: null, doneAt: null, ok: null, error: null
    };
    state.commands.push(cmd);
    saveSoon();
    broadcast("command", cmd);
    return json(res, 202, { ok: true, command: cmd, note: "queued — the reporter picks it up on its next push" });
  }

  if (req.method === "GET" && p === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      Connection: "keep-alive", "X-Accel-Buffering": "no"
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    clients.add(res);
    const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25000);
    req.on("close", () => { clearInterval(beat); clients.delete(res); });
    return;
  }

  if (req.method === "GET" && (p === "/" || p === "/index.html")) {
    const file = path.join(HERE, "public", "index.html");
    return fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(500); return res.end("dashboard page missing"); }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": buf.length });
      res.end(buf);
    });
  }

  if (req.method === "GET" && p === "/healthz") return json(res, 200, { ok: true, jobs: Object.keys(state.jobs).length });

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

/**
 * Start the dashboard. Returns the address it is listening on and a close()
 * that flushes state — both needed when it runs inside another process.
 */
export async function start(opts = {}) {
  configure(opts);
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error("request failed:", e);
      if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });

  const close = () => new Promise((resolve) => {
    saveNow();
    for (const c of clients) { try { c.end(); } catch {} }
    clients.clear();
    server.close(() => resolve());
    setTimeout(resolve, 1500).unref();
  });

  return {
    url: `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`,
    host: HOST, port: PORT, stateFile: STATE_FILE,
    restoredJobs: Object.keys(state.jobs).length,
    ingestProtected: !!INGEST_TOKEN,
    loginRequired: !!(USER && PASS),
    server, close
  };
}

// standalone (docker, systemd, `node dashboard/server.mjs`)
const runDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (runDirectly) {
  const info = await start();
  console.log(`fleet dashboard on ${info.url}`);
  console.log(`  data     ${info.stateFile} (${info.restoredJobs} jobs restored)`);
  console.log(`  ingest   ${info.ingestProtected ? "token required" : "OPEN - set FLEET_INGEST_TOKEN so only your machine can push"}`);
  console.log(`  viewing  ${info.loginRequired ? `basic auth as "${USER}"` : "no login (set DASHBOARD_USER and DASHBOARD_PASS to require one)"}`);

  const shutdown = async () => { await info.close(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("exit", saveNow);
}
