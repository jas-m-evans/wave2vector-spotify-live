import { Room, RoomEvent } from "https://esm.sh/livekit-client@2.15.3";

const debugEl = document.getElementById("debug");
const recEl = document.getElementById("recommendations");
const profileEl = document.getElementById("profile");
const diversityInput = document.getElementById("diversity");
const tasteWeightInput = document.getElementById("taste-weight");
const kInput = document.getElementById("k");
const diversityValueEl = document.getElementById("diversity-value");
const tasteWeightValueEl = document.getElementById("taste-weight-value");
const loginBtn = document.getElementById("login");
const refreshBtn = document.getElementById("refresh");
const modeLiveBtn = document.getElementById("mode-live");
const modeBatchBtn = document.getElementById("mode-batch");
const syncStatusEl = document.getElementById("sync-status");
const syncPercentEl = document.getElementById("sync-percent");
const syncMeterFillEl = document.getElementById("sync-meter-fill");
const syncLogEl = document.getElementById("sync-log");
const syncPhasesEl = document.getElementById("sync-phases");
const modelInsightsEl = document.getElementById("model-insights");
const recommendationMapEl = document.getElementById("recommendation-map");

const roomNameInput = document.getElementById("room-name");
const participantNameInput = document.getElementById("participant-name");
const joinRoomBtn = document.getElementById("join-room");
const openRoomBtn = document.getElementById("open-room");
const leaveRoomBtn = document.getElementById("leave-room");
const recomputeRoomBtn = document.getElementById("recompute-room");
const copyRoomBtn = document.getElementById("copy-room");
const copyRoomLinkInlineBtn = document.getElementById("copy-room-link-inline");
const shareMenuToggleBtn = document.getElementById("share-menu-toggle");
const shareMenuEl = document.getElementById("share-menu");
const shareCopyLinkBtn = document.getElementById("share-copy-link");
const shareEmailLinkBtn = document.getElementById("share-email-link");
const roomShareUrlInput = document.getElementById("room-share-url");
const publishRoomBtn = document.getElementById("publish-room");
const refreshHistoryBtn = document.getElementById("refresh-history");
const roomHistoryEl = document.getElementById("room-history");
const roomStatusEl = document.getElementById("room-status");
const roomHelpEl = document.getElementById("room-help");
const activeRoomsEl = document.getElementById("active-rooms");
const participantListEl = document.getElementById("participant-list");
const compatibilityEl = document.getElementById("compatibility");
const horoscopeEl = document.getElementById("horoscope");
const mutualRecEl = document.getElementById("mutual-recommendations");
const nowCompareEl = document.getElementById("now-playing-compare");
const authStatusEl = document.getElementById("auth-status-content");
const accountEmailInput = document.getElementById("account-email");
const accountPasswordInput = document.getElementById("account-password");
const accountRegisterBtn = document.getElementById("account-register");
const accountLoginBtn = document.getElementById("account-login");
const accountLogoutBtn = document.getElementById("account-logout");
const accountStatusEl = document.getElementById("account-status");
const accountGateEl = document.getElementById("account-gate");
const globalAccountBannerEl = document.getElementById("global-account-banner");
const homeViewBtn = document.getElementById("view-home");
const lobbyViewBtn = document.getElementById("view-lobby");
const homeScreenEl = document.getElementById("screen-home");
const lobbyScreenEl = document.getElementById("screen-lobby");
const roomScreenEl = document.getElementById("screen-room");
const toastEl = document.getElementById("toast");

let activeRoomName = "";
let activeParticipantName = "";
let spotifyDisplayName = "";
let livekitRoom = null;
let isAuthenticated = false;
let roomPublished = false;
let lastRoomParticipants = 0;
let streamMode = "live";
let roomHistory = [];
let currentAccount = null;
let localSharedState = {
  tasteProfile: null,
  nowPlayingState: null,
};

const featureLabels = [
  "danceability",
  "energy",
  "key",
  "loudness",
  "mode",
  "speechiness",
  "acousticness",
  "instrumentalness",
  "liveness",
  "valence",
  "tempo",
  "time_signature",
  "duration",
];
const syncPhaseOrder = ["auth", "pull_ids", "vectorize", "aggregate", "complete"];

