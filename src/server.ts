import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createAccount,
  getAccountById,
  getCachedSessionLike,
  loginAccount,
  saveSessionCacheToAccount,
  type AppAccount,
} from "./accountStore.js";
import { computeCompatibility } from "./compatibility.js";
import {
  endLiveStream,
  getRoomBatchHistory,
  getRoomSnapshot,
  getTwoActiveParticipants,
  listActiveRooms,
  markParticipantJoined,
  markParticipantLeft,
  recordBatchSnapshot,
  resumeRoomFromBatchSnapshot,
  setCompatibilitySummary,
  setMutualRecommendations,
  setRoomPublished,
  startLiveStream,
  shareNowPlaying,
  shareTasteProfile,
} from "./livekitStore.js";
import { createLiveKitAccessToken } from "./livekit.js";
import { computeMutualRecommendations } from "./mutualRecommendations.js";
import { recommendNearest } from "./recommend.js";
import {
  createSessionId,
  createStateToken,
  exchangeCodeForToken,
  fetchTopArtists,
  fetchTopTracks,
  fetchRecentlyPlayedTrackIds,
  fetchSavedTrackIds,
  fetchSpotifyProfile,
  fetchNowPlaying,
  TrackMetadataHint,
  fetchTrackVector,
  refreshToken,
  spotifyLoginUrl,
} from "./spotify.js";
import { loadLibraryFromDisk, persistLibraryToDisk } from "./store.js";
import { AppAccountPublic, SessionRecord, SpotifyTokens, TrackFeatureVector } from "./types.js";

dotenv.config();

const port = Number(process.env.PORT ?? 8787);
const isProduction = process.env.NODE_ENV === "production";
const cookieSecure = (process.env.COOKIE_SECURE ?? (isProduction ? "true" : "false")) === "true";
const app = express();

app.use(cors());
app.use(cookieParser());
app.use(express.json());

const stateToSession = new Map<string, string>();
const sessions = new Map<string, SessionRecord>();
const library = await loadLibraryFromDisk();
type SyncPhase = "idle" | "auth" | "pull_ids" | "vectorize" | "aggregate" | "complete" | "error";
type SyncProgressState = {
  phase: SyncPhase;
  percent: number;
  message: string;
  processed?: number;
  total?: number;
  updatedAt: number;
};
const syncProgressBySession = new Map<string, SyncProgressState>();

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

const vectorFeatureNames = [
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

const artistWindowWeights: Record<"short_term" | "medium_term" | "long_term", number> = {
  short_term: 1.25,
  medium_term: 1,
  long_term: 0.8,
};
const batchTrackSampleLimit = Math.max(8, Math.min(40, Number(process.env.BATCH_TRACK_SAMPLE_LIMIT ?? 24)));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "../public");
app.use(express.static(publicDir));

const liveKitTokenBodySchema = z.object({
  roomName: z.string().trim().min(1).max(120),
  participantName: z.string().trim().min(1).max(60),
});

const roomShareBodySchema = z.object({
  participantName: z.string().trim().min(1).max(60),
  includeNowPlaying: z.boolean().optional(),
});

const roomPublishBodySchema = z.object({
  published: z.boolean(),
});

const roomResumeBodySchema = z.object({
  snapshotId: z.string().uuid().optional(),
  published: z.boolean().optional(),
});

const recommendationModeSchema = z.enum(["live", "batch"]);

const bootstrapSyncBodySchema = z.object({
  force: z.boolean().optional(),
});

const appAccountAuthSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
});

const appAccountRegisterSchema = appAccountAuthSchema;

function extractSessionId(req: express.Request): string | null {
  const sid = req.cookies.sid as string | undefined;
  return sid ?? null;
}

function extractAccountId(req: express.Request): string | null {
  const aid = req.cookies.aid as string | undefined;
  return aid ?? null;
}

function getConfiguredRedirectHost(): string | null {
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
  if (!redirectUri) {
    return null;
  }
  try {
    return new URL(redirectUri).host;
  } catch {
    return null;
  }
}

function getRequestHost(req: express.Request): string | null {
  const forwardedHost = req.get("x-forwarded-host");
  const host = forwardedHost ?? req.get("host");
  return host ? host.split(",")[0].trim() : null;
}

function getRequestProto(req: express.Request): string {
  const forwardedProto = req.get("x-forwarded-proto");
  return forwardedProto ? forwardedProto.split(",")[0].trim() : req.protocol;
}

function toAccountPublic(account: {
  id: string;
  email: string;
  username?: string;
  createdAt: number;
  updatedAt: number;
  authProvider?: "password" | "google";
  cache?: unknown;
}): AppAccountPublic {
  const displayName = (account.username ?? "").trim() || account.email;
  return {
    id: account.id,
    email: account.email,
    username: account.username,
    displayName,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    hasCachedProfile: Boolean(account.cache),
  };
}

