// Discord quests supervisor: ждёт запущенный Discord с портом отладки (9222)
// и вливает quests.js в клиент, если скрипт там ещё не работает.
// Повторяет попытку каждые 30 секунд — переживает перезагрузку страницы,
// ручной перезапуск клиента и обновления Discord.
import { readFileSync, statSync, appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const DIR = `${homedir()}/.local/share/discord-quests`;
const LOG = `${DIR}/supervisor.log`;
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

async function cycle() {
  let targets;
  try {
    targets = await (await fetch("http://127.0.0.1:9222/json", { signal: AbortSignal.timeout(3000) })).json();
  } catch (_) {
    return; // Discord не запущен или без порта — молча ждём дальше
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
