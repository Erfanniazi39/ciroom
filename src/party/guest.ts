/**
 * Watch-party guest page (served at /party by dev/party.js, bundled with esbuild).
 * Self-contained on purpose: the guest never loads CiRoom's app, only this page and /api/party/*.
 * All text from the network is put on the page with textContent (never as HTML).
 *
 * Sync: the host's player is the clock. The server sends { position, paused, rate, at } (at = server time);
 * we estimate the server clock from status round-trips and steer our player toward
 *   target = position + (serverNow - at) * rate
 * small drift → nudge playback speed; big drift → jump. While we load, we report "buffering" and the host waits.
 */
import { MseStream, streamMime, type StreamSource } from "@/lib/mse";
import { parseVtt, type Cue, type ProbeInfo } from "@/api/stream";

// ── tiny DOM helper ───────────────────────────────────────────────────────────────────────────
type Kids = (Node | string | null | false | undefined)[];
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: Kids): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el) (el as any)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c) el.append(c);
  return el;
}
const $app = document.getElementById("app")!;
const fmt = (s: number) => {
  s = Math.max(0, Math.floor(s));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`;
};
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const store = {
  get: (k: string) => { try { return localStorage.getItem(`ciroom.party.${k}`); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(`ciroom.party.${k}`, v); } catch { /* private mode */ } },
};

function screen(title: string, body: string, extra?: Node) {
  $app.replaceChildren(h("div", { class: "screen" }, h("div", { class: "card" },
    h("div", { class: "brand", text: "CiRoom" }), h("h1", { text: title }), h("p", { text: body }), extra)));
}

// ── join ──────────────────────────────────────────────────────────────────────────────────────
async function boot() {
  let me: { guest: { id: string; name: string } | null; hostName: string };
  try {
    const r = await fetch("/api/party/me");
    if (!r.ok) { screen("No watch party right now", "The host hasn't started a watch party. Ask them to turn it on, then reload this page."); return; }
    me = await r.json();
  } catch { screen("Can't reach the host", "Check that Tailscale is connected, then reload this page."); return; }

  if (me.guest) { history.replaceState(null, "", "/party"); start(me.guest, me.hostName, false); return; }

  const token = new URLSearchParams(location.hash.slice(1)).get("i");
  if (!token) { screen("You need an invite", `Ask ${me.hostName} for a watch-party invite link.`); return; }

  const name = h("input", { class: "field", placeholder: "Your name", maxLength: 24, value: store.get("name") ?? "", autofocus: true });
  const err = h("div", { class: "error" });
  const btn = h("button", { class: "primary", text: "Join" });
  const join = async () => {
    btn.disabled = true;
    const r = await post("/api/party/join", { invite: token, name: name.value.trim() });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { err.textContent = d.error ?? "Couldn't join."; btn.disabled = false; return; }
    store.set("name", name.value.trim());
    history.replaceState(null, "", "/party"); // the invite is used up: drop it from the address bar
    start(d.guest, me.hostName, true);
  };
  btn.addEventListener("click", join);
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") void join(); });
  screen(`${me.hostName} invited you to watch together`, "Type your name and join. The video plays here in sync with the host, and you can chat.",
    h("div", { class: "join" }, name, btn, err));
}

// ── the party ─────────────────────────────────────────────────────────────────────────────────
interface HostState {
  type: "state"; hostName: string; hostOnline: boolean; guestControl: boolean;
  media: { key: string; title: string; subtitle: string | null; duration: number } | null;
  position: number; paused: boolean; rate: number; at: number; now: number;
}

function start(me: { id: string; name: string }, hostName: string, gestured: boolean) {
  // ---- layout
  const video = h("video", { playsInline: true, class: "video" });
  const cue = h("div", { class: "cue", dir: "auto" });
  const overlay = h("div", { class: "overlay hidden" });
  const titleEl = h("div", { class: "title", text: "Waiting for the host…" });
  const subEl = h("div", { class: "subtitle" });
  const dot = h("span", { class: "dot" });
  const statusEl = h("span", { class: "status", text: "Connecting…" });
  const playBtn = h("button", { class: "ctl", "aria-label": "Play or pause", text: "▶" });
  const timeEl = h("span", { class: "time", text: "0:00 / 0:00" });
  const bar = h("div", { class: "bar" }, h("div", { class: "buf" }), h("div", { class: "fill" }));
  const vol = h("input", { type: "range", min: "0", max: "100", value: store.get("volume") ?? "100", class: "vol", "aria-label": "Volume" });
  const muteBtn = h("button", { class: "ctl", "aria-label": "Mute", text: "🔊" });
  const subsSel = h("select", { class: "subs", "aria-label": "Subtitles" });
  const delayEl = h("span", { class: "delay", text: "" });
  const delayMinus = h("button", { class: "ctl small", text: "−", title: "Subtitles earlier (0.1 s)" });
  const delayPlus = h("button", { class: "ctl small", text: "+", title: "Subtitles later (0.1 s)" });
  const fsBtn = h("button", { class: "ctl", "aria-label": "Fullscreen", text: "⛶" });
  const stage = h("div", { class: "stage" }, video, cue, overlay,
    h("div", { class: "controls" }, bar,
      h("div", { class: "row" }, playBtn, timeEl, h("span", { class: "grow" }), muteBtn, vol, subsSel, delayMinus, delayEl, delayPlus, fsBtn)));
  const chatList = h("div", { class: "chat-list" });
  const chatInput = h("input", { class: "field", placeholder: "Message…", maxLength: 500, dir: "auto" });
  const chatErr = h("div", { class: "error small" });
  const leaveBtn = h("button", { class: "link", text: "Leave party" });
  const side = h("aside", { class: "side" },
    h("div", { class: "side-head" }, h("span", { text: "Chat" }), leaveBtn),
    chatList,
    chatErr,
    h("form", { class: "chat-form", onsubmit: (e: Event) => { e.preventDefault(); void sendChat(); } }, chatInput, h("button", { class: "primary small", type: "submit", text: "Send" })));
  $app.replaceChildren(h("div", { class: "page" },
    h("header", { class: "head" }, h("div", { class: "brand", text: "CiRoom" }), h("div", { class: "now" }, titleEl, subEl), h("div", { class: "conn" }, dot, statusEl)),
    h("main", { class: "main" }, stage, side)));

  // ---- state
  let host: HostState | null = null;
  let receivedAt = 0;
  let clockOffset = 0; // serverNow ≈ Date.now() + clockOffset
  let bestRtt = Infinity;
  let mediaKey = "";
  let probe: ProbeInfo | null = null;
  let mse: MseStream | null = null;
  let cues: Cue[] = [];
  let subDelay = Number(store.get("subDelay") ?? 0) || 0;
  let lastSyncSeek = 0;
  let lastSyncTarget = -1;
  let needsClick = !gestured;
  let closed = false;
  let lastStatus = "";
  let lastStatusAt = 0;
  let nudging = false;
  let localHold = 0; // after our own play/pause/seek click, don't fight the host's answer for a moment

  const serverNow = () => Date.now() + clockOffset;
  const target = () => {
    if (!host) return 0;
    if (host.paused) return host.position;
    return host.position + Math.max(0, (serverNow() - host.at) / 1000) * host.rate;
  };
  const bufferedAhead = (t: number) => {
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) - 0.3 <= t && t <= b.end(i)) return b.end(i) - t;
    return 0;
  };

  const showOverlay = (text: string, clickable = false) => {
    overlay.replaceChildren(h("div", { class: "overlay-card" }, h("div", { text }), clickable ? h("button", { class: "primary", text: "Start watching" }) : null));
    overlay.classList.remove("hidden");
    overlay.classList.toggle("clickable", clickable);
  };
  const hideOverlay = () => overlay.classList.add("hidden");
  overlay.addEventListener("click", () => {
    if (!overlay.classList.contains("clickable")) return;
    needsClick = false;
    hideOverlay();
    video.muted = false;
    void video.play().catch(() => undefined);
  });

  // ---- media
  const source = (key: string): StreamSource => ({
    seekPoint: async (_p, t) => {
      try {
        const r = await fetch(`/api/party/seekpoint?k=${key}&t=${t.toFixed(3)}`);
        const d = await r.json();
        return typeof d.start === "number" && d.start <= t + 0.01 ? d.start : t;
      } catch { return t; }
    },
    streamUrl: (_p, t) => `/api/party/stream?k=${key}&t=${t.toFixed(3)}`,
  });

  async function loadMedia(key: string) {
    mse?.destroy();
    mse = null;
    probe = null;
    cues = [];
    cue.textContent = "";
    mediaKey = key;
    subsSel.replaceChildren(h("option", { value: "-1", text: "Subtitles off" }));
    try {
      const r = await fetch(`/api/party/probe?k=${key}`);
      if (!r.ok) throw new Error();
      const p: ProbeInfo = await r.json();
      if (mediaKey !== key) return;
      probe = p;
      const mime = streamMime(p);
      if (!MseStream.supported(mime)) { showOverlay("This browser can't play this video. Try Chrome or Edge."); return; }
      mse = new MseStream(video, "", p.duration, mime, true, (m) => showOverlay(m.replace(/ or use the full player\.?|Try the full player\.?/g, "")), source(key));
      await mse.start(target());
      lastSyncSeek = Date.now();
      // Subtitles: remember the language she picked last time.
      const want = store.get("subLang");
      p.subtitles.forEach((s) => subsSel.append(h("option", { value: String(s.index), text: s.label || `Subtitle ${s.index + 1}` })));
      const pick = want && want !== "off" ? p.subtitles.find((s) => (s.label || "").startsWith(want)) : undefined;
      subsSel.value = pick ? String(pick.index) : "-1";
      void loadSubs();
    } catch {
      if (mediaKey === key) showOverlay("Couldn't open the video. The host may have changed it; waiting…");
    }
  }

  async function loadSubs() {
    const i = Number(subsSel.value);
    cues = [];
    cue.textContent = "";
    if (i < 0 || !mediaKey) return;
    const key = mediaKey;
    const r = await fetch(`/api/party/subtitle.vtt?k=${key}&i=${i}`).catch(() => null);
    if (r?.ok && key === mediaKey) cues = parseVtt(await r.text());
  }
  subsSel.addEventListener("change", () => {
    const opt = subsSel.selectedOptions[0];
    store.set("subLang", subsSel.value === "-1" ? "off" : (opt?.textContent ?? "").split(" · ")[0]);
    void loadSubs();
  });
  const showDelay = () => { delayEl.textContent = subDelay ? `${subDelay > 0 ? "+" : ""}${subDelay.toFixed(1)}s` : "0.0s"; };
  showDelay();
  delayMinus.addEventListener("click", () => { subDelay = Math.round((subDelay - 0.1) * 10) / 10; store.set("subDelay", String(subDelay)); showDelay(); });
  delayPlus.addEventListener("click", () => { subDelay = Math.round((subDelay + 0.1) * 10) / 10; store.set("subDelay", String(subDelay)); showDelay(); });

  // ---- local controls
  const applyVol = () => { video.volume = Number(vol.value) / 100; store.set("volume", vol.value); };
  applyVol();
  vol.addEventListener("input", () => { applyVol(); if (video.muted) { video.muted = false; muteBtn.textContent = "🔊"; } });
  muteBtn.addEventListener("click", () => { video.muted = !video.muted; muteBtn.textContent = video.muted ? "🔇" : "🔊"; });
  fsBtn.addEventListener("click", () => { if (document.fullscreenElement) void document.exitFullscreen(); else void stage.requestFullscreen().catch(() => undefined); });
  video.addEventListener("dblclick", () => fsBtn.click());

  // ---- shared controls (sent to the host; the host's player answers for everyone)
  async function cmd(c: "play" | "pause" | "seekTo", value?: number) {
    if (!host?.guestControl || !mediaKey) return;
    localHold = Date.now();
    const r = await post("/api/party/cmd", { cmd: c, value, key: mediaKey }).catch(() => null);
    if (r && !r.ok) { const d = await r.json().catch(() => ({})); flash(d.error ?? "Couldn't send that to the host."); }
  }
  const togglePlay = () => {
    if (needsClick) { overlay.click(); return; }
    if (!host?.media) return;
    if (host.paused) { void cmd("play"); void video.play().catch(() => undefined); } else { void cmd("pause"); video.pause(); }
  };
  playBtn.addEventListener("click", togglePlay);
  video.addEventListener("click", togglePlay);
  bar.addEventListener("click", (e) => {
    if (!host?.media || !host.guestControl) return;
    const r = bar.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (probe?.duration || host.media.duration);
    void cmd("seekTo", t);
    mse?.seek(t);
    lastSyncSeek = Date.now();
  });
  window.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
    if (e.key === " " || e.key === "k") { e.preventDefault(); togglePlay(); }
    else if (e.key === "f") fsBtn.click();
    else if (e.key === "m") muteBtn.click();
    else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && host?.media && host.guestControl) {
      e.preventDefault();
      const t = Math.max(0, target() + (e.key === "ArrowLeft" ? -10 : 10));
      void cmd("seekTo", t);
      mse?.seek(t);
      lastSyncSeek = Date.now();
    }
  });

  let flashTimer = 0;
  function flash(text: string) {
    chatErr.textContent = text;
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => { chatErr.textContent = ""; }, 4000);
  }

  // ---- chat
  function addMsg(m: { id: string; from: string; text: string; at: number; host?: boolean; system?: boolean }) {
    if (m.system) chatList.append(h("div", { class: "sys", text: m.text }));
    else {
      const mine = !m.host && m.from === me.name;
      chatList.append(h("div", { class: `msg ${mine ? "mine" : ""} ${m.host ? "host" : ""}` },
        h("span", { class: "from", text: m.from }), h("span", { class: "bubble", dir: "auto", text: m.text })));
    }
    while (chatList.childElementCount > 150) chatList.firstElementChild?.remove();
    chatList.scrollTop = chatList.scrollHeight;
  }
  async function sendChat() {
    const t = chatInput.value.trim();
    if (!t) return;
    chatInput.value = "";
    const r = await post("/api/party/chat", { text: t }).catch(() => null);
    if (r && !r.ok) { const d = await r.json().catch(() => ({})); flash(d.error ?? "Not sent."); chatInput.value = t; }
  }
  leaveBtn.addEventListener("click", async () => {
    if (!confirmLeave()) return;
    await post("/api/party/leave", {}).catch(() => undefined);
  });
  let leaveArmed = 0;
  function confirmLeave() {
    // A second click within 3 s confirms (no browser dialog).
    if (Date.now() - leaveArmed < 3000) return true;
    leaveArmed = Date.now();
    leaveBtn.textContent = "Click again to leave";
    window.setTimeout(() => { leaveBtn.textContent = "Leave party"; }, 3000);
    return false;
  }

  // ---- connection to the host
  const es = new EventSource("/api/party/events");
  es.onopen = () => { dot.className = "dot on"; };
  es.onmessage = (ev) => {
    let m: any;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "hello") { chatList.replaceChildren(); (m.chat ?? []).forEach(addMsg); }
    else if (m.type === "chat") addMsg(m.msg);
    else if (m.type === "closed") end(m.reason ?? "The watch party ended.");
    else if (m.type === "state") onState(m as HostState);
  };
  es.onerror = async () => {
    dot.className = "dot";
    statusEl.textContent = "Reconnecting…";
    const r = await fetch("/api/party/me").catch(() => null);
    if (r && r.status === 403) end("The host ended the watch party.");
    else if (r && r.ok && !(await r.json().catch(() => ({}))).guest) end("Your access was removed by the host.");
  };

  function end(reason: string) {
    if (closed) return;
    closed = true;
    es.close();
    mse?.destroy();
    screen("Watch party ended", reason);
  }

  function onState(s: HostState) {
    host = s;
    receivedAt = Date.now();
    if (bestRtt === Infinity) clockOffset = s.now - Date.now(); // first guess until a round-trip sample arrives
    hostName = s.hostName;
    if (!s.media) {
      titleEl.textContent = s.hostOnline ? `Waiting for ${s.hostName} to play something…` : `${s.hostName}'s CiRoom is closed`;
      subEl.textContent = "";
      if (mediaKey) { mse?.destroy(); mse = null; mediaKey = ""; }
      return;
    }
    titleEl.textContent = s.media.title;
    subEl.textContent = s.media.subtitle ?? "";
    document.title = `${s.media.title} · CiRoom watch party`;
    if (s.media.key !== mediaKey) void loadMedia(s.media.key);
    playBtn.disabled = !s.guestControl;
    bar.classList.toggle("locked", !s.guestControl);
  }

  // ---- the sync loop
  window.setInterval(() => {
    if (closed) return;
    const t = target();
    const cur = video.currentTime;
    const ready = !!mse && video.readyState >= 3 && (bufferedAhead(cur) >= 1.5 || cur >= (probe?.duration ?? 0) - 2) && Math.abs(cur - t) < 2.5;

    if (host?.media && mse && Date.now() - localHold > 1200) {
      const drift = cur - t;
      if (host.paused) {
        if (!video.paused) video.pause();
        if (Math.abs(drift) > 0.12 && Date.now() - lastSyncSeek > 800) { mse.seek(t); lastSyncSeek = Date.now(); lastSyncTarget = t; }
        video.playbackRate = 1;
      } else {
        const sinceSeek = Date.now() - lastSyncSeek;
        if (Math.abs(drift) > 1.5 && (sinceSeek > 3000 || Math.abs(t - lastSyncTarget) > 6)) {
          // Far off (joined late, big network hiccup): jump. Not for small gaps: with stream-copied video a jump
          // decodes from the previous keyframe (up to ~10 s of frames), which stalls about as long as the gap.
          mse.seek(t + (bufferedAhead(t) > 1 ? 0.15 : 0.6)); // a little ahead: loading takes a moment
          lastSyncSeek = Date.now();
          lastSyncTarget = t;
        } else {
          // Close: play a little faster/slower in proportion to the gap (0.5 s behind → ×1.12 for ~4 s; voices keep
          // their pitch). Starts above 0.1 s, stops within 0.04 s.
          if (Math.abs(drift) > 0.1) nudging = true;
          else if (Math.abs(drift) < 0.04) nudging = false;
          const k = -Math.sign(drift) * Math.min(0.15, Math.max(0.03, Math.abs(drift) * 0.25)); // at least 3%: no slow tail
          video.playbackRate = nudging ? host.rate * (1 + k) : host.rate;
        }
        if (video.paused && !needsClick && video.readyState >= 2) {
          video.play().catch(() => { needsClick = true; });
        }
      }
    }
    if (needsClick && host?.media && !host.paused) showOverlay(`${host.hostName} is playing. Click to start watching in sync.`, true);
    else if (overlay.classList.contains("clickable") && !needsClick) hideOverlay();

    // header status
    if (host) {
      const late = Date.now() - receivedAt > 6000;
      statusEl.textContent = late ? "Reconnecting…" : !host.hostOnline ? `${host.hostName} is offline` : !host.media ? `With ${host.hostName}` : !ready ? "Loading…" : host.paused ? "Paused" : "In sync";
    }
    // controls
    const dur = probe?.duration || host?.media?.duration || 0;
    const shown = host?.media ? cur : 0;
    timeEl.textContent = `${fmt(shown)} / ${fmt(dur)}`;
    (bar.children[1] as HTMLElement).style.width = dur ? `${(shown / dur) * 100}%` : "0";
    const ahead = bufferedAhead(cur);
    (bar.children[0] as HTMLElement).style.left = dur ? `${(shown / dur) * 100}%` : "0";
    (bar.children[0] as HTMLElement).style.width = dur ? `${(ahead / dur) * 100}%` : "0";
    playBtn.textContent = host && !host.paused ? "❚❚" : "▶";

    // status to the server (and a clock sample back): every second, or at once when loading state flips
    const status = JSON.stringify({ buffering: !!host?.media && !ready, paused: video.paused, key: mediaKey });
    if (status !== lastStatus || Date.now() - lastStatusAt > 1000) {
      lastStatus = status;
      lastStatusAt = Date.now();
      const sent = Date.now();
      post("/api/party/status", { buffering: !!host?.media && !ready, position: cur, paused: video.paused, key: mediaKey })
        .then((r) => r.json())
        .then((d) => {
          const rtt = Date.now() - sent;
          if (typeof d.now === "number" && rtt <= bestRtt * 1.5 + 20) { bestRtt = Math.min(bestRtt, rtt); clockOffset = d.now + rtt / 2 - Date.now(); }
          if (rtt > bestRtt * 4) bestRtt = Math.min(rtt, bestRtt * 2); // the network changed: allow re-learning
        })
        .catch(() => undefined);
    }
  }, 250);

  // subtitles (every frame)
  const drawCue = () => {
    if (cues.length) {
      const t = video.currentTime - subDelay;
      let txt = "";
      for (const c of cues) { if (c.start > t) break; if (t < c.end) { txt = c.text; break; } }
      if (cue.textContent !== txt) cue.textContent = txt;
    }
    requestAnimationFrame(drawCue);
  };
  requestAnimationFrame(drawCue);
  video.addEventListener("waiting", () => mse?.onWaiting());
  void hostName;
}

void boot();
