/* ============================================================
 * Discord Quests — auto-completion (web and desktop, single file)
 * (protocol verified against live-tested implementations of Oct 2026)
 *
 * Run:
 *   1. Open Discord (desktop app or discord.com), Discover -> Quests tab.
 *   2. Ctrl+Shift+I -> Console tab.
 *   3. If pasting is blocked — type in the console: allow pasting
 *   4. Paste this whole file and press Enter.
 *
 * Stop:           __questsStop()
 * Current status: __questsStatus()
 *
 * How it works (verified protocol):
 *   - WATCH_VIDEO / WATCH_VIDEO_ON_MOBILE: /video-progress, you can
 *     fast-forward ~7 sec per request.
 *   - PLAY_ON_DESKTOP (+V2), STREAM_ON_DESKTOP, PLAY_ACTIVITY,
 *     ACHIEVEMENT_IN_ACTIVITY: POST /quests/{id}/heartbeat with
 *     { stream_key: "call:{channel}:1" } (a plain DM channel works!).
 *     The server credits ALL real time between two beats (credit window
 *     ~2 minutes: a 100 sec gap is credited, 150 sec is not), so we beat
 *     every 60 sec: a 15-minute quest really takes ~15 minutes, but all
 *     such quests run in parallel.
 *     Important: heartbeat with application_id is rejected from the browser
 *     (401) — only stream_key works.
 *   - Progress comes in the response: body.progress[type].value / .completed_at.
 *   - On desktop it additionally patches the "running game"/stream stores so
 *     the client itself sends heartbeats (a second source of progress).
 * ============================================================ */

try { delete window.$; } catch (_) {}

