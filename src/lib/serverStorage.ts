/**
 * Persistence for the user and settings stores: CiRoom's SQLite database on this PC (dev/userdb.js),
 * not the window's browser storage. The first time, the existing browser-storage data is moved into the
 * database (and the session-1 sample data is cleaned there).
 *
 * Browser storage is still written on every change as a live backup copy, and used only if the CiRoom
 * service can't be reached at start-up. Nothing is sent to the database before the store has loaded
 * from it, so an empty start-up state can never overwrite real data.
 */
import type { PersistStorage, StorageValue } from "zustand/middleware";

const SECTION: Record<string, "user" | "settings"> = { "marquee.user.v1": "user", "ciroom.settings.v1": "settings" };

interface Loaded { user: Record<string, unknown> | null; settings: Record<string, unknown> | null; removed?: string[] }

let loading: Promise<Loaded | null> | null = null;
let online = false;
const ready = new Set<string>();
const pending = new Map<string, unknown>();
const timers = new Map<string, number>();

const readLocal = (name: string) => {
  try { const raw = localStorage.getItem(name); return raw ? JSON.parse(raw) : null; } catch { return null; }
};
const writeLocal = (name: string, value: unknown) => {
  try { localStorage.setItem(name, JSON.stringify(value)); } catch { /* storage full / private mode: the database has it */ }
};

async function loadAll(): Promise<Loaded | null> {
  try {
    const r = await fetch("/api/userdata");
    if (!r.ok) return null;
    let d = await r.json();
    if (!d.imported) {
      // One-time move from browser storage into the database.
      const user = readLocal("marquee.user.v1")?.state ?? null;
      const settings = readLocal("ciroom.settings.v1")?.state ?? null;
      const r2 = await fetch("/api/userdata/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user, settings }) });
      if (!r2.ok) return null;
      d = await r2.json();
      if (d.removed?.length) console.info(`[CiRoom] Moved your data into the database; removed old sample entries: ${d.removed.join(", ")}`);
    }
    online = true;
    return d;
  } catch {
    return null;
  }
}

function send(name: string) {
  const value = pending.get(name);
  if (value === undefined) return;
  pending.delete(name);
  fetch(`/api/userdata/${SECTION[name]}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: (value as StorageValue<unknown>).state }), keepalive: true,
  }).then((r) => { if (!r.ok) throw new Error(String(r.status)); })
    .catch(() => { if (!pending.has(name)) pending.set(name, value); }); // keep it for the next change / flush
}

/** Send anything not yet saved (on close). */
export function flushUserData() {
  for (const [name, t] of timers) { window.clearTimeout(t); timers.delete(name); send(name); }
}
if (typeof window !== "undefined") window.addEventListener("pagehide", flushUserData);

export function serverStorage<S>(): PersistStorage<S> {
  return {
    getItem: async (name) => {
      loading ??= loadAll();
      const d = await loading;
      ready.add(name);
      if (!d) return readLocal(name); // service unreachable: use the browser-storage copy (writes stay local)
      const state = d[SECTION[name]];
      if (!state) return null;
      const value = { state, version: 0 } as StorageValue<S>;
      writeLocal(name, value); // refresh the backup copy
      return value;
    },
    setItem: (name, value) => {
      writeLocal(name, value);
      if (!ready.has(name) || !online || !SECTION[name]) return; // not loaded yet: never overwrite the database with defaults
      pending.set(name, value);
      window.clearTimeout(timers.get(name));
      timers.set(name, window.setTimeout(() => { timers.delete(name); send(name); }, 400));
    },
    removeItem: (name) => { try { localStorage.removeItem(name); } catch { /* ignore */ } },
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