function logEvent(scope, message, details) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${scope}] ${message}`;
  if (details !== undefined) {
    console.log(line, details);
  } else {
    console.log(line);
  }
  
  // Store in localStorage for persistence across redirects
  try {
    const logs = JSON.parse(localStorage.getItem("w2v_debug_logs") || "[]");
    logs.push({
      timestamp,
      scope,
      message,
      details: details ? JSON.stringify(details).slice(0, 200) : undefined,
    });
    // Keep last 50 logs
    if (logs.length > 50) {
      logs.shift();
    }
    localStorage.setItem("w2v_debug_logs", JSON.stringify(logs));
  } catch (e) {
    // localStorage may be unavailable, just skip
  }
}

function showDebugLogs() {
  try {
    const logs = JSON.parse(localStorage.getItem("w2v_debug_logs") || "[]");
    if (!logs.length) {
      console.log("No debug logs stored");
      return;
    }
    console.log("=== DEBUG LOGS (PERSISTED ACROSS REDIRECTS) ===");
    logs.forEach((log) => {
      const msg = `[${log.timestamp}] [${log.scope}] ${log.message}`;
      if (log.details) {
        console.log(msg, "→", log.details);
      } else {
        console.log(msg);
      }
    });
    console.log("=== END DEBUG LOGS ===");
  } catch (e) {
    console.error("Could not read debug logs", e);
  }
}

function clearDebugLogs() {
  localStorage.removeItem("w2v_debug_logs");
  console.log("Debug logs cleared");
}

async function reportDebugLogs() {
  try {
    const logs = JSON.parse(localStorage.getItem("w2v_debug_logs") || "[]");
    if (!logs.length) {
      console.log("No debug logs to report");
      return;
    }
    const response = await fetch("/api/debug/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logs, timestamp: new Date().toISOString() }),
    });
    if (response.ok) {
      console.log("Debug logs reported to server");
    } else {
      console.log("Could not report debug logs:", response.status);
    }
  } catch (e) {
    console.error("Failed to report debug logs:", e);
  }
}

function setActiveScreen(screen) {
  const isHome = screen === "home";
  const isLobby = screen === "lobby";
  const isRoom = screen === "room";
  homeScreenEl?.classList.toggle("active", isHome);
  lobbyScreenEl?.classList.toggle("active", isLobby);
  roomScreenEl?.classList.toggle("active", isRoom);
  homeViewBtn?.classList.toggle("active", isHome);
  lobbyViewBtn?.classList.toggle("active", isLobby);
}

function setFeatureGate(locked) {
  document.querySelectorAll("[data-requires-account='true']").forEach((element) => {
    element.classList.toggle("hidden", locked);
  });
  accountGateEl?.classList.toggle("hidden", !locked);
  if (lobbyViewBtn) {
    lobbyViewBtn.classList.toggle("hidden", locked);
  }
  if (locked) {
    setActiveScreen("home");
  }
}

function setGlobalAccountBanner(account) {
  if (!globalAccountBannerEl) {
    return;
  }
  if (!account) {
    globalAccountBannerEl.textContent = "Register or log in to continue.";
    globalAccountBannerEl.classList.remove("welcome");
    return;
  }
  const name = (account.displayName || account.username || account.email || "").trim() || "there";
  globalAccountBannerEl.textContent = `Welcome ${name}`;
  globalAccountBannerEl.classList.add("welcome");
}

let toastTimer = null;
function showToast(message) {
  if (!toastEl) {
    return;
  }
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  toastTimer = setTimeout(() => {
    toastEl.classList.add("hidden");
  }, 1500);
}

participantNameInput.value = localStorage.getItem("participantName") ?? "";
roomNameInput.value = localStorage.getItem("roomName") ?? "";
setStreamMode(localStorage.getItem("streamMode") ?? "live");
const roomParam = new URLSearchParams(window.location.search).get("room");
if (roomParam) {
  roomNameInput.value = roomParam.trim();
}
updateShareUrlInput(roomNameInput.value.trim());

function setDebug(payload) {
  logEvent("debug", "setDebug called", payload);
  debugEl.textContent = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

function showFriendlyError(message, details) {
  recEl.innerHTML = `<p class="muted">${message}</p>`;
  setDebug(details ?? message);
}

function setSyncStatus(message) {
  if (!syncStatusEl) {
    return;
  }
  syncStatusEl.textContent = message;
}

function setSyncProgress(percent) {
  const safe = Math.max(0, Math.min(100, Math.round(percent)));
  if (syncPercentEl) {
    syncPercentEl.textContent = `${safe}%`;
  }
  if (syncMeterFillEl) {
    syncMeterFillEl.style.width = `${safe}%`;
  }
}

function appendSyncLog(message) {
  if (!syncLogEl) {
    return;
  }
  const stamp = new Date().toLocaleTimeString();
  const previous = syncLogEl.textContent?.trim();
  syncLogEl.textContent = previous
    ? `${previous}\n[${stamp}] ${message}`
    : `[${stamp}] ${message}`;
}

function resetSyncLog() {
  if (syncLogEl) {
    syncLogEl.textContent = "";
  }
}

function setSyncPhaseState(currentPhase) {
  if (!syncPhasesEl) {
    return;
  }
  const currentIdx = syncPhaseOrder.indexOf(currentPhase);
  syncPhasesEl.querySelectorAll(".phase-pill").forEach((pill) => {
    const phase = pill.getAttribute("data-phase");
    const idx = syncPhaseOrder.indexOf(phase);
    pill.classList.remove("active", "done");
    if (idx >= 0 && currentIdx >= 0 && idx < currentIdx) {
      pill.classList.add("done");
    }
    if (phase === currentPhase) {
      pill.classList.add("active");
    }
  });
}

async function fetchSyncProgress() {
  const response = await fetch("/api/sync/progress");
  if (!response.ok) {
    throw new Error(`Sync progress request failed (${response.status})`);
  }
  return response.json();
}

function updateControlLabels() {
  diversityValueEl.textContent = Number(diversityInput.value).toFixed(2);
  tasteWeightValueEl.textContent = Number(tasteWeightInput.value).toFixed(2);
}

function setRoomStatus(text, isActive = false) {
  roomStatusEl.textContent = text;
  roomStatusEl.classList.toggle("muted", !isActive);
}

function setRoomHelp(text) {
  if (!roomHelpEl) {
    return;
  }
  roomHelpEl.textContent = text;
}

function getShareRoomUrl(roomName) {
  if (!roomName) {
    return "";
  }
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomName);
  return url.toString();
}

function updateShareUrlInput(roomName) {
  if (!roomShareUrlInput) {
    return;
  }
  roomShareUrlInput.value = roomName
    ? getShareRoomUrl(roomName)
    : "Join a room to generate a share URL";
}

function buildShareEmailMessage(roomName) {
  const url = getShareRoomUrl(roomName);
  const subject = encodeURIComponent(`Join my Wave2Vector room: ${roomName}`);
  const bodyText = `Join my Wave2Vector room and compare our music taste.\n\nRoom: ${roomName}\nLink: ${url}`;
  return {
    subject,
    body: encodeURIComponent(bodyText),
    rawBody: bodyText,
  };
}

function setStreamMode(nextMode) {
  streamMode = nextMode === "batch" ? "batch" : "live";
  modeLiveBtn?.classList.toggle("active", streamMode === "live");
  modeBatchBtn?.classList.toggle("active", streamMode === "batch");
  if (streamMode === "batch") {
    setSyncStatus("Batch mode active: recommendations come from your persisted taste profile.");
  } else {
    setSyncStatus("Live mode active: recommendations blend now-playing with your taste profile.");
  }
}

function renderRoomHistory(snapshots) {
  if (!roomHistoryEl) {
    return;
  }
  roomHistory = snapshots ?? [];
  if (!roomHistory.length) {
    roomHistoryEl.innerHTML = `<span class="muted">Space history appears after a room has had at least one live session.</span>`;
    return;
  }

  roomHistoryEl.innerHTML = roomHistory
    .map((item) => {
      const date = new Date(item.createdAt).toLocaleString();
      const score = item.compatibility?.score?.overallScore;
      const scoreLabel = typeof score === "number" ? `${score}/100` : "n/a";
      return `
        <div class="history-item">
          <div>
            <strong>${item.roomName}</strong> <span class="muted">${item.reason}</span><br />
            <span class="muted">${date} | score: ${scoreLabel} | participants: ${item.participantCount} | taste-ready: ${item.tasteReadyCount}</span>
          </div>
          <div>
            <button type="button" data-resume-id="${item.id}">Resume Space</button>
          </div>
        </div>
      `;
    })
    .join("");

  roomHistoryEl.querySelectorAll("button[data-resume-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const snapshotId = button.getAttribute("data-resume-id");
      const roomName = (activeRoomName || roomNameInput.value.trim() || localStorage.getItem("roomName") || "").trim();
      if (!roomName || !snapshotId) {
        setRoomStatus("Pick or join a room first.");
        return;
      }

      try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/resume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ snapshotId, published: true }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to resume room snapshot");
        }
        roomPublished = Boolean(payload.room?.published);
        setPublishButtonLabel();
        setRoomStatus(`Resumed room space from snapshot ${snapshotId.slice(0, 8)}...`, true);
        await refreshRoomPanels();
      } catch (error) {
        setRoomStatus(error instanceof Error ? error.message : String(error));
      }
    });
  });
}

async function loadRoomHistory() {
  const roomName = (activeRoomName || roomNameInput.value.trim()).trim();
  if (!roomName) {
    renderRoomHistory([]);
    return;
  }

  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/history?limit=20`);
    const payload = await response.json();
    if (!response.ok) {
      return;
    }
    renderRoomHistory(payload.snapshots ?? []);
  } catch {
    // History is optional and should not break room flow.
  }
}

