/* Sleepscape — a minimal local controller for YouTube soundscapes.
 * Built on the official YouTube IFrame Player API:
 * https://developers.google.com/youtube/iframe_api_reference
 *
 * Everything here is vanilla JS on purpose (no build step, no framework)
 * so this same logic can be dropped into an Electron shell later without
 * a rewrite.
 */

// ---------- Persistence ----------

const STORAGE_KEYS = {
  settings: "sleepscape.settings.v1",
  shortlist: "sleepscape.shortlist.v1",
  titles: "sleepscape.titles.v1",
  session: "sleepscape.session.v1",
};

const DEFAULT_SETTINGS = {
  defaultTimerMinutes: 15,
  fadeSeconds: 30,
  autoArm: true,
  skipStep: 30,
  // Preset playlist ids already offered; see mergeNewPresets().
  seededPresets: [],
  // Supplied by the user in Settings; enables search. Empty by default, and
  // everything except search works fine without it.
  apiKey: "",
  // The video is dead weight for a soundscape and bright at bedtime, so it
  // stays collapsed until asked for. Remembered between nights.
  showVideo: false,
  // Whether the player's track list is expanded. Starts open, since changing
  // tracks easily is the point of it, then remembers what you last chose.
  tracksOpen: true,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) {
    console.warn("Couldn't read settings, using defaults", e);
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  } catch (e) {
    console.warn("Couldn't save settings", e);
  }
}

// Presets offered to every install — see mergeNewPresets() for how they're
// added without resurrecting ones the user has deleted. The names here are
// deliberate: YouTube Music's auto-generated playlists have no oEmbed
// record, so there's no title to look up and they'd otherwise show as
// "Playlist (81 tracks)".
const PRESET_PLAYLISTS = [
  {
    id: "preset-nature-sounds",
    title: "Sleepscape — Nature Sounds",
    playlistId: "PLYHw0b71CtIQ",
  },
  {
    id: "preset-ambient-music",
    title: "Ambient Music",
    playlistId: "RDCLAK5uy_l2OjbOL4oVkkHE86UT6oQCNufuv8d0luQ",
  },
  {
    id: "preset-wind-and-rain",
    title: "Wind & Rain",
    playlistId: "RDCLAK5uy_kGcITlIUh14Xy7FgqGiLtEJtKoDax4TkI",
  },
  {
    id: "preset-gentle-piano",
    title: "Gentle Piano",
    playlistId: "RDCLAK5uy_ldooV6iHaoPy6VKyVuHDq0DT4lh-3tRqQ",
  },
  {
    id: "preset-nature-short",
    title: "Nature Sounds (Short Tracks)",
    playlistId: "RDCLAK5uy_mSTV5z2uzELcKu99EJcQxfuDZwO6CMLFM",
  },
  {
    id: "preset-guided-meditation",
    title: "Guided Sleep Meditation",
    playlistId: "PLwRp13WDIrMPzLqtyvvPrs7sMR_lvZ8Bf",
  },
];

function loadShortlist() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.shortlist);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn("Couldn't read shortlist", e);
    return [];
  }
}

function saveShortlist(list) {
  try {
    localStorage.setItem(STORAGE_KEYS.shortlist, JSON.stringify(list));
  } catch (e) {
    console.warn("Couldn't save shortlist", e);
  }
}

// What was loaded last night, so a refresh comes back to the same place.
// Restored *cued*, never playing — see restoreSession().
function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.session);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    console.warn("Couldn't read last session", e);
    return null;
  }
}

function saveSession(session) {
  try {
    localStorage.setItem(STORAGE_KEYS.session, JSON.stringify(session));
  } catch (e) {
    console.warn("Couldn't save session", e);
  }
}

// Video titles resolved from oEmbed, kept between sessions so reloading a
// playlist you've already seen renders with real names immediately.
function loadTitleCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.titles);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    console.warn("Couldn't read title cache", e);
    return {};
  }
}

function saveTitleCache(cache) {
  try {
    localStorage.setItem(STORAGE_KEYS.titles, JSON.stringify(cache));
  } catch (e) {
    console.warn("Couldn't save title cache", e);
  }
}

// ---------- YouTube URL parsing ----------

function parseVideoId(input) {
  if (!input) return null;
  const trimmed = input.trim();

  // Bare 11-character video ID.
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      const seg = url.pathname.split("/").filter(Boolean)[0];
      if (seg && /^[a-zA-Z0-9_-]{11}$/.test(seg)) return seg;
    }

    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      const v = url.searchParams.get("v");
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

      const parts = url.pathname.split("/").filter(Boolean);
      // /embed/VIDEOID or /shorts/VIDEOID or /v/VIDEOID
      const idx = parts.findIndex((p) => ["embed", "shorts", "v"].includes(p));
      if (idx !== -1 && parts[idx + 1] && /^[a-zA-Z0-9_-]{11}$/.test(parts[idx + 1])) {
        return parts[idx + 1];
      }
    }
  } catch (e) {
    // Not a valid URL at all — fall through to null.
  }

  return null;
}

function parsePlaylistId(input) {
  if (!input) return null;
  const trimmed = input.trim();

  try {
    const url = new URL(trimmed);
    const list = url.searchParams.get("list");
    if (list) return list;
  } catch (e) {
    // Not a URL — maybe they pasted a bare playlist ID.
  }

  // Real playlist IDs carry a known prefix (PL/UU/LL/RD/…). Without that
  // check any single word — "rainsounds" — would parse as a playlist ID and
  // get loaded instead of searched.
  if (/^(PL|UU|LL|FL|RD|OL|TL|MP|SP|EC)[a-zA-Z0-9_-]{8,}$/.test(trimmed)) return trimmed;
  return null;
}

// ---------- Telling links from search terms ----------

// Something the user clearly meant as a link, so a parse failure should be
// reported rather than quietly turned into a search.
function looksLikeUrl(text) {
  return /^https?:\/\//i.test(text) || /(^|\.)(youtube\.com|youtu\.be)\//i.test(text);
}

// Bare IDs and search phrases overlap: "sleepsounds" is exactly 11 chars, the
// same shape as a video ID. Real IDs are base64url of random bytes, so one
// that's all lowercase letters is vanishingly unlikely (~1e-5) — whereas a
// typed word is not. Treat all-lowercase-letters, or anything with a space,
// as words.
function looksLikeWords(text) {
  return /\s/.test(text) || /^[a-z]+$/.test(text);
}

// ---------- App state ----------

const state = {
  settings: loadSettings(),
  shortlist: loadShortlist(),
  titleCache: loadTitleCache(),
  player: null,
  playerReady: false,
  mode: null, // 'single' | 'playlist'
  isDragging: false,
  scrubTimer: null,
  watchdogId: null,
  skipStreak: 0,
  timer: {
    armed: false,
    remaining: 0, // seconds
    intervalId: null,
  },
  search: {
    // Bumped per search so a slow response from an abandoned query can't
    // render over a newer one.
    token: 0,
    busy: false,
  },
  playlist: {
    id: null,
    ids: [],
    index: -1,
    // Track array of the playlist we're switching away from, and whether
    // we're still waiting for the player to stop reporting it.
    previousSignature: "",
    awaitingTurnover: false,
    // Candidate awaiting confirmation by a second identical read.
    pendingSignature: null,
    loadedAt: 0,
    // From a pasted watch link carrying both v= and list=: jump to this video
    // once the track order is known. loadPlaylist() only accepts an index.
    pendingStartVideoId: null,
    // Bumped on every playlist load so in-flight title fetches from a
    // previous playlist can tell they're stale and drop their results.
    loadToken: 0,
    pollId: null,
  },
};

