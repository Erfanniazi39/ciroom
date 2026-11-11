# CiRoom — Product & Technical Specification

> Personal, local-first media center for Linux (Windows later).
> Status: **Stage 1 — planning + UI prototype.** Implementation of later stages waits for review.

The app is called **CiRoom** (Cinema Room), renamed from "Marquee". Internal ids still say `marquee` (see project-state.md → Name).

---

## 0. Findings from the real library

Before writing this spec I read the actual `Movies/` and `Series/` folders. I only read them and changed nothing. What's there differs from the idealised structure in the brief in ways that change the design:

| Observation | Example | Consequence |
|---|---|---|
| A series inside `Movies/` | `Movies/Revenge/S01/EP01/…` | Folder type (Movies vs Series) is a **hint, not a rule**. The scanner classifies by structure. |
| A series nested inside another series | `Series/11.22.63 2016/Better Call Saul/S01…` | Series detection must recurse. A child folder with its own season structure is a separate show. |
| Season and episode in one folder | `11.22.63 2016/S01 E01/` | Episode patterns must match `S01 E01`, `S01E01` and `1x01` at any level. |
| Episodes with no season folder | `Dahmer…/EP01/` | Missing season defaults to Season 1. |
| Abbreviated titles | `HIMYM`, `HOTDG` | A TMDB search will fail. These go to the **Needs attention** queue for manual matching (plus a small built-in alias table). |
| Meaningless file names | `S01 E08/VID_20230820_204207.mkv` | Identity comes from the **folder path first**, and the file name only fills gaps. |
| Subtitle names don't match video names | `Lucy.2014.720p.BRRip.YIFY.mp4` + `Lucy.English-WWW.MY-SUBS.CO.srt` | Subtitles attach by **folder proximity**, not by matching names. |
| Junk next to media | `.srt.style`, `.zip` subtitle archives | Ignore unknown extensions. Report zipped subtitles but never extract them automatically. |
| Folders with no video | `Dahmer…/EP01` (0 videos) | Mark as an "empty" item rather than a broken one. |
| 306 mkv vs 4 mp4, 17 `.ass` files | — | **This rules out playback in the webview** (see §6). |
| Drive is NTFS (`ntfs3`) | — | inotify on NTFS is unreliable and the drive can be unmounted. Use scan-on-launch plus manual rescan instead of live watching, and handle a root going offline. |
| Collections with one film | `Harry Potter/Harry Potter 2001` | A collection is a folder of movie folders, even if there's only one. |

---

## 1. Requirements analysis

### 1.1 Missing or unclear requirements (with proposed defaults)

1. **What "identity" means for watch progress.** Progress belongs to the *logical item* (movie or episode), **not the file**. If a file is replaced with a better rip, renamed or moved, history survives. *Default: progress is keyed on `movie_id` / `episode_id`.*
2. **What "watched" means.** *Default: watched when ≥ 90% is played or fewer than 3 minutes remain, whichever comes first. Can be toggled by hand.*
3. **Several video files in one movie folder** (a sample, extras, a second version). *Default: the largest file is the main feature. Files named `sample`, `trailer` or `extras`, or under 100 MB, are treated as extras. Other similar-sized files count as alternate versions, and the user can pick the default.*
4. **Multi-part movies** (`CD1/CD2`, `part1/part2`). *Default: detect them, play them in order and show them as one item.*
5. **Specials / Season 0.** *Default: `S00` and `Specials` folders map to Season 0, shown last.*
6. **Language preferences.** *Default: subtitle language order `en` and audio language order `en`, both configurable.*
7. **Profiles / multiple users.** Not requested, so out of scope. The schema leaves room for a `profile_id` later.
8. **TMDB API key.** TMDB is free but needs a key. *Default: the user pastes their own key in Settings. The app works fully without one, using generated artwork.*
9. **Where app data lives.** *Default: `~/.local/share/marquee/` (database plus image cache). Nothing is ever written next to the media.*
10. **Unavailable drives.** *Default: items on an offline root stay visible with an "Offline" badge and can't be played. Nothing is deleted.*

### 1.2 Technical risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Embedding mpv in a Tauri window on Linux** | High | Don't embed. Run mpv as its own window and control it over JSON IPC (§6). |
| WebKitGTK performance (Tauri on Linux) with heavy `backdrop-filter`, large images and many layers | Medium | Design system limits blur to small surfaces, uses pre-resized thumbnails (w342 posters, w1280 backdrops) and lazy-loads off-screen rows. |
| Fuzzy matching gives wrong TMDB results | Medium | Confidence score, auto-accept only above a threshold, a review queue and a manual "Fix match" dialog. |
| Large-library scan speed on a USB or NTFS disk | Low | Incremental scans compare `(size, mtime)` and only hash when needed. Scans run on a background thread with progress events. |
| Losing user data on rescan | High (to the user) | Scanner never `DELETE`s logical items. It marks files `missing`, and only an explicit "Clean up" does a purge. |

---

