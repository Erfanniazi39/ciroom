/**
 * Persistence for the user and settings stores: CiRoom's SQLite database on this PC (server/lib/userdb.js),
 * not the window's browser storage. The first time, the existing browser-storage data is moved into the
 * database (and the session-1 sample data is cleaned there).
 *
 * Browser storage is still written on every change as a live backup copy, and used only if the CiRoom
 * service can't be reached at start-up. Nothing is sent to the database before the store has loaded
 * from it, so an empty start-up state can never overwrite real data.
 *
 * Three states (storageMode()):
 *  - online:   loaded from the database; changes are saved there.
 *  - offline:  the service can't be reached; the browser copy is used and changes stay in it.
 *  - readonly: the data folder can't be written (the shared drive after Windows hibernated). The database's data
 *              is shown; changes are kept in the browser copy, and a marker (UNSAVED) records the database
 *              revision and data they are based on. They are saved as soon as the database is writable again:
 *              tried every minute while the window is open, and at the next start. If the database didn't change
 *              meanwhile, the browser copy is saved as it is; if it did, the two are merged (mergeUser.ts).
 *
 * The service stopping while the window is open (it crashed; the desktop shell restarts it): a save that fails stays
 * pending (the newest whole state wins) and is re-sent after 2 s, 5 s, 15 s, then every 30 s, and at once when the
 * service answers again (serverHealth.ts). UNSAVED is set meanwhile, so a window closed before that still merges its
 * changes at the next start. A window that started while the service was unreachable keeps its changes the same way
 * and loads from the database (merging them in) once the service is back: reloadFromServer().
 */
import type { PersistStorage, StorageValue } from "zustand/middleware";
import { mergeSettings, mergeUser } from "./mergeUser";
import { reportServerTrouble } from "./serverHealth";

type Section = "user" | "settings";
type Obj = Record<string, unknown>;
const SECTION: Record<string, Section> = { "marquee.user.v1": "user", "ciroom.settings.v1": "settings" };
const KEY: Record<Section, string> = { user: "marquee.user.v1", settings: "ciroom.settings.v1" };
/** Changes kept in this window while the database couldn't be written. */
const UNSAVED = "ciroom.unsaved.v1";

interface Loaded { user: Obj | null; settings: Obj | null; removed?: string[]; revision?: number; readOnly?: boolean; imported?: boolean }
/** The database revision and data the kept changes are based on (base = null: unknown, no database yet). */
interface Unsaved { revision: number | null; base: Record<Section, Obj | null> | null; at: number }

export type StorageMode = "online" | "offline" | "readonly";

let loading: Promise<Loaded | null> | null = null;
let mode: StorageMode = "offline";
/** The database revision this window's data is based on, and the data last loaded from / saved to it. */
let revision: number | null = null;
const saved: Record<Section, Obj | null> = { user: null, settings: null };
const ready = new Set<string>();
const pending = new Map<string, unknown>();
const timers = new Map<string, number>();
let keptTimer = 0;
/** Read-only state, but the database changed meanwhile: merged at the next start, not while this window runs. */
let conflict = false;
/** Re-sending failed saves (online state): the timer and how many tries so far. */
const RETRY_MS = [2000, 5000, 15000, 30000];
let retryTimer = 0;
let retryStep = 0;
/** Started with the service unreachable: the browser copy this window began with (the base of its changes). */
const offlineBase: Record<Section, Obj | null> = { user: null, settings: null };
const modeListeners = new Set<() => void>();

const readLocal = (name: string) => {
  try { const raw = localStorage.getItem(name); return raw ? JSON.parse(raw) : null; } catch { return null; }
};
const writeLocal = (name: string, value: unknown) => {
  try { localStorage.setItem(name, JSON.stringify(value)); } catch { /* storage full / private mode: the database has it */ }
};
const removeLocal = (name: string) => { try { localStorage.removeItem(name); } catch { /* ignore */ } };
const localState = (s: Section): Obj | null => readLocal(KEY[s])?.state ?? null;

