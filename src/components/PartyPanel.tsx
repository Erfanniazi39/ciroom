import { Loader2, MessageCircle, Send, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { partyApi, useParty, type PartyGuest } from "@/lib/partyLink";
import { timecode } from "@/lib/format";
import { getWebController } from "@/store/webControl";
import { cx } from "./ui";

function guestLine(g: PartyGuest, hostPos: number | null) {
  if (!g.online) return { text: "Offline", tone: "text-muted" };
  const s = g.status;
  if (!s || Date.now() - s.at > 6000) return { text: "Connected", tone: "text-muted" };
  if (!s.onKey) return { text: "Opening the video…", tone: "text-amber-300" };
  if (s.buffering) return { text: "Loading…", tone: "text-amber-300" };
  const drift = hostPos !== null ? s.position - hostPos : 0;
  return { text: `Watching · ${timecode(s.position)}${Math.abs(drift) >= 1.5 ? ` (${drift > 0 ? "+" : ""}${drift.toFixed(1)} s)` : ""}`, tone: "text-emerald-300" };
}

/** The host's watch-party panel: who's watching (and whether they're loading) plus the chat. Shown while the party is on. */
export function PartyPanel() {
  const { enabled, guests, chat, unread, open, waitingFor, gaveUp, notice, setOpen } = useParty();
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [, force] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [fsEl, setFsEl] = useState<Element | null>(null);

  // In real fullscreen only the fullscreen element is visible: render the panel inside it.
  useEffect(() => {
    const on = () => setFsEl(document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  useEffect(() => { const t = window.setInterval(() => force((n) => n + 1), 1000); return () => window.clearInterval(t); }, []);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [chat.length, open]);

  if (!enabled) return null;
  const online = guests.filter((g) => g.online).length;
  const hostPos = getWebController()?.getState().position ?? null;
  const showNotice = notice && Date.now() - notice.at < 4000;

  const sendMsg = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    const r = await partyApi.chat(t);
    setErr(r.error ?? null);
  };

  const panel = (
    <div className="pointer-events-none fixed right-4 top-4 z-[80] flex w-[min(340px,calc(100vw-2rem))] flex-col items-end gap-2" onKeyDown={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen(!open)}
        className="pointer-events-auto flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-[13px] font-semibold text-white ring-1 ring-white/15 backdrop-blur-xl hover:bg-black/85"
        aria-label={open ? "Hide watch party" : "Show watch party"}
      >
        <Users size={15} className="text-violet-300" /> Watch party · {online ? `${online} watching` : "waiting for guests"}
        {!open && unread > 0 && <span className="ml-1 rounded-full bg-violet-500 px-1.5 text-[11px]">{unread}</span>}
      </button>
      {waitingFor.length > 0 && (
        <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-amber-500/90 px-3.5 py-1.5 text-[12px] font-semibold text-black">
          <Loader2 size={13} className="animate-spin" /> Waiting for {waitingFor.join(", ")} to load…
        </div>
      )}
      {gaveUp.length > 0 && waitingFor.length === 0 && (
        <div className="pointer-events-auto rounded-full bg-amber-500/90 px-3.5 py-1.5 text-[12px] font-semibold text-black">
          Continuing without {gaveUp.join(", ")} (slow connection)
        </div>
      )}
      {showNotice && <div className="rounded-full bg-violet-500/90 px-3.5 py-1.5 text-[12px] font-semibold text-white">{notice!.text}</div>}
      {open && (
        <div className="pointer-events-auto flex max-h-[min(520px,70vh)] w-full flex-col overflow-hidden rounded-2xl bg-[#121018]/95 text-white shadow-2xl ring-1 ring-white/10 backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-white/[.06] px-4 py-3">
            <div className="text-[13px] font-semibold">Guests</div>
            <button onClick={() => setOpen(false)} aria-label="Close" className="rounded-full p-1 text-white/70 hover:bg-white/10 hover:text-white"><X size={15} /></button>
          </div>
          <div className="space-y-1.5 px-4 py-3">
            {guests.length === 0 && <div className="text-[12px] text-white/50">Nobody has joined yet. Settings → Watch party → Invite.</div>}
            {guests.map((g) => {
              const l = guestLine(g, hostPos);
              return (
                <div key={g.id} className="flex items-center justify-between gap-3 text-[13px]">
                  <span className="flex items-center gap-2 font-medium"><span className={cx("h-2 w-2 rounded-full", g.online ? "bg-emerald-400" : "bg-white/25")} />{g.name}</span>
                  <span className={cx("truncate text-[12px]", l.tone)}>{l.text}</span>
                </div>
              );
            })}
          </div>
          <div ref={listRef} className="min-h-[120px] flex-1 space-y-2 overflow-y-auto border-t border-white/[.06] px-4 py-3">
            {chat.length === 0 && <div className="flex items-center gap-2 text-[12px] text-white/40"><MessageCircle size={13} /> Messages appear here.</div>}
            {chat.map((m) =>
              m.system ? (
                <div key={m.id} className="text-center text-[11px] text-white/40">{m.text}</div>
              ) : (
                <div key={m.id} className={cx("flex flex-col", m.host ? "items-end" : "items-start")}>
                  <span className="mb-0.5 text-[11px] text-white/45">{m.from}</span>
                  <span dir="auto" className={cx("max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-[13px]", m.host ? "bg-violet-500/80" : "bg-white/10")}>{m.text}</span>
                </div>
              ),
            )}
          </div>
          {err && <div className="px-4 pb-1 text-[12px] text-red-300">{err}</div>}
          <form className="flex items-center gap-2 border-t border-white/[.06] p-2.5" onSubmit={(e) => { e.preventDefault(); void sendMsg(); }}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={500}
              dir="auto"
              placeholder="Message…"
              className="min-w-0 flex-1 rounded-full bg-white/[.08] px-3.5 py-2 text-[13px] text-white outline-none placeholder:text-white/40 focus:bg-white/[.12]"
            />
            <button type="submit" aria-label="Send" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-500 text-white hover:bg-violet-400"><Send size={15} /></button>
          </form>
        </div>
      )}
    </div>
  );
  return createPortal(panel, fsEl ?? document.body);
}
