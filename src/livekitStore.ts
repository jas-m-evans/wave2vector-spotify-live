import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "@upstash/redis";
import {
  CompatibilitySummary,
  MutualRecommendation,
  RoomBatchSnapshot,
  RoomEvent,
  RoomParticipantSnapshot,
  RoomStateSnapshot,
  SharedNowPlaying,
  SharedTasteProfile,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, "../.data");
const roomEventsPath = path.resolve(dataDir, "livekit-events.json");
const roomStatePath = path.resolve(dataDir, "livekit-room-state.json");

const rooms = new Map<string, RoomStateSnapshot>();
const roomHistory = new Map<string, RoomBatchSnapshot[]>();
let loaded = false;

// Detect if running on Vercel with Upstash Redis available
const useRedis = Boolean(process.env.UPSTASH_REDIS_REST_URL);
let redis: Redis | null = null;

if (useRedis) {
  try {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  } catch {
    // Fallback to local fs if Redis fails
  }
}

async function ensureLoaded(): Promise<void> {
  if (loaded) {
    return;
  }
  try {
    if (redis) {
      const raw = await redis.get("livekit:room-state");
      if (raw && typeof raw === "string") {
        const parsed = JSON.parse(raw) as {
          rooms?: RoomStateSnapshot[];
          history?: Record<string, RoomBatchSnapshot[]>;
        };
        for (const room of parsed.rooms ?? []) {
          rooms.set(room.roomName, room);
        }
        for (const [roomName, snapshots] of Object.entries(parsed.history ?? {})) {
          roomHistory.set(roomName, snapshots ?? []);
        }
      }
    } else {
      const raw = await fs.readFile(roomStatePath, "utf8");
      const parsed = JSON.parse(raw) as {
        rooms?: RoomStateSnapshot[];
        history?: Record<string, RoomBatchSnapshot[]>;
      };
      for (const room of parsed.rooms ?? []) {
        rooms.set(room.roomName, room);
      }
      for (const [roomName, snapshots] of Object.entries(parsed.history ?? {})) {
        roomHistory.set(roomName, snapshots ?? []);
      }
    }
  } catch {
    // no-op
  }
  loaded = true;
}

async function persistRooms(): Promise<void> {
  const payload = {
    updatedAt: new Date().toISOString(),
    rooms: [...rooms.values()],
    history: Object.fromEntries(roomHistory.entries()),
  };
  if (redis) {
    await redis.set("livekit:room-state", JSON.stringify(payload));
  } else {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(roomStatePath, JSON.stringify(payload, null, 2), "utf8");
  }
}

async function appendEvent(event: RoomEvent): Promise<void> {
  let events: RoomEvent[] = [];
  if (redis) {
    const raw = await redis.get("livekit:events");
    if (raw && typeof raw === "string") {
      const parsed = JSON.parse(raw) as { events?: RoomEvent[] };
      events = parsed.events ?? [];
    }
    events.push(event);
    await redis.set("livekit:events", JSON.stringify({ events }));
  } else {
    try {
      const raw = await fs.readFile(roomEventsPath, "utf8");
      const parsed = JSON.parse(raw) as { events?: RoomEvent[] };
      events = parsed.events ?? [];
    } catch {
      events = [];
    }
    events.push(event);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(roomEventsPath, JSON.stringify({ events }, null, 2), "utf8");
  }
}

function ensureRoom(roomName: string): RoomStateSnapshot {
  const existing = rooms.get(roomName);
  if (existing) {
    return existing;
  }
  const created: RoomStateSnapshot = {
    roomName,
    participants: [],
    updatedAt: Date.now(),
    published: false,
  };
  rooms.set(roomName, created);
  return created;
}

function upsertParticipant(
  room: RoomStateSnapshot,
  sessionId: string,
  participantName: string,
): RoomParticipantSnapshot {
  const existing = room.participants.find((participant) => participant.sessionId === sessionId);
  if (existing) {
    existing.participantName = participantName;
    existing.connected = true;
    existing.lastSeenAt = Date.now();
    return existing;
  }

  const created: RoomParticipantSnapshot = {
    sessionId,
    participantName,
    connected: true,
    lastSeenAt: Date.now(),
  };
  room.participants.push(created);
  return created;
}

