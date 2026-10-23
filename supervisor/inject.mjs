// Discord quests supervisor: ждёт запущенный Discord с портом отладки (9222)
// и вливает quests.js в клиент, если скрипт там ещё не работает.
// Повторяет попытку каждые 30 секунд — переживает перезагрузку страницы,
// ручной перезапуск клиента и обновления Discord.
//
// Если Discord запущен БЕЗ порта отладки (например, клиент перезапустил сам
// себя через своё меню или после обновления) — супервизор аккуратно
// перезапускает его через лаунчер с портом. Не чаще раза в 2 минуты.
// Отключить: touch ~/.local/share/discord-quests/NO_RELAUNCH
import { readFileSync, statSync, appendFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";

const DIR = `${homedir()}/.local/share/discord-quests`;
const LOG = `${DIR}/supervisor.log`;
const WRAPPER = `${homedir()}/.local/bin/discord-quests`;
const log = (m) => {
  try { if (statSync(LOG).size > 512 * 1024) writeFileSync(LOG, ""); } catch (_) {}
  appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);
};

const script = readFileSync(`${DIR}/quests.js`, "utf8");

const MARKER = `JSON.stringify({
  ready: typeof webpackChunkdiscord_app !== "undefined",
  run: typeof __questsRunning === "undefined" ? null : __questsRunning === true,
  stopped: window.__questsStoppedByUser === true
})`;

function connect(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let mid = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    };
    ws.onopen = async () => {
      const send = (method, params = {}) => new Promise((res2, rej2) => {
        const id = ++mid;
        pending.set(id, { resolve: res2, reject: rej2 });
        try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { rej2(e); }
      });
      try { await send("Runtime.enable"); resolve({ ws, send }); }
      catch (e) { try { ws.close(); } catch (_) {} reject(e); }
    };
    ws.onerror = () => reject(new Error("ws error"));
  });
}

// Главные процессы Discord без --remote-debugging-port (дети --type=... не считаются).
// Внимание: Chromium склеивает cmdline в одну строку без NUL-разделителей,
// поэтому первый "токен" вырезаем по пробелу.
function bareDiscord() {
  const out = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    let argv0;
    try { argv0 = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0")[0]; } catch (_) { continue; }
    if (!argv0) continue;
    const exe = argv0.split(" ")[0];
    if (!exe.endsWith("/Discord")) continue;
    if (argv0.includes("--type=")) continue; // дочерний процесс
    out.push({ pid: d, argv0: exe });
  }
  return out;
}

// Наследуем окружение у живого процесса Discord (WAYLAND_DISPLAY/DISPLAY и т.д.),
// чтобы запустить клиент с графикой из systemd-сервиса.
function envOf(pid) {
  try {
    const env = {};
    for (const kv of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
      const i = kv.indexOf("=");
      if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return env;
  } catch (_) { return {}; }
}

let lastRelaunch = 0;
function maybeRelaunch() {
  if (existsSync(`${DIR}/NO_RELAUNCH`)) return;
  if (Date.now() - lastRelaunch < 120000) return;
  const bare = bareDiscord();
  if (!bare.length) return; // Discord просто не запущен — его запустит пользователь
  lastRelaunch = Date.now();
  log(`Discord запущен без порта отладки (pid ${bare.map((b) => b.pid).join(",")}) — перезапускаю через лаунчер`);
  try {
    execSync("killall Discord 2>/dev/null || true", { shell: "/bin/bash" });
  } catch (_) {}
  setTimeout(() => {
    try { execSync("killall -9 Discord 2>/dev/null || true", { shell: "/bin/bash" }); } catch (_) {}
    setTimeout(() => {
      const env = { ...process.env, ...envOf(bare[0].pid) };
      try {
        const child = spawn(WRAPPER, [], { detached: true, stdio: "ignore", env });
        child.unref();
        log("Discord перезапущен с портом отладки");
      } catch (e) {
        log(`не удалось запустить лаунчер: ${e.message}`);
      }
    }, 2000);
  }, 4000);
}

async function cycle() {
  let targets;
  try {
    targets = await (await fetch("http://127.0.0.1:9222/json", { signal: AbortSignal.timeout(3000) })).json();
  } catch (_) {
    maybeRelaunch(); // порт не отвечает
    return;
  }
  const pages = targets.filter((t) => t.type === "page" && t.url.startsWith("https://discord.com/"));
  const page = pages.find((t) => t.url.includes("/channels")) ?? pages[0];
  if (!page) return;

  let conn;
  try {
    conn = await connect(page);
  } catch (e) {
    log(`connect fail: ${e.message}`);
    return;
  }
  const { ws, send } = conn;
  try {
    const st = await send("Runtime.evaluate", { expression: MARKER, returnByValue: true });
    const m = JSON.parse(st.result?.value ?? "{}");
    if (!m.ready) return;                       // клиент ещё грузится
    if (m.run === true) return;                 // скрипт уже работает
    if (m.stopped) return;                      // пользователь остановил вручную

    const res = await send("Runtime.evaluate", { expression: script, awaitPromise: false, returnByValue: false });
    if (res.exceptionDetails) {
      log(`inject error: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    } else {
      log(`injected into ${page.url.slice(0, 60)}`);
    }
  } catch (e) {
    log(`cycle error: ${e.message}`);
  } finally {
    try { ws.close(); } catch (_) {}
  }
}

log("supervisor started");
setInterval(cycle, 30000);
cycle();
