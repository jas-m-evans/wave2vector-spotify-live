import { SessionRecord, SpotifyProfile } from "./types.js";

type FeatureId =
  | "danceability"
  | "energy"
  | "speechiness"
  | "acousticness"
  | "instrumentalness"
  | "liveness"
  | "valence"
  | "tempo"
  | "loudness"
  | "mode"
  | "key";

type FeatureSummary = {
  id: FeatureId;
  label: string;
  numericValue: number;
  displayValue: number | string;
  percentile: number | null;
  plainMeaning: string;
  highDescriptor: string;
  lowDescriptor: string;
  comparisonWord: string;
};

export type TasteStory = {
  user_display_name: string;
  analysis_date: string;
  opening_narrative: string;
  micro_archetype: string;
  big_three_features: Array<{
    feature: string;
    user_value: number | string;
    percentile: number;
    plain_english: string;
    comparative_insight: string;
    artist_connection: string;
    personality_reveal: string;
  }>;
  audio_profile_grid: Record<string, { value: number | string; percentile: number | null; insight: string }>;
  artist_feature_bridge: string;
  musical_dna: string;
  comparison_stats: string[];
  vibe_tags: string[];
  friction_points: string[];
  confidence_score: number;
  data_completeness: {
    has_artists: boolean;
    has_genres: boolean;
    has_audio_features: boolean;
    sample_size_tracks: number;
  };
};

const NOTE_LABELS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function clampPercentile(value: number): number {
  return Math.max(1, Math.min(99, Math.round(value)));
}

function listify(values: string[], fallback: string): string {
  const clean = values.map((value) => value.trim()).filter(Boolean).slice(0, 3);
  if (!clean.length) {
    return fallback;
  }
  if (clean.length === 1) {
    return clean[0];
  }
  if (clean.length === 2) {
    return `${clean[0]} and ${clean[1]}`;
  }
  return `${clean[0]}, ${clean[1]}, and ${clean[2]}`;
}

function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function describePercentile(percentile: number, comparisonWord: string): string {
  if (percentile >= 50) {
    return `You're higher in ${comparisonWord} than ${percentile}% of listeners.`;
  }
  return `You're lower in ${comparisonWord} than ${100 - percentile}% of listeners.`;
}

function modeFeature(avg: number): FeatureSummary {
  const shareMajor = clamp01(avg);
  const percentile = clampPercentile(shareMajor * 100);
  return {
    id: "mode",
    label: "Mode",
    numericValue: shareMajor,
    displayValue: shareMajor >= 0.5 ? `Major (${Math.round(shareMajor * 100)}% major)` : `Minor (${Math.round((1 - shareMajor) * 100)}% minor)`,
    percentile,
    plainMeaning:
      shareMajor >= 0.5
        ? "Most of your songs lean bright and resolved instead of moody or shadowy."
        : "A lot of your songs lean moody and introspective instead of bright and breezy.",
    highDescriptor: "bright major-key songs",
    lowDescriptor: "minor-key moodiness",
    comparisonWord: "major-key brightness",
  };
}

function keyFeature(avg: number): FeatureSummary {
  const normalized = clamp01(avg);
  const key = Math.max(0, Math.min(11, Math.round(normalized * 11)));
  return {
    id: "key",
    label: "Key",
    numericValue: key,
    displayValue: NOTE_LABELS[key] ?? "C",
    percentile: null,
    plainMeaning: `Your average key lands around ${NOTE_LABELS[key] ?? "C"}, which mostly matters as a subtle color rather than a mood verdict.`,
    highDescriptor: "brighter tonal centers",
    lowDescriptor: "darker tonal centers",
    comparisonWord: "key center",
  };
}

