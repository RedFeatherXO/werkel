#!/usr/bin/env bash
# opencode-fleet installer — checks the toolchain, registers the MCP server, installs the skill.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say() { printf "  %s\n" "$*"; }

echo
echo "opencode-fleet setup"
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

mkdir -p "${OPENCODE_FLEET_HOME:-$HOME/.opencode-fleet}"
CFG="${OPENCODE_FLEET_HOME:-$HOME/.opencode-fleet}/fleet.config.json"
if [ ! -f "$CFG" ]; then
  cp "$ROOT/config/fleet.config.example.json" "$CFG"
  say "✓ wrote $CFG  (edit budget + profiles there)"
else
  say "· keeping existing $CFG"
fi

# registers with Claude Code if present, pins absolute binaries, prints the
# desktop-app JSON block
node "$ROOT/bin/ocfleet.mjs" install --scope user

SKILLS_DIR="$HOME/.claude/skills"
mkdir -p "$SKILLS_DIR"
cp -r "$ROOT/skills/opencode-fleet" "$SKILLS_DIR/" 2>/dev/null \
  && say "✓ installed manager skill to $SKILLS_DIR/opencode-fleet" \
  || say "· could not install skill (copy skills/opencode-fleet manually)"

echo
say "next:"
say "  1. opencode auth login                              # openrouter / zai / deepseek / opencode zen"
say "  2. node $ROOT/bin/ocfleet.mjs suggest --write       # profiles from the providers you have"
say "  3. node $ROOT/bin/ocfleet.mjs doctor                # verify"
say "  4. ask Claude: \"delegate the failing parser tests to a cheap worker\""
echo