function setPublishButtonLabel() {
  if (!publishRoomBtn) {
    return;
  }
  publishRoomBtn.textContent = roomPublished ? "Unpublish Room" : "Publish Room";
}

function renderActiveRooms(rooms) {
  if (!activeRoomsEl) {
    return;
  }
  if (!rooms?.length) {
    activeRoomsEl.innerHTML = `<span class="muted">No published rooms yet.</span>`;
    return;
  }

  activeRoomsEl.innerHTML = rooms
    .map((room) => `
      <div class="room-list-item">
        <div>
          <strong>${room.roomName}</strong><br />
          <span class="muted">connected: ${room.connectedCount} | taste-ready: ${room.tasteReadyCount}</span>
        </div>
        <button type="button" data-join-room="${room.roomName}">Join</button>
      </div>
    `)
    .join("");

  activeRoomsEl.querySelectorAll("button[data-join-room]").forEach((button) => {
    button.addEventListener("click", () => {
      const roomName = button.getAttribute("data-join-room");
      if (roomName) {
        roomNameInput.value = roomName;
      }
    });
  });
}

async function loadActiveRooms() {
  try {
    logEvent("rooms", "Loading active rooms");
    const response = await fetch("/api/rooms/active?limit=10");
    const payload = await response.json();
    logEvent("rooms", `Active rooms response ${response.status}`, payload);
    if (!response.ok) {
      return;
    }
    renderActiveRooms(payload.rooms ?? []);
  } catch {
    // Keep UI resilient if room directory fetch fails.
  }
}

function renderAuthStatus(profile) {
  if (!authStatusEl) {
    return;
  }

  if (!profile?.authenticated) {
    isAuthenticated = false;
    authStatusEl.innerHTML = `
      <span class="muted">Not connected to Spotify.</span>
    `;
    return;
  }

  const avatar = profile.imageUrl
    ? `<img src="${profile.imageUrl}" class="auth-avatar" alt="avatar" />`
    : "";

  authStatusEl.innerHTML = `
    ${avatar}
    <span>
      <strong>${profile.displayName}</strong>
      <span class="connected-dot"></span>
      <span class="muted" style="font-size:0.85rem;"> connected to Spotify</span>
    </span>
  `;

  isAuthenticated = true;
  spotifyDisplayName = profile.displayName ?? "";
  if (!participantNameInput.value.trim() || participantNameInput.value.trim().toLowerCase() === "alex") {
    participantNameInput.value = spotifyDisplayName;
  }
}

function renderAccountStatus(payload) {
  if (!accountStatusEl) {
    return;
  }
  if (!payload?.authenticated || !payload?.account) {
    currentAccount = null;
    accountStatusEl.textContent = "Register or log in to continue.";
    setGlobalAccountBanner(null);
    setFeatureGate(true);
    return;
  }
  currentAccount = payload.account;
  const cached = payload.account.hasCachedProfile ? "cached profile ready" : "no cached profile yet";
  const name = payload.account.displayName || payload.account.username || payload.account.email;
  accountStatusEl.textContent = `Welcome ${name} (${cached})`;
  setGlobalAccountBanner(payload.account);
  setFeatureGate(false);
}

async function checkAccountAuth() {
  try {
    logEvent("account", "Checking app account auth");
    const response = await fetch("/api/account/me");
    const payload = await response.json();
    logEvent("account", `Account auth response ${response.status}`, payload);
    renderAccountStatus(payload);
    return payload;
  } catch (error) {
    logEvent("account", "Could not fetch account status", error);
    return { authenticated: false };
  }
}

function renderRecommendations(items) {
  if (!items?.length) {
    recEl.innerHTML = `<p class="muted">No recommendations yet. Sync with Spotify to hydrate your taste profile.</p>`;
    clearRecommendationHighlights();
    return;
  }

  recEl.innerHTML = items
    .map(
      (item) => `
      <div class="track rec-item" data-track-id="${item.trackId}" style="margin-bottom:8px;">
        ${item.artworkUrl ? `<img src="${item.artworkUrl}" alt="art" />` : ""}
        <div>
          <strong>${item.name}</strong><br />
          <span class="muted">${item.artist}</span><br />
          <span class="muted">Target ${(item.similarity * 100).toFixed(1)}% | Blended ${(item.blendedScore * 100).toFixed(1)}%</span>
          ${typeof item.tasteSimilarity === "number" ? `<br /><span class="muted">Taste ${(item.tasteSimilarity * 100).toFixed(1)}%</span>` : ""}
          ${item.reasons?.length ? `<div class="chip-row">${item.reasons.map((reason) => `<span class="chip">${reason}</span>`).join("")}</div>` : ""}
          ${item.previewUrl ? `<br /><audio controls preload="none" src="${item.previewUrl}"></audio>` : ""}
        </div>
      </div>
    `,
    )
    .join("");
}

function clearRecommendationHighlights() {
  recEl.querySelectorAll(".rec-item.active").forEach((el) => el.classList.remove("active"));
  recommendationMapEl?.querySelectorAll(".projection-point.active").forEach((el) => el.classList.remove("active"));
}

function highlightRecommendation(trackId) {
  if (!trackId) {
    return;
  }
  clearRecommendationHighlights();
  const safeId = CSS.escape(trackId);
  recEl.querySelector(`.rec-item[data-track-id="${safeId}"]`)?.classList.add("active");
  recommendationMapEl
    ?.querySelectorAll(`.projection-point[data-track-id="${safeId}"]`)
    .forEach((el) => el.classList.add("active"));
}

function renderProfile(profile) {
  if (!profile || !profile.hasTasteVector) {
    profileEl.innerHTML = `<p class="muted">Still building your taste profile. Click Sync With Spotify and wait a few seconds.</p>`;
    return;
  }

  const updated = profile.updatedAt ? new Date(profile.updatedAt).toLocaleString() : "unknown";
  profileEl.innerHTML = `
    <p><strong>Vector dims:</strong> ${profile.dims}</p>
    <p class="muted"><strong>Updated:</strong> ${updated}</p>
  `;
}