function scalarFeature(
  id: Exclude<FeatureId, "mode" | "key">,
  avg: number,
): FeatureSummary {
  const normalized = clamp01(avg);
  const percentile = clampPercentile(normalized * 100);

  switch (id) {
    case "danceability":
      return {
        id,
        label: "Danceability",
        numericValue: normalized,
        displayValue: Number(normalized.toFixed(2)),
        percentile,
        plainMeaning:
          normalized >= 0.5
            ? "Your picks usually have a steady pulse and a body-moving feel."
            : "You care more about feel and texture than a clean dance-floor groove.",
        highDescriptor: "rhythms that move",
        lowDescriptor: "songs that sit and unfold",
        comparisonWord: "danceable momentum",
      };
    case "energy":
      return {
        id,
        label: "Energy",
        numericValue: normalized,
        displayValue: Number(normalized.toFixed(2)),
        percentile,
        plainMeaning:
          normalized >= 0.5
            ? "Your music hits with motion and urgency instead of drifting into the background."
            : "You lean calmer and more spacious than the average listener.",
        highDescriptor: "kinetic intensity",
        lowDescriptor: "calm restraint",
        comparisonWord: "musical intensity",
      };
    case "speechiness":
      return {
        id,
        label: "Speechiness",
        numericValue: normalized,
        displayValue: Number(normalized.toFixed(2)),
        percentile,
        plainMeaning:
          normalized >= 0.5
            ? "Words and vocal rhythm are a big part of what grabs you."
            : "You mostly want melody over spoken-word texture.",
        highDescriptor: "lyric-forward delivery",
        lowDescriptor: "melody-first songs",
        comparisonWord: "spoken-word presence",
      };
    case "acousticness":
      return {
        id,
        label: "Acousticness",
        numericValue: normalized,
        displayValue: Number(normalized.toFixed(2)),
        percentile,
        plainMeaning:
          normalized >= 0.5
            ? "You lean toward organic instruments and a more unplugged feel."
            : "You prefer polished production over campfire rawness.",
        highDescriptor: "organic textures",
        lowDescriptor: "produced sheen",
        comparisonWord: "acoustic texture",
      };
    case "instrumentalness":
      return {
        id,
        label: "Instrumentalness",
        numericValue: normalized,
        displayValue: Number(normalized.toFixed(2)),
        percentile,
        plainMeaning:
          normalized >= 0.5
            ? "You have real patience for songs that let the instruments do the talking."
            : "You mostly want a voice or lyrical hook in the center.",
        highDescriptor: "instrument-led tracks",
        lowDescriptor: "vocal-forward songs",
        comparisonWord: "instrumental focus",
      };
    case "liveness":
      return {
        id,
        label: "Liveness",
        numericValue: normalized,
        displayValue: Number(normalized.toFixed(2)),
        percentile,
        plainMeaning:
          normalized >= 0.5
            ? "You like music that feels like a room full of people was there when it happened."
            : "You mostly favor studio-clean recordings over live takes.",
        highDescriptor: "live-room energy",
        lowDescriptor: "studio precision",
        comparisonWord: "live-recorded feel",
      };
    case "valence":
      return {
        id,
        label: "Valence",
        numericValue: normalized,
        displayValue: Number(normalized.toFixed(2)),
        percentile,
        plainMeaning:
          normalized >= 0.5
            ? "Your songs usually lean bright, hopeful, or emotionally lifted."
            : "You make more room for tension, melancholy, and introspection.",
        highDescriptor: "uplifting color",
        lowDescriptor: "darker emotion",
        comparisonWord: "musical positivity",
      };
    case "tempo":
      return {
        id,
        label: "Tempo",
        numericValue: normalized,
        displayValue: Math.round(normalized * 250),
        percentile,
        plainMeaning:
          normalized >= 0.5
            ? "Your music keeps moving with a brisk heartbeat."
            : "You are comfortable with songs that breathe instead of sprint.",
        highDescriptor: "forward momentum",
        lowDescriptor: "unhurried pacing",
        comparisonWord: "musical speed",
      };
    case "loudness":
      return {
        id,
        label: "Loudness",
        numericValue: normalized,
        displayValue: Number((normalized * 60 - 60).toFixed(1)),
        percentile,
        plainMeaning:
          normalized >= 0.5
            ? "Your taste tilts toward punchy, present mixes that feel immediate."
            : "You are fine with quieter, more breathable production.",
        highDescriptor: "punchy production",
        lowDescriptor: "breathable dynamics",
        comparisonWord: "mastering intensity",
      };
  }
}

