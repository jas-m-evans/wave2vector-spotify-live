import { Room, RoomEvent } from "https://esm.sh/livekit-client@2.15.3";

const debugEl = document.getElementById("debug");
const nowEl = document.getElementById("now-playing");
const recEl = document.getElementById("recommendations");
const profileEl = document.getElementById("profile");
const pollBtn = document.getElementById("poll");
const diversityInput = document.getElementById("diversity");
const tasteWeightInput = document.getElementById("taste-weight");
const kInput = document.getElementById("k");
const diversityValueEl = document.getElementById("diversity-value");
const tasteWeightValueEl = document.getElementById("taste-weight-value");
const loginBtn = document.getElementById("login");
const refreshBtn = document.getElementById("refresh");
const syncStatusEl = document.getElementById("sync-status");
const syncPercentEl = document.getElementById("sync-percent");
const syncMeterFillEl = document.getElementById("sync-meter-fill");
const syncLogEl = document.getElementById("sync-log");
const modelInsightsEl = document.getElementById("model-insights");

const roomNameInput = document.getElementById("room-name");
const participantNameInput = document.getElementById("participant-name");
const joinRoomBtn = document.getElementById("join-room");
const leaveRoomBtn = document.getElementById("leave-room");
const recomputeRoomBtn = document.getElementById("recompute-room");
const roomStatusEl = document.getElementById("room-status");
const participantListEl = document.getElementById("participant-list");
const compatibilityEl = document.getElementById("compatibility");
const horoscopeEl = document.getElementById("horoscope");
const mutualRecEl = document.getElementById("mutual-recommendations");
const nowCompareEl = document.getElementById("now-playing-compare");
const authStatusEl = document.getElementById("auth-status-content");

let polling = false;
let timer = null;
let activeRoomName = "";
let activeParticipantName = "";
let spotifyDisplayName = "";
let livekitRoom = null;
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

participantNameInput.value = localStorage.getItem("participantName") ?? "";
roomNameInput.value = localStorage.getItem("roomName") ?? "";

