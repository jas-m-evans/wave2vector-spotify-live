const debugEl = document.getElementById("debug");
const nowEl = document.getElementById("now-playing");
const recEl = document.getElementById("recommendations");
const pollBtn = document.getElementById("poll");

let polling = false;
let timer = null;

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
          <span class="muted">Similarity ${(item.similarity * 100).toFixed(1)}%</span>
          ${item.previewUrl ? `<br /><audio controls preload="none" src="${item.previewUrl}"></audio>` : ""}
        </div>
      </div>
    `,
    )
    .join("");
}

async function refresh() {
  const response = await fetch("/api/recommendations/live?k=5");
  const payload = await response.json();
  debugEl.textContent = JSON.stringify(payload, null, 2);
  if (!response.ok) {
    nowEl.innerHTML = `<p class=\"muted\">${payload.error ?? "Unauthorized"}</p>`;
    recEl.innerHTML = "";
    return;
  }
  renderNowPlaying(payload.nowPlaying);
  renderRecommendations(payload.recommendations);
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

document.getElementById("refresh").addEventListener("click", refresh);

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