function renderBarRows(rows) {
  if (!rows?.length) {
    return `<p class="muted">No feature data yet.</p>`;
  }

  return `
    <div class="bar-list">
      ${rows
        .map((row) => {
          const value = Number(row.value ?? 0);
          const width = Math.max(0, Math.min(100, Math.round(value * 100)));
          return `
            <div class="bar-row">
              <span>${row.feature}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${width}%;"></div></div>
              <span>${(value * 100).toFixed(0)}%</span>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function roleColor(role) {
  switch (role) {
    case "target":
      return "#111111";
    case "taste":
      return "#2f6f2f";
    case "selected":
      return "#005f99";
    default:
      return "#888888";
  }
}

function renderProjectionMap(map) {
  if (!recommendationMapEl) {
    return;
  }

  if (!map?.points?.length) {
    recommendationMapEl.innerHTML = `<p class="muted" style="margin-top:10px;">Projection map appears after recommendations are generated.</p>`;
    return;
  }

  const width = 620;
  const height = 250;
  const pad = 24;
  const toX = (x) => pad + x * (width - pad * 2);
  const toY = (y) => height - (pad + y * (height - pad * 2));

  const circles = map.points
    .map((point) => {
      const cx = toX(Number(point.x ?? 0.5));
      const cy = toY(Number(point.y ?? 0.5));
      const isCentroid = point.role === "taste";
      const r = point.role === "target" ? 6.5 : point.role === "selected" ? 5.5 : isCentroid ? 6.5 : 3.5;
      const stroke = point.role === "selected" ? "#111111" : "#ffffff";
      const trackId = point.id && !point.id.startsWith("target-") && point.id !== "taste-centroid" ? point.id : "";
      const ring = isCentroid
        ? `<circle class="centroid-ring" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="11" fill="none" stroke="#2f6f2f" stroke-width="2"></circle>`
        : "";
      return `${ring}<circle class="projection-point" data-track-id="${trackId}" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r}" fill="${roleColor(point.role)}" stroke="${stroke}" stroke-width="1.2"><title>${point.label} [${point.role}]${typeof point.score === "number" ? ` ${(point.score * 100).toFixed(1)}%` : ""}</title></circle>`;
    })
    .join("");

  const selectedLabels = map.points
    .filter((point) => point.role === "selected")
    .slice(0, 6)
    .map((point) => {
      const x = toX(Number(point.x ?? 0.5));
      const y = toY(Number(point.y ?? 0.5));
      const safeLabel = point.label.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<text x="${(x + 7).toFixed(1)}" y="${(y - 7).toFixed(1)}" font-size="10" fill="#111111">${safeLabel.slice(0, 24)}</text>`;
    })
    .join("");

  recommendationMapEl.innerHTML = `
    <div class="projection-wrap">
      <div class="projection-axis"><strong>2D projection:</strong> X = ${map.axes?.x ?? "feature_x"}, Y = ${map.axes?.y ?? "feature_y"} (${map.mode ?? "unknown"})</div>
      <svg class="projection-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
        <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#666" stroke-width="1" />
        <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="#666" stroke-width="1" />
        ${circles}
        ${selectedLabels}
      </svg>
      <div class="projection-legend">
        <span class="legend-pill">target = black</span>
        <span class="legend-pill">taste centroid = green + pulse</span>
        <span class="legend-pill">selected recommendations = blue</span>
        <span class="legend-pill">other candidates = gray</span>
      </div>
    </div>
  `;

  recommendationMapEl.querySelectorAll(".projection-point[data-track-id]").forEach((el) => {
    const trackId = el.getAttribute("data-track-id");
    if (!trackId) {
      return;
    }
    el.addEventListener("mouseenter", () => highlightRecommendation(trackId));
    el.addEventListener("mouseleave", () => clearRecommendationHighlights());
  });
}

function renderModelInsights(insights) {
  if (!modelInsightsEl) {
    return;
  }

  if (!insights || !insights.vectorDims) {
    modelInsightsEl.innerHTML = `<p class="muted">Insights appear after a successful sync.</p>`;
    return;
  }

  const sourceEntries = Object.entries(insights.sourceCounts ?? {});
  const sourceTotal = sourceEntries.reduce((sum, [, count]) => sum + Number(count || 0), 0);
  const sourceRows = sourceEntries.length
    ? sourceEntries
      .map(([name, count]) => {
        const fraction = sourceTotal ? Number(count) / sourceTotal : 0;
        return { feature: name, value: fraction };
      })
      .sort((a, b) => b.value - a.value)
    : [];

  const topFeatures = insights.topFeatures?.length
    ? insights.topFeatures
    : featureLabels.map((feature, idx) => ({ feature, value: 0 }));

  const updated = insights.updatedAt ? new Date(insights.updatedAt).toLocaleString() : "unknown";

  modelInsightsEl.innerHTML = `
    <div class="insight-meta">
      <strong>Mode:</strong> ${insights.mode} | <strong>Vector dims:</strong> ${insights.vectorDims} | <strong>Updated:</strong> ${updated}<br />
      <strong>Sampled:</strong> ${insights.sampled ?? 0} | <strong>Cached:</strong> ${insights.cached ?? 0} | <strong>Metadata fallback:</strong> ${insights.metadataFallbackCount ?? 0} | <strong>Failures:</strong> ${insights.vectorFailureCount ?? 0}
    </div>
    <div class="insight-grid">
      <div>
        <h3 style="margin:0 0 8px 0;">Top Taste Signals</h3>
        ${renderBarRows(topFeatures)}
      </div>
      <div>
        <h3 style="margin:0 0 8px 0;">Spotify Source Mix</h3>
        ${renderBarRows(sourceRows)}
      </div>
    </div>
    <div class="insight-grid" style="margin-top:10px;">
      <div>
        <h3 style="margin:0 0 8px 0;">Top Genres</h3>
        <div class="insight-chips">
          ${(insights.topGenres ?? [])
            .slice(0, 12)
            .map((genre) => `<span class="insight-chip">${genre.genre} (${genre.weight.toFixed(2)})</span>`)
            .join("") || `<span class="muted">No genre data returned by Spotify yet.</span>`}
        </div>
      </div>
      <div>
        <h3 style="margin:0 0 8px 0;">Top Artists</h3>
        <div class="insight-chips">
          ${(insights.topArtists ?? [])
            .slice(0, 8)
            .map((artist) => `<span class="insight-chip">${artist.name} (${artist.popularity})</span>`)
            .join("") || `<span class="muted">No artist data returned by Spotify yet.</span>`}
        </div>
      </div>
    </div>
  `;
}

function renderParticipants(room) {
  const participants = room?.participants ?? [];
  lastRoomParticipants = participants.filter((participant) => participant.connected).length;
  roomPublished = Boolean(room?.published);
  setPublishButtonLabel();

  if (!participants.length) {
    participantListEl.innerHTML = `<p class="muted">No participants yet.</p>`;
    setRoomHelp("Create/join a room, then share this exact room name with one other person. Compatibility and mutual picks appear once both users are connected and synced.");
    return;
  }

  if (lastRoomParticipants < 2) {
    setRoomHelp("Only one person is here. Have a second user join the same room name, then click Recompute Compatibility.");
  } else {
    setRoomHelp("Room is active with multiple users. Recompute Compatibility anytime either person refreshes sync or playback changes.");
  }

  participantListEl.innerHTML = participants
    .map((participant) => {
      const now = participant.nowPlayingState?.nowPlaying;
      return `
        <div style="margin-bottom:8px; border-bottom:1px solid #2b3751; padding-bottom:8px;">
          <strong>${participant.participantName}</strong>
          <span class="muted">${participant.connected ? "connected" : "offline"}</span><br />
          <span class="muted">Taste profile: ${participant.tasteProfile ? "shared" : "missing"}</span><br />
          <span class="muted">Now: ${now?.name ? `${now.name} - ${now.artist ?? ""}` : "none"}</span>
        </div>
      `;
    })
    .join("");
}

function renderCompatibility(payload) {
  if (
    !payload
    || payload.status === "waiting_for_pair"
    || typeof payload?.score?.overallScore !== "number"
    || !payload.similarityLabel
  ) {
    compatibilityEl.innerHTML = `<p class="muted">Waiting for two participants with taste profiles.</p>`;
    horoscopeEl.innerHTML = `<p class="muted">Horoscope appears after compatibility is computed.</p>`;
    nowCompareEl.innerHTML = `<p class="muted">Compare now playing once both users share playback state.</p>`;
    return;
  }

  if (payload.horoscope) {
    horoscopeEl.innerHTML = `<p>${payload.horoscope}</p>`;
    return;
  }

  const score = payload?.score?.overallScore ?? 0;
  compatibilityEl.innerHTML = `
    <div class="score-meter"><div class="score-fill" style="width:${score}%;"></div></div>
    <p><strong>${score}/100</strong> - ${payload.similarityLabel}</p>
    <p class="muted">Shared traits: ${(payload.strongestSharedTraits ?? []).join(", ") || "n/a"}</p>
    <p class="muted">Biggest differences: ${(payload.biggestDifferences ?? []).join(", ") || "n/a"}</p>
  `;

  horoscopeEl.innerHTML = `<p>${payload.explanation ?? "No explanation yet."}</p>`;
  nowCompareEl.innerHTML = payload.currentTrackComparison
    ? `<p>${payload.currentTrackComparison}</p>`
    : `<p class="muted">No current-track comparison yet.</p>`;
}

function renderMutualRecommendations(items) {
  if (!items?.length) {
    mutualRecEl.innerHTML = `<p class="muted">Mutual recommendations appear when two users are active in the room.</p>`;
    return;
  }

  mutualRecEl.innerHTML = items
    .map(
      (item) => `
      <div class="track" style="margin-bottom:8px;">
        ${item.artworkUrl ? `<img src="${item.artworkUrl}" alt="art" />` : ""}
        <div>
          <strong>${item.name}</strong><br />
          <span class="muted">${item.artist}</span><br />
          <span class="muted">Joint ${(item.jointScore * 100).toFixed(1)}% | A ${(item.scoreForA * 100).toFixed(1)}% | B ${(item.scoreForB * 100).toFixed(1)}%</span>
          ${item.reasonTags?.length ? `<div class="chip-row">${item.reasonTags.map((reason) => `<span class="chip">${reason}</span>`).join("")}</div>` : ""}
          <br /><a href="https://open.spotify.com/track/${item.trackId}" target="_blank" rel="noopener noreferrer"><button type="button">Play Together</button></a>
          ${item.previewUrl ? `<br /><audio controls preload="none" src="${item.previewUrl}"></audio>` : ""}
        </div>
      </div>
    `,
    )
    .join("");
}

async function refresh() {
  logEvent("refresh", "Starting recommendation refresh", { streamMode });
  const params = new URLSearchParams({
    k: String(Math.max(1, Number(kInput.value || 5))),
    diversity: String(Number(diversityInput.value || 0.2)),
    tasteWeight: String(Number(tasteWeightInput.value || 0.25)),
    mode: streamMode,
  });

  const response = await fetch(`/api/recommendations/live?${params.toString()}`);
  const payload = await response.json();
  logEvent("refresh", `Recommendations response ${response.status}`, payload);
  setDebug(payload);

  if (payload.warning) {
    const modeLabel = payload.streamMode === "batch" ? "Batch" : "Live";
    setSyncStatus(`${modeLabel}: ${payload.warning}`);
  }

  if (!response.ok) {
    if (response.status === 429) {
      showFriendlyError("Spotify rate limit hit. Please wait 30 seconds and try again.", payload);
      setSyncStatus("Spotify rate-limited requests. Auto-retrying on next sync.");
      return;
    }
    showFriendlyError(payload.error ?? "Authentication required. Please connect Spotify.", payload);
    recEl.innerHTML = "";
    profileEl.innerHTML = "";
    return;
  }

  renderRecommendations(payload.recommendations);
  renderProfile(payload.profile);
  renderModelInsights(payload.modelInsights);
  renderProjectionMap(payload.projectionMap ?? null);
  if (payload.horoscope && !activeRoomName) {
    horoscopeEl.innerHTML = `<p>${payload.horoscope}</p>`;
  }

  if (payload.controls) {
    diversityInput.value = String(payload.controls.diversity);
    tasteWeightInput.value = String(payload.controls.tasteWeight);
    kInput.value = String(payload.controls.k);
    updateControlLabels();
  }
  logEvent("refresh", "Recommendation refresh complete");
}

async function bootstrapSync(force = false) {
  logEvent("sync", "Bootstrap sync requested", { force });
  resetSyncLog();
  setSyncProgress(0);
  setSyncPhaseState("auth");
  appendSyncLog(`Bootstrap start (force=${force ? "true" : "false"}).`);
  setSyncStatus(force ? "Syncing with Spotify (manual refresh)..." : "Syncing with Spotify for first-time setup...");

  let progress = 8;
  setSyncProgress(progress);
  const progressTimer = setInterval(async () => {
    try {
      const live = await fetchSyncProgress();
      if (typeof live.percent === "number") {
        progress = live.percent;
        setSyncProgress(progress);
      }
      if (typeof live.phase === "string") {
        setSyncPhaseState(live.phase);
      }
      if (live.message) {
        setSyncStatus(live.message);
      }
      if (typeof live.processed === "number" && typeof live.total === "number") {
        appendSyncLog(`Phase ${live.phase}: ${live.processed}/${live.total}`);
      }
      logEvent("sync", "Polled sync progress", live);
    } catch (error) {
      logEvent("sync", "Progress poll error", error);
    }
  }, 900);
  const heartbeatTimer = setInterval(() => {
    appendSyncLog(`Sync still running at ${progress}%... waiting for Spotify + retries to complete.`);
    logEvent("sync", "Heartbeat", { progress, force });
  }, 3000);

  let response;
  let payload;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    response = await fetch("/api/sync/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    payload = await response.json();
    logEvent("sync", `Bootstrap response ${response.status}`, payload);
  } catch (error) {
    clearInterval(progressTimer);
    clearInterval(heartbeatTimer);
    setSyncStatus("Sync timed out or failed. Check console logs for full details.");
    appendSyncLog(`Sync request failed: ${error instanceof Error ? error.message : String(error)}`);
    logEvent("sync", "Bootstrap failed", error);
    setSyncProgress(0);
    throw error;
  }

  clearInterval(progressTimer);
  clearInterval(heartbeatTimer);
  setSyncProgress(100);
  setSyncPhaseState("complete");
  setDebug(payload);
  appendSyncLog(`HTTP ${response.status}`);

  if (response.status === 429) {
    setSyncPhaseState("complete");
    setSyncStatus("Spotify rate limit reached. Please wait 30 seconds and click Sync again.");
    appendSyncLog("Rate-limited by Spotify (429). No profile update applied.");
    logEvent("sync", "Rate limited", payload);
    return payload;
  }
  if (!response.ok) {
    setSyncPhaseState("auth");
    setSyncStatus(payload.error ?? "Sync failed.");
    appendSyncLog(`Sync failed: ${payload.error ?? "unknown error"}`);
    return payload;
  }

  if (payload.sourceCounts) {
    appendSyncLog(`Sources: ${JSON.stringify(payload.sourceCounts)}`);
  }
  if (payload.sourceErrors?.length) {
    appendSyncLog(`Source errors: ${payload.sourceErrors.join(" | ")}`);
  }
  appendSyncLog(`Vectors cached: ${payload.cached ?? 0}, sampled IDs: ${payload.sampled ?? 0}`);
  appendSyncLog(`Metadata-fallback vectors: ${payload.metadataFallbackCount ?? 0}`);
  appendSyncLog(`Vector failures: ${payload.vectorFailureCount ?? 0}`);
  if (payload.vectorFailureSamples?.length) {
    appendSyncLog(`Vector failure samples: ${payload.vectorFailureSamples.join(" | ")}`);
  }
  appendSyncLog(`Taste vector dims: ${payload.dims ?? 0}, fallback used: ${payload.fallbackUsed ? "yes" : "no"}`);

  if (payload.skipped) {
    setSyncStatus("Spotify already synced. You're good to go.");
  } else {
    setSyncStatus(`Spotify sync complete. Taste vector updated (${payload.dims ?? 0} dims).`);
  }
  logEvent("sync", "Bootstrap sync complete", {
    dims: payload.dims,
    sampled: payload.sampled,
    cached: payload.cached,
    failures: payload.vectorFailureCount,
  });

  renderModelInsights(payload.modelInsights);
  renderProjectionMap(payload.projectionMap ?? null);

  return payload;
}

async function checkAuth() {
  try {
    logEvent("auth", "Checking auth state");
    const accountPayload = await checkAccountAuth();
    logEvent("auth", `Account auth payload: authenticated=${accountPayload?.authenticated}`, accountPayload);
    
    if (!accountPayload?.authenticated) {
      logEvent("auth", "User not logged into app account, rendering unauthenticated state");
      renderAuthStatus({ authenticated: false });
      setSyncStatus("Register or log in to continue.");
      setSyncProgress(0);
      return;
    }

    logEvent("auth", `User logged into app account: ${accountPayload.account?.email}`);
    const res = await fetch("/api/me");
    const profile = await res.json();
    logEvent("auth", `Spotify auth response ${res.status}`, profile);
    renderAuthStatus(profile);

    if (!profile.authenticated) {
      logEvent("auth", "Spotify not connected, using cached profile");
      recEl.innerHTML = `<p class="muted">Loading your saved profile recommendations...</p>`;
      profileEl.innerHTML = `<p class="muted">Spotify disconnected. Using your cached account profile if available.</p>`;
      setSyncStatus("Spotify not connected. Batch cache mode active when available.");
      setSyncProgress(0);
      appendSyncLog("Waiting for authentication.");
      await refresh();
      return;
    }

    logEvent("auth", "Spotify connected, checking for cached profile");
    if (accountPayload?.account?.hasCachedProfile) {
      appendSyncLog("Using cached account profile. Skipping auto-bootstrap.");
      logEvent("auth", "Using cached profile, skipping bootstrap");
      await refresh();
      return;
    }

    logEvent("auth", "No cached profile, starting bootstrap sync");
    const bootstrap = await bootstrapSync(false);
    if (!bootstrap?.hasTasteVector) {
      appendSyncLog("Initial sync returned no taste vector. Triggering one forced retry.");
      logEvent("auth", "Bootstrap returned no taste vector, retrying with force=true");
      await bootstrapSync(true);
    }
    await refresh();
  } catch (error) {
    logEvent("auth", "Auth check failed", error);
    showFriendlyError("Could not check Spotify auth state.", String(error));
    setSyncStatus("Could not verify Spotify connection.");
  }
}

async function refreshRoomPanels() {
  logEvent("rooms", "Refreshing room panels", { activeRoomName });
  await loadActiveRooms();

  if (!activeRoomName) {
    renderParticipants(null);
    renderCompatibility(null);
    renderMutualRecommendations([]);
    await loadRoomHistory();
    return;
  }

  const [roomRes, compatibilityRes, mutualRes] = await Promise.all([
    fetch(`/api/rooms/${encodeURIComponent(activeRoomName)}/state`),
    fetch(`/api/rooms/${encodeURIComponent(activeRoomName)}/compatibility`),
    fetch(`/api/rooms/${encodeURIComponent(activeRoomName)}/mutual-recommendations?k=${Math.max(1, Number(kInput.value || 10))}`),
  ]);

  const roomPayload = await roomRes.json();
  const compatibilityPayload = await compatibilityRes.json();
  const mutualPayload = await mutualRes.json();
  logEvent("rooms", "Room panel payloads", {
    roomStatus: roomRes.status,
    compatibilityStatus: compatibilityRes.status,
    mutualStatus: mutualRes.status,
  });

  renderParticipants(roomPayload.room);
  renderCompatibility(compatibilityPayload);
  renderMutualRecommendations(mutualPayload.recommendations ?? []);
  await loadRoomHistory();
}

async function publishDataMessage(message) {
  if (!livekitRoom?.localParticipant) {
    return;
  }
  const payload = new TextEncoder().encode(JSON.stringify(message));
  await livekitRoom.localParticipant.publishData(payload, { reliable: true });
}

async function shareLocalStateViaBackend() {
  if (!activeRoomName || !activeParticipantName) {
    return;
  }

  logEvent("rooms", "Sharing local state", { activeRoomName, activeParticipantName });
  const response = await fetch(`/api/rooms/${encodeURIComponent(activeRoomName)}/share-state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ participantName: activeParticipantName, includeNowPlaying: true }),
  });

  const payload = await response.json();
  logEvent("rooms", `Share state response ${response.status}`, payload);
  if (!response.ok) {
    throw new Error(payload.error ?? "Failed to share room state");
  }

  localSharedState = payload.shared;

  if (localSharedState.tasteProfile) {
    await publishDataMessage({ type: "taste_profile_shared", ...localSharedState.tasteProfile });
  }
  if (localSharedState.nowPlayingState) {
    await publishDataMessage({ type: "now_playing_shared", ...localSharedState.nowPlayingState });
  }
}

