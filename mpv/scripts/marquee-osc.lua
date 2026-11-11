--[[
  Marquee OSC: the player controls Marquee draws inside mpv.

  Layout (bottom of the screen, shown on mouse move, hidden after a moment of inactivity):

        [hover preview thumbnail + time + chapter]
   0:42  ━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━  -1:03:12     ← seek bar, 80% of the width
         (▶)  ⟲10  ⟳10  ⏭   🔊 ───●──      Title      1×  CC  ⛶  ← controls row

  - Seek bar: purple played part, lighter buffered part, chapter notches, round handle,
    hover highlight, click or drag to seek.
  - Hover preview: frame thumbnails rendered with ffmpeg into $XDG_RUNTIME_DIR and shown via
    overlay-add (cached in 4 s steps).
  - While paused, a large Resume button is shown in the centre.
  - Subtitles are lifted above the controls while they are visible.

  Talks to Marquee with `script-message marquee-next` (Next episode button / N key).
  Options (script-opts): marquee-osc-has_next=yes|no, marquee-osc-accent=RRGGBB,
  marquee-osc-intro_start/intro_end/credits=SECONDS (Skip intro / Skip credits button; CiRoom finds them)
]]

local mp = require "mp"
local utils = require "mp.utils"

local opts = { has_next = false, accent = "8B5CF6", thumbnails = true, intro_start = -1, intro_end = -1, credits = -1 }
require("mp.options").read_options(opts, "marquee-osc")

------------------------------------------------------------------------------------------------
-- Style
------------------------------------------------------------------------------------------------
local function bgr(hex) return hex:sub(5, 6) .. hex:sub(3, 4) .. hex:sub(1, 2) end
local COLOR = {
  accent = bgr(opts.accent),        -- played progress, primary button, active states
  buffered = bgr("C4B5FD"),         -- buffered range (light violet)
  white = "FFFFFF",
  black = "000000",
  panel = bgr("141419"),            -- settings panel background
  danger = bgr("F26D6D"),           -- close button hover
}
local ICON_FONT = "Material Icons Round"
local TEXT_FONT = "Noto Sans"
local HIDE_AFTER = 2.0              -- seconds of mouse inactivity
local SPEEDS = { 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2 }
local THUMB_STEP = 4                -- seconds per cached thumbnail

------------------------------------------------------------------------------------------------
-- State
------------------------------------------------------------------------------------------------
local overlay = mp.create_osd_overlay("ass-events")
local S = {
  visible = false,
  mouse = { x = -1, y = -1, hover = false },
  hover = nil,          -- id of hovered zone
  drag = nil,           -- id of zone being dragged
  drag_value = nil,     -- seek-bar fraction while dragging
  zones = {},
  geo = nil,
  base_sub_margin = nil,
  raised = false,
}
local WIN = package.config:sub(1, 1) == "\\"
local thumb = { dir = (WIN and ((os.getenv("TEMP") or os.getenv("TMP") or ".") .. "\\marquee-thumbs-")
                          or ((os.getenv("XDG_RUNTIME_DIR") or "/tmp") .. "/marquee-thumbs-")) .. utils.getpid(),
                cache = {}, pending = nil, want = nil, shown = nil, w = 0, h = 0, gen = 0 }

------------------------------------------------------------------------------------------------
-- Helpers
------------------------------------------------------------------------------------------------
local function round(v) return math.floor(v + 0.5) end
local function clamp(v, a, b) return math.max(a, math.min(b, v)) end
local function esc(s) return (tostring(s):gsub("\\", "\\\\"):gsub("{", "\\{"):gsub("}", "\\}"):gsub("\n", " ")) end

local function fmt_time(t, long)
  t = math.max(0, math.floor(t or 0))
  local h, m, s = math.floor(t / 3600), math.floor(t / 60) % 60, t % 60
  if h > 0 or long then return string.format("%d:%02d:%02d", h, m, s) end
  return string.format("%d:%02d", m, s)
end

local function prop(name, default)
  local v = mp.get_property_native(name)
  if v == nil then return default end
  return v
end

-- ASS drawing --------------------------------------------------------------------------------
local function fill(c, a) return string.format("\\1c&H%s&\\1a&H%02X&", c, a or 0) end

local function rrect(x, y, w, h, r, c, a)
  x, y, w, h = round(x), round(y), round(w), round(h)
  r = math.min(r or 0, w / 2, h / 2)
  local k = r * 0.5523
  local p
  if r <= 0 then
    p = string.format("m %d %d l %d %d %d %d %d %d", x, y, x + w, y, x + w, y + h, x, y + h)
  else
    p = string.format(
      "m %.1f %d l %.1f %d b %.1f %d %d %.1f %d %.1f l %d %.1f b %d %.1f %.1f %d %.1f %d l %.1f %d b %.1f %d %d %.1f %d %.1f l %d %.1f b %d %.1f %.1f %d %.1f %d",
      x + r, y, x + w - r, y, x + w - r + k, y, x + w, y + r - k, x + w, y + r,
      x + w, y + h - r, x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h,
      x + r, y + h, x + r - k, y + h, x, y + h - r + k, x, y + h - r,
      x, y + r, x, y + r - k, x + r - k, y, x + r, y)
  end
  return string.format("{\\an7\\pos(0,0)\\bord0\\shad0%s\\p1}%s{\\p0}", fill(c, a), p)
end

local function circle(cx, cy, r, c, a) return rrect(cx - r, cy - r, 2 * r, 2 * r, r, c, a) end

local function text(x, y, an, size, str, c, a, font, bold)
  return string.format("{\\an%d\\pos(%d,%d)\\fn%s\\fs%d\\b%d\\bord0\\shad1\\4c&H000000&\\4a&H90&%s}%s",
    an, round(x), round(y), font or TEXT_FONT, round(size), bold and 1 or 0, fill(c or COLOR.white, a), esc(str))
end