// Videos YouTube refuses to play in an embed (see handleUnplayableVideo).
// Not persisted — a video can stop being restricted.
const unplayableVideos = new Set();

// How many bad tracks in a row to skip past before giving up and saying so,
// rather than racing through a whole broken playlist.
const MAX_AUTO_SKIPS = 3;

// How long to disregard playlist reads after a load, while the player's
// getPlaylist() catches up with getPlaylistId().
const PLAYLIST_SETTLE_MS = 1200;

// A sleep timer shorter than this isn't useful, so +/- adjustments and the
// exact-length setter both clamp here rather than cutting playback dead.
const MIN_TIMER_SECONDS = 60;

// ---------- DOM refs ----------

const el = {
  ytPlayer: document.getElementById("ytPlayer"),
  stage: document.getElementById("stage"),
  videoShell: document.getElementById("videoShell"),
  toggleVideoBtn: document.getElementById("toggleVideoBtn"),
  npTitle: document.getElementById("npTitle"),
  npSub: document.getElementById("npSub"),
  curTime: document.getElementById("curTime"),
  durTime: document.getElementById("durTime"),
  scrubTrack: document.getElementById("scrubTrack"),
  scrubFill: document.getElementById("scrubFill"),
  scrubHandle: document.getElementById("scrubHandle"),
  skipBackBtn: document.getElementById("skipBackBtn"),
  skipFwdBtn: document.getElementById("skipFwdBtn"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  playPauseBtn: document.getElementById("playPauseBtn"),
  timerStatus: document.getElementById("timerStatus"),
  cancelTimerBtn: document.getElementById("cancelTimerBtn"),
  timerAdjustChips: document.querySelectorAll(".chip[data-add-min]"),
  setTimerBtn: document.getElementById("setTimerBtn"),
  timerSetPanel: document.getElementById("timerSetPanel"),
  timerSetForm: document.getElementById("timerSetForm"),
  timerSetInput: document.getElementById("timerSetInput"),
  timerPresetChips: document.querySelectorAll(".chip[data-set-min]"),
  trackListWrap: document.getElementById("trackListWrap"),
  trackList: document.getElementById("trackList"),
  trackCount: document.getElementById("trackCount"),
  savePlaylistBtn: document.getElementById("savePlaylistBtn"),
  shortlistItems: document.getElementById("shortlistItems"),
  addForm: document.getElementById("addForm"),
  addInput: document.getElementById("addInput"),
  searchResults: document.getElementById("searchResults"),
  searchResultList: document.getElementById("searchResultList"),
  searchResultsLabel: document.getElementById("searchResultsLabel"),
  searchResultsClose: document.getElementById("searchResultsClose"),
  toggleTracksBtn: document.getElementById("toggleTracksBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsOverlay: document.getElementById("settingsOverlay"),
  closeSettingsBtn: document.getElementById("closeSettingsBtn"),
  defaultTimerInput: document.getElementById("defaultTimerInput"),
  fadeSecondsInput: document.getElementById("fadeSecondsInput"),
  autoArmInput: document.getElementById("autoArmInput"),
  skipStepInput: document.getElementById("skipStepInput"),
  apiKeyInput: document.getElementById("apiKeyInput"),
};

// ---------- YouTube player ----------

// Called automatically by the IFrame API script once it has loaded.
function createYouTubePlayer() {
  if (state.player) return; // both entry points below can reach this
  state.player = new YT.Player("ytPlayer", {
    height: "100%",
    width: "100%",
    playerVars: {
      playsinline: 1,
      rel: 0,
    },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange,
    },
  });
}

// The API calls this once, when it has finished loading.
window.onYouTubeIframeAPIReady = createYouTubePlayer;

// ...but if it finished loading before this file ran, that call has already
// happened and is gone for good — nothing would ever build the player, and
// every control would silently no-op on `!state.playerReady`. Script order in
// index.html is arranged to prevent that; this covers it regardless.
if (window.YT && window.YT.Player) createYouTubePlayer();

function onPlayerReady() {
  state.playerReady = true;
  state.player.setVolume(100);
  restoreSession();
}

// Brings back whatever was loaded last time, cued rather than playing. The
// point is to pick up where you left off without a 3am room suddenly filling
// with sound because a tab reloaded.
function restoreSession() {
  const last = loadSession();
  if (!last) return;

  if (last.mode === "playlist" && last.playlistId) {
    playPlaylistById(last.playlistId, { index: last.index || 0, autoplay: false });
  } else if (last.mode === "single" && last.videoId) {
    playSingleVideo(last.videoId, last.title, { autoplay: false });
  }
}

function onPlayerStateChange(event) {
  const PlayerState = window.YT.PlayerState;

  el.stage.classList.toggle("playing", event.data === PlayerState.PLAYING);

  if (event.data === PlayerState.PLAYING) {
    el.playPauseBtn.textContent = "❚❚";
    // Something is actually playing, so nothing is stuck and any run of
    // skipped tracks is over.
    clearPlaybackWatchdog();
    state.skipStreak = 0;
    startScrubLoop();
    maybeAutoArmTimer();
    syncPlaylistState();
    updateNowPlayingFromPlayer();
  } else {
    // Any non-playing state might be a track that will never start. A
    // playlist advancing into a restricted video goes straight to
    // UNSTARTED — ENDED is never fired — so arming only on ENDED misses the
    // overnight case entirely. The check itself only acts on UNSTARTED with
    // an error code, so pausing is unaffected.
    armPlaybackWatchdog();

    if (event.data === PlayerState.PAUSED || event.data === PlayerState.ENDED) {
      el.playPauseBtn.textContent = "▶";
      updateTimerUI();
    } else if (event.data === PlayerState.CUED) {
      syncPlaylistState();
      updateNowPlayingFromPlayer();
    }
  }
}

// ---------- Unplayable videos ----------
// Some videos load their metadata but refuse to play in an embed — YouTube
// reports getVideoData().errorCode === "auth" and simply sits at UNSTARTED
// without ever firing onError. The third track of the default playlist is
// one of these. Since no event announces it, poll once shortly after we ask
// for playback and treat "still unstarted, and carrying an error code" as a
// failure.

function armPlaybackWatchdog() {
  clearPlaybackWatchdog();
  state.watchdogId = setTimeout(checkPlaybackStalled, 4500);
}

function clearPlaybackWatchdog() {
  if (state.watchdogId) {
    clearTimeout(state.watchdogId);
    state.watchdogId = null;
  }
}

function checkPlaybackStalled() {
  state.watchdogId = null;
  if (!state.playerReady) return;

  let playerState, data;
  try {
    playerState = state.player.getPlayerState();
    data = state.player.getVideoData();
  } catch (e) {
    return;
  }

  // UNSTARTED plus an error code is the signature; a merely paused or
  // buffering player has no error code.
  if (playerState !== window.YT.PlayerState.UNSTARTED) return;
  if (!data || !data.errorCode) return;

  rememberTitle(data.video_id, data.title);
  handleUnplayableVideo(data.video_id, data.errorCode);
}

function handleUnplayableVideo(videoId, reason) {
  if (videoId) unplayableVideos.add(videoId);
  renderTrackList();

  const canSkip =
    state.mode === "playlist" &&
    state.playlist.ids.length > 1 &&
    state.skipStreak < MAX_AUTO_SKIPS;

  if (canSkip) {
    state.skipStreak += 1;
    el.npSub.textContent = "Skipping a track YouTube won't play here…";
    try {
      state.player.nextVideo();
    } catch (e) {}
    armPlaybackWatchdog();
    return;
  }

  el.npTitle.textContent = "YouTube won't play this one here";
  el.npSub.textContent =
    reason === "auth"
      ? "It needs a signed-in YouTube session, so it can't play in an embed."
      : "It isn't available for embedded playback.";
}

// setVolume can throw if the iframe isn't ready yet; every caller wants the
// same "try to get back to full volume, shrug if we can't" behavior.
function restorePlayerVolume() {
  if (!state.playerReady) return;
  try {
    state.player.setVolume(100);
  } catch (e) {}
}

function updateNowPlayingFromPlayer() {
  try {
    const data = state.player.getVideoData();
    if (data && data.title) {
      rememberTitle(data.video_id, data.title);
      el.npTitle.textContent = data.title;
      el.npSub.textContent = state.mode === "playlist" ? playlistPositionLabel() : "Playing";
    }
  } catch (e) {
    // getVideoData can be briefly unavailable right after cueing; ignore.
  }
}

function playSingleVideo(videoId, title, options) {
  if (!state.playerReady) return;
  const autoplay = !options || options.autoplay !== false;

  state.mode = "single";
  el.npTitle.textContent = title || "Loading…";
  el.npSub.textContent = autoplay ? "Playing" : "Ready — press play";
  setTransportPlaylistMode(false);
  clearPlaylistTracks();
  restorePlayerVolume();

  if (autoplay) {
    state.player.loadVideoById(videoId);
    // Only worth watching for a stall when we actually asked it to play.
    armPlaybackWatchdog();
  } else {
    state.player.cueVideoById(videoId);
  }

  saveSession({ mode: "single", videoId, title: title || "" });
}

function playPlaylistById(playlistId, options) {
  if (!state.playerReady) return;
  const startIndex = (options && options.index) || 0;
  const autoplay = !options || options.autoplay !== false;
  const startVideoId = (options && options.startVideoId) || null;

  state.mode = "playlist";
  el.npTitle.textContent = "Loading playlist…";
  el.npSub.textContent = "";
  setTransportPlaylistMode(true);

  // Captured before clearPlaylistTracks() wipes them; syncPlaylistState()
  // uses these to tell a real load from a stale read.
  const previousId = state.playlist.id;
  const previousSignature = state.playlist.ids.join(",");

  clearPlaylistTracks();
  state.playlist.id = playlistId;
  state.playlist.previousSignature = previousSignature;
  // Only when actually switching: reloading the same playlist legitimately
  // yields the same tracks and must not wait for a turnover that never comes.
  state.playlist.awaitingTurnover = Boolean(previousId && previousId !== playlistId);
  state.playlist.loadedAt = Date.now();
  state.playlist.pendingStartVideoId = startVideoId;
  state.skipStreak = 0;
  restorePlayerVolume();

  // Stop before loading. Without this the player loads one playlist behind
  // on repeated loadPlaylist() calls — getPlaylistId() reports the new list
  // while getPlaylist() and the actually-playing video are still the
  // previous one, so switching between saved playlists plays the wrong
  // thing. Verified against the raw player with all app polling disabled.
  try {
    state.player.stopVideo();
  } catch (e) {}

  const args = { listType: "playlist", list: playlistId, index: startIndex };
  if (autoplay) {
    state.player.loadPlaylist(args);
    armPlaybackWatchdog();
  } else {
    // Restoring on startup: bring the playlist back without breaking the
    // silence. cuePlaylist loads the metadata but waits to be told to play.
    state.player.cuePlaylist(args);
  }

  watchForPlaylistTracks();
  updateSavePlaylistBtn();
  saveSession({ mode: "playlist", playlistId, index: startIndex });
}

function setTransportPlaylistMode(isPlaylist) {
  el.prevBtn.disabled = !isPlaylist;
  el.nextBtn.disabled = !isPlaylist;
}

// ---------- Video visibility ----------
// Collapsing the shell clips the iframe rather than resizing or unmounting
// it — the player keeps its real dimensions inside, so audio is untouched.

function applyVideoVisibility() {
  const show = state.settings.showVideo;
  el.videoShell.classList.toggle("open", show);
  el.stage.classList.toggle("video-open", show);
  el.toggleVideoBtn.textContent = show ? "Hide video" : "Show video";
  el.toggleVideoBtn.setAttribute("aria-pressed", show ? "true" : "false");
}

function attachVideoToggleEvents() {
  el.toggleVideoBtn.addEventListener("click", () => {
    state.settings.showVideo = !state.settings.showVideo;
    saveSettings(state.settings);
    applyVideoVisibility();
  });
}

// ---------- Scrub bar ----------

function startScrubLoop() {
  if (state.scrubTimer) return;
  state.scrubTimer = setInterval(updateScrubUI, 400);
}

function stopScrubLoopIfIdle() {
  const s = state.player && state.player.getPlayerState ? state.player.getPlayerState() : -1;
  if (s !== window.YT.PlayerState.PLAYING && state.scrubTimer) {
    clearInterval(state.scrubTimer);
    state.scrubTimer = null;
  }
}

function updateScrubUI() {
  if (!state.playerReady || state.isDragging) return;
  stopScrubLoopIfIdle();

  let current = 0;
  let duration = 0;
  try {
    current = state.player.getCurrentTime() || 0;
    duration = state.player.getDuration() || 0;
  } catch (e) {
    return;
  }

  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  el.scrubFill.style.width = pct + "%";
  el.scrubHandle.style.left = pct + "%";
  el.curTime.textContent = formatTime(current);
  el.durTime.textContent = formatTime(duration);
}

function formatTime(seconds) {
  seconds = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  // These are 8- and 10-hour videos, so anything past an hour needs an hours
  // field — "602:09" is not a readable duration.
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function seekToPercent(pct) {
  if (!state.playerReady) return;
  let duration = 0;
  try {
    duration = state.player.getDuration() || 0;
  } catch (e) {
    return;
  }
  if (duration <= 0) return;
  const target = (pct / 100) * duration;
  state.player.seekTo(target, true);
  el.scrubFill.style.width = pct + "%";
  el.scrubHandle.style.left = pct + "%";
  el.curTime.textContent = formatTime(target);
}

function pctFromClientX(clientX) {
  const rect = el.scrubTrack.getBoundingClientRect();
  const pct = ((clientX - rect.left) / rect.width) * 100;
  return Math.max(0, Math.min(100, pct));
}

function attachScrubEvents() {
  const onDown = (clientX) => {
    state.isDragging = true;
    seekToPercent(pctFromClientX(clientX));
  };
  const onMove = (clientX) => {
    if (!state.isDragging) return;
    seekToPercent(pctFromClientX(clientX));
  };
  const onUp = () => {
    state.isDragging = false;
  };

  el.scrubTrack.addEventListener("mousedown", (e) => onDown(e.clientX));
  window.addEventListener("mousemove", (e) => onMove(e.clientX));
  window.addEventListener("mouseup", onUp);

  el.scrubTrack.addEventListener("touchstart", (e) => onDown(e.touches[0].clientX), { passive: true });
  el.scrubTrack.addEventListener("touchmove", (e) => onMove(e.touches[0].clientX), { passive: true });
  el.scrubTrack.addEventListener("touchend", onUp);
}

// ---------- Transport controls ----------

function isPlayingNow() {
  if (!state.playerReady) return false;
  try {
    return state.player.getPlayerState() === window.YT.PlayerState.PLAYING;
  } catch (e) {
    return false;
  }
}

function togglePlayPause() {
  if (!state.playerReady) return;
  const s = state.player.getPlayerState();
  if (s === window.YT.PlayerState.PLAYING) {
    state.player.pauseVideo();
  } else {
    state.player.playVideo();
  }
}

function skipBy(deltaSeconds) {
  if (!state.playerReady) return;
  let current = 0;
  let duration = 0;
  try {
    current = state.player.getCurrentTime() || 0;
    duration = state.player.getDuration() || 0;
  } catch (e) {
    return;
  }
  const target = Math.max(0, Math.min(duration || Infinity, current + deltaSeconds));
  state.player.seekTo(target, true);
}

function previousTrack() {
  if (state.mode !== "playlist" || !state.playerReady) return;
  state.skipStreak = 0;
  state.player.previousVideo();
  armPlaybackWatchdog();
}

function nextTrack() {
  if (state.mode !== "playlist" || !state.playerReady) return;
  state.skipStreak = 0;
  state.player.nextVideo();
  armPlaybackWatchdog();
}

function attachTransportEvents() {
  el.playPauseBtn.addEventListener("click", togglePlayPause);
  el.skipBackBtn.addEventListener("click", () => skipBy(-state.settings.skipStep));
  el.skipFwdBtn.addEventListener("click", () => skipBy(state.settings.skipStep));
  el.prevBtn.addEventListener("click", previousTrack);
  el.nextBtn.addEventListener("click", nextTrack);
}

// ---------- Keyboard shortcuts ----------

// Typing a soundscape name shouldn't scrub the track, so every shortcut
// stands down while a field has focus.
function isTypingTarget(node) {
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable;
}

function attachKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (isTypingTarget(e.target)) return;
    // Leave browser and OS combinations alone.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // The settings overlay owns the keyboard while it's open (Escape closes
    // it), and the grips own the arrow keys while one is focused.
    if (!el.settingsOverlay.classList.contains("hidden")) return;
    if (e.target && e.target.classList && e.target.classList.contains("si-grip")) return;

    switch (e.key) {
      case " ":
      case "k":
        togglePlayPause();
        break;
      case "ArrowLeft":
      case "j":
        skipBy(-state.settings.skipStep);
        break;
      case "ArrowRight":
      case "l":
        skipBy(state.settings.skipStep);
        break;
      case "p":
        previousTrack();
        break;
      case "n":
        nextTrack();
        break;
      case "v":
        el.toggleVideoBtn.click();
        break;
      case "t":
        toggleTimerSetPanel();
        break;
      default:
        return; // not ours: leave the event alone
    }
    // Only reached for a key we handled — stops Space scrolling the page
    // and the arrows moving the scroll position.
    e.preventDefault();
  });
}