## 2. Technology evaluation and architecture

### 2.1 Decisions

| Concern | Choice | Why |
|---|---|---|
| Desktop shell | **Tauri v2** | Small binaries (~10 MB vs ~150 MB for Electron), low memory, a Rust backend that suits a file scanner and SQLite, and good Linux support. Downside: WebKitGTK is slower than Chromium, which the design system accounts for. |
| UI | **React 18 + TypeScript + Vite** | Mature, typed, fast HMR, and huge component ecosystem knowledge. |
| Styling | **Tailwind CSS** + CSS custom properties for design tokens | Tokens live in one place (`index.css`) and Tailwind maps to them, so theming later just swaps variables. |
| Routing | `react-router` with **HashRouter** | Works with Tauri's custom protocol without server rewrites. |
| Client state | **zustand** | Tiny. Used only for UI and session state. The DB is the source of truth. |
| Icons | `lucide-react` | Consistent, tree-shakeable, MIT. |
| Fonts | Bundled via `@fontsource` (Inter, Fraunces) | Must work offline, so no Google Fonts CDN. |
| Database | **SQLite via `rusqlite` (bundled)** + **FTS5** for search | One file, zero setup, transactional, and FTS5 gives instant fuzzy-ish prefix search. Migrations use `PRAGMA user_version`. I'm not adding an ORM. The schema is small and hand-written SQL is clearer. |
| Playback | **mpv (system install) controlled over JSON IPC** | §6. mpv plays everything (mkv, HEVC, DTS, ASS with full styling) and has the best hardware decoding on Linux. |
| Metadata | **TMDB v3 API** (free key) | The brief asks for it. Images are cached locally. |

**Rejected alternatives**
- *Electron*: Chromium still can't play AC3/DTS audio or render ASS subtitles properly, so it doesn't fix playback and costs 10× the size.
- *HTML5 `<video>` in the webview*: on Linux it goes through GStreamer. Codec support depends on what's installed, there's no audio-track switching for mkv, and no ASS styling. With a 99% mkv library it isn't viable.
- *Qt/QML + libmpv* (how Jellyfin Media Player and Haruna work): best embedded playback, but it gives up React and the web design velocity the brief puts first. Worth revisiting only if the separate-window player turns out unacceptable.

### 2.2 Architecture

```
┌──────────────────────── Tauri app ─────────────────────────┐
│  React UI (webview)                                        │
│   pages/ components/  ──►  api/ (typed client)             │
│                              │  invoke() / events          │
│  ────────────────────────────┼──────────────────────────── │
│  Rust core                   ▼                             │
│   commands.rs   (thin layer: validate → call service)      │
│   library/      scanner, classifier, subtitle matcher      │
│   db/           schema, migrations, queries (rusqlite)     │
│   metadata/     TMDB client, matcher, image cache          │
│   player/       mpv process + JSON IPC client              │
└───────────────┬───────────────────────────┬────────────────┘
                │ read-only                 │ unix socket
        Media folders (NTFS)           mpv window
```

Rules:
- **The UI never touches the file system.** Everything goes through `api/`. In Stage 1, `api/` is backed by mock data. In Stage 2 the same function signatures call `invoke()`. Pages don't change.
- **The backend never writes inside library roots.** File access goes through one helper module that opens files read-only. A test asserts this.
- Long jobs (scans, metadata fetches) run on background threads and emit `scan://progress` events.

### 2.3 Project layout

```
marquee/
  docs/SPEC.md
  src/                     React app
    api/                   data access (mock → Tauri)
    components/            reusable UI
    pages/                 screens
    store/                 zustand stores
    lib/                   pure helpers (format, artwork, search)
    types/                 shared domain types
  src-tauri/               (Stage 2) Rust backend
```

---

## 3. Screens and navigation

### 3.1 Navigation model

A slim **left rail** (72 px icons; expands to 220 px with labels on hover or on wide windows):

```
 ◉ CiRoom
 ⌂ Home
 ▣ Movies
 ▤ Series
 ♥ My List
 ─────────
 ⌕ Search  (Ctrl+K)
 ⟳ Library
```

Detail pages, collections and the search palette sit **above** the sections and keep the rail visible. `Esc` or the back button returns to where you were, with scroll position restored.

Routes:

| Route | Screen |
|---|---|
| `/` | Home |
| `/movies` | Movies library |
| `/movies/:id` | Movie detail |
| `/collections/:id` | Collection detail |
| `/series` | Series library |
| `/series/:id?season=N` | Series detail |
| `/my-list` | Favorites + Watchlist |
| `/library` | Library management |
| overlay | Search palette (Ctrl+K, `/`) |
| overlay | Now-playing bar (while mpv runs) |

### 3.2 Screen-by-screen

