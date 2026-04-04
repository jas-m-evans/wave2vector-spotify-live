import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionRecord, SpotifyProfile } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, "../.data");
const accountsPath = path.resolve(dataDir, "accounts.json");

type AccountCache = {
  tasteVector?: number[];
  tasteUpdatedAt?: number;
  streamModePreference?: "live" | "batch";
  lastSyncStats?: SessionRecord["lastSyncStats"];
  artistInsights?: SessionRecord["artistInsights"];
  spotifyProfile?: SpotifyProfile;
  bootstrapCompletedAt?: number;
};

export type AppAccount = {
  id: string;
  email: string;
  passwordSalt: string;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
  cache?: AccountCache;
};

type PersistedAccounts = {
  updatedAt: string;
  accounts: AppAccount[];
};

const accounts = new Map<string, AppAccount>();
let loaded = false;

function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex");
}

async function ensureLoaded(): Promise<void> {
  if (loaded) {
    return;
  }
  try {
    const raw = await fs.readFile(accountsPath, "utf8");
    const parsed = JSON.parse(raw) as PersistedAccounts;
    for (const account of parsed.accounts ?? []) {
      accounts.set(account.id, account);
    }
  } catch {
    // no-op
  }
  loaded = true;
}

async function persist(): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const payload: PersistedAccounts = {
    updatedAt: new Date().toISOString(),
    accounts: [...accounts.values()],
  };
  await fs.writeFile(accountsPath, JSON.stringify(payload, null, 2), "utf8");
}

export async function createAccount(email: string, password: string): Promise<AppAccount> {
  await ensureLoaded();
  const normalized = email.trim().toLowerCase();
  const existing = [...accounts.values()].find((account) => account.email === normalized);
  if (existing) {
    throw new Error("Account already exists for this email.");
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const account: AppAccount = {
    id: crypto.randomUUID(),
    email: normalized,
    passwordSalt: salt,
    passwordHash: hashPassword(password, salt),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  accounts.set(account.id, account);
  await persist();
  return account;
}

export async function loginAccount(email: string, password: string): Promise<AppAccount> {
  await ensureLoaded();
  const normalized = email.trim().toLowerCase();
  const account = [...accounts.values()].find((item) => item.email === normalized);
  if (!account) {
    throw new Error("Invalid email or password.");
  }
  const expected = hashPassword(password, account.passwordSalt);
  if (expected !== account.passwordHash) {
    throw new Error("Invalid email or password.");
  }
  return account;
}

export async function getAccountById(accountId: string): Promise<AppAccount | null> {
  await ensureLoaded();
  return accounts.get(accountId) ?? null;
}

export async function saveSessionCacheToAccount(accountId: string, session: SessionRecord, spotifyProfile?: SpotifyProfile): Promise<void> {
  await ensureLoaded();
  const account = accounts.get(accountId);
  if (!account) {
    return;
  }
  account.cache = {
    tasteVector: session.tasteVector,
    tasteUpdatedAt: session.tasteUpdatedAt,
    streamModePreference: session.streamModePreference,
    lastSyncStats: session.lastSyncStats,
    artistInsights: session.artistInsights,
    spotifyProfile: spotifyProfile ?? account.cache?.spotifyProfile,
    bootstrapCompletedAt: session.bootstrapCompletedAt,
  };
  account.updatedAt = Date.now();
  accounts.set(account.id, account);
  await persist();
}

export async function getCachedSessionLike(accountId: string): Promise<Partial<SessionRecord> | null> {
  await ensureLoaded();
  const account = accounts.get(accountId);
  if (!account?.cache) {
    return null;
  }
  return {
    streamModePreference: account.cache.streamModePreference,
    tasteVector: account.cache.tasteVector,
    tasteUpdatedAt: account.cache.tasteUpdatedAt,
    bootstrapCompletedAt: account.cache.bootstrapCompletedAt,
    lastSyncStats: account.cache.lastSyncStats,
    artistInsights: account.cache.artistInsights,
  };
}
