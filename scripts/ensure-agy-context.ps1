# Re-applies the 1M context patch after `agy update` replaced the binary.
#
#   powershell -ExecutionPolicy Bypass -File scripts/ensure-agy-context.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/ensure-agy-context.ps1 -CheckOnly
#
# Windows locks a running agy.exe, so this stops agy processes first, patches a
# temporary copy, then swaps it in. The original is kept as agy.exe.bak.
param(
  [string]$Binary = "$env:LOCALAPPDATA\agy\bin\agy.exe",
  [string]$Patcher = (Join-Path $PSScriptRoot "vendor\agy-patch.py"),
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Binary)) { Write-Error "agy binary not found: $Binary"; exit 2 }
if (-not (Test-Path $Patcher)) { Write-Error "patcher not found: $Patcher"; exit 2 }
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { Write-Error "python is required"; exit 2 }

$dry = & python $Patcher --binary $Binary --dry-run 2>&1 | Out-String
if ($dry -match "already unlocked|already patched") {
  Write-Output "agy context patch: already applied"
  exit 0
}
if ($CheckOnly) {
  Write-Output "agy context patch: NOT applied (run without -CheckOnly to apply)"
  exit 1
}

$tmp = Join-Path $env:TEMP ("agy-patched-" + [guid]::NewGuid().ToString("N") + ".exe")
Copy-Item $Binary $tmp -Force
try {
  & python $Patcher --binary $tmp --in-place | Out-String | Write-Output
  if ($LASTEXITCODE -ne 0) { throw "patcher failed with exit code $LASTEXITCODE" }
} catch {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  Write-Error $_
  exit 1
}

# A running agy holds an exclusive handle on its image.
Get-Process agy -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 400

$backup = "$Binary.bak"
if (-not (Test-Path $backup)) { Copy-Item $Binary $backup -Force }
Copy-Item $tmp $Binary -Force
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

$hash = (Get-FileHash $Binary).Hash.Substring(0, 12)
Write-Output "agy context patch: applied (sha256 $hash, backup $backup)"
Write-Output "Restart the Antigravity CLI / OpenCode so the new binary is used."
