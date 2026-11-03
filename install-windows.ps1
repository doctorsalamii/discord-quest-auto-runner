#Requires -Version 5.1
<#
.SYNOPSIS
  Discord Quest Auto-Runner - Windows installer.

.DESCRIPTION
  Installs the hidden quest supervisor: a Task Scheduler task "discord-quests"
  starts an invisible Node process at logon. The supervisor watches the running
  Discord client, quietly relaunches it with a debug port if needed (once per
  2 minutes max) and injects quests.js. Discord itself is NOT added to autostart -
  you open it whenever you want.

  Files go to %LOCALAPPDATA%\discord-quests.

.USAGE
  Install:
    powershell -ExecutionPolicy Bypass -File install-windows.ps1
    or one line (downloads the script):
    powershell -c "irm https://raw.githubusercontent.com/doctorsalamii/discord-quest-auto-runner/main/install-windows.ps1 | iex"
  Uninstall:
    powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Uninstall
#>
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$Repo  = 'https://raw.githubusercontent.com/doctorsalamii/discord-quest-auto-runner/main'
$Dir   = Join-Path $env:LOCALAPPDATA 'discord-quests'
$Task  = 'discord-quests'

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host " ok  $m" -ForegroundColor Green }

# --- Uninstall ----------------------------------------------------------------
if ($Uninstall) {
  Say "Removing the '$Task' task and installed files..."
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*inject.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
  if (Test-Path $Dir) { Remove-Item $Dir -Recurse -Force }
  Ok "Removed. If Discord is open, the quest script keeps running in it until you restart the client (or run __questsStop() in the console)."
  return
}

# --- 1. Checks ----------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js not found. Install the LTS build from https://nodejs.org and re-run." }
$discordExe = Join-Path $env:LOCALAPPDATA 'Discord\Discord.exe'
if (-not (Test-Path $discordExe)) { throw "Discord client not found at $discordExe. Install it from https://discord.com/download and run it once." }
Ok "Node.js: $($node.Source)"
Ok "Discord: $discordExe"

# --- 2. Files -----------------------------------------------------------------
Say "Installing scripts to $Dir..."
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

# Local repo copies win over downloads (so the installer works from a clone too)
function Install-SourceFile($destName, $url, $localCandidates) {
  $dest = Join-Path $Dir $destName
  foreach ($c in $localCandidates) {
    if ($c -and (Test-Path $c)) { Copy-Item $c $dest -Force; return }
  }
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}

$root = if ($PSScriptRoot) { $PSScriptRoot } else { $null }
Install-SourceFile 'inject.mjs' "$Repo/supervisor/inject.mjs" @(
  $(if ($root) { Join-Path $root 'supervisor\inject.mjs' }),
  $(if ($root) { Join-Path $root 'inject.mjs' })
)
Install-SourceFile 'quests.js' "$Repo/quests-en.js" @(
  $(if ($root) { Join-Path $root 'quests-en.js' }),
  $(if ($root) { Join-Path $root 'quests.js' })
)
Ok "quests.js + inject.mjs installed"

# --- 3. Helper scripts (hidden autostart, launcher, DevTools) ------------------
# Hidden supervisor start: wscript runs node with window style 0 - no console window.
$nodePath  = $node.Source
$injectMjs = Join-Path $Dir 'inject.mjs'
# Whole command line goes into ONE VBS string literal ("" = escaped quote);
# splitting into two literals leaves a bare space between them - a VBS syntax error.
$runLine   = 'CreateObject("WScript.Shell").Run """' + $nodePath + '"" ""' + $injectMjs + '""", 0, False'

$hiddenVbs = Join-Path $Dir 'supervisor-hidden.vbs'
[IO.File]::WriteAllText($hiddenVbs, $runLine + "`r`n", [Text.Encoding]::Default)

# Manual launcher: starts Discord WITH the debug port (for NO_RELAUNCH setups).
$launcherVbs = @(
  'CreateObject("WScript.Shell").Run _',
  '  """" & CreateObject("WScript.Shell").ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Discord\Discord.exe"" --remote-debugging-port=9222", 0, False',
  ''
) -join "`r`n"
[IO.File]::WriteAllText((Join-Path $Dir 'discord-quests.vbs'), $launcherVbs, [Text.Encoding]::Default)

# DevTools keys helper: Discord wipes settings.json on every start, so the keys
# are added while the client is closed (manual console use only - Ctrl+Shift+I).
$dtPs = @'
$p = "$env:APPDATA\discord\settings.json"
$json = Get-Content $p -Raw | ConvertFrom-Json
$json | Add-Member -NotePropertyName "DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING" -NotePropertyValue $true -Force
$json | ConvertTo-Json -Depth 10 | Set-Content $p -Encoding UTF8
Write-Host " [ok] DevTools keys added. Start Discord - Ctrl+Shift+I works for this session."
'@
[IO.File]::WriteAllText((Join-Path $Dir 'enable-devtools.ps1'), $dtPs, [Text.Encoding]::UTF8)

$dtCmd = @(
  '@echo off',
  'rem Enables the Discord console (Ctrl+Shift+I). RUN WHILE DISCORD IS CLOSED -',
  'rem Discord rewrites settings.json (and drops the keys) on every start.',
  'tasklist /FI "IMAGENAME eq Discord.exe" 2>nul | find /I "Discord.exe" >nul',
  'if %errorlevel%==0 (',
  '  echo [!] Discord is running. Close it first, then run this again.',
  '  pause',
  '  exit /b 1',
  ')',
  'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0enable-devtools.ps1"',
  'pause'
) -join "`r`n"
[IO.File]::WriteAllText((Join-Path $Dir 'enable-devtools.cmd'), $dtCmd + "`r`n", [Text.Encoding]::Default)
Ok "supervisor-hidden.vbs, discord-quests.vbs, enable-devtools.cmd"

# --- 4. Task Scheduler ----------------------------------------------------------
# Stop the old instance first: Start-ScheduledTask is a no-op on an already
# Running task, so a re-install would silently keep the previous supervisor
# (with old paths/code) alive.
Say "Registering scheduled task '$Task' (hidden, at logon)..."
try { Stop-ScheduledTask -TaskName $Task -ErrorAction Stop } catch {}
Start-Sleep -Seconds 1
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*inject.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$me        = "$env:COMPUTERNAME\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $me
$action    = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + (Join-Path $Dir 'supervisor-hidden.vbs') + '"')
$settings  = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $Task -Principal $principal -Trigger $trigger -Action $action -Settings $settings -Force | Out-Null
Ok "Task registered (re-run of the installer updates it in place)"

# --- 5. Start now ----------------------------------------------------------------
Start-ScheduledTask -TaskName $Task
Ok "Supervisor started"

Write-Host ""
Ok "Done! Open Discord like you always do - the panel appears on Discover > Quests within ~1-2 minutes."
Write-Host "     Claim rewards on the quest cards. The client may blink once: the supervisor relaunches it with the debug port."
Write-Host "     Logs:     $Dir\supervisor.log"
Write-Host "     Stop:     Stop-ScheduledTask -TaskName $Task"
Write-Host "     Remove:   powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Uninstall"
Write-Host "     No relaunch: create an empty file $Dir\NO_RELAUNCH (then start Discord via $Dir\discord-quests.vbs)"