(async () => {
  "use strict";

  if (window.__questsRunning === true) {
    console.log("[Quests] Script is already running. Stop it with: __questsStop()");
    return;
  }
  // Set the marker right away: the supervisor uses it to see the injection started
  window.__questsRunning = true;

  /* ---------- settings ---------- */
  const CONFIG = {
    autoEnroll: true,        // automatically accept (enroll) new quests
    autoClaim: false,        // you claim rewards manually: Discover -> Quests -> Claim
    videoSpeed: 7,           // seconds of video to "watch" per request
    heartbeatIntervalMs: 60 * 1000, // pause between heartbeats (credit window ~2 min — keep within it)
    stallTimeoutMs: 5 * 60 * 1000,  // no progress for this long — quest is postponed
    rescanMs: 20 * 1000,     // how often to scan for new quests
    maxApiFails: 6,          // consecutive failed requests (not 401/403) — quest is postponed
  };

  const STOP = { value: false };
  const cleanups = new Set();
  const runCleanup = () => { for (const fn of [...cleanups]) { try { fn(); } catch (_) {} } cleanups.clear(); };

  window.__questsStop = () => {
    STOP.value = true;
    window.__questsStoppedByUser = true;
    runCleanup();
    console.log("[Quests] Stopped. Patches restored.");
  };
  window.__questsStatus = () => {
    for (const [id, st] of state.status) console.log(`[Quests] ${st.name}: ${st.text}`);
    console.log(`[Quests] Active tasks: ${state.status.size}`);
  };
  window.__questsDump = () => JSON.stringify([...state.status.values()]);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uiLog = [];          // recent events — shown in the panel
  const log = (msg, style) => {
    uiLog.push(msg);
    if (uiLog.length > 8) uiLog.shift();
    console.log(`%c[Quests]%c ${msg}`, "color:#5865F2;font-weight:bold", style || "");
  };
  const logOk = (msg) => log(msg, "color:#3BA55D");
  const logWarn = (msg) => log(msg, "color:#FAA61A");
  const logErr = (msg) => log(msg, "color:#ED4245");

  /* ---------- locating Discord internal modules ---------- */
  if (typeof webpackChunkdiscord_app === "undefined") {
    window.__questsRunning = false;
    logErr("webpackChunkdiscord_app not found — open the console on the discord.com tab, not another one.");
    return;
  }

  const wpRequire = webpackChunkdiscord_app.push([[Symbol()], {}, (r) => r]);
  webpackChunkdiscord_app.pop();

  // While scanning modules, silence i18n warnings: touching properties of
  // Proxy modules (like i18n) floods the console with "Requested message ...".
  const origWarn = console.warn;
  console.warn = (...a) => {
    const s = String(a[0] ?? "");
    if (s.includes("Requested message")) return;
    origWarn(...a);
  };
  const restoreWarn = () => { try { console.warn = origWarn; } catch (_) {} };

  // We find modules by their SET OF METHODS, not minified export names
  // (exports.A / exports.Ay / exports.Bo change with every build — that is why
  // the old script broke). Discord does not minify method names.
  const need = {
    api: ["get", "post", "put", "patch"],
    FluxDispatcher: ["dispatch", "subscribe", "unsubscribe"],
    QuestsStore: ["getQuest"],
    ChannelStore: ["getSortedPrivateChannels"],
    GuildChannelStore: ["getAllGuilds"],
    RunningGameStore: ["getRunningGames", "getGameForPID"],          // optional
    ApplicationStreamingStore: ["getStreamerActiveStreamMetadata"],  // optional
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

  // QuestsStore is the one that has both getQuest() and the quests map
  const isQuestsStore = (c) => {
    try { return c && typeof c.getQuest === "function" && c.quests instanceof Map; } catch (_) { return false; }
  };
  if (!isQuestsStore(found.QuestsStore)) {
    found.QuestsStore = null;
    scanExports((exp) => { if (isQuestsStore(exp)) { found.QuestsStore = exp; return true; } return false; });
  }

  // Some modules are Proxies that return a stub function for ANY property
  // (i18n is one: touching .getToken logs a warning and gives undefined). Such
  // a module fools method-based lookup, so found stores are validated by doing:
  // call the method and require a real result.
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

  // api is not in this list: it is picked below by probing candidates
  const missing = ["FluxDispatcher", "QuestsStore"].filter((k) => !found[k]);
  if (missing.length) {
    restoreWarn();
    window.__questsRunning = false;
    logErr(`Modules not found: ${missing.join(", ")}. Reload the page (F5), wait 5 sec and paste the script again.`);
    return;
  }

  /* ---------- identifying the real API client ---------- */
  // Several modules expose get/post/put/patch; we probe each and keep the one
  // that answers like the Discord API. This also detects the call style:
  // old ({url, body}) or new (url, {body}).
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
    logErr("API client not found. Reload the page and try again.");
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

  /* ---------- token and direct transport (v10) ---------- */
  // Try localStorage first (silently), then internal modules.
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
    ? "Transport: internal API client (fallback — direct v10 request with token)."
    : "Transport: internal API client.");

  const QuestsStore = found.QuestsStore;
  const ChannelStore = found.ChannelStore;
  const GuildChannelStore = found.GuildChannelStore;
  const RunningGameStore = found.RunningGameStore;
  const ApplicationStreamingStore = found.ApplicationStreamingStore;
  const FluxDispatcher = found.FluxDispatcher;

  const isApp = typeof DiscordNative !== "undefined";
  log(isApp ? "Client: desktop." : "Client: web (browser).");

  /* ---------- helpers ---------- */
  // ACHIEVEMENT_IN_ACTIVITY is excluded: the server replies 403 to its
  // heartbeat — those quests can only be done manually (OAuth flow).
  const SUPPORTED = ["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE", "PLAY_ON_DESKTOP", "PLAY_ON_DESKTOP_V2", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY"];
  const HEARTBEAT_TYPES = SUPPORTED.filter((t) => !t.startsWith("WATCH_VIDEO"));
  const LOC_QUEST_HOME = 11;   // location used for enroll/claim (same as the client itself)
  const CLAIM_PLATFORMS = [4, 0]; // 4 = PC (desktop), 0 — fallback

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

  // Progress may live under the task type name, under any other key,
  // or in stream_progress_seconds — we check everywhere.
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
        logOk(`Quest accepted: ${name}`);
        await sleep(2000);
        return QuestsStore.getQuest(quest.id) ?? quest;
      }
      if (isCaptcha(t)) logWarn(`Discord asks for a captcha for "${name}" — accept the quest manually.`);
      else logWarn(`Failed to accept "${name}": ${clean(t || res?.status || describe(res))}`);
      return null;
    } catch (e) {
      const why = describe(e);
      if (isCaptcha(why)) logWarn(`Captcha while accepting "${name}" — accept the quest manually.`);
      else logWarn(`Failed to accept "${name}": ${why}`);
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
    if (tries >= 3) { logWarn(`Claim "${name}" manually (Discover -> Quests).`); return false; }
    claimTries.set(quest.id, tries + 1);
    for (const platform of CLAIM_PLATFORMS) {
      const r = await claimOnce(quest, platform);
      if (r.ok) { logOk(`Reward claimed: ${name}`); return true; }
      if (isCaptcha(r.why)) { logWarn(`Captcha while claiming the reward for "${name}" — claim it manually.`); return false; }
    }
    logWarn(`Reward for "${name}" was not issued — claim it manually (Discover -> Quests).`);
    return false;
  }

  /* ---------- finding a channel for stream_key ---------- */
  // A plain DM channel works — confirmed by a live-tested implementation.
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

  /* ---------- state ---------- */
  const state = {
    processed: new Set(),   // quest ids we are done with
    inFlight: new Set(),    // quest ids currently running
    retryAt: new Map(),     // id -> next attempt time
    tries: new Map(),       // id -> attempt count
    enrollFailedAt: new Map(),
    status: new Map(),      // id -> {name, text}
    flash: new Map(),       // id -> {name, at} — recent completions for the panel
  };
  const setStatus = (id, name, text) => state.status.set(id, { name, text });
  const clearStatus = (id) => state.status.delete(id);

  /* ---------- UI: panel, visible only on the quests tab ---------- */
  // Lives in a Shadow DOM (does not touch Discord styles): dark "glass" with blur,
  // gradient accents per quest type, draggable by the header.
  let rescanRequested = false;
  window.__questsRescan = () => { rescanRequested = true; };

  const TYPE_META = {
    PLAY_ON_DESKTOP: { label: "game", c1: "#5865f2", c2: "#8b5cf6" },
    PLAY_ON_DESKTOP_V2: { label: "game", c1: "#5865f2", c2: "#8b5cf6" },
    WATCH_VIDEO: { label: "video", c1: "#eb459e", c2: "#f0b232" },
    WATCH_VIDEO_ON_MOBILE: { label: "video", c1: "#eb459e", c2: "#f0b232" },
    STREAM_ON_DESKTOP: { label: "stream", c1: "#00a8fc", c2: "#5865f2" },
    PLAY_ACTIVITY: { label: "activity", c1: "#23a55a", c2: "#00a8fc" },
  };
  const metaOf = (t) => TYPE_META[t] ?? { label: "quest", c1: "#5865f2", c2: "#8b5cf6" };

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
      .chip { position: fixed; right: 20px; bottom: 20px; z-index: 99999; display: none;
        align-items: center; gap: 9px; height: 42px; padding: 0 16px 0 13px; border-radius: 21px;
        border: 1px solid rgba(255,255,255,.09); cursor: pointer; color: #f2f3f5;
        background: linear-gradient(180deg, #303338, #232428); font-size: 13px; font-weight: 700;
        letter-spacing: .2px; box-shadow: 0 6px 20px rgba(0,0,0,.45);
        transition: transform .18s ease, box-shadow .18s ease; }
      .chip:hover { transform: translateY(-2px); box-shadow: 0 10px 28px rgba(0,0,0,.55); }
      .chip.on { border-color: rgba(88,101,242,.7); box-shadow: 0 6px 24px rgba(88,101,242,.35); }
      .dot { width: 9px; height: 9px; border-radius: 50%; background: #23a55a;
        box-shadow: 0 0 0 0 rgba(35,165,90,.5); animation: pulse 1.8s infinite; }
      @keyframes pulse { 70% { box-shadow: 0 0 0 8px rgba(35,165,90,0); } }
      .badge { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; display: none;
        align-items: center; justify-content: center; color: #fff; font-size: 11px; font-weight: 800;
        background: linear-gradient(135deg, #5865f2, #eb459e); }
      .panel { position: fixed; right: 20px; bottom: 72px; z-index: 99999; display: none; width: 348px;
        border-radius: 16px; overflow: hidden; color: #f2f3f5; font-size: 13px;
        background: rgba(32,34,38,.93);
        backdrop-filter: blur(16px) saturate(1.3); -webkit-backdrop-filter: blur(16px) saturate(1.3);
        border: 1px solid rgba(255,255,255,.09); box-shadow: 0 18px 50px rgba(0,0,0,.55); }
      .panel.show { animation: pop .24s cubic-bezier(.2,.9,.35,1.15); }
      @keyframes pop { from { opacity: 0; transform: translateY(12px) scale(.96); } }
      .head { display: flex; align-items: center; gap: 10px; padding: 12px 12px 11px; cursor: grab;
        background: linear-gradient(135deg, rgba(88,101,242,.18), rgba(235,69,158,.12));
        border-bottom: 1px solid rgba(255,255,255,.07); }
      .head:active { cursor: grabbing; }
      .ico { width: 36px; height: 36px; border-radius: 11px; flex: none; display: flex; align-items: center;
        justify-content: center; font-size: 18px; background: linear-gradient(135deg, #5865f2, #eb459e);
        box-shadow: 0 4px 14px rgba(88,101,242,.4); }
      .tt { flex: 1; min-width: 0; }
      .tt b { display: block; font-size: 14px; font-weight: 800; letter-spacing: .3px; }
      .tt span { display: block; font-size: 11px; font-weight: 600; color: #b5bac1; margin-top: 2px; }
      .xbtn { width: 28px; height: 28px; border-radius: 9px; border: none; flex: none; cursor: pointer;
        background: transparent; color: #949ba4; font-size: 13px; transition: background .15s, color .15s; }
      .xbtn:hover { background: rgba(255,255,255,.09); color: #fff; }
      .sum { height: 3px; background: rgba(255,255,255,.05); }
      .sum i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #23a55a, #00a8fc);
        transition: width 1s linear; }
      .body { padding: 10px 12px 6px; max-height: 47vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
      .body::-webkit-scrollbar { width: 8px; }
      .body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.13); border-radius: 4px; }
      .card { position: relative; border-radius: 12px; background: rgba(255,255,255,.05);
        padding: 10px 12px 9px 15px; overflow: hidden; }
      .card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--ac); }
      .c1 { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
      .c1 b { flex: 1; font-size: 12.5px; font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; }
      .tag { flex: none; font-size: 9px; font-weight: 800; letter-spacing: .7px; text-transform: uppercase;
        padding: 2px 8px; border-radius: 6px; color: #fff; background: var(--ac); opacity: .92; }
      .bar { position: relative; height: 7px; border-radius: 5px; background: rgba(255,255,255,.08); overflow: hidden; }
      .fill { position: relative; height: 100%; width: 0; border-radius: 5px;
        background: linear-gradient(90deg, var(--ac), var(--ac2)); transition: width 1.1s linear; }
      .fill::after { content: ""; position: absolute; inset: 0;
        background: linear-gradient(100deg, transparent 25%, rgba(255,255,255,.4) 50%, transparent 75%);
        animation: shine 1.7s infinite; }
      @keyframes shine { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
      .c2 { display: flex; justify-content: space-between; margin-top: 5px; font-size: 10.5px;
        font-weight: 600; color: #949ba4; }
      .c2 .t { color: #c6c9ce; font-variant-numeric: tabular-nums; }
      .card.err { --ac: #f0b232; --ac2: #f23f43; }
      .card.err .fill::after { animation: none; }
      .flash { display: flex; align-items: center; gap: 9px; padding: 9px 12px; border-radius: 12px;
        font-size: 12px; font-weight: 700; color: #7fe0a7; background: rgba(35,165,90,.16);
        border: 1px solid rgba(35,165,90,.45); }
      .empty { padding: 26px 8px 22px; text-align: center; color: #949ba4; }
      .empty i { display: block; font-style: normal; font-size: 30px; margin-bottom: 9px; }
      .empty b { display: block; color: #c6c9ce; font-size: 12.5px; font-weight: 700; margin-bottom: 3px; }
      .empty s { text-decoration: none; font-size: 11.5px; }
      .foot { border-top: 1px solid rgba(255,255,255,.07); padding: 10px 12px 12px; }
      .log { max-height: 84px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;
        font-size: 11px; line-height: 1.5; color: #949ba4; }
      .log::-webkit-scrollbar { width: 6px; }
      .log::-webkit-scrollbar-thumb { background: rgba(255,255,255,.13); border-radius: 3px; }
      .log div { display: flex; gap: 7px; overflow-wrap: anywhere; }
      .log i { flex: none; width: 6px; height: 6px; border-radius: 50%; margin-top: 5px; background: #00a8fc; }
      .log .ok i { background: #23a55a; } .log .err i { background: #f23f43; }
      .log .warn i { background: #f0b232; } .log .run i { background: #5865f2; }
      .set { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
      .lbl { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 11.5px;
        font-weight: 600; color: #949ba4; }
      .sw { position: relative; width: 34px; height: 20px; border-radius: 10px; background: #4e5058;
        transition: background .18s; flex: none; }
      .sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
        border-radius: 50%; background: #fff; transition: transform .18s ease; box-shadow: 0 1px 3px rgba(0,0,0,.4); }
      .sw.on { background: linear-gradient(90deg, #23a55a, #2dc777); }
      .sw.on::after { transform: translateX(14px); }
      .ghost { border: none; border-radius: 8px; background: rgba(255,255,255,.08); color: #c6c9ce;
        font-size: 11px; font-weight: 700; padding: 6px 11px; cursor: pointer; transition: background .15s, color .15s; }
      .ghost:hover { background: rgba(255,255,255,.15); color: #fff; }
    `;
    sh.appendChild(style);

    const chip = document.createElement("button");
    chip.className = "chip";
    chip.innerHTML = `<span class="dot"></span><span>Quests</span><span class="badge"></span>`;
    const badge = chip.querySelector(".badge");
    sh.appendChild(chip);

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="head">
        <div class="ico">⚡</div>
        <div class="tt"><b>Auto Quests</b><span>loading…</span></div>
        <button class="xbtn" title="Minimize">✕</button>
      </div>
      <div class="sum"><i></i></div>
      <div class="body"></div>
      <div class="foot">
        <div class="log"></div>
        <div class="set">
          <label class="lbl"><span class="sw"></span>Accept new ones</label>
          <button class="ghost">Refresh</button>
        </div>
      </div>`;
    sh.appendChild(panel);
    const bodyEl = panel.querySelector(".body");
    const logEl = panel.querySelector(".log");
    const subEl = panel.querySelector(".tt span");
    const sumEl = panel.querySelector(".sum i");
    const swEl = panel.querySelector(".sw");
    swEl.classList.toggle("on", CONFIG.autoEnroll);

    // drag by the header + remember position
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
    swEl.addEventListener("click", () => { CONFIG.autoEnroll = !CONFIG.autoEnroll; swEl.classList.toggle("on", CONFIG.autoEnroll); });

    const logClass = (l) =>
      l.startsWith("✔") ? "ok" : l.startsWith("✖") ? "err" : /reward|claim|captcha/i.test(l) ? "warn" : l.startsWith("▶") ? "run" : "info";

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
        ? `${active.length} running · ~${etaMax || 1} min left`
        : flash.length ? "all done ✓" : "waiting for quests…";

      const frag = document.createDocumentFragment();
      for (const f of flash) {
        const d = document.createElement("div");
        d.className = "flash";
        d.textContent = `✔ ${f.name} — done!`;
        frag.appendChild(d);
      }
      if (!active.length && !flash.length) {
        const d = document.createElement("div");
        d.className = "empty";
        d.innerHTML = `<i>🎮</i><b>No quests right now</b><s>New ones are picked up automatically</s>`;
        frag.appendChild(d);
      }
      for (const { name, text } of active) {
        const m = /([\d.]+)\s*\/\s*(\d+)\s*sec\s*\((\w+)\)/.exec(text);
        const err = /failed|error|reject/i.test(text);
        const meta = m ? metaOf(m[3]) : { label: "status", c1: "#f0b232", c2: "#f23f43" };
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
          s1.textContent = `${m[1]} of ${m[2]} sec`;
          const s2 = document.createElement("span");
          s2.className = "t";
          s2.textContent = `~${Math.max(1, Math.ceil(left / 60))} min left`;
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

      const logFrag = document.createDocumentFragment();
      for (const l of uiLog) {
        const d = document.createElement("div");
        d.className = logClass(l);
        const i = document.createElement("i");
        const s = document.createElement("span");
        s.textContent = l;
        d.append(i, s);
        logFrag.appendChild(d);
      }
      logEl.replaceChildren(logFrag);
      logEl.scrollTop = logEl.scrollHeight;
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
  // self-heal: if the panel vanished from the DOM (navigation/glitch) — rebuild
  const uiWatch = setInterval(() => {
    if (STOP.value) { clearInterval(uiWatch); return; }
    try {
      if (!document.getElementById("dqs-ui-host")?.shadowRoot) buildUI();
    } catch (_) {}
  }, 3000);
  cleanups.add(() => clearInterval(uiWatch));

  /* ---------- running a single quest ---------- */
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
          logOk(`✔ Quest completed: ${questName}`);
          resolve("done");
          return;
        }
        if (reason === "stop") { clearStatus(quest.id); resolve("stop"); return; }
        setStatus(quest.id, questName, `failed: ${reason}`);
        logWarn(`✖ "${questName}" — ${reason}`);
        resolve(reason);
      }

      const progress = (value, completedAt) => {
        if (typeof value === "number" && value > secondsDone) {
          secondsDone = value;
          lastProgressAt = Date.now();
          stuckBeats = 0;
        }
        setStatus(quest.id, questName, `${Math.round(secondsDone)}/${secondsNeeded} sec (${taskName})`);
        return typeof completedAt === "string" || secondsDone >= secondsNeeded;
      };
      const stalled = () => Date.now() - lastProgressAt > CONFIG.stallTimeoutMs;
      const watch = setInterval(() => { if (STOP.value) settle("stop"); else if (stalled()) settle("no progress from the server"); }, 5000);
      myCleanups.push(() => clearInterval(watch));

      setStatus(quest.id, questName, `start: ${Math.round(secondsDone)}/${secondsNeeded} sec (${taskName})`);
      log(`▶ "${questName}" — type ${taskName}, needs ${secondsNeeded} sec, already ${Math.round(secondsDone)}`);

      /* --- video --- */
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
              if (++apiFails >= CONFIG.maxApiFails) { settle(`API errors: ${describe(e)}`); return; }
              logWarn(`Request failed for "${questName}" (${describe(e)}), retry in 5 sec`);
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
        })().catch((e) => settle(`error: ${describe(e)}`));
        return;
      }

      /* --- all other types: heartbeat with stream_key --- */
      if (HEARTBEAT_TYPES.includes(taskName)) {
        (async () => {
          const channelId = await findChannelId();
          if (settled) return;
          if (!channelId) { settle("no DM/voice channel found"); return; }
          const streamKey = `call:${channelId}:1`;
          log(`"${questName}": heartbeat channel ${channelId} (${taskName}).`);

          // On desktop we additionally patch the stores so the client itself
          // also sends heartbeats (a second source of progress).
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

          // Primary transport is the internal client (works in both the web app and
          // the desktop client, CSP does not block it). On 401/403 we try a
          // direct token request once.
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
              if (/HTTP 40[13]/.test(why)) { settle(`server rejects the heartbeat (${why}) — this quest type cannot be done from the console`); return; }
              if (useDirect) { settle(`direct request not working: ${why}`); return; }
              if (++apiFails >= CONFIG.maxApiFails) { settle(`network errors: ${why}`); return; }
              logWarn(`Heartbeat failed for "${questName}" (${why}), retry in 10 sec`);
              await sleep(10000);
              continue;
            }
            if (res.status === 401 || res.status === 403) {
              if (!useDirect && authToken) {
                useDirect = true;
                logWarn(`Internal client rejected for "${questName}" (${res.status}), trying a direct request with the token`);
                await sleep(2000);
                continue;
              }
              settle(`HTTP ${res.status} — the server does not accept heartbeats from this session`);
              return;
            }
            if (res.status === 429) {
              logWarn(`Rate limited for "${questName}", pausing 30 sec`);
              await sleep(30000);
              continue;
            }
            if (res.status >= 400) {
              if (++apiFails >= CONFIG.maxApiFails) { settle(`heartbeat rejected: HTTP ${res.status}`); return; }
              await sleep(10000);
              continue;
            }
            apiFails = 0;
            const prog = readProgress(res?.body, taskName);
            const finished = progress(prog.value, prog.completedAt);
            if (typeof prog.value !== "number") {
              if (++stuckBeats >= 4) logWarn(`No progress for "${questName}" for ${stuckBeats} beats — the server apparently does not credit ${taskName} via console heartbeat`);
            }
            if (finished) {
              const body = { stream_key: streamKey, terminal: true };
              try { await (useDirect ? directPost(`/quests/${quest.id}/heartbeat`, body) : apiPost(`/quests/${quest.id}/heartbeat`, body)); } catch (_) {}
              settle("done");
              return;
            }
          }
        })().catch((e) => settle(`error: ${describe(e)}`));
        return;
      }

      settle(`unsupported task type (${Object.keys(tc.tasks).join(", ")})`);
    });
  }

  /* ---------- main loop ---------- */
  async function scanOnce() {
    const now = Date.now();
    const all = [...QuestsStore.quests.values()].filter((q) => {
      try { return new Date(q.config.expiresAt).getTime() > now; } catch (_) { return false; }
    });

    // 1) claim rewards for already completed quests
    for (const q of all) {
      if (STOP.value) return;
      if (state.processed.has(q.id) || state.inFlight.has(q.id)) continue;
      if (!q.userStatus?.completedAt) continue;
      if (q.userStatus.claimedAt) { state.processed.add(q.id); continue; }
      if (CONFIG.autoClaim) {
        if (await claimReward(q)) state.processed.add(q.id);
      } else {
        logOk(`✔ "${nameOf(q)}" already completed — claim the reward manually (Discover -> Quests).`);
        state.processed.add(q.id);
      }
    }

    // 2) start the incomplete ones
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
        logWarn(`• "${nameOf(q)}" — unsupported task type (${Object.keys(tc?.tasks ?? {}).join(", ") || "no tasks"}), skipped.`);
        continue;
      }

      let quest = q;
      if (!quest.userStatus?.enrolledAt) {
        if (!CONFIG.autoEnroll) {
          state.processed.add(q.id);
          logWarn(`• "${nameOf(q)}" — accept the quest manually first (Discover -> Quests), then rerun the script.`);
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
            logWarn(`• "${nameOf(quest)}" — 3 failed attempts, not touching it again this session.`);
          } else {
            state.retryAt.set(quest.id, Date.now() + 60 * 1000);
          }
        }
      });
      await sleep(1500); // small request spread
    }
    return started;
  }

  log("Script started. Stop: __questsStop() | Status: __questsStatus()");

  while (!STOP.value) {
    try {
      const started = await scanOnce();
      if (started > 0) log(`Started quests: ${started}`);
    } catch (e) {
      logErr(`Loop error: ${describe(e)}`);
    }
    for (let i = 0; i < CONFIG.rescanMs / 500 && !STOP.value; i++) {
      if (rescanRequested) { rescanRequested = false; break; } // the Refresh button wakes the loop
      await sleep(500);
    }
  }

  runCleanup();
  window.__questsRunning = false;
  log("Finished.");
})().catch((e) => {
  window.__questsRunning = false;
  console.error("[Quests] Unexpected error:", e);
});