// ---------- Sleep timer ----------
// The countdown follows playback: pause the track and the timer holds where
// it is, resuming when you press play. (It previously ran on wall-clock time
// regardless, on the reasoning that pausing shouldn't quietly extend your
// night — that was reversed deliberately, so a pause means a pause.) It arms
// itself the first time playback starts in a session — no extra taps needed.

function maybeAutoArmTimer() {
  if (state.timer.armed) return;
  if (!state.settings.autoArm) return;
  armTimer(state.settings.defaultTimerMinutes * 60);
}

function armTimer(seconds) {
  state.timer.armed = true;
  state.timer.remaining = seconds;
  if (!state.timer.intervalId) {
    state.timer.intervalId = setInterval(timerTick, 1000);
  }
  updateTimerUI();
}

function addMinutesToTimer(minutes) {
  if (!state.timer.armed) {
    // Nothing to subtract from when no timer is running.
    if (minutes <= 0) return;
    armTimer(minutes * 60);
    return;
  }
  // If we were mid fade-out (or already ended), adjusting restores volume;
  // the next tick re-applies the fade if we're still inside the window.
  restorePlayerVolume();
  state.timer.remaining = Math.max(MIN_TIMER_SECONDS, state.timer.remaining + minutes * 60);
  updateTimerUI();
}

