// The Android app's first screen: finds the user's PC and opens its own page in this WebView.
// Ways in: scan the QR code from the PC's Settings → Phone remote, type the address, or the saved PC.
// The check "is CiRoom there?" is done in Rust (src-tauri/src/pc_check.rs): the PC's server sends no CORS headers.
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { cancel, checkPermissions, Format, requestPermissions, scan } from "@tauri-apps/plugin-barcode-scanner";
import { type Pc, parseAddress, parseQr, pcLabel, pcUrl, readSaved, RELEASES_API, updateFrom } from "./connect-lib";
import { type Key, pickLang, STRINGS } from "./strings";

type Status = "ok" | "off" | "unreachable" | "other";

const params = new URLSearchParams(location.search);
// `?lang=fa` forces a language (for testing); otherwise the phone's.
const lang = params.get("lang") === "fa" || params.get("lang") === "en" ? (params.get("lang") as "fa" | "en") : pickLang(navigator.language);
const T = STRINGS[lang];
document.documentElement.lang = lang;
document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";

let version = ""; // the app's own version, filled in a moment after start (the About line shows it when it arrives)
void getVersion().then((v) => { version = v; document.querySelectorAll(".about bdi.ver").forEach((n) => { n.textContent = v; }); }).catch(() => undefined);

const SAVED_KEY = "ciroom.pc";
const app = document.getElementById("app")!;

function saved(): Pc | null {
  try {
    return readSaved(localStorage.getItem(SAVED_KEY));
  } catch {
    return null;
  }
}
/** Is this phone already paired with that PC? Asked of the app's Kotlin side (the cookie is HttpOnly). Unknown = yes. */
function isPaired(pc: Pc): boolean {
  try {
    const native = (window as unknown as { CiRoomNative?: { isPaired(host: string, port: number): boolean } }).CiRoomNative;
    return native ? native.isPaired(pc.host, pc.port) : true;
  } catch {
    return true;
  }
}
function save(pc: Pc | null): void {
  try {
    if (pc) localStorage.setItem(SAVED_KEY, JSON.stringify(pc));
    else localStorage.removeItem(SAVED_KEY);
  } catch {
    /* storage unavailable: the PC just isn't remembered */
  }
}

// ── tiny DOM helpers (text only: nothing typed or scanned is ever put in as HTML) ──────────────
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const { class: cls, ...rest } = props;
  const n = Object.assign(document.createElement(tag), rest);
  if (cls) n.className = cls;
  n.append(...kids);
  return n;
}
/** "CiRoom 0.1.5 · 192.168.1.20:1420": the app's version, and the PC when one is saved. Always left-to-right. */
function about(pc: Pc | null): HTMLElement {
  const ver = el("bdi", { class: "ver" }, version);
  const p = el("p", { class: "about" }, "CiRoom ", ver);
  if (pc) p.append(" · ", el("bdi", {}, pcLabel(pc)));
  return p;
}
/** A string from the table, with `{host}` shown as a left-to-right address. */
function text(key: Key, host?: string): (Node | string)[] {
  const parts = T[key].split("{host}");
  if (parts.length === 1 || host === undefined) return [T[key]];
  return [parts[0], el("bdi", {}, host), parts.slice(1).join("{host}")];
}
function button(key: Key, onClick: () => void, cls = "", host?: string): HTMLButtonElement {
  const b = el("button", { class: cls, type: "button" }, ...text(key, host));
  b.onclick = onClick;
  return b;
}
function show(...nodes: Node[]): void {
  document.body.classList.remove("scanning");
  app.replaceChildren(...nodes);
}

// ── update notice ──────────────────────────────────────────────────────────────────────────────
// Once per start: is there a newer release with an Android APK? Any failure (offline, rate limit, odd answer) is silent.
const LATER_KEY = "ciroom.updateLater";
const updateBar = el("div", { class: "update", hidden: true });
document.body.prepend(updateBar);

function showUpdate(version: string, url: string): void {
  const later = el("button", { type: "button", class: "link" }, T.later);
  later.onclick = () => {
    try { localStorage.setItem(LATER_KEY, version); } catch { /* not remembered: it shows again next start */ }
    updateBar.hidden = true;
  };
  const get = el("button", { type: "button", class: "primary" }, T.download);
  get.onclick = () => {
    try { (window as unknown as { CiRoomNative?: { openUrl(url: string): boolean } }).CiRoomNative?.openUrl(url); } catch { /* nothing to open it with */ }
  };
  const [before, after] = T.updateAvailable.split("{v}");
  updateBar.replaceChildren(el("p", {}, before, el("bdi", {}, version), after), el("div", { class: "row" }, get, later));
  updateBar.hidden = false;
}

async function checkUpdate(): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const current = await getVersion();
    const res = await fetch(RELEASES_API, { signal: ctrl.signal, headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return;
    const up = updateFrom(await res.json(), current);
    if (!up) return;
    let later: string | null = null;
    try { later = localStorage.getItem(LATER_KEY); } catch { /* shown */ }
    if (later !== up.version) showUpdate(up.version, up.url);
  } catch {
    /* offline or blocked: say nothing */
  } finally {
    clearTimeout(timer);
  }
}