function buildFeatureSummaries(vector: number[]): FeatureSummary[] {
  return [
    scalarFeature("danceability", vector[0] ?? 0),
    scalarFeature("energy", vector[1] ?? 0),
    keyFeature(vector[2] ?? 0),
    scalarFeature("loudness", vector[3] ?? 0),
    modeFeature(vector[4] ?? 0),
    scalarFeature("speechiness", vector[5] ?? 0),
    scalarFeature("acousticness", vector[6] ?? 0),
    scalarFeature("instrumentalness", vector[7] ?? 0),
    scalarFeature("liveness", vector[8] ?? 0),
    scalarFeature("valence", vector[9] ?? 0),
    scalarFeature("tempo", vector[10] ?? 0),
  ];
}

function distinctiveness(feature: FeatureSummary): number {
  if (feature.percentile === null) {
    return 0;
  }
  return Math.abs(feature.percentile - 50);
}

function pickMicroArchetype(features: FeatureSummary[]): string {
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const acousticness = byId.get("acousticness")?.percentile ?? 50;
  const valence = byId.get("valence")?.percentile ?? 50;
  const energy = byId.get("energy")?.percentile ?? 50;
  const tempo = byId.get("tempo")?.percentile ?? 50;
  const loudness = byId.get("loudness")?.percentile ?? 50;

  if (valence >= 65 && acousticness >= 60) return "mood architect";
  if (energy >= 65 && tempo >= 65) return "kinetic seeker";
  if (valence <= 35 && acousticness >= 60) return "introspective wanderer";
  if (acousticness <= 35 && loudness >= 65) return "production maximalist";
  if (Math.abs(tempo - 50) >= 20 && Math.abs(energy - 50) >= 15) return "temporal chameleon";
  return "genre alchemist";
}

function featureBridgeSentence(feature: FeatureSummary, topArtists: string[], topGenres: string[]): string {
  const artistText = listify(topArtists, "your favorite artists");
  const genreText = listify(topGenres, "your usual lanes");
  if ((feature.percentile ?? 50) >= 50) {
    return `${artistText} all make sense here: they reinforce your pull toward ${feature.highDescriptor}, and ${genreText} keep that preference consistent.`;
  }
  return `${artistText} still fit because they avoid excess ${feature.highDescriptor}; even across ${genreText}, you keep steering toward ${feature.lowDescriptor}.`;
}

function personalityReveal(feature: FeatureSummary): string {
  switch (feature.id) {
    case "energy":
      return feature.numericValue >= 0.5
        ? "You want music that changes the temperature of the room."
        : "You use music to create space, not noise.";
    case "valence":
      return feature.numericValue >= 0.5
        ? "You use music as fuel more than emotional excavation."
        : "You value emotional honesty over easy uplift.";
    case "danceability":
      return feature.numericValue >= 0.5
        ? "You respond fast to rhythm and momentum."
        : "You care more about mood than movement.";
    case "acousticness":
      return feature.numericValue >= 0.5
        ? "You trust texture and human touch."
        : "You like intention, polish, and production choices you can feel.";
    case "speechiness":
      return feature.numericValue >= 0.5
        ? "You listen for delivery and phrasing as much as melody."
        : "You want a song to sing, not lecture.";
    case "instrumentalness":
      return feature.numericValue >= 0.5
        ? "You are happy to let atmosphere do the talking."
        : "You want a human voice to anchor the experience.";
    case "liveness":
      return feature.numericValue >= 0.5
        ? "You like the feeling of being in the room with the band."
        : "You favor control, detail, and studio precision.";
    case "tempo":
      return feature.numericValue >= 0.5
        ? "You like music that keeps you moving forward."
        : "You do not need every song to rush you somewhere.";
    case "loudness":
      return feature.numericValue >= 0.5
        ? "You like music that arrives with confidence."
        : "You make room for subtlety and dynamics.";
    case "mode":
      return feature.numericValue >= 0.5
        ? "You like tension that eventually resolves into light."
        : "You are comfortable sitting in unresolved emotion.";
    default:
      return "Your taste has a clear point of view instead of drifting wherever the algorithm goes.";
  }
}

function comparisonStat(feature: FeatureSummary): string {
  const percentile = feature.percentile ?? 50;
  if (percentile >= 50) {
    return `${feature.label}: Top ${100 - percentile}% — ${feature.highDescriptor} shows up more often for you than for most listeners.`;
  }
  return `${feature.label}: Bottom ${percentile}% — you avoid heavy ${feature.highDescriptor} more than most listeners do.`;
}