async function joinRoom() {
  const roomName = roomNameInput.value.trim();
  const participantName = participantNameInput.value.trim() || spotifyDisplayName;

  const tasteReady = profileEl.textContent?.includes("Vector dims");

  if (!roomName || !participantName) {
    setRoomStatus("Enter a room name. Display name auto-fills from Spotify, or type one.");
    return;
  }

  if (!tasteReady) {
    setRoomStatus("Taste profile not ready yet. Click Sync With Spotify and wait for 100%.");
    appendSyncLog("Join blocked: taste profile not ready.");
    return;
  }

  localStorage.setItem("roomName", roomName);
  localStorage.setItem("participantName", participantName);
  updateShareUrlInput(roomName);

  logEvent("rooms", "Join room requested", { roomName, participantName });
  const tokenRes = await fetch("/api/livekit/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomName, participantName }),
  });
  const tokenPayload = await tokenRes.json();
  logEvent("rooms", `LiveKit token response ${tokenRes.status}`, tokenPayload);

  if (!tokenRes.ok) {
    throw new Error(tokenPayload.error ?? "Failed to get LiveKit token");
  }

  if (livekitRoom) {
    await livekitRoom.disconnect();
  }

  livekitRoom = new Room({ adaptiveStream: true, dynacast: true });
  livekitRoom.on(RoomEvent.ParticipantConnected, () => {
    refreshRoomPanels().catch((error) => setDebug(String(error)));
  });
  livekitRoom.on(RoomEvent.ParticipantDisconnected, () => {
    refreshRoomPanels().catch((error) => setDebug(String(error)));
  });

  await livekitRoom.connect(tokenPayload.url, tokenPayload.token, { autoSubscribe: true });

  activeRoomName = tokenPayload.roomName;
  activeParticipantName = tokenPayload.participantName;
  updateShareUrlInput(activeRoomName);
  setRoomStatus(`Connected to room ${activeRoomName} as ${activeParticipantName}`, true);

  await shareLocalStateViaBackend();
  await refreshRoomPanels();
  logEvent("rooms", "Join room complete", { activeRoomName, activeParticipantName });
}