// Set the timer to an exact length, arming it if it wasn't already running.
function setTimerMinutes(minutes) {
  const mins = clampNumber(minutes, 1, 600, state.settings.defaultTimerMinutes);

  // Choosing a length deliberately also makes it the new default, so it
  // survives a refresh and auto-arms at that length tomorrow. The +/- chips
  // deliberately don't do this — they're nudges for tonight, not a new
  // preference.
  if (mins !== state.settings.defaultTimerMinutes && mins <= 300) {
    state.settings.defaultTimerMinutes = mins;
    saveSettings(state.settings);
  }

  restorePlayerVolume();
  armTimer(Math.max(MIN_TIMER_SECONDS, mins * 60));
  closeTimerSetPanel();
}

function cancelTimer() {
  state.timer.armed = false;
  state.timer.remaining = 0;
  if (state.timer.intervalId) {
    clearInterval(state.timer.intervalId);
    state.timer.intervalId = null;
  }
  restorePlayerVolume();
  closeTimerSetPanel();
  updateTimerUI();
}

function timerTick() {
  if (!state.timer.armed) return;

  // Held, not stopped: the interval keeps running so the display stays
  // live, but nothing counts down while playback is paused.
  if (!isPlayingNow()) {
    updateTimerUI();
    return;
  }

  state.timer.remaining -= 1;

  const fadeWindow = state.settings.fadeSeconds;
  if (fadeWindow > 0 && state.timer.remaining <= fadeWindow && state.timer.remaining > 0) {
    const vol = Math.round((state.timer.remaining / fadeWindow) * 100);
    if (state.playerReady) {
      try {
        state.player.setVolume(Math.max(0, Math.min(100, vol)));
      } catch (e) {}
    }
  }

  if (state.timer.remaining <= 0) {
    if (state.playerReady) {
      try {
        state.player.setVolume(0);
        state.player.pauseVideo();
      } catch (e) {}
    }
    state.timer.armed = false;
    clearInterval(state.timer.intervalId);
    state.timer.intervalId = null;
    // Restore volume for the next session, but only after the fade has
    // visibly completed — otherwise this would race the fade itself.
    setTimeout(restorePlayerVolume, 500);
  }

  updateTimerUI();
}

function updateTimerUI() {
  if (state.timer.armed) {
    const fading = state.settings.fadeSeconds > 0 && state.timer.remaining <= state.settings.fadeSeconds;
    const held = !isPlayingNow();
    let status;
    if (fading) {
      status = `fading out — ${formatTime(state.timer.remaining)} left`;
    } else if (held) {
      status = `${formatTime(state.timer.remaining)} remaining — paused`;
    } else {
      status = `${formatTime(state.timer.remaining)} remaining`;
    }
    el.timerStatus.textContent = status;
    el.cancelTimerBtn.hidden = false;
  } else {
    el.timerStatus.textContent = state.settings.autoArm
      ? "will start with playback"
      : "off — tap +10m or Set… to start";
    el.cancelTimerBtn.hidden = true;
  }

  // Subtracting only makes sense while a timer is actually running, and
  // never past the floor.
  el.timerAdjustChips.forEach((btn) => {
    const mins = parseInt(btn.dataset.addMin, 10);
    if (mins < 0) {
      btn.disabled = !state.timer.armed || state.timer.remaining <= MIN_TIMER_SECONDS;
    }
  });
}

// ---------- Sleep timer: exact-length setter ----------

function openTimerSetPanel() {
  el.timerSetInput.value = state.timer.armed
    ? Math.max(1, Math.round(state.timer.remaining / 60))
    : state.settings.defaultTimerMinutes;
  el.timerSetPanel.classList.remove("hidden");
  el.setTimerBtn.classList.add("active");
  el.setTimerBtn.setAttribute("aria-expanded", "true");
  el.timerSetInput.focus();
  el.timerSetInput.select();
}

function closeTimerSetPanel() {
  el.timerSetPanel.classList.add("hidden");
  el.setTimerBtn.classList.remove("active");
  el.setTimerBtn.setAttribute("aria-expanded", "false");
}

function toggleTimerSetPanel() {
  if (el.timerSetPanel.classList.contains("hidden")) {
    openTimerSetPanel();
  } else {
    closeTimerSetPanel();
  }
}