**Home** is the most important screen.
- *Hero banner*: full-bleed backdrop at 70vh, max 720 px. Rotates through up to 5 featured items every 9 s with a crossfade, and pauses on hover. Featured = in-progress items first, then recent additions, then favorites. Shows the title (display serif), a meta line (year · runtime or seasons · rating · resolution), a 3-line overview, **Play/Resume** (primary), **More info**, **♥**, and progress dots.
- *Rows*, in order, each shown only when non-empty: **Continue Watching** (landscape cards with progress and "S2:E4 · 18 min left"), **Recently Added**, **Recommended for You**, **Favorites**, **Recently Added Movies**, **Recently Added Series**, **Watch Again** (recently finished).
- *Recommendations* are rule-based. Score unwatched items by genre overlap with favorites and recently watched items (genre weight 2, same decade 1, same collection 3), then take the top 15.
- *Empty library state*: a welcome screen with **Add a folder** as the only action.

**Movies library**
- Header: title, count and a sticky filter bar.
- Filters: search text, genre (multi-select), year/decade, status (All · Unwatched · In progress · Watched), resolution (SD/720p/1080p/4K) and a favorites toggle.
- Sort: Recently added (default), Title A–Z, Release year (new→old, old→new), Rating.
- A **Collections** row shows above the grid when no filters are active.
- Grid: 2:3 posters, auto-fill with a min width of 168 px. Hover shows a lift plus an overlay with year, rating and a play button. Watched items get a small check, and in-progress items a progress line.
- No-results state: "No movies match these filters" plus **Clear filters**.

**Series library**: same layout. Status filter is based on episodes (Not started · In progress · Finished). Cards show a "12 / 62" progress badge.

**Movie detail**
- Full-bleed backdrop fading into the page background. Poster on the left (hidden in narrow windows).
- Title, tagline, meta line, genre chips and overview. Director and top-billed cast.
- Actions: **Play** or **Resume 1:12:40** (plus a "Start over" secondary), ♥ Favorite, + Watchlist, ✓ Mark watched, ⋯ (Fix match, Show file, Choose version).
- If the movie belongs to a collection, a "Part of *Zombieland Collection*" row.
- **More like this** row.
- A collapsed **File** section: path, size, resolution, codecs, and the subtitle files found. The player, not this page, is where subtitles are chosen.

**Series detail**
- Same hero treatment, with an **overall progress** bar ("23 of 62 episodes watched").
- Primary action is smart: **Play S1:E1**, **Resume S2:E4**, or **Play next S2:E5**.
- Season selector: horizontal pill tabs (Season 1…N, Specials last).
- Episode list: 16:9 thumbnail, number, title, runtime, 2-line overview, progress bar and a watched toggle. Hovering a thumbnail shows a play icon. Episodes with no file found are dimmed and labeled "Missing".
- ⋯ menu: Fix match, Mark season watched, Mark series watched.

**Collection detail**: backdrop, name, count and the movies in release order as a poster row, with total runtime.

**My List**: tabs for Favorites and Watchlist, each a poster grid with an empty state.

**Search palette (Ctrl+K)**: centered modal with live results grouped as Movies, Series and Episodes, up to 5 each. Matches title, original title, year and episode title. Arrow keys plus Enter to open, `Esc` to close. Recent searches show when the query is empty.

**Library management**
- Library folders: a list showing path, type hint (Movies/Series/Mixed), item count, status (Online/Offline) and last scan. Actions: Add, Remove (removing a folder hides its items; their history is kept for 30 days before purge), Rescan.
- Scan progress: inline progress with the current folder and counts (new / updated / missing).
- **Needs attention**, as tabs:
  - *Unidentified*: low-confidence or failed matches, each with a "Fix match" action.
  - *Missing files*: files that were indexed but are now absent.
  - *Duplicates*: the same logical item found in several places.
  - *Ignored*: things you've dismissed.
- Metadata settings: TMDB key, language, and "Refresh all metadata".

**Now playing (overlay)**: while mpv runs, a floating bar at the bottom of the app shows a thumbnail, title, position and pause / next / stop controls that send commands over IPC. When playback ends, an **Up next** card appears with a 10 s countdown. Autoplay can be turned off.

### 3.3 States every screen must handle
- **Loading**: skeleton shimmer in the shape of the final content, never a spinner on a blank page.
- **Empty**: a short line of copy plus one clear action.
- **Error**: a plain-language message plus Retry. Errors are logged to the app log, not shown as raw stack traces.
- **Offline media**: a dimmed card with an "Offline" badge. Play is disabled with a tooltip.
- **No metadata**: generated artwork from the title, so the UI never shows a broken image.

---

## 4. Design system

### 4.1 Principles
1. **The content is the interface.** Artwork carries the color. Chrome stays neutral and quiet.
2. **Depth through light, not borders.** Separate surfaces with elevation, gradients and spacing. Hairline borders only at `white/6%`.
3. **One accent, used sparingly**: primary actions, focus rings and progress. Nothing else.
4. **Motion confirms, it doesn't decorate.** Short, eased and interruptible.

