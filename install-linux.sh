#!/usr/bin/env bash
# Discord Quest Auto-Runner — Linux installer (Arch-based distros)
# Sets up: Discord client, DevTools flag, supervisor service, desktop entry.
set -euo pipefail

BASE="$HOME/.local/share/discord-quests"
BIN="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/discord"
SETTINGS="$CONFIG_DIR/settings.json"
SERVICE="$HOME/.config/systemd/user/discord-quests.service"
DESKTOP="$HOME/.local/share/applications/Discord.desktop"
SCRIPT_URL_QUESTS="https://raw.githubusercontent.com/doctorsalamii/discord-quest-auto-runner/main/quests-en.js"
SCRIPT_URL_INJECT="https://raw.githubusercontent.com/doctorsalamii/discord-quest-auto-runner/main/supervisor/inject.mjs"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ✔ \033[0m %s\n' "$*"; }

# --- 1. Discord client -------------------------------------------------------
if ! command -v discord >/dev/null 2>&1 && [ ! -d "$CONFIG_DIR" ]; then
  say "Installing Discord client (pacman)…"
  sudo pacman -S --noconfirm discord
else
  ok "Discord client already present"
fi

# --- 2. DevTools flag --------------------------------------------------------
say "Enabling DevTools in $SETTINGS…"
mkdir -p "$CONFIG_DIR"
node_available=1
command -v node >/dev/null 2>&1 || node_available=0
if [ "$node_available" = 1 ]; then
  node - "$SETTINGS" <<'EOF'
const fs = require("fs");
const p = process.argv[2];
let s = {};
try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) {}
s["DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING"] = true;
s["DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOU_ARE_DOING"] = true;
fs.writeFileSync(p, JSON.stringify(s, null, 2));
EOF
else
  # no node — naive append (file usually small)
  [ -f "$SETTINGS" ] || echo "{}" > "$SETTINGS"
  grep -q WHAT_YOURE_DOING "$SETTINGS" || \
    printf '%s' "$(tr -d '}' < "$SETTINGS" | tr -d '\n' | sed 's/,$//'),\"DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING\":true}" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"
fi
ok "DevTools enabled"

# --- 3. Files ----------------------------------------------------------------
say "Downloading scripts to $BASE…"
mkdir -p "$BASE"
curl -fsSL "$SCRIPT_URL_QUESTS" -o "$BASE/quests.js"
curl -fsSL "$SCRIPT_URL_INJECT" -o "$BASE/inject.mjs"
ok "quests.js + inject.mjs installed"

# --- 4. Launcher -------------------------------------------------------------
mkdir -p "$BIN"
cat > "$BIN/discord-quests" <<'EOF'
#!/bin/sh
# Starts the real Discord client with a debug port for the quest supervisor.
exec ~/.config/discord/app-*/Discord --remote-debugging-port=9222 "$@"
EOF
chmod +x "$BIN/discord-quests"
ok "Launcher: $BIN/discord-quests"

# --- 5. Desktop entry --------------------------------------------------------
mkdir -p "$(dirname "$DESKTOP")"
cat > "$DESKTOP" <<EOF
[Desktop Entry]
Version=1.0
Name=Discord
Comment=Discord client with quest auto-runner
Exec=$BIN/discord-quests
Terminal=false
Type=Application
Icon=discord
StartupNotify=true
Categories=Network;InstantMessaging;
EOF
ok "Desktop entry updated"

# --- 6. systemd user service -------------------------------------------------
mkdir -p "$(dirname "$SERVICE")"
cat > "$SERVICE" <<EOF
[Unit]
Description=Discord quests auto-runner (injects quest script into running Discord client)
After=graphical-session.target

[Service]
ExecStart=$(command -v node || echo $HOME/.local/share/mise/shims/node) $BASE/inject.mjs
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now discord-quests.service
ok "Supervisor service enabled"

# --- 7. Restart Discord if running -------------------------------------------
if pgrep -f "Discord" >/dev/null 2>&1; then
  say "Discord is running — restarting it to pick up the debug port…"
  killall Discord 2>/dev/null || true
  sleep 4
  killall -9 Discord 2>/dev/null || true
  sleep 2
  setsid nohup "$BIN/discord-quests" >/dev/null 2>&1 &
  ok "Discord restarted"
fi

echo
ok "Done! Open Discord → Discover → Quests. The script injects itself; claim rewards on the quest cards."
echo "   Logs: $BASE/supervisor.log | Stop automation: systemctl --user disable --now discord-quests.service"
