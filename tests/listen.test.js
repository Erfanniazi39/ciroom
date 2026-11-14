// M5: the server listens on 127.0.0.1 only, until the phone remote or the watch party is switched on.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer, request, lanIp } from "./helpers.js";

const J = { "Content-Type": "application/json" };
const post = (port, p, on) => request({ port, path: p, method: "POST", headers: J, body: JSON.stringify({ on }) });

test("not reachable from the LAN until the remote or the party is on, and closed again after", { skip: !lanIp() && "no LAN address" }, async () => {
  const s = await startServer({ loopbackOnly: true });
  try {
    const lan = () => request({ host: lanIp(), port: s.port, path: "/api/ping" }).then((r) => r.status, () => "refused");
    // The switch re-listens a moment after the toggle's reply, so wait briefly for the expected state.
    const settle = async (want) => { for (let i = 0; i < 30 && (await lan() === "refused") !== want; i++) await new Promise((r) => setTimeout(r, 100)); return lan(); };
    assert.equal(await lan(), "refused");
    for (const [route, other] of [["/api/remote/enable", "/api/party/host/enable"], ["/api/party/host/enable", "/api/remote/enable"]]) {
      assert.equal((await post(s.port, route, true)).status, 200);
      assert.notEqual(await settle(false), "refused");
      assert.equal((await post(s.port, other, true)).status, 200);
      assert.equal((await post(s.port, route, false)).status, 200);
      assert.notEqual(await settle(false), "refused", "still on: the other feature needs it");
      assert.equal((await post(s.port, other, false)).status, 200);
      assert.equal(await settle(true), "refused");
      assert.equal((await request({ port: s.port, path: "/api/ping" })).status, 200, "this PC always works");
    }
  } finally { s.stop(); }
});
