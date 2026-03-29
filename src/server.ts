import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recommendNearest } from "./recommend.js";
import {
  createSessionId,
  createStateToken,
  exchangeCodeForToken,
  fetchNowPlaying,
  fetchTrackVector,
  refreshToken,
  spotifyLoginUrl,
} from "./spotify.js";
import { SessionRecord, SpotifyTokens, TrackFeatureVector } from "./types.js";

dotenv.config();

const port = Number(process.env.PORT ?? 8787);
const app = express();

app.use(cors());
app.use(cookieParser());
app.use(express.json());

const stateToSession = new Map<string, string>();
const sessions = new Map<string, SessionRecord>();
const library = new Map<string, TrackFeatureVector>();

const famousTrackSeeds = [
  "4uLU6hMCjMI75M1A2tKUQC",
  "3n3Ppam7vgaVa1iaRUc9Lp",
  "0VjIjW4GlUZAMYd2vXMi3b",
  "6habFhsOp2NvshLv26DqMb",
  "7ouMYWpwJ422jRcDASZB7P",
  "5ChkMS8OtdzJeqyybCc9R5",
  "3AJwUDP919kvQ9QcozQPxg",
  "4cOdK2wGLETKBW3PvgPWqT",
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "../public");
app.use(express.static(publicDir));

function extractSessionId(req: express.Request): string | null {
  const sid = req.cookies.sid as string | undefined;
  return sid ?? null;
}

async function getActiveSession(req: express.Request): Promise<SessionRecord> {
  const sid = extractSessionId(req);
  if (!sid) {
    throw new Error("Not authenticated. Visit /auth/spotify/login.");
  }

  const session = sessions.get(sid);
  if (!session) {
    throw new Error("Session not found. Re-authenticate with Spotify.");
  }

  const shouldRefresh = Date.now() >= session.tokens.expiresAt - 20_000;
  if (shouldRefresh) {
    session.tokens = await refreshToken(session.tokens);
    sessions.set(session.id, session);
  }

  return session;
}

async function cacheTrack(trackId: string, tokens: SpotifyTokens): Promise<TrackFeatureVector> {
  const cached = library.get(trackId);
  if (cached) {
    return cached;
  }
  const track = await fetchTrackVector(trackId, tokens.accessToken);
  library.set(trackId, track);
  return track;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, librarySize: library.size });
});

app.get("/auth/spotify/login", (req, res) => {
  const sid = extractSessionId(req) ?? createSessionId();
  const state = createStateToken();

  stateToSession.set(state, sid);
  res.cookie("sid", sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
  });
  res.redirect(spotifyLoginUrl(state));
});

app.get("/auth/spotify/callback", async (req, res) => {
  try {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    if (!code || !state) {
      return res.status(400).send("Missing Spotify callback code or state.");
    }

    const sid = extractSessionId(req);
    const expectedSid = stateToSession.get(state);
    stateToSession.delete(state);

    if (!sid || !expectedSid || sid !== expectedSid) {
      return res.status(400).send("State validation failed.");
    }

    const tokens = await exchangeCodeForToken(code);
    sessions.set(sid, { id: sid, tokens });

    return res.redirect("/");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).send(`Spotify auth failed: ${message}`);
  }
});

app.get("/api/spotify/now-playing", async (req, res) => {
  try {
    const session = await getActiveSession(req);
    const nowPlaying = await fetchNowPlaying(session.tokens.accessToken);

    if (!nowPlaying.trackId) {
      return res.json(nowPlaying);
    }

    const vector = await cacheTrack(nowPlaying.trackId, session.tokens);
    return res.json({ ...nowPlaying, cachedVectorDims: vector.vector.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.post("/api/library/seed-famous", async (req, res) => {
  try {
    const session = await getActiveSession(req);
    const before = library.size;

    for (const id of famousTrackSeeds) {
      try {
        await cacheTrack(id, session.tokens);
      } catch {
        // Skip unavailable tracks in user's market.
      }
    }

    return res.json({
      seeded: library.size - before,
      librarySize: library.size,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/library", async (req, res) => {
  try {
    await getActiveSession(req);
    return res.json({
      count: library.size,
      tracks: [...library.values()].map((t) => ({
        trackId: t.trackId,
        name: t.name,
        artist: t.artist,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/recommendations/live", async (req, res) => {
  try {
    const k = Number(req.query.k ?? 5);
    const session = await getActiveSession(req);
    const nowPlaying = await fetchNowPlaying(session.tokens.accessToken);

    if (!nowPlaying.trackId) {
      return res.json({ nowPlaying, recommendations: [] });
    }

    const target = await cacheTrack(nowPlaying.trackId, session.tokens);
    const candidates = [...library.values()];

    const recommendations = recommendNearest(target, candidates, k).map((r) => ({
      trackId: r.trackId,
      name: r.name,
      artist: r.artist,
      artworkUrl: r.artworkUrl,
      previewUrl: r.previewUrl,
      similarity: Number(r.similarity.toFixed(4)),
      distance: Number(r.distance.toFixed(4)),
    }));

    return res.json({ nowPlaying, target, recommendations });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`wave2vector-spotify-live listening on http://localhost:${port}`);
});
