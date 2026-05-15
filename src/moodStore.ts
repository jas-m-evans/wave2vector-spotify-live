import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "@upstash/redis";
import { BlendSession, GeneratedAsset, MoodProfileSnapshot, RoomArtifact, ShareLink } from "./types.js";

type PersistedMoodState = {
  updatedAt: string;
  moodSnapshots: MoodProfileSnapshot[];
  roomArtifacts: RoomArtifact[];
  generatedAssets: GeneratedAsset[];
  blendSessions: BlendSession[];
  shareLinks: ShareLink[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, "../.data");
const moodStorePath = path.resolve(dataDir, "mood-state.json");

const moodSnapshots = new Map<string, MoodProfileSnapshot[]>();
const roomArtifacts = new Map<string, RoomArtifact[]>();
const generatedAssets = new Map<string, GeneratedAsset[]>();
const blendSessions = new Map<string, BlendSession>();
const shareLinks = new Map<string, ShareLink>();
const shareByToken = new Map<string, ShareLink>();

let loaded = false;
const useRedis = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
let redis: Redis | null = null;
if (useRedis) {
  try {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  } catch {
    redis = null;
  }
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  try {
    const raw = redis ? await redis.get<string>("mood:state") : await fs.readFile(moodStorePath, "utf8");
    if (!raw || typeof raw !== "string") {
      loaded = true;
      return;
    }
    const parsed = JSON.parse(raw) as PersistedMoodState;
    for (const snapshot of parsed.moodSnapshots ?? []) {
      const list = moodSnapshots.get(snapshot.userId) ?? [];
      list.push(snapshot);
      moodSnapshots.set(snapshot.userId, list);
    }
    for (const artifact of parsed.roomArtifacts ?? []) {
      const list = roomArtifacts.get(artifact.userId) ?? [];
      list.push(artifact);
      roomArtifacts.set(artifact.userId, list);
    }
    for (const asset of parsed.generatedAssets ?? []) {
      const list = generatedAssets.get(asset.artifactId) ?? [];
      list.push(asset);
      generatedAssets.set(asset.artifactId, list);
    }
    for (const blend of parsed.blendSessions ?? []) {
      blendSessions.set(blend.id, blend);
    }
    for (const link of parsed.shareLinks ?? []) {
      shareLinks.set(link.id, link);
      shareByToken.set(link.token, link);
    }
  } catch {
    // no-op
  }
  loaded = true;
}

async function persist(): Promise<void> {
  const payload: PersistedMoodState = {
    updatedAt: new Date().toISOString(),
    moodSnapshots: [...moodSnapshots.values()].flat(),
    roomArtifacts: [...roomArtifacts.values()].flat(),
    generatedAssets: [...generatedAssets.values()].flat(),
    blendSessions: [...blendSessions.values()],
    shareLinks: [...shareLinks.values()],
  };
  const serial = JSON.stringify(payload, null, 2);
  if (redis) {
    await redis.set("mood:state", serial);
    return;
  }
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(moodStorePath, serial, "utf8");
}

export async function saveMoodSnapshot(snapshot: MoodProfileSnapshot): Promise<void> {
  await ensureLoaded();
  const list = moodSnapshots.get(snapshot.userId) ?? [];
  list.unshift(snapshot);
  moodSnapshots.set(snapshot.userId, list.slice(0, 120));
  await persist();
}

export async function getLatestMoodSnapshot(userId: string): Promise<MoodProfileSnapshot | null> {
  await ensureLoaded();
  return moodSnapshots.get(userId)?.[0] ?? null;
}

export async function listMoodSnapshots(userId: string, limit = 20): Promise<MoodProfileSnapshot[]> {
  await ensureLoaded();
  return (moodSnapshots.get(userId) ?? []).slice(0, Math.max(1, limit));
}

export async function saveRoomArtifact(artifact: RoomArtifact): Promise<void> {
  await ensureLoaded();
  const list = roomArtifacts.get(artifact.userId) ?? [];
  list.unshift(artifact);
  roomArtifacts.set(artifact.userId, list.slice(0, 120));
  await persist();
}

export async function attachAssetToArtifact(asset: GeneratedAsset): Promise<void> {
  await ensureLoaded();
  const list = generatedAssets.get(asset.artifactId) ?? [];
  list.unshift(asset);
  generatedAssets.set(asset.artifactId, list.slice(0, 20));
  await persist();
}

export async function setArtifactPrimaryAsset(artifactId: string, userId: string, assetId: string): Promise<void> {
  await ensureLoaded();
  const list = roomArtifacts.get(userId) ?? [];
  const item = list.find((artifact) => artifact.id === artifactId);
  if (!item) return;
  item.primaryAssetId = assetId;
  item.status = "ready";
  await persist();
}

export async function getRoomArtifactById(artifactId: string): Promise<{
  artifact: RoomArtifact | null;
  assets: GeneratedAsset[];
}> {
  await ensureLoaded();
  for (const list of roomArtifacts.values()) {
    const artifact = list.find((item) => item.id === artifactId);
    if (artifact) {
      return {
        artifact,
        assets: generatedAssets.get(artifact.id) ?? [],
      };
    }
  }
  return { artifact: null, assets: [] };
}

export async function getLatestRoomArtifact(userId: string): Promise<{ artifact: RoomArtifact | null; assets: GeneratedAsset[] }> {
  await ensureLoaded();
  const artifact = roomArtifacts.get(userId)?.[0] ?? null;
  if (!artifact) return { artifact: null, assets: [] };
  return { artifact, assets: generatedAssets.get(artifact.id) ?? [] };
}

export async function createBlendSession(session: Omit<BlendSession, "id" | "createdAt" | "status">): Promise<BlendSession> {
  await ensureLoaded();
  const created: BlendSession = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    status: "queued",
    ...session,
  };
  blendSessions.set(created.id, created);
  await persist();
  return created;
}

