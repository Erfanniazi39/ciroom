/**
 * The host's side of the watch party (dev/party.js relays to the guests):
 *  - reports what the page player is doing (title, position, paused, speed) several times a second; the server
 *    forwards real changes (play/pause/seek/new episode) to the guests at once;
 *  - applies the guests' play/pause/seek requests to the page player (if the host allows guest controls);
 *  - "waits for her": when a guest is still loading, the host's player pauses until she's ready (max 25 s);
 *  - keeps the guest list and chat for <PartyPanel>.
 * Runs only in this PC's own window. The full player (mpv) isn't part of the party.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { isRemoteClient } from "@/components/MobileNav";
import { meta } from "@/lib/remoteLink";
import { usePlayback } from "@/store/playback";
import { usePlayer } from "@/store/player";
import { getWebController } from "@/store/webControl";

export interface PartyGuest {
  id: string;
  name: string;
  online: boolean;
  status: { buffering: boolean; position: number; paused: boolean; onKey: boolean; at: number } | null;
  lastSeen: number;
}
export interface ChatMsg { id: string; from: string; text: string; at: number; host?: boolean; system?: boolean }

interface PartyStore {
  enabled: boolean;
  guests: PartyGuest[];
  chat: ChatMsg[];
  unread: number;
  open: boolean;
  /** Names the host's player is paused for (waiting while they load). */
  waitingFor: string[];
  /** Names the host stopped waiting for (slow connection): shown as "Continuing without …". */
  gaveUp: string[];
  /** Last thing a guest did ("Sara paused"), shown briefly. */
  notice: { text: string; at: number } | null;
  setOpen: (open: boolean) => void;
}

export const useParty = create<PartyStore>((set) => ({
  enabled: false,
  guests: [],
  chat: [],
  unread: 0,
  open: false,
  waitingFor: [],
  gaveUp: [],
  notice: null,
  setOpen: (open) => set(open ? { open, unread: 0 } : { open }),
}));

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const partyApi = {
  chat: (text: string) => post("/api/party/host/chat", { text }).then((r) => r.json().catch(() => ({}))),
};

const WAIT_MAX_MS = 25_000;
/** After giving up on a slow guest, don't pause for them again until they report ready or this long has passed. */
const GAVE_UP_MS = 60_000;

export function usePartyLink() {
  useEffect(() => {
    if (isRemoteClient()) return;
    let alive = true;
    let es: EventSource | null = null;
    let retry = 0;

    const connect = () => {
      es = new EventSource("/api/party/host/events");
      es.onmessage = (ev) => {
        let m: any;
        try { m = JSON.parse(ev.data); } catch { return; }
        const st = useParty.getState();
        if (m.type === "hello") useParty.setState({ enabled: !!m.enabled, guests: m.guests ?? [], chat: m.chat ?? [] });
        else if (m.type === "guests") useParty.setState({ guests: m.list ?? [] });
        else if (m.type === "chat") useParty.setState({ chat: [...st.chat, m.msg].slice(-100), unread: st.open || m.msg.host ? st.unread : st.unread + 1 });
        else if (m.type === "cmd") applyGuestCmd(m);
      };
      es.onerror = () => { es?.close(); if (alive) retry = window.setTimeout(connect, 3000); };
    };
    connect();

    // ── Guest commands ─────────────────────────────────────────────────────────────────────
    function applyGuestCmd(m: { cmd: string; value?: number; from: string }) {
      const ctl = getWebController();
      if (!ctl || !usePlayback.getState().session) return;
      autoPaused = false; // a guest's own action wins over waiting
      if (m.cmd === "play") ctl.play();
      else if (m.cmd === "pause") ctl.pause();
      else if (m.cmd === "seekTo" && Number.isFinite(m.value)) ctl.seekTo(m.value!);
      const what = m.cmd === "play" ? "pressed play" : m.cmd === "pause" ? "paused" : "jumped";
      useParty.setState({ notice: { text: `${m.from} ${what}`, at: Date.now() } });
      window.setTimeout(report, 50);
    }

    // ── Reporting + waiting for guests ─────────────────────────────────────────────────────
    let autoPaused = false;
    let waitStarted = 0;
    /** guest name → when the host gave up waiting for them */
    const gaveUp = new Map<string, number>();
    let lastBody = "";
    let lastSent = 0;

    function report() {
      if (!alive) return;
      const ctl = getWebController();
      const session = usePlayback.getState().session;
      const full = usePlayer.getState().current; // the full player isn't shared
      const s = ctl && session && !full ? ctl.getState() : null;
      const m = s ? meta() : null;
      const body = s && m
        ? { media: { id: m.id, title: m.title, subtitle: m.subtitle, path: s.path, duration: s.duration }, position: s.position, paused: s.paused || s.waiting, rate: s.rate }
        : { media: null, position: 0, paused: true, rate: 1 };
      const key = JSON.stringify({ ...body, position: Math.round(body.position) });
      const now = Date.now();
      if (key === lastBody && now - lastSent < 1000) return; // nothing new: a heartbeat a second is enough
      lastBody = key;
      lastSent = now;
      post("/api/party/host/state", { ...body, at: now }).catch(() => undefined);
    }

    function waitForGuests() {
      const ctl = getWebController();
      const { guests, enabled } = useParty.getState();
      if (!enabled || !ctl || !usePlayback.getState().session) {
        if (useParty.getState().waitingFor.length) useParty.setState({ waitingFor: [] });
        if (useParty.getState().gaveUp.length) useParty.setState({ gaveUp: [] });
        gaveUp.clear();
        autoPaused = false;
        return;
      }
      const fresh = (g: PartyGuest) => g.online && g.status && Date.now() - g.status.at < 5000 && g.status.onKey;
      const now = Date.now();
      // Forget a give-up once the guest is ready again, has gone, or 60 s have passed.
      for (const [name, at] of gaveUp) {
        const g = guests.find((x) => x.name === name);
        if (now - at > GAVE_UP_MS || !g || !g.online || (fresh(g) && !g.status!.buffering)) gaveUp.delete(name);
      }
      const loading = guests.filter((g) => fresh(g) && g.status!.buffering && !gaveUp.has(g.name)).map((g) => g.name);
      const s = ctl.getState();
      if (loading.length && !s.paused && !s.ended && !autoPaused) {
        autoPaused = true;
        waitStarted = now;
        ctl.pause();
      } else if (autoPaused && !loading.length) {
        autoPaused = false;
        if (s.paused) ctl.play();
      } else if (autoPaused && now - waitStarted > WAIT_MAX_MS) {
        loading.forEach((n) => gaveUp.set(n, now)); // timed out: carry on without them
        autoPaused = false;
        if (s.paused) ctl.play();
      } else if (autoPaused && !s.paused) {
        autoPaused = false; // the host pressed play themselves: don't fight
      }
      const waitingFor = autoPaused ? loading : [];
      if (waitingFor.join() !== useParty.getState().waitingFor.join()) useParty.setState({ waitingFor });
      const gaveUpNames = [...gaveUp.keys()];
      if (gaveUpNames.join() !== useParty.getState().gaveUp.join()) useParty.setState({ gaveUp: gaveUpNames });
    }

    const tick = window.setInterval(() => {
      if (!useParty.getState().enabled) return;
      report();
      waitForGuests();
    }, 300);
    return () => { alive = false; es?.close(); window.clearTimeout(retry); window.clearInterval(tick); };
  }, []);
}
