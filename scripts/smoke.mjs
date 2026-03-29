import { spawn } from "node:child_process";

const port = Number(process.env.PORT ?? 8787);
const baseUrl = `http://127.0.0.1:${port}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { response, payload };
}

async function waitForHealth(timeoutMs = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const { response } = await fetchJson("/health");
      if (response.ok) {
        return true;
      }
    } catch {
      // keep waiting
    }
    await delay(300);
  }
  return false;
}

async function run() {
  const server = spawn("node", ["dist/server.js"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
    },
  });

  server.stdout.on("data", (chunk) => {
    process.stdout.write(`[server] ${chunk}`);
  });
  server.stderr.on("data", (chunk) => {
    process.stderr.write(`[server:err] ${chunk}`);
  });

  try {
    const healthy = await waitForHealth();
    if (!healthy) {
      throw new Error("Server did not become healthy in time.");
    }

    const health = await fetchJson("/health");
    if (!health.response.ok || !health.payload?.ok) {
      throw new Error("Health endpoint failed.");
    }

    const unauthorizedProfile = await fetchJson("/api/profile");
    if (unauthorizedProfile.response.status !== 401) {
      throw new Error(`Expected /api/profile to return 401, got ${unauthorizedProfile.response.status}.`);
    }

    const unauthorizedLive = await fetchJson("/api/recommendations/live?k=3");
    if (unauthorizedLive.response.status !== 401) {
      throw new Error(
        `Expected /api/recommendations/live to return 401, got ${unauthorizedLive.response.status}.`,
      );
    }

    console.log("\nSmoke test passed:");
    console.log("- /health is reachable");
    console.log("- auth-protected routes correctly return 401 without session");
  } finally {
    server.kill("SIGTERM");
  }
}

run().catch((error) => {
  console.error("Smoke test failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
