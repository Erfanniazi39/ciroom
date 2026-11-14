/**
 * Chunked playback for the in-page player (Media Source Extensions), the way YouTube does it.
 *
 * The dev bridge streams fragmented MP4 from ffmpeg starting at a time `t`. Instead of handing that URL to
 * <video> (a one-way pipe the browser can't seek in), we fetch it ourselves and append the chunks to a
 * SourceBuffer placed on the file's real timeline (timestampOffset = where that stream really starts,
 * from /api/seekpoint). Result:
 *  - jumps inside what's loaded (±10 s, scrubbing back) are instant: no reload, no audio gap;
 *  - jumps elsewhere load from there and land on the exact second (the decoder starts at the keyframe
 *    before it and skips ahead by itself);
 *  - we keep ~2 min loaded ahead and drop what's far behind, so memory stays bounded.
 * Verified in WebKitGTK 2.52 (the desktop window): +10 s seek in ~90 ms while playing.
 */
import { streamApi, type ProbeInfo } from "@/api/stream";

const AHEAD_MAX = 120; // seconds to keep loaded ahead of the playhead
const KEEP_BEHIND = 45; // seconds to keep behind it (instant back-jumps)

/** MIME for the stream: H.264 video (copied: from the file; transcoded: High@4.0) + AAC-LC audio. */
export function streamMime(info: ProbeInfo): string {
  const v = info.codecs?.video ?? "avc1.640028";
  return info.audio ? `video/mp4; codecs="${v}, mp4a.40.2"` : `video/mp4; codecs="${v}"`;
}

