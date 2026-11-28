/**
 * Three-way merge of saved state, for changes the window kept while CiRoom's data folder was read-only
 * (see serverStorage.ts). Used only when the database changed meanwhile (another window saved to it);
 * when it didn't, the window's copy is saved as it is.
 *
 *   base  = what the window loaded from the database when the folder was read-only (null if unknown)
 *   local = the window's copy now: base + what was done in this window
 *   db    = the database now: base + what was saved elsewhere meanwhile
 *
 * Rules (never let an older entry replace a newer one):
 *  - progress / history: per item, the newer `updatedAt` / `at` wins (a tie keeps the database's). An item only
 *    one side has is kept, unless the other side removed it (it was in base) and the side that has it didn't
 *    change it since base: then it stays removed ("Reset watching", a removed history entry).
 *  - favorites / watchlist: the database's list, minus what this window removed, plus what it added (in front,
 *    newest first, like the store does). Without base a removal can't be told apart: the database's list is kept.
 *  - watchLog (seconds per day and title): the database's value plus what this window added since base.
 *    Without base: the larger value.
 *  - everything else (volume, subtitle/audio choices, subtitle delays, settings): a value this window changed
 *    since base wins, otherwise the database's. Without base: the database's (keyed maps: union, database first).
 * No imports: the unit tests load this file directly.
 */
type Obj = Record<string, unknown>;
interface Stamped { updatedAt?: unknown; at?: unknown }

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const time = (v: unknown, field: "updatedAt" | "at") => {
  const t = Number((v as Stamped | undefined)?.[field]);
  return Number.isFinite(t) ? t : 0;
};

/** Keyed entries with a time stamp (progress by item id, history by id). */
function mergeStamped(base: Obj | null, local: Obj, db: Obj, field: "updatedAt" | "at"): Obj {
  const out: Obj = {};
  for (const id of new Set([...Object.keys(db), ...Object.keys(local)])) {
    const l = local[id], d = db[id], b = base?.[id];
    if (l !== undefined && d !== undefined) out[id] = time(l, field) > time(d, field) ? l : d;
    else if (l !== undefined) {
      // Only here: removed from the database meanwhile, unless this window changed it since then.
      if (!(base && b !== undefined && time(l, field) <= time(b, field))) out[id] = l;
    } else if (d !== undefined) {
      // Only in the database: removed in this window, unless it was saved elsewhere after that.
      if (!(base && b !== undefined && time(d, field) <= time(b, field))) out[id] = d;
    }
  }
  return out;
}

const historyMap = (v: unknown): Obj => {
  const out: Obj = {};
  if (Array.isArray(v)) for (const h of v) if (isObj(h) && typeof h.id === "string" && !(h.id in out)) out[h.id] = h;
  return out;
};

function mergeList(base: unknown, local: unknown, db: unknown): string[] {
  const d = Array.isArray(db) ? db.filter((x): x is string => typeof x === "string") : [];
  if (!Array.isArray(base) || !Array.isArray(local)) return d;
  const b = new Set(base), l = new Set(local);
  const added = local.filter((x): x is string => typeof x === "string" && !b.has(x) && !d.includes(x));
  return [...added, ...d.filter((x) => !(b.has(x) && !l.has(x)))];
}

function mergeWatchLog(base: unknown, local: unknown, db: unknown): Obj {
  const L = isObj(local) ? local : {}, D = isObj(db) ? db : {}, B = isObj(base) ? base : null;
  const out: Obj = {};
  for (const day of new Set([...Object.keys(D), ...Object.keys(L)])) {
    const l = isObj(L[day]) ? (L[day] as Obj) : {}, d = isObj(D[day]) ? (D[day] as Obj) : {};
    const b = B && isObj(B[day]) ? (B[day] as Obj) : {};
    const row: Record<string, number> = {};
    for (const id of new Set([...Object.keys(d), ...Object.keys(l)])) {
      const lv = Number(l[id]) || 0, dv = Number(d[id]) || 0, bv = Number(b[id]) || 0;
      const v = B ? dv + Math.max(0, lv - bv) : Math.max(lv, dv);
      if (v > 0) row[id] = Math.round(v * 10) / 10;
    }
    if (Object.keys(row).length) out[day] = row;
  }
  return out;
}

/** A value this window changed since base wins, otherwise the database's. Keys removed in this window stay removed. */
function mergeValues(base: Obj | null, local: Obj, db: Obj): Obj {
  const out: Obj = {};
  for (const k of new Set([...Object.keys(db), ...Object.keys(local)])) {
    const changedHere = base ? !same(local[k], base[k]) : false;
    const v = changedHere ? local[k] : k in db ? db[k] : base ? undefined : local[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const HANDLED = new Set(["progress", "history", "favorites", "watchlist", "watchLog", "subDelays", "subPrefs", "audioPrefs"]);

/** The user store's saved state (src/store/user.ts), merged. */
export function mergeUser(base: Obj | null, local: Obj, db: Obj): Obj {
  const sub = (k: string) => (base && isObj(base[k]) ? (base[k] as Obj) : base ? {} : null);
  const obj = (o: Obj, k: string) => (isObj(o[k]) ? (o[k] as Obj) : {});
  const history = Object.values(mergeStamped(base ? historyMap(base.history) : null, historyMap(local.history), historyMap(db.history), "at"))
    .sort((a, b) => time(b, "at") - time(a, "at"))
    .slice(0, 200);
  const out: Obj = {
    ...mergeValues(base, Object.fromEntries(Object.entries(local).filter(([k]) => !HANDLED.has(k))), Object.fromEntries(Object.entries(db).filter(([k]) => !HANDLED.has(k)))),
    progress: mergeStamped(sub("progress"), obj(local, "progress"), obj(db, "progress"), "updatedAt"),
    history,
    favorites: mergeList(base?.favorites, local.favorites, db.favorites),
    watchlist: mergeList(base?.watchlist, local.watchlist, db.watchlist),
    watchLog: mergeWatchLog(base?.watchLog, local.watchLog, db.watchLog),
  };
  for (const k of ["subDelays", "subPrefs", "audioPrefs"]) out[k] = mergeValues(sub(k), obj(local, k), obj(db, k));
  return out;
}

/** The settings store's saved state (src/store/settings.ts): per setting, see mergeValues. */
export function mergeSettings(base: Obj | null, local: Obj, db: Obj): Obj {
  return mergeValues(base, local, db);
}
