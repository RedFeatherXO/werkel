#!/usr/bin/env bash
# One-line install for Linux and macOS:
#   curl -fsSL https://raw.githubusercontent.com/OWNER/werkel/main/scripts/bootstrap.sh | bash
#
# Piping a remote script into a shell means running code you have not read. If
# that bothers you — it reasonably might — the two-step version does the same
# thing and lets you look first:
#   git clone https://github.com/OWNER/werkel && cd werkel && bash scripts/install.sh
set -euo pipefail

REPO="${OCFLEET_REPO:-https://github.com/OWNER/werkel}"
DIR="${OCFLEET_DIR:-$HOME/werkel}"
say() { printf "  %s\n" "$*"; }

echo
echo "werkel"
echo

command -v git  >/dev/null || { say "git not found — install it first"; exit 1; }
command -v node >/dev/null || { say "node not found — install Node 18 or newer"; exit 1; }
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 18 ] || { say "node $NODE_MAJOR is too old, need 18+"; exit 1; }

if [ -d "$DIR/.git" ]; then
  say "updating $DIR"
  git -C "$DIR" pull --ff-only
else
  say "cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
bash scripts/install.sh
