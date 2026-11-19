// Task 12d: the window is told how many phones are connected (so it reports to the remote only while one is).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, pairedPhone, lanIp } from "./helpers.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("the commands stream says how many phones are connected, on connect and when it changes", { skip: !lanIp() }, async () => {
  const s = await startServer();
  let win;
  try {
    const phone = await pairedPhone(s);
    const msgs = [];
    win = http.get({ host: "127.0.0.1", port: s.port, path: "/api/remote/commands", agent: false }, (res) => {
      let buf = ""; res.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const part = buf.slice(0, i); buf = buf.slice(i + 2); if (part.startsWith("data: ")) try { msgs.push(JSON.parse(part.slice(6))); } catch { /* ignore */ } } });
    });
    win.on("error", () => {});
    await wait(300);
    const counts = () => msgs.filter((m) => m.cmd === "phones").map((m) => m.count);
    assert.deepEqual(counts(), [0], "told on connect: no phone");
    const ev = await phone.open("/api/remote/events", 10); // the phone's page keeps this stream open
    await wait(300);
    assert.deepEqual(counts(), [0, 1], "a phone connected");
    ev.res.destroy();
    await wait(400);
    assert.deepEqual(counts(), [0, 1, 0], "the phone left");
  } finally { win?.destroy(); s.stop(); }
});
