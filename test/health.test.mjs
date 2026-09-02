import { test } from "node:test";
import { strict as assert } from "node:assert/strict";
import { isCoolingDown, preferHealthy } from "../src/health.mjs";

const MIN = 60_000;
const now = 1_000_000_000;

test("a model that just failed is cooling down", () => {
  const data = { models: { "a/b": { fail: 1, lastFail: now - 5 * MIN } } };
  assert.equal(isCoolingDown("a/b", { data, now, cooldownMin: 30 }), true);
});

test("an old failure does not hold a model back forever", () => {
  const data = { models: { "a/b": { fail: 1, lastFail: now - 120 * MIN } } };
  assert.equal(isCoolingDown("a/b", { data, now, cooldownMin: 30 }), false);
});

test("a success after the failure clears it immediately", () => {
  const data = { models: { "a/b": { fail: 1, lastFail: now - 5 * MIN, ok: 1, lastOk: now - 1 * MIN } } };
  assert.equal(isCoolingDown("a/b", { data, now, cooldownMin: 30 }), false);
});

test("an unknown model is not penalised", () => {
  assert.equal(isCoolingDown("never/seen", { data: { models: {} }, now }), false);
});

test("broken candidates move to the back, order is otherwise kept", () => {
  // exactly the reported case: the first free model was down, the second worked
  const data = { models: { "openrouter/z-ai/glm-5.2:free": { fail: 1, lastFail: now - 2 * MIN } } };
  const candidates = [
    "openrouter/z-ai/glm-5.2:free",
    "openrouter/minimax/minimax-m3:free",
    "opencode/glm-4.7-free"
  ];
  const sorted = preferHealthy(candidates, { data, now, cooldownMin: 30 });
  assert.equal(sorted[0], "openrouter/minimax/minimax-m3:free");
  assert.equal(sorted[1], "opencode/glm-4.7-free");
  assert.equal(sorted[2], "openrouter/z-ai/glm-5.2:free", "the broken one goes last, it is not dropped");
});

test("with everything broken the list is unchanged rather than empty", () => {
  const data = { models: {
    "x/1": { fail: 1, lastFail: now - MIN },
    "x/2": { fail: 1, lastFail: now - MIN }
  } };
  assert.deepEqual(preferHealthy(["x/1", "x/2"], { data, now }), ["x/1", "x/2"]);
});
