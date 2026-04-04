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
      <button id="auth-banner-login" style="margin-left:8px;">Connect Spotify</button>
    `;
    const bannerLogin = document.getElementById("auth-banner-login");
    bannerLogin?.addEventListener("click", () => {
      window.location.href = "/auth/spotify/login";
    });
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

  if (payload.controls) {
    diversityInput.value = String(payload.controls.diversity);
    tasteWeightInput.value = String(payload.controls.tasteWeight);
    kInput.value = String(payload.controls.k);
    updateControlLabels();
  }
}

async function bootstrapSync(force = false) {
  setSyncStatus(force ? "Syncing with Spotify (manual refresh)..." : "Syncing with Spotify for first-time setup...");
  const response = await fetch("/api/sync/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force }),
  });
  const payload = await response.json();
  setDebug(payload);

  if (response.status === 429) {
    setSyncStatus("Spotify rate limit reached. Please wait 30 seconds and click Sync again.");
    return;
  }
  if (!response.ok) {
    setSyncStatus(payload.error ?? "Sync failed.");
    return;
  }

  if (payload.skipped) {
    setSyncStatus("Spotify already synced. You're good to go.");
  } else {
    setSyncStatus(`Spotify sync complete. Taste vector updated (${payload.dims ?? 0} dims).`);
  }
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
      return;
    }

    await bootstrapSync(false);
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

  if (!roomName || !participantName) {
    setRoomStatus("Enter a room name. Display name auto-fills from Spotify, or type one.");
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
