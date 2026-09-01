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
  YouTube URL parsing, App state, DOM refs, YouTube player, Scrub bar,
  Transport controls, Sleep timer, Sleep timer: exact-length setter,
  Shortlist, Playlist track list, Tabs, Settings overlay, Init. Keep new
  code in the matching section rather than appending to the bottom.
- Dark, low-stimulation UI on purpose (this runs at bedtime) — see the CSS
  custom properties at the top of `style.css` before introducing new
  colors. The theme is "warm twilight": deliberately amber/rose rather than
  blue, because this is the last screen of the night. Three conventions
  hold it together, and one-off values tend to break them:
  - Surfaces are *lit*, not outlined — translucent white washes plus
    `inset 0 0 0 1px var(--hairline)`, never a hard `1px solid` border.
  - One filled control per view (the play button). Everything else is
    glass or ghost, so the eye has a single landing point.
  - Motion is slow and mostly ambient. The only motion that carries
    meaning is the orb's ripple, which runs while audio is playing.
- `@media (prefers-reduced-motion: reduce)` at the bottom of `style.css`
  neutralizes the ambient drift and the orb's animation. If you add motion,
  make sure it degrades there too.

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

Shipped (v1.5) — presets and custom names:
- `PRESET_PLAYLISTS` ships five playlists. `mergeNewPresets()` adds any the
  user has never been offered, recording every id in
  `settings.seededPresets` — so a deleted preset stays deleted, while a
  newly added one still reaches existing installs. This replaced the old
  "seed only when storage is empty" approach, which couldn't deliver new
  presets to anyone who already had the app.
- **Shortlist entries can be renamed** (`beginRename()`), swapping the title
  for an input in place. This isn't cosmetic: four of the five presets are
  YouTube Music auto-generated playlists, which have **no oEmbed record at
  all** (404, not 401), so there is no title to look up and they would
  otherwise read "Playlist (81 tracks)". A hand-typed name is the only good
  name available for them.

Shipped (v1.4) — playlists in the shortlist, and unplayable tracks:
- **The shortlist holds playlists as well as videos.** Entries carry
  `kind: "video" | "playlist"`; `shortlistKind()` infers it for anything
  saved before the field existed, so old data keeps working. A "Save
  playlist" button sits in the track-list header, and its name comes from
  oEmbed — which answers for playlist URLs too, so this still needs no API
  key. Playlist rows carry a badge and switch to the Playlists tab on click.
- **First run seeds the shortlist** with `DEFAULT_SHORTLIST` (the owner's
  "Sleepscape — Nature Sounds" playlist). Only when nothing has ever been
  saved: deleting everything stores `[]`, which is not null, so the seed
  never comes back.
- **Unplayable tracks are detected and skipped** — see below.
- `formatTime()` grew an hours field. These are 8- and 10-hour videos and it
  was rendering "602:09".

Shipped (v1.3) — search:
- Both source tabs take **either a link or a search phrase in the same
  field** — no separate search box, no mode toggle. `attachShortlistEvents`
  / `attachPlaylistFormEvents` route on the input: a parseable link does
  what it always did; something that only *looks* like a link
  (`looksLikeUrl`) is reported as invalid rather than quietly searched; and
  anything else goes to `runSearch`.
- Video results have a **Save** button (adds to the shortlist with the real
  title); clicking the row plays it. Playlist results load on click.
- A blank Name when pasting a link now resolves the video's real title via
  the existing oEmbed cache instead of "Untitled soundscape", so pasted and
  searched entries look the same.

Shipped (v1.2) — "warm twilight" redesign:
- Full restyle of `style.css` around the conventions above; markup and JS
  changed only where the new structure needed it.
- **The video is collapsed by default** and toggled with "Show video"
  (`applyVideoVisibility()`), persisted as `settings.showVideo`. In its
  place a soft "orb" breathes, and ripples while audio plays.
  *The collapse works by clipping, never by resizing or unmounting the
  iframe* — `.video-shell` goes to `max-height: 0; overflow: hidden` while
  the player inside keeps its real dimensions, so YouTube keeps playing.
  Don't "simplify" this to `display: none` or a zero-size iframe; both risk
  YouTube pausing the audio, which is the one thing this app can't do.
- A failed playlist load now says so (`onPlaylistLoadFailed()`) instead of
  sitting on "Loading playlist…" forever. Note it only fires when no
  playlist is loaded at all: pasting a bad link while something is already
  playing leaves the current playlist alone, which is what the player does
  too.
- `flashInvalid()` toggles an `.invalid` class rather than setting an
  inline border color, since inputs are borderless now. Its CSS rule needs
  the `input.invalid:focus` variant — the field keeps focus through a
  failed submit and the focus ring would otherwise win.

