import crypto from "node:crypto";
import { GeneratedAsset, MoodProfileSnapshot, RoomArtifact, RoomThemeTokens } from "./types.js";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function pick<T>(list: T[], indexSeed: number, fallback: T): T {
  if (!list.length) {
    return fallback;
  }
  const index = Math.abs(indexSeed) % list.length;
  return list[index] ?? fallback;
}

function hashToInt(value: string): number {
  const digest = crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
  return parseInt(digest, 16);
}

function hsvToHex(h: number, s: number, v: number): string {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const rgb = (() => {
    switch (i % 6) {
      case 0: return [v, t, p];
      case 1: return [q, v, p];
      case 2: return [p, v, t];
      case 3: return [p, q, v];
      case 4: return [t, p, v];
      default: return [v, p, q];
    }
  })();
  const hex = rgb.map((value) => Math.round(value * 255).toString(16).padStart(2, "0")).join("");
  return `#${hex}`;
}

function buildThemeTokens(snapshot: MoodProfileSnapshot, seed: string): RoomThemeTokens {
  const seedInt = hashToInt(seed);
  const traits = snapshot.stableTraits;
  const hue = clamp01((traits.warmth * 0.55 + traits.intensity * 0.3 + (seedInt % 100) / 100 * 0.15));
  const sat = clamp01(0.35 + traits.dynamism * 0.45);
  const baseV = clamp01(0.35 + traits.warmth * 0.5);

  const palette = [
    hsvToHex(hue, sat, baseV),
    hsvToHex((hue + 0.07) % 1, clamp01(sat * 0.8), clamp01(baseV + 0.15)),
    hsvToHex((hue + 0.15) % 1, clamp01(sat * 0.65), clamp01(baseV + 0.22)),
    hsvToHex((hue + 0.52) % 1, clamp01(0.22 + traits.introspection * 0.4), clamp01(0.28 + traits.texturalFocus * 0.35)),
  ];

  const materials = [
    traits.texturalFocus >= 0.55 ? "brushed velvet" : "matte ceramic",
    traits.intensity >= 0.62 ? "anodized metal" : "soft glass",
    traits.introspection >= 0.58 ? "smoked stone" : "light timber",
  ];

  const motifs = [
    traits.dynamism >= 0.6 ? "layered motion trails" : "calm concentric arcs",
    traits.introspection >= 0.6 ? "deep horizon frame" : "open skylight geometry",
    traits.verbalFocus >= 0.55 ? "signal glyphs" : "texture ripples",
  ];

  const anchors = [
    traits.intensity >= 0.62 ? "prism tower" : "floating lantern",
    traits.warmth >= 0.58 ? "hearth orb" : "cool tide basin",
    traits.introspection >= 0.6 ? "mirror gate" : "sunline arch",
  ];

  return {
    palette,
    lighting: traits.intensity >= 0.7 ? "dramatic" : traits.warmth >= 0.55 ? "soft" : "balanced",
    materials,
    motifs,
    anchorObjects: anchors,
  };
}

function buildPromptTemplate(snapshot: MoodProfileSnapshot, tokens: RoomThemeTokens): string {
  return [
    "Create a premium symbolic interior environment image.",
    `Identity tags: ${snapshot.identityTags.join(", ")}`,
    `Current phase: ${snapshot.currentPhase.label}`,
    `Palette: ${tokens.palette.join(", ")}`,
    `Lighting: ${tokens.lighting}`,
    `Materials: ${tokens.materials.join(", ")}`,
    `Motifs: ${tokens.motifs.join(", ")}`,
    `Anchor objects: ${tokens.anchorObjects.join(", ")}`,
    "No text, no faces, no logos, no brand marks.",
  ].join(" ");
}

function evolutionLabel(snapshot: MoodProfileSnapshot): string {
  if (!snapshot.drift.changed || !snapshot.drift.signals.length) {
    return "Steady identity this cycle";
  }
  return `Shift detected: ${snapshot.drift.signals[0]}`;
}

