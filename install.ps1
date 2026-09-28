#Requires -Version 5.1
<#
  debtaur-eos local install + smoke test (Windows).
  Usage:  powershell -ExecutionPolicy Bypass -File install.ps1
  Needs:  Node.js 22+ on PATH. Zero npm dependencies.
#>
$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Output "Node.js not found. Install Node 22+ from https://nodejs.org/ then re-run this script."
  exit 1
}
$ver = (node -e "console.log(process.versions.node)").Trim()
$major = [int]($ver.Split(".")[0])
if ($major -lt 22) {
  Write-Output "Node $ver found, but this demo needs Node 22+. Update Node, then re-run."
  exit 1
}
Write-Output "Node $ver OK — zero dependencies to install."

Write-Output "Smoke test: running the guided four-outcome sequence..."
$out = "5`n`n`n`n`n`n8" | npm start 2>&1 | Out-String
if ($out -notmatch "all four outcomes as expected") {
  Write-Output "SMOKE TEST FAILED — output was:"
  Write-Output $out
  exit 1
}
Write-Output "Smoke test passed: allow, refusal, escalation, integrity-refusal."
Write-Output ""
Write-Output "Run the CLI demo:      npm start"
Write-Output "Run the browser demo:  npm run demo   then open http://localhost:8080/"
