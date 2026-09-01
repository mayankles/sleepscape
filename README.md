# Sleepscape

A tiny local player for YouTube soundscapes, built for falling asleep to
them — full scrubbing/seeking, and a sleep timer that's already running the
moment you hit play instead of something you configure every night.

This is v1: seeking + the auto-arming sleep timer. Crossfade between tracks
was scoped out for a later pass.

## Live version

Once this is pushed to GitHub with Pages enabled, it'll be live at:

[`https://mayankles.github.io/sleepscape/`](https://mayankles.github.io/sleepscape/)

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

- **My Soundscapes tab** — starts with a handful of ready-made playlists
  (ambient, wind & rain, gentle piano, nature sounds). Delete any you don't
  want; they won't come back. Click the **✎** on any entry to rename it —
  useful because YouTube doesn't publish a name for some playlists, which
  would otherwise show up as "Playlist (81 tracks)".
  You can also paste a YouTube video URL (and optionally a
  name) to save it to your local shortlist, or just type what you're after
  ("rain on a tent") to search YouTube. Click a result to play it, or
  **Save** to keep it. Click any saved title to play it. Everything is
  stored only in your browser's local storage on this Mac — nothing is sent
  anywhere.
- **Playlists tab** — paste a full YouTube playlist link to play through
  it, or type words to search for a playlist. ⏮ / ⏭ move between tracks.
  **Save playlist**, above the track list, keeps it in My Soundscapes
  alongside your individual soundscapes, so it's one click away next time.
  A playlist comes with its own name from YouTube. The full track list appears below
  the box once it loads: click any track to jump straight to it, and the
  one currently playing stays highlighted as the playlist moves along.
- **The video stays hidden** by default — a soft glow stands in for it, so
  there's no bright rectangle at bedtime, and it brightens gently while
  something is playing. **Show video** brings the picture back if you want
  it, and it remembers which way you left it. Sound keeps playing either
  way.
- **Scrub bar** — click or drag anywhere on it to jump to that point in the
  track. « 30 / 30 » nudge by a fixed step (default 30s, changeable in
  Settings).
- **Sleep timer** — arms itself automatically the moment something starts
  playing (using your default length from Settings). It counts down in
  real time (not paused when you pause the video), fades the volume down
  over the last stretch instead of cutting out abruptly, then pauses.
  −20m / −10m / +10m / +20m adjust it on the fly, and **Set…** opens
  preset lengths (15m up to 2h) plus a box for an exact number of minutes.
  Adjustments won't take the timer below one minute, so a mistaken tap
  can't cut the sound off. Cancel turns it off for that session only,
  without changing your default.
- **Settings (gear icon)** — default timer length, fade-out duration, skip
  step, and whether the timer should auto-arm at all.

## Turning on search (optional)

Pasting links works out of the box. Searching needs a free YouTube API key
of your own, because YouTube doesn't allow searching from a page like this
one without it:

1. Go to [console.cloud.google.com](https://console.cloud.google.com), make
   a project (any name).
2. Enable **YouTube Data API v3** for it.
3. Create an **API key** under Credentials, and copy it.
4. Paste it into Sleepscape's Settings (the gear, top right).

The key is stored only in this browser, and is sent only to Google, only
when you actually search. The free allowance is roughly **100 searches a
day**, which resets at midnight Pacific — plenty for finding a few
soundscapes, but it's why there's no search-as-you-type here.

## Notes / limitations

- Embedded YouTube videos still show YouTube's normal ads unless you have
  YouTube Premium on the browser you're using — same as today.
- Occasionally YouTube won't allow a video to play outside youtube.com —
  usually because it requires a signed-in viewer. Sleepscape marks those
  **unavailable** in the track list and skips past them rather than letting
  the night stall on one, so a playlist keeps going. Nothing can be done
  about it from here; replacing the track in the playlist is the fix.
- Track names in the playlist list are looked up from YouTube's public
  oEmbed endpoint and remembered locally, so a playlist you've opened
  before lists instantly. A track that's private or deleted shows its
  video ID instead of a name.
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
   same Pages settings page ([`https://mayankles.github.io/sleepscape/`](https://mayankles.github.io/sleepscape/)).

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
