// Is the folder where CiRoom saves progress actually writable?
// Dual-boot case: if Windows was hibernated (or "fast startup" is on), Linux mounts the NTFS drive read-only,
// and every save silently fails. We detect it and let Settings say so.
import fs from "node:fs";
import path from "node:path";

/** Longest-matching mount of `dir` in /proc/mounts text → { mountPoint, fstype, options[] }. */
export function mountOf(dir, mountsText) {
  let best = null;
  for (const line of mountsText.split("\n")) {
    const f = line.split(" ");
    if (f.length < 4) continue;
    const mp = f[1].replace(/\\040/g, " ").replace(/\\011/g, "\t");
    if ((dir === mp || dir.startsWith(mp.endsWith("/") ? mp : mp + "/")) && (!best || mp.length > best.mountPoint.length))
      best = { mountPoint: mp, fstype: f[2], options: f[3].split(",") };
  }
  return best;
}

/** @returns {{ ok: boolean, readOnly: boolean, dir: string, mountPoint?: string, fstype?: string, message: string | null }} */
export function checkWritable(dir, mountsText) {
  const real = path.resolve(dir);
  let readOnlyMount = false, m = null;
  try {
    mountsText ??= fs.readFileSync("/proc/mounts", "utf8");
    m = mountOf(real, mountsText);
    readOnlyMount = !!m && m.options.includes("ro");
  } catch { /* not Linux: rely on the write test */ }
  let readOnlyFs = false;
  try { fs.accessSync(fs.existsSync(real) ? real : path.dirname(real), fs.constants.W_OK); }
  catch (e) { readOnlyFs = e?.code === "EROFS" || e?.code === "EACCES"; }
  const readOnly = readOnlyMount || readOnlyFs;
  const ntfs = m && /ntfs|fuseblk/.test(m.fstype);
  const message = readOnly
    ? `CiRoom can't save to ${real}: the drive is mounted read-only.` +
      (ntfs ? " This usually means Windows was hibernated or shut down with Fast Startup. Boot Windows, turn Fast Startup off and shut down fully (or run `sudo ntfsfix` on the drive), then reopen CiRoom. Until then your watch progress is not saved." : " Your watch progress is not saved until the drive is writable.")
    : null;
  return { ok: !readOnly, readOnly, dir: real, mountPoint: m?.mountPoint, fstype: m?.fstype, message };
}
