import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The plan reading exists to answer one question: will the subscription run out
// before it resets? Everything interesting here is about refusing to overclaim —
// a single sample cannot see a rate, a reset makes older samples meaningless,
// and an hours-old reading is history rather than status.

process.env.WERKEL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "werkel-plan-"));
const P = await import("../src/plan.mjs");

const FILE = path.join(process.env.WERKEL_HOME, "plan-usage.json");
const reset = () => fs.rmSync(FILE, { force: true });

const S = 1000, MIN = 60 * S, H = 60 * MIN, D = 24 * H;
const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);

/** rate_limits exactly as Claude Code shapes it: percentages plus epoch seconds. */
const limits = ({ fiveHourPct, fiveHourResetsIn, weekPct, weekResetsIn }, now = NOW) => {
  const o = {};
  if (fiveHourPct != null) o.five_hour = { used_percentage: fiveHourPct, resets_at: (now + fiveHourResetsIn) / 1000 };
  if (weekPct != null) o.seven_day = { used_percentage: weekPct, resets_at: (now + weekResetsIn) / 1000 };
  return o;
};

test("a blob without rate_limits is not a sample", () => {
  reset();
  assert.equal(P.record(undefined), null);
  assert.equal(P.record(null), null);
  assert.equal(P.record({}), null);
  // present but unusable — Claude Code omits the percentage before the first response
  assert.equal(P.record({ five_hour: { resets_at: 123 } }), null);
  assert.equal(P.load().samples.length, 0, "nothing should have been written");
  assert.equal(P.pressure(NOW).known, false);
});

test("nothing sampled yet is reported as unknown, not as fine", () => {
  reset();
  const p = P.pressure(NOW);
  assert.equal(p.known, false);
  assert.equal(p.level, "unknown");
  assert.match(p.hint, /statusLine/);
  // silence towards Claude rather than a confident all-clear
  assert.equal(P.pressureNote(p), null);
});

test("resets_at is read as epoch seconds, kept as milliseconds", () => {
  reset();
  const s = P.record(limits({ fiveHourPct: 20, fiveHourResetsIn: 2 * H }), NOW);
  assert.equal(s.fiveHour.pct, 20);
  assert.equal(s.fiveHour.resetsAt, NOW + 2 * H, "seconds must be scaled, not stored raw");
});

test("one sample of the 5h window still gives a pace, because its length is known", () => {
  reset();
  // 3 hours into a 5 hour window, 30% spent: an even pace would have spent 60%
  P.record(limits({ fiveHourPct: 30, fiveHourResetsIn: 2 * H }), NOW);
  const w = P.pressure(NOW).windows.fiveHour;
  assert.equal(w.basis, "pace");
  assert.equal(Math.round(w.burnPctPerHour), 10);
  // 70% left at 10%/h = 7h, but the window resets in 2h — no danger
  assert.ok(w.headroom > 1.6, `headroom ${w.headroom}`);
  assert.equal(w.level, "relaxed");
});

test("the weekly window gets no assumed length — one sample is percentage only", () => {
  reset();
  P.record(limits({ weekPct: 40, weekResetsIn: 3 * D }), NOW);
  const w = P.pressure(NOW).windows.sevenDay;
  assert.equal(w.basis, "raw", "assuming the window is seven days long would be a guess");
  assert.equal(w.headroom, null);
  assert.equal(w.level, "relaxed");
});

test("two samples measure the burn rate and project the ceiling", () => {
  reset();
  // 20% -> 50% over 6 hours = 5%/h; 50% left runs out in 10h, reset is 3 days away
  P.record(limits({ weekPct: 20, weekResetsIn: 3 * D + 6 * H }, NOW - 6 * H), NOW - 6 * H);
  P.record(limits({ weekPct: 50, weekResetsIn: 3 * D }), NOW);
  const w = P.pressure(NOW).windows.sevenDay;
  assert.equal(w.basis, "burn");
  assert.equal(Math.round(w.burnPctPerHour), 5);
  assert.equal(Math.round(w.exhaustsInMs / H), 10);
  assert.ok(w.headroom < 0.2, `headroom ${w.headroom}`);
  assert.equal(w.level, "critical", "runs out long before it resets");
});

