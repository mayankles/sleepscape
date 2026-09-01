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
};

const DEFAULT_SETTINGS = {
  defaultTimerMinutes: 45,
  fadeSeconds: 30,
  autoArm: true,
  skipStep: 30,
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

  if (/^[a-zA-Z0-9_-]{10,64}$/.test(trimmed)) return trimmed;
  return null;
}

// ---------- App state ----------

const state = {
  settings: loadSettings(),
  shortlist: loadShortlist(),
  player: null,
  playerReady: false,
  mode: null, // 'single' | 'playlist'
  isDragging: false,
  scrubTimer: null,
  timer: {
    armed: false,
    remaining: 0, // seconds
    intervalId: null,
  },
};

// ---------- DOM refs ----------

const el = {
  ytPlayer: document.getElementById("ytPlayer"),
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
  shortlistItems: document.getElementById("shortlistItems"),
  addShortlistForm: document.getElementById("addShortlistForm"),
  addTitle: document.getElementById("addTitle"),
  addUrl: document.getElementById("addUrl"),
  playlistForm: document.getElementById("playlistForm"),
  playlistUrl: document.getElementById("playlistUrl"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsOverlay: document.getElementById("settingsOverlay"),
  closeSettingsBtn: document.getElementById("closeSettingsBtn"),
  defaultTimerInput: document.getElementById("defaultTimerInput"),
  fadeSecondsInput: document.getElementById("fadeSecondsInput"),
  autoArmInput: document.getElementById("autoArmInput"),
  skipStepInput: document.getElementById("skipStepInput"),
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

  if (event.data === PlayerState.PLAYING) {
    el.playPauseBtn.textContent = "❚❚";
    startScrubLoop();
    maybeAutoArmTimer();
    updateNowPlayingFromPlayer();
  } else if (event.data === PlayerState.PAUSED) {
    el.playPauseBtn.textContent = "▶";
  } else if (event.data === PlayerState.ENDED) {
    el.playPauseBtn.textContent = "▶";
  } else if (event.data === PlayerState.CUED) {
    updateNowPlayingFromPlayer();
  }
}

function updateNowPlayingFromPlayer() {
  try {
    const data = state.player.getVideoData();
    if (data && data.title) {
      el.npTitle.textContent = data.title;
      el.npSub.textContent =
        state.mode === "playlist" ? "Playing from playlist" : "Playing";
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
  state.player.setVolume(100);
  state.player.loadVideoById(videoId);
}

function playPlaylistById(playlistId) {
  if (!state.playerReady) return;
  state.mode = "playlist";
  el.npTitle.textContent = "Loading playlist…";
  el.npSub.textContent = "";
  setTransportPlaylistMode(true);
  state.player.setVolume(100);
  state.player.loadPlaylist({ listType: "playlist", list: playlistId });
}

function setTransportPlaylistMode(isPlaylist) {
  el.prevBtn.disabled = !isPlaylist;
  el.nextBtn.disabled = !isPlaylist;
  el.prevBtn.style.opacity = isPlaylist ? "1" : "0.35";
  el.nextBtn.style.opacity = isPlaylist ? "1" : "0.35";
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
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
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
    armTimer(minutes * 60);
    return;
  }
  // If we were mid fade-out (or already ended), extending restores volume.
  if (state.playerReady) {
    try {
      state.player.setVolume(100);
    } catch (e) {}
  }
  state.timer.remaining += minutes * 60;
  updateTimerUI();
}

function cancelTimer() {
  state.timer.armed = false;
  state.timer.remaining = 0;
  if (state.timer.intervalId) {
    clearInterval(state.timer.intervalId);
    state.timer.intervalId = null;
  }
  if (state.playerReady) {
    try {
      state.player.setVolume(100);
    } catch (e) {}
  }
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
    setTimeout(() => {
      if (state.playerReady) {
        try {
          state.player.setVolume(100);
        } catch (e) {}
      }
    }, 500);
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
      : "off — tap +10m to start";
    el.cancelTimerBtn.hidden = true;
  }
}

function attachTimerEvents() {
  document.querySelectorAll(".chip[data-add-min]").forEach((btn) => {
    btn.addEventListener("click", () => {
      addMinutesToTimer(parseInt(btn.dataset.addMin, 10));
    });
  });
  el.cancelTimerBtn.addEventListener("click", cancelTimer);
}

// ---------- Shortlist ----------

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
    const li = document.createElement("li");
    li.className = "shortlist-item";

    const title = document.createElement("span");
    title.className = "si-title";
    title.textContent = item.title || item.videoId;
    title.title = "Play";
    title.addEventListener("click", () => playSingleVideo(item.videoId, item.title));

    const removeBtn = document.createElement("button");
    removeBtn.className = "si-remove";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", () => {
      state.shortlist = state.shortlist.filter((x) => x.id !== item.id);
      saveShortlist(state.shortlist);
      renderShortlist();
    });

    li.appendChild(title);
    li.appendChild(removeBtn);
    el.shortlistItems.appendChild(li);
  });
}

function attachShortlistEvents() {
  el.addShortlistForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const videoId = parseVideoId(el.addUrl.value);
    if (!videoId) {
      flashInvalid(el.addUrl);
      return;
    }
    const title = el.addTitle.value.trim() || "Untitled soundscape";
    state.shortlist.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      videoId,
      url: el.addUrl.value.trim(),
    });
    saveShortlist(state.shortlist);
    renderShortlist();
    el.addShortlistForm.reset();
  });
}

function attachPlaylistFormEvents() {
  el.playlistForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const listId = parsePlaylistId(el.playlistUrl.value);
    if (!listId) {
      flashInvalid(el.playlistUrl);
      return;
    }
    playPlaylistById(listId);
  });
}

function flashInvalid(inputEl) {
  inputEl.style.borderColor = "#ff6b6b";
  setTimeout(() => {
    inputEl.style.borderColor = "";
  }, 1200);
}

// ---------- Tabs ----------

function attachTabEvents() {
  el.tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      el.tabBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.add("hidden"));
      document.getElementById(`tab-${btn.dataset.tab}`).classList.remove("hidden");
    });
  });
}

// ---------- Settings overlay ----------

function openSettings() {
  el.defaultTimerInput.value = state.settings.defaultTimerMinutes;
  el.fadeSecondsInput.value = state.settings.fadeSeconds;
  el.autoArmInput.checked = state.settings.autoArm;
  el.skipStepInput.value = state.settings.skipStep;
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
    saveSettings(state.settings);
    updateTimerUI();
  };

  [el.defaultTimerInput, el.fadeSecondsInput, el.skipStepInput].forEach((input) => {
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

  setTransportPlaylistMode(false);
  renderShortlist();
  updateTimerUI();
}

document.addEventListener("DOMContentLoaded", init);
