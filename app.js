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
};

const DEFAULT_SETTINGS = {
  defaultTimerMinutes: 15,
  fadeSeconds: 30,
  autoArm: true,
  skipStep: 30,
  // Supplied by the user in Settings; enables search. Empty by default, and
  // everything except search works fine without it.
  apiKey: "",
  // The video is dead weight for a soundscape and bright at bedtime, so it
  // stays collapsed until asked for. Remembered between nights.
  showVideo: false,
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

// Seeded on first run only. Once anything has been saved — including an
// empty list after deleting everything — the stored value wins and this is
// never consulted again.
const DEFAULT_SHORTLIST = [
  {
    id: "seed-nature-sounds",
    kind: "playlist",
    title: "Sleepscape — Nature Sounds",
    playlistId: "PLYHw0b71CtIQ",
    url: "https://www.youtube.com/playlist?list=PLYHw0b71CtIQ",
  },
];

function loadShortlist() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.shortlist);
    if (!raw) return DEFAULT_SHORTLIST.map((item) => ({ ...item }));
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
  addShortlistForm: document.getElementById("addShortlistForm"),
  addTitle: document.getElementById("addTitle"),
  addUrl: document.getElementById("addUrl"),
  playlistForm: document.getElementById("playlistForm"),
  playlistUrl: document.getElementById("playlistUrl"),
  videoResults: document.getElementById("videoResults"),
  videoResultList: document.getElementById("videoResultList"),
  videoResultsLabel: document.getElementById("videoResultsLabel"),
  videoResultsClose: document.getElementById("videoResultsClose"),
  playlistResults: document.getElementById("playlistResults"),
  playlistResultList: document.getElementById("playlistResultList"),
  playlistResultsLabel: document.getElementById("playlistResultsLabel"),
  playlistResultsClose: document.getElementById("playlistResultsClose"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsOverlay: document.getElementById("settingsOverlay"),
  closeSettingsBtn: document.getElementById("closeSettingsBtn"),
  defaultTimerInput: document.getElementById("defaultTimerInput"),
  fadeSecondsInput: document.getElementById("fadeSecondsInput"),
  autoArmInput: document.getElementById("autoArmInput"),
  skipStepInput: document.getElementById("skipStepInput"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  tabBtns: document.querySelectorAll(".tab-btn"),
};

// ---------- YouTube player ----------

// Called automatically by the IFrame API script once it has loaded.
window.onYouTubeIframeAPIReady = function () {
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
};

function onPlayerReady() {
  state.playerReady = true;
  state.player.setVolume(100);
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

function playSingleVideo(videoId, title) {
  if (!state.playerReady) return;
  state.mode = "single";
  el.npTitle.textContent = title || "Loading…";
  el.npSub.textContent = "Playing";
  setTransportPlaylistMode(false);
  clearPlaylistTracks();
  restorePlayerVolume();
  state.player.loadVideoById(videoId);
  armPlaybackWatchdog();
}

function playPlaylistById(playlistId) {
  if (!state.playerReady) return;
  state.mode = "playlist";
  el.npTitle.textContent = "Loading playlist…";
  el.npSub.textContent = "";
  setTransportPlaylistMode(true);
  clearPlaylistTracks();
  state.playlist.id = playlistId;
  state.skipStreak = 0;
  restorePlayerVolume();
  state.player.loadPlaylist({ listType: "playlist", list: playlistId });
  watchForPlaylistTracks();
  armPlaybackWatchdog();
  updateSavePlaylistBtn();
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

function attachTransportEvents() {
  el.playPauseBtn.addEventListener("click", togglePlayPause);
  el.skipBackBtn.addEventListener("click", () => skipBy(-state.settings.skipStep));
  el.skipFwdBtn.addEventListener("click", () => skipBy(state.settings.skipStep));
  el.prevBtn.addEventListener("click", () => {
    if (state.mode === "playlist" && state.playerReady) state.player.previousVideo();
  });
  el.nextBtn.addEventListener("click", () => {
    if (state.mode === "playlist" && state.playerReady) state.player.nextVideo();
  });
}

// ---------- Sleep timer ----------
// Runs on wall-clock time, independent of play/pause, so pausing to use
// the bathroom doesn't quietly extend your night. It arms itself the
// first time playback starts in a session — no extra taps needed.

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
    el.timerStatus.textContent = fading
      ? `fading out — ${formatTime(state.timer.remaining)} left`
      : `${formatTime(state.timer.remaining)} remaining`;
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

  state.shortlist.forEach((item) => {
    const kind = shortlistKind(item);

    const li = document.createElement("li");
    li.className = "shortlist-item";

    const title = document.createElement("span");
    title.className = "si-title";
    title.textContent = item.title || item.videoId || item.playlistId;
    title.title = kind === "playlist" ? "Load this playlist" : "Play";
    title.addEventListener("click", () => {
      if (kind === "playlist") {
        // Switch tabs so the track list is visible for what just loaded.
        activateTab("playlist");
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

    const removeBtn = document.createElement("button");
    removeBtn.className = "si-remove";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", () => {
      state.shortlist = state.shortlist.filter((x) => x.id !== item.id);
      saveShortlist(state.shortlist);
      renderShortlist();
      updateSavePlaylistBtn();
    });

    li.appendChild(title);
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

function attachShortlistEvents() {
  // One field, two jobs: a link is saved, anything else is searched.
  el.addShortlistForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const raw = el.addUrl.value.trim();
    if (!raw) return;

    const videoId = looksLikeWords(raw) ? null : parseVideoId(raw);

    if (videoId) {
      clearResults("video");
      const customTitle = el.addTitle.value.trim();
      el.addShortlistForm.reset();
      await addToShortlist(videoId, customTitle, raw);
      return;
    }

    // Clearly meant as a link but unparseable — say so rather than searching.
    if (looksLikeUrl(raw)) {
      flashInvalid(el.addUrl);
      return;
    }

    runSearch(raw, "video", el.addUrl);
  });
}

function attachPlaylistFormEvents() {
  // Same split as the shortlist field: a link loads, words search.
  el.playlistForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = el.playlistUrl.value.trim();
    if (!raw) return;

    const listId = parsePlaylistId(raw);
    if (listId) {
      clearResults("playlist");
      playPlaylistById(listId);
      return;
    }

    if (looksLikeUrl(raw)) {
      flashInvalid(el.playlistUrl);
      return;
    }

    runSearch(raw, "playlist", el.playlistUrl);
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
    } else if (tries > 25) {
      clearInterval(state.playlist.pollId);
      state.playlist.pollId = null;
      onPlaylistLoadFailed();
    }
  }, 300);
}

// A private, deleted or mistyped playlist just never arrives — the player
// reports no error — so say so rather than sitting on "Loading playlist…".
function onPlaylistLoadFailed() {
  if (state.playlist.ids.length > 0) return;
  el.npTitle.textContent = "Couldn't load that playlist";
  el.npSub.textContent = "Check the link — it may be private or unlisted.";
  flashInvalid(el.playlistUrl);
}

// Pulls the current track order and position off the player. Returns true
// once a non-empty playlist is available.
function syncPlaylistState() {
  if (state.mode !== "playlist" || !state.playerReady) return false;

  let ids = null;
  let index = -1;
  try {
    ids = state.player.getPlaylist();
    index = state.player.getPlaylistIndex();
  } catch (e) {
    return false;
  }
  if (!Array.isArray(ids) || ids.length === 0) return false;

  const isNewPlaylist = ids.join(",") !== state.playlist.ids.join(",");
  const movedTrack = index !== state.playlist.index;
  state.playlist.ids = ids;
  state.playlist.index = index;

  if (isNewPlaylist || movedTrack) {
    renderTrackList();
    // The poll is the only signal we get when autoplay is blocked — no
    // PLAYING/CUED event ever fires — so refresh the label here too, or the
    // header sits on "Loading playlist…" over a fully loaded playlist.
    updateNowPlayingFromPlayer();
  }
  if (isNewPlaylist) fetchTrackTitles(ids, state.playlist.loadToken);
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
    if (isCurrent) {
      requestAnimationFrame(() => li.scrollIntoView({ block: "nearest" }));
    }
  });
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

