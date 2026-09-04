#!/usr/bin/env bash
# werkel installer — checks the toolchain, registers the MCP server, installs the skill.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say() { printf "  %s\n" "$*"; }

echo
echo "werkel setup"
echo

command -v node >/dev/null || { say "✗ node not found — install Node 18+"; exit 1; }
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 18 ] || { say "✗ node $NODE_MAJOR is too old, need 18+"; exit 1; }
say "✓ node $(node -v)"

command -v git >/dev/null || { say "✗ git not found — worktree isolation needs it"; exit 1; }
say "✓ git $(git --version | awk '{print $3}')"

if ! command -v opencode >/dev/null; then
  say "· opencode not found — installing (npm i -g opencode-ai)"
  npm i -g opencode-ai
fi
say "✓ opencode $(opencode --version 2>/dev/null || echo '?')"

mkdir -p "${WERKEL_HOME:-$HOME/.werkel}"
CFG="${WERKEL_HOME:-$HOME/.werkel}/werkel.config.json"
if [ ! -f "$CFG" ]; then
  cp "$ROOT/config/werkel.config.example.json" "$CFG"
  say "✓ wrote $CFG  (edit budget + profiles there)"
else
  say "· keeping existing $CFG"
fi

# registers with Claude Code if present, pins absolute binaries, prints the
# desktop-app JSON block
node "$ROOT/bin/werkel.mjs" install --scope user

# put `werkel` on the PATH — the docs referred to it long before anything created it
node "$ROOT/bin/werkel.mjs" link

# manager skill into ~/.claude/skills — one code path with `werkel skill`, so a
# re-run refreshes a stale copy and clears the pre-rename opencode-fleet skill
node "$ROOT/bin/werkel.mjs" skill || say "· could not install skill (run: node bin/werkel.mjs skill)"

echo
say "next:"
say "  1. opencode auth login                              # openrouter / zai / deepseek / opencode zen"
say "  2. werkel suggest --write                          # profiles from the providers you have"
say "  3. werkel doctor                                   # verify"
say "     (if 'werkel' is not found, open a new shell or use $ROOT/werkel)"
say "  4. ask Claude: \"delegate the failing parser tests to a cheap worker\""
echo
