import { test } from "node:test";
import { strict as assert } from "node:assert/strict";
import { classifyFailure } from "../src/failover.mjs";

// Rule 1: a worker that produced anything is never retried.

test("rule 1: non-todowrite tool counts as produced work", () => {
  const job = { state: "failed", exitCode: 1, error: null };
  const parsed = { text: "", tools: [{ tool: "bash", status: "error", target: "x" }], errors: [] };
  const r = classifyFailure(job, parsed);
  assert.equal(r.retryable, false);
  assert.equal(r.category, "worker");
});

test("rule 1: non-empty text counts as produced work", () => {
  const job = { state: "failed" };
  const parsed = { text: "done", tools: [], errors: [] };
  const r = classifyFailure(job, parsed);
  assert.equal(r.category, "worker");
});

// Rule 2: timeout without produced work is retried.

test("rule 2: timeout state is retryable", () => {
  const job = { state: "timeout", error: "killed after 1200s" };
  const parsed = { text: "", tools: [], errors: [] };
  const r = classifyFailure(job, parsed);
  assert.equal(r.retryable, true);
  assert.equal(r.category, "timeout");
});

// Rule 3: recognizable provider problems are retried.

test("rule 3: provider marker in parsed.errors", () => {
  const job = { state: "failed" };
  const parsed = { text: "", tools: [], errors: ["Cannot connect to API: socket closed"] };
  const r = classifyFailure(job, parsed);
  assert.equal(r.retryable, true);
  assert.equal(r.category, "provider");
  assert.ok(r.reason.includes("Cannot connect"));
});

test("rule 3: APIError JSON in job.error is a provider problem", () => {
  const job = {
    state: "failed",
    error: '{"type":"error","error":{"name":"APIError","data":{"message":"Cannot connect to API"}}}'
  };
  const parsed = { text: "", tools: [], errors: [] };
  const r = classifyFailure(job, parsed);
  assert.equal(r.retryable, true);
  assert.equal(r.category, "provider");
  assert.ok(r.reason.includes("APIError"));
});

test("rule 3: standalone status code 429 triggers provider", () => {
  const job = { state: "failed" };
  const parsed = { text: "", tools: [], errors: ["request failed with status 429"] };
  const r = classifyFailure(job, parsed);
  assert.equal(r.category, "provider");
});

test("rule 3: worker tool failure is not a provider problem", () => {
  const job = { state: "failed" };
  const parsed = { text: "", tools: [], errors: ["tool bash: command failed with exit code 1"] };
  const r = classifyFailure(job, parsed);
  assert.equal(r.category, "none");
});

// Rule 4: non-zero exit code without output is retried.

test("rule 4: non-zero exit code is retryable as provider", () => {
  const job = { state: "failed", exitCode: 1, error: null };
  const parsed = { text: "", tools: [], errors: [] };
  const r = classifyFailure(job, parsed);
  assert.equal(r.retryable, true);
  assert.equal(r.category, "provider");
  assert.ok(r.reason.includes("opencode exited"));
});

// Rule 5: nothing retryable falls through to none.

test("rule 5: no failure falls through to none", () => {
  const job = { state: "failed", exitCode: 0 };
  const parsed = { text: "", tools: [], errors: [] };
  const r = classifyFailure(job, parsed);
  assert.equal(r.retryable, false);
  assert.equal(r.category, "none");
});

// Edge cases.

test("edge: only a todowrite tool does not count as work", () => {
  const job = { state: "failed", exitCode: 0 };
  const parsed = { text: "", tools: [{ tool: "todowrite", status: "completed", target: "x" }], errors: [] };
  const r = classifyFailure(job, parsed);
  assert.equal(r.category, "none");
});

test("edge: whitespace-only text does not count as work", () => {
  const job = { state: "failed", exitCode: 0 };
  const parsed = { text: "   \n\t ", tools: [], errors: [] };
  const r = classifyFailure(job, parsed);
  assert.equal(r.category, "none");
});

test("edge: 1429 in error text does not trigger provider", () => {
  const job = { state: "failed", exitCode: 0 };
  const parsed = { text: "", tools: [], errors: ["job id 1429 errored"] };
  const r = classifyFailure(job, parsed);
  assert.equal(r.category, "none");
});

test("edge: classifyFailure(undefined, undefined) does not throw", () => {
  const r = classifyFailure(undefined, undefined);
  assert.equal(r.retryable, false);
  assert.equal(r.category, "none");
});

test("edge: malformed parsed still classifies safely", () => {
  const job = { state: "timeout" };
  const r = classifyFailure(job, { tools: "nope", errors: {}, text: 42 });
  assert.equal(r.retryable, true);
  assert.equal(r.category, "timeout");
});