### 4.2 Color tokens (dark default)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0A0A0D` | App background |
| `--surface-1` | `#121217` | Rail, panels |
| `--surface-2` | `#1A1A21` | Inputs, menus, cards |
| `--surface-3` | `#24242D` | Hover, selected |
| `--line` | `rgb(255 255 255 / .06)` | Hairlines |
| `--fg` | `#F4F4F6` | Primary text |
| `--fg-muted` | `#A3A3AE` | Secondary text |
| `--fg-subtle` | `#6B6B78` | Tertiary text, meta |
| `--accent` | `#F4C15D` (marquee gold) | Primary buttons, progress, focus |
| `--accent-ink` | `#1A1405` | Text on accent |
| `--danger` | `#F26D6D` | Errors |
| `--success` | `#5FD39A` | Watched check, online |

Gold is deliberate. It isn't Netflix red, it's distinct from Plex's orange-yellow, and it fits the theatre-marquee name. It's a single token, so any theme can change it.

### 4.3 Typography
- **UI: Inter Variable**, with tabular numbers for times and counts.
- **Display: Fraunces Variable** (optical-size serif), used only for hero and detail titles. It gives a cinematic, editorial feel that sans-serif streaming UIs don't have.

| Style | Size / line height | Weight |
|---|---|---|
| Display XL (hero title) | `clamp(40px, 5vw, 72px)` / 1.0 | Fraunces 600, tracking −0.02em |
| Display L (detail title) | `clamp(32px, 4vw, 56px)` / 1.05 | Fraunces 600 |
| H2 (row titles) | 20 / 28 | Inter 600 |
| H3 | 16 / 24 | Inter 600 |
| Body | 15 / 24 | Inter 400 |
| Small / meta | 13 / 20 | Inter 500, muted |
| Micro (badges) | 11 / 16 | Inter 600, uppercase, tracking +0.06em |

### 4.4 Spacing, layout, shapes
- 4 px base scale: 4, 8, 12, 16, 24, 32, 48, 64, 96.
- Page gutter: `clamp(24px, 4vw, 64px)`, applied to rows and hero text so everything aligns on one left edge.
- Radii: posters 8 px, cards and inputs 10 px, buttons and pills fully rounded, modals 16 px.
- Posters **2:3**. Row posters 168–200 px wide, scaling with the window. Episode and continue cards **16:9**.
- Elevation: `0 8px 30px -12px rgb(0 0 0 / .6)` at rest, `0 24px 60px -20px rgb(0 0 0 / .8)` on hover.

### 4.5 Components
`Button` (primary / secondary / ghost / icon), `IconButton`, `PosterCard`, `LandscapeCard`, `EpisodeRow`, `Row` (horizontal scroller with edge fades and hover arrows), `Hero`, `DetailHero`, `Artwork` (real image or generated fallback), `ProgressBar`, `Chip`, `Segmented`, `Dropdown`, `SearchPalette`, `EmptyState`, `Skeleton`, `Badge`, `NowPlayingBar`, `Sidebar`.

### 4.6 Motion

| Interaction | Duration | Easing |
|---|---|---|
| Poster hover lift and scale (1.04) | 220 ms | `cubic-bezier(.2,.8,.2,1)` |
| Page enter (fade + 8 px rise) | 280 ms | same |
| Hero crossfade | 900 ms | ease-in-out |
| Modal in / out | 180 / 140 ms | ease-out / ease-in |
| Row scroll by arrow | native smooth scroll | — |

Everything respects `prefers-reduced-motion`. No animation runs longer than 1 s except the hero crossfade.

### 4.7 Generated artwork
When there's no poster, `Artwork` renders a deterministic gradient: hue from a hash of the title, layered radial lights and film grain, with the title set in Fraunces. It looks intentional rather than broken, and makes the UI fully usable offline and before metadata exists.

---

## 5. Database schema (SQLite)

Conventions: `INTEGER PRIMARY KEY`, timestamps are unix seconds UTC, `ON DELETE` rules are explicit, `PRAGMA foreign_keys = ON`, and WAL mode.

