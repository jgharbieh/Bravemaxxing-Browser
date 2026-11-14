<#
brave-debug.ps1 - put YOUR Brave into CDP mode in one fast motion (Windows).

  - CDP already up on the port  -> reuse, change nothing (instant).
  - Otherwise: close Brave, mark the last exit as clean (no "restore pages?" popup),
    relaunch with --remote-debugging-port and --restore-last-session (all windows and tabs back).

WARNING: this force-closes every Brave window and rewrites "exit_type" in each profile's Preferences file.
The relaunched window takes focus. brave-agent-ready only calls this when BRAVE_RELAUNCH_OK=1 is set.

Why not a profile copy: Chromium's App-Bound Encryption ties cookies to the default user-data dir, so a
copied profile opens signed out.

Usage:  brave-debug.ps1 [-Port 9222] [-Force]
  -Force  restart even if CDP is already up
Env:    BRAVE_PATH = path to brave.exe (else the standard install locations are tried)
#>
param([int]$Port = 9222, [switch]$Force)
$ErrorActionPreference = 'Stop'

$brave = $env:BRAVE_PATH
if (-not $brave) {
    $brave = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) |
        Where-Object { $_ } |
        ForEach-Object { Join-Path $_ 'BraveSoftware\Brave-Browser\Application\brave.exe' } |
        Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $brave -or -not (Test-Path $brave)) { Write-Output 'Brave not found. Set BRAVE_PATH to brave.exe.'; exit 1 }
$ud = Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data'

function Test-Cdp {
    # Raw TCP probe first: far cheaper than an HTTP request while the port is still closed.
    $c = New-Object Net.Sockets.TcpClient
    try { if (-not $c.ConnectAsync('127.0.0.1', $Port).Wait(150)) { return $false } } catch { return $false } finally { $c.Dispose() }
    try { Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 1 | Out-Null; $true } catch { $false }
}

if (-not $Force -and (Test-Cdp)) { Write-Output "CDP already on $Port - reusing your Brave, nothing restarted."; exit 0 }

$t = [Diagnostics.Stopwatch]::StartNew(); $marks = @()

# 1) Close Brave. Safety check: if it's still open, wait 0.5 s and check again; still open at 1 s -> kill
#    again; still open at 3 s -> abort WITHOUT relaunching, because starting a new Brave onto a half-closed
#    one is what can lose the session.
function Stop-Brave { Get-Process brave -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }
Stop-Brave
$rekilled = $false
while (Get-Process brave -ErrorAction SilentlyContinue) {
    if ($t.Elapsed.TotalSeconds -ge 3) {
        Write-Output 'ABORTED: Brave did not close within 3 s. Nothing relaunched; your session is untouched. Close Brave yourself and rerun.'
        exit 1
    }
    if (-not $rekilled -and $t.Elapsed.TotalSeconds -ge 1) { Stop-Brave; $rekilled = $true }
    Start-Sleep -Milliseconds 500
}
$marks += 'close {0:N1}s{1}' -f $t.Elapsed.TotalSeconds, $(if ($rekilled) { ' (re-killed)' } else { '' })

# 2) Mark the forced exit as clean so Brave doesn't show the crash-restore popup.
foreach ($dir in [IO.Directory]::GetDirectories($ud)) {
    if ($dir -notmatch '\\(Default|Profile \d+)$') { continue }
    $pref = Join-Path $dir 'Preferences'
    if (-not [IO.File]::Exists($pref)) { continue }
    $raw = [IO.File]::ReadAllText($pref)
    $fixed = $raw.Replace('"exit_type":"Crashed"', '"exit_type":"Normal"').Replace('"exited_cleanly":false', '"exited_cleanly":true')
    if ($fixed -ne $raw) { [IO.File]::WriteAllText($pref, $fixed) }
}
$marks += 'prefs {0:N1}s' -f $t.Elapsed.TotalSeconds

# 3) Relaunch and wait for CDP.
Start-Process $brave -ArgumentList "--remote-debugging-port=$Port", '--restore-last-session'
$up = $false
for ($i = 0; $i -lt 200 -and -not $up; $i++) { $up = Test-Cdp; if (-not $up) { Start-Sleep -Milliseconds 50 } }
$marks += 'cdp {0:N1}s' -f $t.Elapsed.TotalSeconds
Write-Output ("Brave {0} with CDP on {1}, tabs restored. Total {2:N1}s ({3})." -f $(if ($up) { 'back' } else { 'started but CDP NOT responding' }), $Port, $t.Elapsed.TotalSeconds, ($marks -join ', '))
