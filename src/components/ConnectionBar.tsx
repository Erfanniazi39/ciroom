import { useSyncExternalStore } from "react";
import { onServerHealth, serverHealth } from "@/lib/serverHealth";

/** Shown on every page (the player too) while CiRoom's server doesn't answer (src/lib/serverHealth.ts). */
export function ConnectionBar() {
  const health = useSyncExternalStore(onServerHealth, serverHealth);
  if (health !== "down") return null;
  return (
    <div role="alert" className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex justify-center px-4">
      <p className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-amber-500/50 bg-bg/95 px-4 py-2 text-[14px] shadow-lg backdrop-blur">
        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" aria-hidden />
        <span><span className="font-semibold text-fg">CiRoom stopped.</span> Reconnecting…</span>
      </p>
    </div>
  );
}
