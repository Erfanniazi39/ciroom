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
import { streamApi, type ProbeInfo, type SeekPoint, type StreamMode } from "@/api/stream";

const AHEAD_MAX = 120; // seconds to keep loaded ahead of the playhead
const KEEP_BEHIND = 45; // seconds to keep behind it (instant back-jumps)
const SEEKPOINT_TIMEOUT = 12_000; // ms: after this, the requested time is used as the stream's origin
const FIRST_BYTE_TIMEOUT = 15_000; // ms to wait for the first chunk of a stream
const CHUNK_GAP_TIMEOUT = 20_000; // ms without a new chunk (while not held back by back-pressure)
const STALL_MS = 8_000; // ms of frozen playhead (not paused, not enough data) before the watchdog reloads
const MAX_STALL_RELOADS = 2; // watchdog reloads without progress before an error is shown

/** MIME for the stream: H.264 video (copied: from the file; transcoded: High@4.0) + AAC-LC audio. */
export function streamMime(info: ProbeInfo): string {
  const v = info.codecs?.video ?? "avc1.640028";
  return info.audio ? `video/mp4; codecs="${v}, mp4a.40.2"` : `video/mp4; codecs="${v}"`;
}

/** The stream's MIME when the server re-encodes to 480p (`q=low`: High@3.1) instead of copying. */
export function lowStreamMime(info: ProbeInfo): string {
  return streamMime({ ...info, codecs: { ...info.codecs, video: "avc1.64001f" } });
}

/** Where the chunks come from: the PC's own API, or the watch-party guest API (src/party/guest.ts). */
export interface StreamSource {
  /** A plain number = the start (copy mode); an object also says which mode gives that start. */
  seekPoint: (path: string, t: number, audio?: number) => Promise<number | SeekPoint>;
  streamUrl: (path: string, t: number, level?: boolean, audio?: number, mode?: StreamMode) => string;
}

