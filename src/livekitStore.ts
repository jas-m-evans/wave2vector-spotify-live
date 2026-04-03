import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CompatibilitySummary,
  MutualRecommendation,
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
let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) {
    return;
  }
  try {
    const raw = await fs.readFile(roomStatePath, "utf8");
    const parsed = JSON.parse(raw) as { rooms?: RoomStateSnapshot[] };
    for (const room of parsed.rooms ?? []) {
      rooms.set(room.roomName, room);
    }
  } catch {
    // no-op
  }
  loaded = true;
}

async function persistRooms(): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    roomStatePath,
    JSON.stringify({ updatedAt: new Date().toISOString(), rooms: [...rooms.values()] }, null, 2),
    "utf8",
  );
}

async function appendEvent(event: RoomEvent): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  let events: RoomEvent[] = [];
  try {
    const raw = await fs.readFile(roomEventsPath, "utf8");
    const parsed = JSON.parse(raw) as { events?: RoomEvent[] };
    events = parsed.events ?? [];
  } catch {
    events = [];
  }
  events.push(event);
  await fs.writeFile(roomEventsPath, JSON.stringify({ events }, null, 2), "utf8");
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
