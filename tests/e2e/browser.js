// Minimal headless-Chrome driver for the end-to-end tests (Chrome DevTools Protocol over Node 22's built-in WebSocket).
// A fresh profile in the test's scratch folder, muted, no proxy, autoplay allowed. Never touches the user's browser.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const CHROME = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((c) => { try { execFileSync(c, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } });

/** @param {{ dir: string, width?: number, height?: number }} o */
export async function launch(o) {
  if (!CHROME) throw new Error("Chrome/Chromium not found");
  const profile = path.join(o.dir, "chrome-profile");
  fs.mkdirSync(profile, { recursive: true });
  const portFile = path.join(profile, "DevToolsActivePort");
  fs.rmSync(portFile, { force: true }); // a profile used before still has the old port: reopening it would connect there
  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-proxy-server", "--mute-audio", "--no-first-run",
    "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", `--window-size=${o.width ?? 1440},${o.height ?? 900}`,
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "about:blank",
  ], { stdio: "ignore" });
  const t0 = Date.now();
  while (!fs.existsSync(portFile) || !fs.readFileSync(portFile, "utf8").includes("\n")) {
    if (Date.now() - t0 > 20000) { proc.kill("SIGKILL"); throw new Error("Chrome did not start"); }
    await new Promise((r) => setTimeout(r, 100));
  }
  const port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  let id = 0;
  /** @type {Map<number, {res: Function, rej: Function}>} */ const waiting = new Map();
  /** @type {string[]} */ const console_ = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w?.rej(new Error(m.error.message)) : w?.res(m.result); }
    else if (m.method === "Runtime.consoleAPICalled") console_.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
    else if (m.method === "Runtime.exceptionThrown") console_.push(`exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
  });
  const send = (/** @type {string} */ method, /** @type {any} */ params = {}) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  await send("Page.enable");

  const page = {
    send, console: console_,
    /** Evaluate an expression (or `async () => …` body via (async()=>{…})()) in the page and return its value. */
    async eval(/** @type {string} */ expr) {
      const r = /** @type {any} */ (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }));
      if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    },
    async goto(/** @type {string} */ url) { await send("Page.navigate", { url }); await page.waitFor("document.readyState === 'complete'"); },
    /** Wait until a page expression is truthy; returns its value. */
    async waitFor(/** @type {string} */ expr, ms = 15000) {
      const t = Date.now(); let last;
      for (;;) {
        try { last = await page.eval(expr); if (last) return last; } catch (e) { last = e instanceof Error ? e.message : e; }
        if (Date.now() - t > ms) throw new Error(`waitFor timed out: ${expr} (last: ${JSON.stringify(last)})`);
        await new Promise((r) => setTimeout(r, 150));
      }
    },
    /** Click the first visible button/link whose text or aria-label contains `text` (real mouse events at its centre). */
    async click(/** @type {string} */ text, scope = "button, a, [role=button]") {
      const box = await page.waitFor(`(() => { const want = ${JSON.stringify(text)}.toLowerCase();
        const el = [...document.querySelectorAll(${JSON.stringify(scope)})].find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && ((e.innerText || "").toLowerCase().includes(want) || (e.getAttribute("aria-label") || "").toLowerCase().includes(want)); });
        if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await page.mouse(box.x, box.y);
      return box;
    },
    async mouse(/** @type {number} */ x, /** @type {number} */ y) {
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    },
    async key(/** @type {string} */ key, /** @type {string} */ code = key, /** @type {number} */ keyCode = 0, modifiers = 0) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers, text: key.length === 1 && !modifiers ? key : undefined });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers });
    },
    async type(/** @type {string} */ text) { await send("Input.insertText", { text }); },
    async screenshot(/** @type {string} */ file) { const r = /** @type {any} */ (await send("Page.captureScreenshot", { format: "png" })); fs.writeFileSync(file, Buffer.from(r.data, "base64")); },
    text: () => page.eval("document.body.innerText"),
    /** The page player's <video>: current time, paused, ready state. */
    video: () => page.eval(`(() => { const v = document.querySelector("video"); return v ? { t: v.currentTime, paused: v.paused, ready: v.readyState, ended: v.ended, muted: v.muted, rate: v.playbackRate } : null; })()`),
    hash: () => page.eval("location.hash"),
    /** Like closing the window: Chrome is asked to quit (it writes the page's browser storage to disk then) and gets up to 5 s, else it is killed. */
    async close() {
      if (proc.exitCode !== null || proc.signalCode !== null) { try { ws.close(); } catch { /* gone */ } return; }
      const exited = new Promise((r) => proc.once("exit", r));
      send("Browser.close").catch(() => undefined);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      try { ws.close(); } catch { /* gone */ }
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    },
  };
  return page;
}
