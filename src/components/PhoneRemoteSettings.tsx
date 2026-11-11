import { Smartphone, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { qrMatrix } from "@/lib/qr";
import { Button, cx } from "./ui";

interface Info {
  enabled: boolean;
  urls: string[];
  pairing: { pin: string; expiresIn: number } | null;
  devices: { id: string; name: string; created: number; lastSeen: number }[];
}

const post = (url: string, body: unknown = {}) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json().catch(() => ({})));

function Qr({ text }: { text: string }) {
  const m = useMemo(() => qrMatrix(text), [text]);
  const n = m.length;
  return (
    <svg viewBox={`-4 -4 ${n + 8} ${n + 8}`} className="h-44 w-44 rounded-xl bg-white" shapeRendering="crispEdges" role="img" aria-label="QR code to pair your phone">
      {m.flatMap((row, y) => row.map((d, x) => (d ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#000" /> : null)))}
    </svg>
  );
}

/** Settings → Phone remote: turn it on, pair a phone with a QR code + PIN, see and revoke paired phones. */
export function PhoneRemoteSettings({ Row, Toggle }: { Row: React.ComponentType<{ label: string; hint?: React.ReactNode; children: React.ReactNode }>; Toggle: React.ComponentType<{ on: boolean; onChange: (v: boolean) => void; label: string }> }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [left, setLeft] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = useCallback(() => fetch("/api/remote/info").then((r) => r.json()).then((i: Info) => { setInfo(i); setLeft(i.pairing?.expiresIn ?? 0); }).catch(() => undefined), []);
  useEffect(() => { void refresh(); const t = window.setInterval(refresh, 4000); return () => window.clearInterval(t); }, [refresh]);
  useEffect(() => { if (left <= 0) return; const t = window.setTimeout(() => setLeft((l) => l - 1), 1000); return () => window.clearTimeout(t); }, [left]);

  if (!info) return <Row label="Phone remote" hint="Loading…"><span /></Row>;
  const url = info.urls[0];
  const pairing = info.pairing && left > 0 ? info.pairing : null;
  const pairUrl = url && pairing ? `${url}/?pair=${pairing.pin}` : "";

  return (
    <>
      <Row label="Control CiRoom from your phone" hint="Your phone opens a page over your home Wi-Fi and becomes a remote: now playing, play/pause, ±10 s, volume, subtitles, next episode, browse and start titles. Only phones you pair can connect, and nothing leaves your network.">
        <Toggle on={info.enabled} onChange={async (v) => { await post("/api/remote/enable", { on: v }); void refresh(); }} label="Phone remote" />
      </Row>
      {info.enabled && (
        <>
          <Row
            label="Pair a phone"
            hint={url ? <>Phone and PC on the same Wi-Fi. Scan the code with the phone's camera, or open <b className="text-fg">{url}</b> and type the PIN. It works once and expires in 5 minutes.</> : "No home Wi-Fi address was found on this PC. Connect to your Wi-Fi first."}
          >
            {!pairing && <Button variant="primary" disabled={!url} icon={<Smartphone size={16} />} onClick={async () => { const r = await post("/api/remote/pair/start"); if (r.error) setMsg(r.error); void refresh(); }}>Pair a phone</Button>}
          </Row>
          {pairing && (
            <div className="flex flex-wrap items-center gap-8 px-5 py-6">
              <Qr text={pairUrl} />
              <div>
                <div className="meta">PIN</div>
                <div className="font-mono text-[40px] font-semibold tracking-[0.25em]">{pairing.pin}</div>
                <div className="meta mt-1">Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</div>
                <Button className="mt-4" onClick={async () => { await post("/api/remote/pair/cancel"); void refresh(); }}>Cancel</Button>
              </div>
            </div>
          )}
          {msg && <div className="px-5 py-3 text-sm text-danger">{msg}</div>}
          {info.urls.length > 1 && <div className="meta px-5 py-3">Other addresses of this PC: {info.urls.slice(1).join(", ")}</div>}
          {info.devices.map((d) => (
            <Row key={d.id} label={d.name} hint={`Paired ${new Date(d.created).toLocaleDateString()} · last seen ${new Date(d.lastSeen).toLocaleString()}`}>
              <button aria-label={`Remove ${d.name}`} onClick={async () => { await post("/api/remote/revoke", { id: d.id }); void refresh(); }} className={cx("flex h-10 items-center gap-2 rounded-full bg-white/[.08] px-4 text-sm font-semibold hover:bg-white/[.16]")}>
                <Trash2 size={15} /> Remove
              </button>
            </Row>
          ))}
        </>
      )}
    </>
  );
}
