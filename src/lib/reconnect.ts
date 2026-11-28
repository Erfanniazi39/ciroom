/**
 * CiRoom's server answers again after being down (serverHealth.ts): re-send what wasn't saved, and reload only what
 * may be stale. The page the user is on is kept (no navigation, no full reload).
 *  - Saves: serverStorage re-sends failed saves at once. A window that started while the server was unreachable
 *    loads progress and settings from the database now, with this window's changes merged in.
 *  - Library: loaded again only if it failed to load.
 */
import { onServerBack } from "./serverHealth";
import { reloadFromServer, setOfflineBase } from "./serverStorage";
import { useUser } from "@/store/user";
import { useSettings } from "@/store/settings";
import { useLibrary } from "@/store/library";

let started = false;

type Persisted = { getState: () => object; persist: { getOptions: () => { partialize?: (s: never) => unknown } } };
/** The part of a store that is saved, as plain data. */
const saved = (store: Persisted) => {
  const { partialize } = store.persist.getOptions();
  const s = store.getState();
  return JSON.parse(JSON.stringify(partialize ? partialize(s as never) : s)) as Record<string, unknown>;
};

/** Called once the stores have loaded, before the user can change anything. */
export function startReconnect() {
  if (started) return;
  started = true;
  setOfflineBase({ user: saved(useUser), settings: saved(useSettings) });
  onServerBack(() => {
    if (reloadFromServer()) void Promise.all([useUser.persist.rehydrate(), useSettings.persist.rehydrate()]);
    const lib = useLibrary.getState();
    if (lib.error || (!lib.data && !lib.loading)) void lib.load();
  });
}
