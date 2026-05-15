import crypto from "node:crypto";
import { MoodProfileSnapshot, MoodTraits } from "./types.js";

const IDEAL_SAMPLE_COUNT = 36;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Number(clamp01(value).toFixed(4));
}

function avg(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, item) => sum + item, 0) / values.length;
}

function blend(a: number, b: number, wA: number, wB: number): number {
  const denom = wA + wB;
  if (!denom) return 0;
  return (a * wA + b * wB) / denom;
}

export function vectorToTraits(vector: number[]): MoodTraits {
  const energy = vector[1] ?? 0.5;
  const loudness = vector[3] ?? 0.5;
  const tempo = vector[10] ?? 0.5;
  const valence = vector[9] ?? 0.5;
  const acousticness = vector[6] ?? 0.5;
  const instrumentalness = vector[7] ?? 0.5;
  const liveness = vector[8] ?? 0.5;
  const speechiness = vector[5] ?? 0.5;
  const danceability = vector[0] ?? 0.5;

  const intensity = blend(avg([energy, loudness, tempo]), danceability, 0.8, 0.2);
  const warmth = avg([valence, acousticness]);
  const texturalFocus = avg([instrumentalness, liveness]);
  const dynamism = avg([danceability, tempo, energy]);
  const introspection = avg([1 - valence, acousticness, 1 - energy]);
  const verbalFocus = speechiness;

  return {
    intensity: round(intensity),
    warmth: round(warmth),
    texturalFocus: round(texturalFocus),
    dynamism: round(dynamism),
    introspection: round(introspection),
    verbalFocus: round(verbalFocus),
  };
}

function traitDistance(a: MoodTraits, b: MoodTraits): number {
  const keys: Array<keyof MoodTraits> = [
    "intensity",
    "warmth",
    "texturalFocus",
    "dynamism",
    "introspection",
    "verbalFocus",
  ];
  const deltas = keys.map((key) => Math.abs(a[key] - b[key]));
  return Number((avg(deltas) * 100).toFixed(2));
}

function signalDeltas(a: MoodTraits, b: MoodTraits): string[] {
  const pairs: Array<{ key: keyof MoodTraits; label: string }> = [
    { key: "intensity", label: "intensity" },
    { key: "warmth", label: "warmth" },
    { key: "texturalFocus", label: "texture focus" },
    { key: "dynamism", label: "dynamism" },
    { key: "introspection", label: "introspection" },
    { key: "verbalFocus", label: "verbal focus" },
  ];

  return pairs
    .map((pair) => ({
      label: pair.label,
      delta: b[pair.key] - a[pair.key],
    }))
    .filter((item) => Math.abs(item.delta) >= 0.05)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
    .slice(0, 3)
    .map((item) => `${item.delta > 0 ? "+" : ""}${Math.round(item.delta * 100)}% ${item.label}`);
}

function phaseFromTraits(traits: MoodTraits): { label: MoodProfileSnapshot["currentPhase"]["label"]; score: number } {
  const candidates = [
    { label: "kinetic" as const, score: avg([traits.intensity, traits.dynamism]) },
    { label: "reflective" as const, score: avg([traits.introspection, traits.texturalFocus]) },
    { label: "grounded" as const, score: avg([traits.warmth, 1 - traits.intensity]) },
    { label: "luminous" as const, score: avg([traits.warmth, 1 - traits.introspection]) },
    { label: "volatile" as const, score: avg([traits.intensity, traits.introspection]) },
  ];
  candidates.sort((a, b) => b.score - a.score);
  return { label: candidates[0]?.label ?? "grounded", score: Number((candidates[0]?.score ?? 0.5).toFixed(4)) };
}

function buildIdentityTags(stable: MoodTraits): string[] {
  const tags: string[] = [];
  if (stable.intensity >= 0.65) tags.push("kinetic");
  if (stable.warmth >= 0.6) tags.push("warm");
  if (stable.texturalFocus >= 0.55) tags.push("textured");
  if (stable.introspection >= 0.6) tags.push("reflective");
  if (stable.verbalFocus >= 0.55) tags.push("lyric-led");
  if (stable.dynamism >= 0.65) tags.push("momentum");
  if (!tags.length) tags.push("balanced");
  return tags.slice(0, 5);
}

function confidenceTier(score: number): MoodProfileSnapshot["confidence"]["tier"] {
  if (score >= 80) return "high";
  if (score >= 55) return "medium";
  return "low";
}