export async function updateBlendSession(
  blendId: string,
  patch: Partial<BlendSession>,
): Promise<BlendSession | null> {
  await ensureLoaded();
  const existing = blendSessions.get(blendId);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  blendSessions.set(blendId, updated);
  await persist();
  return updated;
}

export async function getBlendSession(blendId: string): Promise<BlendSession | null> {
  await ensureLoaded();
  return blendSessions.get(blendId) ?? null;
}

export async function createShareLink(payload: {
  ownerUserId: string;
  targetType: ShareLink["targetType"];
  targetId: string;
  visibility: ShareLink["visibility"];
  expiresAt?: number;
}): Promise<ShareLink> {
  await ensureLoaded();
  const token = crypto.randomBytes(16).toString("hex");
  const link: ShareLink = {
    id: crypto.randomUUID(),
    ownerUserId: payload.ownerUserId,
    targetType: payload.targetType,
    targetId: payload.targetId,
    visibility: payload.visibility,
    token,
    createdAt: Date.now(),
    expiresAt: payload.expiresAt,
  };
  shareLinks.set(link.id, link);
  shareByToken.set(link.token, link);
  await persist();
  return link;
}

export async function resolveShareToken(token: string): Promise<ShareLink | null> {
  await ensureLoaded();
  const link = shareByToken.get(token) ?? null;
  if (!link || link.revokedAt) return null;
  if (typeof link.expiresAt === "number" && Date.now() > link.expiresAt) return null;
  return link;
}

export async function revokeShareLink(linkId: string, ownerUserId: string): Promise<boolean> {
  await ensureLoaded();
  const link = shareLinks.get(linkId);
  if (!link || link.ownerUserId !== ownerUserId) return false;
  link.revokedAt = Date.now();
  shareLinks.set(link.id, link);
  shareByToken.set(link.token, link);
  await persist();
  return true;
}