/** Where this window saves now (see the header). */
export const storageMode = () => mode;
/** Calls `fn` when storageMode() changes. Returns the unsubscribe. */
export function onStorageMode(fn: () => void) {
  modeListeners.add(fn);
  return () => { modeListeners.delete(fn); };
}
function setMode(m: StorageMode) {
  if (m === mode) return;
  mode = m;
  for (const fn of modeListeners) fn();
}

/** First change while the database can't be written: remember what the window's data is based on. */
function markUnsaved() {
  if (readLocal(UNSAVED)) return; // keep the oldest base: everything since then is unsaved
  writeLocal(UNSAVED, { revision, base: { ...saved }, at: Date.now() } satisfies Unsaved);
}

const put = (s: Section, state: unknown, ifRevision?: number | null) =>
  fetch(`/api/userdata/${s}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, keepalive: true,
    body: JSON.stringify(ifRevision == null ? { state } : { state, ifRevision }),
  });

/**
 * Saves the changes kept in browser storage (UNSAVED), each section only if the database is still at the revision
 * they are based on. "saved": done, marker cleared; "readonly": still can't be written; "conflict": the database
 * changed meanwhile; "error": not reachable / refused.
 */
async function saveKept(): Promise<"saved" | "readonly" | "conflict" | "error"> {
  const u = readLocal(UNSAVED) as Unsaved | null;
  if (!u) return "saved";
  // Kept before the database existed, or while the service was unreachable (base unknown to the database): moved in
  // or merged at the next load.
  if (!u.base || u.revision == null) return "conflict";
  let rev = u.revision;
  const base: Record<Section, Obj | null> = { user: u.base?.user ?? null, settings: u.base?.settings ?? null };
  for (const s of ["user", "settings"] as const) {
    const state = localState(s);
    if (!state) continue;
    let r: Response;
    try { r = await put(s, state, rev); } catch { return "error"; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return d.readOnly ? "readonly" : d.conflict ? "conflict" : "error";
    rev = d.revision ?? null;
    base[s] = state;
    revision = rev;
    saved[s] = state;
    writeLocal(UNSAVED, { revision: rev, base: { ...base }, at: u.at } satisfies Unsaved); // what the database now holds
  }
  removeLocal(UNSAVED);
  return "saved";
}

/** In read-only state: try to save the kept changes after `ms` (the server checks the folder again at most once a minute). */
function scheduleKept(ms: number) {
  if (conflict || keptTimer) return; // one try at a time; saves while watching must not keep pushing it back
  keptTimer = window.setTimeout(async () => {
    keptTimer = 0;
    if (!readLocal(UNSAVED)) return; // nothing changed here yet: the next change tries again
    const res = await saveKept();
    if (res === "saved") { console.info("[CiRoom] The data folder is writable again: the changes kept in this window are saved."); setMode("online"); }
    else if (res === "conflict") conflict = true; // merged at the next start (the stores here still hold the window's copy)
    else scheduleKept(60_000);
  }, ms);
}

/** JSON with object keys sorted, to compare two saved states. */
const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Obj)[k])}`).join(",")}}`
  : JSON.stringify(v) ?? "null";

/**
 * The window's copy of `s`, merged with the database's if that changed since the copy's base. Unchanged = same revision
 * and (when known) the same data as the base, so a save by a CiRoom without the revision counter is noticed too.
 */
function keptState(s: Section, u: Unsaved, d: Loaded): Obj | null {
  const local = localState(s);
  const db = d[s];
  if (!local) return db;
  if (!db) return local;
  const base = u.base?.[s] ?? null;
  const unchanged = u.revision != null && u.revision === (d.revision ?? 0) && (!u.base || stable(base) === stable(db));
  return unchanged ? local : (s === "user" ? mergeUser : mergeSettings)(base, local, db);
}

/** Start-up with changes kept from a read-only spell: the state to show (written to browser storage). */
function withKept(d: Loaded, u: Unsaved): Loaded {
  const user = keptState("user", u, d), settings = keptState("settings", u, d);
  if (user) writeLocal(KEY.user, { state: user, version: 0 });
  if (settings) writeLocal(KEY.settings, { state: settings, version: 0 });
  if (u.revision !== (d.revision ?? 0) || !u.base || stable(u.base.user) !== stable(d.user) || stable(u.base.settings) !== stable(d.settings)) writeLocal(UNSAVED, { revision: d.revision ?? 0, base: { user: d.user, settings: d.settings }, at: u.at } satisfies Unsaved);
  return { ...d, user, settings };
}

async function loadAll(attempt = 0): Promise<Loaded | null> {
  try {
    const r = await fetch("/api/userdata");
    if (!r.ok) return null;
    let d: Loaded = await r.json();
    const kept = readLocal(UNSAVED) as Unsaved | null;
    revision = d.revision ?? 0;
    saved.user = d.user;
    saved.settings = d.settings;
    if (d.readOnly) {
      setMode("readonly");
      console.warn("[CiRoom] The data folder is read-only: showing the saved data; changes are kept in this window until it is writable.");
      if (!d.imported) {
        // No database yet on a read-only folder: the browser copy is all there is (moved in once it is writable).
        if (!kept) writeLocal(UNSAVED, { revision: null, base: null, at: Date.now() } satisfies Unsaved);
        return { ...d, user: localState("user"), settings: localState("settings") };
      }
      if (kept) { d = withKept(d, kept); scheduleKept(60_000); }
      return d;
    }
    if (!d.imported) {
      // One-time move from browser storage into the database (including anything kept while it was read-only).
      const r2 = await fetch("/api/userdata/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user: localState("user"), settings: localState("settings") }) });
      if (!r2.ok) return null;
      d = await r2.json();
      if (d.removed?.length) console.info(`[CiRoom] Moved your data into the database; removed old sample entries: ${d.removed.join(", ")}`);
      removeLocal(UNSAVED);
      revision = d.revision ?? 0;
      saved.user = d.user;
      saved.settings = d.settings;
    } else if (kept) {
      d = withKept(d, kept);
      const res = await saveKept();
      if (res === "conflict" && attempt < 2) return loadAll(attempt + 1); // saved elsewhere at this very moment: merge again
      if (res === "readonly") { setMode("readonly"); scheduleKept(60_000); return d; }
      if (res === "saved") console.info("[CiRoom] Saved the changes kept in this window while the data folder was read-only.");
    }
    setMode("online");
    return d;
  } catch {
    return null;
  }
}

let inFlight = 0;
/** UNSAVED was set here because a save failed (not by a read-only or offline spell): cleared once all is saved. */
let failMarked = false;

/** Sends one store's pending change; resolves (never rejects) once the database has answered or the send failed. */
function send(name: string): Promise<void> | undefined {
  const value = pending.get(name);
  if (value === undefined) return;
  pending.delete(name);
  const s = SECTION[name];
  const state = (value as StorageValue<unknown>).state as Obj;
  inFlight++;
  return put(s, state).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      revision = d.revision ?? revision;
      saved[s] = state;
      if (inFlight === 1 && !pending.size) {
        retryStep = 0;
        // Everything is in the database now: nothing left to merge at the next start.
        if (failMarked && mode === "online") { removeLocal(UNSAVED); failMarked = false; }
      }
      return;
    }
    if (d.readOnly) {
      // The folder turned read-only while this window was open: keep the changes here from now on.
      markUnsaved();
      setMode("readonly");
      scheduleKept(60_000);
      return;
    }
    throw Object.assign(new Error(String(r.status)), { status: r.status });
  }).catch((e: { status?: number }) => {
    if (!pending.has(name)) pending.set(name, value); // keep it, unless a newer change replaced it meanwhile
    if (e.status && e.status < 500) return; // refused: sent again with the next change / flush, as before
    // Not reachable (the service stopped?) or failed there: try again, and merge at the next start if the window closes first.
    if (!readLocal(UNSAVED)) { markUnsaved(); failMarked = true; }
    scheduleRetry();
    if (!e.status) reportServerTrouble();
  }).finally(() => { inFlight--; });
}

function scheduleRetry() {
  if (retryTimer || mode !== "online") return;
  const ms = RETRY_MS[Math.min(retryStep, RETRY_MS.length - 1)];
  retryStep++;
  retryTimer = window.setTimeout(() => { retryTimer = 0; retryPending(); }, ms);
}

/** Re-send the saves that failed (the next backoff step, or at once when the service answers again). */
export function retryPending() {
  window.clearTimeout(retryTimer);
  retryTimer = 0;
  if (mode !== "online") return; // read-only: scheduleKept() handles it; offline: reloadFromServer()
  for (const name of [...pending.keys()]) if (!timers.has(name)) send(name);
}

/**
 * Started with the service unreachable: what the stores hold right after loading (the browser copy, or the defaults
 * when there is none) is the base of this window's changes. Without it, a favourite added here couldn't be told apart
 * from one removed elsewhere, and the merge would keep the database's list.
 */
export function setOfflineBase(base: Record<Section, Obj | null>) {
  if (mode !== "offline" || ready.size < Object.keys(SECTION).length || readLocal(UNSAVED)) return;
  offlineBase.user = base.user;
  offlineBase.settings = base.settings;
}

/**
 * The service answers again. Online: re-send what failed. Started offline: true when the stores must load again
 * (the caller rehydrates them; getItem then loads from the database and merges this window's changes in).
 */
export function reloadFromServer(): boolean {
  if (mode !== "offline" || !ready.size) { retryPending(); return false; }
  loading = null;
  return true;
}

/**
 * Send anything not yet saved, at once (on close: src/lib/beforeClose.ts). Resolves when those saves have answered
 * (the requests use `keepalive`, so they also finish if the page goes away first).
 */
export function flushUserData(): Promise<void> {
  const sent: (Promise<void> | undefined)[] = [];
  for (const [name, t] of timers) { window.clearTimeout(t); timers.delete(name); sent.push(send(name)); }
  if (mode === "online") for (const name of [...pending.keys()]) sent.push(send(name)); // saves that failed earlier
  return Promise.all(sent).then(() => undefined);
}

export function serverStorage<S>(): PersistStorage<S> {
  return {
    getItem: async (name) => {
      loading ??= loadAll();
      const d = await loading;
      ready.add(name);
      if (!d) {
        // Service unreachable: use the browser-storage copy (writes stay local until it is back: reloadFromServer()).
        const local = readLocal(name);
        if (!readLocal(UNSAVED)) offlineBase[SECTION[name]] = local?.state ?? null;
        reportServerTrouble();
        return local;
      }
      const state = d[SECTION[name]];
      if (!state) return null;
      const value = { state, version: 0 } as StorageValue<S>;
      writeLocal(name, value); // refresh the backup copy
      return value;
    },
    setItem: (name, value) => {
      writeLocal(name, value);
      if (!ready.has(name) || !SECTION[name]) return; // not loaded yet: never overwrite the database with defaults
      if (mode === "readonly") { markUnsaved(); scheduleKept(10_000); return; }
      if (mode === "offline") {
        // Kept here; merged into the database once the service is back (base: what this window started with).
        if (!readLocal(UNSAVED)) writeLocal(UNSAVED, { revision: null, base: { ...offlineBase }, at: Date.now() } satisfies Unsaved);
        return;
      }
      pending.set(name, value);
      window.clearTimeout(timers.get(name));
      timers.set(name, window.setTimeout(() => { timers.delete(name); send(name); }, 400));
    },
    removeItem: (name) => removeLocal(name),
  };
}

/** Resolves when a persisted store has loaded (or after `ms`, so a slow start never blocks the window forever). */
export function whenHydrated(store: { persist: { hasHydrated: () => boolean; onFinishHydration: (fn: () => void) => () => void } }, ms = 8000) {
  return new Promise<void>((resolve) => {
    if (store.persist.hasHydrated()) return resolve();
    const off = store.persist.onFinishHydration(() => { off(); resolve(); });
    window.setTimeout(resolve, ms);
  });
}