test("a reset does not read as a negative burn rate", () => {
  reset();
  // an old window that ended, then a fresh one — different resets_at
  P.record(limits({ weekPct: 88, weekResetsIn: 1 * H }, NOW - 5 * H), NOW - 5 * H);
  P.record(limits({ weekPct: 3, weekResetsIn: 3 * D }, NOW - 2 * H), NOW - 2 * H);
  P.record(limits({ weekPct: 5, weekResetsIn: 3 * D - 2 * H }, NOW), NOW);
  const w = P.pressure(NOW).windows.sevenDay;
  assert.equal(w.samples, 2, "only the samples from the open window may count");
  assert.ok(w.burnPctPerHour > 0 && w.burnPctPerHour < 2, `burn ${w.burnPctPerHour}`);
  assert.equal(w.level, "relaxed");
});

test("a window whose reset time has passed is gone, not stale", () => {
  reset();
  // Claude Code drops a window once resets_at passes; a cached one must go too
  P.record(limits({ fiveHourPct: 95, fiveHourResetsIn: 30 * MIN }, NOW - 2 * H), NOW - 2 * H);
  const p = P.pressure(NOW + 0);
  assert.equal(p.windows.fiveHour, undefined, "95% in a window that already reset says nothing");
  assert.equal(p.known, false);
});

test("flat usage projects no exhaustion at all", () => {
  reset();
  P.record(limits({ weekPct: 44, weekResetsIn: 2 * D + 4 * H }, NOW - 4 * H), NOW - 4 * H);
  P.record(limits({ weekPct: 44, weekResetsIn: 2 * D }), NOW);
  const w = P.pressure(NOW).windows.sevenDay;
  assert.equal(w.burnPctPerHour, 0);
  assert.equal(w.exhaustsInMs, Infinity);
  assert.equal(w.level, "relaxed", "idle at 44% is not a problem");
});

test("nearly spent is critical however slowly it got there", () => {
  reset();
  // a crawl: 92% reached at well under 1%/h, reset still days out
  P.record(limits({ weekPct: 91, weekResetsIn: 2 * D + 10 * H }, NOW - 10 * H), NOW - 10 * H);
  P.record(limits({ weekPct: 93, weekResetsIn: 2 * D }), NOW);
  assert.equal(P.pressure(NOW).windows.sevenDay.level, "critical");
});

test("the worse of the two windows decides", () => {
  reset();
  P.record(limits({ fiveHourPct: 2, fiveHourResetsIn: 4 * H, weekPct: 95, weekResetsIn: 2 * D }), NOW);
  const p = P.pressure(NOW);
  assert.equal(p.windows.fiveHour.level, "relaxed");
  assert.equal(p.level, "critical");
  assert.equal(p.driver, "weekly");
});

test("an old reading is softened, because it may describe a window that moved on", () => {
  reset();
  const old = NOW - 3 * H;
  P.record(limits({ weekPct: 40, weekResetsIn: 2 * D + 3 * H }, old), old - 6 * H);
  P.record(limits({ weekPct: 95, weekResetsIn: 2 * D + 3 * H }, old), old);
  const p = P.pressure(NOW);
  assert.equal(p.stale, true);
  assert.equal(p.windows.sevenDay.level, "critical");
  assert.equal(p.level, "conserve", "a three-hour-old panic is downgraded, not repeated");
  assert.match(p.reason, /old/);
});

test("the note stays silent while the plan is comfortable", () => {
  reset();
  P.record(limits({ weekPct: 5, weekResetsIn: 3 * D }), NOW);
  assert.equal(P.pressureNote(P.pressure(NOW)), null, "a banner on every response is noise");

  reset();
  P.record(limits({ weekPct: 20, weekResetsIn: 3 * D + 8 * H }, NOW - 8 * H), NOW - 8 * H);
  P.record(limits({ weekPct: 70, weekResetsIn: 3 * D }), NOW);
  const note = P.pressureNote(P.pressure(NOW));
  assert.ok(note, "under pressure it must speak up");
  assert.match(note, /conserve|critical/);
});

test("the advice never says to delegate everything", () => {
  // Briefing and reviewing cost the manager plan tokens too, so a small edit
  // stays cheaper done directly no matter how tight things are.
  reset();
  P.record(limits({ weekPct: 20, weekResetsIn: 3 * D + 8 * H }, NOW - 8 * H), NOW - 8 * H);
  P.record(limits({ weekPct: 88, weekResetsIn: 3 * D }), NOW);
  const p = P.pressure(NOW);
  assert.match(p.advice, /still (not worth|faster)|directly/i);
});

test("history is bounded so the file cannot grow without limit", () => {
  reset();
  for (let i = 0; i < 460; i++) {
    P.record(limits({ weekPct: i / 10, weekResetsIn: 5 * D }, NOW - (460 - i) * MIN), NOW - (460 - i) * MIN);
  }
  assert.ok(P.load().samples.length <= 400, `kept ${P.load().samples.length}`);
});