function supportingInsight(feature: FeatureSummary): string {
  if (feature.percentile === null) {
    return feature.plainMeaning;
  }
  if (feature.percentile >= 65) {
    return `${feature.plainMeaning} This is one of the louder parts of your taste.`;
  }
  if (feature.percentile <= 35) {
    return `${feature.plainMeaning} You clearly do not chase this trait for its own sake.`;
  }
  return `${feature.plainMeaning} You sit near the middle here, so you can flex either way.`;
}

function buildVibeTags(features: FeatureSummary[], topGenres: string[]): string[] {
  const tags = new Set<string>();
  for (const genre of topGenres.slice(0, 3)) {
    tags.add(`#${genre.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase()}`);
  }

  const addTag = (id: string) => tags.add(`#${id}`);
  const byId = new Map(features.map((feature) => [feature.id, feature]));

  if ((byId.get("energy")?.percentile ?? 50) >= 65) addTag("energetic");
  if ((byId.get("valence")?.percentile ?? 50) >= 65) addTag("uplifting");
  if ((byId.get("danceability")?.percentile ?? 50) >= 65) addTag("rhythmic");
  if ((byId.get("acousticness")?.percentile ?? 50) >= 65) addTag("organic");
  if ((byId.get("acousticness")?.percentile ?? 50) <= 35) addTag("production-conscious");
  if ((byId.get("tempo")?.percentile ?? 50) >= 65) addTag("driving");
  if ((byId.get("instrumentalness")?.percentile ?? 50) >= 65) addTag("atmospheric");
  if ((byId.get("mode")?.percentile ?? 50) >= 65) addTag("major-key");
  if ((byId.get("speechiness")?.percentile ?? 50) >= 55) addTag("lyric-forward");

  return [...tags].slice(0, 8);
}

function buildFrictionPoints(features: FeatureSummary[]): string[] {
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const friction: string[] = [];

  if ((byId.get("energy")?.percentile ?? 50) >= 70) {
    friction.push("Slow ambient drift may feel too passive for your taste.");
  }
  if ((byId.get("valence")?.percentile ?? 50) <= 35) {
    friction.push("Ultra-bright feel-good pop can sound too tidy if it has no emotional edge.");
  }
  if ((byId.get("acousticness")?.percentile ?? 50) <= 25) {
    friction.push("Very raw unplugged recordings may feel underpowered next to the polish you usually like.");
  }
  if ((byId.get("instrumentalness")?.percentile ?? 50) <= 25) {
    friction.push("Purely instrumental pieces may lose you if they never offer a vocal hook.");
  }

  return friction.slice(0, 2);
}

function buildMusicalDna(features: FeatureSummary[], topGenres: string[]): string {
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const descriptors: string[] = [];

  descriptors.push((byId.get("energy")?.percentile ?? 50) >= 60 ? "energetic" : "measured");
  descriptors.push((byId.get("valence")?.percentile ?? 50) >= 60 ? "bright" : "emotionally shaded");
  descriptors.push((byId.get("acousticness")?.percentile ?? 50) >= 50 ? "organic" : "produced");
  descriptors.push((byId.get("danceability")?.percentile ?? 50) >= 60 ? "rhythm-forward" : "mood-first");

  const genreText = topGenres.length ? `${listify(topGenres, "genre-fluid listening")}` : "genre-fluid listening";
  return `${titleCase(genreText)} with a ${descriptors.join(", ")} center. You like songs that feel deliberate and emotionally legible, not shapeless background noise.`;
}

