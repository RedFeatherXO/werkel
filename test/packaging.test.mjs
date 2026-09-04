import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// A rename is the easiest way to ship a broken installer, because the installer
// is the one code path nobody runs: every machine that already has a config
// skips the copy, so the dangling reference only surfaces on a stranger's fresh
// box. That is exactly how `config/fleet.config.example.json` survived the rename
// to werkel and then failed on the first real Windows install.
//
// So: every repo path a shipped script names must exist, and must be in git —
// a file that exists only here is missing from every clone.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The files that decide whether a fresh install works. */
const SHIPPED = [
  "scripts/install.sh",
  "scripts/install.ps1",
  "scripts/bootstrap.sh",
  "scripts/bootstrap.ps1",
  "package.json",
  "dashboard/Dockerfile"
].filter((f) => fs.existsSync(path.join(ROOT, f)));

const DIRS = ["bin", "src", "config", "scripts", "skills", "dashboard", "test"];

/** Prose puts punctuation after a path; the path stops before it. */
const clean = (raw) => raw.replace(/\\/g, "/").replace(/^[("'`]+/, "").replace(/[.,;:)\]"'`/]+$/, "");

/**
 * Every repo-relative path a file names.
 *
 * Two shapes, because the two installers write paths differently: the shell one
 * puts a whole path in one word behind a variable, and PowerShell assembles it
 * from Join-Path segments. Reading only one of them would leave the other
 * unguarded while looking guarded, which is worse than no test.
 */
function referencedPaths(text) {
  const out = new Set();
  const add = (raw) => {
    const rel = clean(String(raw));
    if (!rel || /[*?]/.test(rel) || /^[A-Za-z]:/.test(rel)) return;
    if (DIRS.some((d) => rel === d || rel.startsWith(d + "/"))) out.add(rel);
  };

  for (const word of text.split(/[\s"'`(),;|=]+/)) {
    // "$ROOT/config/x", "${dir}/x", "%DIR%\x" — the variable is not part of the path
    const w = word.replace(/\\/g, "/")
      .replace(/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\//, "")
      .replace(/^%[A-Za-z_][A-Za-z0-9_]*%\//, "");
    add(w);
  }

  for (const re of [
    /Join-Path\s*\(\s*Join-Path\s*\$\w+\s*"([^"]+)"\s*\)\s*"([^"]+)"/g,
    /Join-Path\s*\$\w+\s*"([^"]+)"/g
  ]) {
    for (const m of text.matchAll(re)) add(m.slice(1).filter(Boolean).join("/"));
  }
  return [...out];
}

/**
 * Everything that will be in the repository after a `git add -A`.
 *
 * Not `git ls-files` alone: that lists the index, so a file written five minutes
 * ago counts as "missing from every clone" until someone commits it — which made
 * this test fail in the one place it must not, a script that gates a push on the
 * suite being green. The file it complained about was the fix it was blocking.
 *
 * The honest question is not "is it committed yet" — a working copy cannot know
 * that — but "can it ever get there". A file present and not ignored will be
 * committed by the next `git add -A`; a file matched by .gitignore never will be,
 * however long it sits there. That is the hazard worth failing on.
 */
const willReachAClone = (() => {
  try {
    return new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: ROOT, encoding: "utf8" })
      .split("\n").map((l) => l.trim()).filter(Boolean));
  } catch {
    return null; // no git here (a tarball, a container) — existence still applies
  }
})();

test("every repo path a shipped script names actually exists", () => {
  const missing = [];
  for (const file of SHIPPED) {
    for (const rel of referencedPaths(fs.readFileSync(path.join(ROOT, file), "utf8"))) {
      if (!fs.existsSync(path.join(ROOT, rel))) missing.push(`${file} → ${rel}`);
    }
  }
  assert.deepEqual(missing, [], `a shipped script points at files that are not here:\n  ${missing.join("\n  ")}`);
});

test("and none of them is ignored by git, so a clone gets them too", { skip: !willReachAClone }, () => {
  const ignored = [];
  for (const file of SHIPPED) {
    for (const rel of referencedPaths(fs.readFileSync(path.join(ROOT, file), "utf8"))) {
      if (!fs.existsSync(path.join(ROOT, rel))) continue; // the test above owns this
      // A directory counts as present when anything beneath it will ship.
      const isDir = fs.statSync(path.join(ROOT, rel)).isDirectory();
      const ok = isDir
        ? [...willReachAClone].some((t) => t.startsWith(rel + "/"))
        : willReachAClone.has(rel);
      if (!ok) ignored.push(`${file} → ${rel}`);
    }
  }
  assert.deepEqual(ignored, [],
    `a shipped script needs these, but .gitignore keeps them out of every clone:\n  ${ignored.join("\n  ")}`);
});

test("no shipped script still calls the project by an old name", () => {
  // `opencode-fleet` survives on purpose in exactly one role: the pre-rename
  // skill directory that `werkel skill` and `doctor` clean up. Anywhere in an
  // installer it would be a leftover.
  const stale = [];
  for (const file of SHIPPED) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    text.split("\n").forEach((line, i) => {
      if (/\bocfleet\b/.test(line) || /fleet\.config/.test(line) || /FLEET_INGEST_TOKEN/.test(line)) {
        stale.push(`${file}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(stale, [], `old project names left in shipped scripts:\n  ${stale.join("\n  ")}`);
});

test("the config the installer copies is a config, not a placeholder", () => {
  // Copying a file that parses as nothing would fail later and further away.
  const example = path.join(ROOT, "config", "werkel.config.example.json");
  assert.ok(fs.existsSync(example), "the installer's starting config must ship");
  const cfg = JSON.parse(fs.readFileSync(example, "utf8"));
  assert.ok(cfg.budget, "it must carry a budget block, or the guard has nothing to enforce");
  assert.ok(cfg.profiles && Object.keys(cfg.profiles).length, "and profiles to route to");
});

test("the CLI entry point the installers invoke really is one", () => {
  const bin = path.join(ROOT, "bin", "werkel.mjs");
  const text = fs.readFileSync(bin, "utf8");
  assert.match(text.split("\n")[0], /^#!/, "it is invoked directly on unix, so it needs a shebang");
  // Every command the installers and the docs call has to exist, or a fresh
  // install fails at the last step with an unknown-command error.
  for (const cmd of ["install", "link", "skill", "doctor", "statusline"]) {
    assert.match(text, new RegExp(`async ${cmd}\\s*\\(`), `bin/werkel.mjs is missing the \`${cmd}\` command`);
  }
});

test("no doc shows a fake path that someone would paste verbatim", () => {
  // A config block with a stand-in path in it gets copied exactly as printed —
  // and then fails as `Server disconnected`, which names neither the path nor
  // the paste. Print the real block instead of illustrating a fake one.
  const docs = ["README.md", "docs/ARCHITECTURE.md", "dashboard/README.md", "skills/werkel/SKILL.md"]
    .filter((f) => fs.existsSync(path.join(ROOT, f)));
  const found = [];
  for (const file of docs) {
    fs.readFileSync(path.join(ROOT, file), "utf8").split("\n").forEach((line, i) => {
      if (!/mcpServers|"command"|"args"|mcp add/.test(line)) return;
      if (/\/abs\/|\/path\/to\/|<path>|YOUR_PATH|\/your\//i.test(line)) {
        found.push(`${file}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(found, [], `a placeholder path sits inside a config block:\n  ${found.join("\n  ")}`);
});