async function leaveRoom() {
  if (!activeRoomName) {
    return;
  }

  const roomName = activeRoomName;
  if (livekitRoom) {
    await livekitRoom.disconnect();
    livekitRoom = null;
  }

  logEvent("rooms", "Leave room requested", { activeRoomName });
  await fetch(`/api/rooms/${encodeURIComponent(roomName)}/leave`, { method: "POST" });

  activeRoomName = "";
  activeParticipantName = "";
  roomPublished = false;
  lastRoomParticipants = 0;
  updateShareUrlInput(roomNameInput.value.trim());
  setPublishButtonLabel();
  localSharedState = { tasteProfile: null, nowPlayingState: null };
  setRoomStatus("Not connected to a room", false);
  await refreshRoomPanels();
  logEvent("rooms", "Leave room complete", { roomName });
}

loginBtn.addEventListener("click", () => {
  if (!currentAccount) {
    setSyncStatus("Register or log in to continue.");
    logEvent("auth", "Connect Spotify blocked: no app account logged in");
    return;
  }
  logEvent("auth", "Connect Spotify button clicked");
  logEvent("auth", `Current account: ${currentAccount.email}, id=${currentAccount.id}`);
  setSyncStatus("Redirecting to Spotify authorization...");
  resetSyncLog();
  appendSyncLog("Initiating Spotify OAuth flow.");
  setSyncPhaseState("auth");
  setSyncProgress(5);
  logEvent("auth", `Redirecting to /auth/spotify/login for account ${currentAccount.email}`);
  window.location.href = "/auth/spotify/login";
});