```sql
-- ── Library ──────────────────────────────────────────────
CREATE TABLE library_roots (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,         -- absolute
  kind_hint     TEXT NOT NULL CHECK (kind_hint IN ('movies','series','mixed')),
  is_online     INTEGER NOT NULL DEFAULT 1,
  last_scan_at  INTEGER,
  removed_at    INTEGER                       -- soft remove; purge after grace period
);

CREATE TABLE media_files (
  id            INTEGER PRIMARY KEY,
  root_id       INTEGER NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
  rel_path      TEXT NOT NULL,                -- relative to root: survives remounts
  size_bytes    INTEGER NOT NULL,
  mtime         INTEGER NOT NULL,
  quick_hash    TEXT,                         -- xxh3(first 64K + last 64K + size): duplicates & moves
  duration_s    REAL,
  width         INTEGER, height INTEGER,
  video_codec   TEXT, audio_tracks_json TEXT, embedded_subs_json TEXT,
  status        TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present','missing','ignored')),
  role          TEXT NOT NULL DEFAULT 'main'   CHECK (role IN ('main','alt','extra','part')),
  part_index    INTEGER,                      -- CD1/CD2
  movie_id      INTEGER REFERENCES movies(id)   ON DELETE SET NULL,
  episode_id    INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  UNIQUE (root_id, rel_path),
  CHECK (movie_id IS NULL OR episode_id IS NULL)
);
CREATE INDEX idx_files_hash ON media_files(quick_hash);
CREATE INDEX idx_files_movie ON media_files(movie_id);
CREATE INDEX idx_files_episode ON media_files(episode_id);

CREATE TABLE subtitle_files (
  id         INTEGER PRIMARY KEY,
  file_id    INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  root_id    INTEGER NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
  rel_path   TEXT NOT NULL,
  format     TEXT NOT NULL CHECK (format IN ('srt','ass','ssa','vtt','sub')),
  language   TEXT,                          -- ISO 639-1 if detected
  is_sdh     INTEGER NOT NULL DEFAULT 0,
  is_forced  INTEGER NOT NULL DEFAULT 0,
  match_score REAL NOT NULL,                -- how confident the association is
  UNIQUE (file_id, rel_path)
);

-- ── Catalog (logical items; never deleted by a scan) ─────
CREATE TABLE collections (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, overview TEXT,
  tmdb_id INTEGER UNIQUE, source TEXT NOT NULL CHECK (source IN ('folder','tmdb','user')),
  poster_id INTEGER REFERENCES artwork(id), backdrop_id INTEGER REFERENCES artwork(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE movies (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL, original_title TEXT, sort_title TEXT NOT NULL,
  year INTEGER, release_date TEXT, runtime_min INTEGER,
  overview TEXT, tagline TEXT, rating REAL, certification TEXT,
  tmdb_id INTEGER UNIQUE, imdb_id TEXT,
  match_state TEXT NOT NULL DEFAULT 'unmatched'
     CHECK (match_state IN ('unmatched','auto','confirmed','manual','failed')),
  match_confidence REAL,
  locked INTEGER NOT NULL DEFAULT 0,         -- user-corrected: never auto-overwrite
  poster_id INTEGER REFERENCES artwork(id), backdrop_id INTEGER REFERENCES artwork(id),
  added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE collection_items (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  movie_id      INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  PRIMARY KEY (collection_id, movie_id)
);

CREATE TABLE series (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL, original_title TEXT, sort_title TEXT NOT NULL,
  first_air_year INTEGER, last_air_year INTEGER, status TEXT,
  overview TEXT, rating REAL, tmdb_id INTEGER UNIQUE,
  match_state TEXT NOT NULL DEFAULT 'unmatched', match_confidence REAL,
  locked INTEGER NOT NULL DEFAULT 0,
  poster_id INTEGER REFERENCES artwork(id), backdrop_id INTEGER REFERENCES artwork(id),
  added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE seasons (
  id INTEGER PRIMARY KEY,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (number >= 0),   -- 0 = specials
  title TEXT, overview TEXT, poster_id INTEGER REFERENCES artwork(id),
  UNIQUE (series_id, number)
);

CREATE TABLE episodes (
  id INTEGER PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (number >= 0),
  title TEXT, overview TEXT, air_date TEXT, runtime_min INTEGER,
  still_id INTEGER REFERENCES artwork(id),
  added_at INTEGER NOT NULL,
  UNIQUE (season_id, number)
);

-- ── People, genres, artwork ──────────────────────────────
CREATE TABLE genres (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, tmdb_id INTEGER UNIQUE);
CREATE TABLE movie_genres  (movie_id  INTEGER REFERENCES movies(id) ON DELETE CASCADE,
                            genre_id  INTEGER REFERENCES genres(id) ON DELETE CASCADE,
                            PRIMARY KEY (movie_id, genre_id));
CREATE TABLE series_genres (series_id INTEGER REFERENCES series(id) ON DELETE CASCADE,
                            genre_id  INTEGER REFERENCES genres(id) ON DELETE CASCADE,
                            PRIMARY KEY (series_id, genre_id));

CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tmdb_id INTEGER UNIQUE,
                     profile_id INTEGER REFERENCES artwork(id));
CREATE TABLE credits (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  movie_id  INTEGER REFERENCES movies(id) ON DELETE CASCADE,
  series_id INTEGER REFERENCES series(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('cast','director','creator','writer')),
  character TEXT, position INTEGER,
  CHECK ((movie_id IS NULL) <> (series_id IS NULL))
);

CREATE TABLE artwork (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('poster','backdrop','still','profile','logo')),
  source_url TEXT, local_path TEXT,          -- relative to app cache dir
  width INTEGER, height INTEGER,
  dominant_color TEXT,                       -- used to tint hero gradients
  fetched_at INTEGER
);

-- ── User state ───────────────────────────────────────────
CREATE TABLE watch_progress (                -- one row per logical item
  movie_id   INTEGER UNIQUE REFERENCES movies(id)   ON DELETE CASCADE,
  episode_id INTEGER UNIQUE REFERENCES episodes(id) ON DELETE CASCADE,
  position_s REAL NOT NULL DEFAULT 0,
  duration_s REAL,
  watched    INTEGER NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0,
  audio_track TEXT, subtitle_choice TEXT,    -- remembered per item
  updated_at INTEGER NOT NULL,
  CHECK ((movie_id IS NULL) <> (episode_id IS NULL))
);

CREATE TABLE watch_history (                 -- append-only log of sessions
  id INTEGER PRIMARY KEY,
  movie_id INTEGER REFERENCES movies(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL, ended_at INTEGER,
  from_s REAL, to_s REAL, completed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_history_time ON watch_history(started_at DESC);

CREATE TABLE user_list_items (               -- favorites + watchlist
  list TEXT NOT NULL CHECK (list IN ('favorites','watchlist')),
  movie_id INTEGER REFERENCES movies(id) ON DELETE CASCADE,
  series_id INTEGER REFERENCES series(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  CHECK ((movie_id IS NULL) <> (series_id IS NULL)),
  UNIQUE (list, movie_id), UNIQUE (list, series_id)
);

-- ── Scanner bookkeeping ─────────────────────────────────
CREATE TABLE scan_runs (
  id INTEGER PRIMARY KEY, root_id INTEGER REFERENCES library_roots(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL, finished_at INTEGER,
  files_seen INTEGER DEFAULT 0, added INTEGER DEFAULT 0, updated INTEGER DEFAULT 0,
  missing INTEGER DEFAULT 0, error TEXT
);

CREATE TABLE review_items (                  -- "Needs attention"
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('unidentified','low_confidence','duplicate','missing','nested','zipped_subtitle')),
  root_id INTEGER REFERENCES library_roots(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL, detail_json TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','ignored')),
  created_at INTEGER NOT NULL,
  UNIQUE (kind, root_id, rel_path)
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- ── Search ───────────────────────────────────────────────
CREATE VIRTUAL TABLE search_index USING fts5(
  kind UNINDEXED, ref_id UNINDEXED, title, original_title, year, extra,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);
```

