// The Android Connect screen's address and QR rules (android-app/connect-lib.ts) and its language choice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateIPv4, parseAddress, parseQr, pcUrl, pcLabel, readSaved, parseVersion, isNewer, updateFrom } from "../android-app/connect-lib.ts";
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

test("update check: only a higher x.y.z with an Android APK from this repo's releases counts", () => {
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion("0.1.5"), [0, 1, 5]);
  for (const bad of ["v1.2", "1.2.3-beta", "latest", "", null, undefined, 5, "v1.2.3.4"]) assert.equal(parseVersion(bad), null, String(bad));
  assert.equal(isNewer("v0.1.6", "0.1.5"), true);
  assert.equal(isNewer("v0.2.0", "0.1.9"), true);
  assert.equal(isNewer("v1.0.0", "0.99.99"), true);
  assert.equal(isNewer("v0.10.0", "0.9.0"), true, "numbers, not text");
  assert.equal(isNewer("v0.1.5", "0.1.5"), false);
  assert.equal(isNewer("v0.1.4", "0.1.5"), false);
  assert.equal(isNewer("garbage", "0.1.5"), false);
  assert.equal(isNewer("v9.9.9", "garbage"), false);

  const base = "https://github.com/Erfanniazi39/ciroom/releases/download/v0.2.0/";
  const apk = { name: "CiRoom_0.2.0_android-arm64.apk", browser_download_url: base + "CiRoom_0.2.0_android-arm64.apk" };
  const exe = { name: "CiRoom_0.2.0_x64-setup.exe", browser_download_url: base + "CiRoom_0.2.0_x64-setup.exe" };
  assert.deepEqual(updateFrom({ tag_name: "v0.2.0", assets: [exe, apk] }, "0.1.5"), { version: "0.2.0", url: apk.browser_download_url });
  assert.equal(updateFrom({ tag_name: "v0.2.0", assets: [exe] }, "0.1.5"), null, "newer but no APK (CI still building, or a desktop-only release)");
  assert.equal(updateFrom({ tag_name: "v0.1.5", assets: [apk] }, "0.1.5"), null, "same version");
  assert.equal(updateFrom({ tag_name: "v0.2.0", assets: [{ name: apk.name, browser_download_url: "https://evil.example/" + apk.name }] }, "0.1.5"), null, "a link outside this repo's downloads is never offered");
  for (const odd of [null, undefined, {}, "x", { tag_name: "v0.2.0" }, { tag_name: "v0.2.0", assets: "x" }, { tag_name: "v0.2.0", assets: [null, 5] }]) assert.equal(updateFrom(odd, "0.1.5"), null, JSON.stringify(odd));
});