test("a corrupt cache is treated as no data, not as a crash", () => {
  reset();
  fs.writeFileSync(FILE, "{not json");
  assert.deepEqual(P.load().samples, []);
  assert.equal(P.pressure(NOW).known, false);
  // and it must be writable again afterwards
  assert.ok(P.record(limits({ weekPct: 10, weekResetsIn: 2 * D }), NOW));
});

test("spans shorter than a few minutes do not become a burn rate", () => {
  reset();
  P.record(limits({ weekPct: 10, weekResetsIn: 3 * D }, NOW - 20 * S), NOW - 20 * S);
  P.record(limits({ weekPct: 11, weekResetsIn: 3 * D }), NOW);
  const w = P.pressure(NOW).windows.sevenDay;
  assert.equal(w.basis, "raw", "1% in 20 seconds is not 180%/hour");
});

test("a wobbling resets_at does not split one window into two", () => {
  // The grouping must not depend on the server returning a byte-identical
  // timestamp; only a jump backwards means a reset actually happened.
  reset();
  P.record(limits({ weekPct: 30, weekResetsIn: 2 * D + 6 * H }, NOW - 6 * H), NOW - 6 * H);
  P.record(limits({ weekPct: 45, weekResetsIn: 2 * D + 3 * H - 2 * MIN }, NOW - 3 * H), NOW - 3 * H);
  P.record(limits({ weekPct: 60, weekResetsIn: 2 * D + 90 * S }, NOW), NOW);
  const w = P.pressure(NOW).windows.sevenDay;
  assert.equal(w.samples, 3, "a few minutes of drift is not three separate windows");
  assert.equal(w.basis, "burn");
  assert.equal(Math.round(w.burnPctPerHour), 5);
});

test("a reset is still caught when usage immediately climbs past the old level", () => {
  reset();
  // 88% -> reset -> 90%: the percentage never falls between samples, so only
  // the reset time can give it away.
  P.record(limits({ weekPct: 88, weekResetsIn: 30 * MIN }, NOW - 2 * H), NOW - 2 * H);
  P.record(limits({ weekPct: 90, weekResetsIn: 4 * D }, NOW), NOW);
  const w = P.pressure(NOW).windows.sevenDay;
  assert.equal(w.samples, 1, "the pre-reset sample must not be treated as this window's start");
  assert.equal(w.basis, "raw");
});

test("an unchanged reading is not stored again a second later", () => {
  reset();
  const same = limits({ weekPct: 50, weekResetsIn: 2 * D });
  assert.ok(P.record(same, NOW));
  assert.equal(P.record(same, NOW + 2 * S), null, "the status line fires constantly; this would flood the file");
  assert.equal(P.record(same, NOW + 30 * S), null);
  assert.equal(P.load().samples.length, 1);
  // but a change is always worth keeping, however soon it arrives
  assert.ok(P.record(limits({ weekPct: 51, weekResetsIn: 2 * D }), NOW + 31 * S));
  assert.equal(P.load().samples.length, 2);
  // and an unchanged reading is kept once it widens the measurable span
  assert.ok(P.record(limits({ weekPct: 51, weekResetsIn: 2 * D }), NOW + 20 * MIN));
});

// --- why no sample arrived -------------------------------------------------
// Claude Code prints nothing when a status line command fails, so every mistake
// in the wiring looks exactly like "not used yet". These are the ways it breaks.

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "werkel-home-"));
const SETTINGS = path.join(HOME, ".claude", "settings.json");
fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
const realHome = os.homedir;
const withSettings = (obj) => {
  if (obj === null) fs.rmSync(SETTINGS, { force: true });
  else fs.writeFileSync(SETTINGS, JSON.stringify(obj));
  os.homedir = () => HOME;
  try { return P.checkWiring(); } finally { os.homedir = realHome; }
};

const script = path.join(HOME, "werkel.mjs");
fs.writeFileSync(script, "#!/usr/bin/env node\n");

test("no settings file at all is named as such", () => {
  const w = withSettings(null);
  assert.equal(w.wired, false);
  assert.match(w.problems[0], /does not exist/);
});

test("settings without a statusLine says the hook is simply not there", () => {
  const w = withSettings({ agentPushNotifEnabled: true });
  assert.equal(w.wired, false);
  assert.match(w.problems[0], /no statusLine/);
});