async function youtubeSearch(query, type) {
  const params = new URLSearchParams({
    part: "snippet",
    q: query,
    type,
    maxResults: String(SEARCH_MAX_RESULTS),
    key: state.settings.apiKey.trim(),
  });
  // Only offer results the embedded player can actually play.
  if (type === "video") params.set("videoEmbeddable", "true");

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
    if (reason === "keyInvalid" || reason === "badRequest" || res.status === 400) {
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

function resultPanelFor(kind) {
  return kind === "video"
    ? { wrap: el.videoResults, list: el.videoResultList, label: el.videoResultsLabel }
    : { wrap: el.playlistResults, list: el.playlistResultList, label: el.playlistResultsLabel };
}

function showResultsMessage(kind, message) {
  const panel = resultPanelFor(kind);
  panel.wrap.hidden = false;
  panel.list.innerHTML = "";
  const li = document.createElement("li");
  li.className = "result-message";
  li.textContent = message;
  panel.list.appendChild(li);
}

function clearResults(kind) {
  // Bumping the token cancels an in-flight search, so results the user has
  // already dismissed can't reappear when the response lands.
  state.search.token += 1;
  const panel = resultPanelFor(kind);
  panel.wrap.hidden = true;
  panel.list.innerHTML = "";
}

// Shared entry point: validate, show progress, hand off to the renderer.
async function runSearch(query, kind, inputEl) {
  if (!hasApiKey()) {
    showResultsMessage(
      kind,
      "Searching needs a YouTube API key — add one in Settings (the gear, top right). Pasting links works without it."
    );
    return;
  }
  if (state.search.busy) return;

  const token = ++state.search.token;
  state.search.busy = true;

  const panel = resultPanelFor(kind);
  panel.label.textContent = `Results for "${query}"`;
  showResultsMessage(kind, "Searching…");

  try {
    const items = await youtubeSearch(query, kind === "video" ? "video" : "playlist");
    if (token !== state.search.token) return; // a newer search won
    if (items.length === 0) {
      showResultsMessage(kind, `Nothing found for "${query}".`);
      return;
    }
    renderResults(kind, items.map(normalizeResult));
  } catch (e) {
    if (token !== state.search.token) return;
    showResultsMessage(kind, e.message);
    flashInvalid(inputEl);
  } finally {
    state.search.busy = false;
  }
}

function renderResults(kind, results) {
  const panel = resultPanelFor(kind);
  panel.wrap.hidden = false;
  panel.list.innerHTML = "";

  results.forEach((r) => {
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
    channel.textContent = r.channel;

    text.appendChild(title);
    text.appendChild(channel);
    li.appendChild(text);

    if (kind === "video") {
      // Clicking plays it straight away; saving is the deliberate extra step.
      li.title = "Play now";
      li.addEventListener("click", () => playSingleVideo(r.videoId, r.title));

      const save = document.createElement("button");
      save.type = "button";
      save.className = "res-save";
      save.textContent = "Save";
      save.title = "Add to My Soundscapes";
      save.addEventListener("click", (e) => {
        e.stopPropagation();
        saveSearchResult(r, save);
      });
      li.appendChild(save);
    } else {
      li.title = "Load this playlist";
      li.addEventListener("click", () => {
        playPlaylistById(r.playlistId);
        el.playlistUrl.value = "";
      });
    }

    panel.list.appendChild(li);
  });
}

function saveSearchResult(result, button) {
  const already = state.shortlist.some((x) => x.videoId === result.videoId);
  if (already) {
    button.textContent = "Saved";
    button.disabled = true;
    return;
  }
  state.shortlist.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: result.title,
    videoId: result.videoId,
    url: `https://www.youtube.com/watch?v=${result.videoId}`,
  });
  saveShortlist(state.shortlist);
  renderShortlist();
  button.textContent = "Saved";
  button.disabled = true;
}

function attachSearchEvents() {
  el.savePlaylistBtn.addEventListener("click", savePlaylistToShortlist);
  el.videoResultsClose.addEventListener("click", () => clearResults("video"));
  el.playlistResultsClose.addEventListener("click", () => clearResults("playlist"));
}

// ---------- Tabs ----------

function activateTab(name) {
  el.tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.add("hidden"));
  document.getElementById(`tab-${name}`).classList.remove("hidden");
}

function attachTabEvents() {
  el.tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });
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

  [el.defaultTimerInput, el.fadeSecondsInput, el.skipStepInput, el.apiKeyInput].forEach((input) => {
    input.addEventListener("change", persist);
  });
  el.autoArmInput.addEventListener("change", persist);
}

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
  attachShortlistEvents();
  attachPlaylistFormEvents();
  attachTabEvents();
  attachSettingsEvents();
  attachVideoToggleEvents();
  attachSearchEvents();

  setTransportPlaylistMode(false);
  applyVideoVisibility();
  renderShortlist();
  updateSavePlaylistBtn();
  updateTimerUI();
}

document.addEventListener("DOMContentLoaded", init);
