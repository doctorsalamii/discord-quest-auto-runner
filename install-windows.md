# Windows auto-start (optional)

The script itself works on Windows the same way — paste `quests-en.js` into the Discord console and it runs. This guide adds the same "survives restarts" automation that the Linux installer sets up: Discord starts with a debug port, a tiny supervisor keeps the quest script injected.

## 1. Enable DevTools

`Win+R` → `%APPDATA%\discord\settings.json` → open with Notepad. Add (merge into the existing JSON):

```json
{
  "DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING": true,
  "DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOU_ARE_DOING": true
}
```

## 2. Launcher shortcut

Create `C:\Tools\discord-quests.vbs`:

```vbs
CreateObject("WScript.Shell").Run _
  """" & CreateObject("Scripting.FileSystemObject").GetParentFolderName(CreateObject("WScript.Shell").RegRead("HKCU\Software\Discord\Bluescreen\Default")) & "\Discord.exe"" --remote-debugging-port=9222", 0, False
```

If the registry path does not resolve on your build, point it at the real exe instead:

```vbs
CreateObject("WScript.Shell").Run _
  """" & CreateObject("WScript.Shell").ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Discord\app-*\Discord.exe"" --remote-debugging-port=9222", 0, False
```

(Discord's self-updater keeps builds under `%LOCALAPPDATA%\Discord\app-<version>\`.)

## 3. Supervisor (Node.js required — [nodejs.org](https://nodejs.org), any LTS)

Save `supervisor/inject.mjs` from this repo to `C:\Tools\discord-quests\inject.mjs` and `quests-en.js` next to it as `quests.js`.

Create `C:\Tools\discord-quests\supervisor.cmd`:

```bat
@echo off
node "%USERPROFILE%\C:\Tools\discord-quests\inject.mjs"
```

(adjust the path if you put it elsewhere — the `.mjs` expects `quests.js` in the same folder and the Discord debug port on `127.0.0.1:9222`)

## 4. Task Scheduler

Open **Task Scheduler** → Create Task:

- **General**: run only when user is logged on; run with highest privileges not required
- **Triggers**: At log on
- **Actions**: start `C:\Tools\discord-quests.vbs`; second action: start `C:\Tools\discord-quests\supervisor.cmd`
- **Settings**: allow task to be run on demand; restart on failure

## 5. Use

Start Discord from the shortcut (or let the task run at logon). The supervisor injects `quests.js` into the running client within ~30 s. Open Discover → Quests, watch the panel. Claim rewards on the cards.

Stop everything: end the "supervisor" task, and run `__questsStop()` in the Discord console.
