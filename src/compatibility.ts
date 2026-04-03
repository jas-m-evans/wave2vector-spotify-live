import { CompatibilitySummary, SharedNowPlaying, SharedTasteProfile } from "./types.js";

const featureNames = [
  "danceability",
  "energy",
  "key",
  "loudness",
  "mode",
  "speechiness",
  "acousticness",
  "instrumentalness",
  "liveness",
  "valence",
  "tempo",
  "time_signature",
  "duration",
];

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function toScore(similarity: number): number {
  const normalized = Math.max(0, Math.min(1, (similarity + 1) / 2));
  return Math.round(normalized * 100);
}

function describeScore(score: number): string {
  if (score >= 86) return "surprisingly aligned";
  if (score >= 72) return "same universe, different moons";
  if (score >= 58) return "opposites with crossover potential";
  if (score >= 45) return "adjacent lanes with occasional overlap";
  return "different planets, still remixable";
}

function featureDiffs(a: number[], b: number[]): Array<{ name: string; diff: number }> {
  return a.map((value, idx) => ({
    name: featureNames[idx] ?? `feature_${idx + 1}`,
    diff: Math.abs(value - b[idx]),
  }));
}

function summarizeTrackComparison(nowA?: SharedNowPlaying, nowB?: SharedNowPlaying): string | undefined {
  const vecA = nowA?.nowPlaying?.vector;
  const vecB = nowB?.nowPlaying?.vector;
  const titleA = nowA?.nowPlaying?.name;
  const titleB = nowB?.nowPlaying?.name;

  if (!vecA || !vecB || !titleA || !titleB || vecA.length !== vecB.length) {
    return undefined;
  }

  const similarity = toScore(cosineSimilarity(vecA, vecB));
  if (similarity >= 75) {
    return `Current tracks are close (${similarity}/100): ${titleA} and ${titleB} sit in a similar mood lane.`;
  }
  if (similarity >= 50) {
    return `Current tracks are moderately close (${similarity}/100): ${titleA} and ${titleB} share some vibe overlap.`;
  }
  return `Current tracks are far apart (${similarity}/100): ${titleA} and ${titleB} pull in different directions.`;
}

export function computeCompatibility(params: {
  roomName: string;
  participantA: SharedTasteProfile;
  participantB: SharedTasteProfile;
  nowPlayingA?: SharedNowPlaying;
  nowPlayingB?: SharedNowPlaying;
}): CompatibilitySummary {
  const similarity = cosineSimilarity(params.participantA.tasteVector, params.participantB.tasteVector);
  const overallScore = toScore(similarity);
  const diffs = featureDiffs(params.participantA.tasteVector, params.participantB.tasteVector)
    .sort((a, b) => a.diff - b.diff);

  const strongestSharedTraits = diffs.slice(0, 3).map((item) => item.name);
  const biggestDifferences = [...diffs].reverse().slice(0, 3).map((item) => item.name);

  const explanation =
    `You both overlap around ${strongestSharedTraits.join(", ")}, but diverge most on ${biggestDifferences.join(", ")}. ` +
    "Good match for discovery where shared rhythm and mood can bridge your biggest differences.";

  return {
    roomName: params.roomName,
    computedAt: Date.now(),
    score: {
      participantA: params.participantA.participantName,
      participantB: params.participantB.participantName,
      cosineSimilarity: Number(similarity.toFixed(4)),
      overallScore,
    },
    similarityLabel: describeScore(overallScore),
    strongestSharedTraits,
    biggestDifferences,
    currentTrackComparison: summarizeTrackComparison(params.nowPlayingA, params.nowPlayingB),
    explanation,
  };
}