local function icon(x, y, size, name, c, a)
  return string.format("{\\an5\\pos(%d,%d)\\fn%s\\fs%d\\bord0\\shad1\\4c&H000000&\\4a&HA0&%s}%s",
    round(x), round(y), ICON_FONT, round(size), fill(c or COLOR.white, a), name)
end

------------------------------------------------------------------------------------------------
-- Player data
------------------------------------------------------------------------------------------------
local function chapters() return prop("chapter-list", {}) end

local function chapter_at(t)
  local found
  for _, c in ipairs(chapters()) do if c.time <= t then found = c else break end end
  if not found or not found.title then return nil end
  -- Many rips have auto-named chapters ("5: 00:41:22.230", "Chapter 5"): not worth showing.
  local title = found.title
  if title:match("^[%d%s:%.%-]+$") or title:match("^[Cc]hapter%s*%d+$") then return nil end
  return title
end

local function buffered_ranges()
  local cache = prop("demuxer-cache-state", nil)
  return (cache and cache["seekable-ranges"]) or {}
end

local function current_sub_label()
  local sid = prop("sid", false)
  if not sid then return "Off" end
  for _, t in ipairs(prop("track-list", {})) do
    if t.type == "sub" and t.id == sid then
      local name = t.title or (t["external-filename"] and t["external-filename"]:match("[^/]+$")) or t.lang or ("Track " .. t.id)
      if #name > 42 then name = name:sub(1, 40) .. "…" end
      return name
    end
  end
  return "On"
end

------------------------------------------------------------------------------------------------
-- Thumbnails (hover preview)
------------------------------------------------------------------------------------------------
local function thumb_remove()
  if thumb.shown then mp.commandv("overlay-remove", "7"); thumb.shown = nil end
end

local render -- forward

local function thumb_request(key)
  thumb.want = key
  if not opts.thumbnails or thumb.w == 0 or thumb.cache[key] or thumb.pending then return end
  local path = mp.get_property("path")
  if not path or path:match("^%a+://") then return end
  local file = string.format("%s/%d-%d-%d.bgra", thumb.dir, thumb.gen, thumb.w, key)
  thumb.pending = key
  local gen = thumb.gen
  mp.command_native_async({
    name = "subprocess", playback_only = false, capture_stdout = true, capture_stderr = true,
    args = { "ffmpeg", "-v", "error", "-nostdin", "-ss", tostring(key), "-i", path, "-frames:v", "1", "-an", "-sn",
             "-vf", string.format("scale=%d:%d,format=bgra", thumb.w, thumb.h), "-f", "rawvideo", "-y", file },
  }, function(ok, res)
    thumb.pending = nil
    if gen ~= thumb.gen then return end -- file changed meanwhile
    if ok and res and res.status == 0 then thumb.cache[key] = file end
    if thumb.want and thumb.want ~= key and not thumb.cache[thumb.want] then thumb_request(thumb.want) end
    if S.visible then render() end
  end)
end

local function thumb_setup()
  thumb.gen = thumb.gen + 1
  thumb.cache, thumb.pending, thumb.want = {}, nil, nil
  thumb_remove()
  local vp = prop("video-params", nil)
  local _, oh = mp.get_osd_size()
  if not vp or not vp.dw or vp.dw == 0 or not oh or oh == 0 then thumb.w = 0; return end
  local scale = clamp(oh / 1080, 0.7, 2)
  thumb.w = math.floor(260 * scale / 2) * 2
  thumb.h = math.floor(thumb.w * vp.dh / vp.dw / 2) * 2
  mp.command_native({ name = "subprocess", playback_only = false,
    args = WIN and { "cmd", "/d", "/c", "mkdir", thumb.dir } or { "mkdir", "-p", thumb.dir } }) -- Windows: an error if it exists is fine
end

------------------------------------------------------------------------------------------------
-- Subtitles: lift them above the controls while the controls are visible
------------------------------------------------------------------------------------------------
local function raise_subs(on)
  if S.base_sub_margin == nil then S.base_sub_margin = prop("sub-margin-y", 22) end
  if on == S.raised or not S.geo then return end
  S.raised = on
  local _, h = mp.get_osd_size()
  if not h or h == 0 then return end
  -- clear the seek bar + handle + room for descenders/outline of the subtitle's last line
  local lift = (h - S.geo.bar_y + 46 * S.geo.s) * 720 / h
  mp.set_property_number("sub-margin-y", on and round(math.max(S.base_sub_margin, lift)) or S.base_sub_margin)
end

-- While the user points at / drags the seek bar, subtitles would collide with the preview:
-- hide them for that moment only, then restore the previous state.
local function preview_hides_subs(on)
  if on and not S.subs_hidden then
    S.subs_prev = prop("sub-visibility", true)
    S.subs_hidden = true
    if S.subs_prev then mp.set_property_native("sub-visibility", false) end
  elseif not on and S.subs_hidden then
    S.subs_hidden = false
    if S.subs_prev then mp.set_property_native("sub-visibility", true) end
  end
end

