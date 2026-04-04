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
  popularity?: number;
  explicit?: boolean;
  artists: Array<{ id?: string; name: string }>;
  album?: { images?: Array<{ url: string }>; release_date?: string };
  preview_url?: string | null;
  duration_ms?: number;
};

export type SpotifyTopArtist = {
  id: string;
  name: string;
  popularity: number;
  genres: string[];
};

const scopes = [
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-read-recently-played",
  "user-library-read",
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
  let lastError: Response | Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${apiBase}${path}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (response.status === 429) {
        lastError = response;
        if (attempt < 2) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < 2) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
    }
  }

  if (lastError instanceof Response) {
    return lastError;
  }
  throw lastError ?? new Error("Unknown error in spotifyGet");
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

export async function fetchTopTrackIds(
  accessToken: string,
  limit = 30,
  timeRange: "short_term" | "medium_term" | "long_term" = "medium_term",
): Promise<string[]> {
  const response = await spotifyGet(`/me/top/tracks?time_range=${timeRange}&limit=${limit}`, accessToken);
  if (!response.ok) {
    throw new Error(`Top tracks request failed (${response.status}).`);
  }
  const payload = (await response.json()) as { items?: Array<{ id?: string }> };
  return (payload.items ?? [])
    .map((item) => item.id)
    .filter((id): id is string => Boolean(id));
}

export async function fetchTopArtists(
  accessToken: string,
  limit = 20,
  timeRange: "short_term" | "medium_term" | "long_term" = "medium_term",
): Promise<SpotifyTopArtist[]> {
  const capped = Math.max(1, Math.min(50, limit));
  const response = await spotifyGet(`/me/top/artists?time_range=${timeRange}&limit=${capped}`, accessToken);
  if (!response.ok) {
    throw new Error(`Top artists request failed (${response.status}).`);
  }

  const payload = (await response.json()) as {
    items?: Array<{ id?: string; name?: string; popularity?: number; genres?: string[] }>;
  };

  return (payload.items ?? [])
    .filter((item): item is { id: string; name: string; popularity?: number; genres?: string[] } => Boolean(item.id && item.name))
    .map((item) => ({
      id: item.id,
      name: item.name,
      popularity: Math.max(0, Math.min(100, item.popularity ?? 50)),
      genres: (item.genres ?? []).slice(0, 6),
    }));
}

export async function fetchSavedTrackIds(accessToken: string, limit = 50): Promise<string[]> {
  const capped = Math.max(1, Math.min(50, limit));
  const response = await spotifyGet(`/me/tracks?limit=${capped}`, accessToken);
  if (!response.ok) {
    throw new Error(`Saved tracks request failed (${response.status}).`);
  }

  const payload = (await response.json()) as {
    items?: Array<{ track?: { id?: string } }>;
  };

  return (payload.items ?? [])
    .map((item) => item.track?.id)
    .filter((id): id is string => Boolean(id));
}

