import { HeartPulse, Library as LibraryIcon, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api";
import { subSearchApi } from "@/api/subsearch";
import { PhoneRemoteSettings } from "@/components/PhoneRemoteSettings";
import { WatchPartySettings } from "@/components/WatchPartySettings";
import { UpdateSettings } from "@/components/UpdateSettings";
import { DataFolder, LibraryFolder } from "@/components/LibraryFolder";
import { Button, Segmented, cx } from "@/components/ui";
import { SUBTITLE_LANGUAGES } from "@/lib/languages";
import { setTvMode } from "@/hooks/useTvMode";
import { useSettings } from "@/store/settings";
import { useUser } from "@/store/user";
import type { LibraryRoot } from "@/types/media";

/** Shows a warning when ffmpeg, ffprobe or mpv can't be run (dev/deps.js). Nothing when all is well. */
function MissingTools() {
  const [tools, setTools] = useState<{ name: string; ok: boolean; needed: string; help: string | null }[] | null>(null);
  useEffect(() => { fetch("/api/system/tools").then((r) => (r.ok ? r.json() : null)).then((d) => setTools(d?.tools ?? null)).catch(() => undefined); }, []);
  const missing = tools?.filter((t) => !t.ok) ?? [];
  if (!missing.length) return null;
  return (
    <div className="mt-6 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-[14px] leading-6">
      <div className="font-semibold text-fg">Some programs CiRoom needs were not found</div>
      <ul className="mt-2 list-disc pl-5">
        {missing.map((t) => <li key={t.name}><b>{t.name}</b>: needed for {t.needed}. {t.help}</li>)}
      </ul>
    </div>
  );
}

/** Background skip-intro analysis progress (dev/intro.js). */
function SkipIntroStatus() {
  const [st, setSt] = useState<{ done: number; total: number; running: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetch("/api/markers/status").then((r) => (r.ok ? r.json() : null)).then((d) => alive && setSt(d)).catch(() => undefined);
    load();
    const t = window.setInterval(load, 5000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);
  if (!st) return null;
  const all = st.total > 0 && st.done >= st.total;
  return (
    <div className="meta w-56 text-right text-[13px] leading-5">
      <div className="font-semibold text-fg">{all ? "All episodes checked" : `${st.done} of ${st.total} episodes checked`}</div>
      {st.running ? <div>Now: {st.running}</div> : !all && <div>Starts shortly after CiRoom opens</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">{title}</h2>
      <div className="divide-y divide-white/[.05] rounded-2xl bg-white/[.03]">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
      <div className="min-w-[220px] flex-1">
        <div className="text-[15px] font-medium">{label}</div>
        {hint && <div className="meta mt-0.5 max-w-xl text-[13px] leading-5">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className={cx("relative h-7 w-12 shrink-0 rounded-full transition", on ? "bg-accent" : "bg-white/[.16]")}>
      <span className={cx("absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all", on ? "left-[26px]" : "left-1")} />
    </button>
  );
}

export default function Settings() {
  const st = useSettings();
  const levelling = useUser((s) => s.levelling);
  const setLevelling = useUser((s) => s.setLevelling);
  const resetWatching = useUser((s) => s.resetWatching);
  const [roots, setRoots] = useState<LibraryRoot[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  useEffect(() => { subSearchApi.config().then((c) => setHasKey(c.hasKey), () => setHasKey(false)); }, []);
  const saveKey = async (key: string) => {
    setSavingKey(true);
    setKeyMsg(null);
    try {
      const r = await subSearchApi.setKey(key);
      setHasKey(r.hasKey);
      setKeyInput("");
      setKeyMsg({ ok: true, text: r.hasKey ? "Key accepted." : "Key removed." });
    } catch (e) { setKeyMsg({ ok: false, text: e instanceof Error ? e.message : "Couldn't save the key" }); }
    setSavingKey(false);
  };

  useEffect(() => { api.listRoots().then(setRoots).catch(() => setRoots([])); }, []);

  return (
    <div className="gutter-x max-w-[900px] pb-24 pt-10">
      <h1 className="h-display-l">Settings</h1>
      <p className="meta mt-2">Everything here is saved on this computer.</p>
      <MissingTools />

      <Section title="Updates">
        <UpdateSettings />
      </Section>

      <Section title="Playback">
        <Row label="Play the next episode automatically" hint="A card counts down in the last seconds, and the next episode starts when this one ends. Cancel it with the ✕.">
          <Toggle on={st.autoplayNext} onChange={(v) => st.set({ autoplayNext: v })} label="Auto-play next episode" />
        </Row>
        <Row label="Show the “Up next” card" hint="How long before the end it appears.">
          <Segmented label="Up next timing" value={String(st.upNextSeconds)} onChange={(v) => st.set({ upNextSeconds: Number(v) })}
            options={[5, 10, 15, 20, 30].map((n) => ({ value: String(n), label: `${n} s` }))} />
        </Row>
        <Row label="Mini player" hint="Keep the video playing in a small corner window when you leave the watch page to browse.">
          <Toggle on={st.miniPlayer} onChange={(v) => st.set({ miniPlayer: v })} label="Mini player" />
        </Row>
        <Row label="Volume levelling" hint="Boost quiet videos to a normal loudness, in both players. Takes effect the next time a video starts.">
          <Toggle on={levelling} onChange={setLevelling} label="Volume levelling" />
        </Row>
        <Row label="Skip intro and credits" hint="CiRoom finds each series' intro and end credits by comparing the episodes of a season, in the background. A “Skip intro” / “Next episode” button appears while they play (key S), in both players and on the phone remote.">
          <SkipIntroStatus />
        </Row>
        <Row label="Turn subtitles on automatically" hint="Only when the video has subtitle files next to it.">
          <Toggle on={st.subtitlesDefault} onChange={(v) => st.set({ subtitlesDefault: v })} label="Subtitles on by default" />
        </Row>
        <Row label="Subtitle language order" hint="Words matched against the subtitle names, in order. Leave empty to use the first one found. Applies to the in-page player; the full player has its own order (English first).">
          <input
            value={st.subtitleLanguages}
            onChange={(e) => st.set({ subtitleLanguages: e.target.value })}
            placeholder="English, Persian"
            aria-label="Subtitle language order"
            className="h-10 w-56 rounded-full bg-white/[.07] px-4 text-[14px] outline-none ring-1 ring-white/[.08] placeholder:text-fg-subtle focus:ring-accent"
          />
        </Row>
      </Section>

      <Section title="Subtitle search">
        <Row label="SubDL API key" hint={<>Needed to search for subtitles online. Create a free account on subdl.com and copy the key from its API page. {hasKey ? <span className="text-success">A key is saved.</span> : null}{keyMsg && <span className={cx("ml-1", keyMsg.ok ? "text-success" : "text-danger")}>{keyMsg.text}</span>}</>}>
          <div className="flex gap-2">
            <input type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder={hasKey ? "••••••••  (saved)" : "Paste your key"} aria-label="SubDL API key"
              className="h-10 w-56 rounded-full bg-white/[.07] px-4 text-[14px] outline-none ring-1 ring-white/[.08] placeholder:text-fg-subtle focus:ring-accent" />
            <Button variant="primary" disabled={!keyInput.trim() || savingKey} onClick={() => saveKey(keyInput)}>Save</Button>
            {hasKey && <Button variant="ghost" onClick={() => saveKey("")}>Remove</Button>}
          </div>
        </Row>
        <Row label="Search languages" hint="Which languages “Find subtitles” looks for, in this order. Persian and English by default.">
          <div className="flex max-w-md flex-wrap gap-1.5">
            {[...st.subtitleSearchLanguages.map((c) => SUBTITLE_LANGUAGES.find((l) => l.code === c)).filter((l): l is { code: string; name: string } => !!l), ...SUBTITLE_LANGUAGES.filter((l) => !st.subtitleSearchLanguages.includes(l.code))].map((l) => {
              const on = st.subtitleSearchLanguages.includes(l.code);
              return (
                <button key={l.code} aria-pressed={on} onClick={() => st.set({ subtitleSearchLanguages: on ? st.subtitleSearchLanguages.filter((c) => c !== l.code) : [...st.subtitleSearchLanguages, l.code] })}
                  className={cx("h-8 rounded-full px-3.5 text-[13px] font-medium transition", on ? "bg-accent text-accent-ink" : "bg-white/[.07] text-fg-muted hover:bg-white/[.14] hover:text-fg")}>{l.name}</button>
              );
            })}
          </div>
        </Row>
      </Section>

      <Section title="Phone remote">
        <PhoneRemoteSettings Row={Row} Toggle={Toggle} />
      </Section>

      <Section title="Watch party">
        <WatchPartySettings Row={Row} Toggle={Toggle} />
      </Section>

      <Section title="Couch mode">
        <Row label="TV mode" hint={<>Bigger interface, big focus outlines, and control with the arrow keys and Enter (Esc or Backspace goes back). Fills the screen. Shortcut: <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-[12px]">Ctrl</kbd> + <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-[12px]">Shift</kbd> + <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-[12px]">T</kbd></>}>
          <Toggle on={st.tvMode} onChange={setTvMode} label="TV mode" />
        </Row>
      </Section>

      <Section title="Your library">
        <LibraryFolder />
        <Row label="Media folders" hint="CiRoom only reads these. It never moves, renames or deletes your files.">
          <Link to="/library"><Button icon={<LibraryIcon size={16} />} tabIndex={-1}>Open Library</Button></Link>
        </Row>
        {roots?.map((r) => (
          <div key={r.id} className="flex items-center gap-3 px-5 py-3 text-[13px]">
            <span className={cx("h-2 w-2 shrink-0 rounded-full", r.online ? "bg-success" : "bg-danger")} />
            <span className="min-w-0 flex-1 truncate font-mono text-fg-muted">{r.path}</span>
            <span className="meta shrink-0">{r.itemCount} titles</span>
          </div>
        ))}
        <Row label="Library health" hint="Missing episodes, duplicates, low-quality files and videos without subtitles.">
          <Link to="/health"><Button icon={<HeartPulse size={16} />} tabIndex={-1}>Open report</Button></Link>
        </Row>
      </Section>

      <Section title="Where CiRoom keeps its data">
        <DataFolder />
        <Row label="Reset watching data" hint="Forget progress, history and watch time. Favorites, the watchlist and your files are not touched.">
          {confirm ? (
            <div className="flex gap-2">
              <Button variant="primary" icon={<Trash2 size={16} />} onClick={() => { resetWatching(); setConfirm(false); }}>Yes, reset</Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
            </div>
          ) : (
            <Button icon={<RotateCcw size={16} />} onClick={() => setConfirm(true)}>Reset…</Button>
          )}
        </Row>
      </Section>
    </div>
  );
}