function attachTimerEvents() {
  el.timerAdjustChips.forEach((btn) => {
    btn.addEventListener("click", () => {
      addMinutesToTimer(parseInt(btn.dataset.addMin, 10));
    });
  });
  el.cancelTimerBtn.addEventListener("click", cancelTimer);

  el.setTimerBtn.addEventListener("click", toggleTimerSetPanel);

  el.timerPresetChips.forEach((btn) => {
    btn.addEventListener("click", () => {
      setTimerMinutes(parseInt(btn.dataset.setMin, 10));
    });
  });

  el.timerSetForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const mins = parseInt(el.timerSetInput.value, 10);
    if (Number.isNaN(mins) || mins < 1) {
      flashInvalid(el.timerSetInput);
      return;
    }
    setTimerMinutes(mins);
  });
}

// ---------- Shortlist ----------

// Adds any preset the user has never been offered. `settings.seededPresets`
// records every preset id we've handed over, so deleting one keeps it gone
// while a genuinely new preset still arrives on an existing install.
function mergeNewPresets() {
  const seeded = new Set(state.settings.seededPresets || []);
  let addedAny = false;

  PRESET_PLAYLISTS.forEach((preset) => {
    if (seeded.has(preset.playlistId)) return;
    seeded.add(preset.playlistId);

    // Don't duplicate one the user already saved for themselves.
    if (state.shortlist.some((x) => x.playlistId === preset.playlistId)) return;

    state.shortlist.push({
      id: preset.id,
      kind: "playlist",
      title: preset.title,
      playlistId: preset.playlistId,
      url: playlistUrlFor(preset.playlistId),
    });
    addedAny = true;
  });

  state.settings.seededPresets = [...seeded];
  saveSettings(state.settings);
  if (addedAny) saveShortlist(state.shortlist);
}

// Index of the row currently being dragged, shared across every row's
// handlers for the duration of one drag.
let shortlistDragIndex = null;

function clearDropMarkers() {
  el.shortlistItems.querySelectorAll(".shortlist-item").forEach((row) => {
    row.classList.remove("drop-before", "drop-after");
  });
}

function moveShortlistItem(from, to, refocusGrip) {
  if (from === null || to === null) return;
  if (from === to || to < 0 || to >= state.shortlist.length) return;

  const [moved] = state.shortlist.splice(from, 1);
  state.shortlist.splice(to, 0, moved);
  saveShortlist(state.shortlist);
  renderShortlist();

  // Re-rendering drops focus, which would strand a keyboard user after one
  // press; put it back on the same row at its new position.
  if (refocusGrip) {
    const grips = el.shortlistItems.querySelectorAll(".si-grip");
    if (grips[to]) grips[to].focus();
  }
}

function shortlistKind(item) {
  return item.kind || (item.playlistId ? "playlist" : "video");
}

function renderShortlist() {
  el.shortlistItems.innerHTML = "";

  if (state.shortlist.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-hint";
    p.textContent = "No saved soundscapes yet — add your favorites below.";
    el.shortlistItems.appendChild(p);
    return;
  }

  state.shortlist.forEach((item, index) => {
    const kind = shortlistKind(item);

    const li = document.createElement("li");
    li.className = "shortlist-item";

    // Reordering is driven from the grip alone, never the whole row: making
    // the row itself draggable makes the rename field awkward to select in
    // and turns a slightly-moved click into a drag instead of playback.
    const grip = document.createElement("span");
    grip.className = "si-grip";
    grip.textContent = "⠿";
    grip.tabIndex = 0;
    grip.setAttribute("role", "button");
    grip.title = "Drag to reorder, or focus and use ↑ / ↓";
    grip.setAttribute("aria-label", `Reorder ${item.title || ""}`);

    grip.addEventListener("mousedown", () => {
      li.draggable = true;
    });
    // Keyboard path, so reordering doesn't require a mouse.
    grip.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveShortlistItem(index, index - 1, true);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        moveShortlistItem(index, index + 1, true);
      }
    });

    li.addEventListener("dragstart", (e) => {
      shortlistDragIndex = index;
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      // Firefox won't start a drag unless some data is set.
      e.dataTransfer.setData("text/plain", String(index));
    });
    li.addEventListener("dragend", () => {
      li.draggable = false;
      li.classList.remove("dragging");
      shortlistDragIndex = null;
      clearDropMarkers();
    });
    li.addEventListener("dragover", (e) => {
      if (shortlistDragIndex === null || shortlistDragIndex === index) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      clearDropMarkers();
      li.classList.add(shortlistDragIndex < index ? "drop-after" : "drop-before");
    });
    li.addEventListener("dragleave", () => {
      li.classList.remove("drop-before", "drop-after");
    });
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      clearDropMarkers();
      moveShortlistItem(shortlistDragIndex, index, false);
    });

    li.appendChild(grip);

    const title = document.createElement("span");
    title.className = "si-title";
    title.textContent = item.title || item.videoId || item.playlistId;
    title.title = kind === "playlist" ? "Load this playlist" : "Play";
    title.addEventListener("click", () => {
      if (kind === "playlist") {
        playPlaylistById(item.playlistId);
      } else {
        playSingleVideo(item.videoId, item.title);
      }
    });

    if (kind === "playlist") {
      const badge = document.createElement("span");
      badge.className = "si-badge";
      badge.textContent = "Playlist";
      li.appendChild(badge);
    }

    const renameBtn = document.createElement("button");
    renameBtn.className = "si-action";
    renameBtn.textContent = "✎";
    renameBtn.title = "Rename";
    renameBtn.setAttribute("aria-label", `Rename ${item.title || ""}`);
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      beginRename(item, title);
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "si-action si-remove";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", () => {
      state.shortlist = state.shortlist.filter((x) => x.id !== item.id);
      saveShortlist(state.shortlist);
      renderShortlist();
      updateSavePlaylistBtn();
    });

    li.appendChild(title);
    li.appendChild(renameBtn);
    li.appendChild(removeBtn);
    el.shortlistItems.appendChild(li);
  });
}

// A blank name now resolves to the video's real title instead of
// "Untitled soundscape", so pasted and searched entries look the same.
async function addToShortlist(videoId, customTitle, url) {
  let title = customTitle;
  if (!title) {
    title = state.titleCache[videoId] || (await fetchVideoTitle(videoId)) || "";
    if (title && !state.titleCache[videoId]) {
      state.titleCache[videoId] = title;
      saveTitleCache(state.titleCache);
    }
  }
  state.shortlist.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: title || "Untitled soundscape",
    videoId,
    url: url || `https://www.youtube.com/watch?v=${videoId}`,
  });
  saveShortlist(state.shortlist);
  renderShortlist();
}

// Swaps the title for an input in place. Auto-generated playlists have no
// title to look up, so a name you choose is often the only good one.
function beginRename(item, titleEl) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "si-rename";
  input.value = item.title || "";
  input.setAttribute("aria-label", "New name");

  let settled = false;
  const finish = (commit) => {
    if (settled) return; // blur fires again after Enter re-renders
    settled = true;
    const next = input.value.trim();
    // An empty name would leave an unclickable blank row, so keep the old one.
    if (commit && next && next !== item.title) {
      item.title = next;
      saveShortlist(state.shortlist);
    }
    renderShortlist();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));

  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