Shipped (v1.1):
- Sleep timer −10m/−20m alongside the existing +10m/+20m, and a "Set…"
  panel (preset chips plus an exact minutes field) for setting the length
  outright. Adjustments clamp at `MIN_TIMER_SECONDS` (60) so a stray tap
  can't cut playback dead; the subtract chips disable at the floor and
  whenever no timer is armed.
- Playlist track list: the loaded playlist renders under the Playlist URL
  tab, current track highlighted, click any row to jump to it
  (`player.playVideoAt`). `syncPlaylistState()` re-reads
  `getPlaylist()`/`getPlaylistIndex()` on every player state change, so the
  highlight follows ⏮/⏭ and natural auto-advance too.

Not built yet (the known next steps):
- **Crossfade between tracks.** The track order is now already available
  in `state.playlist.ids` (see "Playlist track list"), which covers the
  "needs to know what's next" requirement below. The plan discussed but
  not implemented:
  run two `YT.Player` instances, preload the upcoming track in the hidden
  one, cross-blend `setVolume()` between them over a configurable window
  as the current track approaches its end, then swap which player is
  "active" for scrub-bar/transport purposes. For playlist mode this needs
  the track order known ahead of time — `player.getPlaylist()` after a
  playlist loads gives the full video-ID array, so don't rely on YouTube's
  native shuffle if crossfade needs to know what's next; compute the play
  order ourselves instead.
- **A quieter first paint.** The ambient gradients animate from load; on a
  cold start that's the brightest the app ever gets. Worth trying a short
  fade-in from black.