export async function markParticipantJoined(params: {
  roomName: string;
  sessionId: string;
  participantName: string;
}): Promise<void> {
  await ensureLoaded();
  const room = ensureRoom(params.roomName);
  upsertParticipant(room, params.sessionId, params.participantName);
  room.updatedAt = Date.now();

  await persistRooms();
  await appendEvent({
    id: crypto.randomUUID(),
    roomName: params.roomName,
    sessionId: params.sessionId,
    participantName: params.participantName,
    type: "room_joined",
    timestamp: Date.now(),
  });
}

export async function startLiveStream(params: {
  roomName: string;
  sessionId: string;
  participantName: string;
}): Promise<void> {
  await ensureLoaded();
  const room = ensureRoom(params.roomName);
  if (!room.liveStreamStartedAt || room.liveStreamEndedAt) {
    room.liveStreamStartedAt = Date.now();
    room.liveStreamEndedAt = undefined;
  }
  room.updatedAt = Date.now();
  await persistRooms();

  await appendEvent({
    id: crypto.randomUUID(),
    roomName: params.roomName,
    sessionId: params.sessionId,
    participantName: params.participantName,
    type: "stream_started",
    timestamp: Date.now(),
  });
}

export async function markParticipantLeft(params: {
  roomName: string;
  sessionId: string;
}): Promise<void> {
  await ensureLoaded();
  const room = ensureRoom(params.roomName);
  const participant = room.participants.find((item) => item.sessionId === params.sessionId);
  if (participant) {
    participant.connected = false;
    participant.lastSeenAt = Date.now();
  }
  room.updatedAt = Date.now();

  await persistRooms();
  await appendEvent({
    id: crypto.randomUUID(),
    roomName: params.roomName,
    sessionId: params.sessionId,
    participantName: participant?.participantName,
    type: "room_left",
    timestamp: Date.now(),
  });
}

export async function endLiveStream(params: {
  roomName: string;
  sessionId: string;
}): Promise<void> {
  await ensureLoaded();
  const room = ensureRoom(params.roomName);
  room.liveStreamEndedAt = Date.now();
  room.updatedAt = Date.now();

  await persistRooms();
  await appendEvent({
    id: crypto.randomUUID(),
    roomName: params.roomName,
    sessionId: params.sessionId,
    type: "stream_ended",
    timestamp: Date.now(),
  });
}

export async function shareTasteProfile(params: {
  roomName: string;
  sessionId: string;
  participantName: string;
  profile: SharedTasteProfile;
}): Promise<void> {
  await ensureLoaded();
  const room = ensureRoom(params.roomName);
  const participant = upsertParticipant(room, params.sessionId, params.participantName);
  participant.tasteProfile = params.profile;
  participant.lastSeenAt = Date.now();
  room.updatedAt = Date.now();

  await persistRooms();
  await appendEvent({
    id: crypto.randomUUID(),
    roomName: params.roomName,
    sessionId: params.sessionId,
    participantName: params.participantName,
    type: "taste_profile_shared",
    timestamp: Date.now(),
    payload: {
      dims: params.profile.profileStats.dims,
    },
  });
}

export async function shareNowPlaying(params: {
  roomName: string;
  sessionId: string;
  participantName: string;
  nowPlayingState: SharedNowPlaying;
}): Promise<void> {
  await ensureLoaded();
  const room = ensureRoom(params.roomName);
  const participant = upsertParticipant(room, params.sessionId, params.participantName);
  participant.nowPlayingState = params.nowPlayingState;
  participant.lastSeenAt = Date.now();
  room.updatedAt = Date.now();

  await persistRooms();
  await appendEvent({
    id: crypto.randomUUID(),
    roomName: params.roomName,
    sessionId: params.sessionId,
    participantName: params.participantName,
    type: "now_playing_shared",
    timestamp: Date.now(),
    payload: {
      trackId: params.nowPlayingState.nowPlaying?.trackId,
    },
  });
}

export async function setCompatibilitySummary(roomName: string, summary: CompatibilitySummary): Promise<void> {
  await ensureLoaded();
  const room = ensureRoom(roomName);
  room.lastCompatibility = summary;
  room.updatedAt = Date.now();

  await persistRooms();
  await appendEvent({
    id: crypto.randomUUID(),
    roomName,
    type: "compatibility_computed",
    timestamp: Date.now(),
    payload: {
      overallScore: summary.score.overallScore,
      label: summary.similarityLabel,
    },
  });
}

