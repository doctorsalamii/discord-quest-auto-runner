/* ============================================================
 * Discord Quests — автозавершение (веб и десктоп, общий файл)
 * (протокол сверен с live-tested реализациями от октября 2026)
 *
 * Запуск:
 *   1. Открой Discord (десктоп или discord.com), вкладка Discover -> Quests.
 *   2. Ctrl+Shift+I -> вкладка Console.
 *   3. Если вставка запрещена — набери в консоли: allow pasting
 *   4. Вставь весь этот файл целиком и нажми Enter.
 *
 * Остановка:      __questsStop()
 * Текущий статус: __questsStatus()
 *
 * Как это работает (проверенный протокол):
 *   - WATCH_VIDEO / WATCH_VIDEO_ON_MOBILE: /video-progress, можно
 *     докручивать по ~7 сек за запрос.
 *   - PLAY_ON_DESKTOP (+V2), STREAM_ON_DESKTOP, PLAY_ACTIVITY,
 *     ACHIEVEMENT_IN_ACTIVITY: POST /quests/{id}/heartbeat с
 *     { stream_key: "call:{канал}:1" } (канал может быть обычным ЛС!).
 *     Сервер засчитывает ВСЁ реальное время между двумя ударами
 *     (окно ~2 минуты: пауза 100 сек засчитывается, 150 сек — нет),
 *     поэтому бьём раз в 60 сек: 15-минутный квест реально идёт ~15 мин.
 *     Важно: heartbeat с application_id из браузера отклоняется (401) —
 *     работает только stream_key.
 *   - Прогресс приходит в ответе: body.progress[тип].value / .completed_at.
 *   - В десктопе дополнительно подменяются сторы "запущенной игры"/стрима,
 *     чтобы клиент сам слал heartbeat'ы (второй источник прогресса).
 * ============================================================ */

try { delete window.$; } catch (_) {}