- **Packaging as a standalone Mac app.** Electron or Tauri, wrapping
  `index.html` as-is. Test whether Electron's renderer can `loadFile()`
  directly (fewer file:// restrictions than a plain browser) before
  assuming a bundled local server is still needed inside the packaged app.

## Search (why it needs a key, and what was already ruled out)

Search is the one feature here that can't be done key-free. Don't spend time
re-deriving this — all three alternatives were tried and measured:

- **Scraping `youtube.com/results`** — blocked by CORS, no
  `Access-Control-Allow-Origin`. Not fixable from a static page.
- **The IFrame API's `listType: "search"`** — removed by YouTube. Calling
  `cuePlaylist({listType:"search", list:"…"})` cues an empty player:
  `getPlaylist()` returns `[]` and `getVideoData()` has no video ID.
- **The Data API without a key** — 403 "Method doesn't allow unregistered
  callers". Note that this *is* a real JSON response, which confirms the
  endpoint is CORS-enabled: a user-supplied key is all that's missing, not a
  backend.

So `youtubeSearch()` calls `search.list` with `settings.apiKey`, which the
user pastes into Settings and which lives only in `localStorage`. Quota is
the thing to be careful with: `search.list` costs 100 units against a
default 10,000/day, i.e. **about 100 searches a day**. That's why
`state.search.busy` blocks a concurrent second search rather than letting
requests pile up, and why nothing searches automatically as you type.

**The live search path has never been exercised against a real key** — it
was verified with a stubbed response for rendering plus a real rejected
request for the error path. If search misbehaves, suspect this first.

### The link-vs-words split

`looksLikeWords()` exists because bare IDs and search phrases overlap:
"sleepsounds" is exactly 11 characters, the same shape as a video ID. Real
IDs are base64url of random bytes, so an all-lowercase-letters one is
~1e-5 likely, while a typed word is not — hence "has a space, or is all
lowercase letters" means words.

`parsePlaylistId()` was also tightened to require a real prefix
(`PL`/`UU`/`LL`/`RD`/…). Its old bare-ID branch accepted any 10–64
character string, so "rainsounds" and even "not-a-playlist" parsed as
playlist IDs — which broke search routing and was already a latent bug.

## loadPlaylist() loads one playlist behind — stopVideo() first

**Always call `player.stopVideo()` immediately before
`player.loadPlaylist()`.** Without it, repeated loads on the same player
return the *previous* playlist: `getPlaylistId()` reports the newly
requested list while `getPlaylist()` — and the video that actually starts
playing — are still the one before. Clicking between saved playlists played
the wrong one every time.

This was verified against the raw player with all app polling and watchdogs
disabled, so it is the IFrame API's behavior and not something in this code.
`stopVideo()` immediately before the load fixes it completely, with no delay
needed between the two calls.

`syncPlaylistState()` additionally refuses to trust a read until
`getPlaylistId()` matches what was requested, `PLAYLIST_SETTLE_MS` has
elapsed since the load, the contents have turned over from the outgoing
playlist, and the same track array comes back twice running. Those guards
were written before the `stopVideo()` fix was found and are now belt and
braces — but the API misreported state in enough different ways that they're
worth keeping.

## Videos YouTube won't play in an embed

Some videos load their metadata but never play here. Track 3 of the default
playlist (`FUQEecZ0HG0`) is one: oEmbed returns **401**, and
`getVideoData().errorCode` is **`"auth"`** — it needs a signed-in YouTube
session, which an embed can't provide. The title and duration still resolve,
so it looks fine until you try to play it.

Two traps, both learned the hard way:

1. **No `onError` event fires for this.** The player simply sits at
   `UNSTARTED` forever. That's why `checkPlaybackStalled()` polls once,
   ~4.5s after playback is requested, and treats "still UNSTARTED *and*
   carrying an `errorCode`" as the failure signal. A paused or buffering
   player has no `errorCode`, so this doesn't misfire.
2. **`ENDED` does not fire when a playlist advances by itself.** The real
   sequence is `PLAYING → UNSTARTED → BUFFERING → UNSTARTED`. An earlier
   version armed the watchdog only on `ENDED` and so worked when you clicked
   the bad track but hung all night on natural advance — exactly the case
   that matters. The watchdog is now armed on *every* non-PLAYING state.

On failure the track is added to `unplayableVideos`, struck through in the
list, and skipped. `MAX_AUTO_SKIPS` (3) caps a run so a wholly broken
playlist reports itself instead of racing to the end; the streak resets only
on a successful `PLAYING` or a deliberate user action — deliberately *not*
when giving up, or a later state flicker would restart the skipping.

`rememberTitle()` also caches the title the player exposes, so a video oEmbed
can't resolve still shows a name in the list rather than a raw ID.

## Track titles (why oEmbed)

Note that oEmbed has two distinct failure modes here, and they mean
different things: **401** is a restricted video (see below), while **404**
is simply "no oEmbed record" — which is what all four YouTube Music
`RDCLAK5uy_*` playlists return for the playlist URL itself. Their individual
tracks do resolve normally, so track lists still show real names; it's only
the playlist's own title that can't be looked up.


The IFrame API's `getPlaylist()` returns bare video IDs and no titles. Real
names would otherwise mean a YouTube Data API key plus a quota, which
breaks the "no backend, no accounts, drop it on Pages" constraint. Instead
`fetchVideoTitle()` hits the public oEmbed endpoint
(`https://www.youtube.com/oembed?url=…&format=json`) — no API key, and it
sends CORS headers, so it works straight from the browser. Results are
cached in `localStorage` under `sleepscape.titles.v1`, so a playlist you've
opened before renders with real names immediately. Failed lookups (private
or deleted videos) fall back to showing the video ID.

Two things to preserve if you touch this: fetches go out in batches of
`TITLE_FETCH_BATCH` (4) rather than all at once, since playlists run to
hundreds of entries; and each run carries the `state.playlist.loadToken`
it started with, so results from a playlist the user has already navigated
away from get dropped instead of rendering over the new one.

## Testing notes

There's no test suite. When changing `app.js`, at minimum:
- `node --check app.js` for syntax.
- Serve it (`python3 -m http.server` from the project root, or
  `start.command`) and manually exercise: add/remove a shortlist item,
  load a playlist, drag the scrub bar, let the sleep timer fade out once
  with a short test duration (the "Set…" panel makes this quick now — set
  2 minutes rather than waiting out the real default).
- After any CSS change, check the app at ~380px wide as well as full
  width: the chip rows and preset rows are expected to wrap, and the
  transport labels («30 / 30») must stay on one line.
- Search can be exercised without spending quota (or a key) by stubbing
  `window.fetch` to return a `{ items: [...] }` payload in the Data API's
  shape and submitting the form — that covers `normalizeResult`, entity
  decoding, rendering and Save. Check the no-key prompt and the rejected-key
  message too; the latter is a real round trip and costs no quota.
- To exercise the unplayable path, the default playlist's track 3 is a
  standing fixture. Test *both* routes: clicking it directly, and natural
  advance (play track 2, `seekTo(getDuration() - 3)`, wait ~10s). They take
  different code paths and only the second one matters overnight.
- When touching playlist loading, always test *switching between* playlists,
  not just loading one. A single load looks correct even when switching is
  broken — that's exactly how the one-playlist-behind bug survived.
- Also exercise the timer chips (+/− and the floor: hold −20m down to
  1:00 and confirm the subtract chips disable) and the track list (load a
  playlist, click a row mid-list, confirm the highlight follows ⏭ and
  natural track changes as well as clicks).
- Note that `python3 -m http.server` sends cacheable responses, so a plain
  reload will happily serve you a stale `app.js`/`style.css` while you're
  iterating. `.claude/launch.json` runs the same server with
  `Cache-Control: no-store` for that reason — prefer it over a bare
  `http.server` when testing changes.
- A real YouTube video ID (e.g. `dQw4w9WgXcQ`) is fine to use for manual
  testing; there's nothing environment-specific to fake.