// One field for everything. What it does depends on what you give it:
//   - a playlist link loads and plays it — from the linked video, when a
//     watch URL carries both v= and list=, which is almost always what
//     copying such a link means;
//   - a video link saves it to the library;
//   - something that only looks like a link is flagged, not searched;
//   - anything else searches for videos and playlists together.
function attachAddFormEvents() {
  el.addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const raw = el.addInput.value.trim();
    if (!raw) return;

    const words = looksLikeWords(raw);
    const videoId = words ? null : parseVideoId(raw);
    // A bare 11-character string is a video ID, even one that happens to
    // start with a playlist prefix like "PL".
    const listId = /^[a-zA-Z0-9_-]{11}$/.test(raw) ? null : parsePlaylistId(raw);

    if (listId) {
      clearResults();
      el.addForm.reset();
      playPlaylistById(listId, { startVideoId: videoId });
      return;
    }

    if (videoId) {
      clearResults();
      el.addForm.reset();
      await addToShortlist(videoId, "", raw);
      return;
    }

    if (looksLikeUrl(raw)) {
      flashInvalid(el.addInput);
      return;
    }

    runSearch(raw);
  });
}

function flashInvalid(inputEl) {
  inputEl.classList.add("invalid");
  setTimeout(() => {
    inputEl.classList.remove("invalid");
  }, 1200);
}

// ---------- Playlist track list ----------
// YouTube's IFrame API hands us the playlist as bare video IDs, and there's
// no titles in it. Rather than take on an API key and a Data API quota just
// for names, we resolve each title from YouTube's public oEmbed endpoint
// (no key, CORS-enabled) and cache the results in localStorage.

const OEMBED_ENDPOINT = "https://www.youtube.com/oembed";
// Enough to fill a list quickly without opening dozens of sockets at once.
const TITLE_FETCH_BATCH = 4;

function clearPlaylistTracks() {
  if (state.playlist.pollId) {
    clearInterval(state.playlist.pollId);
    state.playlist.pollId = null;
  }
  state.playlist.id = null;
  state.playlist.ids = [];
  state.playlist.index = -1;
  state.playlist.loadToken += 1;
  state.playlist.awaitingTurnover = false;
  state.playlist.previousSignature = "";
  state.playlist.pendingSignature = null;
  state.playlist.pendingStartVideoId = null;
  renderTrackList();
  updateSavePlaylistBtn();
}

// getPlaylist() returns null for a moment after loadPlaylist() while the
// player fetches it, so poll briefly rather than reading it once.
function watchForPlaylistTracks() {
  if (state.playlist.pollId) clearInterval(state.playlist.pollId);
  let tries = 0;
  state.playlist.pollId = setInterval(() => {
    tries += 1;
    if (syncPlaylistState()) {
      clearInterval(state.playlist.pollId);
      state.playlist.pollId = null;
    } else if (tries > 40) {
      clearInterval(state.playlist.pollId);
      state.playlist.pollId = null;
      // Out of patience: a playlist whose tracks genuinely match the previous
      // one would otherwise look like a failure, so take what the player has
      // before concluding nothing loaded.
      state.playlist.awaitingTurnover = false;
      if (!syncPlaylistState()) onPlaylistLoadFailed();
    }
  }, 300);
}

// A private, deleted or mistyped playlist just never arrives — the player
// reports no error — so say so rather than sitting on "Loading playlist…".
function onPlaylistLoadFailed() {
  if (state.playlist.ids.length > 0) return;
  el.npTitle.textContent = "Couldn't load that playlist";
  el.npSub.textContent = "Check the link — it may be private or unlisted.";
}

// Pulls the current track order and position off the player. Returns true
// once a non-empty playlist is available.
function syncPlaylistState() {
  if (state.mode !== "playlist" || !state.playerReady) return false;

  let ids = null;
  let index = -1;
  let loadedId = null;
  try {
    ids = state.player.getPlaylist();
    index = state.player.getPlaylistIndex();
    loadedId = state.player.getPlaylistId();
  } catch (e) {
    return false;
  }
  if (!Array.isArray(ids) || ids.length === 0) return false;

  // Two separate staleness problems after loadPlaylist():
  //
  //   1. getPlaylistId() can still name the outgoing playlist.
  //   2. getPlaylistId() flips to the new one BEFORE getPlaylist() catches
  //      up, so "the ids agree" is not enough on its own — the track array
  //      can still belong to the playlist we just left.
  //
  // So wait for the id to match *and* for the contents to actually turn over
  // from what the previous playlist had. Accepting early is what made
  // switching between presets show the wrong tracks.
  if (state.playlist.id && loadedId && loadedId !== state.playlist.id) return false;

  // getPlaylist() lags getPlaylistId() by roughly one load, so reads taken
  // right after loadPlaylist() can describe the playlist we just left. Give
  // the player a moment before trusting anything.
  if (Date.now() - state.playlist.loadedAt < PLAYLIST_SETTLE_MS) return false;

  const signature = ids.join(",");
  if (state.playlist.awaitingTurnover && signature === state.playlist.previousSignature) {
    return false;
  }

  // ...and require the same answer twice running. A lagging read changes as
  // the player catches up, so a repeated one is settled. This is belt and
  // braces on top of the settle window: switching playlists quickly used to
  // show the previous playlist's tracks under the new playlist's name.
  if (state.playlist.pendingSignature !== signature) {
    state.playlist.pendingSignature = signature;
    return false;
  }

  state.playlist.awaitingTurnover = false;

  const isNewPlaylist = signature !== state.playlist.ids.join(",");
  const movedTrack = index !== state.playlist.index;
  state.playlist.ids = ids;
  state.playlist.index = index;

  if (movedTrack && state.playlist.id) {
    saveSession({ mode: "playlist", playlistId: state.playlist.id, index });
  }

  if (isNewPlaylist || movedTrack) {
    renderTrackList();
    // The poll is the only signal we get when autoplay is blocked — no
    // PLAYING/CUED event ever fires — so refresh the label here too, or the
    // header sits on "Loading playlist…" over a fully loaded playlist.
    updateNowPlayingFromPlayer();
  }
  if (isNewPlaylist) fetchTrackTitles(ids, state.playlist.loadToken);

  if (isNewPlaylist && state.playlist.pendingStartVideoId) {
    const startAt = ids.indexOf(state.playlist.pendingStartVideoId);
    state.playlist.pendingStartVideoId = null;
    // Auto-generated playlists can reshuffle per load, so the video may not
    // be in this run of it at all; then just play from the top.
    if (startAt > 0) playTrackAt(startAt);
  }
  return true;
}

function playlistPositionLabel() {
  const total = state.playlist.ids.length;
  if (total === 0 || state.playlist.index < 0) return "Playing from playlist";
  return `Track ${state.playlist.index + 1} of ${total}`;
}

function trackTitleFor(videoId) {
  return state.titleCache[videoId] || videoId;
}

// oEmbed 401s on restricted videos, but the player still reports their title.
// Keeping it means the track list shows a name instead of a raw ID.
function rememberTitle(videoId, title) {
  if (!videoId || !title || state.titleCache[videoId]) return;
  state.titleCache[videoId] = title;
  saveTitleCache(state.titleCache);
}

function renderTrackList() {
  el.trackList.innerHTML = "";

  const ids = state.playlist.ids;
  if (ids.length === 0) {
    el.trackListWrap.hidden = true;
    return;
  }

  el.trackListWrap.hidden = false;
  el.trackCount.textContent = `${ids.length} track${ids.length === 1 ? "" : "s"}`;
  applyTracksDrawerState();

  ids.forEach((videoId, i) => {
    const isCurrent = i === state.playlist.index;
    const isUnplayable = unplayableVideos.has(videoId);

    const li = document.createElement("li");
    li.className = "track-item";
    if (isCurrent) li.classList.add("current");
    if (isUnplayable) li.classList.add("unavailable");
    li.title = isUnplayable ? "YouTube won't play this one here" : "Play this track";

    const num = document.createElement("span");
    num.className = "tr-num";
    num.textContent = isCurrent ? "▶" : String(i + 1);

    const title = document.createElement("span");
    title.className = "tr-title";
    title.textContent = trackTitleFor(videoId);

    li.appendChild(num);
    li.appendChild(title);

    if (isUnplayable) {
      const flag = document.createElement("span");
      flag.className = "tr-flag";
      flag.textContent = "unavailable";
      li.appendChild(flag);
    }
    li.addEventListener("click", () => playTrackAt(i));
    el.trackList.appendChild(li);

    // Keep the playing track visible as a playlist advances on its own.
    if (isCurrent) requestAnimationFrame(() => scrollTrackIntoList(li));
  });
}

