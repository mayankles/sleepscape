# Sleepscape

A tiny local player for YouTube soundscapes, built for falling asleep to
them — full scrubbing/seeking, and a sleep timer that's already running the
moment you hit play instead of something you configure every night.

This is v1: seeking + the auto-arming sleep timer. Crossfade between tracks
was scoped out for a later pass.

## Live version

Once this is pushed to GitHub with Pages enabled, it'll be live at:

`https://<your-github-username>.github.io/sleepscape/`

(see **Deploying to GitHub Pages** below). No server, no build — Pages
just serves the static files as-is, and being served over `https://`
actually satisfies YouTube's embed requirements even better than the
local `start.command` workaround does.

## Running it locally (macOS)

1. Unzip this folder anywhere you like (e.g. `~/Apps/Sleepscape`).
2. Double-click **`start.command`**.
   - First run: macOS will likely refuse to open an "unidentified" script.
     Right-click (or Control-click) `start.command` → **Open** → confirm
     **Open** in the dialog. You only need to do this once.
3. It opens `http://localhost:8791` in your default browser. That's the app.
4. To stop it, close the Terminal window that `start.command` opened (or
   press Ctrl+C in it).

Why a launcher instead of just double-clicking `index.html`? YouTube's
embedded player needs the page to be served over `http://`, not opened as a
bare `file://` page — the launcher spins up Python's built-in web server
(already on macOS) just to satisfy that.

## Using it

- **My Soundscapes tab** — paste a YouTube video URL (and optionally a
  name) to save it to your local shortlist. Click any saved title to play
  it. Everything is stored only in your browser's local storage on this
  Mac — nothing is sent anywhere.
- **Playlist URL tab** — paste a full YouTube playlist link to play through
  it, with ⏮ / ⏭ to move between tracks.
- **Scrub bar** — click or drag anywhere on it to jump to that point in the
  track. « 30 / 30 » nudge by a fixed step (default 30s, changeable in
  Settings).
- **Sleep timer** — arms itself automatically the moment something starts
  playing (using your default length from Settings). It counts down in
  real time (not paused when you pause the video), fades the volume down
  over the last stretch instead of cutting out abruptly, then pauses.
  +10m / +20m extend it on the fly; Cancel turns it off for that session
  only, without changing your default.
- **Settings (gear icon)** — default timer length, fade-out duration, skip
  step, and whether the timer should auto-arm at all.

## Notes / limitations

- Embedded YouTube videos still show YouTube's normal ads unless you have
  YouTube Premium on the browser you're using — same as today.
- Only public/unlisted playlists and videos will load, same as any YouTube
  embed.
- Settings and your shortlist live in the browser's local storage. If you
  later switch browsers (or clear site data) on this machine, they won't
  carry over.

## Deploying to GitHub Pages

This is a static site with no build step, so Pages needs nothing beyond
the files already in this repo.

1. Push this repo to GitHub (see the setup instructions you were given
   alongside this file, or just create a repo on github.com and follow its
   push instructions).
2. On GitHub: **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to `Deploy from a
   branch`, branch `main`, folder `/ (root)`. Save.
4. GitHub builds it in under a minute; the URL appears at the top of that
   same Pages settings page (`https://<username>.github.io/sleepscape/`).

Notes:
- The repo needs to be **public** for Pages to be free; a private repo
  needs GitHub Pro/Team/Enterprise to use Pages. Nothing in this app is
  sensitive to have public — no keys, no server, no data that leaves the
  visitor's own browser — but it's your call.
- `start.command` and the local Python server are just for developing
  against changes you haven't pushed yet; the deployed Pages site doesn't
  need either.

## Packaging this as a standalone app later

Everything here is deliberately plain HTML/CSS/JS with no build tooling,
specifically so it's easy to wrap later without rewriting the logic. The
straightforward path when you're ready:

- **Electron**: load `index.html` in a `BrowserWindow` pointed at a small
  bundled server (or `loadFile` directly — Electron's renderer can load
  local files with fewer of the restrictions a plain browser has for the
  YouTube postMessage handshake, but test this first). `electron-builder`
  or `electron-forge` can then produce a signed `.app`/`.dmg`.
- **Tauri**: similar shape, smaller resulting binary, Rust-based shell.
- Either way, `app.js` doesn't need to change — only how the page gets
  served and window-wrapped.

Ask and we can pick one of these up as the next step.

## What's next (not built yet)

- Crossfade between tracks (queue the next video in a second hidden
  player, cross-blend volume over a configurable window as one ends).
- Packaging into a standalone Mac app per above.

See `CLAUDE.md` for implementation notes on both, written for picking this
project back up in Claude Code.
