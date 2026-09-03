import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";
import { strict as assert } from "node:assert/strict";
import { record, statsFor, bonusFor, summary, load, save, forget } from "../src/experience.mjs";

// Everything below that touches disk writes into a throwaway werkel home, so
// the tests never see (or leave) real experience data.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "werkel-experience-"));
process.env.WERKEL_HOME = HOME;
const FILE = () => path.join(HOME, "experience.json");

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const DAY = 86_400_000;
const now = 1_750_000_000_000;
const good = (t) => ({ t, o: 1, w: 1, s: "applied" });
const bad = (t) => ({ t, o: 0, w: 1, s: "failed" });
const bucket = (events) => ({ "cheap|a/b": { events } });

/** Park-Miller LCG: same seed, same sequence, so explore mode can be tested. */
function lcg(seed) {
  let s = seed;
  return () => (s = s * 16807 % 2147483647) / 2147483647;
}

test("no evidence means exactly zero bonus", () => {
  assert.equal(bonusFor("x/y", "cheap", { data: {} }), 0);
  assert.equal(bonusFor("x/y", "cheap", { data: {}, explore: false }), 0);
});

test("a verdict from one half-life ago counts about half", () => {
  const fresh = statsFor("a/b", "cheap", { data: bucket([good(now)]), now });
  const stale = statsFor("a/b", "cheap", { data: bucket([good(now - 45 * DAY)]), now });
  assert.equal(fresh.effectiveN, 1);
  assert.ok(Math.abs(stale.effectiveN - 0.5) < 1e-9);
});

test("one good job does not outscore twenty good jobs", () => {
  const one = bucket([good(now)]);
  const twenty = bucket(Array.from({ length: 20 }, () => good(now)));
  const b1 = bonusFor("a/b", "cheap", { data: one, now, explore: false });
  const b20 = bonusFor("a/b", "cheap", { data: twenty, now, explore: false });
  // confidence is what separates them, not the rate (both are 100%)
  assert.ok(b1 < b20 / 3, `one good job (${b1}) must be far below twenty (${b20})`);
});

test("all-bad evidence pulls down, all-good pushes up, both inside the cap", () => {
  const badData = bucket(Array.from({ length: 5 }, (_, i) => bad(now - i)));
  const goodData = bucket(Array.from({ length: 5 }, (_, i) => good(now - i)));
  const down = bonusFor("a/b", "cheap", { data: badData, now, explore: false });
  const up = bonusFor("a/b", "cheap", { data: goodData, now, explore: false });
  assert.ok(down < 0);
  assert.ok(up > 0);
  assert.ok(down >= -10);
  assert.ok(up <= 10);
});

test("even 500 good jobs cannot exceed maxShift", () => {
  const data = bucket(Array.from({ length: 500 }, () => good(now)));
  const b = bonusFor("a/b", "cheap", { data, now, explore: false, maxShift: 10 });
  assert.ok(b > 0);
  assert.ok(b <= 10);
});

test("explore:false is deterministic", () => {
  const data = bucket([good(now), bad(now - DAY)]);
  const a = bonusFor("a/b", "cheap", { data, now, explore: false });
  const b = bonusFor("a/b", "cheap", { data, now, explore: false });
  assert.equal(a, b);
});

test("explore:true with a fixed random is deterministic too", () => {
  const data = bucket([good(now), good(now), bad(now - DAY)]);
  const a = bonusFor("a/b", "cheap", { data, now, random: lcg(123456789) });
  const b = bonusFor("a/b", "cheap", { data, now, random: lcg(123456789) });
  assert.equal(a, b);
  assert.ok(a >= -10 && a <= 10);
});

test("only the newest 200 events are kept, oldest dropped first", () => {
  save({});
  for (let i = 0; i < 205; i++) {
    record({ model: "cap/m", profile: "p", outcome: i % 2 ? 1 : 0, source: "applied", at: 1000 + i });
  }
  const { events } = load()["p|cap/m"];
  assert.equal(events.length, 200);
  assert.equal(events[0].t, 1005);
  assert.equal(events[199].t, 1204);
});

test("a corrupt experience.json means no experience, not a crash", () => {
  fs.writeFileSync(FILE(), "{ this is not json");
  assert.deepEqual(load(), {});
  assert.equal(statsFor("x/y", "cheap").n, 0);
  assert.equal(bonusFor("x/y", "cheap"), 0);
  // valid JSON but the wrong shape is treated the same way
  fs.writeFileSync(FILE(), JSON.stringify([1, 2, 3]));
  assert.deepEqual(load(), {});
  // and recording recovers the store instead of dying on it
  assert.equal(record({ model: "x/y", outcome: 1, source: "applied" }), "*|x/y");
  assert.equal(load()["*|x/y"].events.length, 1);
});

test("record rejects an outcome of 2 or a weight of 0 without writing anything", () => {
  save({});
  assert.equal(record({ model: "r/m", outcome: 2, source: "applied" }), null);
  assert.equal(record({ model: "r/m", outcome: 1, weight: 0, source: "applied" }), null);
  assert.deepEqual(load(), {});
});

test("statsFor reports rate, confidence and the newest notes first", () => {
  const events = [
    { t: now - 4 * DAY, o: 1, w: 1, s: "applied", n: "oldest note" },
    { t: now - 3 * DAY, o: 0, w: 1, s: "failed" },
    { t: now - 2 * DAY, o: 1, w: 2, s: "rated", n: "mid note" },
    { t: now - 1 * DAY, o: 0.5, w: 1, s: "followup", n: "newest note" },
    { t: now, o: 1, w: 1, s: "applied" }
  ];
  const s = statsFor("a/b", "cheap", { data: bucket(events), now });
  assert.equal(s.n, 5);
  assert.ok(s.rate > 0.5 && s.rate < 1);
  assert.ok(s.confidence > 0 && s.confidence < 1);
  assert.deepEqual(s.notes, [
    { at: now - 1 * DAY, source: "followup", note: "newest note" },
    { at: now - 2 * DAY, source: "rated", note: "mid note" },
    { at: now - 4 * DAY, source: "applied", note: "oldest note" }
  ]);
  assert.equal(s.lastAt, now);
});