test("someone else's status line is not mistaken for ours", () => {
  const w = withSettings({ statusLine: { type: "command", command: "my-bar.sh --fancy" } });
  assert.equal(w.wired, false);
  assert.match(w.problems[0], /runs something else/);
  // and the fix keeps their bar rather than replacing it
  assert.match(w.next.join(" "), /--then/);
});

test("a script that lost its executable bit is the silent failure worth catching", { skip: process.platform === "win32" }, () => {
  fs.chmodSync(script, 0o644);
  const w = withSettings({ statusLine: { type: "command", command: `${script} statusline` } });
  assert.equal(w.wired, true, "it is our command, it just cannot start");
  assert.match(w.problems[0], /not executable/);
  assert.match(w.next.join(" "), /node /);
});

test("the same script is fine once node runs it, bit or no bit", () => {
  reset();
  fs.chmodSync(script, 0o644);
  P.noteHook({ parsed: true, hadRateLimits: true, windows: ["five_hour"] });
  const w = withSettings({ statusLine: { type: "command", command: `node ${script} statusline` } });
  assert.deepEqual(w.problems, [], "prefixing with node sidesteps the whole question");
});

test("a path that is not there at all is reported before anything else", () => {
  const w = withSettings({ statusLine: { type: "command", command: `node ${script}.gone statusline` } });
  assert.match(w.problems[0], /does not exist/);
});

test("a bare command name is checked against the PATH", () => {
  const w = withSettings({ statusLine: { type: "command", command: "definitely-not-installed statusline" } });
  assert.match(w.problems[0], /not on the PATH/);
});

test("a statusLine given as a plain string is understood too", () => {
  reset();
  fs.chmodSync(script, 0o755);
  P.noteHook({ parsed: true, hadRateLimits: true });
  const w = withSettings({ statusLine: `${script} statusline` });
  assert.equal(w.wired, true);
  assert.deepEqual(w.problems, []);
});

// --- did the hook ever actually run? ---------------------------------------
// Settings can be perfect and nothing still happens, because the statusLine is a
// Claude Code CLI feature and because rate_limits is not sent to every account.
// Those need opposite fixes, so they must not look the same.

const wired = () => withSettings({ statusLine: { type: "command", command: `node ${script} statusline` } });

test("a perfect config that has never been run says exactly that", () => {
  reset();
  const w = wired();
  assert.match(w.problems[0], /never run this command/);
  assert.match(w.next.join(" "), /claude` CLI|desktop app/, "the likely reason is named, not left as a mystery");
});

test("a hook that runs but gets no rate_limits blames the account, not the wiring", () => {
  reset();
  P.noteHook({ parsed: true, hadRateLimits: false, topKeys: ["model", "workspace", "cost"] });
  const w = wired();
  assert.match(w.problems[0], /carried no rate_limits/);
  assert.match(w.next.join(" "), /Pro and Max/);
  assert.match(w.next.join(" "), /model, workspace, cost/, "showing the payload proves the hook is really wired");
});

test("a hook fed something that is not JSON is a third, different fault", () => {
  reset();
  P.noteHook({ parsed: false, hadRateLimits: false });
  assert.match(wired().problems[0], /stdin was not JSON/);
});

test("a hook that does deliver limits reports clean", () => {
  reset();
  P.noteHook({ parsed: true, hadRateLimits: true, windows: ["five_hour", "seven_day"] });
  const w = wired();
  assert.deepEqual(w.problems, []);
  assert.match(w.next.join(" "), /five_hour, seven_day/);
});

test("the heartbeat counts runs without writing on every single one", () => {
  reset();
  const t = Date.UTC(2026, 8, 3, 9, 0, 0);
  const info = { parsed: true, hadRateLimits: true };
  assert.equal(P.noteHook(info, t).runs, 1);
  assert.equal(P.noteHook(info, t + 2000).runs, 1, "the status line fires constantly; this is a heartbeat, not a log");
  assert.equal(P.noteHook(info, t + 60000).runs, 2);
  // a change of state is always worth recording, however soon
  assert.equal(P.noteHook({ parsed: true, hadRateLimits: false }, t + 61000).runs, 3);
});

test("the heartbeat survives a sample being written", () => {
  reset();
  P.noteHook({ parsed: true, hadRateLimits: true });
  P.record(limits({ weekPct: 12, weekResetsIn: 2 * D }), NOW);
  assert.ok(P.load().lastHook, "recording a sample must not wipe the diagnosis");
  assert.equal(P.load().samples.length, 1);
});