const WATCH_EVENTS = ["waiting", "playing", "timeupdate", "seeking", "pause"] as const;

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
  private starting = false; // a load is waiting for /api/seekpoint or its first chunk: those have their own timeouts
  private noRange = 0; // appends in a row without a buffered range at the origin
  private opened!: Promise<void>;
  private dead = false;
  private earlyEnd = -1; // where a stream last ended before the duration (a second end there = a real error)
  private recovered = false; // an append failure already triggered a recovery reload since the playhead last moved on
  private netRetries = 0; // timeouts retried since the playhead last moved on
  private stallReloads = 0; // watchdog reloads since the playhead last moved on
  private lastT = 0; // watchdog: playhead at the last check
  private lastMove = 0; // watchdog: when the playhead last moved (or the user acted)
  private progressBase = 0; // watchdog: playhead where the retry counters were last reset
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readonly onVideoEvent = (e: Event) => this.videoEvent(e.type);

  constructor(
    private video: HTMLVideoElement,
    private path: string,
    private duration: number,
    private mime: string,
    private level: boolean,
    private audio: number,
    private onError: (message: string) => void,
    private api: StreamSource = streamApi,
  ) {
    this.lastT = this.progressBase = video.currentTime;
    this.lastMove = Date.now();
    this.open();
    for (const ev of WATCH_EVENTS) video.addEventListener(ev, this.onVideoEvent);
    this.watchdog = setInterval(() => this.checkStall(), 1000);
  }

  /** Attach a fresh MediaSource to the <video> and open a SourceBuffer on it (constructor and rebuild() share this). */
  private open() {
    const ms = (this.ms = new MediaSource());
    this.sb = null;
    this.url = URL.createObjectURL(ms);
    this.video.src = this.url;
    this.opened = new Promise((resolve) => {
      ms.addEventListener("sourceopen", () => {
        try {
          ms.duration = this.duration;
          this.sb = ms.addSourceBuffer(this.mime);
          this.sb.mode = "segments";
          resolve();
        } catch (e) {
          this.onError(`This video can't be played here (${e instanceof Error ? e.message : "codec"}). Try the full player.`);
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
    void this.rebuild(this.video.currentTime);
  }

  /** Another audio track was chosen: reload from the current position (like a far seek). */
  setAudio(n: number) {
    if (n === this.audio) return;
    this.audio = n;
    void this.rebuild(this.video.currentTime);
  }

  /** The video stalled: make sure something is loading at the playhead. (The watchdog calls the same logic.) */
  onWaiting() {
    this.ensureLoading();
  }

  private ensureLoading() {
    const t = this.video.currentTime;
    if (!this.isBuffered(t) && !(this.loading && Math.abs(this.head - t) < 8)) void this.load(t);
  }

  /** Events from the <video>: track whether the playhead is moving, so a frozen one gets reloaded. */
  private videoEvent(type: string) {
    const t = this.video.currentTime;
    if (type === "seeking" || type === "pause") {
      this.lastT = t;
      this.lastMove = Date.now();
      return;
    }
    if (type === "waiting") { this.ensureLoading(); return; }
    // playing / timeupdate
    if (Math.abs(t - this.lastT) > 0.01) {
      this.lastT = t;
      this.lastMove = Date.now();
    }
    if (Math.abs(t - this.progressBase) >= 2) {
      this.progressBase = t;
      this.stallReloads = 0;
      this.netRetries = 0;
      this.recovered = false;
    }
  }

  /** Once a second: playing, short of data, and the playhead hasn't moved for STALL_MS → reload from it. */
  private checkStall() {
    if (this.dead) return;
    const v = this.video;
    const t = v.currentTime;
    if (this.starting || v.paused || v.ended || v.seeking || v.readyState >= 3) {
      if (v.paused || v.seeking) this.lastMove = Date.now();
      return;
    }
    if (Math.abs(t - this.lastT) > 0.01) { this.lastT = t; this.lastMove = Date.now(); return; }
    if (Date.now() - this.lastMove < STALL_MS) return;
    this.lastMove = Date.now();
    this.progressBase = t;
    if (this.stallReloads >= MAX_STALL_RELOADS) {
      this.stallReloads = 0;
      this.fail("The video keeps stalling here. Try the full player.");
      return;
    }
    this.stallReloads++;
    void this.reloadFrom(t);
  }

  private fail(message: string) {
    if (!this.dead) this.onError(message);
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
    if (this.watchdog) clearInterval(this.watchdog);
    for (const ev of WATCH_EVENTS) this.video.removeEventListener(ev, this.onVideoEvent);
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

  /**
   * Start over on a brand-new MediaSource at `t`. Emptying the SourceBuffer (reloadFrom) leaves WebKit's decoder
   * holding the old picture until the next keyframe (up to 10 s), so audio/levelling switches use this instead.
   * Pause state, volume, mute and speed belong to the <video> element and survive the new src.
   */
  private async rebuild(t: number) {
    if (this.dead) return;
    const wasPlaying = !this.video.paused && !this.video.ended;
    const oldUrl = this.url;
    this.gen++; // stops the old fetch loop
    this.ctrl?.abort();
    this.loading = false;
    this.starting = true; // the watchdog must not count the gap below as a stall
    this.earlyEnd = -1;
    this.recovered = false;
    this.netRetries = 0;
    this.stallReloads = 0;
    this.open();
    URL.revokeObjectURL(oldUrl);
    this.lastT = this.progressBase = t;
    this.lastMove = Date.now();
    await this.opened;
    if (this.dead) return;
    this.video.currentTime = t;
    void this.load(t);
    if (wasPlaying) void this.video.play().catch(() => { /* the user can press play */ });
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
    let found = false;
    for (let i = 0; i < b.length; i++) {
      // the range this stream is filling: it contains (or starts just after) the origin, ±3 s
      if (b.start(i) <= Math.max(this.head, origin) + 3 && b.end(i) >= origin - 3) {
        this.head = Math.max(this.head, b.end(i));
        found = true;
      }
    }
    if (found) { this.noRange = 0; return; }
    // No range matches (shifted start, odd merge): after 3 appends take the last range's end, so `head`
    // keeps up with the data and back-pressure still works.
    if (++this.noRange >= 3 && b.length) {
      if (this.noRange === 3) console.warn("[mse] no buffered range at the stream origin; using the last range");
      this.head = Math.max(this.head, b.end(b.length - 1));
    }
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
    let origin: number;
    let mode: StreamMode | undefined;
    this.starting = true;
    try {
      // No answer in time: ask for an exact (re-encoded) stream from t, so the origin we assume is right.
      const sp = await Promise.race([this.api.seekPoint(this.path, t, this.audio), sleep(SEEKPOINT_TIMEOUT).then((): SeekPoint => ({ start: t, mode: "transcode" }))]);
      origin = typeof sp === "number" ? sp : sp.start;
      mode = typeof sp === "number" ? undefined : sp.mode;
    } catch {
      if (gen === this.gen) { this.starting = false; this.fail("The video couldn't be loaded here. Try the full player."); }
      return;
    }
    if (gen !== this.gen) return;
    await this.idle();
    if (gen !== this.gen) return;
    try { sb.abort(); } catch { /* not appending */ } // fresh parser state: the new stream starts with its own init segment
    sb.timestampOffset = origin;
    this.head = origin;
    this.noRange = 0;
    this.loading = true;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Abort the fetch if nothing arrives in `ms` (a stuck server must not mean an endless spinner).
    const arm = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms); };
    try {
      arm(FIRST_BYTE_TIMEOUT);
      const r = await fetch(this.api.streamUrl(this.path, t, this.level, this.audio, mode), { signal: ctrl.signal });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const reader = r.body.getReader();
      let appended = 0;
      for (;;) {
        // Back-pressure: don't read further ahead than AHEAD_MAX (ffmpeg pauses with us).
        while (gen === this.gen && this.head - this.video.currentTime > AHEAD_MAX) await sleep(400);
        if (gen !== this.gen) { void reader.cancel(); return; }
        arm(appended === 0 ? FIRST_BYTE_TIMEOUT : CHUNK_GAP_TIMEOUT);
        const { done, value } = await reader.read();
        clearTimeout(timer);
        if (gen === this.gen) this.starting = false;
        if (gen !== this.gen) { void reader.cancel(); return; }
        if (done) {
          if (this.head >= this.duration - 2) {
            this.earlyEnd = -1;
            await this.idle();
            try { this.ms.endOfStream(); } catch { /* already ended */ }
          } else if (this.earlyEnd >= 0 && Math.abs(this.head - this.earlyEnd) < 2) {
            // Ended early twice at the same place: retrying would spin forever.
            this.earlyEnd = -1;
            this.fail("The video stops here and can't be streamed further. Try the full player.");
          } else {
            this.earlyEnd = this.head; // first time: the stall handler retries once
          }
          break;
        }
        if (!(await this.append(value, gen))) {
          if (gen !== this.gen) return;
          void reader.cancel();
          this.recover();
          return;
        }
        this.updateHead(origin);
        if (++appended % 20 === 0) await this.evict();
      }
    } catch (e) {
      if (gen !== this.gen) return;
      if (timedOut) {
        // Like an interrupted stream: one automatic retry from the playhead, then an error.
        if (this.netRetries < 1) { this.netRetries++; void this.reloadFrom(this.video.currentTime); }
        else this.fail("The video stream stopped responding. Press play to retry, or use the full player.");
      } else if (!(e instanceof DOMException && e.name === "AbortError")) {
        this.fail("The video stream was interrupted. Press play to retry, or use the full player.");
      }
    } finally {
      clearTimeout(timer);
      if (gen === this.gen) this.loading = this.starting = false;
    }
  }

  /** An append kept failing (buffer full): reload from the playhead once; failing again without progress is an error. */
  private recover() {
    if (this.recovered) {
      this.fail("The video couldn't be loaded here. Try the full player.");
      return;
    }
    this.recovered = true;
    void this.reloadFrom(this.video.currentTime);
  }

  /** Append one chunk. false = it could not be appended (buffer stayed full); the caller must recover. */
  private async append(chunk: Uint8Array, gen: number): Promise<boolean> {
    const sb = this.sb!;
    for (let attempt = 0; attempt < 30 && gen === this.gen; attempt++) {
      await this.idle();
      try {
        sb.appendBuffer(chunk);
        await this.idle();
        return true;
      } catch (e) {
        if (e instanceof DOMException && e.name === "QuotaExceededError") { await this.evict(true); await sleep(500); continue; }
        throw e;
      }
    }
    return false;
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
