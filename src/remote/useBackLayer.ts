import { useEffect, useRef } from "react";

/**
 * Makes the phone's Back button (and the browser's) close the top layer of the phone UI (menu → player → title →
 * Library) instead of leaving the page. While `active`, one history entry is on the stack for this layer; Back (popstate)
 * calls `close`; closing the layer another way (a button) removes the entry again.
 */
interface Layer { close: () => void }
const stack: Layer[] = [];
let ignore = 0; // popstates caused by our own history.back()
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  window.addEventListener("popstate", () => {
    if (ignore > 0) { ignore--; return; }
    stack.pop()?.close();
  });
}

export function useBackLayer(active: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!active) return;
    wire();
    const layer: Layer = { close: () => closeRef.current() };
    stack.push(layer);
    history.pushState({ ciroomLayer: stack.length }, "");
    return () => {
      const i = stack.indexOf(layer);
      if (i < 0) return; // closed by Back already
      stack.splice(i, 1);
      ignore++;
      history.back();
    };
  }, [active]);
}
