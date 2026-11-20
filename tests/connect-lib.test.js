// The Android Connect screen's address and QR rules (android-app/connect-lib.ts) and its language choice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateIPv4, parseAddress, parseQr, pcUrl, pcLabel, readSaved } from "../android-app/connect-lib.ts";
import { pickLang, STRINGS } from "../android-app/strings.ts";

test("only home-network IPv4 addresses are accepted", () => {
  for (const ok of ["192.168.1.20", "10.0.0.7", "172.16.0.1", "172.31.255.254"]) assert.equal(isPrivateIPv4(ok), true, ok);
  for (const bad of ["100.64.0.1", "8.8.8.8", "127.0.0.1", "172.15.0.1", "172.32.0.1", "192.169.1.1", "192.168.1", "192.168.1.256", "192.168.01.4", "example.com", "::1", "", "192.168.1.20.5"]) assert.equal(isPrivateIPv4(bad), false, bad);
});

test("typed address: host, optional port (default 1420)", () => {
  assert.deepEqual(parseAddress("192.168.1.20"), { host: "192.168.1.20", port: 1420 });
  assert.deepEqual(parseAddress(" 192.168.1.20:1430 "), { host: "192.168.1.20", port: 1430 });
  assert.deepEqual(parseAddress("http://10.0.0.2:80/"), { host: "10.0.0.2", port: 80 });
  for (const bad of ["", "192.168.1.20:0", "192.168.1.20:99999", "192.168.1.20:", "100.100.1.1", "https://192.168.1.20", "192.168.1.20/x", "192.168.1.20@evil.com", "evil.com"]) assert.equal(parseAddress(bad), null, bad);
});

test("QR code: exactly http://<private ip>[:port]/?pair=<digits>", () => {
  assert.deepEqual(parseQr("http://192.168.1.20:1420/?pair=123456"), { pc: { host: "192.168.1.20", port: 1420 }, pin: "123456" });
  assert.deepEqual(parseQr("http://10.1.2.3/?pair=654321"), { pc: { host: "10.1.2.3", port: 1420 }, pin: "654321" });
  for (const bad of [
    "https://192.168.1.20:1420/?pair=123456", "http://192.168.1.20:1420/?pair=12ab56", "http://192.168.1.20:1420/", "http://192.168.1.20:1420/?pair=123456&x=1",
    "http://100.64.0.1:1420/?pair=123456", "http://evil.com/?pair=123456", "http://192.168.1.20@evil.com/?pair=123456", "http://192.168.1.20:1420/other?pair=123456",
    "WIFI:S:home;T:WPA;P:secret;;", "https://example.com", "",
  ]) assert.equal(parseQr(bad), null, bad);
});

test("urls, labels and saved values", () => {
  assert.equal(pcUrl({ host: "192.168.1.20", port: 1420 }), "http://192.168.1.20:1420/");
  assert.equal(pcUrl({ host: "192.168.1.20", port: 1420 }, "123456"), "http://192.168.1.20:1420/?pair=123456");
  assert.equal(pcLabel({ host: "192.168.1.20", port: 1420 }), "192.168.1.20");
  assert.equal(pcLabel({ host: "192.168.1.20", port: 1430 }), "192.168.1.20:1430");
  assert.deepEqual(readSaved('{"host":"192.168.1.20","port":1430}'), { host: "192.168.1.20", port: 1430 });
  for (const bad of [null, "", "nope", '{"host":"8.8.8.8","port":80}', '{"host":"192.168.1.20","port":"1"}', '{"host":"192.168.1.20"}']) assert.equal(readSaved(bad), null, String(bad));
});

test("language: Persian phones get Persian, everyone else English; both tables have the same keys", () => {
  assert.equal(pickLang("fa"), "fa");
  assert.equal(pickLang("fa-IR"), "fa");
  assert.equal(pickLang("en-US"), "en");
  assert.equal(pickLang("fr"), "en");
  assert.equal(pickLang(undefined), "en");
  assert.deepEqual(Object.keys(STRINGS.fa).sort(), Object.keys(STRINGS.en).sort());
  for (const k of Object.keys(STRINGS.en)) assert.ok(STRINGS.fa[k].length > 0 && STRINGS.en[k].length > 0, k);
});
