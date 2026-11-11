import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button, cx } from "./ui";

/** Settings → Your library → Library folder: the folder that holds Movies/ and Series/. */
export function LibraryFolder() {
  const [info, setInfo] = useState<{ current: string; saved: string | null; ok: boolean } | null>(null);
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    fetch("/api/media-root").then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) { setInfo(d); setValue(d.saved ?? d.current); } }).catch(() => undefined);
  }, []);
  if (!info) return null;

  const save = async () => {
    setMsg(null);
    try {
      const r = await fetch("/api/media-root", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: value }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setInfo({ ...info, saved: d.saved });
      setMsg({ ok: true, text: d.restart ? "Saved. Close and reopen CiRoom to use it." : "Saved." });
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Couldn't save" }); }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-4">
      <div className="min-w-0 flex-1 basis-60">
        <div className="text-[15px] font-medium text-fg">Library folder</div>
        <div className="meta mt-0.5">
          The folder with your <span className="font-mono">Movies</span> and <span className="font-mono">Series</span> folders inside.
          {!info.ok && <span className="text-danger"> No Movies or Series folder found in the current one.</span>}
          {msg && <span className={cx("ml-1", msg.ok ? "text-success" : "text-danger")}>{msg.text}</span>}
        </div>
      </div>
      <div className="flex gap-2">
        <input value={value} onChange={(e) => setValue(e.target.value)} aria-label="Library folder" spellCheck={false}
          className="h-10 w-72 rounded-full bg-white/[.07] px-4 font-mono text-[13px] outline-none ring-1 ring-white/[.08] focus:ring-accent" />
        <Button icon={<FolderOpen size={16} />} disabled={!value.trim() || value === (info.saved ?? info.current)} onClick={save}>Save</Button>
      </div>
    </div>
  );
}

/** Settings → Where CiRoom keeps its data: the real folder (shared with the other system when set up). */
export function DataFolder() {
  const [d, setD] = useState<{ dataDir: string; shared: boolean } | null>(null);
  useEffect(() => { fetch("/api/media-root").then((r) => (r.ok ? r.json() : null)).then(setD).catch(() => undefined); }, []);
  if (!d) return null;
  return (
    <div className="space-y-1.5 px-5 py-4 text-[13px] text-fg-muted">
      <div className="font-mono">{d.dataDir}</div>
      <div className="text-fg-subtle">
        Progress, favorites, watchlist, watch time, subtitle choices, these settings, skip-intro results (database ciroom.db, daily backups in backups/), plus artwork and metadata.
        {d.shared && <span className="text-success"> Shared with your other system (Linux and Windows see the same data).</span>}
      </div>
    </div>
  );
}