**Key decisions**
- **Files and catalog are separate.** `media_files` is "what's on disk" and `movies`/`episodes` are "what it is". Rescans update files and never delete catalog rows, so progress, favorites and corrections survive a drive being unplugged.
- `rel_path` + `root_id`: if the drive mounts at a different path, the user edits one root path and everything reconnects.
- `quick_hash` finds duplicates and detects moves (same hash, new path, so the file row is relinked instead of creating a new item).
- `locked = 1` after a manual correction, so a "Refresh metadata" never overwrites the user's fix.

---

## 6. Video playback

### 6.1 Options evaluated (Linux first)

| Approach | Plays the mkv/ASS library | Wayland | HW decode | Fullscreen | Verdict |
|---|---|---|---|---|---|
| HTML5 `<video>` in WebKitGTK | ✗ (codec lottery, no ASS, no audio-track switch) | ✓ | partial | ✓ | Reject |
| libmpv render API inside the Tauri webview | ✓ | ✗ | ✓ | — | **Not feasible**: WebKitGTK has no way to composite a foreign GL texture into the page |
| mpv embedded via `--wid` into a native child window under a transparent webview | ✓ | **✗ X11 only** | ✓ | fragile | Reject (most distros now default to Wayland) |
| **mpv as a separate window, controlled via JSON IPC** | ✓ | ✓ | ✓ | ✓ native | **Chosen** |
| Qt/QML + libmpv (rewrite the UI in QML) | ✓ | ✓ | ✓ | ✓ | Fallback if the above feels disjointed |

### 6.2 How it works
1. The user clicks **Play**. The backend resolves the file, the resume position, the preferred subtitle and audio track, and (for episodes) the remaining episodes of the season.
2. It spawns `mpv` with:
   ```
   mpv --input-ipc-server=$XDG_RUNTIME_DIR/marquee-mpv.sock
       --fullscreen --force-window=immediate --keep-open=yes
       --hwdec=auto-safe --vo=gpu-next
       --start=<resume_s> --sub-file=<sub> --slang=en --alang=en
       --title="<Title> — CiRoom" --config-dir=<app>/mpv  <file>
   ```
   On Windows the socket becomes a named pipe (`\\.\pipe\marquee-mpv`). Only this spawn call differs per platform.
3. The Rust `player` module connects to the socket and sends `observe_property` for `time-pos`, `duration`, `pause`, `track-list` and `eof-reached`.
4. Progress is written to `watch_progress` every 10 s, on pause, on seek and on exit (debounced), so a crash loses at most 10 s.
5. On end of file: mark watched, then if there's a next episode either load it in the same mpv window (`loadfile`, so there's no window flicker) after the in-app **Up next** countdown, or show an Up Next overlay drawn by a small bundled Lua script inside mpv.
6. The app's **Now Playing bar** reflects the IPC state and can send `cycle pause`, `seek`, `playlist-next` and `quit`.