(async () => {
  "use strict";

  if (window.__questsRunning === true) {
    console.log("[Quests] Скрипт уже запущен. Останови его: __questsStop()");
    return;
  }
  // Маркер ставим сразу: supervisor по нему понимает, что инъекция началась
  window.__questsRunning = true;
  // Метка билда: supervisor сравнивает её со своей копией файла и переливает
  // скрипт, если в клиенте крутится устаревшая версия (host мог выжить при
  // переходах между страницами).
  window.__questsBuild = "2026-10-25.3";

  /* ---------- настройки ---------- */
  const CONFIG = {
    autoEnroll: true,        // автоматически принимать (enroll) новые квесты
    autoClaim: false,        // награду забираешь вручную: Discover -> Quests -> Claim
    videoSpeed: 7,           // сколько секунд видео "смотреть" за один запрос
    heartbeatIntervalMs: 60 * 1000, // пауза между heartbeat (окно засчёта ~2 мин — не реже)
    stallTimeoutMs: 5 * 60 * 1000,  // нет прогресса столько — квест откладывается
    rescanMs: 20 * 1000,     // как часто искать новые квесты
    maxApiFails: 6,          // подряд неудачных запросов (не 401/403) — квест откладывается
  };

  const STOP = { value: false };
  const cleanups = new Set();
  const runCleanup = () => { for (const fn of [...cleanups]) { try { fn(); } catch (_) {} } cleanups.clear(); };

  window.__questsStop = () => {
    STOP.value = true;
    window.__questsStoppedByUser = true;
    runCleanup();
    console.log("[Quests] Остановлено. Патчи восстановлены.");
  };
  window.__questsStatus = () => {
    for (const [id, st] of state.status) console.log(`[Quests] ${st.name}: ${st.text}`);
    console.log(`[Quests] Активных задач: ${state.status.size}`);
  };
  window.__questsDump = () => JSON.stringify([...state.status.values()]);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uiLog = [];          // последние события — показывает панель
  const log = (msg, style) => {
    uiLog.push(msg);
    if (uiLog.length > 8) uiLog.shift();
    console.log(`%c[Quests]%c ${msg}`, "color:#5865F2;font-weight:bold", style || "");
  };
  const logOk = (msg) => log(msg, "color:#3BA55D");
  const logWarn = (msg) => log(msg, "color:#FAA61A");
  const logErr = (msg) => log(msg, "color:#ED4245");

  /* ---------- поиск внутренних модулей Discord ---------- */
  if (typeof webpackChunkdiscord_app === "undefined") {
    window.__questsRunning = false;
    logErr("webpackChunkdiscord_app не найден — открой консоль на вкладке discord.com, а не в другой вкладке.");
    return;
  }

  const wpRequire = webpackChunkdiscord_app.push([[Symbol()], {}, (r) => r]);
  webpackChunkdiscord_app.pop();

  // На время поиска модулей глушим i18n-ворнинги: обращение к свойствам
  // Proxy-модулей (например, i18n) сыплет "Requested message ..." в консоль.
  const origWarn = console.warn;
  console.warn = (...a) => {
    const s = String(a[0] ?? "");
    if (s.includes("Requested message")) return;
    origWarn(...a);
  };
  const restoreWarn = () => { try { console.warn = origWarn; } catch (_) {} };

  // Ищем модули по НАБОРУ МЕТОДОВ, а не по минифицированным именам экспорта
  // (exports.A / exports.Ay / exports.Bo меняются в каждом билде — именно поэтому
  // старый скрипт перестал работать). Имена методов Discord не минифицирует.
  const need = {
    api: ["get", "post", "put", "patch"],
    FluxDispatcher: ["dispatch", "subscribe", "unsubscribe"],
    QuestsStore: ["getQuest"],
    ChannelStore: ["getSortedPrivateChannels"],
    GuildChannelStore: ["getAllGuilds"],
    RunningGameStore: ["getRunningGames", "getGameForPID"],          // опционально
    ApplicationStreamingStore: ["getStreamerActiveStreamMetadata"],  // опционально
  };
  const found = {};
  const apiCandidates = [];

  const hasAll = (obj, names) => {
    if (!obj || (typeof obj !== "object" && typeof obj !== "function")) return false;
    for (const n of names) {
      let fn;
      try { fn = obj[n]; } catch (_) { return false; }
      if (typeof fn !== "function") return false;
    }
    return true;
  };

  const consider = (obj) => {
    if (!obj) return;
    if (hasAll(obj, need.api) && !apiCandidates.includes(obj)) apiCandidates.push(obj);
    for (const key in need) {
      if (key === "api" || found[key]) continue;
      if (hasAll(obj, need[key])) found[key] = obj;
    }
  };

  const scanExports = (visit) => {
    for (const mod of Object.values(wpRequire.c)) {
      let exp;
      try { exp = mod && mod.exports; } catch (_) { continue; }
      if (!exp) continue;
      if (visit(exp)) return true;
      let keys = [];
      try { keys = Object.keys(exp); } catch (_) { continue; }
      for (const k of keys) {
        let sub;
        try { sub = exp[k]; } catch (_) { continue; }
        if (visit(sub)) return true;
      }
    }
    return false;
  };

  for (const mod of Object.values(wpRequire.c)) {
    let exp;
    try { exp = mod && mod.exports; } catch (_) { continue; }
    if (!exp) continue;
    consider(exp);
    let keys = [];
    try { keys = Object.keys(exp); } catch (_) { continue; }
    for (const k of keys) {
      let sub;
      try { sub = exp[k]; } catch (_) { continue; }
      consider(sub);
    }
  }

  // QuestsStore — тот, у кого есть и getQuest(), и карта quests
  const isQuestsStore = (c) => {
    try { return c && typeof c.getQuest === "function" && c.quests instanceof Map; } catch (_) { return false; }
  };
  if (!isQuestsStore(found.QuestsStore)) {
    found.QuestsStore = null;
    scanExports((exp) => { if (isQuestsStore(exp)) { found.QuestsStore = exp; return true; } return false; });
  }

  // Некоторые модули — Proxy, который на ЛЮБОЕ свойство отдаёт функцию-заглушку
  // (пример — i18n: обращение к .getToken даёт ворнинг и undefined). Такой
  // модуль обманывает поиск по методам, поэтому найденные сторы проверяем
  // делом: вызываем метод и требуем реальный результат.
  const probeCall = (obj, name) => { try { return obj?.[name]?.(); } catch (_) { return undefined; } };
  const validateStore = (key, methodName, check) => {
    if (found[key] && check(probeCall(found[key], methodName))) return;
    found[key] = null;
    scanExports((exp) => {
      if (hasAll(exp, need[key]) && check(probeCall(exp, methodName))) { found[key] = exp; return true; }
      return false;
    });
  };
  validateStore("ChannelStore", "getSortedPrivateChannels", (r) => Array.isArray(r));
  validateStore("GuildChannelStore", "getAllGuilds", (r) => r != null && typeof r === "object" && !Array.isArray(r));
  validateStore("RunningGameStore", "getRunningGames", (r) => Array.isArray(r));
  validateStore("ApplicationStreamingStore", "getStreamerActiveStreamMetadata", (r) => r === null || (r && typeof r === "object"));

  // api в этом списке нет: он выбирается ниже отдельной пробой кандидатов
  const missing = ["FluxDispatcher", "QuestsStore"].filter((k) => !found[k]);
  if (missing.length) {
    restoreWarn();
    window.__questsRunning = false;
    logErr(`Не найдены модули: ${missing.join(", ")}. Перезагрузи страницу (F5), подожди 5 сек и вставь скрипт заново.`);
    return;
  }

  /* ---------- определение настоящего API-клиента ---------- */
  // Модулей с get/post/put/patch несколько; пробуем каждый и оставляем тот,
  // кто отвечает как Discord API. Заодно определяем стиль вызова:
  // старый ({url, body}) или новый (url, {body}).
  const answersLikeApi = (res) =>
    !!res && res.status === 200 && !!res.body &&
    typeof res.body === "object" && typeof res.body.id === "string";

  let api = null;
  let apiStyle = null;
  try {
    for (const cand of apiCandidates) {
      for (const style of ["object", "positional"]) {
        let res;
        try {
          res = await Promise.race([
            Promise.resolve(style === "object" ? cand.get({ url: "/users/@me" }) : cand.get("/users/@me")),
            sleep(15000),
          ]);
        } catch (_) { continue; }
        if (!answersLikeApi(res)) continue;
        api = cand;
        apiStyle = style;
        break;
      }
      if (api) break;
    }
  } finally {
    restoreWarn();
  }
  if (!api) {
    window.__questsRunning = false;
    logErr("API-клиент не найден. Перезагрузи страницу и попробуй снова.");
    return;
  }

  const apiRequest = (method, url, body) => {
    const work = apiStyle === "object"
      ? api[method]({ url, body })
      : api[method](url, body === undefined ? undefined : { body });
    return Promise.race([Promise.resolve(work), sleep(15000)]);
  };
  const apiPost = (url, body) => apiRequest("post", url, body);
  const apiGet = (url) => apiRequest("get", url);

  /* ---------- токен и прямой транспорт (v10) ---------- */
  // Сначала пробуем localStorage (без шума), затем внутренние модули.
  let authToken = null;
  try {
    const t = JSON.parse(localStorage.getItem("token") || "null");
    if (typeof t === "string" && t.length > 20) authToken = t;
  } catch (_) {}
  if (!authToken) {
    try {
      scanExports((exp) => {
        const cand = exp?.default ?? exp;
        if (cand && typeof cand.getToken === "function") {
          try {
            const t = cand.getToken();
            if (typeof t === "string" && t.length > 20) { authToken = t; return true; }
          } catch (_) {}
        }
        return false;
      });
    } catch (_) {}
  }

  const directPost = async (path, body) => {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authToken ? { Authorization: authToken } : {}) },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, ok: res.ok, body: data };
  };

  log(authToken
    ? "Транспорт: внутренний API-клиент (запасной — прямой запрос v10 с токеном)."
    : "Транспорт: внутренний API-клиент.");

  const QuestsStore = found.QuestsStore;
  const ChannelStore = found.ChannelStore;
  const GuildChannelStore = found.GuildChannelStore;
  const RunningGameStore = found.RunningGameStore;
  const ApplicationStreamingStore = found.ApplicationStreamingStore;
  const FluxDispatcher = found.FluxDispatcher;

  const isApp = typeof DiscordNative !== "undefined";
  log(isApp ? "Клиент: десктоп." : "Клиент: веб (браузер).");

  /* ---------- вспомогательное ---------- */
  // ACHIEVEMENT_IN_ACTIVITY не включён: сервер отвечает 403 на heartbeat
  // для него — такие квесты проходятся только вручную (OAuth-flow).
  const SUPPORTED = ["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE", "PLAY_ON_DESKTOP", "PLAY_ON_DESKTOP_V2", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY"];
  const HEARTBEAT_TYPES = SUPPORTED.filter((t) => !t.startsWith("WATCH_VIDEO"));
  const LOC_QUEST_HOME = 11;   // location для enroll/claim (как в самом клиенте)
  const CLAIM_PLATFORMS = [4, 0]; // 4 = PC (десктоп), 0 — запасной вариант

  const taskOf = (q) => {
    const tc = q && q.config && (q.config.taskConfig || q.config.taskConfigV2);
    return SUPPORTED.find((t) => tc && tc.tasks && tc.tasks[t] != null);
  };
  const nameOf = (q) => q?.config?.messages?.questName ?? "quest";

  const clean = (t) => {
    const x = String(t);
    if (/<(!doctype|html)/i.test(x)) return "HTTP 404";
    const flat = x.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return flat.length > 160 ? flat.slice(0, 160) + "…" : flat;
  };
  const describe = (e) => {
    if (!e) return "unknown";
    if (typeof e === "string") return clean(e);
    if (e.message) return clean(e.message);
    const status = e.status ?? e.statusCode;
    const body = e.body ?? e.response?.body;
    const detail = body?.message || body?.errors?.[0]?.message ||
      (body && typeof body === "object" ? JSON.stringify(body).slice(0, 160) : body);
    if (status && detail) return `HTTP ${status}: ${clean(detail)}`;
    if (status) return `HTTP ${status}`;
    if (detail) return clean(detail);
    try { return clean(JSON.stringify(e)); } catch (_) { return clean(e); }
  };
  const isCaptcha = (x) => /captcha/i.test(String(x || ""));

  // Прогресс может лежать под именем типа задания, под любым другим ключом
  // или в stream_progress_seconds — смотрим везде.
  const readProgress = (body, taskName) => {
    const p = body?.progress;
    let value = p?.[taskName]?.value;
    let completedAt = p?.[taskName]?.completed_at;
    if (typeof value !== "number" && p && typeof p === "object") {
      for (const k of Object.keys(p)) {
        const v = p[k]?.value;
        if (typeof v === "number") { value = v; completedAt = p[k]?.completed_at ?? completedAt; break; }
      }
    }
    if (typeof value !== "number" && typeof body?.stream_progress_seconds === "number") {
      value = body.stream_progress_seconds;
    }
    return { value, completedAt };
  };

  /* ---------- enroll / claim ---------- */
  async function enroll(quest) {
    const name = nameOf(quest);
    try {
      const res = await apiPost(`/quests/${quest.id}/enroll`, { location: LOC_QUEST_HOME });
      const t = res?.body?.type;
      if (t === "success" || t === "previous_in_flight_request" || (res?.status === 200 && res?.body && typeof res.body === "object" && !t)) {
        logOk(`Квест принят: ${name}`);
        await sleep(2000);
        return QuestsStore.getQuest(quest.id) ?? quest;
      }
      if (isCaptcha(t)) logWarn(`Discord просит капчу для «${name}» — прими квест вручную.`);
      else logWarn(`Не удалось принять «${name}»: ${clean(t || res?.status || describe(res))}`);
      return null;
    } catch (e) {
      const why = describe(e);
      if (isCaptcha(why)) logWarn(`Капча при принятии «${name}» — прими квест вручную.`);
      else logWarn(`Не удалось принять «${name}»: ${why}`);
      return null;
    }
  }

  const claimTries = new Map();
  const claimOnce = async (quest, platform) => {
    const body = { location: LOC_QUEST_HOME, platform };
    let res = await apiPost(`/quests/${quest.id}/claim-reward`, body).catch((e) => ({ status: 0, body: null, _e: e }));
    if (!(res?.status === 200 && (!res.body?.errors || res.body.errors.length === 0)) && authToken) {
      const d = await directPost(`/quests/${quest.id}/claim-reward`, body).catch(() => null);
      if (d) res = d;
    }
    if (res?.status === 200 && (!res.body?.errors || res.body.errors.length === 0)) return { ok: true };
    const why = res?.body?.errors?.[0]?.message || res?.body?.message || `status ${res?.status ?? "?"}`;
    return { ok: false, why: String(why) };
  };
  async function claimReward(quest) {
    const name = nameOf(quest);
    const tries = claimTries.get(quest.id) ?? 0;
    if (tries >= 3) { logWarn(`Награду «${name}» забери вручную (Discover -> Quests).`); return false; }
    claimTries.set(quest.id, tries + 1);
    for (const platform of CLAIM_PLATFORMS) {
      const r = await claimOnce(quest, platform);
      if (r.ok) { logOk(`Награда получена: ${name}`); return true; }
      if (isCaptcha(r.why)) { logWarn(`Капча при получении награды «${name}» — забери вручную.`); return false; }
    }
    logWarn(`Награда «${name}» не выдана — забери вручную (Discover -> Quests).`);
    return false;
  }

  /* ---------- поиск канала для stream_key ---------- */
  // Подходит личный канал (ДМ) — это подтверждено live-tested реализацией.
  async function findChannelId() {
    try {
      const dm = ChannelStore?.getSortedPrivateChannels?.()?.[0]?.id;
      if (dm) return dm;
    } catch (_) {}
    try {
      const g = Object.values(GuildChannelStore?.getAllGuilds?.() ?? {}).find((x) => x?.VOCAL?.length > 0);
      if (g?.VOCAL?.[0]?.channel?.id) return g.VOCAL[0].channel.id;
    } catch (_) {}
    if (authToken) {
      try {
        const r = await fetch("https://discord.com/api/v10/users/@me/channels", { headers: { Authorization: authToken } });
        if (r.ok) {
          const arr = await r.json();
          const dm = Array.isArray(arr) && arr.find((c) => c && (c.type === 1 || c.type === 3));
          if (dm?.id) return dm.id;
        }
      } catch (_) {}
    }
    return null;
  }

  /* ---------- состояние ---------- */
  const state = {
    processed: new Set(),   // id квестов, с которыми закончили
    inFlight: new Set(),    // id квестов в работе
    retryAt: new Map(),     // id -> время следующей попытки
    tries: new Map(),       // id -> число попыток
    enrollFailedAt: new Map(),
    status: new Map(),      // id -> {name, text}
    flash: new Map(),       // id -> {name, at} — недавние завершения для панели
  };
  const setStatus = (id, name, text) => state.status.set(id, { name, text });
  const clearStatus = (id) => state.status.delete(id);

  /* ---------- интерфейс: панель, видна только на вкладке квестов ---------- */
  // Живёт в Shadow DOM (стили Discord не задевает): тёмное «стекло» с блюром,
  // градиентные акценты по типу квеста, перетаскивание за шапку.
  let rescanRequested = false;
  window.__questsRescan = () => { rescanRequested = true; };

  const TYPE_META = {
    PLAY_ON_DESKTOP: { label: "игра", c1: "#5865f2", c2: "#8b5cf6" },
    PLAY_ON_DESKTOP_V2: { label: "игра", c1: "#5865f2", c2: "#8b5cf6" },
    WATCH_VIDEO: { label: "видео", c1: "#eb459e", c2: "#f0b232" },
    WATCH_VIDEO_ON_MOBILE: { label: "видео", c1: "#eb459e", c2: "#f0b232" },
    STREAM_ON_DESKTOP: { label: "стрим", c1: "#00a8fc", c2: "#5865f2" },
    PLAY_ACTIVITY: { label: "активность", c1: "#23a55a", c2: "#00a8fc" },
  };
  const metaOf = (t) => TYPE_META[t] ?? { label: "квест", c1: "#5865f2", c2: "#8b5cf6" };

  let uiTick = null;
  function buildUI() {
    document.getElementById("dqs-ui-host")?.remove();
    const host = document.createElement("div");
    host.id = "dqs-ui-host";
    host.style.cssText = "position:absolute;width:0;height:0;";
    document.body.appendChild(host);
    const sh = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: var(--font-primary, "gg sans", "Segoe UI", sans-serif);
          -webkit-user-select: none; user-select: none; }
      button { font-family: inherit; }
      button:focus-visible { outline: 2px solid #8b95ff; outline-offset: 2px; }
      .chip { position: fixed; right: 20px; bottom: 20px; z-index: 99999; display: none;
        align-items: center; gap: 9px; height: 44px; padding: 0 16px 0 14px; border-radius: 22px;
        border: 1px solid rgba(255,255,255,.16); cursor: pointer; color: #f2f3f5;
        background: rgba(20,21,26,.66); backdrop-filter: blur(24px) saturate(150%);
        -webkit-backdrop-filter: blur(24px) saturate(150%); font-size: 13px; font-weight: 700;
        box-shadow: 0 8px 24px rgba(0,0,0,.45); transition: transform .18s ease, border-color .18s; }
      .chip:hover { transform: translateY(-2px); }
      .chip.on { border-color: rgba(139,149,255,.6); }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #57f287;
        box-shadow: 0 0 0 0 rgba(87,242,135,.5); animation: pulse 1.8s infinite; }
      @keyframes pulse { 70% { box-shadow: 0 0 0 8px rgba(87,242,135,0); } }
      .badge { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; display: none;
        align-items: center; justify-content: center; color: #fff; font-size: 11px; font-weight: 800;
        background: #5865f2; }
      .panel { position: fixed; right: 20px; bottom: 72px; z-index: 99999; display: none; width: 380px;
        border-radius: 24px; overflow: hidden; color: #f2f3f5; font-size: 13px;
        background: rgba(20,21,26,.66);
        backdrop-filter: blur(28px) saturate(150%); -webkit-backdrop-filter: blur(28px) saturate(150%);
        border: 1px solid rgba(255,255,255,.16); box-shadow: 0 24px 60px rgba(0,0,0,.5); }
      .panel.show { animation: pop .24s cubic-bezier(.2,.9,.35,1.15); }
      @keyframes pop { from { opacity: 0; transform: translateY(12px) scale(.96); } }
      .head { display: flex; align-items: center; gap: 12px; padding: 16px 16px 14px; cursor: grab; }
      .head:active { cursor: grabbing; }
      .grip { flex: none; opacity: .75; }
      .ico { width: 36px; height: 36px; border-radius: 12px; flex: none; display: flex; align-items: center;
        justify-content: center; background: #5865f2; color: #fff; }
      .tt { flex: 1; min-width: 0; }
      .tt b { display: block; font-size: 16px; font-weight: 800; letter-spacing: -.01em; }
      .tt span { display: block; font-size: 12px; font-weight: 600; color: #b5bac1; margin-top: 2px; }
      .xbtn { width: 32px; height: 32px; border-radius: 10px; border: none; flex: none; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        background: transparent; color: #b5bac1; transition: background .15s, color .15s; }
      .xbtn:hover { background: rgba(255,255,255,.1); color: #fff; }
      .sum { height: 3px; margin: 0 16px; border-radius: 2px; background: rgba(255,255,255,.1); overflow: hidden; }
      .sum i { display: block; height: 100%; width: 0; background: #8b95ff; border-radius: 2px;
        transition: width 1s linear; }
      .body { padding: 14px 16px 4px; max-height: 47vh; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
      .body::-webkit-scrollbar { width: 8px; }
      .body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.16); border-radius: 4px; }
      .card { border-radius: 16px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.08);
        padding: 12px 14px; }
      .c1 { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
      .c1 b { flex: 1; font-size: 14px; font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; }
      .tag { flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700;
        padding: 3px 9px; border-radius: 8px; color: #dbdee1; background: rgba(255,255,255,.12); }
      .tag::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--ac); }
      .bar { position: relative; height: 8px; border-radius: 4px; background: rgba(255,255,255,.12); overflow: hidden; }
      .fill { height: 100%; width: 0; border-radius: 4px; background: var(--ac); transition: width 1.1s linear; }
      .c2 { display: flex; justify-content: space-between; margin-top: 8px; font-size: 12px;
        font-weight: 600; color: #c4c9d1; }
      .c2 .t { font-variant-numeric: tabular-nums; }
      .card.err { --ac: #f0b232; }
      .flash { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 16px;
        font-size: 13px; font-weight: 800; color: #9bf7b8; background: rgba(87,242,135,.14);
        border: 1px solid rgba(87,242,135,.45); }
      .flash svg { flex: none; }
      .empty { padding: 28px 8px 24px; text-align: center; color: #b5bac1; }
      .empty i { display: flex; justify-content: center; margin-bottom: 10px; opacity: .8; }
      .empty b { display: block; color: #dbdee1; font-size: 13px; font-weight: 700; margin-bottom: 3px; }
      .empty s { text-decoration: none; font-size: 12px; }
      .foot { padding: 6px 16px 14px; }
      .set { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 8px; }
      .lbl { display: flex; align-items: center; gap: 10px; cursor: pointer; font-size: 13px;
        font-weight: 700; color: #f2f3f5; min-height: 40px; }
      .sw { position: relative; width: 42px; height: 24px; border-radius: 12px; background: #4e5058; border: none;
        padding: 0; cursor: pointer; transition: background .18s; flex: none; }
      .sw::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px;
        border-radius: 50%; background: #fff; transition: transform .18s ease; box-shadow: 0 1px 3px rgba(0,0,0,.4); }
      .sw.on { background: #5865f2; }
      .sw.on::after { transform: translateX(18px); }
      .ghost { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 16px;
        border-radius: 12px; border: 1px solid rgba(255,255,255,.2); background: rgba(255,255,255,.1);
        color: #f2f3f5; font-size: 13px; font-weight: 700; cursor: pointer; transition: background .15s; }
      .ghost:hover { background: rgba(255,255,255,.18); }
`;
    sh.appendChild(style);

    const chip = document.createElement("button");
    chip.className = "chip";
    chip.innerHTML = `<span class="dot"></span><span>Квесты</span><span class="badge"></span>`;
    const badge = chip.querySelector(".badge");
    sh.appendChild(chip);

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="head">
        <svg class="grip" aria-hidden="true" width="12" height="20" viewBox="0 0 14 22" fill="#b5bac1"><circle cx="4" cy="5" r="2"/><circle cx="10" cy="5" r="2"/><circle cx="4" cy="11" r="2"/><circle cx="10" cy="11" r="2"/><circle cx="4" cy="17" r="2"/><circle cx="10" cy="17" r="2"/></svg>
        <div class="ico"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg></div>
        <div class="tt"><b>Автоквесты</b><span>загрузка…</span></div>
        <button class="xbtn" title="Свернуть" aria-label="Свернуть"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>
      <div class="sum"><i></i></div>
      <div class="body"></div>
      <div class="foot">
        <div class="set">
          <div class="lbl"><button class="sw" role="switch" aria-checked="false" aria-label="Принимать новые"></button><span>Принимать новые</span></div>
          <button class="ghost"><svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>Обновить</button>
        </div>
      </div>`;
    sh.appendChild(panel);
    const bodyEl = panel.querySelector(".body");
    const subEl = panel.querySelector(".tt span");
    const sumEl = panel.querySelector(".sum i");
    const swEl = panel.querySelector(".sw");
    swEl.classList.toggle("on", CONFIG.autoEnroll);

    // перетаскивание за шапку + запоминание позиции
    try {
      const saved = JSON.parse(localStorage.getItem("dqsPos") || "null");
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        panel.style.left = saved.left + "px";
        panel.style.top = saved.top + "px";
        panel.style.right = "auto";
        panel.style.bottom = "auto";
      }
    } catch (_) {}
    const head = panel.querySelector(".head");
    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".xbtn")) return;
      const r = panel.getBoundingClientRect();
      if (panel.style.right !== "auto") {
        panel.style.left = r.left + "px";
        panel.style.top = r.top + "px";
        panel.style.right = "auto";
        panel.style.bottom = "auto";
      }
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const move = (ev) => {
        const x = Math.max(8, Math.min(innerWidth - r.width - 8, ev.clientX - ox));
        const y = Math.max(8, Math.min(innerHeight - 40, ev.clientY - oy));
        panel.style.left = x + "px";
        panel.style.top = y + "px";
      };
      const up = () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        try {
          localStorage.setItem("dqsPos", JSON.stringify({ left: parseInt(panel.style.left), top: parseInt(panel.style.top) }));
        } catch (_) {}
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
    });
    head.addEventListener("dblclick", () => {
      try { localStorage.removeItem("dqsPos"); } catch (_) {}
      panel.style.left = "";
      panel.style.top = "";
      panel.style.right = "20px";
      panel.style.bottom = "72px";
    });

    chip.addEventListener("click", () => {
      const open = panel.style.display === "block";
      panel.style.display = open ? "none" : "block";
      if (!open) { panel.classList.remove("show"); void panel.offsetWidth; panel.classList.add("show"); }
      updateUI();
    });
    panel.querySelector(".xbtn").addEventListener("click", (e) => { e.stopPropagation(); panel.style.display = "none"; });
    panel.querySelector(".ghost").addEventListener("click", () => window.__questsRescan?.());
    const syncSw = () => { swEl.classList.toggle("on", CONFIG.autoEnroll); swEl.setAttribute("aria-checked", String(!!CONFIG.autoEnroll)); };
    syncSw();
    panel.querySelector(".lbl").addEventListener("click", () => { CONFIG.autoEnroll = !CONFIG.autoEnroll; syncSw(); });

    function updateUI() {
      for (const [id, f] of state.flash) if (Date.now() - f.at >= 20000) state.flash.delete(id);
      const active = [...state.status.values()];
      const flash = [...state.flash.values()];

      badge.style.display = active.length ? "inline-flex" : "none";
      badge.textContent = String(active.length);
      chip.classList.toggle("on", active.length > 0);
      if (panel.style.display !== "block") return;

      let sumDone = 0, sumAll = 0, etaMax = 0;
      for (const { text } of active) {
        const m = /([\d.]+)\s*\/\s*(\d+)/.exec(text);
        if (m) {
          sumDone += parseFloat(m[1]);
          sumAll += parseFloat(m[2]);
          etaMax = Math.max(etaMax, Math.ceil((parseFloat(m[2]) - parseFloat(m[1])) / 60));
        }
      }
      sumEl.style.width = sumAll ? Math.min(100, (sumDone / sumAll) * 100) + "%" : "0%";
      subEl.textContent = active.length
        ? `${active.length} в работе · осталось ~${etaMax || 1} мин`
        : flash.length ? "все выполнено ✓" : "ожидание квестов…";

      const frag = document.createDocumentFragment();
      for (const f of flash) {
        const d = document.createElement("div");
        d.className = "flash";
        d.innerHTML = `<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#7df5a5" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M7.5 12.5l3 3 6-6.5"/></svg>`;
        const ft = document.createElement("span");
        ft.textContent = `${f.name} — готово!`;
        d.appendChild(ft);
        frag.appendChild(d);
      }
      if (!active.length && !flash.length) {
        const d = document.createElement("div");
        d.className = "empty";
        d.innerHTML = `<i><svg aria-hidden="true" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="11" rx="4"/><path d="M8 10.5v4M6 12.5h4M16 11h.01M18 14h.01"/></svg></i><b>Сейчас квестов нет</b><s>Новые подхватятся автоматически</s>`;
        frag.appendChild(d);
      }
      for (const { name, text } of active) {
        const m = /([\d.]+)\s*\/\s*(\d+)\s*сек\s*\((\w+)\)/.exec(text);
        const err = /не удалось|ошиб|отклон/.test(text);
        const meta = m ? metaOf(m[3]) : { label: "статус", c1: "#f0b232", c2: "#f23f43" };
        const card = document.createElement("div");
        card.className = "card" + (err || !m ? " err" : "");
        card.style.setProperty("--ac", meta.c1);
        card.style.setProperty("--ac2", meta.c2);

        const c1 = document.createElement("div");
        c1.className = "c1";
        const b = document.createElement("b");
        b.textContent = name;
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = meta.label;
        c1.append(b, tag);
        card.appendChild(c1);

        if (m && !err) {
          const done = parseFloat(m[1]), total = parseFloat(m[2]);
          const pct = Math.max(0, Math.min(100, (done / total) * 100));
          const bar = document.createElement("div");
          bar.className = "bar";
          const fill = document.createElement("div");
          fill.className = "fill";
          fill.style.width = pct + "%";
          bar.appendChild(fill);
          card.appendChild(bar);
          const c2 = document.createElement("div");
          c2.className = "c2";
          const left = Math.max(0, Math.ceil(total - done));
          const s1 = document.createElement("span");
          s1.textContent = `${m[1]} из ${m[2]} сек`;
          const s2 = document.createElement("span");
          s2.className = "t";
          s2.textContent = `~${Math.max(1, Math.ceil(left / 60))} мин осталось`;
          c2.append(s1, s2);
          card.appendChild(c2);
        } else {
          const tx = document.createElement("div");
          tx.className = "c2";
          const s1 = document.createElement("span");
          const s2 = document.createElement("span");
          s2.className = "t";
          s2.textContent = text;
          tx.append(s1, s2);
          card.appendChild(tx);
        }
        frag.appendChild(card);
      }
      bodyEl.replaceChildren(frag);
    }

    let wasOnQuests = false;
    if (uiTick) clearInterval(uiTick);
    uiTick = setInterval(() => {
      if (STOP.value) return;
      const onQuests = /quest/i.test(location.pathname);
      chip.style.display = onQuests ? "inline-flex" : "none";
      if (onQuests && !wasOnQuests) {
        panel.style.display = "block";
        panel.classList.remove("show");
        void panel.offsetWidth;
        panel.classList.add("show");
      }
      if (!onQuests) panel.style.display = "none";
      wasOnQuests = onQuests;
      updateUI();
    }, 1000);

    cleanups.add(() => { if (uiTick) clearInterval(uiTick); host.remove(); });
  }
  buildUI();
  // самовосстановление: если панель пропала из DOM (навигация/сбой) — пересоздаём
  const uiWatch = setInterval(() => {
    if (STOP.value) { clearInterval(uiWatch); return; }
    try {
      if (!document.getElementById("dqs-ui-host")?.shadowRoot) buildUI();
    } catch (_) {}
  }, 3000);
  cleanups.add(() => clearInterval(uiWatch));

  /* ---------- выполнение одного квеста ---------- */
  function processQuest(quest) {
    return new Promise((resolve) => {
      const questName = nameOf(quest);
      const tc = quest.config.taskConfig || quest.config.taskConfigV2;
      const taskName = taskOf(quest);
      const taskData = tc.tasks[taskName];
      const applicationId = quest.config.application?.id ?? taskData.applications?.[0]?.id;
      const secondsNeeded = taskData.target;
      let secondsDone = quest.userStatus?.progress?.[taskName]?.value
        ?? quest.userStatus?.streamProgressSeconds ?? 0;
      let lastProgressAt = Date.now();
      let settled = false;
      let apiFails = 0;
      let stuckBeats = 0;
      const myCleanups = [];

      const hardLimit = Math.max(12 * 60 * 1000, (secondsNeeded - secondsDone) * 2500 + 12 * 60 * 1000);
      const guard = setTimeout(() => settle("timeout"), hardLimit);
      myCleanups.push(() => clearTimeout(guard));

      function settle(reason) {
        if (settled) return;
        settled = true;
        for (const fn of myCleanups) { try { fn(); } catch (_) {} }
        state.inFlight.delete(quest.id);
        if (reason === "done") {
          state.flash.set(quest.id, { name: questName, at: Date.now() });
          clearStatus(quest.id);
          logOk(`✔ Квест завершён: ${questName}`);
          resolve("done");
          return;
        }
        if (reason === "stop") { clearStatus(quest.id); resolve("stop"); return; }
        setStatus(quest.id, questName, `не удалось: ${reason}`);
        logWarn(`✖ «${questName}» — ${reason}`);
        resolve(reason);
      }

      const progress = (value, completedAt) => {
        if (typeof value === "number" && value > secondsDone) {
          secondsDone = value;
          lastProgressAt = Date.now();
          stuckBeats = 0;
        }
        setStatus(quest.id, questName, `${Math.round(secondsDone)}/${secondsNeeded} сек (${taskName})`);
        return typeof completedAt === "string" || secondsDone >= secondsNeeded;
      };
      const stalled = () => Date.now() - lastProgressAt > CONFIG.stallTimeoutMs;
      const watch = setInterval(() => { if (STOP.value) settle("stop"); else if (stalled()) settle("нет прогресса от сервера"); }, 5000);
      myCleanups.push(() => clearInterval(watch));

      setStatus(quest.id, questName, `старт: ${Math.round(secondsDone)}/${secondsNeeded} сек (${taskName})`);
      log(`▶ «${questName}» — тип ${taskName}, нужно ${secondsNeeded} сек, уже ${Math.round(secondsDone)}`);

      /* --- видео --- */
      if (taskName === "WATCH_VIDEO" || taskName === "WATCH_VIDEO_ON_MOBILE") {
        let completed = false;
        let res = null;
        (async () => {
          while (!settled) {
            const remaining = Math.max(0, Math.min(CONFIG.videoSpeed, secondsNeeded - secondsDone));
            await sleep(remaining * 1000);
            if (settled) return;
            const timestamp = secondsDone + CONFIG.videoSpeed;
            try {
              res = await apiPost(`/quests/${quest.id}/video-progress`, {
                timestamp: Math.min(secondsNeeded, timestamp + Math.random()),
              });
              apiFails = 0;
              completed = res?.body?.completed_at != null;
            } catch (e) {
              if (++apiFails >= CONFIG.maxApiFails) { settle(`ошибки API: ${describe(e)}`); return; }
              logWarn(`«${questName}» запрос не прошёл (${describe(e)}), повтор через 5 сек`);
              await sleep(5000);
              continue;
            }
            progress(Math.min(secondsNeeded, timestamp), res?.body?.completed_at);
            if (timestamp >= secondsNeeded) break;
          }
          if (settled) return;
          if (!completed) {
            try { await apiPost(`/quests/${quest.id}/video-progress`, { timestamp: secondsNeeded }); } catch (_) {}
          }
          settle("done");
        })().catch((e) => settle(`ошибка: ${describe(e)}`));
        return;
      }

      /* --- все остальные типы: heartbeat со stream_key --- */
      if (HEARTBEAT_TYPES.includes(taskName)) {
        (async () => {
          const channelId = await findChannelId();
          if (settled) return;
          if (!channelId) { settle("не найден ни один личный/голосовой канал"); return; }
          const streamKey = `call:${channelId}:1`;
          log(`«${questName}»: heartbeat-канал ${channelId} (${taskName}).`);

          // В десктопе дополнительно подменяем сторы, чтобы сам клиент тоже
          // слал heartbeat'ы (второй источник прогресса).
          if (isApp) {
            try {
              if ((taskName === "PLAY_ON_DESKTOP" || taskName === "PLAY_ON_DESKTOP_V2") && RunningGameStore) {
                apiGet(`/applications/public?application_ids=${applicationId}`).then((res) => {
                  if (settled || !res?.body?.[0]) return;
                  const appData = res.body[0];
                  const exeName = appData.executables?.find((x) => x.os === "win32")?.name?.replace(">", "")
                    ?? String(appData.name || "game").replace(/[\/\\:*?"<>|]/g, "");
                  const pid = Math.floor(Math.random() * 30000) + 1000;
                  const fakeGame = {
                    cmdLine: `C:\\Program Files\\${appData.name}\\${exeName}`, exeName,
                    exePath: `c:/program files/${String(appData.name).toLowerCase()}/${exeName}`,
                    hidden: false, isLauncher: false, id: applicationId, name: appData.name,
                    pid, pidPath: [pid], processName: appData.name, start: Date.now(),
                  };
                  const realGames = RunningGameStore.getRunningGames();
                  const realGetRunning = RunningGameStore.getRunningGames;
                  const realGetForPID = RunningGameStore.getGameForPID;
                  RunningGameStore.getRunningGames = () => [fakeGame];
                  RunningGameStore.getGameForPID = (p) => [fakeGame].find((x) => x.pid === p);
                  try { FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: realGames, added: [fakeGame], games: [fakeGame] }); } catch (_) {}
                  myCleanups.push(() => {
                    RunningGameStore.getRunningGames = realGetRunning;
                    RunningGameStore.getGameForPID = realGetForPID;
                    try { FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: [] }); } catch (_) {}
                  });
                }).catch(() => {});
              }
              if (taskName === "STREAM_ON_DESKTOP" && ApplicationStreamingStore) {
                const realFunc = ApplicationStreamingStore.getStreamerActiveStreamMetadata;
                ApplicationStreamingStore.getStreamerActiveStreamMetadata = () => ({ id: applicationId, pid: Math.floor(Math.random() * 30000) + 1000, sourceName: null });
                myCleanups.push(() => { ApplicationStreamingStore.getStreamerActiveStreamMetadata = realFunc; });
              }
              const listener = (data) => {
                try {
                  const value = quest.config.configVersion === 1
                    ? data?.userStatus?.streamProgressSeconds
                    : Math.floor(data?.userStatus?.progress?.[taskName]?.value ?? 0);
                  if (progress(value)) {
                    try { apiPost(`/quests/${quest.id}/heartbeat`, { stream_key: streamKey, terminal: true }); } catch (_) {}
                    settle("done");
                  }
                } catch (_) {}
              };
              FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", listener);
              myCleanups.push(() => { try { FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", listener); } catch (_) {} });
            } catch (_) {}
          }

          // Основной транспорт — внутренний клиент (работает и в вебе, и в
          // десктопе, CSP не мешает). При 401/403 один раз пробуем прямой
          // запрос с токеном.
          let useDirect = false;
          let first = true;
          while (!settled) {
            if (!first) await sleep(CONFIG.heartbeatIntervalMs);
            if (settled) return;
            first = false;
            let res = null;
            try {
              res = useDirect
                ? await directPost(`/quests/${quest.id}/heartbeat`, { stream_key: streamKey, terminal: false })
                : await apiPost(`/quests/${quest.id}/heartbeat`, { stream_key: streamKey, terminal: false });
            } catch (e) {
              const why = describe(e);
              if (/HTTP 40[13]/.test(why)) { settle(`сервер отклоняет heartbeat (${why}) — этот тип квеста из консоли не пройти`); return; }
              if (useDirect) { settle(`прямой запрос не работает: ${why}`); return; }
              if (++apiFails >= CONFIG.maxApiFails) { settle(`ошибки сети: ${why}`); return; }
              logWarn(`«${questName}» heartbeat не прошёл (${why}), повтор через 10 сек`);
              await sleep(10000);
              continue;
            }
            if (res.status === 401 || res.status === 403) {
              if (!useDirect && authToken) {
                useDirect = true;
                logWarn(`«${questName}» внутренний клиент отклонён (${res.status}), пробую прямой запрос с токеном`);
                await sleep(2000);
                continue;
              }
              settle(`HTTP ${res.status} — сервер не принимает heartbeat этой сессией`);
              return;
            }
            if (res.status === 429) {
              logWarn(`«${questName}» rate limit, пауза 30 сек`);
              await sleep(30000);
              continue;
            }
            if (res.status >= 400) {
              if (++apiFails >= CONFIG.maxApiFails) { settle(`heartbeat отклоняется: HTTP ${res.status}`); return; }
              await sleep(10000);
              continue;
            }
            apiFails = 0;
            const prog = readProgress(res?.body, taskName);
            const finished = progress(prog.value, prog.completedAt);
            if (typeof prog.value !== "number") {
              if (++stuckBeats >= 4) logWarn(`«${questName}» прогресс не растёт уже ${stuckBeats} ударов — сервер, похоже, не засчитывает ${taskName} через консольный heartbeat`);
            }
            if (finished) {
              const body = { stream_key: streamKey, terminal: true };
              try { await (useDirect ? directPost(`/quests/${quest.id}/heartbeat`, body) : apiPost(`/quests/${quest.id}/heartbeat`, body)); } catch (_) {}
              settle("done");
              return;
            }
          }
        })().catch((e) => settle(`ошибка: ${describe(e)}`));
        return;
      }

      settle(`неподдерживаемый тип задания (${Object.keys(tc.tasks).join(", ")})`);
    });
  }

  /* ---------- главный цикл ---------- */
  async function scanOnce() {
    const now = Date.now();
    const all = [...QuestsStore.quests.values()].filter((q) => {
      try { return new Date(q.config.expiresAt).getTime() > now; } catch (_) { return false; }
    });

    // 1) забрать награды за уже завершённые квесты
    for (const q of all) {
      if (STOP.value) return;
      if (state.processed.has(q.id) || state.inFlight.has(q.id)) continue;
      if (!q.userStatus?.completedAt) continue;
      if (q.userStatus.claimedAt) { state.processed.add(q.id); continue; }
      if (CONFIG.autoClaim) {
        if (await claimReward(q)) state.processed.add(q.id);
      } else {
        logOk(`✔ «${nameOf(q)}» уже завершён — забери награду вручную (Discover -> Quests).`);
        state.processed.add(q.id);
      }
    }

    // 2) запустить незавершённые
    let started = 0;
    for (const q of all) {
      if (STOP.value) return;
      if (state.processed.has(q.id) || state.inFlight.has(q.id)) continue;
      if (q.userStatus?.completedAt) continue;
      if (now < (state.retryAt.get(q.id) ?? 0)) continue;

      const taskName = taskOf(q);
      if (!taskName) {
        state.processed.add(q.id);
        const tc = q.config.taskConfig || q.config.taskConfigV2;
        logWarn(`• «${nameOf(q)}» — тип задания не поддерживается (${Object.keys(tc?.tasks ?? {}).join(", ") || "нет задач"}), пропущен.`);
        continue;
      }

      let quest = q;
      if (!quest.userStatus?.enrolledAt) {
        if (!CONFIG.autoEnroll) {
          state.processed.add(q.id);
          logWarn(`• «${nameOf(q)}» — сначала прими квест вручную (Discover -> Quests), затем перезапусти скрипт.`);
          continue;
        }
        const failedAt = state.enrollFailedAt.get(quest.id) ?? 0;
        if (now - failedAt < 3 * 60 * 1000) continue;
        const enrolled = await enroll(quest);
        if (!enrolled) { state.enrollFailedAt.set(quest.id, Date.now()); continue; }
        quest = enrolled;
      }

      state.inFlight.add(quest.id);
      started++;
      processQuest(quest).then((outcome) => {
        if (outcome === "done") {
          state.processed.add(quest.id);
          if (CONFIG.autoClaim) claimReward(quest).catch(() => {});
        } else if (outcome === "stop") {
          state.processed.add(quest.id);
        } else {
          const tries = (state.tries.get(quest.id) ?? 0) + 1;
          state.tries.set(quest.id, tries);
          if (tries >= 3) {
            state.processed.add(quest.id);
            logWarn(`• «${nameOf(quest)}» — 3 неудачные попытки, больше не трогаем в этой сессии.`);
          } else {
            state.retryAt.set(quest.id, Date.now() + 60 * 1000);
          }
        }
      });
      await sleep(1500); // небольшой разнос запросов
    }
    return started;
  }

  log("Скрипт запущен. Остановка: __questsStop() | Статус: __questsStatus()");

  while (!STOP.value) {
    try {
      const started = await scanOnce();
      if (started > 0) log(`Запущено квестов: ${started}`);
    } catch (e) {
      logErr(`Ошибка цикла: ${describe(e)}`);
    }
    for (let i = 0; i < CONFIG.rescanMs / 500 && !STOP.value; i++) {
      if (rescanRequested) { rescanRequested = false; break; } // кнопка "Обновить" будит цикл
      await sleep(500);
    }
  }

  runCleanup();
  window.__questsRunning = false;
  log("Работа завершена.");
})().catch((e) => {
  window.__questsRunning = false;
  console.error("[Quests] Непредвиденная ошибка:", e);
});