function buildSvgData(tokens: RoomThemeTokens, seed: string, label: string): string {
  const seedInt = hashToInt(seed);
  const angle = seedInt % 360;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='1024' height='1024' viewBox='0 0 1024 1024'>
<defs>
<linearGradient id='g1' x1='0' y1='0' x2='1' y2='1'>
<stop offset='0%' stop-color='${tokens.palette[0]}'/>
<stop offset='60%' stop-color='${tokens.palette[1]}'/>
<stop offset='100%' stop-color='${tokens.palette[2]}'/>
</linearGradient>
<radialGradient id='g2' cx='55%' cy='35%' r='65%'>
<stop offset='0%' stop-color='${tokens.palette[2]}' stop-opacity='0.55'/>
<stop offset='100%' stop-color='${tokens.palette[3]}' stop-opacity='0.16'/>
</radialGradient>
</defs>
<rect width='1024' height='1024' fill='url(#g1)'/>
<rect width='1024' height='1024' fill='url(#g2)'/>
<g transform='translate(512 512) rotate(${angle})'>
<circle cx='0' cy='0' r='260' fill='none' stroke='${tokens.palette[3]}' stroke-width='18' opacity='0.55'/>
<rect x='-210' y='-90' width='420' height='180' rx='38' fill='${tokens.palette[1]}' opacity='0.35'/>
<path d='M-360 260 Q0 ${seedInt % 220 - 110} 360 260' stroke='${tokens.palette[2]}' stroke-width='22' fill='none' opacity='0.48'/>
</g>
<text x='48' y='960' fill='${tokens.palette[2]}' font-size='28' font-family='Arial, Helvetica, sans-serif' opacity='0.55'>${label}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export function generateInnerRoom(params: {
  userId: string;
  snapshot: MoodProfileSnapshot;
  styleVersion?: string;
}): { artifact: RoomArtifact; asset: GeneratedAsset } {
  const styleVersion = params.styleVersion ?? "innerroom-v1";
  const weekBucket = Math.floor(params.snapshot.computedAt / (1000 * 60 * 60 * 24 * 7));
  const seed = crypto
    .createHash("sha256")
    .update(`${params.userId}:${params.snapshot.id}:${weekBucket}:${params.snapshot.identityTags.join("|")}`)
    .digest("hex")
    .slice(0, 24);

  const themeTokens = buildThemeTokens(params.snapshot, seed);
  const promptTemplate = buildPromptTemplate(params.snapshot, themeTokens);
  const label = evolutionLabel(params.snapshot);
  const artifactId = crypto.randomUUID();
  const assetId = crypto.randomUUID();

  const artifact: RoomArtifact = {
    id: artifactId,
    userId: params.userId,
    snapshotId: params.snapshot.id,
    seed,
    styleVersion,
    status: "queued",
    promptTemplate,
    themeTokens,
    narrativeTags: params.snapshot.identityTags,
    evolutionLabel: label,
    createdAt: Date.now(),
    primaryAssetId: assetId,
  };

  const dataUrl = buildSvgData(themeTokens, seed, label);
  const asset: GeneratedAsset = {
    id: assetId,
    artifactId,
    variant: "primary",
    storageUrl: dataUrl,
    thumbUrl: dataUrl,
    promptVersion: "innerroom-base-v1",
    modelName: "deterministic-svg-generator",
    generationCost: 0,
    createdAt: Date.now(),
  };

  return { artifact, asset };
}

export function generateBlendRoom(params: {
  blendId: string;
  initiatorUserId: string;
  partnerUserId: string;
  blendVector: number[];
  tagsFromA: string[];
  tagsFromB: string[];
}): { artifact: RoomArtifact; asset: GeneratedAsset } {
  const safeTagsA = params.tagsFromA.length ? params.tagsFromA : ["origin-a"];
  const safeTagsB = params.tagsFromB.length ? params.tagsFromB : ["origin-b"];
  const pseudoSnapshot: MoodProfileSnapshot = {
    id: `blend-${params.blendId}`,
    userId: params.initiatorUserId,
    computedAt: Date.now(),
    stableTraits: {
      intensity: clamp01(params.blendVector[1] ?? 0.5),
      warmth: clamp01(((params.blendVector[9] ?? 0.5) + (params.blendVector[6] ?? 0.5)) / 2),
      texturalFocus: clamp01(((params.blendVector[7] ?? 0.5) + (params.blendVector[8] ?? 0.5)) / 2),
      dynamism: clamp01(((params.blendVector[0] ?? 0.5) + (params.blendVector[10] ?? 0.5)) / 2),
      introspection: clamp01(((1 - (params.blendVector[9] ?? 0.5)) + (params.blendVector[6] ?? 0.5)) / 2),
      verbalFocus: clamp01(params.blendVector[5] ?? 0.5),
    },
    currentPhase: { label: "grounded", score: 0.5 },
    drift: { driftScore: 0, changed: false, signals: [] },
    confidence: { tier: "medium", score: 70, rationale: ["Blend generated from two user mood vectors"] },
    explainSummary: "EchoMerge blend room generated from both users' patterns.",
    baseVector: params.blendVector,
    identityTags: [...new Set([...safeTagsA.slice(0, 2), ...safeTagsB.slice(0, 2), "fusion"])],
  };
  const generated = generateInnerRoom({
    userId: params.initiatorUserId,
    snapshot: pseudoSnapshot,
    styleVersion: "echomerge-v1",
  });
  generated.artifact.narrativeTags = pseudoSnapshot.identityTags;
  generated.artifact.evolutionLabel = `Blend of ${pick(safeTagsA, 0, "origin-a")} + ${pick(safeTagsB, 0, "origin-b")}`;
  generated.asset.promptVersion = "echomerge-base-v1";
  return generated;
}