function setDebug(payload) {
  debugEl.textContent = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

function showFriendlyError(message, details) {
  nowEl.innerHTML = `<p class="muted">${message}</p>`;
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

function updateControlLabels() {
  diversityValueEl.textContent = Number(diversityInput.value).toFixed(2);
  tasteWeightValueEl.textContent = Number(tasteWeightInput.value).toFixed(2);
}

function setRoomStatus(text, isActive = false) {
  roomStatusEl.textContent = text;
  roomStatusEl.classList.toggle("muted", !isActive);
}

function renderAuthStatus(profile) {
  if (!authStatusEl) {
    return;
  }

  if (!profile?.authenticated) {
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

  spotifyDisplayName = profile.displayName ?? "";
  if (!participantNameInput.value.trim() || participantNameInput.value.trim().toLowerCase() === "alex") {
    participantNameInput.value = spotifyDisplayName;
  }
}

function renderNowPlaying(now) {
  if (!now || !now.trackId) {
    nowEl.innerHTML = `<p class="muted">No active playback detected.</p>`;
    return;
  }

  const pct = now.durationMs ? ((now.progressMs ?? 0) / now.durationMs) * 100 : 0;
  nowEl.innerHTML = `
    <div class="track">
      ${now.artworkUrl ? `<img src="${now.artworkUrl}" alt="art" />` : ""}
      <div>
        <strong>${now.name}</strong><br />
        <span class="muted">${now.artist}</span><br />
        <span class="muted">Progress: ${Math.round(pct)}%</span>
      </div>
    </div>
  `;
}

function renderRecommendations(items) {
  if (!items?.length) {
    recEl.innerHTML = `<p class="muted">No recommendations yet. Sync with Spotify to hydrate your taste profile.</p>`;
    return;
  }

  recEl.innerHTML = items
    .map(
      (item) => `
      <div class="track" style="margin-bottom:8px;">
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
  if (!map?.points?.length) {
    return `<p class="muted" style="margin-top:10px;">Projection map appears after recommendations are generated.</p>`;
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
      const r = point.role === "target" ? 6 : point.role === "selected" ? 5 : 3.5;
      const stroke = point.role === "selected" ? "#111111" : "#ffffff";
      return `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r}" fill="${roleColor(point.role)}" stroke="${stroke}" stroke-width="1.2"><title>${point.label} [${point.role}]${typeof point.score === "number" ? ` ${(point.score * 100).toFixed(1)}%` : ""}</title></circle>`;
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

  return `
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
        <span class="legend-pill">taste centroid = green</span>
        <span class="legend-pill">selected recommendations = blue</span>
        <span class="legend-pill">other candidates = gray</span>
      </div>
    </div>
  `;
}

function renderModelInsights(insights, projectionMap = null) {
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
        <h3 style="margin:0 0 8px 0;">Top Genres (free tier)</h3>
        <div class="insight-chips">
          ${(insights.topGenres ?? [])
            .slice(0, 12)
            .map((genre) => `<span class="insight-chip">${genre.genre} (${genre.weight.toFixed(2)})</span>`)
            .join("") || `<span class="muted">No genre data returned by Spotify yet.</span>`}
        </div>
      </div>
      <div>
        <h3 style="margin:0 0 8px 0;">Top Artists (free tier)</h3>
        <div class="insight-chips">
          ${(insights.topArtists ?? [])
            .slice(0, 8)
            .map((artist) => `<span class="insight-chip">${artist.name} (${artist.popularity})</span>`)
            .join("") || `<span class="muted">No artist data returned by Spotify yet.</span>`}
        </div>
      </div>
    </div>
    ${renderProjectionMap(projectionMap)}
  `;
}

function renderParticipants(room) {
  const participants = room?.participants ?? [];
  if (!participants.length) {
    participantListEl.innerHTML = `<p class="muted">No participants yet.</p>`;
    return;
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
  if (!payload || payload.status === "waiting_for_pair") {
    compatibilityEl.innerHTML = `<p class="muted">Waiting for two participants with taste profiles.</p>`;
    horoscopeEl.innerHTML = `<p class="muted">Horoscope appears after compatibility is computed.</p>`;
    nowCompareEl.innerHTML = `<p class="muted">Compare now playing once both users share playback state.</p>`;
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
  const params = new URLSearchParams({
    k: String(Math.max(1, Number(kInput.value || 5))),
    diversity: String(Number(diversityInput.value || 0.2)),
    tasteWeight: String(Number(tasteWeightInput.value || 0.25)),
  });

  const response = await fetch(`/api/recommendations/live?${params.toString()}`);
  const payload = await response.json();
  setDebug(payload);

  if (payload.warning) {
    setSyncStatus(payload.warning);
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

  renderNowPlaying(payload.nowPlaying);
  renderRecommendations(payload.recommendations);
  renderProfile(payload.profile);
  renderModelInsights(payload.modelInsights, payload.projectionMap ?? null);

  if (payload.controls) {
    diversityInput.value = String(payload.controls.diversity);
    tasteWeightInput.value = String(payload.controls.tasteWeight);
    kInput.value = String(payload.controls.k);
    updateControlLabels();
  }
}

async function bootstrapSync(force = false) {
  resetSyncLog();
  setSyncProgress(0);
  appendSyncLog(`Bootstrap start (force=${force ? "true" : "false"}).`);
  setSyncStatus(force ? "Syncing with Spotify (manual refresh)..." : "Syncing with Spotify for first-time setup...");

  let progress = 8;
  setSyncProgress(progress);
  const timer = setInterval(() => {
    progress = Math.min(88, progress + 6);
    setSyncProgress(progress);
  }, 350);

  const response = await fetch("/api/sync/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force }),
  });
  const payload = await response.json();
  clearInterval(timer);
  setSyncProgress(100);
  setDebug(payload);
  appendSyncLog(`HTTP ${response.status}`);

  if (response.status === 429) {
    setSyncStatus("Spotify rate limit reached. Please wait 30 seconds and click Sync again.");
    appendSyncLog("Rate-limited by Spotify (429). No profile update applied.");
    return payload;
  }
  if (!response.ok) {
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

  renderModelInsights(payload.modelInsights, payload.projectionMap ?? null);

  return payload;
}

async function checkAuth() {
  try {
    const res = await fetch("/api/me");
    const profile = await res.json();
    renderAuthStatus(profile);

    if (!profile.authenticated) {
      nowEl.innerHTML = `<p class="muted">Connect Spotify to get started.</p>`;
      recEl.innerHTML = `<p class="muted">Recommendations appear after connecting Spotify.</p>`;
      profileEl.innerHTML = `<p class="muted">Connect Spotify first, then we'll auto-sync your taste profile.</p>`;
      setSyncStatus("Not connected to Spotify.");
      setSyncProgress(0);
      appendSyncLog("Waiting for authentication.");
      return;
    }

    const bootstrap = await bootstrapSync(false);
    if (!bootstrap?.hasTasteVector) {
      appendSyncLog("Initial sync returned no taste vector. Triggering one forced retry.");
      await bootstrapSync(true);
    }
    await refresh();
  } catch (error) {
    showFriendlyError("Could not check Spotify auth state.", String(error));
    setSyncStatus("Could not verify Spotify connection.");
  }
}

async function refreshRoomPanels() {
  if (!activeRoomName) {
    renderParticipants(null);
    renderCompatibility(null);
    renderMutualRecommendations([]);
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

  renderParticipants(roomPayload.room);
  renderCompatibility(compatibilityPayload);
  renderMutualRecommendations(mutualPayload.recommendations ?? []);
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

  const response = await fetch(`/api/rooms/${encodeURIComponent(activeRoomName)}/share-state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ participantName: activeParticipantName, includeNowPlaying: true }),
  });

  const payload = await response.json();
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

  const tokenRes = await fetch("/api/livekit/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomName, participantName }),
  });
  const tokenPayload = await tokenRes.json();

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
  setRoomStatus(`Connected to room ${activeRoomName} as ${activeParticipantName}`, true);

  await shareLocalStateViaBackend();
  await refreshRoomPanels();
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

  await fetch(`/api/rooms/${encodeURIComponent(roomName)}/leave`, { method: "POST" });

  activeRoomName = "";
  activeParticipantName = "";
  localSharedState = { tasteProfile: null, nowPlayingState: null };
  setRoomStatus("Not connected to a room", false);
  await refreshRoomPanels();
}

loginBtn.addEventListener("click", () => {
  setSyncStatus("Redirecting to Spotify authorization...");
  appendSyncLog("Redirecting to Spotify OAuth.");
  window.location.href = "/auth/spotify/login";
});

refreshBtn.addEventListener("click", () => {
  bootstrapSync(true)
    .then(() => refresh())
    .catch((error) => showFriendlyError("Refresh failed", String(error)));
});

diversityInput.addEventListener("input", updateControlLabels);
tasteWeightInput.addEventListener("input", updateControlLabels);

joinRoomBtn.addEventListener("click", async () => {
  try {
    await joinRoom();
  } catch (error) {
    setRoomStatus(error instanceof Error ? error.message : String(error));
    setDebug(String(error));
  }
});

leaveRoomBtn.addEventListener("click", async () => {
  try {
    await leaveRoom();
  } catch (error) {
    setRoomStatus(error instanceof Error ? error.message : String(error));
    setDebug(String(error));
  }
});

recomputeRoomBtn.addEventListener("click", async () => {
  try {
    await shareLocalStateViaBackend();
    await refreshRoomPanels();
  } catch (error) {
    setDebug(String(error));
  }
});

pollBtn.addEventListener("click", async () => {
  polling = !polling;
  pollBtn.textContent = polling ? "Stop live polling" : "Start live polling";

  if (polling) {
    await refresh();
    timer = setInterval(async () => {
      await refresh();
      if (activeRoomName) {
        await shareLocalStateViaBackend();
        await refreshRoomPanels();
      }
    }, 4000);
  } else if (timer) {
    clearInterval(timer);
    timer = null;
  }
});

checkAuth().catch((error) => {
  showFriendlyError("Failed to initialize app", String(error));
});

refreshRoomPanels().catch((error) => setDebug(String(error)));
updateControlLabels();