// ── screens ────────────────────────────────────────────────────────────────────────────────────
function home(error?: Key): void {
  const pc = saved();
  const paired = pc ? isPaired(pc) : false;
  const field = el("input", { type: "text", inputMode: "decimal", autocomplete: "off", placeholder: T.addressPlaceholder, id: "addr", enterKeyHint: "go" });
  field.setAttribute("dir", "ltr");
  field.setAttribute("autocapitalize", "off");
  field.spellcheck = false;
  const go = () => {
    const parsed = parseAddress(field.value);
    if (!parsed) return home("errBadAddress");
    void connect(parsed);
  };
  field.onkeydown = (e) => { if (e.key === "Enter") go(); };
  const label = el("label", { htmlFor: "addr" }, T.addressLabel);

  show(
    el("h1", {}, "CiRoom"),
    el("p", { class: "tag" }, T.tagline),
    ...(error ? [el("p", { class: "err", role: "alert" }, ...text(error))] : []),
    ...(pc ? [button("open", () => void connect(pc), paired ? "primary" : "", pcLabel(pc)), button("forget", () => { save(null); home(); }, "link")] : []),
    button("scan", () => void scanQr(), paired ? "" : "primary"),
    el("div", { class: "or" }, T.or),
    el("div", {}, label, el("div", { class: "row" }, field, button("connect", go))),
    about(pc),
  );
}

let attempt = 0; // a newer connect/cancel makes older ones stop quietly

function connecting(pc: Pc): void {
  attempt++;
  show(el("div", { class: "spin" }), el("p", { class: "msg", role: "status" }, ...text("connecting", pcLabel(pc))), button("cancel", () => { attempt++; home(); }, "link"));
}

function failed(pc: Pc | null, status: Status): void {
  const key: Key = status === "other" ? "errOther" : status === "off" ? "errOff" : "errUnreachable";
  show(
    el("h1", {}, "CiRoom"),
    el("p", { class: "err", role: "alert" }, ...text(key)),
    ...(pc ? [button("tryAgain", () => void connect(pc), "primary")] : []),
    button("changePc", () => home(), pc ? "" : "primary"),
    about(pc),
  );
}

/** Is CiRoom there? Three tries, one second apart (the server re-listens a moment after the phone remote is switched on). */
async function probe(pc: Pc, me: number): Promise<Status | null> {
  let last: Status = "unreachable";
  for (let i = 0; i < 3; i++) {
    if (me !== attempt) return null;
    try {
      last = await invoke<Status>("check_pc", { host: pc.host, port: pc.port });
    } catch {
      last = "unreachable";
    }
    if (last === "ok" || last === "other") break;
    if (i < 2) await new Promise((r) => setTimeout(r, 1000));
  }
  return me === attempt ? last : null;
}

async function connect(pc: Pc, pin?: string): Promise<void> {
  connecting(pc);
  const me = attempt;
  const status = await probe(pc, me);
  if (status === null) return; // cancelled
  if (status !== "ok") return failed(pc, status);
  save(pc);
  // replace: the Connect page stays out of the Back history (Back on the PC page must not bounce into it).
  window.location.replace(pcUrl(pc, pin));
}

let scanCancelled = false;

async function scanQr(): Promise<void> {
  scanCancelled = false;
  try {
    let perm = await checkPermissions();
    if (perm !== "granted") perm = await requestPermissions();
    if (perm !== "granted") return home("errCamera");
  } catch {
    return home("errCamera");
  }
  await cancel().catch(() => undefined); // a scan left open by an earlier page load would make this one fail
  document.body.classList.add("scanning");
  app.replaceChildren(
    el("div", { class: "scan" }, el("div", { class: "frame" }), el("p", { class: "msg" }, T.scanHint), button("cancel", () => { scanCancelled = true; void cancel().catch(() => undefined); home(); }, "link")),
  );
  try {
    const r = await scan({ windowed: true, formats: [Format.QRCode] });
    const parsed = parseQr(r.content);
    if (!parsed) return home("errBadQr");
    await connect(parsed.pc, parsed.pin);
  } catch (e) {
    // Our Cancel button rejects the scan on purpose (the screen is already back). Anything else (Back button, camera
    // trouble) says so instead of silently returning.
    console.warn("scan ended:", JSON.stringify(e), String(e));
    if (!scanCancelled) home("errScan");
  }
}

// ── start ──────────────────────────────────────────────────────────────────────────────────────
// `?error=unreachable` comes from the app's Kotlin side: the PC's page failed to load (PC closed, Wi-Fi lost).
const startError = params.get("error");
const savedPc = saved();
if (startError) {
  failed(savedPc, startError === "other" ? "other" : "unreachable");
} else if (savedPc && !params.has("noauto") && isPaired(savedPc)) {
  void connect(savedPc);
} else if (savedPc && !params.has("noauto")) {
  home("errUnpaired"); // saved, but never paired: the PC's PIN page would be a dead end, so offer the QR scan first
} else {
  home();
}

void checkUpdate();