------------------------------------------------------------------------------------------------
-- Rendering
------------------------------------------------------------------------------------------------
local function zone(id, x1, y1, x2, y2, t) t.id, t.x1, t.y1, t.x2, t.y2 = id, x1, y1, x2, y2; S.zones[#S.zones + 1] = t end

local function zone_at(x, y)
  for i = #S.zones, 1, -1 do
    local z = S.zones[i]
    if x >= z.x1 and x <= z.x2 and y >= z.y1 and y <= z.y2 then return z end
  end
end

local function find_zone(id) for _, z in ipairs(S.zones) do if z.id == id then return z end end end

local function button(out, id, cx, cy, size, name, t)
  local hovered = S.hover == id
  if t.primary then
    out[#out + 1] = circle(cx, cy, size / 2 + (hovered and 2 or 0), COLOR.accent, 0)
  elseif hovered or t.active_bg then
    out[#out + 1] = circle(cx, cy, size / 2, COLOR.white, hovered and 0xD9 or 0xE6)
  end
  out[#out + 1] = icon(cx, cy, size * (t.icon_scale or 0.62), name, t.color or COLOR.white, t.alpha or 0)
  zone(id, cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2, t)
end

------------------------------------------------------------------------------------------------
-- Settings menu (right-click anywhere, or the gear button)
------------------------------------------------------------------------------------------------
local SUB_SIZES = { 0.75, 0.9, 1, 1.15, 1.3, 1.5 }

local function track_label(t)
  local name = t.title or (t["external-filename"] and t["external-filename"]:match("[^/]+$")) or nil
  local lang = t.lang
  local parts = {}
  if name then parts[#parts + 1] = name elseif lang then parts[#parts + 1] = lang:upper() else parts[#parts + 1] = "Track " .. t.id end
  if name and lang then parts[#parts + 1] = lang:upper() end
  if t.type == "audio" and t["demux-channel-count"] then parts[#parts + 1] = t["demux-channel-count"] .. "ch" end
  local label = table.concat(parts, " · ")
  if #label > 40 then label = label:sub(1, 38) .. "…" end
  return label, (t.external and "File" or ((t.codec or ""):upper():gsub("HDMV_PGS_SUBTITLE", "PGS"):gsub("SUBRIP", "SRT")))
end

local function tracks(kind)
  local list = {}
  for _, t in ipairs(prop("track-list", {})) do if t.type == kind then list[#list + 1] = t end end
  return list
end

local function selected_label(kind)
  for _, t in ipairs(tracks(kind)) do if t.selected then return (track_label(t)) end end
  return "Off"
end

local function fmt_delay(v)
  v = v or 0
  if math.abs(v) < 0.05 then return "0.0 s" end
  return string.format("%s%.1f s", v > 0 and "+" or "−", math.abs(v))
end
local function fmt_speed(v) return math.abs(v - 1) < 0.001 and "Normal" or (string.format("%g", v) .. "×") end
local function fmt_size(v) return math.abs(v - 1) < 0.001 and "Default" or string.format("%d%%", round(v * 100)) end

local function menu_close()
  if not S.menu then return end
  S.menu = nil
  mp.remove_key_binding("marquee-osc-esc")
end

local function menu_open(mode, ax, ay)
  S.menu = { page = "main", mode = mode, ax = ax, ay = ay }
  mp.add_forced_key_binding("ESC", "marquee-osc-esc", function()
    if S.menu and S.menu.page ~= "main" then S.menu.page = "main" else menu_close() end
    render()
  end)
end

local function draw_menu(out, w, h, s)
  local m = S.menu
  local pw, rh, hh, pad = 380 * s, 46 * s, 50 * s, 8 * s
  local rows, title = {}, "Settings"
  local sid_on = prop("sid", false) and true or false

  if m.page == "main" then
    rows = {
      { icon = "subtitles", label = "Subtitles", value = sid_on and selected_label("sub") or "Off", go = "subs" },
      { icon = "timer", label = "Subtitle timing", value = fmt_delay(prop("sub-delay", 0)), go = "delay" },
      { icon = "format_size", label = "Subtitle size", value = fmt_size(prop("sub-scale", 1)), go = "size" },
      { icon = "audiotrack", label = "Audio", value = selected_label("audio"), go = "audio" },
      { icon = "speed", label = "Playback speed", value = fmt_speed(prop("speed", 1)), go = "speed" },
    }
  elseif m.page == "subs" then
    title = "Subtitles"
    rows[#rows + 1] = { label = "Off", selected = not sid_on, act = function() mp.set_property("sid", "no") end }
    for _, t in ipairs(tracks("sub")) do
      local label, hint = track_label(t)
      rows[#rows + 1] = { label = label, hint = hint, selected = t.selected, act = function()
        mp.set_property_number("sid", t.id); mp.set_property_native("sub-visibility", true); S.subs_hidden = false
      end }
    end
  elseif m.page == "audio" then
    title = "Audio"
    for _, t in ipairs(tracks("audio")) do
      local label, hint = track_label(t)
      rows[#rows + 1] = { label = label, hint = hint, selected = t.selected, act = function() mp.set_property_number("aid", t.id) end }
    end
    if #rows == 0 then rows[1] = { label = "No audio tracks", disabled = true } end
  elseif m.page == "speed" then
    title = "Playback speed"
    local cur = prop("speed", 1)
    for _, v in ipairs(SPEEDS) do
      rows[#rows + 1] = { label = fmt_speed(v), selected = math.abs(v - cur) < 0.001, act = function() mp.set_property_number("speed", v) end }
    end
  elseif m.page == "size" then
    title = "Subtitle size"
    local cur = prop("sub-scale", 1)
    for _, v in ipairs(SUB_SIZES) do
      rows[#rows + 1] = { label = fmt_size(v), selected = math.abs(v - cur) < 0.001, act = function() mp.set_property_number("sub-scale", v) end }
    end
  elseif m.page == "delay" then
    title = "Subtitle timing"
  end

  local body_h = m.page == "delay" and (190 * s) or (#rows * rh)
  local ph = hh + body_h + pad * 2
  local px, py
  if m.mode == "above" then px, py = m.ax - pw, m.ay - ph
  else px, py = m.ax, m.ay; if px + pw > w - 12 * s then px = m.ax - pw end; if py + ph > h - 12 * s then py = m.ay - ph end end
  px, py = clamp(px, 12 * s, w - pw - 12 * s), clamp(py, 12 * s, h - ph - 12 * s)

  -- panel
  out[#out + 1] = rrect(px - 1, py - 1, pw + 2, ph + 2, 15 * s, COLOR.white, 0xE4)
  out[#out + 1] = rrect(px, py, pw, ph, 14 * s, COLOR.panel, 0x08)
  zone("menu-panel", px, py, px + pw, py + ph, { menu = true })

  -- header
  local hy = py + pad + hh / 2
  if m.page ~= "main" then
    local hov = S.hover == "menu-back"
    if hov then out[#out + 1] = circle(px + pad + 22 * s, hy, 18 * s, COLOR.white, 0xE0) end
    out[#out + 1] = icon(px + pad + 22 * s, hy, 24 * s, "arrow_back", COLOR.white, 0)
    zone("menu-back", px + pad, hy - 20 * s, px + pad + 44 * s, hy + 20 * s, { menu = true, click = function() m.page = "main" end })
    out[#out + 1] = text(px + pad + 52 * s, hy, 4, 21 * s, title, COLOR.white, 0, nil, true)
  else
    out[#out + 1] = icon(px + pad + 22 * s, hy, 22 * s, "settings", COLOR.white, 0x40)
    out[#out + 1] = text(px + pad + 46 * s, hy, 4, 21 * s, title, COLOR.white, 0, nil, true)
  end
  out[#out + 1] = rrect(px + pad, py + pad + hh, pw - pad * 2, 1, 0, COLOR.white, 0xE8)

  local y = py + pad + hh
  if m.page == "delay" then
    local d = prop("sub-delay", 0)
    out[#out + 1] = text(px + pw / 2, y + 40 * s, 5, 36 * s, fmt_delay(d), math.abs(d) >= 0.05 and COLOR.accent or COLOR.white, 0, nil, true)
    local steps = { { -0.5, "−0.5" }, { -0.1, "−0.1" }, { 0.1, "+0.1" }, { 0.5, "+0.5" } }
    local bw, bh, gap = (pw - pad * 2 - 3 * 8 * s) / 4, 40 * s, 8 * s
    for i, st in ipairs(steps) do
      local bx = px + pad + (i - 1) * (bw + gap)
      local by = y + 76 * s
      local id = "menu-step-" .. i
      out[#out + 1] = rrect(bx, by, bw, bh, 10 * s, COLOR.white, S.hover == id and 0xC8 or 0xE4)
      out[#out + 1] = text(bx + bw / 2, by + bh / 2, 5, 19 * s, st[2], COLOR.white, 0, nil, true)
      zone(id, bx, by, bx + bw, by + bh, { menu = true, click = function()
        mp.set_property_number("sub-delay", round((prop("sub-delay", 0) + st[1]) * 10) / 10)
      end })
    end
    out[#out + 1] = text(px + pad + 4 * s, y + 146 * s, 4, 18 * s, "Text too early → +    too late → −", COLOR.white, 0x40)
    out[#out + 1] = text(px + pad + 4 * s, y + 168 * s, 4, 18 * s, "Also: Z / X keys. Remembered for this title.", COLOR.white, 0x60)
    if math.abs(d) >= 0.05 then
      local rx2 = px + pw - pad - 4 * s
      local hov = S.hover == "menu-reset"
      out[#out + 1] = text(rx2, y + 157 * s, 6, 18 * s, "Reset", hov and COLOR.accent or COLOR.white, 0, nil, true)
      zone("menu-reset", rx2 - 70 * s, y + 140 * s, rx2, y + 174 * s, { menu = true, click = function() mp.set_property_number("sub-delay", 0) end })
    end
    return
  end

  for i, r in ipairs(rows) do
    local ry = y + pad / 2 + (i - 1) * rh
    local id = "menu-row-" .. i
    local hov = S.hover == id and not r.disabled
    if hov then out[#out + 1] = rrect(px + pad, ry, pw - pad * 2, rh, 9 * s, COLOR.white, 0xE2) end
    local cy = ry + rh / 2
    local lx = px + pad + 14 * s
    if m.page == "main" then
      out[#out + 1] = icon(lx + 10 * s, cy, 22 * s, r.icon, COLOR.white, 0x30)
      out[#out + 1] = text(lx + 32 * s, cy, 4, 19 * s, r.label, COLOR.white, 0, nil, true)
      out[#out + 1] = icon(px + pw - pad - 18 * s, cy, 22 * s, "chevron_right", COLOR.white, 0x70)
      local v = r.value or ""
      if #v > 18 then v = v:sub(1, 17) .. "…" end
      out[#out + 1] = text(px + pw - pad - 34 * s, cy, 6, 17 * s, v, COLOR.white, 0x60)
      zone(id, px + pad, ry, px + pw - pad, ry + rh, { menu = true, click = function() m.page = r.go end })
    else
      if r.selected then out[#out + 1] = icon(lx + 10 * s, cy, 22 * s, "check", COLOR.accent, 0) end
      out[#out + 1] = text(lx + 32 * s, cy, 4, 19 * s, r.label, COLOR.white, r.disabled and 0x80 or 0, nil, r.selected)
      if r.hint and r.hint ~= "" then out[#out + 1] = text(px + pw - pad - 12 * s, cy, 6, 14 * s, r.hint, COLOR.white, 0x80, nil, true) end
      if not r.disabled then
        zone(id, px + pad, ry, px + pw - pad, ry + rh, { menu = true, click = function() if r.act then r.act() end end })
      end
    end
  end
end

-- Skip intro / Skip credits ------------------------------------------------------------------
local function skip_state()
  local pos = prop("time-pos", 0) or 0
  local dur = prop("duration", 0) or 0
  if opts.intro_start >= 0 and opts.intro_end > opts.intro_start and pos >= opts.intro_start and pos < opts.intro_end - 1 then
    return "intro", "Skip intro"
  end
  if opts.credits > 0 and pos >= opts.credits and (dur == 0 or pos < dur - 2) then
    return "credits", opts.has_next and "Next episode" or "Skip credits"
  end
end

local function do_skip()
  local kind = skip_state()
  if kind == "intro" then mp.commandv("seek", tostring(opts.intro_end), "absolute")
  elseif kind == "credits" then
    if opts.has_next then mp.commandv("script-message", "marquee-next")
    else mp.commandv("seek", tostring(math.max(0, (prop("duration", 0) or 0) - 1)), "absolute") end
  end
end

-- A white pill bottom-right, shown while the intro/credits play even when the controls are hidden.
local function draw_skip(out, w, h, s, controls_visible)
  local kind, label = skip_state()
  if not kind then return end
  local bw, bh = (#label * 9.5 + 66) * s, 54 * s
  local x = w - bw - w * 0.04
  local y = controls_visible and (h - 190 * s) or (h - bh - h * 0.08)
  local hov = S.hover == "skip"
  out[#out + 1] = rrect(x, y, bw, bh, bh / 2, COLOR.white, hov and 0 or 0x0A)
  out[#out + 1] = icon(x + 30 * s, y + bh / 2, 28 * s, kind == "intro" and "fast_forward" or "skip_next", COLOR.black, 0)
  out[#out + 1] = text(x + 50 * s, y + bh / 2, 4, 21 * s, label, COLOR.black, 0, nil, true)
  zone("skip", x, y, x + bw, y + bh, { click = do_skip, tip = label .. " (S)" })
end

render = function()
  local w, h = mp.get_osd_size()
  if not w or w == 0 then return end
  S.zones = {}
  local out = {}

  if not S.visible then
    preview_hides_subs(false)
    local s0 = clamp(h / 1080, 0.7, 2)
    draw_skip(out, w, h, s0, false)
    overlay.res_x, overlay.res_y = w, h
    overlay.data = table.concat(out, "\n")
    overlay:update()
    thumb_remove()
    return
  end

  local s = clamp(h / 1080, 0.7, 2)
  local dur = prop("duration", 0) or 0
  local pos = prop("time-pos", 0) or 0
  local paused = prop("pause", false)
  local muted = prop("mute", false)
  local volume = prop("volume", 100)
  local speed = prop("speed", 1)
  local subs_visible = S.subs_hidden and S.subs_prev or (not S.subs_hidden and prop("sub-visibility", true))
  local subs_on = subs_visible and prop("sid", false)
  local fs = prop("fullscreen", false)

  local bar_x, bar_w = w * 0.10, w * 0.80
  local bar_y = h - 104 * s
  local row_y = h - 48 * s
  S.geo = { s = s, bar_y = bar_y }

  -- Bottom scrim (stacked bands = soft gradient) ---------------------------------------------
  local scrim_h = 270 * s
  local bands = 18
  for i = 0, bands - 1 do
    local y = h - scrim_h + i * scrim_h / bands
    local f = (i + 1) / bands
    local a = round(255 - (f ^ 1.6) * 200)                -- 0xFF (clear) → 0x37 (≈80% black), eased
    out[#out + 1] = rrect(0, y, w, scrim_h / bands + 1, 0, COLOR.black, a)
  end

  -- Seek bar ---------------------------------------------------------------------------------
  local hovering_bar = S.hover == "seek" or S.drag == "seek"
  local th = (hovering_bar and 6 or 4) * s                  -- track thickness
  local ty = bar_y - th / 2
  local frac = dur > 0 and clamp(pos / dur, 0, 1) or 0
  if S.drag == "seek" and S.drag_value then frac = S.drag_value end

  out[#out + 1] = rrect(bar_x, ty, bar_w, th, th / 2, COLOR.white, 0xB0)                 -- track
  if dur > 0 then
    for _, r in ipairs(buffered_ranges()) do                                              -- buffered
      local a, b = clamp(r.start / dur, 0, 1), clamp(r["end"] / dur, 0, 1)
      if b > a then out[#out + 1] = rrect(bar_x + a * bar_w, ty, (b - a) * bar_w, th, th / 2, COLOR.buffered, 0x70) end
    end
  end
  local hover_frac
  if hovering_bar and S.mouse.x >= bar_x then
    hover_frac = clamp((S.mouse.x - bar_x) / bar_w, 0, 1)
    if hover_frac > frac then
      out[#out + 1] = rrect(bar_x, ty, hover_frac * bar_w, th, th / 2, COLOR.white, 0x90)   -- hover preview fill
    end
  end
  out[#out + 1] = rrect(bar_x, ty, math.max(th, frac * bar_w), th, th / 2, COLOR.accent, 0) -- played
  if dur > 0 then                                                                         -- chapter markers
    for _, c in ipairs(chapters()) do
      if c.time > 1 and c.time < dur - 1 then
        local cx = bar_x + c.time / dur * bar_w
        out[#out + 1] = rrect(cx - 1.5 * s, ty - 1, 3 * s, th + 2, 0, COLOR.black, 0x50)
      end
    end
  end
  local hr = (hovering_bar and 9 or 7) * s                                                  -- handle
  local hx = bar_x + frac * bar_w
  out[#out + 1] = circle(hx, bar_y, hr + 3 * s, COLOR.accent, 0x60)
  out[#out + 1] = circle(hx, bar_y, hr, COLOR.white, 0)
  zone("seek", bar_x - 8 * s, bar_y - 16 * s, bar_x + bar_w + 8 * s, bar_y + 16 * s, {
    drag = function(x, final)
      if dur <= 0 then return end
      local f = clamp((x - bar_x) / bar_w, 0, 1)
      S.drag_value = f
      mp.commandv("seek", tostring(f * dur), final and "absolute+exact" or "absolute+keyframes")
    end,
  })

  -- Timestamps
  out[#out + 1] = text(bar_x - 18 * s, bar_y, 6, 22 * s, fmt_time(frac * dur, dur >= 3600), COLOR.white, 0, nil, true)
  out[#out + 1] = text(bar_x + bar_w + 18 * s, bar_y, 4, 22 * s, "-" .. fmt_time(dur - frac * dur, dur >= 3600), COLOR.white, 0x30, nil, true)

  -- Controls row ----------------------------------------------------------------------------
  local x = bar_x
  local big, btn = 52 * s, 42 * s
  button(out, "play", x + big / 2, row_y, big, paused and "play_arrow" or "pause",
    { primary = true, icon_scale = 0.66, tip = paused and "Play (Space)" or "Pause (Space)", click = function() mp.commandv("cycle", "pause") end })
  x = x + big + 14 * s
  button(out, "back", x + btn / 2, row_y, btn, "replay_10", { tip = "Back 10 s (←)", click = function() mp.commandv("seek", "-10") end })
  x = x + btn + 6 * s
  button(out, "fwd", x + btn / 2, row_y, btn, "forward_10", { tip = "Forward 10 s (→)", click = function() mp.commandv("seek", "10") end })
  x = x + btn + 6 * s
  if opts.has_next then
    button(out, "next", x + btn / 2, row_y, btn, "skip_next", { tip = "Next episode (N)", click = function() mp.commandv("script-message", "marquee-next") end })
    x = x + btn + 6 * s
  end
  x = x + 10 * s
  local vol_icon = (muted or volume == 0) and "volume_off" or (volume < 50 and "volume_down" or "volume_up")
  button(out, "mute", x + btn / 2, row_y, btn, vol_icon, { tip = muted and "Unmute (M)" or "Mute (M)", click = function() mp.commandv("cycle", "mute") end })
  x = x + btn + 8 * s
  -- volume slider
  local vw, vth = 120 * s, 4 * s
  local vfrac = muted and 0 or clamp(volume / 100, 0, 1)
  local vhover = S.hover == "volume" or S.drag == "volume"
  out[#out + 1] = rrect(x, row_y - vth / 2, vw, vth, vth / 2, COLOR.white, 0xB0)
  out[#out + 1] = rrect(x, row_y - vth / 2, math.max(vth, vfrac * vw), vth, vth / 2, COLOR.accent, 0)
  out[#out + 1] = circle(x + vfrac * vw, row_y, (vhover and 7 or 6) * s, COLOR.white, 0)
  if vhover then out[#out + 1] = text(x + vw + 12 * s, row_y, 4, 18 * s, string.format("%d%%", round(muted and 0 or volume)), COLOR.white, 0x40, nil, true) end
  local vx = x
  zone("volume", vx - 6 * s, row_y - 14 * s, vx + vw + 6 * s, row_y + 14 * s, {
    drag = function(mx)
      local v = clamp((mx - vx) / vw, 0, 1) * 100
      mp.set_property_number("volume", round(v))
      if muted and v > 0 then mp.set_property_native("mute", false) end
    end,
  })
  local left_end = x + vw + 60 * s

  -- right group (from the right edge of the bar)
  local rx = bar_x + bar_w
  button(out, "fullscreen", rx - btn / 2, row_y, btn, fs and "fullscreen_exit" or "fullscreen",
    { tip = fs and "Exit fullscreen (F)" or "Fullscreen (F)", click = function() mp.commandv("cycle", "fullscreen") end })
  rx = rx - btn - 6 * s
  button(out, "subs", rx - btn / 2, row_y, btn, subs_on and "closed_caption" or "closed_caption_disabled", {
    color = subs_on and COLOR.white or COLOR.white, alpha = subs_on and 0 or 0x60,
    tip = "Subtitles: " .. (subs_on and current_sub_label() or "Off") .. "  ·  right-click: next track",
    click = function()
      if not prop("sid", false) then mp.commandv("cycle", "sub"); mp.set_property_native("sub-visibility", true)
      else mp.commandv("cycle", "sub-visibility") end
      S.subs_hidden = false
    end,
    rclick = function() mp.commandv("cycle", "sub") end,
  })
  if subs_on then out[#out + 1] = rrect(rx - btn / 2 - 9 * s, row_y + 14 * s, 18 * s, 2.5 * s, 1.2 * s, COLOR.accent, 0) end
  rx = rx - btn - 6 * s
  local gear_rx = rx
  button(out, "settings", rx - btn / 2, row_y, btn, "settings", {
    active_bg = S.menu ~= nil, tip = "Settings (right-click anywhere)",
    click = function() if S.menu then menu_close() else menu_open("above", gear_rx, row_y - 30 * s) end end,
  })
  rx = rx - btn - 10 * s
  -- speed pill
  local speed_label = (math.abs(speed - math.floor(speed)) < 0.001 and string.format("%d×", speed) or string.format("%g×", speed))
  local pw, ph = 64 * s, 32 * s
  local shover = S.hover == "speed"
  out[#out + 1] = rrect(rx - pw, row_y - ph / 2, pw, ph, ph / 2, speed ~= 1 and COLOR.accent or COLOR.white, speed ~= 1 and 0x20 or (shover and 0xC8 or 0xDE))
  out[#out + 1] = text(rx - pw / 2, row_y, 5, 19 * s, speed_label, COLOR.white, 0, nil, true)
  zone("speed", rx - pw, row_y - ph / 2, rx, row_y + ph / 2, {
    tip = "Playback speed  ·  click: faster  ·  right-click: normal",
    click = function()
      local nxt = SPEEDS[1]
      for _, v in ipairs(SPEEDS) do if v > speed + 0.001 then nxt = v; break end end
      mp.set_property_number("speed", nxt)
    end,
    rclick = function() mp.set_property_number("speed", 1) end,
  })
  local right_start = rx - pw - 30 * s

  -- Top bar: title + close --------------------------------------------------------------------
  local top_h = 150 * s
  for i = 0, 11 do
    local f = 1 - i / 12
    out[#out + 1] = rrect(0, i * top_h / 12, w, top_h / 12 + 1, 0, COLOR.black, round(255 - (f ^ 1.6) * 170))
  end
  local title = prop("media-title", "")
  local max_chars = math.floor((w - 220 * s) / (13 * s))
  if #title > max_chars then title = title:sub(1, math.max(1, max_chars - 1)) .. "…" end
  out[#out + 1] = text(bar_x, 52 * s, 4, 28 * s, title, COLOR.white, 0, nil, true)
  local cx2, cy2, cr = w - bar_x + 0 * s - 26 * s, 52 * s, 26 * s
  local chov = S.hover == "close"
  out[#out + 1] = circle(cx2, cy2, cr, chov and COLOR.danger or COLOR.white, chov and 0 or 0xDC)
  out[#out + 1] = icon(cx2, cy2, 28 * s, "close", COLOR.white, 0)
  zone("close", cx2 - cr, cy2 - cr, cx2 + cr, cy2 + cr, { tip = "Close player (Q) · your place is saved", tip_below = true, click = function() mp.commandv("quit") end })

  -- Big Resume button in the centre while paused ----------------------------------------------
  if paused then
    local r = 52 * s
    local hov = S.hover == "resume"
    out[#out + 1] = circle(w / 2, h / 2, r + (hov and 4 or 0), COLOR.black, 0x70)
    out[#out + 1] = circle(w / 2, h / 2, r - 6 * s + (hov and 4 or 0), COLOR.accent, 0)
    out[#out + 1] = icon(w / 2, h / 2, 64 * s, "play_arrow", COLOR.white, 0)
    out[#out + 1] = text(w / 2, h / 2 + r + 28 * s, 5, 22 * s, "Resume", COLOR.white, 0, nil, true)
    zone("resume", w / 2 - r, h / 2 - r, w / 2 + r, h / 2 + r, { click = function() mp.set_property_native("pause", false) end })
  end

  -- Hover preview over the seek bar --------------------------------------------------------------
  if S.menu then hover_frac = nil end
  preview_hides_subs(hover_frac ~= nil or S.drag == "seek")
  local want_thumb
  if hover_frac and dur > 0 then
    local t = hover_frac * dur
    local cx = bar_x + hover_frac * bar_w
    local chap = chapter_at(t)
    local label = fmt_time(t, dur >= 3600)
    local tw, tht = thumb.w, thumb.h
    local key = math.floor(t / THUMB_STEP) * THUMB_STEP
    thumb_request(key)
    local has_img = thumb.cache[key] ~= nil
    local box_w = has_img and tw or math.max(90 * s, (#label * 12 + 24) * s)
    local box_x = clamp(cx - box_w / 2, 8 * s, w - box_w - 8 * s)
    local label_h = 30 * s
    local img_h = has_img and tht or 0
    local box_y = bar_y - 22 * s - label_h - img_h - (chap and 24 * s or 0)
    if has_img then
      out[#out + 1] = rrect(box_x - 3 * s, box_y - 3 * s, tw + 6 * s, tht + 6 * s, 10 * s, COLOR.black, 0x30)
      out[#out + 1] = rrect(box_x - 2 * s, box_y - 2 * s, tw + 4 * s, tht + 4 * s, 9 * s, COLOR.accent, 0)
      want_thumb = { file = thumb.cache[key], x = round(box_x), y = round(box_y) }
    end
    local ly = box_y + img_h + 6 * s
    if chap then
      out[#out + 1] = text(box_x + box_w / 2, ly + 10 * s, 5, 17 * s, chap, COLOR.white, 0x20, nil, true)
      ly = ly + 24 * s
    end
    local pill_w = (#label * 11 + 22) * s
    out[#out + 1] = rrect(box_x + box_w / 2 - pill_w / 2, ly, pill_w, label_h - 4 * s, (label_h - 4 * s) / 2, COLOR.black, 0x30)
    out[#out + 1] = text(box_x + box_w / 2, ly + (label_h - 4 * s) / 2, 5, 19 * s, label, COLOR.white, 0, nil, true)
  end

  -- Tooltip for hovered button ----------------------------------------------------------------
  local hz = S.hover and find_zone(S.hover)
  if hz and hz.tip and not S.drag and not S.menu then
    local tip = hz.tip
    local tw = (#tip * 9.2 + 24) * s
    local tx = clamp((hz.x1 + hz.x2) / 2 - tw / 2, 8 * s, w - tw - 8 * s)
    local ty2 = hz.tip_below and (hz.y2 + 10 * s) or (hz.y1 - 42 * s)
    out[#out + 1] = rrect(tx, ty2, tw, 32 * s, 8 * s, COLOR.black, 0x28)
    out[#out + 1] = text(tx + tw / 2, ty2 + 16 * s, 5, 17 * s, tip, COLOR.white, 0, nil, false)
  end

  if not S.menu then draw_skip(out, w, h, s, true) end
  if S.menu then draw_menu(out, w, h, s) end

  overlay.res_x, overlay.res_y = w, h
  overlay.data = table.concat(out, "\n")
  overlay:update()

  -- Thumbnail image (overlay-add draws raw BGRA on top of the OSD)
  if want_thumb then
    local id = want_thumb.file .. "@" .. want_thumb.x .. "," .. want_thumb.y
    if thumb.shown ~= id then
      mp.commandv("overlay-add", "7", tostring(want_thumb.x), tostring(want_thumb.y), want_thumb.file, "0", "bgra",
        tostring(thumb.w), tostring(thumb.h), tostring(thumb.w * 4))
      thumb.shown = id
    end
  else
    thumb_remove()
  end
end

------------------------------------------------------------------------------------------------
-- Visibility
------------------------------------------------------------------------------------------------
local tick = mp.add_periodic_timer(0.2, function() render() end)
tick:kill()

local hide_timer
local function in_controls_area()
  local _, h = mp.get_osd_size()
  return S.mouse.hover and h and S.mouse.y > h - 240 * clamp(h / 1080, 0.7, 2)
end

local function hide()
  if prop("pause", false) or S.drag or S.menu or in_controls_area() then hide_timer:kill(); hide_timer:resume(); return end
  S.visible, S.hover = false, nil
  tick:kill()
  raise_subs(false)
  render()
end
hide_timer = mp.add_timeout(HIDE_AFTER, hide)
hide_timer:kill()

local function show()
  if not S.visible then
    S.visible = true
    tick:resume()
    render()
    raise_subs(true)
  end
  hide_timer:kill()
  hide_timer:resume()
end

------------------------------------------------------------------------------------------------
-- Input
------------------------------------------------------------------------------------------------
mp.observe_property("mouse-pos", "native", function(_, m)
  if not m then return end
  local moved = m.x ~= S.mouse.x or m.y ~= S.mouse.y
  S.mouse = m
  if S.drag then
    local z = find_zone(S.drag)
    if z and z.drag then z.drag(m.x, false) end
    render()
    return
  end
  if not m.hover then S.hover = nil; if S.visible then hide_timer:kill(); hide_timer:resume() end; return end
  if moved then
    show()
    local z = zone_at(m.x, m.y)
    local id = z and z.id or nil
    if id ~= S.hover or id == "seek" then S.hover = id; render() end
  end
end)

-- Read the pointer position at the moment of a click: the mouse-pos observer is asynchronous
-- and can lag behind a fast move-then-click.
local function sync_mouse()
  local m = mp.get_property_native("mouse-pos")
  if m then S.mouse = m end
end

local function on_left(e)
  sync_mouse()
  if e.event == "down" then
    if not S.visible then
      local z = zone_at(S.mouse.x, S.mouse.y)
      if z and z.id == "skip" then z.click(); render(); return end  -- the skip pill works while the controls are hidden
      show(); return
    end
    if S.menu then                                -- clicks go to the menu; outside closes it
      local mz = zone_at(S.mouse.x, S.mouse.y)
      if mz and mz.menu then if mz.click then mz.click() end
      elseif mz and mz.id == "settings" then menu_close()
      else menu_close() end
      render()
      return
    end
    local z = zone_at(S.mouse.x, S.mouse.y)
    if z and z.drag then
      S.drag = z.id
      z.drag(S.mouse.x, false)
      render()
    elseif z and z.click then
      z.click()
      render()
    elseif not in_controls_area() then
      mp.commandv("cycle", "pause")            -- click on the picture: play/pause
    end
  elseif e.event == "up" then
    if S.drag then
      local z = find_zone(S.drag)
      if z and z.drag then z.drag(S.mouse.x, true) end
      S.drag, S.drag_value = nil, nil
      render()
    end
  end
end

-- Mice send down + up; some touchpads and mpv's own `mouse` command send a single "press".
mp.add_forced_key_binding("MBTN_LEFT", "marquee-osc-click", function(e)
  if e.event == "press" then
    on_left({ event = "down" })
    on_left({ event = "up" })
  else
    on_left(e)
  end
end, { complex = true })

mp.add_forced_key_binding("MBTN_LEFT_DBL", "marquee-osc-dbl", function()
  sync_mouse()
  if not in_controls_area() and not zone_at(S.mouse.x, S.mouse.y) then mp.commandv("cycle", "fullscreen") end
end)

mp.add_forced_key_binding("MBTN_RIGHT", "marquee-osc-rclick", function()
  sync_mouse()
  show()
  if S.menu then menu_close(); render(); return end
  local z = zone_at(S.mouse.x, S.mouse.y)
  if z and z.rclick then z.rclick()
  else menu_open("point", S.mouse.x, S.mouse.y) end   -- right-click anywhere: settings
  render()
end)

------------------------------------------------------------------------------------------------
-- Events
------------------------------------------------------------------------------------------------
mp.observe_property("pause", "bool", function(_, paused)
  if paused then show() elseif S.visible then hide_timer:kill(); hide_timer:resume(); render() end
end)
mp.observe_property("seeking", "bool", function(_, v) if v then show() end end)
local last_skip = nil
mp.observe_property("time-pos", "number", function()
  local k = skip_state()
  if k ~= last_skip then last_skip = k; if not S.visible then render() end end
end)
-- S: skip while the Skip button shows, otherwise its usual job (input.conf: cycle subtitles).
mp.add_forced_key_binding("s", "marquee-osc-skip", function() if skip_state() then do_skip() else mp.command("cycle sub") end end)
for _, p in ipairs({ "fullscreen", "mute", "volume", "speed", "sid", "aid", "sub-delay", "sub-scale", "sub-visibility", "osd-dimensions" }) do
  mp.observe_property(p, "native", function() if S.visible then render() end end)
end
mp.observe_property("osd-dimensions", "native", function() if thumb.w > 0 then thumb_setup() end end)
mp.observe_property("video-params", "native", function(_, vp) if vp and vp.dw then thumb_setup() end end)
mp.register_event("file-loaded", function()
  S.base_sub_margin = nil
  thumb_setup()
  show()
end)
mp.register_event("shutdown", function()
  thumb_remove()
  mp.command_native({ name = "subprocess", playback_only = false,
    args = WIN and { "cmd", "/d", "/c", "rmdir", "/s", "/q", thumb.dir } or { "rm", "-rf", thumb.dir } })
end)

-- Toggle the controls from input.conf: `TAB script-binding marquee-osc/toggle`
mp.add_key_binding(nil, "toggle", function() if S.visible then S.visible = false; tick:kill(); raise_subs(false); render() else show() end end)
-- Keep visible (for screenshots/testing): `script-message marquee-osc-pin yes|no`
mp.register_script_message("marquee-osc-pin", function(v)
  if v == "yes" then show(); hide_timer:kill() else hide_timer:resume() end
end)
-- Open the settings menu on a given page (testing): `script-message marquee-osc-menu main|subs|delay|audio|speed|size|off`
mp.register_script_message("marquee-osc-menu", function(page)
  if page == "off" then menu_close(); render(); return end
  local w, h = mp.get_osd_size()
  show(); hide_timer:kill()
  menu_open("point", w * 0.62, h * 0.30)
  S.menu.page = page or "main"
  render()
end)
-- Simulate hovering the seek bar at a fraction (testing the hover preview without a mouse)
mp.register_script_message("marquee-osc-hover", function(f)
  local w, h = mp.get_osd_size()
  if f == "off" then S.hover = nil; S.mouse = { x = w / 2, y = h / 2, hover = true }; render(); return end
  f = tonumber(f)
  if not f or not S.geo then return end
  S.mouse = { x = w * 0.10 + f * w * 0.80, y = S.geo.bar_y, hover = true }
  S.hover = "seek"
  show(); hide_timer:kill()
  render()
end)
