import { test } from "node:test";
import assert from "node:assert/strict";
import { permissionFor } from "../src/jobs.mjs";

// The workers run with --auto, which auto-answers every permission prompt with
// yes. "ask" is therefore not a restriction, and these cases pin the difference
// between what `readOnly` promises and what it actually allows.

test("a normal job gets no permission override — the worktree is the sandbox", () => {
  assert.equal(permissionFor({ readOnly: false, allowBash: true }), null);
  assert.equal(permissionFor({ readOnly: false, allowBash: false }), null);
});

test("readOnly denies every way of changing a file", () => {
  const p = permissionFor({ readOnly: true, allowBash: false });
  assert.equal(p.edit, "deny");
  assert.equal(p.write, "deny");
  assert.equal(p.patch, "deny");
});

test("readOnly denies bash, because --auto would approve it", () => {
  // The regression this pins: bash used to be "ask", which under --auto meant a
  // read-only worker could still run any command it liked.
  assert.equal(permissionFor({ readOnly: true, allowBash: false }).bash, "deny");
});

test("allowBash opens the shell back up, and only the shell", () => {
  const p = permissionFor({ readOnly: true, allowBash: true });
  assert.equal(p.bash, "allow");
  assert.equal(p.edit, "deny");
  assert.equal(p.write, "deny");
  assert.equal(p.patch, "deny");
});

test("no permission value is ever \"ask\"", () => {
  for (const allowBash of [true, false]) {
    const p = permissionFor({ readOnly: true, allowBash });
    assert.ok(!Object.values(p).includes("ask"),
      `"ask" is auto-approved under --auto, so it must never appear: ${JSON.stringify(p)}`);
  }
});
