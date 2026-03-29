import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TrackFeatureVector } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, "../.data");
const libraryPath = path.resolve(dataDir, "library.json");

type PersistedLibrary = {
  updatedAt: string;
  tracks: TrackFeatureVector[];
};

export async function loadLibraryFromDisk(): Promise<Map<string, TrackFeatureVector>> {
  try {
    const raw = await fs.readFile(libraryPath, "utf8");
    const parsed = JSON.parse(raw) as PersistedLibrary;
    const map = new Map<string, TrackFeatureVector>();
    for (const track of parsed.tracks ?? []) {
      map.set(track.trackId, track);
    }
    return map;
  } catch {
    return new Map<string, TrackFeatureVector>();
  }
}

export async function persistLibraryToDisk(library: Map<string, TrackFeatureVector>): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const payload: PersistedLibrary = {
    updatedAt: new Date().toISOString(),
    tracks: [...library.values()],
  };
  await fs.writeFile(libraryPath, JSON.stringify(payload, null, 2), "utf8");
}