export function computeMoodSnapshot(params: {
  userId: string;
  longTermVector: number[];
  mediumTermVector?: number[];
  shortTermVector?: number[];
  sampledCount: number;
  /** Number of distinct signal sources contributing to this snapshot (expected 0-5). */
  sourceDiversity: number;
  metadataFallbackRatio: number;
  recencyCompleteness: number;
}): MoodProfileSnapshot {
  const medium = params.mediumTermVector?.length ? params.mediumTermVector : params.longTermVector;
  const short = params.shortTermVector?.length ? params.shortTermVector : medium;

  const longTraits = vectorToTraits(params.longTermVector);
  const mediumTraits = vectorToTraits(medium);
  const shortTraits = vectorToTraits(short);

  const stable: MoodTraits = {
    intensity: round(longTraits.intensity * 0.7 + mediumTraits.intensity * 0.2 + shortTraits.intensity * 0.1),
    warmth: round(longTraits.warmth * 0.7 + mediumTraits.warmth * 0.2 + shortTraits.warmth * 0.1),
    texturalFocus: round(longTraits.texturalFocus * 0.7 + mediumTraits.texturalFocus * 0.2 + shortTraits.texturalFocus * 0.1),
    dynamism: round(longTraits.dynamism * 0.7 + mediumTraits.dynamism * 0.2 + shortTraits.dynamism * 0.1),
    introspection: round(longTraits.introspection * 0.7 + mediumTraits.introspection * 0.2 + shortTraits.introspection * 0.1),
    verbalFocus: round(longTraits.verbalFocus * 0.7 + mediumTraits.verbalFocus * 0.2 + shortTraits.verbalFocus * 0.1),
  };

  const current: MoodTraits = {
    intensity: round(shortTraits.intensity * 0.6 + mediumTraits.intensity * 0.3 + longTraits.intensity * 0.1),
    warmth: round(shortTraits.warmth * 0.6 + mediumTraits.warmth * 0.3 + longTraits.warmth * 0.1),
    texturalFocus: round(shortTraits.texturalFocus * 0.6 + mediumTraits.texturalFocus * 0.3 + longTraits.texturalFocus * 0.1),
    dynamism: round(shortTraits.dynamism * 0.6 + mediumTraits.dynamism * 0.3 + longTraits.dynamism * 0.1),
    introspection: round(shortTraits.introspection * 0.6 + mediumTraits.introspection * 0.3 + longTraits.introspection * 0.1),
    verbalFocus: round(shortTraits.verbalFocus * 0.6 + mediumTraits.verbalFocus * 0.3 + longTraits.verbalFocus * 0.1),
  };

  const driftScore = traitDistance(stable, current);
  const signals = signalDeltas(stable, current);

  const sampleSignal = Math.min(1, params.sampledCount / IDEAL_SAMPLE_COUNT);
  const sourceSignal = clamp01(params.sourceDiversity / 5);
  const fallbackSignal = clamp01(1 - params.metadataFallbackRatio);
  const recencySignal = clamp01(params.recencyCompleteness);
  const confidenceScore = Math.round((sampleSignal * 0.35 + sourceSignal * 0.2 + fallbackSignal * 0.25 + recencySignal * 0.2) * 100);

  const phase = phaseFromTraits(current);
  const tags = buildIdentityTags(stable);
  const tier = confidenceTier(confidenceScore);

  const rationale = [
    `${params.sampledCount} tracks sampled`,
    `${Math.round(sourceSignal * 100)}% source diversity`,
    `${Math.round((1 - params.metadataFallbackRatio) * 100)}% direct feature coverage`,
    `${Math.round(recencySignal * 100)}% recency completeness`,
  ];

  const explainSummary = [
    `Your listening pattern suggests a ${phase.label} phase right now, while your stable identity remains ${tags.slice(0, 2).join(" + ")}.`,
    signals.length ? `Recent shift: ${signals.join(", ")}.` : "No major short-term shift detected.",
    `Confidence: ${tier}. This is a listening-pattern interpretation, not a psychological diagnosis.`,
  ].join(" ");

  return {
    id: crypto.randomUUID(),
    userId: params.userId,
    computedAt: Date.now(),
    stableTraits: stable,
    currentPhase: phase,
    drift: {
      driftScore,
      changed: driftScore >= 8,
      signals,
    },
    confidence: {
      tier,
      score: confidenceScore,
      rationale,
    },
    explainSummary,
    baseVector: params.longTermVector,
    identityTags: tags,
  };
}