async function getActiveAccount(req: express.Request) {
  const aid = extractAccountId(req);
  if (!aid) {
    return null;
  }
  return getAccountById(aid);
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

async function cacheTrack(
  trackId: string,
  tokens: SpotifyTokens,
  options?: { metadataOnly?: boolean; fallbackMetadata?: TrackMetadataHint },
): Promise<TrackFeatureVector> {
  const cached = library.get(trackId);
  if (cached) {
    return cached;
  }
  const track = await fetchTrackVector(trackId, tokens.accessToken, options);
  library.set(trackId, track);
  try {
    await persistLibraryToDisk(library);
  } catch {
    // Ignore ephemeral filesystem failures (e.g. serverless runtimes without writable disk).
  }
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

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function explainSimilarity(target: number[], candidate: number[]): string[] {
  if (!target.length || !candidate.length || target.length !== candidate.length) {
    return [];
  }
  const deltas = target.map((value, idx) => ({
    idx,
    delta: Math.abs(value - candidate[idx]),
  }));
  deltas.sort((a, b) => a.delta - b.delta);
  return deltas.slice(0, 3).map((item) => vectorFeatureNames[item.idx] ?? `feature_${item.idx + 1}`);
}

function cleanRoomName(raw: string): string {
  return raw.trim().replace(/\s+/g, "-").slice(0, 120);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setSyncProgress(
  sessionId: string,
  phase: SyncPhase,
  percent: number,
  message: string,
  details?: { processed?: number; total?: number },
): void {
  syncProgressBySession.set(sessionId, {
    phase,
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    message,
    processed: details?.processed,
    total: details?.total,
    updatedAt: Date.now(),
  });
}

function isSpotifyRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("(429)");
}

function topTasteSignals(vector: number[]): string[] {
  return vector
    .map((value, idx) => ({ idx, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((item) => vectorFeatureNames[item.idx] ?? `feature_${item.idx + 1}`);
}

function buildModelInsights(session: SessionRecord) {
  const tasteVector = session.tasteVector ?? [];
  const topFeatures = tasteVector
    .map((value, idx) => ({
      feature: vectorFeatureNames[idx] ?? `feature_${idx + 1}`,
      value: Number(value.toFixed(4)),
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);

  const lowFeatures = tasteVector
    .map((value, idx) => ({
      feature: vectorFeatureNames[idx] ?? `feature_${idx + 1}`,
      value: Number(value.toFixed(4)),
    }))
    .sort((a, b) => a.value - b.value)
    .slice(0, 4);

  const sync = session.lastSyncStats;
  const mode = sync
    ? sync.metadataFallbackCount > 0 && sync.cached > 0
      ? (sync.metadataFallbackCount === sync.cached ? "metadata-only" : "hybrid")
      : "spotify-audio-features"
    : "unknown";

  return {
    mode,
    vectorDims: tasteVector.length,
    topFeatures,
    lowFeatures,
    sourceCounts: sync?.sourceCounts ?? {},
    sampled: sync?.sampled ?? 0,
    cached: sync?.cached ?? 0,
    metadataFallbackCount: sync?.metadataFallbackCount ?? 0,
    vectorFailureCount: sync?.vectorFailureCount ?? 0,
    fallbackUsed: sync?.fallbackUsed ?? false,
    topGenres: session.artistInsights?.topGenres ?? [],
    topArtists: session.artistInsights?.topArtists ?? [],
    updatedAt: session.tasteUpdatedAt,
  };
}

type ProjectionRole = "target" | "taste" | "selected" | "candidate";

type ProjectionInput = {
  id: string;
  label: string;
  role: ProjectionRole;
  vector: number[];
  score?: number;
};

function buildProjectionMap(points: ProjectionInput[], mode: "taste-only" | "now-playing") {
  if (!points.length) {
    return null;
  }

  const dims = points[0].vector.length;
  if (!dims) {
    return null;
  }

  const variances = new Array<number>(dims).fill(0);
  const means = new Array<number>(dims).fill(0);
  for (const point of points) {
    for (let i = 0; i < dims; i += 1) {
      means[i] += point.vector[i];
    }
  }
  for (let i = 0; i < dims; i += 1) {
    means[i] /= points.length;
  }
  for (const point of points) {
    for (let i = 0; i < dims; i += 1) {
      const delta = point.vector[i] - means[i];
      variances[i] += delta * delta;
    }
  }

  const axisOrder = variances
    .map((variance, idx) => ({ variance, idx }))
    .sort((a, b) => b.variance - a.variance)
    .map((item) => item.idx);

  const axisX = axisOrder[0] ?? 0;
  const axisY = axisOrder.find((idx) => idx !== axisX) ?? ((axisX + 1) % Math.max(1, dims));

  const raw = points.map((point) => ({
    ...point,
    xRaw: point.vector[axisX] ?? 0,
    yRaw: point.vector[axisY] ?? 0,
  }));

  const minX = Math.min(...raw.map((point) => point.xRaw));
  const maxX = Math.max(...raw.map((point) => point.xRaw));
  const minY = Math.min(...raw.map((point) => point.yRaw));
  const maxY = Math.max(...raw.map((point) => point.yRaw));
  const spanX = Math.max(1e-9, maxX - minX);
  const spanY = Math.max(1e-9, maxY - minY);

  return {
    mode,
    axes: {
      x: vectorFeatureNames[axisX] ?? `feature_${axisX + 1}`,
      y: vectorFeatureNames[axisY] ?? `feature_${axisY + 1}`,
    },
    points: raw.map((point) => ({
      id: point.id,
      label: point.label,
      role: point.role,
      score: point.score,
      x: Number(((point.xRaw - minX) / spanX).toFixed(4)),
      y: Number(((point.yRaw - minY) / spanY).toFixed(4)),
    })),
  };
}

async function recomputeRoomAnalytics(roomName: string, k = 10): Promise<void> {
  const pair = await getTwoActiveParticipants(roomName);
  if (!pair) {
    return;
  }

  const [participantA, participantB] = pair;
  const tasteA = participantA.tasteProfile;
  const tasteB = participantB.tasteProfile;
  if (!tasteA || !tasteB) {
    return;
  }

  const compatibility = computeCompatibility({
    roomName,
    participantA: tasteA,
    participantB: tasteB,
    nowPlayingA: participantA.nowPlayingState,
    nowPlayingB: participantB.nowPlayingState,
  });
  await setCompatibilitySummary(roomName, compatibility);

  const mutualRecommendations = computeMutualRecommendations({
    participants: [participantA, participantB],
    library,
    k,
  });
  await setMutualRecommendations(roomName, mutualRecommendations);
}

function mmrRerank<T extends { blendedScore: number; vector: number[] }>(
  items: T[],
  k: number,
  diversity: number,
): T[] {
  const selected: T[] = [];
  const pool = [...items];

  while (selected.length < Math.max(1, k) && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < pool.length; i += 1) {
      const candidate = pool[i];
      const maxSimilarityToSelected = selected.length
        ? Math.max(...selected.map((item) => cosineSimilarity(item.vector, candidate.vector)))
        : 0;
      const mmrScore = (1 - diversity) * candidate.blendedScore - diversity * maxSimilarityToSelected;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = i;
      }
    }

    selected.push(pool[bestIndex]);
    pool.splice(bestIndex, 1);
  }

  return selected;
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

async function refreshTasteProfileBatch(
  session: SessionRecord,
  reportProgress?: (state: { phase: SyncPhase; percent: number; message: string; processed?: number; total?: number }) => void,
): Promise<{
  sampled: number;
  cached: number;
  sourceCounts: Record<string, number>;
  sourceErrors: string[];
  fallbackUsed: boolean;
  metadataFallbackCount: number;
  vectorFailureCount: number;
  vectorFailureSamples: string[];
}> {
  reportProgress?.({ phase: "pull_ids", percent: 18, message: "Pulling top tracks and artists" });
  // eslint-disable-next-line no-console
  console.log(`[sync] batch refresh start sid=${session.id} sampleLimit=${batchTrackSampleLimit}`);
  const mergedTopIds: string[] = [];
  const metadataHints = new Map<string, TrackMetadataHint>();
  const seen = new Set<string>();
  const sourceCounts: Record<string, number> = {
    short_term: 0,
    medium_term: 0,
    long_term: 0,
    saved_tracks: 0,
    recently_played: 0,
  };
  const sourceErrors: string[] = [];
  const windows: Array<"short_term" | "medium_term" | "long_term"> = [
    "short_term",
    "medium_term",
    "long_term",
  ];

  for (const window of windows) {
    try {
      const tracks = await fetchTopTracks(session.tokens.accessToken, 20, window);
      const ids = tracks.map((item) => item.trackId);
      sourceCounts[window] = ids.length;
      for (const item of tracks) {
        metadataHints.set(item.trackId, item);
      }
      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id);
          mergedTopIds.push(id);
        }
      }
    } catch (error) {
      sourceErrors.push(`${window}: ${error instanceof Error ? error.message : String(error)}`);
      // Continue with other sources if one window fails/rate-limits.
    }
  }

  const genreWeights = new Map<string, number>();
  const topArtistsDedup = new Map<string, { id: string; name: string; popularity: number; genres: string[] }>();
  for (const window of windows) {
    try {
      const artists = await fetchTopArtists(session.tokens.accessToken, 20, window);
      const windowWeight = artistWindowWeights[window];
      for (const artist of artists) {
        if (!topArtistsDedup.has(artist.id)) {
          topArtistsDedup.set(artist.id, artist);
        }
        for (const genre of artist.genres) {
          const key = genre.trim().toLowerCase();
          if (!key) {
            continue;
          }
          genreWeights.set(key, (genreWeights.get(key) ?? 0) + windowWeight);
        }
      }
    } catch (error) {
      sourceErrors.push(`${window}_artists: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Fallback for users with sparse top-tracks history.
  if (mergedTopIds.length < 12) {
    try {
      const saved = await fetchSavedTrackIds(session.tokens.accessToken, 50);
      sourceCounts.saved_tracks = saved.length;
      for (const id of saved) {
        if (!seen.has(id)) {
          seen.add(id);
          mergedTopIds.push(id);
        }
      }
    } catch (error) {
      sourceErrors.push(`saved_tracks: ${error instanceof Error ? error.message : String(error)}`);
      // Optional fallback source.
    }
  }

  if (mergedTopIds.length < 20) {
    try {
      const recent = await fetchRecentlyPlayedTrackIds(session.tokens.accessToken, 50);
      sourceCounts.recently_played = recent.length;
      for (const id of recent) {
        if (!seen.has(id)) {
          seen.add(id);
          mergedTopIds.push(id);
        }
      }
    } catch (error) {
      sourceErrors.push(`recently_played: ${error instanceof Error ? error.message : String(error)}`);
      // Optional fallback source.
    }
  }

  const topIds = mergedTopIds.slice(0, batchTrackSampleLimit);
  reportProgress?.({
    phase: "vectorize",
    percent: 32,
    message: `Vectorizing ${topIds.length} tracks`,
    processed: 0,
    total: topIds.length,
  });
  const vectors: number[][] = [];
  let metadataFallbackCount = 0;
  let vectorFailureCount = 0;
  const vectorFailureSamples: string[] = [];

  for (const trackId of topIds) {
    try {
      await sleep(260);
      const vector = await cacheTrack(trackId, session.tokens, {
        metadataOnly: true,
        fallbackMetadata: metadataHints.get(trackId),
      });
      vectors.push(vector.vector);
      if (vector.source === "metadata-fallback") {
        metadataFallbackCount += 1;
      }
    } catch (error) {
      vectorFailureCount += 1;
      if (vectorFailureSamples.length < 6) {
        vectorFailureSamples.push(`${trackId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Skip unavailable tracks in local market.
    }
    if ((vectors.length + vectorFailureCount) % 5 === 0 || (vectors.length + vectorFailureCount) === topIds.length) {
      const processed = vectors.length + vectorFailureCount;
      const ratio = topIds.length ? processed / topIds.length : 1;
      const percent = 32 + Math.round(ratio * 53);
      reportProgress?.({
        phase: "vectorize",
        percent,
        message: `Vectorized ${processed}/${topIds.length}`,
        processed,
        total: topIds.length,
      });
      // eslint-disable-next-line no-console
      console.log(
        `[sync] batch progress sid=${session.id} processed=${vectors.length + vectorFailureCount}/${topIds.length} cached=${vectors.length} failed=${vectorFailureCount}`,
      );
    }
  }

  reportProgress?.({ phase: "aggregate", percent: 90, message: "Aggregating taste profile" });

  const centroid = averageVectors(vectors);
  const libraryFallback = !centroid && library.size
    ? averageVectors([...library.values()].slice(0, 50).map((track) => track.vector))
    : undefined;
  const seedFallback = !centroid && !libraryFallback && famousTrackSeeds.length
    ? averageVectors(
        [...library.values()]
          .filter((track) => famousTrackSeeds.includes(track.trackId))
          .map((track) => track.vector)
      )
    : undefined;

  const fallbackUsed = Boolean((libraryFallback || seedFallback) && !centroid);
  session.tasteVector = centroid ?? libraryFallback ?? seedFallback;
  session.tasteUpdatedAt = Date.now();
  session.lastSyncStats = {
    sampled: topIds.length,
    cached: vectors.length,
    metadataFallbackCount,
    vectorFailureCount,
    sourceCounts,
    fallbackUsed,
    updatedAt: session.tasteUpdatedAt,
  };
  session.artistInsights = {
    topGenres: [...genreWeights.entries()]
      .map(([genre, weight]) => ({ genre, weight: Number(weight.toFixed(2)) }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 12),
    topArtists: [...topArtistsDedup.values()]
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, 10),
    updatedAt: session.tasteUpdatedAt,
  };
  sessions.set(session.id, session);
  // eslint-disable-next-line no-console
  console.log(
    `[sync] batch refresh complete sid=${session.id} dims=${session.tasteVector?.length ?? 0} cached=${vectors.length} failed=${vectorFailureCount} fallback=${fallbackUsed}`,
  );

  return {
    sampled: topIds.length,
    cached: vectors.length,
    sourceCounts,
    sourceErrors,
    fallbackUsed,
    metadataFallbackCount,
    vectorFailureCount,
    vectorFailureSamples,
  };
}

function buildTasteOnlyRecommendations(session: SessionRecord, k: number) {
  if (!session.tasteVector?.length) {
    return null;
  }

  const tasteTarget: TrackFeatureVector = {
    trackId: "taste-centroid",
    name: "Your taste centroid",
    artist: "Profile-derived",
    vector: session.tasteVector,
    source: "cached",
  };

  const tasteCandidates = recommendNearest(tasteTarget, [...library.values()], Math.max(5, k * 3));
  const horoscope = topTasteSignals(session.tasteVector)
    .map((signal) => `You love ${signal}`)
    .join(". ") + ".";
  const recommendations = tasteCandidates.slice(0, Math.max(1, k)).map((item) => ({
    trackId: item.trackId,
    name: item.name,
    artist: item.artist,
    artworkUrl: item.artworkUrl,
    previewUrl: item.previewUrl,
    similarity: Number(item.similarity.toFixed(4)),
    distance: Number(item.distance.toFixed(4)),
    tasteSimilarity: Number(item.similarity.toFixed(4)),
    blendedScore: Number(item.similarity.toFixed(4)),
    reasons: explainSimilarity(session.tasteVector ?? [], item.vector),
  }));

  const selectedIds = new Set(recommendations.map((item) => item.trackId));
  const projectionPoints: ProjectionInput[] = [
    {
      id: "taste-centroid",
      label: "Taste centroid",
      role: "taste",
      vector: tasteTarget.vector,
    },
    ...tasteCandidates.slice(0, Math.max(12, k * 3)).map((item) => ({
      id: item.trackId,
      label: `${item.name} - ${item.artist}`,
      role: selectedIds.has(item.trackId) ? "selected" as const : "candidate" as const,
      vector: item.vector,
      score: item.similarity,
    })),
  ];
  const projectionMap = buildProjectionMap(projectionPoints, "taste-only");

  return {
    horoscope,
    recommendations,
    projectionMap,
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, librarySize: library.size, sessions: sessions.size });
});

app.post("/api/account/register", async (req, res) => {
  try {
    const active = await getActiveAccount(req);
    if (active) {
      return res.status(409).json({ error: "You are already logged in. Log out before creating another account." });
    }
    const body = appAccountRegisterSchema.parse(req.body ?? {});
    let account: AppAccount | null = null;
    try {
      account = await createAccount(body.email, body.password);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Account creation failed";
      return res.status(409).json({ error: message });
    }
    res.cookie("aid", account.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecure,
      path: "/",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });
    return res.json({ account: toAccountPublic(account) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(400).json({ error: message });
  }
});

app.post("/api/account/login", async (req, res) => {
  try {
    const body = appAccountAuthSchema.parse(req.body ?? {});
    let account: AppAccount | null = null;
    try {
      account = await loginAccount(body.email, body.password);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Login failed";
      return res.status(401).json({ error: message });
    }
    res.cookie("aid", account.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecure,
      path: "/",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });
    return res.json({ account: toAccountPublic(account) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Login failed";
    return res.status(401).json({ error: message });
  }
});

app.post("/api/account/logout", (_req, res) => {
  res.clearCookie("aid", {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure,
    path: "/",
  });
  return res.json({ ok: true });
});

app.get("/api/account/me", async (req, res) => {
  const aid = extractAccountId(req);
  // eslint-disable-next-line no-console
  console.log(`[account] /api/account/me: aid=${aid ?? "none"}`);
  
  const account = await getActiveAccount(req);
  if (!account) {
    // eslint-disable-next-line no-console
    console.log(`[account] No active account found for aid=${aid ?? "none"}`);
    return res.json({ authenticated: false });
  }
  
  // eslint-disable-next-line no-console
  console.log(`[account] Active account found: email=${account.email}, id=${account.id}`);
  return res.json({ authenticated: true, account: toAccountPublic(account) });
});

app.post("/api/debug/logs", (req, res) => {
  try {
    const body = req.body as unknown;
    if (
      body &&
      typeof body === "object" &&
      "logs" in body &&
      Array.isArray((body as { logs: unknown }).logs)
    ) {
      const logs = (body as { logs: unknown[] }).logs;
      // eslint-disable-next-line no-console
      console.log("=== CLIENT DEBUG LOGS RECEIVED ===");
      logs.forEach((log) => {
        if (log && typeof log === "object" && "scope" in log && "message" in log) {
          const l = log as { scope: unknown; message: unknown; details: unknown };
          console.log(`[${l.scope}] ${l.message}${l.details ? ` → ${l.details}` : ""}`);
        }
      });
      // eslint-disable-next-line no-console
      console.log("=== END CLIENT DEBUG LOGS ===");
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: "Invalid debug log format" });
  }
});

app.get("/auth/spotify/login", (req, res) => {
  const sid = extractSessionId(req) ?? createSessionId();
  const state = createStateToken();
  const aid = extractAccountId(req);
  const requestHost = getRequestHost(req);
  const requestProto = getRequestProto(req);
  const redirectHost = getConfiguredRedirectHost();

  // eslint-disable-next-line no-console
  console.log(
    `[oauth] /auth/spotify/login: sid=${sid}, aid=${aid ?? "none"}, state=${state}, request=${requestProto}://${requestHost ?? "unknown"}, redirectHost=${redirectHost ?? "missing"}`,
  );
  if (requestHost && redirectHost && requestHost !== redirectHost) {
    // eslint-disable-next-line no-console
    console.warn(
      `[oauth] Host mismatch detected. App request host is ${requestHost}, but SPOTIFY_REDIRECT_URI points to ${redirectHost}. This will break host-scoped cookies and look like a logout after Spotify redirect.`,
    );
  }

  stateToSession.set(state, sid);
  res.cookie("sid", sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure,
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 7,
  });
  // eslint-disable-next-line no-console
  console.log(`[oauth] Redirecting to Spotify with state=${state}`);
  res.redirect(spotifyLoginUrl(state));
});

app.get("/auth/spotify/callback", async (req, res) => {
  try {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const requestHost = getRequestHost(req);
    const requestProto = getRequestProto(req);
    const redirectHost = getConfiguredRedirectHost();
    // eslint-disable-next-line no-console
    console.log(
      `[oauth] Callback received: state=${state}, code=${code ? "yes" : "no"}, request=${requestProto}://${requestHost ?? "unknown"}, redirectHost=${redirectHost ?? "missing"}`,
    );
    if (requestHost && redirectHost && requestHost !== redirectHost) {
      // eslint-disable-next-line no-console
      console.warn(
        `[oauth] Callback host mismatch detected. Callback arrived on ${requestHost}, but configured redirect host is ${redirectHost}.`,
      );
    }

    if (!code || !state) {
      return res.status(400).send("Missing Spotify callback code or state.");
    }

    const sid = extractSessionId(req);
    const expectedSid = stateToSession.get(state);
    stateToSession.delete(state);

    // eslint-disable-next-line no-console
    console.log(`[oauth] State validation: sid=${sid ?? "none"}, expectedSid=${expectedSid ?? "none"}, match=${sid === expectedSid}`);

    if (!sid || !expectedSid || sid !== expectedSid) {
      return res.status(400).send("State validation failed.");
    }

    let tokens;
    try {
      tokens = await exchangeCodeForToken(code);
      // eslint-disable-next-line no-console
      console.log(`[oauth] Token exchange successful, creating session sid=${sid}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`[oauth] Token exchange failed: ${msg}`);
      throw error;
    }

    const session: SessionRecord = { id: sid, tokens };
    sessions.set(sid, session);
    const aid = extractAccountId(req);

    // eslint-disable-next-line no-console
    console.log(`[oauth] Session stored: sid=${sid}, aid=${aid ?? "none"}`);

    if (aid) {
      try {
        const profile = await fetchSpotifyProfile(tokens.accessToken).catch(() => undefined);
        await saveSessionCacheToAccount(aid, session, profile);
        // eslint-disable-next-line no-console
        console.log(`[oauth] Cached Spotify profile to account ${aid}`);
      } catch (cacheError) {
        // eslint-disable-next-line no-console
        console.error(`[oauth] Could not cache profile: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`);
      }
      res.cookie("aid", aid, {
        httpOnly: true,
        sameSite: "lax",
        secure: cookieSecure,
        path: "/",
        maxAge: 1000 * 60 * 60 * 24 * 30,
      });
      // eslint-disable-next-line no-console
      console.log(`[oauth] aid cookie set for ${aid}`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`[oauth] No aid cookie found, continuing with Spotify session only`);
    }

    // eslint-disable-next-line no-console
    console.log(`[oauth] Callback complete, redirecting to /`);
    return res.redirect("/");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    // eslint-disable-next-line no-console
    console.error(`[oauth] Callback error: ${message}`);
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
    if (isSpotifyRateLimitError(error)) {
      return res.json({
        isPlaying: false,
        rateLimited: true,
        warning: "Spotify now-playing is temporarily rate-limited. Try again shortly.",
      });
    }
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
    session.streamModePreference = "batch";
    const result = await refreshTasteProfileBatch(session);
    const account = await getActiveAccount(req);
    if (account) {
      await saveSessionCacheToAccount(account.id, session);
    }
    return res.json({
      ...result,
      streamMode: "batch",
      hasTasteVector: Boolean(session.tasteVector),
      dims: session.tasteVector?.length ?? 0,
      updatedAt: session.tasteUpdatedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.includes("429") ? 429 : 401;
    return res.status(status).json({ error: message });
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
  } catch {
    const account = await getActiveAccount(req);
    if (account) {
      const cached = await getCachedSessionLike(account.id);
      return res.json({
        hasTasteVector: Boolean(cached?.tasteVector?.length),
        dims: cached?.tasteVector?.length ?? 0,
        updatedAt: cached?.tasteUpdatedAt,
      });
    }
    return res.status(401).json({ error: "Not authenticated." });
  }
});

app.get("/api/me", async (req, res) => {
  try {
    const session = await getActiveSession(req);
    const profile = await fetchSpotifyProfile(session.tokens.accessToken);
    return res.json({ authenticated: true, ...profile });
  } catch {
    return res.json({ authenticated: false });
  }
});

app.post("/api/sync/bootstrap", async (req, res) => {
  try {
    const session = await getActiveSession(req);
    setSyncProgress(session.id, "auth", 8, "Authenticated. Starting sync.");
    const body = bootstrapSyncBodySchema.safeParse(req.body);
    const force = body.success ? body.data.force ?? false : false;

    if (session.bootstrapCompletedAt && session.tasteVector?.length && !force) {
      setSyncProgress(session.id, "complete", 100, "Already synced. Using cached profile.");
      return res.json({
        skipped: true,
        reason: "already_bootstrapped",
        bootstrapCompletedAt: session.bootstrapCompletedAt,
        hasTasteVector: Boolean(session.tasteVector),
        dims: session.tasteVector?.length ?? 0,
        updatedAt: session.tasteUpdatedAt,
        modelInsights: buildModelInsights(session),
      });
    }

    const before = library.size;
    for (const id of famousTrackSeeds) {
      try {
        await cacheTrack(id, session.tokens);
      } catch {
        // Ignore market-limited seed tracks.
      }
    }
    setSyncProgress(session.id, "pull_ids", 20, "Seeded baseline tracks. Pulling Spotify IDs.");

    session.streamModePreference = "batch";
    const result = await refreshTasteProfileBatch(session, (state) => {
      setSyncProgress(session.id, state.phase, state.percent, state.message, {
        processed: state.processed,
        total: state.total,
      });
    });
    session.bootstrapCompletedAt = Date.now();
    sessions.set(session.id, session);
    const account = await getActiveAccount(req);
    if (account) {
      const spotifyProfile = await fetchSpotifyProfile(session.tokens.accessToken).catch(() => undefined);
      await saveSessionCacheToAccount(account.id, session, spotifyProfile);
    }
    setSyncProgress(session.id, "complete", 100, "Sync complete.");

    return res.json({
      skipped: false,
      seeded: library.size - before,
      sampled: result.sampled,
      cached: result.cached,
      sourceCounts: result.sourceCounts,
      sourceErrors: result.sourceErrors,
      fallbackUsed: result.fallbackUsed,
      metadataFallbackCount: result.metadataFallbackCount,
      vectorFailureCount: result.vectorFailureCount,
      vectorFailureSamples: result.vectorFailureSamples,
      streamMode: "batch",
      hasTasteVector: Boolean(session.tasteVector),
      dims: session.tasteVector?.length ?? 0,
      updatedAt: session.tasteUpdatedAt,
      bootstrapCompletedAt: session.bootstrapCompletedAt,
      modelInsights: buildModelInsights(session),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    try {
      const session = await getActiveSession(req);
      setSyncProgress(session.id, "error", 0, message);
    } catch {
      // Session may be unavailable on auth failures.
    }
    const status = message.includes("429") ? 429 : 401;
    return res.status(status).json({ error: message });
  }
});

app.get("/api/sync/progress", async (req, res) => {
  try {
    const session = await getActiveSession(req);
    const progress = syncProgressBySession.get(session.id) ?? {
      phase: "idle",
      percent: 0,
      message: "No sync in progress.",
      updatedAt: Date.now(),
    };
    return res.json(progress);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.post("/api/livekit/token", async (req, res) => {
  try {
    const session = await getActiveSession(req);
    const body = liveKitTokenBodySchema.parse(req.body);
    const tokenPayload = await createLiveKitAccessToken({
      roomName: body.roomName,
      participantName: body.participantName,
      sessionId: session.id,
    });

    await markParticipantJoined({
      roomName: tokenPayload.roomName,
      participantName: tokenPayload.participantName,
      sessionId: session.id,
    });

    return res.json(tokenPayload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(400).json({ error: message });
  }
});

app.post("/api/rooms/:roomName/share-state", async (req, res) => {
  try {
    const session = await getActiveSession(req);
    session.streamModePreference = "live";
    const roomName = cleanRoomName(req.params.roomName);
    const body = roomShareBodySchema.parse(req.body);

    await markParticipantJoined({
      roomName,
      participantName: body.participantName,
      sessionId: session.id,
    });
    await startLiveStream({
      roomName,
      sessionId: session.id,
      participantName: body.participantName,
    });

    let tasteProfile = null;
    if (session.tasteVector && session.tasteVector.length) {
      tasteProfile = {
        roomName,
        participantName: body.participantName,
        timestamp: Date.now(),
        tasteVector: session.tasteVector,
        tasteUpdatedAt: session.tasteUpdatedAt,
        topSignals: topTasteSignals(session.tasteVector),
        profileStats: {
          dims: session.tasteVector.length,
        },
      };
      await shareTasteProfile({
        roomName,
        sessionId: session.id,
        participantName: body.participantName,
        profile: tasteProfile,
      });
    }

    const includeNowPlaying = body.includeNowPlaying ?? true;
    let nowPlayingState = null;
    if (includeNowPlaying) {
      const nowPlaying = await fetchNowPlaying(session.tokens.accessToken);
      let vector: number[] | undefined;
      if (nowPlaying.trackId) {
        const cached = await cacheTrack(nowPlaying.trackId, session.tokens);
        vector = cached.vector;
      }

      nowPlayingState = {
        roomName,
        participantName: body.participantName,
        timestamp: Date.now(),
        nowPlaying: nowPlaying.trackId ? { ...nowPlaying, vector } : null,
      };

      await shareNowPlaying({
        roomName,
        sessionId: session.id,
        participantName: body.participantName,
        nowPlayingState,
      });
    }

    await recomputeRoomAnalytics(roomName);
    const room = await getRoomSnapshot(roomName);

    return res.json({
      room,
      shared: {
        tasteProfile,
        nowPlayingState,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(400).json({ error: message });
  }
});

app.post("/api/rooms/:roomName/leave", async (req, res) => {
  try {
    const session = await getActiveSession(req);
    const roomName = cleanRoomName(req.params.roomName);
    await endLiveStream({ roomName, sessionId: session.id });
    await markParticipantLeft({ roomName, sessionId: session.id });
    const snapshot = await recordBatchSnapshot(roomName, "stream_end");
    const room = await getRoomSnapshot(roomName);
    return res.json({ room, snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(400).json({ error: message });
  }
});

app.post("/api/rooms/:roomName/publish", async (req, res) => {
  try {
    await getActiveSession(req);
    const roomName = cleanRoomName(req.params.roomName);
    const body = roomPublishBodySchema.parse(req.body);
    const room = await setRoomPublished(roomName, body.published);
    return res.json({
      roomName: room.roomName,
      published: Boolean(room.published),
      updatedAt: room.updatedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(400).json({ error: message });
  }
});

app.get("/api/rooms/active", async (req, res) => {
  try {
    await getActiveSession(req);
    const limit = Math.max(1, Math.min(30, Number(req.query.limit ?? 20)));
    const rooms = await listActiveRooms(limit);
    return res.json({ rooms });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/rooms/:roomName/history", async (req, res) => {
  try {
    await getActiveSession(req);
    const roomName = cleanRoomName(req.params.roomName);
    const limit = Math.max(1, Math.min(40, Number(req.query.limit ?? 20)));
    const snapshots = await getRoomBatchHistory(roomName, limit);
    return res.json({ roomName, snapshots });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.post("/api/rooms/:roomName/resume", async (req, res) => {
  try {
    await getActiveSession(req);
    const roomName = cleanRoomName(req.params.roomName);
    const body = roomResumeBodySchema.parse(req.body ?? {});
    const result = await resumeRoomFromBatchSnapshot(roomName, body.snapshotId);
    if (typeof body.published === "boolean") {
      await setRoomPublished(roomName, body.published);
    }
    return res.json({
      room: result.room,
      snapshot: result.snapshot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(400).json({ error: message });
  }
});

app.get("/api/rooms/:roomName/state", async (req, res) => {
  try {
    await getActiveSession(req);
    const roomName = cleanRoomName(req.params.roomName);
    const room = await getRoomSnapshot(roomName);
    return res.json({ room });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/rooms/:roomName/compatibility", async (req, res) => {
  try {
    await getActiveSession(req);
    const roomName = cleanRoomName(req.params.roomName);
    await recomputeRoomAnalytics(roomName);
    const room = await getRoomSnapshot(roomName);

    if (!room.lastCompatibility) {
      return res.json({
        roomName,
        status: "waiting_for_pair",
        participants: room.participants.map((participant) => ({
          participantName: participant.participantName,
          connected: participant.connected,
          hasTasteProfile: Boolean(participant.tasteProfile),
          nowPlaying: participant.nowPlayingState?.nowPlaying
            ? {
              trackId: participant.nowPlayingState.nowPlaying.trackId,
              name: participant.nowPlayingState.nowPlaying.name,
              artist: participant.nowPlayingState.nowPlaying.artist,
            }
            : null,
        })),
      });
    }

    return res.json(room.lastCompatibility);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/rooms/:roomName/mutual-recommendations", async (req, res) => {
  try {
    await getActiveSession(req);
    const roomName = cleanRoomName(req.params.roomName);
    const k = Math.max(1, Number(req.query.k ?? 10));

    const pair = await getTwoActiveParticipants(roomName);
    if (!pair) {
      return res.json({
        roomName,
        status: "waiting_for_pair",
        recommendations: [],
      });
    }

    const recommendations = computeMutualRecommendations({
      participants: pair,
      library,
      k,
    });

    await setMutualRecommendations(roomName, recommendations);
    return res.json({
      roomName,
      participants: [pair[0].participantName, pair[1].participantName],
      recommendations,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/recommendations/live", async (req, res) => {
  try {
    const k = Number(req.query.k ?? 5);
    const diversity = clamp01(Number(req.query.diversity ?? 0.2));
    const tasteWeight = clamp01(Number(req.query.tasteWeight ?? 0.25));
    const account = await getActiveAccount(req);
    let session: SessionRecord | null = null;
    try {
      session = await getActiveSession(req);
    } catch {
      session = null;
    }

    const cachedSession = !session && account ? await getCachedSessionLike(account.id) : null;
    const sessionLike = (session ?? cachedSession ?? null) as (SessionRecord | null);
    if (!sessionLike) {
      return res.status(401).json({ error: "Not authenticated. Log in and connect Spotify." });
    }

    const queryMode = recommendationModeSchema.safeParse(req.query.mode);
    const streamMode = queryMode.success
      ? queryMode.data
      : (sessionLike.streamModePreference ?? "batch");

    if (streamMode === "batch") {
      if (session) {
        session.streamModePreference = "batch";
      }
      const tasteOnly = buildTasteOnlyRecommendations(sessionLike, Math.max(1, k));
      return res.json({
        streamMode: "batch",
        nowPlaying: { isPlaying: false },
        recommendations: tasteOnly?.recommendations ?? [],
        profile: {
          hasTasteVector: Boolean(sessionLike.tasteVector),
          dims: sessionLike.tasteVector?.length ?? 0,
          updatedAt: sessionLike.tasteUpdatedAt,
        },
        modelInsights: buildModelInsights(sessionLike),
        horoscope: tasteOnly?.horoscope,
        controls: {
          k: Math.max(1, k),
          diversity,
          tasteWeight,
        },
        projectionMap: tasteOnly?.projectionMap ?? null,
        warning: tasteOnly
          ? "Batch stream mode: showing recommendations from your persisted taste profile."
          : "Batch stream mode is ready, but your taste profile is still empty. Sync with Spotify.",
      });
    }

    if (!session) {
      return res.status(401).json({ error: "Live mode requires an active Spotify connection." });
    }

    session.streamModePreference = "live";
    let nowPlaying;
    try {
      nowPlaying = await fetchNowPlaying(session.tokens.accessToken);
    } catch (error) {
      if (isSpotifyRateLimitError(error)) {
        return res.json({
          streamMode: "live",
          nowPlaying: { isPlaying: false },
          recommendations: [],
          profile: {
            hasTasteVector: Boolean(session.tasteVector),
            dims: session.tasteVector?.length ?? 0,
            updatedAt: session.tasteUpdatedAt,
          },
          modelInsights: buildModelInsights(session),
          controls: {
            k: Math.max(1, k),
            diversity,
            tasteWeight,
          },
          warning: session.tasteVector?.length
            ? "Spotify now-playing is rate-limited right now. Showing profile-only mode."
            : "Spotify now-playing is rate-limited right now, and your taste profile is still empty. Use Sync With Spotify again.",
        });
      }
      throw error;
    }

    if (!nowPlaying.trackId) {
      const tasteOnly = buildTasteOnlyRecommendations(session, Math.max(1, k));
      if (tasteOnly) {
        return res.json({
          streamMode: "live",
          nowPlaying,
          recommendations: tasteOnly.recommendations,
          profile: {
            hasTasteVector: true,
            dims: session.tasteVector?.length ?? 0,
            updatedAt: session.tasteUpdatedAt,
          },
          modelInsights: buildModelInsights(session),
          horoscope: tasteOnly.horoscope,
          controls: {
            k: Math.max(1, k),
            diversity,
            tasteWeight,
          },
          projectionMap: tasteOnly.projectionMap,
          warning: "No active playback detected. Showing taste-only recommendations.",
        });
      }

      return res.json({
        streamMode: "live",
        nowPlaying,
        recommendations: [],
        profile: {
          hasTasteVector: Boolean(session.tasteVector),
          dims: session.tasteVector?.length ?? 0,
          updatedAt: session.tasteUpdatedAt,
        },
        modelInsights: buildModelInsights(session),
        controls: {
          k: Math.max(1, k),
          diversity,
          tasteWeight,
        },
        projectionMap: null,
        warning: "No active playback detected. Play a track to generate live recommendations.",
      });
    }

    const target = await cacheTrack(nowPlaying.trackId, session.tokens);
    const candidates = [...library.values()];

    const baseRecommendations = recommendNearest(target, candidates, Math.max(5, k * 4));
    const rescored = baseRecommendations
      .map((item) => {
        const tasteSimilarity = session.tasteVector
          ? Math.max(0, cosineSimilarity(session.tasteVector, item.vector))
          : undefined;
        const blendedScore = typeof tasteSimilarity === "number"
          ? item.similarity * (1 - tasteWeight) + tasteSimilarity * tasteWeight
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
          vector: item.vector,
          reasons: explainSimilarity(target.vector, item.vector),
        };
      })
      .sort((a, b) => b.blendedScore - a.blendedScore);

    const rerankedInternal = mmrRerank(rescored, k, diversity);
    const reranked = rerankedInternal.map((item) => ({
      trackId: item.trackId,
      name: item.name,
      artist: item.artist,
      artworkUrl: item.artworkUrl,
      previewUrl: item.previewUrl,
      similarity: item.similarity,
      distance: item.distance,
      tasteSimilarity: item.tasteSimilarity,
      blendedScore: item.blendedScore,
      reasons: item.reasons,
    }));

    const selectedIds = new Set(rerankedInternal.map((item) => item.trackId));
    const projectionPoints: ProjectionInput[] = [
      {
        id: `target-${target.trackId}`,
        label: `${target.name} - ${target.artist}`,
        role: "target",
        vector: target.vector,
      },
      ...(session.tasteVector?.length
        ? [{
          id: "taste-centroid",
          label: "Taste centroid",
          role: "taste" as const,
          vector: session.tasteVector,
        }]
        : []),
      ...rescored.slice(0, Math.max(14, k * 3)).map((item) => ({
        id: item.trackId,
        label: `${item.name} - ${item.artist}`,
        role: selectedIds.has(item.trackId) ? "selected" as const : "candidate" as const,
        vector: item.vector,
        score: item.blendedScore,
      })),
    ];
    const projectionMap = buildProjectionMap(projectionPoints, "now-playing");

    return res.json({
      streamMode: "live",
      nowPlaying,
      target,
      profile: {
        hasTasteVector: Boolean(session.tasteVector),
        updatedAt: session.tasteUpdatedAt,
      },
      modelInsights: buildModelInsights(session),
      controls: {
        k: Math.max(1, k),
        diversity,
        tasteWeight,
      },
      recommendations: reranked,
      projectionMap,
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
