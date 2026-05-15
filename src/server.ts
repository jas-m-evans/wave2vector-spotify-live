import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { Redis } from "@upstash/redis";
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
import { buildTasteStory, buildTasteHoroscope } from "./tasteInsights.js";
import { computeMoodSnapshot } from "./moodEngine.js";
import {
  attachAssetToArtifact,
  createBlendSession,
  createShareLink,
  getBlendSession,
  getLatestMoodSnapshot,
  getLatestRoomArtifact,
  getRoomArtifactById,
  listMoodSnapshots,
  resolveShareToken,
  revokeShareLink,
  saveMoodSnapshot,
  saveRoomArtifact,
  setArtifactPrimaryAsset,
  updateBlendSession,
} from "./moodStore.js";
import { generateBlendRoom, generateInnerRoom } from "./innerRoom.js";
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
  getMissingSpotifyEnv,
  refreshToken,
  spotifyLoginUrl,
} from "./spotify.js";
import { loadLibraryFromDisk, persistLibraryToDisk } from "./store.js";
import {
  AppAccountPublic,
  MoodProfileSnapshot,
  SessionRecord,
  SpotifyTokens,
  TasteCapsule,
  TrackFeatureVector,
} from "./types.js";

dotenv.config();

const port = Number(process.env.PORT ?? 8787);
const isProduction = process.env.NODE_ENV === "production";
const cookieSecure = (process.env.COOKIE_SECURE ?? (isProduction ? "true" : "false")) === "true";
const moodProductMode = (process.env.MOOD_PRODUCT_MODE ?? "true") === "true";
const legacyLiveRooms = (process.env.LEGACY_LIVE_ROOMS ?? "false") === "true";
const app = express();

app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  const origin = req.get("origin");
  if (!origin) {
    return next();
  }
  const host = req.get("x-forwarded-host") ?? req.get("host");
  if (!host) {
    return res.status(403).json({ error: "Request origin validation failed." });
  }
  try {
    const originHost = new URL(origin).host;
    const requestHost = host.split(",")[0].trim();
    const requestHostNormalized = new URL(`http://${requestHost}`).host;
    if (originHost !== requestHostNormalized) {
      return res.status(403).json({ error: "Cross-site request rejected." });
    }
  } catch {
    return res.status(403).json({ error: "Invalid request origin." });
  }
  return next();
});

const stateToSession = new Map<string, string>();
const sessions = new Map<string, SessionRecord>();
const useRedisSessionStore = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
let redisSessionStore: Redis | null = null;
if (useRedisSessionStore) {
  try {
    redisSessionStore = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
    // eslint-disable-next-line no-console
    console.log("[session] Redis-backed OAuth/session store enabled.");
  } catch {
    redisSessionStore = null;
  }
}

const oauthStateTtlSeconds = 60 * 10;
const spotifySessionTtlSeconds = 60 * 60 * 24 * 30;

function oauthStateKey(state: string): string {
  return `oauth:state:${state}`;
}

function spotifySessionKey(sid: string): string {
  return `spotify:session:${sid}`;
}

