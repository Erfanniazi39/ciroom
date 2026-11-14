import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mountOf, checkWritable } from "../server/lib/diskcheck.js";

const mounts = [
  "/dev/sda2 / ext4 rw,relatime 0 0",
  "/dev/sdb1 /media/me/Big\\040Drive fuseblk ro,nosuid,nodev,relatime 0 0",
  "/dev/sdc1 /media/me/Other ext4 rw 0 0",
].join("\n");

test("mountOf picks the longest mount and decodes spaces", () => {
  assert.equal(mountOf("/media/me/Big Drive/CiRoom-data", mounts).fstype, "fuseblk");
  assert.equal(mountOf("/media/me/Other/x", mounts).fstype, "ext4");
  assert.equal(mountOf("/home/me", mounts).mountPoint, "/");
});

test("read-only NTFS drive gives a Windows-hibernation warning", () => {
  const r = checkWritable("/media/me/Big Drive/CiRoom-data", mounts);
  assert.equal(r.ok, false);
  assert.match(r.message, /Fast Startup/);
});

test("a writable folder is ok", () => {
  const r = checkWritable(os.tmpdir(), "/dev/x / ext4 rw 0 0");
  assert.equal(r.ok, true);
  assert.equal(r.message, null);
});