// Scrolls the list itself, never the page. scrollIntoView() would also move
// the window, and with the list now in the player card that meant the page
// jumping every time a playlist advanced on its own overnight.
function scrollTrackIntoList(li) {
  const list = el.trackList;
  if (!list.clientHeight) return; // collapsed
  const top = li.offsetTop;
  const bottom = top + li.offsetHeight;
  if (top < list.scrollTop) {
    list.scrollTop = top;
  } else if (bottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = bottom - list.clientHeight;
  }
}

function applyTracksDrawerState() {
  const open = state.settings.tracksOpen !== false;
  el.trackListWrap.classList.toggle("collapsed", !open);
  el.toggleTracksBtn.setAttribute("aria-expanded", open ? "true" : "false");
}

function attachTracksDrawerEvents() {
  el.toggleTracksBtn.addEventListener("click", () => {
    state.settings.tracksOpen = state.settings.tracksOpen === false;
    saveSettings(state.settings);
    applyTracksDrawerState();
    if (state.settings.tracksOpen) {
      const current = el.trackList.querySelector(".track-item.current");
      if (current) scrollTrackIntoList(current);
    }
  });
  el.savePlaylistBtn.addEventListener("click", savePlaylistToShortlist);
}

function playTrackAt(i) {
  if (state.mode !== "playlist" || !state.playerReady) return;
  try {
    state.player.playVideoAt(i);
  } catch (e) {
    return;
  }
  // A track picked by hand shouldn't inherit an earlier run of auto-skips.
  state.skipStreak = 0;
  state.playlist.index = i;
  // Saved here, not left to syncPlaylistState(): having already set the
  // index above, the sync sees no movement and would never record it — so a
  // refresh after picking a track by hand came back to the wrong one.
  if (state.playlist.id) {
    saveSession({ mode: "playlist", playlistId: state.playlist.id, index: i });
  }
  renderTrackList();
  armPlaybackWatchdog();
}

// Resolves titles a batch at a time, re-rendering as each batch lands so a
// long playlist fills in progressively instead of sitting on video IDs.
async function fetchTrackTitles(ids, token) {
  const missing = ids.filter((id) => !state.titleCache[id]);
  if (missing.length === 0) return;

  for (let i = 0; i < missing.length; i += TITLE_FETCH_BATCH) {
    const batch = missing.slice(i, i + TITLE_FETCH_BATCH);
    const results = await Promise.all(batch.map(fetchVideoTitle));

    // A different playlist was loaded while we were waiting — drop these.
    if (token !== state.playlist.loadToken) return;

    let gotAny = false;
    results.forEach((title, n) => {
      if (title) {
        state.titleCache[batch[n]] = title;
        gotAny = true;
      }
    });

    if (gotAny) {
      saveTitleCache(state.titleCache);
      renderTrackList();
    }
  }
}

async function fetchOembedTitle(targetUrl) {
  const url = `${OEMBED_ENDPOINT}?url=${encodeURIComponent(targetUrl)}&format=json`;
  try {
    const res = await fetch(url);
    // 401/404 here means private, restricted or deleted.
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.title ? data.title : null;
  } catch (e) {
    return null;
  }
}

function fetchVideoTitle(videoId) {
  return fetchOembedTitle(`https://www.youtube.com/watch?v=${videoId}`);
}

// oEmbed answers for playlist URLs too, which is how a saved playlist gets a
// real name without the Data API. Cached under a prefixed key so it can't
// collide with a video ID.
async function fetchPlaylistTitle(playlistId) {
  const cacheKey = `pl:${playlistId}`;
  if (state.titleCache[cacheKey]) return state.titleCache[cacheKey];

  const title = await fetchOembedTitle(playlistUrlFor(playlistId));
  if (title) {
    state.titleCache[cacheKey] = title;
    saveTitleCache(state.titleCache);
  }
  return title;
}

function playlistUrlFor(playlistId) {
  return `https://www.youtube.com/playlist?list=${playlistId}`;
}

// ---------- Saving a playlist to the shortlist ----------

function playlistIsSaved(playlistId) {
  return state.shortlist.some((x) => x.playlistId === playlistId);
}

function updateSavePlaylistBtn() {
  const listId = state.playlist.id;
  if (!listId) {
    el.savePlaylistBtn.hidden = true;
    return;
  }
  const saved = playlistIsSaved(listId);
  el.savePlaylistBtn.hidden = false;
  el.savePlaylistBtn.disabled = saved;
  el.savePlaylistBtn.textContent = saved ? "Saved" : "Save playlist";
}

async function savePlaylistToShortlist() {
  const listId = state.playlist.id;
  if (!listId || playlistIsSaved(listId)) return;

  el.savePlaylistBtn.disabled = true;
  el.savePlaylistBtn.textContent = "Saving…";

  const title =
    (await fetchPlaylistTitle(listId)) ||
    `Playlist (${state.playlist.ids.length} tracks)`;

  state.shortlist.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: "playlist",
    title,
    playlistId: listId,
    url: playlistUrlFor(listId),
  });
  saveShortlist(state.shortlist);
  renderShortlist();
  updateSavePlaylistBtn();
}

// ---------- YouTube search ----------
// Search is the one thing here that can't be done without a key: YouTube's
// results page blocks cross-origin reads, and the IFrame API's old
// listType:"search" mode was removed. So this calls the official Data API
// with a key the user supplies in Settings, which is CORS-enabled and needs
// no backend. No key just means no search — every other flow is unaffected.

const SEARCH_ENDPOINT = "https://www.googleapis.com/youtube/v3/search";
const SEARCH_MAX_RESULTS = 12;

function hasApiKey() {
  return !!(state.settings.apiKey && state.settings.apiKey.trim());
}

// The API returns titles HTML-escaped ("Rain &amp; Thunder"). A detached
// textarea decodes them; the value is only ever used as textContent.
function decodeEntities(text) {
  const area = document.createElement("textarea");
  area.innerHTML = text;
  return area.value;
}

async function youtubeSearch(query) {
  // Videos and playlists in one request: same 100 quota units as searching
  // either alone. The cost is videoEmbeddable, which the API only accepts
  // with type=video exactly, so an unembeddable video can now appear in
  // results. The unplayable-video watchdog handles that if it's picked.
  const params = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video,playlist",
    maxResults: String(SEARCH_MAX_RESULTS),
    key: state.settings.apiKey.trim(),
  });

  let res;
  try {
    res = await fetch(`${SEARCH_ENDPOINT}?${params}`);
  } catch (e) {
    throw new Error("Couldn't reach YouTube — check your connection.");
  }

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const reason = data && data.error && data.error.errors && data.error.errors[0]
      ? data.error.errors[0].reason
      : "";
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      throw new Error("Today's search quota is used up — it resets at midnight Pacific.");
    }
    const message = (data && data.error && data.error.message) || "";
    // Only blame the key when Google does. A malformed query is also a 400,
    // and calling that a bad key would send you chasing the wrong problem.
    if (reason === "keyInvalid" || /api key/i.test(message)) {
      throw new Error("That API key was rejected. Check it in Settings.");
    }
    if (res.status === 403) {
      throw new Error("YouTube refused the search — make sure the Data API is enabled for this key.");
    }
    throw new Error((data && data.error && data.error.message) || `Search failed (${res.status}).`);
  }

  return (data && data.items) || [];
}

