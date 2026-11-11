import { useEffect } from "react";

/** Registers a global shortcut. `combo` like "mod+k", "/", "escape". `mod` = Ctrl (Cmd on macOS). */
export function useHotkey(combo: string, handler: (e: KeyboardEvent) => void, opts: { allowInInputs?: boolean } = {}) {
  useEffect(() => {
    const parts = combo.toLowerCase().split("+");
    const key = parts.pop()!;
    const needMod = parts.includes("mod");
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (inInput && !opts.allowInInputs && !needMod) return;
      if (needMod !== (e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() !== key) return;
      e.preventDefault();
      handler(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [combo, handler, opts.allowInInputs]);
}
