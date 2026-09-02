#!/usr/bin/env node
// Runs the mock server's self-test with whichever python this machine has.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "mock_llm_selftest.py");
for (const py of ["python3", "python"]) {
  const probe = spawnSync(py, ["-c", "print(1)"], { encoding: "utf8" });
  if (probe.status !== 0) continue;
  const r = spawnSync(py, [script], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
console.error("no python interpreter found (tried python3, python) — skipping the mock self-test");
process.exit(0);
