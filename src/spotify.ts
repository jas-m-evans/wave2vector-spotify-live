import crypto from "node:crypto";
import { z } from "zod";
import { NowPlayingResponse, SpotifyProfile, SpotifyTokens, TrackFeatureVector } from "./types.js";

const tokenSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
});

const audioFeaturesSchema = z.object({
  id: z.string(),
  danceability: z.number(),
  energy: z.number(),
  key: z.number(),
  loudness: z.number(),
  mode: z.number(),
  speechiness: z.number(),
  acousticness: z.number(),
  instrumentalness: z.number(),
  liveness: z.number(),
  valence: z.number(),
  tempo: z.number(),
  duration_ms: z.number(),
  time_signature: z.number(),
});

type TrackPayload = {
  id: string;
  name: string;
  artists: Array<{ name: string }>;
  album?: { images?: Array<{ url: string }> };
  preview_url?: string | null;
  duration_ms?: number;
};

const scopes = [
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-top-read",
].join(" ");

const accountsBase = "https://accounts.spotify.com";
const apiBase = "https://api.spotify.com/v1";

function envOrThrow(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} is required in environment.`);
  }
  return value;
}

function authHeader(): string {
  const clientId = envOrThrow("SPOTIFY_CLIENT_ID");
  const secret = envOrThrow("SPOTIFY_CLIENT_SECRET");
  return `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;
}

export function createStateToken(): string {
  return crypto.randomBytes(18).toString("hex");
}

export function createSessionId(): string {
  return crypto.randomUUID();
}

export function spotifyLoginUrl(state: string): string {
  const redirectUri = envOrThrow("SPOTIFY_REDIRECT_URI");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: envOrThrow("SPOTIFY_CLIENT_ID"),
    scope: scopes,
    redirect_uri: redirectUri,
    state,
    show_dialog: "false",
  });
  return `${accountsBase}/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken(code: string): Promise<SpotifyTokens> {
  const redirectUri = envOrThrow("SPOTIFY_REDIRECT_URI");
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch(`${accountsBase}/api/token`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}).`);
  }

  const payload = tokenSchema.parse(await response.json());
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? "",
    expiresAt: Date.now() + payload.expires_in * 1000,
  };
}

export async function refreshToken(tokens: SpotifyTokens): Promise<SpotifyTokens> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
  });

  const response = await fetch(`${accountsBase}/api/token`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status}).`);
  }

  const payload = tokenSchema.parse(await response.json());
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + payload.expires_in * 1000,
  };
}

export async function spotifyGet(path: string, accessToken: string): Promise<Response> {
  return fetch(`${apiBase}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export function toFeatureVector(features: z.infer<typeof audioFeaturesSchema>): number[] {
  return [
    features.danceability,
    features.energy,
    features.key / 11,
    (features.loudness + 60) / 60,
    features.mode,
    features.speechiness,
    features.acousticness,
    features.instrumentalness,
    features.liveness,
    features.valence,
    features.tempo / 250,
    features.time_signature / 7,
    features.duration_ms / 600000,
  ];
}

export async function fetchNowPlaying(accessToken: string): Promise<NowPlayingResponse> {
  const nowRes = await spotifyGet("/me/player/currently-playing", accessToken);
  if (nowRes.status === 204) {
    return { isPlaying: false };
  }
  if (!nowRes.ok) {
    throw new Error(`Now playing request failed (${nowRes.status}).`);
  }

  const payload = (await nowRes.json()) as {
    is_playing: boolean;
    progress_ms?: number;
    item?: TrackPayload;
  };

  const item = payload.item;
  if (!item?.id) {
    return { isPlaying: false };
  }

  return {
    isPlaying: payload.is_playing,
    trackId: item.id,
    name: item.name,
    artist: item.artists.map((a) => a.name).join(", "),
    artworkUrl: item.album?.images?.[0]?.url,
    progressMs: payload.progress_ms,
    durationMs: item.duration_ms,
    previewUrl: item.preview_url ?? undefined,
  };
}

export async function fetchTopTrackIds(accessToken: string, limit = 30): Promise<string[]> {
  const response = await spotifyGet(`/me/top/tracks?time_range=medium_term&limit=${limit}`, accessToken);
  if (!response.ok) {
    throw new Error(`Top tracks request failed (${response.status}).`);
  }
  const payload = (await response.json()) as { items?: Array<{ id?: string }> };
  return (payload.items ?? [])
    .map((item) => item.id)
    .filter((id): id is string => Boolean(id));
}

export async function fetchSpotifyProfile(accessToken: string): Promise<SpotifyProfile> {
  const res = await spotifyGet("/me", accessToken);
  if (!res.ok) {
    throw new Error(`Spotify profile fetch failed (${res.status}).`);
  }
  const data = (await res.json()) as {
    id: string;
    display_name?: string;
    images?: Array<{ url: string }>;
  };
  return {
    id: data.id,
    displayName: data.display_name ?? data.id,
    imageUrl: data.images?.[0]?.url,
  };
}

export async function fetchTrackVector(trackId: string, accessToken: string): Promise<TrackFeatureVector> {
  const [trackRes, featuresRes] = await Promise.all([
    spotifyGet(`/tracks/${trackId}`, accessToken),
    spotifyGet(`/audio-features/${trackId}`, accessToken),
  ]);

  if (!trackRes.ok || !featuresRes.ok) {
    throw new Error(`Track vector fetch failed (${trackRes.status}/${featuresRes.status}).`);
  }

  const track = (await trackRes.json()) as TrackPayload;
  const features = audioFeaturesSchema.parse(await featuresRes.json());

  return {
    trackId: track.id,
    name: track.name,
    artist: track.artists.map((a) => a.name).join(", "),
    artworkUrl: track.album?.images?.[0]?.url,
    previewUrl: track.preview_url ?? undefined,
    vector: toFeatureVector(features),
    source: "spotify",
  };
}