test("summary lists one row per bucket, busiest evidence first, bonus stable", () => {
  const data = {
    "cheap|busy/m": { events: [good(now), good(now - DAY), good(now - 2 * DAY), good(now - 3 * DAY)] },
    "cheap|rare/m": { events: [good(now)] },
    "*|plain/m": { events: [bad(now - DAY)] }
  };
  const rows = summary({ now, data });
  assert.deepEqual(rows.map((r) => [r.profile, r.model]),
    [["cheap", "busy/m"], ["cheap", "rare/m"], ["*", "plain/m"]]);
  assert.ok(rows[0].bonus > 0);
  assert.ok(rows[2].bonus < 0);
  // explore:false, so a second read gives byte-identical rows
  assert.deepEqual(rows, summary({ now, data }));
});

test("record buckets a null profile under * and forget removes buckets", () => {
  save({});
  assert.equal(record({ model: "m1", profile: "p1", outcome: 1, source: "applied", note: "clean diff" }), "p1|m1");
  assert.equal(record({ model: "m1", outcome: 0, source: "failed" }), "*|m1");
  const data = load();
  assert.equal(data["p1|m1"].events.length, 1);
  assert.equal(data["p1|m1"].events[0].n, "clean diff");
  assert.equal(data["*|m1"].events[0].o, 0);
  assert.equal(forget("m1", "p1"), 1);
  assert.equal(forget("m1", "p1"), 0);
  assert.equal(forget("m1", null), 1);
  assert.deepEqual(load(), {});
});

// --- decay measured in jobs, not only in days -----------------------------
//
// Time decay alone made this an all-time average wearing a moving average's
// clothes: at twenty jobs a day, a 45-day half-life is nine hundred jobs, so
// everything inside a week weighed the same. A model with two hundred good jobs
// behind it could fail forty in a row and still score positive.

const run = (goods, bads, t = now) => {
  const events = [];
  for (let i = 0; i < goods; i++) events.push(good(t - (goods + bads - i) * 1000));
  for (let i = 0; i < bads; i++) events.push(bad(t - (bads - i) * 1000));
  return bucket(events);
};

test("a long good history does not survive a run of failures", () => {
  const opts = { explore: false, now };
  const before = bonusFor("a/b", "cheap", { ...opts, data: run(200, 0) });
  assert.ok(before > 6, `a clean record should score well, got ${before}`);
  // this is the regression: with time decay alone this was still +5.7
  const after = bonusFor("a/b", "cheap", { ...opts, data: run(200, 40) });
  assert.ok(after < 0,
    `40 consecutive failures must outweigh an old good record, got ${after.toFixed(2)}`);
});

test("the drop is gradual, not a cliff", () => {
  const at = (n) => bonusFor("a/b", "cheap", { explore: false, now, data: run(200, n) });
  const steps = [0, 5, 10, 20, 30, 40].map(at);
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i] < steps[i - 1], `step ${i} did not fall: ${steps.join(", ")}`);
  }
});

test("a model that recovers is allowed to recover", () => {
  const sunk = bonusFor("a/b", "cheap", { explore: false, now, data: run(0, 15) });
  assert.ok(sunk < -4, `15 failures should hurt, got ${sunk}`);
  // 30 good jobs after those 15 failures must bring it back above zero
  const events = [...run(0, 15)["cheap|a/b"].events];
  for (let i = 0; i < 30; i++) events.push(good(now - (30 - i) * 1000));
  const healed = bonusFor("a/b", "cheap", { explore: false, now, data: bucket(events) });
  assert.ok(healed > 0, `a model that got good again must climb back, got ${healed.toFixed(2)}`);
});

test("evidence saturates, so no history is ever unassailable", () => {
  const s = statsFor("a/b", "cheap", { now, data: run(1000, 0) });
  assert.ok(s.effectiveN < 60, `effective evidence must not grow without bound, got ${s.effectiveN}`);
  assert.ok(s.confidence < 0.9,
    "a rolling window can never make you fully certain, and pretending otherwise is the bug");
  assert.ok(bonusFor("a/b", "cheap", { explore: false, now, data: run(1000, 0) }) <= 10);
});

test("countHalfLife: 0 turns the job-count decay off", () => {
  const withCount = bonusFor("a/b", "cheap", { explore: false, now, data: run(200, 40) });
  const timeOnly = bonusFor("a/b", "cheap", { explore: false, now, countHalfLife: 0, data: run(200, 40) });
  assert.ok(timeOnly > withCount,
    "without the count decay the old good record still dominates — that was the old behaviour");
});

test("order matters now: the same jobs in a different order score differently", () => {
  const worsening = bonusFor("a/b", "cheap", { explore: false, now, data: run(20, 20) });
  const events = [];
  for (let i = 0; i < 20; i++) events.push(bad(now - (40 - i) * 1000));
  for (let i = 0; i < 20; i++) events.push(good(now - (20 - i) * 1000));
  const gettingBetter = bonusFor("a/b", "cheap", { explore: false, now, data: bucket(events) });
  assert.ok(gettingBetter > worsening,
    `a model on the way up must beat one on the way down with the same totals: ${gettingBetter.toFixed(2)} vs ${worsening.toFixed(2)}`);
});