refreshBtn.addEventListener("click", () => {
  logEvent("sync", "Manual sync requested");
  bootstrapSync(true)
    .then(() => refresh())
    .catch((error) => showFriendlyError("Refresh failed", String(error)));
});

modeLiveBtn?.addEventListener("click", () => {
  logEvent("ui", "Switching stream mode", { mode: "live" });
  setStreamMode("live");
  localStorage.setItem("streamMode", "live");
  refresh().catch((error) => setDebug(String(error)));
});

modeBatchBtn?.addEventListener("click", () => {
  logEvent("ui", "Switching stream mode", { mode: "batch" });
  setStreamMode("batch");
  localStorage.setItem("streamMode", "batch");
  refresh().catch((error) => setDebug(String(error)));
});

roomNameInput.addEventListener("input", () => {
  const roomName = roomNameInput.value.trim();
  updateShareUrlInput(roomName);
  localStorage.setItem("roomName", roomName);
  loadRoomHistory().catch(() => {
    // Optional panel refresh.
  });
});

diversityInput.addEventListener("input", updateControlLabels);
tasteWeightInput.addEventListener("input", updateControlLabels);

joinRoomBtn.addEventListener("click", async () => {
  try {
    await joinRoom();
    setActiveScreen("room");
  } catch (error) {
    logEvent("rooms", "Join room failed", error);
    setRoomStatus(error instanceof Error ? error.message : String(error));
    setDebug(String(error));
  }
});

leaveRoomBtn.addEventListener("click", async () => {
  try {
    await leaveRoom();
  } catch (error) {
    logEvent("rooms", "Leave room failed", error);
    setRoomStatus(error instanceof Error ? error.message : String(error));
    setDebug(String(error));
  }
});

recomputeRoomBtn.addEventListener("click", async () => {
  try {
    logEvent("rooms", "Manual recompute requested");
    await shareLocalStateViaBackend();
    await refreshRoomPanels();
  } catch (error) {
    logEvent("rooms", "Manual recompute failed", error);
    setDebug(String(error));
  }
});

copyRoomBtn?.addEventListener("click", async () => {
  const roomName = roomNameInput.value.trim();
  if (!roomName) {
    setRoomStatus("Enter a room name first.");
    return;
  }
  try {
    await navigator.clipboard.writeText(roomName);
    showToast("Copied to clipboard. Done.");
  } catch {
    setRoomStatus("Could not copy room name. Copy it manually.");
  }
});

copyRoomLinkInlineBtn?.addEventListener("click", async () => {
  const roomName = (activeRoomName || roomNameInput.value.trim()).trim();
  if (!roomName) {
    setRoomStatus("Enter a room name first.");
    return;
  }
  const url = getShareRoomUrl(roomName);
  try {
    await navigator.clipboard.writeText(url);
    showToast("Copied to clipboard. Done.");
  } catch {
    setRoomStatus("Could not copy share link.");
  }
});

