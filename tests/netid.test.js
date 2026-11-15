// Network identity: parsers on sample output (made-up names only) and the test override.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNmcli, parseNetsh, parseIpNeigh, parseDefaultRoute, currentNetwork } from "../server/lib/netid.js";

test("nmcli: the active line wins, escaped colons are unescaped", () => {
  assert.equal(parseNmcli("no:Other\nyes:HomeWifi\nno:Third\n"), "HomeWifi");
  assert.equal(parseNmcli("yes:My\\: Phone\\\\x\n"), "My: Phone\\x");
});
test("nmcli: no active line gives an empty name", () => {
  assert.equal(parseNmcli("no:A\nno:B\n"), "");
  assert.equal(parseNmcli(""), "");
});
test("netsh: SSID is read, BSSID is skipped, any label wording order", () => {
  const out = "    Name                   : Wi-Fi\n    State                  : connected\n    SSID                   : HomeWifi\n    BSSID                  : aa:bb:cc:dd:ee:ff\n    Radio type             : 802.11ac\n";
  assert.equal(parseNetsh(out), "HomeWifi");
  assert.equal(parseNetsh("    BSSID : aa:bb:cc:dd:ee:ff\n"), "");
  assert.equal(parseNetsh("There is 1 interface on the system:\n"), "");
});
test("ip neigh / route parsers", () => {
  assert.equal(parseIpNeigh("192.168.1.1 dev enp3s0 lladdr AA:BB:CC:DD:EE:01 REACHABLE"), "aa:bb:cc:dd:ee:01");
  assert.equal(parseIpNeigh("192.168.1.1 dev enp3s0  FAILED"), "");
  assert.equal(parseDefaultRoute("default via 192.168.1.1 dev enp3s0 proto dhcp metric 100"), "192.168.1.1");
  assert.equal(parseDefaultRoute(""), "");
});
test("CIROOM_FAKE_NETWORK overrides detection", async () => {
  process.env.CIROOM_FAKE_NETWORK = "wifi:HomeWifi|HomeWifi";
  assert.deepEqual(await currentNetwork(), { id: "wifi:HomeWifi", label: "HomeWifi", kind: "wifi" });
  process.env.CIROOM_FAKE_NETWORK = "";
  assert.equal((await currentNetwork()).kind, "unknown");
  delete process.env.CIROOM_FAKE_NETWORK;
});
