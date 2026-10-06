# Tiny static file server for the Tianhe demo (Windows PowerShell 5.1+, nothing to install): serves ..\game on
# 127.0.0.1 (the first free port from 4299), opens the browser, runs until the window is closed.
# Plain TcpListener on loopback: no admin rights, no firewall prompt. One thread, polling: a connection is only
# read once it has bytes waiting, so an idle speculative connection from the browser never blocks the rest.
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\game'))
$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'; '.glb' = 'model/gltf-binary'
  '.gltf' = 'model/gltf+json'; '.bin' = 'application/octet-stream'; '.wasm' = 'application/wasm'; '.png' = 'image/png'
  '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.webp' = 'image/webp'; '.svg' = 'image/svg+xml'; '.ktx2' = 'image/ktx2'
  '.txt' = 'text/plain; charset=utf-8'; '.ico' = 'image/x-icon'; '.mp3' = 'audio/mpeg'; '.ogg' = 'audio/ogg'; '.wav' = 'audio/wav'
}

$listener = $null
$port = 0
foreach ($p in 4299..4399) {
  try {
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
    $l.Start()
    $listener = $l; $port = $p
    break
  } catch { }
}
if (-not $listener) { Write-Host '找不到空闲端口（4299-4399 都被占用了）'; exit 1 }

$url = "http://127.0.0.1:$port/"
Write-Host ''
Write-Host "  广州 · 天河 demo 已启动：$url"
Write-Host ''
Write-Host '  浏览器没有自动打开的话，把上面的地址复制到 Chrome / Edge 里。'
Write-Host '  玩的时候别关这个窗口；关掉窗口游戏就停了。'
Write-Host ''
try { Start-Process $url } catch { }

$ascii = [System.Text.Encoding]::ASCII

function Send-Head($stream, [string]$status, [string]$type, [long]$length) {
  $h = "HTTP/1.1 $status`r`nContent-Type: $type`r`nContent-Length: $length`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
  $b = $ascii.GetBytes($h)
  $stream.Write($b, 0, $b.Length)
}

function Serve($stream, [string]$request) {
  $line = $request.Substring(0, $request.IndexOf("`r`n"))
  $parts = $line.Split(' ')
  $method = $parts[0]
  if ($parts.Length -lt 2 -or ($method -ne 'GET' -and $method -ne 'HEAD')) { Send-Head $stream '405 Method Not Allowed' 'text/plain' 0; return }
  $path = $parts[1]
  $q = $path.IndexOfAny([char[]]'?#')
  if ($q -ge 0) { $path = $path.Substring(0, $q) }
  $path = [System.Uri]::UnescapeDataString($path)
  if ($path -eq '/') { $path = '/index.html' }
  $file = [System.IO.Path]::GetFullPath((Join-Path $root ($path.TrimStart('/').Replace('/', '\'))))
  if ([System.IO.Directory]::Exists($file)) { $file = Join-Path $file 'index.html' }
  if ($path.Contains('..') -or -not $file.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -or -not [System.IO.File]::Exists($file)) {
    $m = $ascii.GetBytes("not found: $path")
    Send-Head $stream '404 Not Found' 'text/plain' $m.Length
    $stream.Write($m, 0, $m.Length)
    return
  }
  $ext = [System.IO.Path]::GetExtension($file).ToLowerInvariant()
  $type = $mime[$ext]
  if (-not $type) { $type = 'application/octet-stream' }
  $fs = [System.IO.File]::OpenRead($file)
  try {
    Send-Head $stream '200 OK' $type $fs.Length
    if ($method -eq 'GET') { $fs.CopyTo($stream, 262144) }
  } finally { $fs.Dispose() }
}

$clients = New-Object System.Collections.ArrayList
while ($true) {
  $busy = $false
  while ($listener.Pending()) {
    $c = $listener.AcceptTcpClient()
    [void]$clients.Add(@{ c = $c; t = [DateTime]::UtcNow; buf = New-Object System.Text.StringBuilder })
    $busy = $true
  }
  for ($i = $clients.Count - 1; $i -ge 0; $i--) {
    $st = $clients[$i]
    $c = $st.c
    $done = $false
    try {
      if ($c.Available -gt 0) {
        $busy = $true
        $ns = $c.GetStream()
        $bytes = New-Object byte[] ($c.Available)
        $n = $ns.Read($bytes, 0, $bytes.Length)
        [void]$st.buf.Append($ascii.GetString($bytes, 0, $n))
        $text = $st.buf.ToString()
        if ($text.Contains("`r`n`r`n")) {
          Serve $ns $text
          $ns.Flush()
          $done = $true
        }
      } elseif (([DateTime]::UtcNow - $st.t).TotalSeconds -gt 20) {
        $done = $true
      }
    } catch {
      $done = $true
    }
    if ($done) {
      try { $c.Close() } catch { }
      $clients.RemoveAt($i)
    }
  }
  if (-not $busy) { Start-Sleep -Milliseconds 3 }
}