export async function fetchRecentlyPlayedTrackIds(accessToken: string, limit = 50): Promise<string[]> {
  const capped = Math.max(1, Math.min(50, limit));
  const response = await spotifyGet(`/me/player/recently-played?limit=${capped}`, accessToken);
  if (!response.ok) {
    throw new Error(`Recently played request failed (${response.status}).`);
  }

  const payload = (await response.json()) as {
    items?: Array<{ track?: { id?: string } }>;
  };

  return (payload.items ?? [])
    .map((item) => item.track?.id)
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

export async function fetchTrackVector(
  trackId: string,
  accessToken: string,
  options?: { metadataOnly?: boolean },
): Promise<TrackFeatureVector> {
  const trackRes = await spotifyGet(`/tracks/${trackId}`, accessToken);
  
  // If track fetch fails, create minimal fallback from just the track ID
  if (!trackRes.ok) {
    const seed = trackId
      .split("")
      .reduce((sum, ch, idx) => (sum + ch.charCodeAt(0) * (idx + 7)) % 10007, 0);
    const seedA = ((seed % 997) + 1) / 998;
    const seedB = (((seed * 7) % 991) + 1) / 992;
    const seedC = (((seed * 17) % 983) + 1) / 984;

    const minimalVector = [
      0.5 + seedA * 0.3,
      0.4 + seedB * 0.3,
      seedA,
      0.5 + seedB * 0.3,
      seedC > 0.5 ? 0.2 : 0.8,
      seedC,
      0.5 - seedA * 0.3,
      0.5 - seedB * 0.3,
      seedC,
      0.5 + (seedA - seedB) * 0.3,
      Math.max(0.05, Math.min(0.98, seedB * 0.9)),
      3 / 7 + (seedA - 0.5) * 0.08,
      0.5 + (seedC - 0.5) * 0.3,
    ];

    return {
      trackId,
      name: `Track ${trackId.slice(0, 8)}`,
      artist: "Unknown",
      vector: minimalVector,
      source: "metadata-fallback",
    };
  }

  const track = (await trackRes.json()) as TrackPayload;
  if (options?.metadataOnly) {
    const popularity = Math.max(0, Math.min(100, track.popularity ?? 50)) / 100;
    const durationNorm = Math.max(0, Math.min(1, (track.duration_ms ?? 210000) / 600000));
    const explicit = track.explicit ? 1 : 0;
    const year = Number((track.album?.release_date ?? "2000").slice(0, 4));
    const releaseRecency = Number.isFinite(year)
      ? Math.max(0, Math.min(1, (year - 1960) / (new Date().getFullYear() - 1960)))
      : 0.5;
    const seed = track.id
      .split("")
      .reduce((sum, ch, idx) => (sum + ch.charCodeAt(0) * (idx + 7)) % 10007, 0);
    const seedA = ((seed % 997) + 1) / 998;
    const seedB = (((seed * 7) % 991) + 1) / 992;
    const seedC = (((seed * 17) % 983) + 1) / 984;

    const metadataVector = [
      0.1 + popularity * 0.8,
      0.12 + popularity * 0.76,
      seedA,
      0.15 + (0.6 * popularity + 0.25 * seedB),
      explicit ? 0.18 : 0.86,
      explicit ? 0.62 + seedC * 0.22 : 0.14 + seedB * 0.22,
      Math.max(0.05, 1 - popularity * 0.72),
      Math.max(0.02, (1 - popularity) * 0.8 + seedA * 0.15),
      0.12 + seedC * 0.78,
      0.18 + releaseRecency * 0.72,
      Math.max(0.05, Math.min(0.98, durationNorm * 0.65 + seedB * 0.25)),
      3 / 7 + (seedA - 0.5) * 0.08,
      Math.max(0.05, Math.min(0.98, durationNorm)),
    ];

    return {
      trackId: track.id,
      name: track.name,
      artist: track.artists.map((a) => a.name).join(", "),
      artworkUrl: track.album?.images?.[0]?.url,
      previewUrl: track.preview_url ?? undefined,
      vector: metadataVector,
      source: "metadata-fallback",
    };
  }

  const featuresRes = await spotifyGet(`/audio-features/${trackId}`, accessToken);

  if (featuresRes.ok) {
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

  // Fallback for restricted apps where /audio-features is blocked.
  const popularity = Math.max(0, Math.min(100, track.popularity ?? 50)) / 100;
  const durationNorm = Math.max(0, Math.min(1, (track.duration_ms ?? 210000) / 600000));
  const explicit = track.explicit ? 1 : 0;
  const year = Number((track.album?.release_date ?? "2000").slice(0, 4));
  const releaseRecency = Number.isFinite(year)
    ? Math.max(0, Math.min(1, (year - 1960) / (new Date().getFullYear() - 1960)))
    : 0.5;

  const seed = track.id
    .split("")
    .reduce((sum, ch, idx) => (sum + ch.charCodeAt(0) * (idx + 7)) % 10007, 0);
  const seedA = ((seed % 997) + 1) / 998;
  const seedB = (((seed * 7) % 991) + 1) / 992;
  const seedC = (((seed * 17) % 983) + 1) / 984;

  let artistPopularityNorm = popularity;
  try {
    const leadArtistId = track.artists?.[0]?.id;
    if (leadArtistId) {
      const artistRes = await spotifyGet(`/artists/${leadArtistId}`, accessToken);
      if (artistRes.ok) {
        const artistPayload = (await artistRes.json()) as { popularity?: number; genres?: string[] };
        artistPopularityNorm = Math.max(0, Math.min(100, artistPayload.popularity ?? track.popularity ?? 50)) / 100;
      }
    }
  } catch {
    // Keep metadata fallback resilient when artist metadata calls fail.
  }

  const metadataVector = [
    0.1 + popularity * 0.8,
    0.08 + artistPopularityNorm * 0.84,
    seedA,
    0.15 + (0.6 * popularity + 0.25 * seedB),
    explicit ? 0.18 : 0.86,
    explicit ? 0.62 + seedC * 0.22 : 0.14 + seedB * 0.22,
    Math.max(0.05, 1 - popularity * 0.72),
    Math.max(0.02, (1 - artistPopularityNorm) * 0.8 + seedA * 0.15),
    0.12 + seedC * 0.78,
    0.18 + releaseRecency * 0.72,
    Math.max(0.05, Math.min(0.98, durationNorm * 0.65 + seedB * 0.25)),
    3 / 7 + (seedA - 0.5) * 0.08,
    Math.max(0.05, Math.min(0.98, durationNorm)),
  ];

  return {
    trackId: track.id,
    name: track.name,
    artist: track.artists.map((a) => a.name).join(", "),
    artworkUrl: track.album?.images?.[0]?.url,
    previewUrl: track.preview_url ?? undefined,
    vector: metadataVector,
    source: "metadata-fallback",
  };
}
