export type SpotifyTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export type SessionRecord = {
  id: string;
  tokens: SpotifyTokens;
};

export type TrackFeatureVector = {
  trackId: string;
  name: string;
  artist: string;
  artworkUrl?: string;
  previewUrl?: string;
  vector: number[];
  source: "spotify" | "cached";
};

export type Recommendation = TrackFeatureVector & {
  similarity: number;
  distance: number;
};

export type NowPlayingResponse = {
  isPlaying: boolean;
  trackId?: string;
  name?: string;
  artist?: string;
  artworkUrl?: string;
  progressMs?: number;
  durationMs?: number;
  previewUrl?: string;
};
