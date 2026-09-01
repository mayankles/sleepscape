# Sleepscape — project notes for Claude Code

Context for picking this project back up. This file is for you (Claude
Code), not the end user's README.

## What this is

A personal local player for YouTube soundscapes (rain, ambient noise,
etc.), built to replace using the Calm app's soundscape tab. The whole
point is control the Calm app doesn't give: real seeking within a track,
and a sleep timer that's already running by the time you hit play instead
of something you configure by hand every night.

Single user, runs entirely client-side, no backend, no accounts, no
analytics. Settings and the saved-soundscape shortlist live in the
browser's `localStorage` — nothing is sent to a server.

## Stack and conventions

- Plain HTML/CSS/JS. No framework, no bundler, no `package.json`, no build
  step. This was deliberate, both to keep the project simple for its size
  and so it can be dropped into an Electron/Tauri shell later without a
  rewrite (see "Packaging" in README.md).
- Playback is driven entirely by the official YouTube IFrame Player API
  (https://developers.google.com/youtube/iframe_api_reference), loaded via
  `<script src="https://www.youtube.com/iframe_api">` in `index.html`.
  All player control lives in `app.js` (`state.player`, a `YT.Player`
  instance).
- `app.js` is organized into clearly commented sections: Persistence,
  YouTube URL parsing, App state, YouTube player, Scrub bar, Transport
  controls, Sleep timer, Shortlist, Tabs, Settings overlay, Init. Keep new
  code in the matching section rather than appending to the bottom.
- Dark, low-stimulation UI on purpose (this runs at bedtime) — see the CSS
  custom properties at the top of `style.css` before introducing new
  colors.

## Why `start.command` exists

YouTube's IFrame API needs the page served over `http(s)://`, not opened
as a bare `file://` page (the postMessage handshake between the page and
the embedded player is origin-sensitive). `start.command` just runs
`python3 -m http.server` and opens the browser to it. Once this is on
GitHub Pages, Pages itself satisfies that requirement — `start.command` is
only needed for local development against uncommitted changes.

## Current status

Shipped (v1):
- Custom scrub bar (click/drag to seek), skip ±30s (configurable).
- Sleep timer that auto-arms on first play, runs on wall-clock time
  (independent of pause state), fades volume out over a configurable
  window before pausing, +10m/+20m quick-extend, cancel-for-tonight.
- "My Soundscapes" shortlist (paste a video URL + name, saved locally) and
  a separate "paste a playlist URL" flow, with ⏮/⏭ in playlist mode.
- Settings overlay: default timer length, fade-out length, skip step,
  auto-arm on/off.

Not built yet (the known next steps):
- **Crossfade between tracks.** The plan discussed but not implemented:
  run two `YT.Player` instances, preload the upcoming track in the hidden
  one, cross-blend `setVolume()` between them over a configurable window
  as the current track approaches its end, then swap which player is
  "active" for scrub-bar/transport purposes. For playlist mode this needs
  the track order known ahead of time — `player.getPlaylist()` after a
  playlist loads gives the full video-ID array, so don't rely on YouTube's
  native shuffle if crossfade needs to know what's next; compute the play
  order ourselves instead.
- **Packaging as a standalone Mac app.** Electron or Tauri, wrapping
  `index.html` as-is. Test whether Electron's renderer can `loadFile()`
  directly (fewer file:// restrictions than a plain browser) before
  assuming a bundled local server is still needed inside the packaged app.

## Testing notes

There's no test suite. When changing `app.js`, at minimum:
- `node --check app.js` for syntax.
- Serve it (`python3 -m http.server` from the project root, or
  `start.command`) and manually exercise: add/remove a shortlist item,
  load a playlist, drag the scrub bar, let the sleep timer fade out once
  with a short test duration (temporarily set a low default in Settings
  rather than waiting out a real 45 minutes).
- A real YouTube video ID (e.g. `dQw4w9WgXcQ`) is fine to use for manual
  testing; there's nothing environment-specific to fake.
