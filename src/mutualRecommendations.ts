import { MutualRecommendation, RoomParticipantSnapshot, TrackFeatureVector } from "./types.js";

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

function avgVector(vectors: number[][]): number[] | undefined {
  if (!vectors.length) {
    return undefined;
  }
  const dims = vectors[0]?.length ?? 0;
  if (!dims) {
    return undefined;
  }
  const sum = new Array<number>(dims).fill(0);
  for (const vector of vectors) {
    if (vector.length !== dims) {
      continue;
    }
    for (let i = 0; i < dims; i += 1) {
      sum[i] += vector[i];
    }
  }
  return sum.map((value) => value / vectors.length);
}

function reasonTags(scoreA: number, scoreB: number, track: TrackFeatureVector, joint: number[]): string[] {
  const tags: string[] = [];
  const fairnessGap = Math.abs(scoreA - scoreB);

  if (fairnessGap <= 0.08) {
    tags.push("balanced fit for both");
  } else if (scoreA > scoreB) {
    tags.push("leans toward listener A");
  } else {
    tags.push("leans toward listener B");
  }

  const energyDiff = Math.abs((track.vector[1] ?? 0) - (joint[1] ?? 0));
  const valenceDiff = Math.abs((track.vector[9] ?? 0) - (joint[9] ?? 0));
  const acousticDiff = Math.abs((track.vector[6] ?? 0) - (joint[6] ?? 0));

  if (energyDiff < 0.15) {
    tags.push("shared energy");
  }
  if (valenceDiff < 0.15) {
    tags.push("similar valence");
  }
  if (acousticDiff < 0.2) {
    tags.push("bridges acousticness gap");
  }

  return tags.slice(0, 3);
}

export function computeMutualRecommendations(params: {
  participants: [RoomParticipantSnapshot, RoomParticipantSnapshot];
  library: Map<string, TrackFeatureVector>;
  k: number;
}): MutualRecommendation[] {
  const [participantA, participantB] = params.participants;
  const tasteA = participantA.tasteProfile?.tasteVector;
  const tasteB = participantB.tasteProfile?.tasteVector;

  if (!tasteA || !tasteB || tasteA.length !== tasteB.length) {
    return [];
  }

  const nowVectors = [participantA.nowPlayingState?.nowPlaying?.vector, participantB.nowPlayingState?.nowPlaying?.vector]
    .filter((vector): vector is number[] => Boolean(vector));

  const jointBase = avgVector([tasteA, tasteB]);
  if (!jointBase) {
    return [];
  }

  const jointNow = avgVector(nowVectors);
  const jointVector = jointNow
    ? jointBase.map((value, idx) => value * 0.85 + (jointNow[idx] ?? 0) * 0.15)
    : jointBase;

  const scored = [...params.library.values()].map((track) => {
    const scoreForA = Math.max(0, cosineSimilarity(track.vector, tasteA));
    const scoreForB = Math.max(0, cosineSimilarity(track.vector, tasteB));
    const scoreToJoint = Math.max(0, cosineSimilarity(track.vector, jointVector));
    const fairnessPenalty = Math.abs(scoreForA - scoreForB) * 0.2;
    const jointScore = scoreToJoint * 0.6 + ((scoreForA + scoreForB) / 2) * 0.4 - fairnessPenalty;

    return {
      track,
      scoreForA,
      scoreForB,
      jointScore,
    };
  });

  return scored
    .sort((a, b) => b.jointScore - a.jointScore)
    .slice(0, Math.max(1, params.k))
    .map((item) => ({
      trackId: item.track.trackId,
      name: item.track.name,
      artist: item.track.artist,
      artworkUrl: item.track.artworkUrl,
      previewUrl: item.track.previewUrl,
      scoreForA: Number(item.scoreForA.toFixed(4)),
      scoreForB: Number(item.scoreForB.toFixed(4)),
      jointScore: Number(item.jointScore.toFixed(4)),
      reasonTags: reasonTags(item.scoreForA, item.scoreForB, item.track, jointVector),
    }));
}
