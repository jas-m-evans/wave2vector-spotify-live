export type SpotifyTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export type SessionRecord = {
  id: string;
  tokens: SpotifyTokens;
  streamModePreference?: "live" | "batch";
  tasteVector?: number[];
  tasteUpdatedAt?: number;
  bootstrapCompletedAt?: number;
  lastSyncStats?: {
    sampled: number;
    cached: number;
    metadataFallbackCount: number;
    vectorFailureCount: number;
    sourceCounts: Record<string, number>;
    fallbackUsed: boolean;
    updatedAt: number;
  };
  artistInsights?: {
    topGenres: Array<{ genre: string; weight: number }>;
    topArtists: Array<{ id: string; name: string; popularity: number; genres: string[] }>;
    updatedAt: number;
  };
};

export type LiveKitTokenResponse = {
  url: string;
  roomName: string;
  participantName: string;
  token: string;
};

export type TrackFeatureVector = {
  trackId: string;
  name: string;
  artist: string;
  artworkUrl?: string;
  previewUrl?: string;
  vector: number[];
  source: "spotify" | "cached" | "metadata-fallback";
};

export type Recommendation = TrackFeatureVector & {
  similarity: number;
  distance: number;
  tasteSimilarity?: number;
  blendedScore?: number;
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

export type SpotifyProfile = {
  id: string;
  displayName: string;
  imageUrl?: string;
};

export type SharedTasteProfile = {
  roomName: string;
  participantName: string;
  timestamp: number;
  tasteVector: number[];
  tasteUpdatedAt?: number;
  topSignals: string[];
  profileStats: {
    dims: number;
  };
};

export type SharedNowPlaying = {
  roomName: string;
  participantName: string;
  timestamp: number;
  nowPlaying: (NowPlayingResponse & {
    vector?: number[];
  }) | null;
};

export type CompatibilityScore = {
  participantA: string;
  participantB: string;
  cosineSimilarity: number;
  overallScore: number;
};

export type CompatibilitySummary = {
  roomName: string;
  computedAt: number;
  score: CompatibilityScore;
  similarityLabel: string;
  strongestSharedTraits: string[];
  biggestDifferences: string[];
  currentTrackComparison?: string;
  explanation: string;
};

export type MutualRecommendation = {
  trackId: string;
  name: string;
  artist: string;
  artworkUrl?: string;
  previewUrl?: string;
  scoreForA: number;
  scoreForB: number;
  jointScore: number;
  reasonTags: string[];
};

export type RoomParticipantSnapshot = {
  sessionId: string;
  participantName: string;
  lastSeenAt: number;
  connected: boolean;
  tasteProfile?: SharedTasteProfile;
  nowPlayingState?: SharedNowPlaying;
};

export type RoomStateSnapshot = {
  roomName: string;
  participants: RoomParticipantSnapshot[];
  updatedAt: number;
  published?: boolean;
  liveStreamStartedAt?: number;
  liveStreamEndedAt?: number;
  lastCompatibility?: CompatibilitySummary;
  lastMutualRecommendations?: MutualRecommendation[];
};

export type RoomBatchSnapshot = {
  id: string;
  roomName: string;
  createdAt: number;
  reason: "stream_end" | "manual";
  participantCount: number;
  tasteReadyCount: number;
  compatibility?: CompatibilitySummary;
  mutualRecommendations?: MutualRecommendation[];
};

export type RoomEventType =
  | "room_joined"
  | "room_left"
  | "stream_started"
  | "stream_ended"
  | "taste_profile_shared"
  | "now_playing_shared"
  | "compatibility_computed"
  | "mutual_recommendations_computed"
  | "batch_snapshot_created"
  | "room_resumed";

export type RoomEvent = {
  id: string;
  roomName: string;
  sessionId?: string;
  participantName?: string;
  type: RoomEventType;
  timestamp: number;
  payload?: Record<string, unknown>;
};
