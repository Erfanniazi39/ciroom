// The Android app's first screen: finds the user's PC and opens its own page in this WebView.
// Ways in: scan the QR code from the PC's Settings → Phone remote, type the address, or the saved PC.
// The check "is CiRoom there?" is done in Rust (src-tauri/src/pc_check.rs): the PC's server sends no CORS headers.
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { cancel, checkPermissions, Format, requestPermissions, scan } from "@tauri-apps/plugin-barcode-scanner";
import { type Pc, parseAddress, parseQr, parseUpdateInfo, pcLabel, pcUrl, pendingUpdate, readSaved, startAction, type UpdateInfo } from "./connect-lib";
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
// The app's Kotlin side asks GitHub (in the background at every start, at most once an hour) and keeps the newest release
// that has an Android APK. This page only reads it. It can't ask GitHub itself: the page navigates to the PC a second
// after start, which would cancel the request.
type Native = { updateInfo?(): string; checkForUpdate?(): void; openUrl?(url: string): boolean };
const native = (): Native | undefined => (window as unknown as { CiRoomNative?: Native }).CiRoomNative;
const LATER_KEY = "ciroom.updateLater";
const updateBar = el("div", { class: "update", hidden: true });
document.body.prepend(updateBar);

function readInfo(): UpdateInfo {
  try { return parseUpdateInfo(native()?.updateInfo?.()); } catch { return parseUpdateInfo(null); }
}
function laterVersion(): string | null {
  try { return localStorage.getItem(LATER_KEY); } catch { return null; }
}
/** The newer version to tell the user about, if any (not the one they put off). */
function pending(ignoreLater = false) {
  return pendingUpdate(readInfo(), version, ignoreLater ? null : laterVersion());
}

function showUpdate(newVersion: string, url: string): void {
  const later = el("button", { type: "button", class: "link" }, T.later);
  later.onclick = () => {
    try { localStorage.setItem(LATER_KEY, newVersion); } catch { /* not remembered: it shows again next start */ }
    updateBar.hidden = true;
  };
  const get = el("button", { type: "button", class: "primary" }, T.download);
  get.onclick = () => {
    try { native()?.openUrl?.(url); } catch { /* nothing to open it with */ }
  };
  const [before, after] = T.updateAvailable.split("{v}");
  updateBar.replaceChildren(el("p", {}, before, el("bdi", {}, newVersion), after), el("div", { class: "row" }, get, later));
  updateBar.hidden = false;
}
function refreshUpdateBar(): void {
  const up = pending();
  if (up) showUpdate(up.version, up.url);
  else updateBar.hidden = true;
}

/** The "Check for updates" link: asks the Kotlin side to check now, then reads its answer for up to 12 s. */
async function checkNow(line: HTMLElement): Promise<void> {
  const say = (key: Key | null) => line.replaceChildren(...(key ? [T[key]] : []));
  say("checking");
  line.setAttribute("role", "status");
  try { native()?.checkForUpdate?.(); } catch { /* answered below as "couldn't check" */ }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 150 : 300));
    const info = readInfo();
    if (info.checking) continue;
    const up = pending(true); // asked on purpose: shown even if "Later" was pressed for it
    if (up) { try { localStorage.removeItem(LATER_KEY); } catch { /* ignored */ } showUpdate(up.version, up.url); return say(null); }
    return say(info.ok === true ? "upToDate" : "checkFailed");
  }
  say("checkFailed");
}

// ── screens ────────────────────────────────────────────────────────────────────────────────────
function home(error?: Key): void {
  const pc = saved();
  const paired = pc ? isPaired(pc) : false;
  const field = el("input", { type: "text", inputMode: "url", autocomplete: "off", placeholder: T.addressPlaceholder, id: "addr", enterKeyHint: "go" });
  field.setAttribute("dir", "ltr");
  field.setAttribute("autocapitalize", "off");
  field.setAttribute("autocorrect", "off");
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
    checkLine(),
    about(pc),
  );
  refreshUpdateBar();
}

/** The small "Check for updates" link, and where its answer appears. */
function checkLine(): HTMLElement {
  const line = el("p", { class: "checkline" });
  const link = button("checkUpdates", () => void checkNow(line), "link");
  line.append(link);
  return line;
}

let attempt = 0; // a newer connect/cancel makes older ones stop quietly

function connecting(pc: Pc): void {
  attempt++;
  updateBar.hidden = true;
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
  refreshUpdateBar();
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
// `version` arrives a moment after start (getVersion); the decision needs it, so wait for it (it is a local call).
void (async () => {
  try { version = await getVersion(); } catch { /* unknown version: nothing counts as newer */ }
  const action = startAction({
    error: !!startError,
    noauto: params.has("noauto"),
    saved: !!savedPc,
    paired: savedPc ? isPaired(savedPc) : false,
    update: pending() !== null,
  });
  if (action === "error") failed(savedPc, startError === "other" ? "other" : "unreachable");
  else if (action === "connect" && savedPc) void connect(savedPc);
  else if (action === "unpaired") home("errUnpaired"); // saved, but never paired: the PC's PIN page would be a dead end, so offer the QR scan first
  else home(); // "update": the saved PC's big Open button and the update bar are on this screen
})();
