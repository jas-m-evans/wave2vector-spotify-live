export type SpotifyTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export type TasteCapsule = {
  lockedAt: number;
  tasteVector: number[];
  topArtists: string[];
  archetype?: string;
};

export type SessionRecord = {
  id: string;
  tokens: SpotifyTokens;
  spotifyProfile?: SpotifyProfile;
  streamModePreference?: "live" | "batch";
  tasteVector?: number[];
  tasteUpdatedAt?: number;
  bootstrapCompletedAt?: number;
  tasteCapsule?: TasteCapsule;
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

export type AppAccountPublic = {
  id: string;
  email: string;
  username?: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
  hasCachedProfile: boolean;
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

export type OutlierTrackResult = {
  trackId: string;
  name: string;
  artist: string;
  artworkUrl?: string;
  distance: number;
  badge: string;
  tagline: string;
};

export type MatchCardData = {
  roomName: string;
  participantA: string;
  participantB: string;
  overallScore: number;
  similarityLabel: string;
  verdict: string;
  verdictEmoji: string;
  overlappingSignals: string[];
  shareText: string;
};

export type SurveyQuestion = {
  id: string;
  optionA: string;
  optionB: string;
  hint: string;
};

export type SurveyEstimate = {
  estimatedVector: number[];
  archetype: string;
  teaserText: string;
  confidence: number;
};

export type NicheScore = {
  nicheScore: number;
  distanceFromMainstream: number;
  percentileText: string;
  verdict: string;
};

export type MoodConfidenceTier = "low" | "medium" | "high";

export type MoodTraits = {
  intensity: number;
  warmth: number;
  texturalFocus: number;
  dynamism: number;
  introspection: number;
  verbalFocus: number;
};

export type MoodPhase = {
  label: "kinetic" | "reflective" | "grounded" | "luminous" | "volatile";
  score: number;
};

export type MoodDrift = {
  driftScore: number;
  changed: boolean;
  signals: string[];
};

export type MoodProfileSnapshot = {
  id: string;
  userId: string;
  computedAt: number;
  stableTraits: MoodTraits;
  currentPhase: MoodPhase;
  drift: MoodDrift;
  confidence: {
    tier: MoodConfidenceTier;
    score: number;
    rationale: string[];
  };
  explainSummary: string;
  baseVector: number[];
  identityTags: string[];
};

export type RoomThemeTokens = {
  palette: string[];
  lighting: "soft" | "balanced" | "dramatic";
  materials: string[];
  motifs: string[];
  anchorObjects: string[];
};

export type GeneratedAsset = {
  id: string;
  artifactId: string;
  variant: "primary" | "thumbnail";
  storageUrl: string;
  thumbUrl?: string;
  promptVersion: string;
  modelName: string;
  generationCost: number;
  createdAt: number;
};

export type RoomArtifact = {
  id: string;
  userId: string;
  snapshotId: string;
  seed: string;
  styleVersion: string;
  status: "queued" | "ready" | "failed";
  promptTemplate: string;
  themeTokens: RoomThemeTokens;
  narrativeTags: string[];
  evolutionLabel?: string;
  createdAt: number;
  primaryAssetId?: string;
};

export type BlendSessionStatus = "queued" | "processing" | "ready" | "failed";

export type BlendSession = {
  id: string;
  initiatorUserId: string;
  partnerUserId: string;
  status: BlendSessionStatus;
  createdAt: number;
  completedAt?: number;
  blendVector?: number[];
  artifactId?: string;
  explainability?: {
    fromA: string[];
    fromB: string[];
    bridge: string[];
  };
};

export type ShareLink = {
  id: string;
  ownerUserId: string;
  targetType: "user_room" | "blend_room";
  targetId: string;
  visibility: "public" | "unlisted";
  token: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
};