async function setOAuthState(state: string, sid: string): Promise<void> {
  stateToSession.set(state, sid);
  if (!redisSessionStore) {
    return;
  }
  try {
    await redisSessionStore.set(oauthStateKey(state), sid, { ex: oauthStateTtlSeconds });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[session] Could not persist OAuth state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function consumeOAuthState(state: string): Promise<string | null> {
  const inMemory = stateToSession.get(state) ?? null;
  stateToSession.delete(state);

  if (!redisSessionStore) {
    return inMemory;
  }

  try {
    const stored = await redisSessionStore.get<string>(oauthStateKey(state));
    await redisSessionStore.del(oauthStateKey(state));
    if (typeof stored === "string" && stored.length) {
      return stored;
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[session] Could not consume OAuth state: ${error instanceof Error ? error.message : String(error)}`);
  }

  return inMemory;
}

async function setStoredSession(session: SessionRecord): Promise<void> {
  sessions.set(session.id, session);
  if (!redisSessionStore) {
    return;
  }
  try {
    await redisSessionStore.set(spotifySessionKey(session.id), JSON.stringify(session), { ex: spotifySessionTtlSeconds });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[session] Could not persist Spotify session: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function getStoredSession(sid: string): Promise<SessionRecord | null> {
  const inMemory = sessions.get(sid);
  if (inMemory) {
    return inMemory;
  }
  if (!redisSessionStore) {
    return null;
  }
  try {
    const stored = await redisSessionStore.get<string>(spotifySessionKey(sid));
    if (typeof stored !== "string" || !stored.length) {
      return null;
    }
    const parsed = JSON.parse(stored) as SessionRecord;
    if (!parsed?.id || parsed.id !== sid || !parsed?.tokens?.accessToken) {
      return null;
    }
    sessions.set(sid, parsed);
    return parsed;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[session] Could not load Spotify session: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

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
app.get("/demo", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const missingSpotifyEnv = getMissingSpotifyEnv();
if (missingSpotifyEnv.length) {
  // eslint-disable-next-line no-console
  console.warn(`[config] Missing Spotify env vars: ${missingSpotifyEnv.join(", ")}`);
}

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
const roomGenerateBodySchema = z.object({
  force: z.boolean().optional(),
});
const blendCreateBodySchema = z.object({
  partnerUserId: z.string().trim().min(1),
});
const shareLinkCreateBodySchema = z.object({
  targetType: z.enum(["user_room", "blend_room"]),
  targetId: z.string().trim().min(1),
  visibility: z.enum(["public", "unlisted"]).default("unlisted"),
  expiresInHours: z.number().min(1).max(24 * 30).optional(),
});

function getMoodActorUserId(params: {
  account: AppAccount | null;
  session: SessionRecord | null;
  fallbackSid: string | null;
}): string {
  if (params.account?.id) return `aid:${params.account.id}`;
  if (params.session?.spotifyProfile?.id) return `spotify:${params.session.spotifyProfile.id}`;
  if (params.session?.id) return `sid:${params.session.id}`;
  if (params.fallbackSid) return `sid:${params.fallbackSid}`;
  return "anonymous";
}

async function buildWindowVector(
  accessToken: string,
  tokens: SpotifyTokens,
  window: "short_term" | "medium_term" | "long_term",
  limit = 14,
): Promise<{ vector: number[]; sampled: number; metadataFallbackCount: number }> {
  const tracks = await fetchTopTracks(accessToken, limit, window);
  const vectors: number[][] = [];
  let metadataFallbackCount = 0;
  for (const track of tracks) {
    try {
      const cached = await cacheTrack(track.trackId, tokens, { fallbackMetadata: track });
      vectors.push(cached.vector);
      if (cached.source === "metadata-fallback") {
        metadataFallbackCount += 1;
      }
    } catch {
      // ignore unavailable tracks for this window
    }
  }
  return {
    vector: averageVectors(vectors) ?? [],
    sampled: vectors.length,
    metadataFallbackCount,
  };
}

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

function buildClientErrorRedirect(message: string): string {
  const params = new URLSearchParams({ spotify_error: message });
  return `/?${params.toString()}`;
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

async function getRoomActor(req: express.Request): Promise<{
  account: AppAccount | null;
  session: SessionRecord | null;
  cached: Partial<SessionRecord> | null;
  sessionId: string;
}> {
  const account = await getActiveAccount(req);

  let session: SessionRecord | null = null;
  try {
    session = await getActiveSession(req);
  } catch {
    session = null;
  }

  if (!account && !session) {
    throw new Error("Connect Spotify to access room features.");
  }

  const cached = account ? await getCachedSessionLike(account.id) : null;
  const sessionId = session?.id ?? (account ? `aid:${account.id}` : `spotify:${extractSessionId(req) ?? "guest"}`);
  return { account, session, cached, sessionId };
}

async function getActiveSession(req: express.Request): Promise<SessionRecord> {
  const sid = extractSessionId(req);
  if (!sid) {
    throw new Error("Not authenticated. Visit /auth/spotify/login.");
  }

  const session = await getStoredSession(sid);
  if (!session) {
    throw new Error("Session not found. Re-authenticate with Spotify.");
  }

  const shouldRefresh = Date.now() >= session.tokens.expiresAt - 20_000;
  if (shouldRefresh) {
    session.tokens = await refreshToken(session.tokens);
    await setStoredSession(session);
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
    tasteStory: buildTasteStory(session),
    updatedAt: session.tasteUpdatedAt,
  };
}

function computeMatchVerdictFromScore(score: number): { verdict: string; verdictEmoji: string } {
  if (score >= 90) return { verdict: "Punk Soulmates", verdictEmoji: "🤝" };
  if (score >= 75) return { verdict: "Same Universe, Different Moons", verdictEmoji: "🌙" };
  if (score >= 60) return { verdict: "Sonic Siblings", verdictEmoji: "🎵" };
  if (score >= 45) return { verdict: "Crossover Potential", verdictEmoji: "🔀" };
  if (score >= 30) return { verdict: "Respectful Strangers", verdictEmoji: "👋" };
  return { verdict: "Different Planets", verdictEmoji: "🪐" };
}

function findOutlierTracks(
  tasteVector: number[],
  lib: Map<string, TrackFeatureVector>,
  k = 5,
): Array<{ trackId: string; name: string; artist: string; artworkUrl?: string; distance: number; badge: string; tagline: string }> {
  if (!tasteVector.length || !lib.size) {
    return [];
  }

  const OUTLIER_BADGES = [
    "🃏 Wildcard",
    "🌀 Chaos Agent",
    "😈 Guilty Pleasure",
    "🎭 Alter Ego",
    "🌪️ Plot Twist",
  ];

  const scored = [...lib.values()].map((track) => {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < tasteVector.length; i += 1) {
      dot += tasteVector[i] * (track.vector[i] ?? 0);
      normA += tasteVector[i] * tasteVector[i];
      normB += (track.vector[i] ?? 0) * (track.vector[i] ?? 0);
    }
    const sim = normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
    return { ...track, distance: Number((1 - sim).toFixed(4)) };
  });

  scored.sort((a, b) => b.distance - a.distance);

  return scored.slice(0, Math.max(1, k)).map((track, idx) => {
    const badge = OUTLIER_BADGES[idx % OUTLIER_BADGES.length] ?? "🃏 Wildcard";
    const tagline = `Your most chaotic track: ${track.name} — ${track.distance.toFixed(2)} vector distance from your soul.`;
    return {
      trackId: track.trackId,
      name: track.name,
      artist: track.artist,
      artworkUrl: track.artworkUrl,
      distance: track.distance,
      badge,
      tagline,
    };
  });
}

function computeNicheScore(
  tasteVector: number[],
  lib: Map<string, TrackFeatureVector>,
): { nicheScore: number; distanceFromMainstream: number; percentileText: string; verdict: string } {
  if (!tasteVector.length || !lib.size) {
    return { nicheScore: 0, distanceFromMainstream: 0, percentileText: "N/A", verdict: "Not enough data yet." };
  }

  const dims = tasteVector.length;
  const centroid = new Array<number>(dims).fill(0);
  let count = 0;
  for (const track of lib.values()) {
    if (track.vector.length === dims) {
      for (let i = 0; i < dims; i += 1) {
        centroid[i] += track.vector[i];
      }
      count += 1;
    }
  }
  if (!count) {
    return { nicheScore: 0, distanceFromMainstream: 0, percentileText: "N/A", verdict: "Library is empty." };
  }
  for (let i = 0; i < dims; i += 1) {
    centroid[i] /= count;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < dims; i += 1) {
    dot += tasteVector[i] * centroid[i];
    normA += tasteVector[i] * tasteVector[i];
    normB += centroid[i] * centroid[i];
  }
  const similarity = normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
  const distanceFromMainstream = Number((1 - similarity).toFixed(4));
  const nicheScore = Math.round(Math.min(100, distanceFromMainstream * 200));

  let verdict: string;
  if (nicheScore >= 80) verdict = "Maximum Niche. We've never seen a taste profile quite like yours.";
  else if (nicheScore >= 60) verdict = "Deep Cut Devotee. You live in the long tail.";
  else if (nicheScore >= 40) verdict = "Selective Explorer. You range broadly but keep a strong center.";
  else if (nicheScore >= 20) verdict = "Eclectic but Accessible. You have range and some surprising overlaps.";
  else verdict = "Crowd Pleaser. Your taste aligns closely with the mainstream — not a bad thing.";

  let percentileText: string;
  if (nicheScore >= 75) percentileText = "Top 5% most niche";
  else if (nicheScore >= 55) percentileText = "Top 20% most niche";
  else if (nicheScore >= 35) percentileText = "Middle of the pack";
  else percentileText = "Trending mainstream";

  return { nicheScore, distanceFromMainstream, percentileText, verdict };
}

const SURVEY_QUESTIONS = [
  {
    id: "q1",
    optionA: "Radiohead",
    optionB: "Daft Punk",
    hint: "Gloom and poetry vs. euphoria and beats",
    vectorA: [0.40, 0.55, 0.5, 0.55, 0.35, 0.05, 0.25, 0.30, 0.18, 0.25, 0.48, 0.5, 0.5],
    vectorB: [0.82, 0.85, 0.5, 0.65, 0.70, 0.05, 0.15, 0.35, 0.10, 0.75, 0.68, 0.5, 0.5],
  },
  {
    id: "q2",
    optionA: "Kendrick Lamar",
    optionB: "The Weeknd",
    hint: "Words that cut vs. vibes that pull",
    vectorA: [0.72, 0.65, 0.5, 0.65, 0.65, 0.28, 0.15, 0.05, 0.10, 0.50, 0.60, 0.5, 0.5],
    vectorB: [0.65, 0.70, 0.5, 0.70, 0.35, 0.07, 0.08, 0.06, 0.10, 0.60, 0.55, 0.5, 0.5],
  },
  {
    id: "q3",
    optionA: "Billie Eilish",
    optionB: "Taylor Swift",
    hint: "Hushed shadows vs. bright anthems",
    vectorA: [0.58, 0.40, 0.5, 0.45, 0.35, 0.06, 0.60, 0.08, 0.08, 0.28, 0.40, 0.5, 0.5],
    vectorB: [0.71, 0.65, 0.5, 0.60, 0.75, 0.05, 0.38, 0.00, 0.10, 0.75, 0.55, 0.5, 0.5],
  },
  {
    id: "q4",
    optionA: "Metallica",
    optionB: "Coldplay",
    hint: "Full volume catharsis vs. melodic lift",
    vectorA: [0.40, 0.95, 0.5, 0.90, 0.35, 0.07, 0.05, 0.02, 0.22, 0.35, 0.65, 0.5, 0.5],
    vectorB: [0.52, 0.55, 0.5, 0.55, 0.65, 0.04, 0.28, 0.08, 0.12, 0.60, 0.50, 0.5, 0.5],
  },
  {
    id: "q5",
    optionA: "Frank Ocean",
    optionB: "Post Malone",
    hint: "Introspective texture vs. breezy swagger",
    vectorA: [0.55, 0.42, 0.5, 0.48, 0.55, 0.05, 0.55, 0.02, 0.08, 0.55, 0.42, 0.5, 0.5],
    vectorB: [0.68, 0.65, 0.5, 0.62, 0.65, 0.08, 0.12, 0.00, 0.12, 0.65, 0.55, 0.5, 0.5],
  },
];

const surveyAnswerSchema = z.object({
  answers: z.record(z.string(), z.enum(["a", "b"])),
});

function estimateVectorFromSurvey(answers: Record<string, "a" | "b">): {
  estimatedVector: number[];
  archetype: string;
  teaserText: string;
  confidence: number;
} {
  const dims = 13;
  const neutral = new Array<number>(dims).fill(0.5);
  const chosenVectors: number[][] = [];

  for (const question of SURVEY_QUESTIONS) {
    const answer = answers[question.id];
    if (answer === "a") {
      chosenVectors.push(question.vectorA);
    } else if (answer === "b") {
      chosenVectors.push(question.vectorB);
    }
  }

  if (!chosenVectors.length) {
    return {
      estimatedVector: neutral,
      archetype: "genre alchemist",
      teaserText: "Answer the questions to discover your taste archetype.",
      confidence: 0,
    };
  }

  const estimated = new Array<number>(dims).fill(0);
  for (const vec of chosenVectors) {
    for (let i = 0; i < dims; i += 1) {
      estimated[i] += vec[i] ?? 0.5;
    }
  }
  for (let i = 0; i < dims; i += 1) {
    estimated[i] = Number((estimated[i] / chosenVectors.length).toFixed(4));
  }

  const energy = estimated[1] ?? 0.5;
  const acousticness = estimated[6] ?? 0.5;
  const valence = estimated[9] ?? 0.5;
  const tempo = estimated[10] ?? 0.5;
  const loudness = estimated[3] ?? 0.5;

  let archetype: string;
  if (valence >= 0.65 && acousticness >= 0.50) archetype = "mood architect";
  else if (energy >= 0.70 && tempo >= 0.60) archetype = "kinetic seeker";
  else if (valence <= 0.40 && acousticness >= 0.45) archetype = "introspective wanderer";
  else if (acousticness <= 0.25 && loudness >= 0.65) archetype = "production maximalist";
  else archetype = "genre alchemist";

  const archetypeLabels: Record<string, string> = {
    "mood architect": "You engineer the emotional weather of every room you're in. Playlists are blueprints.",
    "kinetic seeker": "You want music that moves — literally. Tempo is your love language.",
    "introspective wanderer": "You use music to excavate, not escape. The minor keys know your name.",
    "production maximalist": "You hear the mix, not just the song. Every texture is intentional.",
    "genre alchemist": "Genre labels can't contain you. Your taste is a moving target — and that's the point.",
  };

  const confidence = Math.round((chosenVectors.length / SURVEY_QUESTIONS.length) * 100);
  const teaserText = archetypeLabels[archetype] ?? "Your taste is genuinely hard to classify. That's a compliment.";

  return { estimatedVector: estimated, archetype, teaserText, confidence };
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

function computeBlendVector(vectorA: number[], vectorB: number[]): number[] {
  if (!vectorA.length || !vectorB.length || vectorA.length !== vectorB.length) {
    return vectorA;
  }
  return vectorA.map((value, idx) => Number((((value ?? 0.5) + (vectorB[idx] ?? 0.5)) / 2).toFixed(4)));
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
  await setStoredSession(session);
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

app.get("/api/config/status", (_req, res) => {
  const missing = getMissingSpotifyEnv();
  return res.json({
    spotify: {
      configured: missing.length === 0,
      missing,
    },
    flags: {
      moodProductMode,
      legacyLiveRooms,
    },
  });
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

app.get("/auth/spotify/login", async (req, res) => {
  const mode = String(req.query.mode ?? "").toLowerCase();
  const missing = getMissingSpotifyEnv();
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.warn(`[oauth] Spotify login blocked; missing env vars: ${missing.join(", ")}`);
    return res.redirect(buildClientErrorRedirect(`Spotify is not configured locally. Missing: ${missing.join(", ")}`));
  }

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

  await setOAuthState(state, sid);
  if (mode === "demo") {
    res.cookie("post_auth_redirect", "/demo", {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecure,
      path: "/",
      maxAge: 1000 * 60 * 10,
    });
  }
  res.cookie("sid", sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure,
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 7,
  });
  // eslint-disable-next-line no-console
  console.log(`[oauth] Redirecting to Spotify with state=${state}`);
  return res.redirect(spotifyLoginUrl(state));
});

app.get("/auth/spotify/callback", async (req, res) => {
  try {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const requestHost = getRequestHost(req);
    const requestProto = getRequestProto(req);
    const redirectHost = getConfiguredRedirectHost();
    const postAuthRedirect = typeof req.cookies?.post_auth_redirect === "string"
      ? req.cookies.post_auth_redirect
      : "/";
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
    const expectedSid = await consumeOAuthState(state);

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
    await setStoredSession(session);
    const aid = extractAccountId(req);

    // eslint-disable-next-line no-console
    console.log(`[oauth] Session stored: sid=${sid}, aid=${aid ?? "none"}`);

    if (aid) {
      try {
        const profile = await fetchSpotifyProfile(tokens.accessToken).catch(() => undefined);
        session.spotifyProfile = profile;
        await setStoredSession(session);
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
    res.clearCookie("post_auth_redirect", {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecure,
      path: "/",
    });
    // eslint-disable-next-line no-console
    console.log(`[oauth] Callback complete, redirecting to ${postAuthRedirect}`);
    return res.redirect(postAuthRedirect === "/demo" ? "/demo" : "/");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    // eslint-disable-next-line no-console
    console.error(`[oauth] Callback error: ${message}`);
    return res.redirect(buildClientErrorRedirect(`Spotify auth failed: ${message}`));
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
    session.spotifyProfile = profile;
    await setStoredSession(session);
    const account = await getActiveAccount(req);
    if (account) {
      await saveSessionCacheToAccount(account.id, session, profile);
    }
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
    await setStoredSession(session);
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

app.post("/api/mood/sync", async (req, res) => {
  try {
    if (!moodProductMode) {
      return res.status(409).json({ error: "Mood mode is disabled." });
    }
    const session = await getActiveSession(req);
    const account = await getActiveAccount(req);
    const userId = getMoodActorUserId({
      account,
      session,
      fallbackSid: extractSessionId(req),
    });

    const body = roomGenerateBodySchema.safeParse(req.body ?? {});
    const force = body.success ? body.data.force ?? false : false;
    if (!force && session.bootstrapCompletedAt && session.tasteVector?.length) {
      const existing = await getLatestMoodSnapshot(userId);
      if (existing) {
        return res.json({
          queued: false,
          reused: true,
          snapshot: existing,
        });
      }
    }

    const [longTerm, mediumTerm, shortTerm] = await Promise.all([
      buildWindowVector(session.tokens.accessToken, session.tokens, "long_term"),
      buildWindowVector(session.tokens.accessToken, session.tokens, "medium_term"),
      buildWindowVector(session.tokens.accessToken, session.tokens, "short_term"),
    ]);
    const sampledCount = longTerm.sampled + mediumTerm.sampled + shortTerm.sampled;
    const metadataFallbackCount = longTerm.metadataFallbackCount + mediumTerm.metadataFallbackCount + shortTerm.metadataFallbackCount;
    const sourceDiversity =
      Number(longTerm.sampled > 0) + Number(mediumTerm.sampled > 0) + Number(shortTerm.sampled > 0) + Number(Boolean(session.artistInsights?.topGenres?.length)) + Number(Boolean(session.artistInsights?.topArtists?.length));

    const longVector = longTerm.vector.length ? longTerm.vector : session.tasteVector ?? [];
    const mediumVector = mediumTerm.vector.length ? mediumTerm.vector : longVector;
    const shortVector = shortTerm.vector.length ? shortTerm.vector : mediumVector;
    if (!longVector.length) {
      return res.status(400).json({ error: "Taste profile not available. Run bootstrap sync first." });
    }

    const snapshot = computeMoodSnapshot({
      userId,
      longTermVector: longVector,
      mediumTermVector: mediumVector,
      shortTermVector: shortVector,
      sampledCount,
      sourceDiversity,
      metadataFallbackRatio: sampledCount > 0 ? metadataFallbackCount / sampledCount : 1,
      recencyCompleteness: shortTerm.sampled > 0 ? 1 : 0.3,
    });
    await saveMoodSnapshot(snapshot);
    return res.json({
      queued: false,
      reused: false,
      snapshot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/mood/latest", async (req, res) => {
  try {
    if (!moodProductMode) {
      return res.status(409).json({ error: "Mood mode is disabled." });
    }
    const account = await getActiveAccount(req);
    let session: SessionRecord | null = null;
    try {
      session = await getActiveSession(req);
    } catch {
      session = null;
    }
    const userId = getMoodActorUserId({ account, session, fallbackSid: extractSessionId(req) });
    const snapshot = await getLatestMoodSnapshot(userId);
    if (!snapshot) {
      return res.status(404).json({ error: "No mood snapshot yet. Run POST /api/mood/sync first." });
    }
    return res.json({ snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/mood/timeline", async (req, res) => {
  try {
    if (!moodProductMode) {
      return res.status(409).json({ error: "Mood mode is disabled." });
    }
    const account = await getActiveAccount(req);
    let session: SessionRecord | null = null;
    try {
      session = await getActiveSession(req);
    } catch {
      session = null;
    }
    const userId = getMoodActorUserId({ account, session, fallbackSid: extractSessionId(req) });
    const limit = Math.max(1, Math.min(40, Number(req.query.limit ?? 20)));
    const snapshots = await listMoodSnapshots(userId, limit);
    return res.json({ userId, snapshots });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.post("/api/rooms/generate", async (req, res) => {
  try {
    if (!moodProductMode) {
      return res.status(409).json({ error: "Mood mode is disabled." });
    }
    const account = await getActiveAccount(req);
    let session: SessionRecord | null = null;
    try {
      session = await getActiveSession(req);
    } catch {
      session = null;
    }
    const userId = getMoodActorUserId({ account, session, fallbackSid: extractSessionId(req) });
    const latest = await getLatestMoodSnapshot(userId);
    if (!latest) {
      return res.status(400).json({ error: "Run mood sync before generating a room." });
    }
    const generated = generateInnerRoom({
      userId,
      snapshot: latest,
    });
    await saveRoomArtifact(generated.artifact);
    await attachAssetToArtifact(generated.asset);
    await setArtifactPrimaryAsset(generated.artifact.id, userId, generated.asset.id);
    const stored = await getRoomArtifactById(generated.artifact.id);
    return res.json({
      queued: false,
      artifact: stored.artifact,
      assets: stored.assets,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(400).json({ error: message });
  }
});

app.get("/api/rooms/latest", async (req, res) => {
  try {
    if (!moodProductMode) {
      return res.status(409).json({ error: "Mood mode is disabled." });
    }
    const account = await getActiveAccount(req);
    let session: SessionRecord | null = null;
    try {
      session = await getActiveSession(req);
    } catch {
      session = null;
    }
    const userId = getMoodActorUserId({ account, session, fallbackSid: extractSessionId(req) });
    const latest = await getLatestRoomArtifact(userId);
    if (!latest.artifact) {
      return res.status(404).json({ error: "No room artifact yet. Run POST /api/rooms/generate first." });
    }
    return res.json(latest);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/rooms/:artifactId", async (req, res) => {
  try {
    if (!moodProductMode) {
      return res.status(409).json({ error: "Mood mode is disabled." });
    }
    const record = await getRoomArtifactById(req.params.artifactId);
    if (!record.artifact) {
      return res.status(404).json({ error: "Room artifact not found." });
    }
    return res.json(record);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(400).json({ error: message });
  }
});

app.post("/api/blends", async (req, res) => {
  try {
    if (!moodProductMode) {
      return res.status(409).json({ error: "Mood mode is disabled." });
    }
    const body = blendCreateBodySchema.parse(req.body ?? {});
    const account = await getActiveAccount(req);
    let session: SessionRecord | null = null;
    try {
      session = await getActiveSession(req);
    } catch {
      session = null;
    }
    const initiatorUserId = getMoodActorUserId({ account, session, fallbackSid: extractSessionId(req) });
    const selfMood = await getLatestMoodSnapshot(initiatorUserId);
    const partnerMood = await getLatestMoodSnapshot(body.partnerUserId);
    if (!selfMood || !partnerMood) {
      return res.status(400).json({ error: "Both users need mood snapshots before blending." });
    }

    const blendVector = computeBlendVector(selfMood.baseVector, partnerMood.baseVector);

    const blend = await createBlendSession({
      initiatorUserId,
      partnerUserId: body.partnerUserId,
      blendVector,
    });
    await updateBlendSession(blend.id, { status: "processing" });

    const generated = generateBlendRoom({
      blendId: blend.id,
      initiatorUserId,
      partnerUserId: body.partnerUserId,
      blendVector,
      tagsFromA: selfMood.identityTags,
      tagsFromB: partnerMood.identityTags,
    });
    await saveRoomArtifact(generated.artifact);
    await attachAssetToArtifact(generated.asset);
    await setArtifactPrimaryAsset(generated.artifact.id, generated.artifact.userId, generated.asset.id);
    const updated = await updateBlendSession(blend.id, {
      status: "ready",
      artifactId: generated.artifact.id,
      completedAt: Date.now(),
      explainability: {
        fromA: selfMood.identityTags.slice(0, 2),
        fromB: partnerMood.identityTags.slice(0, 2),
        bridge: ["shared mood vector midpoint", "retained symbolic anchors"],
      },
    });
    return res.json({ blend: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(400).json({ error: message });
  }
});

app.get("/api/blends/:id", async (req, res) => {
  try {
    if (!moodProductMode) {
      return res.status(409).json({ error: "Mood mode is disabled." });
    }
    const blend = await getBlendSession(req.params.id);
    if (!blend) {
      return res.status(404).json({ error: "Blend session not found." });
    }
    const artifact = blend.artifactId ? await getRoomArtifactById(blend.artifactId) : { artifact: null, assets: [] };
    return res.json({ blend, artifact: artifact.artifact, assets: artifact.assets });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(400).json({ error: message });
  }
});

app.post("/api/share-links", async (req, res) => {
  try {
    if (!moodProductMode) {
      return res.status(409).json({ error: "Mood mode is disabled." });
    }
    const body = shareLinkCreateBodySchema.parse(req.body ?? {});
    const account = await getActiveAccount(req);
    let session: SessionRecord | null = null;
    try {
      session = await getActiveSession(req);
    } catch {
      session = null;
    }
    const ownerUserId = getMoodActorUserId({ account, session, fallbackSid: extractSessionId(req) });
    const link = await createShareLink({
      ownerUserId,
      targetType: body.targetType,
      targetId: body.targetId,
      visibility: body.visibility,
      expiresAt: body.expiresInHours ? Date.now() + body.expiresInHours * 60 * 60 * 1000 : undefined,
    });
    return res.json({
      link,
      url: `/s/${link.token}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(400).json({ error: message });
  }
});

app.delete("/api/share-links/:id", async (req, res) => {
  try {
    if (!moodProductMode) {
      return res.status(409).json({ error: "Mood mode is disabled." });
    }
    const account = await getActiveAccount(req);
    let session: SessionRecord | null = null;
    try {
      session = await getActiveSession(req);
    } catch {
      session = null;
    }
    const ownerUserId = getMoodActorUserId({ account, session, fallbackSid: extractSessionId(req) });
    const ok = await revokeShareLink(req.params.id, ownerUserId);
    if (!ok) {
      return res.status(404).json({ error: "Share link not found." });
    }
    return res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(400).json({ error: message });
  }
});

app.get("/s/:token", async (req, res) => {
  try {
    if (!moodProductMode) {
      return res.status(404).send("Not found");
    }
    const link = await resolveShareToken(req.params.token);
    if (!link) {
      return res.status(404).send("Share link is invalid or expired.");
    }
    if (link.targetType === "user_room") {
      const artifact = await getRoomArtifactById(link.targetId);
      if (!artifact.artifact) {
        return res.status(404).send("Shared room artifact not found.");
      }
      return res.json({
        type: "user_room",
        link,
        artifact: artifact.artifact,
        assets: artifact.assets,
      });
    }
    const blend = await getBlendSession(link.targetId);
    if (!blend) {
      return res.status(404).send("Shared blend artifact not found.");
    }
    const artifact = blend.artifactId ? await getRoomArtifactById(blend.artifactId) : { artifact: null, assets: [] };
    return res.json({
      type: "blend_room",
      link,
      blend,
      artifact: artifact.artifact,
      assets: artifact.assets,
    });
  } catch {
    return res.status(400).send("Invalid share link.");
  }
});

app.post("/api/livekit/token", async (req, res) => {
  if (!legacyLiveRooms) {
    return res.status(410).json({
      error: "Live room mode is deprecated. Use mood snapshots and async blend sessions instead.",
      deprecated: true,
    });
  }
  try {
    const actor = await getRoomActor(req);
    const body = liveKitTokenBodySchema.parse(req.body);
    const tokenPayload = await createLiveKitAccessToken({
      roomName: body.roomName,
      participantName: body.participantName,
      sessionId: actor.sessionId,
    });

    await markParticipantJoined({
      roomName: tokenPayload.roomName,
      participantName: tokenPayload.participantName,
      sessionId: actor.sessionId,
    });

    return res.json(tokenPayload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.post("/api/rooms/:roomName/share-state", async (req, res) => {
  if (!legacyLiveRooms) {
    return res.status(410).json({ error: "Live room mode is deprecated.", deprecated: true });
  }
  try {
    const actor = await getRoomActor(req);
    const session = actor.session;
    const cached = actor.cached;
    if (session) {
      session.streamModePreference = "live";
      await setStoredSession(session);
    }
    const roomName = cleanRoomName(req.params.roomName);
    const body = roomShareBodySchema.parse(req.body);

    await markParticipantJoined({
      roomName,
      participantName: body.participantName,
      sessionId: actor.sessionId,
    });
    await startLiveStream({
      roomName,
      sessionId: actor.sessionId,
      participantName: body.participantName,
    });

    const tasteVector = session?.tasteVector?.length
      ? session.tasteVector
      : cached?.tasteVector?.length
        ? cached.tasteVector
        : null;
    const tasteUpdatedAt = session?.tasteUpdatedAt ?? cached?.tasteUpdatedAt;

    let tasteProfile = null;
    if (tasteVector && tasteVector.length) {
      tasteProfile = {
        roomName,
        participantName: body.participantName,
        timestamp: Date.now(),
        tasteVector,
        tasteUpdatedAt,
        topSignals: topTasteSignals(tasteVector),
        profileStats: {
          dims: tasteVector.length,
        },
      };
      await shareTasteProfile({
        roomName,
        sessionId: actor.sessionId,
        participantName: body.participantName,
        profile: tasteProfile,
      });
    }

    const includeNowPlaying = body.includeNowPlaying ?? true;
    let nowPlayingState = null;
    if (includeNowPlaying && session) {
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
        sessionId: actor.sessionId,
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
      warnings: session ? [] : ["Spotify live session not active; shared room state uses cached taste profile only."],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(400).json({ error: message });
  }
});

app.post("/api/rooms/:roomName/leave", async (req, res) => {
  if (!legacyLiveRooms) {
    return res.status(410).json({ error: "Live room mode is deprecated.", deprecated: true });
  }
  try {
    const actor = await getRoomActor(req);
    const roomName = cleanRoomName(req.params.roomName);
    await endLiveStream({ roomName, sessionId: actor.sessionId });
    await markParticipantLeft({ roomName, sessionId: actor.sessionId });
    const snapshot = await recordBatchSnapshot(roomName, "stream_end");
    const room = await getRoomSnapshot(roomName);
    return res.json({ room, snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(400).json({ error: message });
  }
});

app.post("/api/rooms/:roomName/publish", async (req, res) => {
  if (!legacyLiveRooms) {
    return res.status(410).json({ error: "Live room mode is deprecated.", deprecated: true });
  }
  try {
    await getRoomActor(req);
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
  if (!legacyLiveRooms) {
    return res.status(410).json({ error: "Live room mode is deprecated.", deprecated: true });
  }
  try {
    const actor = await getRoomActor(req);
    const limit = Math.max(1, Math.min(30, Number(req.query.limit ?? 20)));
    const rooms = await listActiveRooms(limit);

    const myVector = actor.session?.tasteVector ?? actor.cached?.tasteVector;
    const roomsWithMatch: Array<{
      roomName: string;
      published: boolean;
      connectedCount: number;
      tasteReadyCount: number;
      updatedAt: number;
      tasteMatchPct: number | null;
    }> = rooms.map((room) => ({ ...room, tasteMatchPct: null }));

    if (myVector?.length) {
      for (const room of roomsWithMatch) {
        const snapshot = await getRoomSnapshot(room.roomName);
        const tasteReadyParticipants = snapshot.participants.filter(
          (p) => p.connected && p.tasteProfile?.tasteVector?.length,
        );
        if (!tasteReadyParticipants.length) {
          continue;
        }
        let totalSim = 0;
        let count = 0;
        for (const p of tasteReadyParticipants) {
          const vec = p.tasteProfile?.tasteVector;
          if (!vec?.length || vec.length !== myVector.length) continue;
          let dot = 0;
          let normA = 0;
          let normB = 0;
          for (let i = 0; i < myVector.length; i += 1) {
            dot += myVector[i] * vec[i];
            normA += myVector[i] * myVector[i];
            normB += vec[i] * vec[i];
          }
          totalSim += normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
          count += 1;
        }
        if (count) {
          room.tasteMatchPct = Math.round(Math.max(0, Math.min(100, (totalSim / count + 1) / 2 * 100)));
        }
      }
    }

    return res.json({ rooms: roomsWithMatch });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/rooms/:roomName/history", async (req, res) => {
  if (!legacyLiveRooms) {
    return res.status(410).json({ error: "Live room mode is deprecated.", deprecated: true });
  }
  try {
    await getRoomActor(req);
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
  if (!legacyLiveRooms) {
    return res.status(410).json({ error: "Live room mode is deprecated.", deprecated: true });
  }
  try {
    await getRoomActor(req);
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
  if (!legacyLiveRooms) {
    return res.status(410).json({ error: "Live room mode is deprecated.", deprecated: true });
  }
  try {
    await getRoomActor(req);
    const roomName = cleanRoomName(req.params.roomName);
    const room = await getRoomSnapshot(roomName);
    return res.json({ room });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/rooms/:roomName/compatibility", async (req, res) => {
  if (!legacyLiveRooms) {
    return res.status(410).json({ error: "Live room mode is deprecated.", deprecated: true });
  }
  try {
    await getRoomActor(req);
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

    return res.json({
      ...room.lastCompatibility,
      vibeClash: room.lastCompatibility.score.cosineSimilarity < 0.5,
      vibeClashPrompt: room.lastCompatibility.score.cosineSimilarity < 0.5
        ? "🌋 Vibe Clash detected! Can you find a track you both love?"
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/rooms/:roomName/mutual-recommendations", async (req, res) => {
  if (!legacyLiveRooms) {
    return res.status(410).json({ error: "Live room mode is deprecated.", deprecated: true });
  }
  try {
    await getRoomActor(req);
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

// ── Feature 1: Taste Twin Match Card ─────────────────────────────────────────

app.get("/api/rooms/:roomName/match-card", async (req, res) => {
  if (!legacyLiveRooms) {
    return res.status(410).json({ error: "Live room mode is deprecated.", deprecated: true });
  }
  try {
    await getRoomActor(req);
    const roomName = cleanRoomName(req.params.roomName);
    const room = await getRoomSnapshot(roomName);

    if (!room.lastCompatibility) {
      return res.status(404).json({ error: "No compatibility data found for this room. Share taste profiles first." });
    }

    const comp = room.lastCompatibility;
    const { verdict, verdictEmoji } = computeMatchVerdictFromScore(comp.score.overallScore);

    const pair = room.participants.filter((p) => p.tasteProfile);
    const signalsA = pair[0]?.tasteProfile?.topSignals ?? [];
    const signalsB = pair[1]?.tasteProfile?.topSignals ?? [];
    const overlappingSignals = pair.length >= 2
      ? signalsA.filter((sig) => signalsB.includes(sig))
      : [];

    const shareText =
      `${comp.score.participantA} and ${comp.score.participantB} scored ` +
      `${comp.score.overallScore}/100 on Wave2Vector ${verdictEmoji} ` +
      `"${verdict}" #TasteTwins #wave2vector`;

    return res.json({
      roomName,
      participantA: comp.score.participantA,
      participantB: comp.score.participantB,
      overallScore: comp.score.overallScore,
      similarityLabel: comp.similarityLabel,
      verdict,
      verdictEmoji,
      overlappingSignals,
      shareText,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

// ── Feature 2: Outlier Track Badge ───────────────────────────────────────────

app.get("/api/profile/outlier-track", async (req, res) => {
  try {
    const account = await getActiveAccount(req);
    let session: SessionRecord | null = null;
    try {
      session = await getActiveSession(req);
    } catch {
      session = null;
    }
    const sessionLike = session ?? (account ? await getCachedSessionLike(account.id) : null);
    if (!sessionLike?.tasteVector?.length) {
      return res.status(400).json({ error: "Taste profile not available. Run a sync first." });
    }

    const k = Math.max(1, Math.min(10, Number(req.query.k ?? 5)));
    const outliers = findOutlierTracks(sessionLike.tasteVector, library, k);
    return res.json({ outliers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

// ── Feature 4: Taste Horoscope ────────────────────────────────────────────────

app.get("/api/profile/horoscope", async (req, res) => {
  try {
    const account = await getActiveAccount(req);
    let session: SessionRecord | null = null;
    try {
      session = await getActiveSession(req);
    } catch {
      session = null;
    }
    const sessionLike = session ?? (account ? await getCachedSessionLike(account.id) : null);
    if (!sessionLike?.tasteVector?.length) {
      return res.status(400).json({ error: "Taste profile not available. Run a sync first." });
    }

    const horoscope = buildTasteHoroscope(sessionLike);
    if (!horoscope) {
      return res.status(400).json({ error: "Unable to generate horoscope." });
    }
    return res.json(horoscope);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

// ── Feature 5: Niche Listener Score ──────────────────────────────────────────

app.get("/api/leaderboard/niche", async (req, res) => {
  try {
    const account = await getActiveAccount(req);
    let session: SessionRecord | null = null;
    try {
      session = await getActiveSession(req);
    } catch {
      session = null;
    }
    const sessionLike = session ?? (account ? await getCachedSessionLike(account.id) : null);
    if (!sessionLike?.tasteVector?.length) {
      return res.status(400).json({ error: "Taste profile not available. Run a sync first." });
    }

    const result = computeNicheScore(sessionLike.tasteVector, library);
    const displayName = sessionLike.spotifyProfile?.displayName?.trim() || "Listener";
    return res.json({
      displayName,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(401).json({ error: message });
  }
});

// ── Feature 7: Onboarding Taste Survey ───────────────────────────────────────

app.get("/api/survey/questions", (_req, res) => {
  return res.json({
    questions: SURVEY_QUESTIONS.map(({ id, optionA, optionB, hint }) => ({ id, optionA, optionB, hint })),
  });
});

app.post("/api/survey/estimate", (req, res) => {
  try {
    const body = surveyAnswerSchema.parse(req.body ?? {});
    const result = estimateVectorFromSurvey(body.answers);
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    return res.status(400).json({ error: message });
  }
});

// ── Feature 8: Taste Time Capsule ────────────────────────────────────────────

app.post("/api/profile/capsule", async (req, res) => {
  try {
    const account = await getActiveAccount(req);
    let session: SessionRecord | null = null;
    try {
      session = await getActiveSession(req);
    } catch {
      session = null;
    }

    const tasteVector = session?.tasteVector ?? (account ? (await getCachedSessionLike(account.id))?.tasteVector : undefined);
    if (!tasteVector?.length) {
      return res.status(400).json({ error: "Taste profile not available. Run a sync first." });
    }

    const topArtists = (session?.artistInsights ?? (account ? (await getCachedSessionLike(account.id))?.artistInsights : undefined))
      ?.topArtists?.map((a) => a.name) ?? [];

    const capsule: TasteCapsule = {
      lockedAt: Date.now(),
      tasteVector,
      topArtists: topArtists.slice(0, 10),
    };

    if (session) {
      session.tasteCapsule = capsule;
      await setStoredSession(session);
      if (account) {
        await saveSessionCacheToAccount(account.id, session);
      }
    } else if (account) {
      const cached = await getCachedSessionLike(account.id);
      const syntheticSession = {
        ...cached,
        id: `aid:${account.id}`,
        tokens: { accessToken: "", refreshToken: "", expiresAt: 0 },
        tasteCapsule: capsule,
      } as SessionRecord;
      await saveSessionCacheToAccount(account.id, syntheticSession);
    }

    return res.json({ capsule, message: "Taste time capsule locked. Check back in 90 days." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(400).json({ error: message });
  }
});

app.get("/api/profile/capsule", async (req, res) => {
  try {
    const account = await getActiveAccount(req);
    let session: SessionRecord | null = null;
    try {
      session = await getActiveSession(req);
    } catch {
      session = null;
    }

    const cached = !session && account ? await getCachedSessionLike(account.id) : null;
    const capsule = session?.tasteCapsule ?? cached?.tasteCapsule;

    if (!capsule) {
      return res.json({ capsule: null, message: "No taste capsule locked yet. Use POST to lock your current taste." });
    }

    const currentVector = session?.tasteVector ?? cached?.tasteVector;
    const daysSinceLock = Math.floor((Date.now() - capsule.lockedAt) / (1000 * 60 * 60 * 24));
    const isReady = daysSinceLock >= 90;

    if (!currentVector?.length || !isReady) {
      return res.json({
        capsule,
        daysSinceLock,
        isReady,
        message: isReady
          ? "Your capsule is ready to open!"
          : `${90 - daysSinceLock} days until your taste capsule is ready to open.`,
      });
    }

    const dims = Math.min(capsule.tasteVector.length, currentVector.length);
    const featureLabels = vectorFeatureNames;
    const diffs = Array.from({ length: dims }, (_, i) => ({
      feature: featureLabels[i] ?? `feature_${i + 1}`,
      delta: Number(((currentVector[i] ?? 0) - (capsule.tasteVector[i] ?? 0)).toFixed(4)),
      direction: (currentVector[i] ?? 0) > (capsule.tasteVector[i] ?? 0) ? "up" : "down",
    }))
      .filter((d) => Math.abs(d.delta) >= 0.03)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 5);

    const changeLines = diffs.map(
      (d) => `Your ${d.feature} ${d.direction === "up" ? "rose" : "dropped"} ${Math.abs(Math.round(d.delta * 100))}%.`,
    );

    return res.json({
      capsule,
      daysSinceLock,
      isReady: true,
      currentVector,
      topChanges: diffs,
      summary: changeLines.length
        ? changeLines.join(" ")
        : "Your taste is remarkably consistent — or you haven't changed much. Either way, you know who you are.",
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