/** Where the chunks come from: the PC's own API, or the watch-party guest API (src/party/guest.ts). */
export interface StreamSource {
  seekPoint: (path: string, t: number, audio?: number) => Promise<number>;
  streamUrl: (path: string, t: number, level?: boolean, audio?: number) => string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MseStream {
  static supported(mime: string): boolean {
    return typeof window !== "undefined" && "MediaSource" in window && MediaSource.isTypeSupported(mime);
  }

  private ms = new MediaSource();
  private sb: SourceBuffer | null = null;
  private url = "";
  private gen = 0; // bumps on every (re)load and on destroy; stale loops stop
  private ctrl: AbortController | null = null;
  private head = 0; // absolute time where the active fetch is appending
  private loading = false;
  private opened: Promise<void>;
  private dead = false;
  private earlyEnd = -1; // where a stream last ended before the duration (a second end there = a real error)

  constructor(
    private video: HTMLVideoElement,
    private path: string,
    private duration: number,
    mime: string,
    private level: boolean,
    private audio: number,
    private onError: (message: string) => void,
    private api: StreamSource = streamApi,
  ) {
    this.url = URL.createObjectURL(this.ms);
    video.src = this.url;
    this.opened = new Promise((resolve) => {
      this.ms.addEventListener("sourceopen", () => {
        try {
          this.ms.duration = duration;
          this.sb = this.ms.addSourceBuffer(mime);
          this.sb.mode = "segments";
          resolve();
        } catch (e) {
          onError(`This video can't be played here (${e instanceof Error ? e.message : "codec"}). Try the full player.`);
        }
      }, { once: true });
    });
  }

  /** Start playback at `t` (resume position). */
  async start(t: number) {
    await this.opened;
    this.video.currentTime = t;
    void this.load(t);
  }

  /** Jump to `t`: instant if it's loaded, otherwise load from there. */
  seek(t: number) {
    this.video.currentTime = t;
    if (!this.isBuffered(t) && !(this.loading && t >= this.head - 1 && t <= this.head + 8)) void this.load(t);
  }

  /** Volume levelling changed: the audio comes from the server, so reload from the current position. */
  setLevel(on: boolean) {
    if (on === this.level) return;
    this.level = on;
    void this.reloadFrom(this.video.currentTime);
  }

  /** Another audio track was chosen: reload from the current position (like a far seek). */
  setAudio(n: number) {
    if (n === this.audio) return;
    this.audio = n;
    void this.reloadFrom(this.video.currentTime);
  }

  /** The video stalled: make sure something is loading at the playhead. */
  onWaiting() {
    const t = this.video.currentTime;
    if (!this.isBuffered(t) && !(this.loading && Math.abs(this.head - t) < 8)) void this.load(t);
  }

  /** The loaded range around `t` (for the seek bar), or null. */
  rangeAt(t: number): [number, number] | null {
    const b = this.video.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) - 0.3 <= t && t <= b.end(i) + 0.3) return [b.start(i), b.end(i)];
    return null;
  }

  destroy() {
    this.dead = true;
    this.gen++;
    this.ctrl?.abort();
    try { if (this.ms.readyState === "open") this.ms.endOfStream(); } catch { /* closing */ }
    this.video.removeAttribute("src");
    this.video.load();
    URL.revokeObjectURL(this.url);
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────
  private isBuffered(t: number) {
    const r = this.rangeAt(t);
    return !!r && t <= r[1] - 0.5;
  }

  private async reloadFrom(t: number) {
    await this.idle();
    try { this.sb?.remove(0, Infinity); } catch { /* nothing buffered */ }
    await this.idle();
    this.video.currentTime = t;
    void this.load(t);
  }

  /**
   * Where the active fetch is appending: the end of the loaded range that starts at/after this stream's
   * origin. Tolerant of small shifts (re-encoded audio can move the stream's start by a few hundred ms).
   */
  private updateHead(origin: number) {
    const b = this.video.buffered;
    let head = this.head;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= head + 1.5 && b.end(i) >= origin - 3) head = Math.max(head, b.end(i));
    this.head = head;
  }

  private async idle() {
    while (this.sb?.updating) await new Promise((r) => this.sb!.addEventListener("updateend", r, { once: true }));
  }

  private async load(t: number) {
    if (this.dead) return;
    const gen = ++this.gen;
    this.ctrl?.abort();
    const ctrl = (this.ctrl = new AbortController());
    await this.opened;
    const sb = this.sb;
    if (!sb || this.dead || gen !== this.gen) return;
    t = Math.round(t * 1000) / 1000; // the same value for /api/seekpoint and /api/stream
    const origin = await this.api.seekPoint(this.path, t, this.audio);
    if (gen !== this.gen) return;
    await this.idle();
    if (gen !== this.gen) return;
    try { sb.abort(); } catch { /* not appending */ } // fresh parser state: the new stream starts with its own init segment
    sb.timestampOffset = origin;
    this.head = origin;
    this.loading = true;
    try {
      const r = await fetch(this.api.streamUrl(this.path, t, this.level, this.audio), { signal: ctrl.signal });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const reader = r.body.getReader();
      let appended = 0;
      for (;;) {
        // Back-pressure: don't read further ahead than AHEAD_MAX (ffmpeg pauses with us).
        while (gen === this.gen && this.head - this.video.currentTime > AHEAD_MAX) await sleep(400);
        if (gen !== this.gen) { void reader.cancel(); return; }
        const { done, value } = await reader.read();
        if (gen !== this.gen) { void reader.cancel(); return; }
        if (done) {
          if (this.head >= this.duration - 2) {
            this.earlyEnd = -1;
            await this.idle();
            try { this.ms.endOfStream(); } catch { /* already ended */ }
          } else if (this.earlyEnd >= 0 && Math.abs(this.head - this.earlyEnd) < 2) {
            // Ended early twice at the same place: retrying would spin forever.
            this.earlyEnd = -1;
            this.onError("The video stops here and can't be streamed further. Try the full player.");
          } else {
            this.earlyEnd = this.head; // first time: the stall handler retries once
          }
          break;
        }
        await this.append(value, gen);
        this.updateHead(origin);
        if (++appended % 20 === 0) await this.evict();
      }
    } catch (e) {
      if (gen === this.gen && !(e instanceof DOMException && e.name === "AbortError")) this.onError("The video stream was interrupted. Press play to retry, or use the full player.");
    } finally {
      if (gen === this.gen) this.loading = false;
    }
  }

  private async append(chunk: Uint8Array, gen: number) {
    const sb = this.sb!;
    for (let attempt = 0; attempt < 30 && gen === this.gen; attempt++) {
      await this.idle();
      try {
        sb.appendBuffer(chunk);
        await this.idle();
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "QuotaExceededError") { await this.evict(true); await sleep(500); continue; }
        throw e;
      }
    }
  }

  /** Drop what's far behind (and, when full, far ahead) so the browser's buffer quota is never hit. */
  private async evict(full = false) {
    const sb = this.sb!;
    const t = this.video.currentTime;
    const behind = t - (full ? 10 : KEEP_BEHIND);
    await this.idle();
    try {
      if (behind > 0 && sb.buffered.length && sb.buffered.start(0) < behind) { sb.remove(0, behind); await this.idle(); }
      const aheadLimit = t + AHEAD_MAX + 30;
      if (sb.buffered.length && sb.buffered.end(sb.buffered.length - 1) > aheadLimit && this.head <= aheadLimit) { sb.remove(aheadLimit, Infinity); await this.idle(); }
    } catch { /* removal while closing */ }
  }
}
