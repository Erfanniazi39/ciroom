import { Check, Copy, Link2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParty } from "@/lib/partyLink";
import { Button, cx } from "./ui";

interface Info {
  enabled: boolean;
  hostName: string;
  guestControl: boolean;
  urls: { label: string; url: string }[];
  invite: { expiresIn: number } | null;
  guests: { id: string; name: string; online: boolean; lastSeen: number }[];
}

const post = (url: string, body: unknown = {}) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json().catch(() => ({})));

type RowT = React.ComponentType<{ label: string; hint?: React.ReactNode; children: React.ReactNode }>;
type ToggleT = React.ComponentType<{ on: boolean; onChange: (v: boolean) => void; label: string }>;

/** Settings → Watch party: on/off, your name, guest controls, invite links (single use, 30 min), guests (remove). */
export function WatchPartySettings({ Row, Toggle }: { Row: RowT; Toggle: ToggleT }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [links, setLinks] = useState<{ label: string; url: string }[] | null>(null);
  const [left, setLeft] = useState(0);
  const [copied, setCopied] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [name, setName] = useState("");

  const refresh = useCallback(() => fetch("/api/party/host/info").then((r) => r.json()).then((i: Info) => {
    setInfo(i);
    setName((n) => n || i.hostName);
    if (!i.invite) setLinks(null);
    else setLeft(i.invite.expiresIn);
  }).catch(() => undefined), []);
  useEffect(() => { void refresh(); const t = window.setInterval(refresh, 4000); return () => window.clearInterval(t); }, [refresh]);
  useEffect(() => { if (left <= 0) return; const t = window.setTimeout(() => setLeft((l) => l - 1), 1000); return () => window.clearTimeout(t); }, [left]);

  if (!info) return <Row label="Watch party" hint="Loading…"><span /></Row>;
  const hasTailscale = info.urls.some((u) => u.label === "Tailscale");

  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(url); window.setTimeout(() => setCopied(""), 2000); }
    catch { setMsg("Couldn't copy. Select the link and copy it by hand."); }
  };

  return (
    <>
      <Row label="Watch together, from anywhere" hint="Someone you invite opens a link in their browser and watches what you play here, in sync, with a chat. The video streams from this PC over Tailscale, a private encrypted network: nothing is public, and guests can only watch what you're playing right now.">
        <Toggle on={info.enabled} onChange={async (v) => { await post("/api/party/host/enable", { on: v }); useParty.setState({ enabled: v }); void refresh(); }} label="Watch party" />
      </Row>
      {info.enabled && (
        <>
          <Row label="Your name in the chat">
            <input
              value={name}
              maxLength={24}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void post("/api/party/host/settings", { hostName: name })}
              className="h-10 w-44 rounded-full bg-white/[.08] px-4 text-sm outline-none focus:bg-white/[.12]"
            />
          </Row>
          <Row label="Guests can pause and jump" hint="Their play, pause and seek control your player too. Off: only you control playback.">
            <Toggle on={info.guestControl} onChange={async (v) => { await post("/api/party/host/settings", { guestControl: v }); void refresh(); }} label="Guest controls" />
          </Row>
          <Row
            label="Invite someone"
            hint={hasTailscale
              ? "Creates a link that works once and expires in 30 minutes. Send it to them privately; they open it in Chrome, Edge or Firefox while Tailscale is on."
              : <>Tailscale isn't running on this PC, so only the home-network link is available (good for testing). See <b className="text-fg">project-state.md → Watch party</b> for the one-time setup.</>}
          >
            {!links && <Button variant="primary" icon={<Link2 size={16} />} onClick={async () => { const r = await post("/api/party/host/invite"); if (r.error) setMsg(r.error); else { setMsg(null); setLinks(r.links); setLeft(r.expiresIn); } }}>Create invite link</Button>}
          </Row>
          {links && left > 0 && (
            <div className="space-y-3 px-5 py-5">
              {links.map((l) => (
                <div key={l.url}>
                  <div className="meta mb-1">{l.label}</div>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 select-all truncate rounded-lg bg-white/[.06] px-3 py-2 text-[13px]">{l.url}</code>
                    <button onClick={() => void copy(l.url)} className="flex h-9 items-center gap-1.5 rounded-full bg-white/[.08] px-3 text-sm font-semibold hover:bg-white/[.16]">
                      {copied === l.url ? <Check size={14} /> : <Copy size={14} />} {copied === l.url ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              ))}
              <div className="meta">Works once · expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</div>
              <Button onClick={async () => { await post("/api/party/host/invite/cancel"); setLinks(null); void refresh(); }}>Cancel invite</Button>
            </div>
          )}
          {msg && <div className="px-5 py-3 text-sm text-danger">{msg}</div>}
          {info.guests.map((g) => (
            <Row key={g.id} label={g.name} hint={g.online ? "Connected now" : `Last seen ${new Date(g.lastSeen).toLocaleString()}`}>
              <button aria-label={`Remove ${g.name}`} onClick={async () => { await post("/api/party/host/revoke", { id: g.id }); void refresh(); }} className={cx("flex h-10 items-center gap-2 rounded-full bg-white/[.08] px-4 text-sm font-semibold hover:bg-white/[.16]")}>
                <Trash2 size={15} /> Remove
              </button>
            </Row>
          ))}
        </>
      )}
    </>
  );
}
