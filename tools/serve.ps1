# Tow Bros dev server - started by play.bat (double-click friendly).
#
# COPIED from AirportBaggageCrew	oolsserve.ps1 (DevINDEX.md -> Testing).
#
# Serving over http is REQUIRED, not a convenience: the game is ES modules, and browsers
# block module loads on file:// (CORS). GDD 21.1 asked for "open index.html"; that is not
# possible with modules, so this is the documented substitute. See README.
#
# Ports 8381-8390, chosen to sit clear of Chameleon (8321-8330), Something's Different
# (8341-8350) and Airport Baggage Crew (8361-8370), so all four can run at once.
#   -NoBrowser   don't launch a browser tab (used by tools\smoketest.ps1)
#   -Port <n>    try this exact port instead of scanning 8381-8390
param([switch]$NoBrowser, [int]$Port = 0)
$root = Split-Path $PSScriptRoot -Parent
$mime = @{ ".html"="text/html"; ".js"="text/javascript"; ".mjs"="text/javascript";
           ".css"="text/css"; ".json"="application/json"; ".png"="image/png";
           ".jpg"="image/jpeg"; ".svg"="image/svg+xml"; ".ico"="image/x-icon";
           ".woff2"="font/woff2"; ".map"="application/json" }

$listener = $null
$ports = if ($Port -gt 0) { @($Port) } else { 8381..8390 }
foreach ($p in $ports) {
  try {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://localhost:$p/")
    $l.Start()
    $listener = $l
    break
  } catch { }
}
if (-not $listener) {
  Write-Host "Could not find a free port ($($ports -join ', '))."
  if (-not $NoBrowser) { Read-Host "Press Enter to close" }
  exit 1
}

$url = $listener.Prefixes | Select-Object -First 1
Write-Host ""
Write-Host "  TOW BROS is running at $url" -ForegroundColor Green
Write-Host "  Keep this window open while you play. Close it to stop." -ForegroundColor DarkGray
Write-Host ""
if (-not $NoBrowser) { Start-Process $url }

while ($listener.IsListening) {
  try {
    $ctx  = $listener.GetContext()
    $path = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ($path -eq '') { $path = 'index.html' }
    $file = Join-Path $root $path
    if ((Test-Path $file -PathType Leaf) -and ((Resolve-Path $file).Path.StartsWith($root))) {
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      $ctx.Response.ContentType = if ($mime[$ext]) { $mime[$ext] } else { "application/octet-stream" }
      # no-store: a cached module during a test run is a false green
      $ctx.Response.Headers.Add("Cache-Control", "no-store")
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
    $ctx.Response.Close()
  } catch { }
}
