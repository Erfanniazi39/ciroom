# Test media (synthetic)

`media.js` generates every clip with ffmpeg's built-in test sources (`testsrc2` colour bars + `sine` tones). No film,
series or third-party file is used. The clips are made once per `FIXTURE_VERSION` into the OS temp folder
(`ciroom-fixture-clips-v<N>`, ~28 MB, ~20 s) and shared by every run; each test builds its own library folder of hard
links to them (`makeLibrary`), so a test can rename and delete folders freely.

Test files run as parallel processes and each may find the cache missing. Each one then builds the clips in its own
folder (`ciroom-fixture-clips-v<N>.build-<pid>-<time>`) and renames it into place in one step; the first rename wins and
the others delete their copy. Never write into the cache folder directly: on a fresh machine (every GitHub run) that
corrupted clips and failed a random test. Bump `FIXTURE_VERSION` whenever a clip changes.

## Clips

| Clip | What it is | Used to test |
|---|---|---|
| `long.mkv` | 10 min, 160×90 H.264, keyframe every 2 s, two AAC tracks (eng 440 Hz, fre 1200 Hz), two built-in SRT tracks (eng, per) | stream copy, seeking, audio-track choice (told apart by pitch), built-in subtitles, mpv |
| `long.mp4` | 10 min H.264 + AAC, faststart | the MP4 path |
| `short.mkv`, `short20.mkv`, `short30.mkv` | 12 / 20 / 30 s | most movies; different sizes for duplicate/rename rules |
| `ep60.mkv` … `ep67.mkv` | 60–67 s episodes, each a different size and tone | episodes; renames are matched by name + size |
| `hevc10.mkv` | 10 s HEVC 10-bit + Opus | transcoding to 8-bit H.264 |
| `noaudio.mkv` | video only | streams without sound |
| `ac3_51.mkv` | H.264 + AC-3 5.1 | down-mix to AAC stereo |
| `broken.mkv` | 256 KB of the byte 0x5A with a video extension | a corrupted download |
| `en.srt` | English, UTF-8, 140 cues, cue k says "… #k" | external subtitles |
| `fa-utf8.srt` / `fa-utf16.srt` / `fa-cp1256.srt` | Persian in UTF-8, UTF-16 LE (BOM), Windows-1256 | encoding detection and conversion |
| `broken.srt` | binary garbage | the 422 path, language labelling |
| `styled.ass` | ASS with override tags | ASS → WebVTT |

## Layout `LAYOUT_FULL`

Movies: a normal movie with five subtitle files, a release-style folder name, a collection of two, a wrapper folder,
a cd1/cd2 movie, two copies of one movie, a Persian title, quotes/`&`/brackets in a name, HEVC, no audio, 5.1, a
corrupted file, an empty folder, a video without an extension, a loose video directly in `Movies/`.

Series: `S01/EP01` folders with a misplaced file and an empty episode folder, `S02` with a gap, `S01 E01` folders,
a flat folder with `SxxEyy`, a smaller duplicate and `1x03`, absolute numbering (`- 001`), a double episode
(`S01E01E02`), an empty series, a zipped subtitle.

Each test file adds its own small layouts for the case it checks.
