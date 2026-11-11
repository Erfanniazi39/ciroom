import { Check, Download, KeyRound, Loader2, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { subSearchApi, type SearchContext, type SubtitleResult } from "@/api/subsearch";
import { SUBTITLE_LANGUAGES, languageName } from "@/lib/languages";
import { useSettings } from "@/store/settings";
import { cx } from "./ui";

/**
 * "Find subtitles" panel (inside the page player). Search runs for the languages you toggle on
 * (Persian and English by default); "Use" downloads one into CiRoom's own folder and selects it.
 * Nothing is written next to your videos.
 */
export function SubtitleFinder({ path, ctx, onClose, onAdded, onChanged }: {
  path: string;
  ctx: SearchContext;
  onClose: () => void;
  onAdded: (file: string) => void;
  onChanged: () => void;
}) {
  const langs = useSettings((s) => s.subtitleSearchLanguages);
  const setSettings = useSettings((s) => s.set);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [results, setResults] = useState<SubtitleResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [mine, setMine] = useState<string[]>([]);
  const [more, setMore] = useState(false);

  useEffect(() => {
    subSearchApi.config().then((c) => setHasKey(c.hasKey), () => setHasKey(false));
    subSearchApi.downloaded(path).then((d) => setMine(d.files), () => {});
  }, [path]);

  const search = useCallback(() => {
    if (!langs.length) { setResults([]); return; }
    setSearching(true);
    setError(null);
    subSearchApi.search(path, ctx, langs).then(
      (r) => { setResults(r.results); setSearching(false); },
      (e) => { setError(e instanceof Error ? e.message : "Search failed"); if ((e as { code?: string }).code === "key") setHasKey(false); setSearching(false); },
    );
  }, [path, ctx, langs]);

  useEffect(() => { if (hasKey) search(); }, [hasKey, search]);

  const toggle = (code: string) => setSettings({ subtitleSearchLanguages: langs.includes(code) ? langs.filter((c) => c !== code) : [...langs, code] });

  const saveKey = async () => {
    setSavingKey(true);
    setError(null);
    try { setHasKey((await subSearchApi.setKey(keyInput)).hasKey); setKeyInput(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't save the key"); }
    setSavingKey(false);
  };

  const use = async (r: SubtitleResult) => {
    setBusy(r.url);
    setError(null);
    try {
      const { file } = await subSearchApi.download(path, r, ctx);
      setAdded((a) => new Set(a).add(r.url));
      setMine((m) => [...m, file]);
      onAdded(file);
    } catch (e) { setError(e instanceof Error ? e.message : "Download failed"); }
    setBusy(null);
  };

  const remove = async (file: string) => {
    try { setMine((await subSearchApi.remove(path, file)).files); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't remove it"); }
  };

  const shown = more ? SUBTITLE_LANGUAGES : SUBTITLE_LANGUAGES.filter((l) => l.code === "FA" || l.code === "EN" || langs.includes(l.code));
  const bestPerLang = new Set<string>();
  const best = (results ?? []).filter((r) => !r.fullSeason && r.score >= 0.6 && !bestPerLang.has(r.language) && bestPerLang.add(r.language)).map((r) => r.url);

  return (
    <div onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}
      className="absolute bottom-[96px] right-[3%] top-[5%] z-20 flex w-[min(470px,94%)] flex-col rounded-2xl bg-[#141419]/97 shadow-[0_24px_70px_-15px_rgb(0_0_0/.95)] ring-1 ring-white/10 animate-pop">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <Search size={17} className="text-violet-300" />
        <span className="flex-1 text-[15px] font-semibold text-white">Find subtitles</span>
        <button onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white"><X size={17} /></button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3">
        {hasKey === false ? (
          <div className="space-y-3 text-[13px] leading-5 text-white/75">
            <div className="flex items-center gap-2 text-[14px] font-semibold text-white"><KeyRound size={16} className="text-violet-300" /> One-time setup</div>
            <p>Subtitles come from SubDL. Create a free account on subdl.com, copy your API key from its API page, and paste it here. It's saved on this computer only.</p>
            <div className="flex gap-2">
              <input type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && keyInput.trim()) void saveKey(); }}
                placeholder="SubDL API key" aria-label="SubDL API key"
                className="h-10 min-w-0 flex-1 rounded-full bg-white/10 px-4 text-[14px] text-white outline-none ring-1 ring-white/10 placeholder:text-white/40 focus:ring-violet-400" />
              <button disabled={!keyInput.trim() || savingKey} onClick={saveKey} className="h-10 rounded-full bg-violet-500 px-5 text-[14px] font-semibold text-white hover:bg-violet-400 disabled:opacity-40">
                {savingKey ? <Loader2 size={16} className="animate-spin" /> : "Save"}
              </button>
            </div>
            {error && <p className="rounded-xl bg-red-500/15 px-3 py-2.5 text-red-200">{error}</p>}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Languages">
              {shown.map((l) => (
                <button key={l.code} aria-pressed={langs.includes(l.code)} onClick={() => toggle(l.code)}
                  className={cx("h-8 rounded-full px-3.5 text-[13px] font-semibold transition", langs.includes(l.code) ? "bg-violet-500 text-white" : "bg-white/10 text-white/70 hover:bg-white/20")}>
                  {l.name}
                </button>
              ))}
              <button onClick={() => setMore((m) => !m)} className="h-8 rounded-full px-3 text-[13px] text-white/55 hover:text-white">{more ? "Fewer" : "More languages…"}</button>
            </div>

            {mine.length > 0 && (
              <div className="mt-4">
                <div className="mb-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-white/45">Added from search</div>
                {mine.map((f) => (
                  <div key={f} className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-[13px] text-white/85">
                    <Check size={14} className="shrink-0 text-violet-300" />
                    <span className="min-w-0 flex-1 truncate">{f}</span>
                    <button onClick={() => remove(f)} aria-label={`Remove ${f}`} title="Remove (your video folder isn't touched)" className="flex h-7 w-7 items-center justify-center rounded-full text-white/50 hover:bg-white/10 hover:text-white"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4">
              {searching && <div className="flex items-center gap-2 py-6 text-[13px] text-white/60"><Loader2 size={16} className="animate-spin" /> Searching…</div>}
              {error && <p className="rounded-xl bg-red-500/15 px-3 py-2.5 text-[13px] text-red-200">{error}</p>}
              {!searching && !error && results && results.length === 0 && (
                <p className="py-6 text-center text-[13px] text-white/55">{langs.length ? `No ${langs.map(languageName).join(" or ")} subtitles found for this video.` : "Pick at least one language."}</p>
              )}
              {!searching && results?.map((r) => (
                <div key={r.url} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-white/[.06]">
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 break-all text-[13px] font-medium leading-[18px] text-white" title={r.release}>{r.release || "Subtitle"}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-white/55">
                      <span className="rounded bg-white/10 px-1.5 py-px font-bold text-white/80">{languageName(r.language)}</span>
                      {best.includes(r.url) && <span className="rounded bg-violet-500/30 px-1.5 py-px font-semibold text-violet-200">Best match</span>}
                      {r.hearingImpaired && <span className="rounded bg-white/10 px-1.5 py-px">SDH</span>}
                      {r.fullSeason && <span className="rounded bg-white/10 px-1.5 py-px">Season pack</span>}
                      {r.author && <span className="truncate">by {r.author}</span>}
                    </div>
                  </div>
                  <button onClick={() => use(r)} disabled={busy !== null || added.has(r.url)}
                    className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-violet-500 px-4 text-[13px] font-semibold text-white hover:bg-violet-400 disabled:opacity-50">
                    {busy === r.url ? <Loader2 size={15} className="animate-spin" /> : added.has(r.url) ? <><Check size={15} /> Added</> : <><Download size={15} /> Use</>}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
