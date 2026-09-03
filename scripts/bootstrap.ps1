# One-line install for Windows:
#   irm https://raw.githubusercontent.com/RedFeatherXO/werkel/main/scripts/bootstrap.ps1 | iex
#
# That runs code you have not read. The two-step version is identical and lets
# you look first:
#   git clone https://github.com/RedFeatherXO/werkel; cd werkel
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
$ErrorActionPreference = "Stop"

$repo = if ($env:OCFLEET_REPO) { $env:OCFLEET_REPO } else { "https://github.com/RedFeatherXO/werkel" }
$dir  = if ($env:OCFLEET_DIR)  { $env:OCFLEET_DIR }  else { Join-Path $HOME "werkel" }
function Say($m) { Write-Host "  $m" }

Write-Host ""
Write-Host "werkel"
Write-Host ""

foreach ($cmd in @("git", "node")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Say "$cmd not found — install it first"; exit 1 }
}
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) { Say "node $major is too old, need 18+"; exit 1 }

if (Test-Path (Join-Path $dir ".git")) {
  Say "updating $dir"
  git -C $dir pull --ff-only
} else {
  Say "cloning into $dir"
  git clone --depth 1 $repo $dir
}

Set-Location $dir
& powershell -ExecutionPolicy Bypass -File (Join-Path $dir "scripts\install.ps1")
