# werkel installer - checks the toolchain, registers the MCP server, installs the skill.
# PowerShell counterpart to scripts/install.sh. Runs on Windows PowerShell 5.1 and PowerShell 7+.
#
# If execution policy blocks scripts, run it with:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
#
# No admin rights needed; nothing is written to the registry or the PATH.

$ErrorActionPreference = "Stop"

# repo root = one level above scripts/, so the script works from any working directory
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$root = Split-Path -Parent $scriptDir
$binOcfleet = Join-Path (Join-Path $root "bin") "werkel.mjs"
$exampleConfig = Join-Path (Join-Path $root "config") "fleet.config.example.json"
$skillSource = Join-Path (Join-Path $root "skills") "werkel"

function Say([string]$msg) { Write-Host "  $msg" }

# runs "<name> --version" and returns the first output line, or "?" on any failure
function Get-CliVersion([string]$name) {
  try {
    $out = & $name --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $out) { return ([string]($out | Select-Object -First 1)) }
  } catch { }
  return "?"
}

Write-Host ""
Write-Host "werkel setup"
Write-Host ""

# 1. node >= 18
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Say "[!!] node not found - install Node 18+ (https://nodejs.org)"
  exit 1
}
$nodeVersion = ([string](& node -v))
try {
  $nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
} catch {
  Say "[!!] could not determine the node version - reinstall Node 18+"
  exit 1
}
if ($nodeMajor -lt 18) {
  Say "[!!] node $nodeVersion is too old, need 18+"
  exit 1
}
Say "[ok] node $nodeVersion"

# 2. git - worktree isolation needs it
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Say "[!!] git not found - worktree isolation needs it (https://git-scm.com/download/win)"
  exit 1
}
$gitVersion = ([string](& git --version)) -replace "^git version ", ""
Say "[ok] git $gitVersion"

# 3. opencode - npm packages on Windows only show up on the PATH after a new terminal sometimes
if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
  Say "[--] opencode not found - installing (npm i -g opencode-ai)"
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Say "[!!] npm not found - reinstall Node 18+ so npm is on the PATH"
    exit 1
  }
  & npm i -g opencode-ai
  if ($LASTEXITCODE -ne 0) {
    Say "[!!] npm i -g opencode-ai failed (exit code $LASTEXITCODE)"
    exit 1
  }
  if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
    Say "[!!] opencode is still not on the PATH after installing."
    Say "     npm global packages sometimes only appear in a NEW terminal on Windows."
    Say "     Open a fresh PowerShell window and re-run this script."
    exit 1
  }
}
Say "[ok] opencode $(Get-CliVersion opencode)"

# 4. werkel config: $env:WERKEL_HOME, falling back to $HOME\.werkel
$fleetHome = $env:WERKEL_HOME
if ([string]::IsNullOrWhiteSpace($fleetHome)) { $fleetHome = Join-Path $HOME ".werkel" }
New-Item -ItemType Directory -Force -Path $fleetHome | Out-Null
$fleetConfig = Join-Path $fleetHome "werkel.config.json"
if (Test-Path $fleetConfig) {
  Say "[--] keeping existing $fleetConfig"
} else {
  try {
    Copy-Item -Force -Path $exampleConfig -Destination $fleetConfig
    Say "[ok] wrote $fleetConfig  (edit budget + profiles there)"
  } catch {
    Say "[!!] could not write $fleetConfig : $_"
    exit 1
  }
}

# 5. registers the MCP server with Claude Code if present, pins absolute binaries,
#    prints the JSON block for the Claude desktop app
& node $binOcfleet install --scope user
if ($LASTEXITCODE -ne 0) {
  Say "[!!] node bin\werkel.mjs install --scope user failed (exit code $LASTEXITCODE)"
  exit 1
}

# 6. manager skill into ~/.claude/skills (overwrite an existing copy)
$skillsDir = Join-Path (Join-Path $HOME ".claude") "skills"
$skillTarget = Join-Path $skillsDir "werkel"
try {
  New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null
  if (Test-Path $skillTarget) { Remove-Item -Recurse -Force $skillTarget }
  Copy-Item -Recurse -Force -Path $skillSource -Destination $skillsDir
  Say "[ok] installed manager skill to $skillTarget"
} catch {
  Say "[--] could not install skill (copy skills\werkel to $skillsDir manually)"
}

# 7. make `werkel` callable — the docs referred to it long before anything set it up
Write-Host ""
& node "$binOcfleet" link

# 8. next steps
Write-Host ""
Say "next:"
Say "  1. opencode auth login                              # openrouter / zai / deepseek / opencode zen"
Say "  2. werkel suggest --write                          # profiles from the providers you have"
Say "  3. werkel doctor                                   # verify"
Say "     (not on your PATH yet? use .\werkel from this folder)"
Say "  4. ask Claude: ""delegate the failing parser tests to a cheap worker"""
Write-Host ""
