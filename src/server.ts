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
  fetchTopTrackIds,
  fetchNowPlaying,
  fetchTrackVector,
  refreshToken,
  spotifyLoginUrl,
} from "./spotify.js";
import { loadLibraryFromDisk, persistLibraryToDisk } from "./store.js";
import { SessionRecord, SpotifyTokens, TrackFeatureVector } from "./types.js";

dotenv.config();

const port = Number(process.env.PORT ?? 8787);
const app = express();

app.use(cors());
app.use(cookieParser());
app.use(express.json());

const stateToSession = new Map<string, string>();
const sessions = new Map<string, SessionRecord>();
const library = await loadLibraryFromDisk();

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
  await persistLibraryToDisk(library);
  return track;
}

function cosineSimilarity(a: number[] | undefined, b: number[] | undefined): number {
  if (!a || !b || !a.length || !b.length || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function averageVectors(vectors: number[][]): number[] | undefined {
  if (!vectors.length) {
    return undefined;
  }
  const dims = vectors[0]?.length ?? 0;
  if (!dims) {
    return undefined;
  }
  const sum = new Array<number>(dims).fill(0);
  for (const vector of vectors) {
    if (vector.length !== dims) {
      continue;
    }
    for (let i = 0; i < dims; i += 1) {
      sum[i] += vector[i];
    }
  }
  return sum.map((value) => value / vectors.length);
}

async function refreshTasteProfile(session: SessionRecord): Promise<{ sampled: number; cached: number }> {
  const topIds = await fetchTopTrackIds(session.tokens.accessToken, 25);
  const vectors: number[][] = [];

  for (const trackId of topIds) {
    try {
      const vector = await cacheTrack(trackId, session.tokens);
      vectors.push(vector.vector);
    } catch {
      // Skip unavailable tracks in local market.
    }
  }

  const centroid = averageVectors(vectors);
  session.tasteVector = centroid;
  session.tasteUpdatedAt = Date.now();
  sessions.set(session.id, session);

  return {
    sampled: topIds.length,
    cached: vectors.length,
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, librarySize: library.size, sessions: sessions.size });
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

app.post("/api/profile/taste-refresh", async (req, res) => {
  try {
    const session = await getActiveSession(req);
    const result = await refreshTasteProfile(session);
    return res.json({
      ...result,
      hasTasteVector: Boolean(session.tasteVector),
      dims: session.tasteVector?.length ?? 0,
      updatedAt: session.tasteUpdatedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/profile", async (req, res) => {
  try {
    const session = await getActiveSession(req);
    return res.json({
      hasTasteVector: Boolean(session.tasteVector),
      dims: session.tasteVector?.length ?? 0,
      updatedAt: session.tasteUpdatedAt,
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

    const baseRecommendations = recommendNearest(target, candidates, k * 3);
    const reranked = baseRecommendations
      .map((item) => {
        const tasteSimilarity = session.tasteVector
          ? Math.max(0, cosineSimilarity(session.tasteVector, item.vector))
          : undefined;
        const blendedScore = typeof tasteSimilarity === "number"
          ? item.similarity * 0.75 + tasteSimilarity * 0.25
          : item.similarity;
        return {
          trackId: item.trackId,
          name: item.name,
          artist: item.artist,
          artworkUrl: item.artworkUrl,
          previewUrl: item.previewUrl,
          similarity: Number(item.similarity.toFixed(4)),
          distance: Number(item.distance.toFixed(4)),
          tasteSimilarity: typeof tasteSimilarity === "number" ? Number(tasteSimilarity.toFixed(4)) : null,
          blendedScore: Number(blendedScore.toFixed(4)),
        };
      })
      .sort((a, b) => b.blendedScore - a.blendedScore)
      .slice(0, Math.max(1, k));

    return res.json({
      nowPlaying,
      target,
      profile: {
        hasTasteVector: Boolean(session.tasteVector),
        updatedAt: session.tasteUpdatedAt,
      },
      recommendations: reranked,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`wave2vector-spotify-live listening on http://localhost:${port}`);
});