### 6.3 Player experience
- mpv runs with an **app-owned config directory** (`--config-dir`), so the user's own mpv config doesn't affect it. That directory ships:
  - `mpv.conf` with sane defaults (hardware decoding, gpu-next, nice subtitle font and size, screenshot to app dir off)
  - `input.conf` keyboard shortcuts matching the app (Space, ←/→ ±10 s, ↑/↓ volume, F fullscreen, S cycle subtitles, A cycle audio, `[`/`]` speed, N next episode, Esc exit fullscreen, Q quit and save)
  - a **themed on-screen controller**. Recommendation: bundle [uosc] (a modern mpv OSC with a timeline, track menus, playback speed and chapters) restyled with CiRoom colors. Its license allows bundling with attribution, which I'll confirm before shipping.
- Subtitle selection: external subtitles found by the scanner are passed with `--sub-file` (all of them, best match first). Embedded tracks come from mpv's `track-list`. Both appear in the same menu.
- **Dependency**: mpv must be installed (`sudo apt install mpv`). The app checks for it on startup and shows a friendly setup screen if it's missing. The AppImage and Flatpak builds can bundle it later.

[uosc]: https://github.com/tomasklaen/uosc

---

## 7. Scanner and identification

### 7.1 Pipeline
```
walk roots (walkdir, follow no symlinks, skip hidden & app dirs)
  → collect video files (.mkv .mp4 .avi .m4v .mov .webm .ts .wmv)
    and subtitle files (.srt .ass .ssa .vtt .sub; note .zip as 'zipped_subtitle')
  → incremental check: (rel_path, size, mtime) unchanged → skip
  → classify each folder tree (7.2)
  → parse names (7.3)
  → associate subtitles (7.4)
  → upsert files + catalog in one transaction per root
  → mark unseen files 'missing' (never delete)
  → enqueue metadata matching (Stage 4)
```

### 7.2 Classification by structure (bottom-up)
For every directory, compute a signature from its children:

| Signal | Means |
|---|---|
| Name matches a **season pattern** (`S01`, `Season 1`, `Series 2`, `Specials`) | season folder |
| Name or file matches an **episode pattern** (`S01E02`, `S01 E02`, `1x02`, `EP02`, `E02`, `Episode 2`) | episode |
| Contains season folders or ≥ 2 episode items | **series root** |
| Contains exactly one main video (plus extras and subs), no episode markers | **movie folder** |
| Contains ≥ 1 movie folders and no direct main video | **collection** |

Rules:
1. Bottom-up: classify leaves first, then promote. Episode folders make a season, seasons make a series.
2. **Structure beats the root hint.** `Movies/Revenge/S01/EP01` becomes a series and is flagged *"Series found in Movies folder"* for confirmation.
3. **Nested series**: if a series root contains a child folder that is itself a series root (`11.22.63 2016/Better Call Saul`), the child is a separate series. Flagged *nested* for review.
4. A loose video file directly in a root is a movie, identified from its file name.
5. Missing season (`Dahmer…/EP01`) means Season 1. A season-less episode number in the file name wins over the folder.
6. Title and year come from the **closest meaningful folder name**. For an episode, the series title comes from the series root folder, never the file (`VID_20230820_204207.mkv` stays usable).

### 7.3 Name parsing
Normalization pipeline: replace `._` with spaces, strip bracketed tags (`[YTS.LT]`, `(2019)` → year), remove release tokens (`720p 1080p 2160p BluRay BRRip WEB-DL x264 x265 HEVC DDP5.1 Atmos YIFY Pahe GalaxyRG …`), and remove the trailing year `(19|20)\d{2}` into a separate field.

Key regexes (case-insensitive):
```
episode_full : \bS(\d{1,2})\s*[ ._-]?\s*E(\d{1,3})(?:-?E(\d{1,3}))?\b   (multi-episode S01E01E02)
episode_x    : \b(\d{1,2})x(\d{2,3})\b
season_dir   : ^(?:s|season|series)\s*[ ._-]?(\d{1,2})$   |  ^specials?$ → 0
episode_dir  : ^(?:e|ep|episode)\s*[ ._-]?(\d{1,3})$
year         : (?<!\d)(19[2-9]\d|20[0-4]\d)(?!\d)
resolution   : \b(480|576|720|1080|2160)p\b | \b4k\b
```
`11.22.63` must not be read as a date or episode. The year regex requires 4 digits, and `episode_x` needs an `x`.

Both are unit-tested against every real folder name in this library.

Episode titles before TMDB: taken from subtitle file names when they hold one (`Breaking Bad - S01E02 - Cat's in the Bag....srt` gives "Cat's in the Bag...").

### 7.4 Subtitle association
For each subtitle file, score it against the candidate videos **in the same folder** (or a `Subs/` child):

