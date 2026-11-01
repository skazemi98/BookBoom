# BookBoom web: tiny local server for Windows (no Python needed).
# Serves this folder at http://localhost:5051 so the app can be installed and used offline. Only this computer can reach it.
$ErrorActionPreference = 'Stop'
$port = 5051
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://localhost:$port/"
$types = @{
  '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.mjs'='text/javascript; charset=utf-8';
  '.css'='text/css; charset=utf-8'; '.json'='application/json'; '.webmanifest'='application/manifest+json';
  '.png'='image/png'; '.svg'='image/svg+xml'; '.woff2'='font/woff2'; '.txt'='text/plain; charset=utf-8';
  '.md'='text/plain; charset=utf-8'; '.bcmap'='application/octet-stream'; '.pfb'='application/octet-stream'; '.ttf'='font/ttf'; '.wasm'='application/wasm'
}
try {
  $c = New-Object Net.Sockets.TcpClient
  $c.Connect('127.0.0.1', $port); $c.Close()
  Write-Host "BookBoom is already running: $url"; try { Start-Process $url } catch {}; exit
} catch {}
$listener = New-Object Net.HttpListener
$listener.Prefixes.Add($url)
try { $listener.Start() } catch {
  Write-Host "Couldn't start the local server ($($_.Exception.Message))."
  Write-Host "You can still open index.html directly. Press Enter to close."; Read-Host; exit 1
}
Write-Host "BookBoom is running at $url"
Write-Host "Keep this window open while you use it (after you install the app it also works offline). Close the window to stop."
try { Start-Process $url } catch { Write-Host "Open $url in your browser." }
$rootFull = [IO.Path]::GetFullPath($root)
while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($path -eq '/' -or $path -eq '') { $path = '/index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $rootFull ($path.TrimStart('/') -replace '/', '\')))
    if ($file.StartsWith($rootFull) -and [IO.File]::Exists($file)) {
      $ext = [IO.Path]::GetExtension($file).ToLower()
      $res.ContentType = $(if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' })
      if ($path -eq '/index.html' -or $path -eq '/sw.js') { $res.Headers.Add('Cache-Control', 'no-cache') }
      $bytes = [IO.File]::ReadAllBytes($file)
      $res.ContentLength64 = $bytes.Length
      if ($ctx.Request.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
    } else {
      $res.StatusCode = 404
    }
    $res.Close()
  } catch { try { $res.Abort() } catch {} }
}