export async function setMutualRecommendations(
  roomName: string,
  recommendations: MutualRecommendation[],
): Promise<void> {
  await ensureLoaded();
  const room = ensureRoom(roomName);
  room.lastMutualRecommendations = recommendations;
  room.updatedAt = Date.now();

  await persistRooms();
  await appendEvent({
    id: crypto.randomUUID(),
    roomName,
    type: "mutual_recommendations_computed",
    timestamp: Date.now(),
    payload: {
      count: recommendations.length,
    },
  });
}

export async function getRoomSnapshot(roomName: string): Promise<RoomStateSnapshot> {
  await ensureLoaded();
  return ensureRoom(roomName);
}

export async function getTwoActiveParticipants(
  roomName: string,
): Promise<[RoomParticipantSnapshot, RoomParticipantSnapshot] | null> {
  const room = await getRoomSnapshot(roomName);
  const active = room.participants.filter((participant) => participant.connected && participant.tasteProfile);
  if (active.length < 2) {
    return null;
  }

  return [active[0], active[1]];
}

export async function setRoomPublished(roomName: string, published: boolean): Promise<RoomStateSnapshot> {
  await ensureLoaded();
  const room = ensureRoom(roomName);
  room.published = published;
  room.updatedAt = Date.now();
  await persistRooms();
  return room;
}

export async function listActiveRooms(limit = 20): Promise<Array<{
  roomName: string;
  published: boolean;
  connectedCount: number;
  tasteReadyCount: number;
  updatedAt: number;
}>> {
  await ensureLoaded();
  return [...rooms.values()]
    .filter((room) => room.participants.some((participant) => participant.connected))
    .map((room) => {
      const connected = room.participants.filter((participant) => participant.connected);
      const tasteReady = connected.filter((participant) => participant.tasteProfile);
      return {
        roomName: room.roomName,
        published: Boolean(room.published),
        connectedCount: connected.length,
        tasteReadyCount: tasteReady.length,
        updatedAt: room.updatedAt,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(1, limit));
}

export async function recordBatchSnapshot(
  roomName: string,
  reason: "stream_end" | "manual" = "manual",
): Promise<RoomBatchSnapshot> {
  await ensureLoaded();
  const room = ensureRoom(roomName);
  const connected = room.participants.filter((participant) => participant.connected);
  const tasteReady = connected.filter((participant) => participant.tasteProfile);
  const snapshot: RoomBatchSnapshot = {
    id: crypto.randomUUID(),
    roomName,
    createdAt: Date.now(),
    reason,
    participantCount: connected.length,
    tasteReadyCount: tasteReady.length,
    compatibility: room.lastCompatibility,
    mutualRecommendations: room.lastMutualRecommendations,
  };

  const existing = roomHistory.get(roomName) ?? [];
  existing.unshift(snapshot);
  roomHistory.set(roomName, existing.slice(0, 40));
  await persistRooms();
  await appendEvent({
    id: crypto.randomUUID(),
    roomName,
    type: "batch_snapshot_created",
    timestamp: Date.now(),
    payload: {
      snapshotId: snapshot.id,
      participantCount: snapshot.participantCount,
      tasteReadyCount: snapshot.tasteReadyCount,
      reason,
    },
  });

  return snapshot;
}

export async function getRoomBatchHistory(roomName: string, limit = 20): Promise<RoomBatchSnapshot[]> {
  await ensureLoaded();
  return (roomHistory.get(roomName) ?? []).slice(0, Math.max(1, limit));
}

export async function resumeRoomFromBatchSnapshot(
  roomName: string,
  snapshotId?: string,
): Promise<{ room: RoomStateSnapshot; snapshot: RoomBatchSnapshot | null }> {
  await ensureLoaded();
  const room = ensureRoom(roomName);
  const snapshots = roomHistory.get(roomName) ?? [];
  const snapshot = snapshotId
    ? snapshots.find((item) => item.id === snapshotId) ?? null
    : (snapshots[0] ?? null);

  if (snapshot) {
    room.lastCompatibility = snapshot.compatibility;
    room.lastMutualRecommendations = snapshot.mutualRecommendations;
    room.liveStreamStartedAt = Date.now();
    room.liveStreamEndedAt = undefined;
    room.updatedAt = Date.now();
    await persistRooms();
    await appendEvent({
      id: crypto.randomUUID(),
      roomName,
      type: "room_resumed",
      timestamp: Date.now(),
      payload: {
        snapshotId: snapshot.id,
      },
    });
  }

  return { room, snapshot };
}
