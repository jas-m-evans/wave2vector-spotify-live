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

let polling = false;
let timer = null;

function updateControlLabels() {
  diversityValueEl.textContent = Number(diversityInput.value).toFixed(2);
  tasteWeightValueEl.textContent = Number(tasteWeightInput.value).toFixed(2);
}

function renderNowPlaying(now) {
  if (!now || !now.trackId) {
    nowEl.innerHTML = `<p class=\"muted\">No active playback detected.</p>`;
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
    recEl.innerHTML = `<p class=\"muted\">No recommendations yet. Seed library first.</p>`;
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
          ${typeof item.tasteSimilarity === "number" ? `<br /><span class=\"muted\">Taste ${(item.tasteSimilarity * 100).toFixed(1)}%</span>` : ""}
          ${item.reasons?.length ? `<div class=\"chip-row\">${item.reasons.map((reason) => `<span class=\"chip\">${reason}</span>`).join("")}</div>` : ""}
          ${item.previewUrl ? `<br /><audio controls preload="none" src="${item.previewUrl}"></audio>` : ""}
        </div>
      </div>
    `,
    )
    .join("");
}

function renderProfile(profile) {
  if (!profile || !profile.hasTasteVector) {
    profileEl.innerHTML = `<p class=\"muted\">No taste profile yet. Click refresh taste profile.</p>`;
    return;
  }

  const updated = profile.updatedAt ? new Date(profile.updatedAt).toLocaleString() : "unknown";
  profileEl.innerHTML = `
    <p><strong>Vector dims:</strong> ${profile.dims}</p>
    <p class="muted"><strong>Updated:</strong> ${updated}</p>
  `;
}

async function refresh() {
  const params = new URLSearchParams({
    k: String(Math.max(1, Number(kInput.value || 5))),
    diversity: String(Number(diversityInput.value || 0.2)),
    tasteWeight: String(Number(tasteWeightInput.value || 0.25)),
  });
  const response = await fetch(`/api/recommendations/live?${params.toString()}`);
  const payload = await response.json();
  debugEl.textContent = JSON.stringify(payload, null, 2);
  if (!response.ok) {
    nowEl.innerHTML = `<p class=\"muted\">${payload.error ?? "Unauthorized"}</p>`;
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

document.getElementById("login").addEventListener("click", () => {
  window.location.href = "/auth/spotify/login";
});

document.getElementById("seed").addEventListener("click", async () => {
  const response = await fetch("/api/library/seed-famous", { method: "POST" });
  const payload = await response.json();
  debugEl.textContent = JSON.stringify(payload, null, 2);
  if (response.ok) {
    await refresh();
  }
});

document.getElementById("taste").addEventListener("click", async () => {
  const response = await fetch("/api/profile/taste-refresh", { method: "POST" });
  const payload = await response.json();
  debugEl.textContent = JSON.stringify(payload, null, 2);
  if (response.ok) {
    renderProfile({
      hasTasteVector: payload.hasTasteVector,
      dims: payload.dims,
      updatedAt: payload.updatedAt,
    });
    await refresh();
  }
});

document.getElementById("refresh").addEventListener("click", refresh);
diversityInput.addEventListener("input", updateControlLabels);
tasteWeightInput.addEventListener("input", updateControlLabels);

pollBtn.addEventListener("click", async () => {
  polling = !polling;
  pollBtn.textContent = polling ? "Stop live polling" : "Start live polling";
  if (polling) {
    await refresh();
    timer = setInterval(refresh, 4000);
  } else if (timer) {
    clearInterval(timer);
    timer = null;
  }
});

refresh().catch((err) => {
  debugEl.textContent = String(err);
});

updateControlLabels();
