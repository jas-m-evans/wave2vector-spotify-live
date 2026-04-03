import { AccessToken } from "livekit-server-sdk";
import { LiveKitTokenResponse } from "./types.js";

const defaultLiveKitUrl = "ws://127.0.0.1:7880";
const defaultLiveKitApiKey = "devkey";
const defaultLiveKitApiSecret = "secret";

function envOrDefault(key: string, fallback: string): string {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : fallback;
}

export function getLiveKitConfig(): { url: string; apiKey: string; apiSecret: string } {
  return {
    url: envOrDefault("LIVEKIT_URL", defaultLiveKitUrl),
    apiKey: envOrDefault("LIVEKIT_API_KEY", defaultLiveKitApiKey),
    apiSecret: envOrDefault("LIVEKIT_API_SECRET", defaultLiveKitApiSecret),
  };
}

function cleanRoomName(value: string): string {
  return value.trim().replace(/\s+/g, "-").slice(0, 120);
}

function cleanParticipantName(value: string): string {
  return value.trim().slice(0, 60);
}

export async function createLiveKitAccessToken(params: {
  roomName: string;
  participantName: string;
  sessionId: string;
}): Promise<LiveKitTokenResponse> {
  const roomName = cleanRoomName(params.roomName);
  const participantName = cleanParticipantName(params.participantName);

  if (!roomName) {
    throw new Error("roomName is required.");
  }
  if (!participantName) {
    throw new Error("participantName is required.");
  }

  const { url, apiKey, apiSecret } = getLiveKitConfig();
  const identity = `${participantName}-${params.sessionId.slice(0, 8)}`;

  const token = new AccessToken(apiKey, apiSecret, {
    identity,
    name: participantName,
    ttl: "2h",
  });

  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublishData: true,
    canSubscribe: true,
  });

  return {
    url,
    roomName,
    participantName,
    token: await token.toJwt(),
  };
}