| Signal | Score |
|---|---|
| Only one video in the folder | +0.6 |
| Same stem as video | +0.4 |
| Same `SxxEyy` as video | +0.4 |
| Shares the parsed title or year | +0.2 |
| Different episode number | −1.0 (reject) |

Attach if score ≥ 0.5. Parse language from tokens (`.en.`, `English`, `eng`, `.fa.`, `Persian`), `SDH`/`HI`/`cc` gives `is_sdh`, and `forced` gives `is_forced`. When several subtitles match, the default picks preferred language, then non-SDH, then `.ass` over `.srt` (ASS keeps styling), then highest score.

### 7.5 Metadata matching (Stage 4)
- Query TMDB `search/movie` or `search/tv` with the parsed title and year.
- Confidence = title similarity (normalized Levenshtein / token set) × 0.7 + year match (exact 0.3, ±1 0.15).
- **≥ 0.85 auto-accept**, 0.6–0.85 accept but flag `low_confidence`, < 0.6 goes to **Unidentified**.
- A small alias table (`HIMYM → How I Met Your Mother`, `HOTD`/`HOTDG → House of the Dragon`, …) runs before search. User fixes are stored per folder, so they survive re-scans.
- Images are downloaded once (posters w500, backdrops w1280, stills w300) into `~/.local/share/marquee/artwork/` and served via Tauri's asset protocol.
- Rate limited (TMDB allows ~40 req/s, we use ≤ 20) and resumable.

### 7.6 Duplicates and missing files
- **Duplicate**: two `main` files linked to the same movie or episode, or the same `quick_hash` at two paths. Shown in Needs attention with both paths, sizes and resolutions. The user chooses which is default, and nothing is deleted.
- **Missing**: file not found on a scan of an *online* root. The item keeps its history and shows "Missing" until the file reappears (same hash elsewhere, so it's relinked automatically).

---

## 8. Roadmap

Each milestone ends with the app runnable and a short demo or checkpoint for your review.

### Stage 1 — Product and UI prototype ✅ *(this delivery)*
- **M1.1** Spec (this document).
- **M1.2** Vite + React + TS + Tailwind scaffold, design tokens, fonts, app shell and rail.
- **M1.3** Core components: Artwork (generated), PosterCard, LandscapeCard, Row, Hero, Button, ProgressBar, Skeleton, EmptyState, Dropdown, Segmented.
- **M1.4** All screens on mock data (modelled on the real library): Home, Movies, Series, Movie/Series/Collection detail, My List, Library management, Search palette, Now Playing bar (simulated).
- **Exit check:** you review the look and the flows in the browser (`npm run dev`).

### Stage 2 — Local library (Rust)
- **M2.1** Tauri v2 shell around the existing UI, plus the `api/` switch from mock to `invoke()`.
- **M2.2** SQLite and migrations, plus a read-only file-access guard test.
- **M2.3** Name parser and classifier, unit-tested against a fixture tree that mirrors *every* real folder in your library.
- **M2.4** Scanner with progress events, incremental rescan, missing detection and subtitle association.
- **M2.5** Library management screen wired up: add/remove roots, scan, Needs attention.
- **Exit check:** your real library shows up correctly with generated artwork.

### Stage 3 — Playback
- **M3.1** mpv detection and setup screen.
- **M3.2** Spawn + IPC client, progress persistence, resume, watched threshold.
- **M3.3** Subtitles (external + embedded), audio track and speed. Bundled mpv config, keys and themed OSC.
- **M3.4** Next episode, Up Next countdown and the Now Playing bar wired up.
- **Exit check:** watch an episode on Wayland with hardware decoding, quit halfway, resume from Continue Watching, and auto-advance to the next episode.

### Stage 4 — Metadata
- **M4.1** TMDB client, settings key and rate limiter.
- **M4.2** Matcher with confidence and the alias table, plus the review queue.
- **M4.3** Artwork cache and dominant-color extraction for hero tinting.
- **M4.4** Fix Match dialog (search, preview, confirm, lock).
- **Exit check:** ≥ 90% of your library is auto-identified, and the rest can be fixed in under a minute each.

### Stage 5 — Polish and release
- FTS5 search, filter and sort performance (virtualized grids if > 1,000 items), transitions, keyboard navigation everywhere, error and offline states, accessibility pass, tests (Rust unit + a Playwright smoke test of the UI), and packaging (`.deb`, AppImage; Windows MSI later).

### After v1 (only once the above is solid)
Custom collections, watch statistics, random pick, theme customization, Windows build.

---

## 9. Open questions for you
1. **Player**: are you OK with mpv opening as its own fullscreen window, with a themed controller? (Recommended. The alternative is a Qt rewrite.)
2. **App name**: keep "CiRoom"?
3. **Accent color**: gold `#F4C15D`, or another color?
4. **Subtitle and audio language order**: English first, then Persian? Anything else?
5. **Code location**: the project currently lives on the media drive (`Movies & Series/marquee`). Building Rust on NTFS works but is slower. I'd suggest moving it to your home directory before Stage 2.