export function buildTasteStory(session: Partial<SessionRecord> & { spotifyProfile?: SpotifyProfile | undefined | null }): TasteStory | null {
  const vector = session.tasteVector ?? [];
  if (!vector.length) {
    return null;
  }

  const features = buildFeatureSummaries(vector);
  const topArtists = session.artistInsights?.topArtists?.map((artist) => artist.name) ?? [];
  const topGenres = session.artistInsights?.topGenres?.map((genre) => genre.genre) ?? [];
  const displayName = session.spotifyProfile?.displayName?.trim() || "Listener";
  const analysisDate = new Date(session.tasteUpdatedAt ?? Date.now()).toISOString();
  const archetype = pickMicroArchetype(features);

  const rankedDistinctive = features
    .filter((feature) => feature.percentile !== null && feature.id !== "key")
    .sort((a, b) => distinctiveness(b) - distinctiveness(a));
  const bigThree = rankedDistinctive.slice(0, 3);
  const supporting = features
    .filter((feature) => !bigThree.some((picked) => picked.id === feature.id))
    .slice(0, 7);

  const leadFeatures = bigThree.slice(0, 2).map((feature) => feature.highDescriptor);
  const leadArtists = listify(topArtists.slice(0, 3), "your top artists");
  const leadGenres = listify(topGenres.slice(0, 3), "a few different styles");

  const openingNarrative = `${displayName}'s taste is shaped by ${listify(leadFeatures, "clear musical preferences")}. ${leadArtists} sit right in that lane, turning ${leadGenres} into something that feels coherent instead of random. You are not just browsing for background music; you are curating a point of view. That makes you a ${archetype}.`;

  const audioProfileGrid = Object.fromEntries(
    supporting.map((feature) => [
      feature.label,
      {
        value: feature.displayValue,
        percentile: feature.percentile,
        insight: supportingInsight(feature),
      },
    ]),
  );

  const artistFeatureBridge = topArtists.length
    ? `${listify(topArtists.slice(0, 3), "Your favorite artists")} all map back to the same core signals: ${listify(
        bigThree.map((feature) => feature.highDescriptor),
        "strong taste markers",
      )}. Even when the genre label changes, you keep choosing songs that preserve that emotional and production DNA.`
    : `Your profile still hangs together even without named artists because the same feature pattern keeps repeating: ${listify(
        bigThree.map((feature) => feature.highDescriptor),
        "strong taste markers",
      )}.`;

  const comparisonStats = bigThree.map(comparisonStat).slice(0, 3);
  const vibeTags = buildVibeTags(features, topGenres);
  const frictionPoints = buildFrictionPoints(features);

  const sampleSize = session.lastSyncStats?.sampled ?? 0;
  const hasArtists = topArtists.length > 0;
  const hasGenres = topGenres.length > 0;
  const cached = session.lastSyncStats?.cached ?? 0;
  const fallbackCount = session.lastSyncStats?.metadataFallbackCount ?? 0;
  const hasAudioFeatures = cached > 0 && fallbackCount < cached;
  const confidenceScore = Math.max(
    35,
    Math.min(
      98,
      40
        + (hasArtists ? 15 : 0)
        + (hasGenres ? 10 : 0)
        + (hasAudioFeatures ? 18 : 6)
        + Math.min(15, Math.round(sampleSize / 3)),
    ),
  );

  return {
    user_display_name: displayName,
    analysis_date: analysisDate,
    opening_narrative: openingNarrative,
    micro_archetype: archetype,
    big_three_features: bigThree.map((feature) => ({
      feature: feature.label,
      user_value: feature.displayValue,
      percentile: feature.percentile ?? 50,
      plain_english: `${feature.plainMeaning} ${feature.numericValue >= 0.5 ? "You naturally lean toward this sound." : "You tend to keep this in check."}`,
      comparative_insight: describePercentile(feature.percentile ?? 50, feature.comparisonWord),
      artist_connection: featureBridgeSentence(feature, topArtists.slice(0, 3), topGenres.slice(0, 3)),
      personality_reveal: personalityReveal(feature),
    })),
    audio_profile_grid: audioProfileGrid,
    artist_feature_bridge: artistFeatureBridge,
    musical_dna: buildMusicalDna(features, topGenres.slice(0, 3)),
    comparison_stats: comparisonStats,
    vibe_tags: vibeTags,
    friction_points: frictionPoints,
    confidence_score: confidenceScore,
    data_completeness: {
      has_artists: hasArtists,
      has_genres: hasGenres,
      has_audio_features: hasAudioFeatures,
      sample_size_tracks: sampleSize,
    },
  };
}

