import { Check, ExternalLink, Globe, ImageUp, KeyRound, Link2, Loader2, RotateCcw, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { artApi, type ArtKind, type TmdbCandidate, type TmdbType } from "@/api/artwork";
import { metaApi } from "@/api/meta";
import { useLibrary } from "@/store/library";
import type { Artwork } from "@/types/media";
import { BackdropArt, PosterArt } from "./Artwork";
import { Button, Segmented, cx } from "./ui";

type Tab = "online" | "link" | "file";

interface Props {
  open: boolean;
  onClose: () => void;
  id: string;
  type: TmdbType;
  title: string;
  year?: number;
  art: Artwork;
  /** Seasons on disk (series), so a re-match also fetches their episode titles. */
  seasons?: number[];
  /** "match": opened from Library → Metadata to fix a wrong match (TMDB search only). */
  mode?: "art" | "match";
}

/**
 * Change a title's poster/backdrop: search TMDB, paste an image link, or pick a local file.
 * Images are cached in the app's data folder, never written next to your media.
 */
export function ArtworkDialog({ open, onClose, id, type, title, year, art, seasons, mode = "art" }: Props) {
  const setArt = useLibrary((s) => s.setArt);
  const setMeta = useLibrary((s) => s.setMeta);
  const [tab, setTab] = useState<Tab>("online");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDone(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  /** Run an artwork action with shared busy/error/success handling. */
  const run = async (label: string, fn: () => Promise<Parameters<typeof setArt>[1]>, success: string) => {
    setBusy(label);
    setError(null);
    setDone(null);
    try {
      setArt(id, await fn());
      setDone(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/70 p-4 animate-fade" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={`Artwork for ${title}`}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-[860px] flex-col overflow-hidden rounded-modal bg-surface-1 shadow-[0_40px_120px_-20px_rgb(0_0_0/.95)] ring-1 ring-white/[.08] animate-pop"
      >
        {/* Header with live preview */}
        <div className="relative">
          <BackdropArt art={art} className="h-40">
            <div className="absolute inset-0 bg-gradient-to-t from-surface-1 via-surface-1/50 to-transparent" />
          </BackdropArt>
          <div className="absolute bottom-0 left-6 flex translate-y-1/3 items-end gap-4">
            <PosterArt art={art} title={title} showTitle={false} className="w-24 rounded-lg shadow-lift ring-1 ring-white/10" />
            <div className="pb-8">
              <div className="micro text-fg-subtle">{mode === "match" ? "Fix match" : "Artwork"}</div>
              <div className="font-display text-2xl font-semibold leading-tight">{title}</div>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-fg backdrop-blur hover:bg-black/70">
            <X size={18} />
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 px-6 pb-3 pt-14">
          {mode === "art" && <Segmented
            label="Source"
            value={tab}
            onChange={(t) => { setTab(t); setError(null); setDone(null); }}
            options={[
              { value: "online", label: "Search online" },
              { value: "link", label: "Image link" },
              { value: "file", label: "From computer" },
            ]}
          />}
          {mode === "match" && <p className="meta">Pick the right title. Its details, episode titles, ratings, poster and background will all be used.</p>}
          {mode === "art" && (art.poster || art.backdrop) && (
            <Button variant="ghost" icon={<RotateCcw size={15} />} disabled={!!busy} onClick={() => run("reset", () => artApi.reset(id), "Restored the generated artwork.")}>
              Reset
            </Button>
          )}
        </div>

        {(error || done) && (
          <div className={cx("mx-6 mb-2 rounded-xl px-4 py-2.5 text-[13px]", error ? "bg-danger/10 text-danger" : "bg-success/10 text-success")}>
            {error ?? <span className="flex items-center gap-2"><Check size={15} /> {done}</span>}
          </div>
        )}

        <div className="min-h-[300px] overflow-y-auto px-6 pb-6">
          {tab === "online" && <OnlineTab type={type} title={title} year={year} busy={busy} onPick={(c) => run(`tmdb-${c.tmdbId}`, async () => {
            // Picking a TMDB title = "this is the right title": update details too, then the images.
            const meta = await metaApi.fetch({ id, type, query: title, year, seasons, tmdbId: c.tmdbId });
            setMeta(id, meta);
            return c.poster || c.hasBackdrop ? artApi.apply(id, type, c.tmdbId) : { ...art };
          }, `Matched to “${c.title}${c.year ? ` (${c.year})` : ""}”: details, ratings and artwork updated.`)} />}
          {tab === "link" && <LinkTab busy={busy} onSave={(kind, url) => run(`link-${kind}`, () => artApi.fromUrl(id, kind, url), `${kind === "poster" ? "Poster" : "Background"} updated.`)} />}
          {tab === "file" && <FileTab busy={busy} onFile={(kind, f) => run(`file-${kind}`, () => artApi.fromFile(id, kind, f), `${kind === "poster" ? "Poster" : "Background"} updated.`)} />}
        </div>
      </div>
    </div>
  );
}

function OnlineTab({ type, title, year, busy, onPick }: { type: TmdbType; title: string; year?: number; busy: string | null; onPick: (c: TmdbCandidate) => void }) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [query, setQuery] = useState(title);
  const [results, setResults] = useState<TmdbCandidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const search = async (q = query) => {
    setLoading(true);
    setErr(null);
    try {
      setResults(await artApi.search(type, q, q === title ? year : undefined));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Search failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    artApi.settings().then((s) => {
      setHasKey(s.hasTmdbKey);
      if (s.hasTmdbKey) search(title);
    }).catch(() => setHasKey(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (hasKey === null) return <Spinner />;
  if (!hasKey) return <TmdbKeyForm onSaved={() => { setHasKey(true); search(title); }} />;

  return (
    <div>
      <form onSubmit={(e) => { e.preventDefault(); search(); }} className="flex gap-2">
        <label className="flex h-11 flex-1 items-center gap-2 rounded-full bg-white/[.06] px-4 focus-within:ring-1 focus-within:ring-white/20">
          <Search size={16} className="text-fg-subtle" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} className="flex-1 bg-transparent outline-none" placeholder={`Search TMDB ${type === "movie" ? "movies" : "series"}`} />
        </label>
        <Button type="submit" disabled={loading}>Search</Button>
      </form>
      {err && <p className="mt-4 text-[13px] text-danger">{err}</p>}
      {loading ? (
        <Spinner />
      ) : results && results.length === 0 ? (
        <p className="py-12 text-center text-fg-muted">No results. Try a different spelling or remove the year.</p>
      ) : (
        <div className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-4">
          {results?.map((c) => {
            const isBusy = busy === `tmdb-${c.tmdbId}`;
            return (
              <button key={c.tmdbId} disabled={!!busy} onClick={() => onPick(c)} className="group/res text-left disabled:opacity-60">
                <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-surface-2 ring-1 ring-white/[.06] transition duration-200 group-hover/res:-translate-y-1 group-hover/res:ring-accent">
                  {c.poster ? <img src={c.poster} alt="" loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center p-3 text-center text-[12px] text-fg-subtle">No poster</div>}
                  {isBusy && <div className="absolute inset-0 flex items-center justify-center bg-black/60"><Loader2 className="animate-spin" /></div>}
                </div>
                <div className="mt-2 truncate text-[13px] font-semibold">{c.title}</div>
                <div className="meta text-[12px]">{c.year ?? "—"}{!c.hasBackdrop && " · no background"}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TmdbKeyForm({ onSaved, compact }: { onSaved: () => void; compact?: boolean }) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await artApi.saveTmdbKey(key);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the key");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className={cx(!compact && "mx-auto max-w-md py-8 text-center")}>
      {!compact && (
        <>
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-white/[.05] text-fg-muted"><KeyRound size={22} /></div>
          <h3 className="text-lg font-semibold">Connect to TMDB</h3>
          <p className="mt-1.5 text-[14px] text-fg-muted">Free. Create an account at The Movie Database, then go to <b className="text-fg">Settings → API</b> and copy your <b className="text-fg">API Key</b> or <b className="text-fg">Read Access Token</b>.</p>
        </>
      )}
      <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer" className={cx("inline-flex items-center gap-1.5 text-[13px] font-semibold text-accent hover:underline", !compact && "mt-3")}>
        Get a free key <ExternalLink size={13} />
      </a>
      <form onSubmit={(e) => { e.preventDefault(); if (key.trim()) save(); }} className={cx("flex gap-2", compact ? "mt-3" : "mt-5")}>
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste API key or read access token"
          className="h-11 min-w-0 flex-1 rounded-full bg-white/[.06] px-4 text-[14px] outline-none placeholder:text-fg-subtle focus:ring-1 focus:ring-white/20"
        />
        <Button type="submit" variant="primary" disabled={!key.trim() || saving}>{saving ? "Checking…" : "Save"}</Button>
      </form>
      {err && <p className="mt-2 text-[13px] text-danger">{err}</p>}
    </div>
  );
}

function LinkTab({ busy, onSave }: { busy: string | null; onSave: (kind: ArtKind, url: string) => void }) {
  return (
    <div className="space-y-5 pt-2">
      <p className="flex items-center gap-2 text-[14px] text-fg-muted"><Globe size={15} /> Paste a direct link to a JPG, PNG or WebP image (right-click an image online → <i>Copy image address</i>).</p>
      {(["poster", "backdrop"] as const).map((kind) => <LinkRow key={kind} kind={kind} busy={busy === `link-${kind}`} disabled={!!busy} onSave={onSave} />)}
    </div>
  );
}

function LinkRow({ kind, busy, disabled, onSave }: { kind: ArtKind; busy: boolean; disabled: boolean; onSave: (kind: ArtKind, url: string) => void }) {
  const [url, setUrl] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (url.trim()) onSave(kind, url.trim()); }}>
      <label className="mb-1.5 block text-[13px] font-semibold">{kind === "poster" ? "Poster (portrait, 2:3)" : "Background (landscape, 16:9)"}</label>
      <div className="flex gap-2">
        <label className="flex h-11 flex-1 items-center gap-2 rounded-full bg-white/[.06] px-4 focus-within:ring-1 focus-within:ring-white/20">
          <Link2 size={15} className="text-fg-subtle" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className="min-w-0 flex-1 bg-transparent text-[14px] outline-none" />
        </label>
        <Button type="submit" disabled={disabled || !url.trim()}>{busy ? <Loader2 size={16} className="animate-spin" /> : "Use image"}</Button>
      </div>
    </form>
  );
}

function FileTab({ busy, onFile }: { busy: string | null; onFile: (kind: ArtKind, f: File) => void }) {
  return (
    <div className="grid gap-4 pt-2 sm:grid-cols-[1fr_1.6fr]">
      {(["poster", "backdrop"] as const).map((kind) => <DropZone key={kind} kind={kind} busy={busy === `file-${kind}`} disabled={!!busy} onFile={onFile} />)}
    </div>
  );
}

function DropZone({ kind, busy, disabled, onFile }: { kind: ArtKind; busy: boolean; disabled: boolean; onFile: (kind: ArtKind, f: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => input.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(kind, f); }}
      className={cx(
        "flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-6 text-center transition",
        kind === "poster" ? "aspect-[2/3] max-h-[300px]" : "aspect-video",
        over ? "border-accent bg-accent/5" : "border-white/[.1] hover:border-white/25 hover:bg-white/[.03]",
      )}
    >
      {busy ? <Loader2 className="animate-spin text-fg-muted" /> : <ImageUp size={24} className="text-fg-muted" />}
      <span className="text-[14px] font-semibold">{kind === "poster" ? "Poster" : "Background"}</span>
      <span className="text-[12px] text-fg-subtle">Drop an image or click to choose</span>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(kind, f); e.target.value = ""; }} />
    </button>
  );
}

function Spinner() {
  return <div className="flex justify-center py-16"><Loader2 className="animate-spin text-fg-muted" /></div>;
}
