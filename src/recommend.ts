import { Recommendation, TrackFeatureVector } from "./types.js";

function cosineDistance(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) {
    return 1;
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
    return 1;
  }
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1 - similarity;
}

export function recommendNearest(
  target: TrackFeatureVector,
  candidates: TrackFeatureVector[],
  k: number,
): Recommendation[] {
  const deduped = new Map<string, Recommendation>();

  for (const candidate of candidates) {
    if (candidate.trackId === target.trackId) {
      continue;
    }

    const distance = cosineDistance(target.vector, candidate.vector);
    const similarity = Math.max(0, 1 - distance);
    const rec: Recommendation = {
      ...candidate,
      distance,
      similarity,
    };

    const prev = deduped.get(candidate.trackId);
    if (!prev || rec.distance < prev.distance) {
      deduped.set(candidate.trackId, rec);
    }
  }

  return [...deduped.values()]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(1, k));
}
