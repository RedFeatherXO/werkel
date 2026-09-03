import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";
import { strict as assert } from "node:assert/strict";
import { record, statsFor, bonusFor, summary, load, save, forget } from "../src/experience.mjs";

// Everything below that touches disk writes into a throwaway fleet home, so
// the tests never see (or leave) real experience data.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-fleet-experience-"));
process.env.OPENCODE_FLEET_HOME = HOME;
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