// Both result kinds normalize to the same shape so one renderer covers them.
function normalizeResult(item) {
  const snip = item.snippet || {};
  const thumbs = snip.thumbnails || {};
  const thumb = thumbs.medium || thumbs.default || {};
  return {
    videoId: item.id ? item.id.videoId : null,
    playlistId: item.id ? item.id.playlistId : null,
    title: decodeEntities(snip.title || "Untitled"),
    channel: decodeEntities(snip.channelTitle || ""),
    thumb: thumb.url || "",
  };
}

function showResultsMessage(message) {
  el.searchResults.hidden = false;
  el.searchResultList.innerHTML = "";
  const li = document.createElement("li");
  li.className = "result-message";
  li.textContent = message;
  el.searchResultList.appendChild(li);
}

function clearResults() {
  // Bumping the token cancels an in-flight search, so results the user has
  // already dismissed can't reappear when the response lands.
  state.search.token += 1;
  el.searchResults.hidden = true;
  el.searchResultList.innerHTML = "";
}

async function runSearch(query) {
  if (!hasApiKey()) {
    showResultsMessage(
      "Searching needs a YouTube API key — add one in Settings (the gear, top right). Pasting links works without it."
    );
    return;
  }
  if (state.search.busy) return;

  const token = ++state.search.token;
  state.search.busy = true;

  el.searchResultsLabel.textContent = `Results for "${query}"`;
  showResultsMessage("Searching…");

  try {
    const items = await youtubeSearch(query);
    if (token !== state.search.token) return; // a newer search won
    // Anything that's neither (a channel slipping through) has nothing to play.
    const results = items.map(normalizeResult).filter((r) => r.videoId || r.playlistId);
    if (results.length === 0) {
      showResultsMessage(`Nothing found for "${query}".`);
      return;
    }
    renderResults(results);
  } catch (e) {
    if (token !== state.search.token) return;
    showResultsMessage(e.message);
    flashInvalid(el.addInput);
  } finally {
    state.search.busy = false;
  }
}

function renderResults(results) {
  el.searchResults.hidden = false;
  el.searchResultList.innerHTML = "";

  results.forEach((r) => {
    const isPlaylist = !!r.playlistId;
    const li = document.createElement("li");
    li.className = "result-item";

    if (r.thumb) {
      const img = document.createElement("img");
      img.className = "res-thumb";
      img.src = r.thumb;
      img.alt = "";
      img.loading = "lazy";
      // Deleted videos can 404 their thumbnail; drop it rather than showing
      // a broken-image glyph.
      img.addEventListener("error", () => img.remove());
      li.appendChild(img);
    }

    const text = document.createElement("div");
    text.className = "res-text";

    const title = document.createElement("div");
    title.className = "res-title";
    title.textContent = r.title;

    const channel = document.createElement("div");
    channel.className = "res-channel";
    channel.textContent = isPlaylist ? `Playlist · ${r.channel}` : r.channel;

    text.appendChild(title);
    text.appendChild(channel);
    li.appendChild(text);

    // Clicking plays it straight away; saving is the deliberate extra step.
    li.title = isPlaylist ? "Play this playlist" : "Play now";
    li.addEventListener("click", () => {
      if (isPlaylist) playPlaylistById(r.playlistId);
      else playSingleVideo(r.videoId, r.title);
    });

    const save = document.createElement("button");
    save.type = "button";
    save.className = "res-save";
    save.title = "Add to your library";
    const saved = isResultSaved(r);
    save.textContent = saved ? "Saved" : "Save";
    save.disabled = saved;
    save.addEventListener("click", (e) => {
      e.stopPropagation();
      saveSearchResult(r, save);
    });
    li.appendChild(save);

    el.searchResultList.appendChild(li);
  });
}

function isResultSaved(result) {
  return result.playlistId
    ? playlistIsSaved(result.playlistId)
    : state.shortlist.some((x) => x.videoId === result.videoId);
}

function saveSearchResult(result, button) {
  if (!isResultSaved(result)) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Search hands us the playlist's real title, which matters for the
    // auto-generated ones oEmbed can't name.
    state.shortlist.push(
      result.playlistId
        ? { id, kind: "playlist", title: result.title, playlistId: result.playlistId, url: playlistUrlFor(result.playlistId) }
        : { id, kind: "video", title: result.title, videoId: result.videoId, url: `https://www.youtube.com/watch?v=${result.videoId}` }
    );
    saveShortlist(state.shortlist);
    renderShortlist();
    updateSavePlaylistBtn();
  }
  button.textContent = "Saved";
  button.disabled = true;
}

function attachSearchEvents() {
  el.searchResultsClose.addEventListener("click", clearResults);
}

// ---------- Settings overlay ----------

function openSettings() {
  el.defaultTimerInput.value = state.settings.defaultTimerMinutes;
  el.fadeSecondsInput.value = state.settings.fadeSeconds;
  el.autoArmInput.checked = state.settings.autoArm;
  el.skipStepInput.value = state.settings.skipStep;
  el.apiKeyInput.value = state.settings.apiKey;
  el.settingsOverlay.classList.remove("hidden");
}

function closeSettings() {
  if (persistSettingsFromForm) persistSettingsFromForm();
  el.settingsOverlay.classList.add("hidden");
}

function attachSettingsEvents() {
  el.settingsBtn.addEventListener("click", openSettings);
  el.closeSettingsBtn.addEventListener("click", closeSettings);
  el.settingsOverlay.addEventListener("click", (e) => {
    if (e.target === el.settingsOverlay) closeSettings();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSettings();
  });

  const persist = () => {
    state.settings.defaultTimerMinutes = clampNumber(el.defaultTimerInput.value, 1, 300, DEFAULT_SETTINGS.defaultTimerMinutes);
    state.settings.fadeSeconds = clampNumber(el.fadeSecondsInput.value, 0, 120, DEFAULT_SETTINGS.fadeSeconds);
    state.settings.autoArm = el.autoArmInput.checked;
    state.settings.skipStep = clampNumber(el.skipStepInput.value, 5, 120, DEFAULT_SETTINGS.skipStep);
    state.settings.apiKey = el.apiKeyInput.value.trim();
    saveSettings(state.settings);
    updateTimerUI();
  };

  // "change" alone only fires on blur or Enter, so a value typed and then
  // abandoned by closing the panel (Escape especially) was silently lost.
  // "input" fires on every keystroke, and closeSettings() persists again as
  // a backstop for any path that skips both.
  [el.defaultTimerInput, el.fadeSecondsInput, el.skipStepInput, el.apiKeyInput].forEach((input) => {
    input.addEventListener("change", persist);
    input.addEventListener("input", persist);
  });
  el.autoArmInput.addEventListener("change", persist);
  persistSettingsFromForm = persist;
}

// Assigned by attachSettingsEvents so closeSettings() can flush the form.
let persistSettingsFromForm = null;

function clampNumber(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ---------- Init ----------

function init() {
  attachScrubEvents();
  attachTransportEvents();
  attachTimerEvents();
  attachAddFormEvents();
  attachTracksDrawerEvents();
  attachSettingsEvents();
  attachVideoToggleEvents();
  attachSearchEvents();
  attachKeyboardShortcuts();

  setTransportPlaylistMode(false);
  applyVideoVisibility();
  mergeNewPresets();
  renderShortlist();
  updateSavePlaylistBtn();
  updateTimerUI();
}

document.addEventListener("DOMContentLoaded", init);