const HOROSCOPE_PREDICTIONS: Record<string, string[]> = {
  "kinetic seeker": [
    "A track with an unexpected tempo shift will stop you mid-sentence this week.",
    "You will hear something loud in an unlikely place and feel immediately at home.",
    "Your next obsession is probably already in your queue — you just haven't played it loud enough yet.",
  ],
  "mood architect": [
    "A breezy track will hit you harder than expected this week.",
    "You will find yourself curating a playlist for a specific 20-minute window of your day.",
    "The song you recommend to someone next will reveal more about you than about them.",
  ],
  "introspective wanderer": [
    "Something minor-key and unhurried will find you at exactly the right moment.",
    "You will replay a track three times before you understand why you needed it.",
    "Your taste is pulling toward something slower and more shadowed than usual — trust it.",
  ],
  "production maximalist": [
    "A heavily produced track will give you chills in a moment you weren't expecting.",
    "You will notice the mixing on something this week and feel personally vindicated.",
    "Your next favorite song will sound like someone built it from the ground up just for you.",
  ],
  "temporal chameleon": [
    "A song at an odd BPM will feel oddly correct this week.",
    "You will shuffle between two completely different moods and both will feel right.",
    "Something from a genre you don't usually claim will earn a permanent spot in your rotation.",
  ],
  "genre alchemist": [
    "The best song you hear this week will be impossible to explain to someone else.",
    "You will find a connection between two artists you never expected to link.",
    "Your taste refuses to be filed — and something new this week will prove it again.",
  ],
};

export type TasteHoroscope = {
  archetype: string;
  opening: string;
  artist_read: string;
  prediction: string;
  vibe_tags: string[];
};

export function buildTasteHoroscope(
  session: Partial<SessionRecord> & { spotifyProfile?: SpotifyProfile | undefined | null },
): TasteHoroscope | null {
  const vector = session.tasteVector ?? [];
  if (!vector.length) {
    return null;
  }

  const features = buildFeatureSummaries(vector);
  const topArtists = session.artistInsights?.topArtists?.map((artist) => artist.name) ?? [];
  const topGenres = session.artistInsights?.topGenres?.map((genre) => genre.genre) ?? [];
  const archetype = pickMicroArchetype(features);
  const displayName = session.spotifyProfile?.displayName?.trim() || "Listener";

  const rankedDistinctive = features
    .filter((feature) => feature.percentile !== null && feature.id !== "key")
    .sort((a, b) => distinctiveness(b) - distinctiveness(a));
  const topFeature = rankedDistinctive[0];
  const secondFeature = rankedDistinctive[1];

  const artistText = listify(topArtists.slice(0, 2), "your top artists");
  const genreText = listify(topGenres.slice(0, 2), "your usual territory");
  const topFeatureDesc = topFeature
    ? (topFeature.percentile ?? 50) >= 50
      ? topFeature.highDescriptor
      : topFeature.lowDescriptor
    : "a clear sonic identity";
  const secondFeatureDesc = secondFeature
    ? (secondFeature.percentile ?? 50) >= 50
      ? secondFeature.highDescriptor
      : secondFeature.lowDescriptor
    : null;

  const opening = secondFeatureDesc
    ? `${displayName}, the stars see ${topFeatureDesc} and ${secondFeatureDesc} running through everything you play. You are a ${archetype}, and this week that shapes everything.`
    : `${displayName}, the stars see ${topFeatureDesc} at the center of your musical universe. You are a ${archetype}, and this week that current is especially strong.`;

  const artistRead = topArtists.length
    ? `${artistText} hold the map to where you are right now — they have been pointing you toward ${genreText} for a reason, even if you haven't named it yet.`
    : `Your ${genreText} is not a genre, it is a mood. And this week, that mood is sharper than usual.`;

  const predictionsForArchetype = HOROSCOPE_PREDICTIONS[archetype] ?? HOROSCOPE_PREDICTIONS["genre alchemist"];
  const dayIndex = Math.floor(Date.now() / (1000 * 60 * 60 * 24)) % predictionsForArchetype.length;
  const prediction = predictionsForArchetype[dayIndex] ?? predictionsForArchetype[0] ?? "Something unexpected is on its way.";

  const vibeTags = buildVibeTags(features, topGenres);

  return {
    archetype,
    opening,
    artist_read: artistRead,
    prediction,
    vibe_tags: vibeTags,
  };
}