shareMenuToggleBtn?.addEventListener("click", () => {
  shareMenuEl?.classList.toggle("hidden");
  if (shareMenuToggleBtn && shareMenuEl) {
    shareMenuToggleBtn.setAttribute("aria-expanded", shareMenuEl.classList.contains("hidden") ? "false" : "true");
  }
});

document.addEventListener("click", (event) => {
  if (!shareMenuEl || !shareMenuToggleBtn) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  if (!shareMenuEl.contains(target) && !shareMenuToggleBtn.contains(target)) {
    shareMenuEl.classList.add("hidden");
    shareMenuToggleBtn.setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  if (!shareMenuEl?.classList.contains("hidden")) {
    shareMenuEl.classList.add("hidden");
    shareMenuToggleBtn?.setAttribute("aria-expanded", "false");
  }
});

shareCopyLinkBtn?.addEventListener("click", async () => {
  const roomName = (activeRoomName || roomNameInput.value.trim()).trim();
  if (!roomName) {
    setRoomStatus("Enter a room name first.");
    return;
  }
  const url = getShareRoomUrl(roomName);
  try {
    await navigator.clipboard.writeText(url);
    showToast("Copied to clipboard. Done.");
    shareMenuEl?.classList.add("hidden");
    shareMenuToggleBtn?.setAttribute("aria-expanded", "false");
  } catch {
    setRoomStatus("Could not copy share link.");
  }
});

shareEmailLinkBtn?.addEventListener("click", async () => {
  const roomName = (activeRoomName || roomNameInput.value.trim()).trim();
  if (!roomName) {
    setRoomStatus("Enter a room name first.");
    return;
  }
  const parts = buildShareEmailMessage(roomName);
  try {
    await navigator.clipboard.writeText(parts.rawBody);
    showToast("Invite message copied. Opening email app.");
  } catch {
    showToast("Opening email app.");
  }
  window.location.href = `mailto:?subject=${parts.subject}&body=${parts.body}`;
  shareMenuEl?.classList.add("hidden");
  shareMenuToggleBtn?.setAttribute("aria-expanded", "false");
});

publishRoomBtn?.addEventListener("click", async () => {
  const roomName = activeRoomName || roomNameInput.value.trim();
  if (!roomName) {
    setRoomStatus("Join or enter a room name first.");
    return;
  }
  try {
    logEvent("rooms", "Toggle publish requested", { roomName, next: !roomPublished });
    const next = !roomPublished;
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ published: next }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error ?? "Could not update room visibility");
    }
    roomPublished = Boolean(payload.published);
    setPublishButtonLabel();
    setRoomStatus(roomPublished ? `Room ${roomName} published.` : `Room ${roomName} hidden.`, true);
    await loadActiveRooms();
  } catch (error) {
    logEvent("rooms", "Toggle publish failed", error);
    setRoomStatus(error instanceof Error ? error.message : String(error));
  }
});

refreshHistoryBtn?.addEventListener("click", () => {
  logEvent("rooms", "Manual history refresh requested");
  loadRoomHistory().catch((error) => setDebug(String(error)));
});

accountRegisterBtn?.addEventListener("click", async () => {
  try {
    if (currentAccount) {
      accountStatusEl.textContent = "You are already logged in. Log out first to create another account.";
      return;
    }
    const response = await fetch("/api/account/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: accountEmailInput?.value ?? "",
        password: accountPasswordInput?.value ?? "",
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error ?? "Could not create account");
    }
    renderAccountStatus({ authenticated: true, account: payload.account });
    setSyncStatus("Account created. Connect Spotify to begin authentication, then sync will run with live progress.");
    resetSyncLog();
    appendSyncLog("Account created. Waiting for Spotify connect.");
    accountPasswordInput.value = "";
  } catch (error) {
    accountStatusEl.textContent = error instanceof Error ? error.message : String(error);
  }
});

accountLoginBtn?.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/account/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: accountEmailInput?.value ?? "",
        password: accountPasswordInput?.value ?? "",
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error ?? "Could not login");
    }
    renderAccountStatus({ authenticated: true, account: payload.account });
    setSyncStatus("Logged in. Connect Spotify to authenticate, then sync progress will appear here.");
    appendSyncLog("Logged in successfully.");
    accountPasswordInput.value = "";
    await refresh();
  } catch (error) {
    accountStatusEl.textContent = error instanceof Error ? error.message : String(error);
  }
});

accountLogoutBtn?.addEventListener("click", async () => {
  await fetch("/api/account/logout", { method: "POST" });
  await checkAccountAuth();
  setSyncStatus("You are logged out.");
  await refresh().catch((error) => setDebug(String(error)));
});

homeViewBtn?.addEventListener("click", () => {
  setActiveScreen("home");
  logEvent("ui", "Switched to Home screen");
});

lobbyViewBtn?.addEventListener("click", () => {
  if (!currentAccount) {
    setSyncStatus("Create or log in to an account first.");
    setActiveScreen("home");
    return;
  }
  setActiveScreen("lobby");
  logEvent("ui", "Switched to Lobby screen");
});

openRoomBtn?.addEventListener("click", () => {
  if (!activeRoomName) {
    setRoomStatus("Join a room from Lobby first.");
    setActiveScreen("lobby");
    return;
  }
  setActiveScreen("room");
  logEvent("ui", "Opened Room screen from Lobby");
});

recEl.addEventListener("mouseover", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const card = target.closest(".rec-item");
  if (!(card instanceof HTMLElement)) {
    return;
  }
  const trackId = card.dataset.trackId;
  if (trackId) {
    highlightRecommendation(trackId);
  }
});

recEl.addEventListener("mouseout", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const card = target.closest(".rec-item");
  if (card) {
    clearRecommendationHighlights();
  }
});

logEvent("init", "Page fully loaded, running initialization sequence");

// Show any persisted logs from OAuth redirect
try {
  const logs = JSON.parse(localStorage.getItem("w2v_debug_logs") || "[]");
  if (logs.length > 0) {
    console.log("=== PERSISTED DEBUG LOGS (from previous OAuth flow) ===");
    logs.forEach((log) => {
      console.log(`[${log.scope}] ${log.message}${log.details ? " → " + log.details : ""}`);
    });
    console.log("=== END PERSISTED LOGS ===");
    // Send these logs to the server for analysis
    reportDebugLogs().catch((e) => console.error("Failed to report logs:", e));
  }
} catch (e) {
  // Ignore
}

checkAuth().catch((error) => {
  logEvent("init", "App init failed", error);
  showFriendlyError("Failed to initialize app", String(error));
});

refreshRoomPanels().catch((error) => setDebug(String(error)));
updateControlLabels();
setPublishButtonLabel();
setSyncPhaseState("auth");
setFeatureGate(true);
updateShareUrlInput(roomNameInput.value.trim());
setActiveScreen("home");
loadActiveRooms().catch(() => {
  // Active room directory is optional.
});
loadRoomHistory().catch(() => {
  // Room history panel is optional.
});
