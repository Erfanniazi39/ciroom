import { useState, useSyncExternalStore } from "react";
import { onStorageMode, storageMode } from "@/lib/serverStorage";

/** Shown while CiRoom's data folder can't be written (src/lib/serverStorage.ts, "readonly"). Hidden on the player page. */
export function ReadOnlyBanner() {
  const mode = useSyncExternalStore(onStorageMode, storageMode);
  const [hidden, setHidden] = useState(false);
  if (mode !== "readonly" || hidden) return null;
  return (
    <div role="status" className="mx-4 mt-4 flex items-start gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-[14px] leading-6 md:mx-8">
      <p className="flex-1">
        <span className="font-semibold text-fg">The drive with CiRoom's data is read-only.</span>{" "}
        What you watch is kept on this PC and saved when the drive is writable again.
      </p>
      <button type="button" className="text-fg-muted hover:text-fg" onClick={() => setHidden(true)}>Hide</button>
    </div>
  );
}
