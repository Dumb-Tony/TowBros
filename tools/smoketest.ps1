# Tow Bros - headless smoke test.
#
# COPIED from AirportBaggageCrew\tools\smoketest.ps1 (itself from
# SomethingsDifferent\tools\smoketest.ps1) - Dev\INDEX.md -> "Tooling & testing".
#
# There is no Node.js on this machine, so the harness IS a browser. It builds a scratch copy
# of index.html with the suite injected after main.js, serves it over http, drives it in
# headless Chrome, and greps the dumped DOM for the result block. Module scripts execute in
# document order, so the suite always runs AFTER main.js has booted and published window.__TB.
#
# MEASURED, and recorded in Dev\INDEX.md: headless Chrome in --dump-dom mode delivers only 1-3
# requestAnimationFrame callbacks in total. tools\m1-tests.js therefore drives game.step()
# directly instead of waiting for frames. Do not "fix" a hanging test by waiting longer.
#
#   .\tools\smoketest.ps1                          run the milestone-1 suite
#   .\tools\smoketest.ps1 -Tests tools\m1-tests.js -Keep
param(
  [string]$Tests = "tools\m1-tests.js",
  [string]$Game  = "index.html",
  [int]$Port     = 8399,
  [switch]$Keep,
  # Print only failures and the final tally. The full pass list is 250-odd lines and reading it
  # costs more than it tells you once a suite is green.
  [switch]$Quiet
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" }
if (-not (Test-Path $chrome)) { Write-Host "Chrome not found." -ForegroundColor Red; exit 2 }

$gamePath = Join-Path $root $Game
$testPath = Join-Path $root $Tests
if (-not (Test-Path $gamePath)) { Write-Host "Game not found: $gamePath" -ForegroundColor Red; exit 2 }
if (-not (Test-Path $testPath)) { Write-Host "Tests not found: $testPath" -ForegroundColor Red; exit 2 }

# Scratch copy in the served root, so every relative module path still resolves.
# -Encoding UTF8 is REQUIRED: PS 5.1's Get-Content defaults to ANSI, so a UTF-8 source
# file round-trips into double-encoded mojibake and the test runs against a corrupt copy.
#
# NAMED FOR THE PORT. It used to be one fixed filename, which meant -Port bought you a second web
# server and a second browser but not a second scratch page: two harnesses running at once wrote
# the same file, and the second one's <script> tag silently replaced the first one's while it was
# still loading. Anything that runs two suites in parallel — which is the only reason -Port exists —
# could get a run of the wrong tests, or of no tests at all, with no error to say so.
$scratchName = "_smoketest-$Port.html"
$scratch = Join-Path $root $scratchName
$html = Get-Content $gamePath -Raw -Encoding UTF8
if ($html -notmatch '</body>') { Write-Host "No </body> in $Game." -ForegroundColor Red; exit 2 }
$inject = "<script type=""module"" src=""$($Tests -replace '\\','/')""></script>`r`n</body>"
$html = $html -replace '</body>', $inject
Set-Content -Path $scratch -Value $html -Encoding utf8

$server = Start-Process powershell `
  -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","$root\tools\serve.ps1","-NoBrowser","-Port","$Port" `
  -WindowStyle Hidden -PassThru

$url = "http://localhost:$Port/$scratchName"
$tries = 0; $up = $false
while ($tries -lt 40 -and -not $up) {
  try { if ((Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $up = $true } }
  catch { Start-Sleep -Milliseconds 250; $tries++ }
}
if (-not $up) {
  Write-Host "Server never came up on port $Port." -ForegroundColor Red
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  exit 2
}

# NOTE: chrome.exe is a GUI-subsystem binary, so `$x = & chrome --dump-dom` captures
# NOTHING under PowerShell - the DOM has to be redirected to a file. Do not "simplify"
# this back to a direct capture; it silently cost an hour on the last project.
$profileDir = Join-Path $env:TEMP ("tb-smoke-" + [System.Guid]::NewGuid().ToString("N").Substring(0,8))
$domFile    = Join-Path $env:TEMP ("tb-dom-"   + [System.Guid]::NewGuid().ToString("N").Substring(0,8) + ".html")
$proc = Start-Process $chrome -ArgumentList `
  "--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check",
  "--user-data-dir=$profileDir","--window-size=1280,720",
  "--autoplay-policy=no-user-gesture-required",
  "--virtual-time-budget=90000","--dump-dom",$url `
  -RedirectStandardOutput $domFile -NoNewWindow -Wait -PassThru

if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
try { Remove-Item -Recurse -Force $profileDir -ErrorAction Stop } catch {}
if (-not $Keep) { try { Remove-Item $scratch -Force -ErrorAction Stop } catch {} }

$text = ""
if (Test-Path $domFile) { $text = Get-Content $domFile -Raw -Encoding UTF8 }
try { Remove-Item $domFile -Force -ErrorAction Stop } catch {}
if (-not $text) { $text = "" }

$m = [regex]::Match($text, '==TBTEST-BEGIN==(.*?)==TBTEST-END==', 'Singleline')
if (-not $m.Success) {
  Write-Host "No test output found - the page probably crashed before the harness ran." -ForegroundColor Red
  $eb = [regex]::Match($text, 'id="err-banner"[^>]*>(.*?)</div>', 'Singleline')
  if ($eb.Success) { Write-Host ("Error banner: " + $eb.Groups[1].Value.Trim()) -ForegroundColor Red }
  exit 1
}

$body = $m.Groups[1].Value.Trim() -replace '&lt;','<' -replace '&gt;','>' -replace '&amp;','&'
foreach ($line in ($body -split "`n")) {
  $t = $line.Trim()
  if ($t -like 'FAIL*')          { Write-Host $t -ForegroundColor Red }
  elseif ($t -like 'PASS*')      { if (-not $Quiet) { Write-Host $t -ForegroundColor DarkGray } }
  elseif ($t -like '*ALL-PASS*') { Write-Host $t -ForegroundColor Green }
  elseif ($t -like '*FAILURES*') { Write-Host $t -ForegroundColor Red }
  elseif ($t -like '---*')       { if (-not $Quiet) { Write-Host $t } }
  else                           { if (-not $Quiet) { Write-Host $t } }
}
if ($body -match 'ALL-PASS') { exit 0 } else { exit 1 }
