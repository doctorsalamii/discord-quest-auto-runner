# Windows auto-start (optional)

The script itself works on Windows the same way — paste `quests-en.js` into the Discord console and it runs. This guide adds the same "survives restarts" automation that the Linux installer sets up: a tiny supervisor keeps the quest script injected into a running client.

Windows specifics (different from Linux, by design):

- the supervisor **does not start Discord for you** — you open the client whenever you want, no Discord in your autostart;
- if Discord is running **without** the debug port (i.e. you started it normally), the supervisor quietly relaunches it with the port once (the client blinks) and injects the script;
- the supervisor runs **hidden** — no console window.

## One command (auto-installer)

```powershell
powershell -c "irm https://raw.githubusercontent.com/doctorsalamii/discord-quest-auto-runner/main/install-windows.ps1 | iex"
```

(or download the repo and run `powershell -ExecutionPolicy Bypass -File install-windows.ps1`)

What it does:

- checks Node.js LTS and the Discord client;
- installs `quests.js`, `inject.mjs` and helper scripts to `%LOCALAPPDATA%\discord-quests`;
- registers a Task Scheduler task **`discord-quests`** that starts the hidden supervisor at logon.

Then just open Discord normally. The panel appears on the Quests tab within ~1–2 minutes. Claim rewards on the quest cards.

Manage it:

```powershell
Stop-ScheduledTask -TaskName discord-quests       # stop the supervisor now
Disable-ScheduledTask -TaskName discord-quests    # keep, but no autostart at logon
Unregister-ScheduledTask -TaskName discord-quests # remove the task (or run install-windows.ps1 -Uninstall)
Get-Content "$env:LOCALAPPDATA\discord-quests\supervisor.log" -Tail 20   # logs
```

To forbid the auto-relaunch (you start Discord yourself — with the bundled `discord-quests.vbs` launcher, which adds the debug port): create an empty file `%LOCALAPPDATA%\discord-quests\NO_RELAUNCH`.

## Manual setup

### 1. Files

Copy `supervisor/inject.mjs` from this repo to `%LOCALAPPDATA%\discord-quests\inject.mjs`, and `quests-en.js` next to it as `quests.js`. The supervisor reads `quests.js` from this folder on **both** Linux (`~/.local/share/discord-quests/`) and Windows (`%LOCALAPPDATA%\discord-quests\`) — it does **not** look next to `inject.mjs`.

### 2. Hidden supervisor + autostart at logon

Create `%LOCALAPPDATA%\discord-quests\supervisor-hidden.vbs` (this is what hides the console window — starting `node inject.mjs` from Task Scheduler directly would show a terminal; adjust the node path to yours, `where node` tells it):

```vbs
CreateObject("WScript.Shell").Run """C:\Program Files\nodejs\node.exe"" ""%LOCALAPPDATA%\discord-quests\inject.mjs""", 0, False
```

Note: `%LOCALAPPDATA%` inside the `.mjs` path is not expanded by VBS here — put the full path in (`C:\Users\<you>\AppData\Local\discord-quests\inject.mjs`).

Register the Task Scheduler task (PowerShell):

```powershell
$me = "$env:COMPUTERNAME\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $me
$action    = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + "$env:LOCALAPPDATA\discord-quests\supervisor-hidden.vbs" + '"')
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName 'discord-quests' -Principal $principal -Trigger $trigger -Action $action -Settings $settings -Force
```

(Equivalent GUI steps: **Create Task** → run only when user is logged on; trigger **At log on**; action: `wscript.exe` with the `.vbs` path as the argument; allow run on demand, restart on failure.)

### 3. Optional: launcher for "start Discord with the port by hand"

Only needed with `NO_RELAUNCH`. Create `%LOCALAPPDATA%\discord-quests\discord-quests.vbs`:

```vbs
CreateObject("WScript.Shell").Run _
  """" & CreateObject("WScript.Shell").ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Discord\Discord.exe"" --remote-debugging-port=9222", 0, False
```

This starts the **root** `%LOCALAPPDATA%\Discord\Discord.exe`, which launches the actual build from `app-<version>\` with the port. ⚠️ Two variants that look tempting but **don't work**:

- `RegRead("HKCU\Software\Discord\Bluescreen\Default")` — `WshShell.RegRead` needs the full `HKEY_CURRENT_USER\` prefix, and this key does not exist on current Discord builds anyway;
- a `...\Discord\app-*\Discord.exe` wildcard — `WScript.Shell.Run` does not expand wildcards.

### 4. Optional: DevTools for the manual console

Only needed if you want `Ctrl+Shift+I` (manual paste / `__questsStop()` / `__questsStatus()`) — the automated setup does **not** require it. Close Discord, add to `%APPDATA%\discord\settings.json` (merge):

```json
{
  "DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING": true
}
```

⚠️ **Discord rewrites `settings.json` on every start/exit and drops these keys** (verified: they are gone ~30 s after launch). The fix: add them while Discord is closed, right before starting it — DevTools work for that session. The installer drops an `enable-devtools.cmd` helper into `%LOCALAPPDATA%\discord-quests\` that does this for you (run it while Discord is closed).

## Use

Start Discord the way you always do. The supervisor injects `quests.js` into the running client within ~30 s (it may silently relaunch the client with the debug port first — once per 2 minutes at most). Open Discover → Quests, watch the panel. Claim rewards on the cards.

Stop everything: `Stop-ScheduledTask -TaskName discord-quests`, and run `__questsStop()` in the Discord console (or just restart Discord while the task is stopped).

## Troubleshooting (Windows)

| Problem | Fix |
|---|---|
| A console window stays open | The task must start `supervisor-hidden.vbs` via `wscript.exe`, not `supervisor.cmd`/`node` directly |
| `Cannot find module ... inject.mjs` in the log | A stray `%USERPROFILE%` in the path (old guide typo) — use the full absolute path |
| Supervisor dies with `ENOENT ... quests.js` | `quests.js` must be in `%LOCALAPPDATA%\discord-quests\`, not next to `inject.mjs` in some other folder |
| Supervisor dies right after logon | Old version scanned `/proc` (Linux-only). Update `inject.mjs` — current one detects bare Discord via WMI |
| Panel never appears | Check the log: `Get-Content "$env:LOCALAPPDATA\discord-quests\supervisor.log" -Tail 20` — Discord must be running and the port must answer (`curl http://127.0.0.1:9222/json/version`) |
| Client relaunches itself when you open Discord | That is the supervisor giving it the debug port (once per 2 min max). Disable via `NO_RELAUNCH` if unwanted |
