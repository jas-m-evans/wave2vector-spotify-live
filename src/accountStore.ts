import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "@upstash/redis";
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
  username?: string;
  passwordSalt?: string;
  passwordHash?: string;
  authProvider: "password" | "google";
  createdAt: number;
  updatedAt: number;
  cache?: AccountCache;
};

type PersistedAccounts = {
  updatedAt: string;
  accounts: AppAccount[];
};

const accounts = new Map<string, AppAccount>();
const accountIdByEmail = new Map<string, string>();
let loaded = false;
const useRedis = Boolean(process.env.UPSTASH_REDIS_REST_URL);
let redis: Redis | null = null;

if (useRedis) {
  try {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  } catch {
    redis = null;
  }
}

function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeUsername(username?: string): string | undefined {
  const value = (username ?? "").trim();
  return value.length ? value : undefined;
}

async function ensureLoaded(): Promise<void> {
  if (loaded) {
    return;
  }
  try {
    const raw = redis
      ? await redis.get("app:accounts")
      : await fs.readFile(accountsPath, "utf8");
    const serial = typeof raw === "string" ? raw : "";
    if (!serial) {
      loaded = true;
      return;
    }
    const parsed = JSON.parse(serial) as PersistedAccounts;
    for (const account of parsed.accounts ?? []) {
      const normalized = normalizeEmail(account.email);
      const existingId = accountIdByEmail.get(normalized);
      if (!existingId) {
        const hydrated = { ...account, email: normalized };
        accounts.set(hydrated.id, hydrated);
        accountIdByEmail.set(normalized, hydrated.id);
      } else {
        const existing = accounts.get(existingId);
        if (!existing || (account.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
          accounts.delete(existingId);
          const hydrated = { ...account, email: normalized };
          accounts.set(hydrated.id, hydrated);
          accountIdByEmail.set(normalized, hydrated.id);
        }
      }
    }
  } catch {
    // no-op
  }
  loaded = true;
}

async function persist(): Promise<void> {
  const payload: PersistedAccounts = {
    updatedAt: new Date().toISOString(),
    accounts: [...accounts.values()],
  };
  const serialized = JSON.stringify(payload, null, 2);
  if (redis) {
    try {
      await redis.set("app:accounts", serialized);
      return;
    } catch {
      // fall through to local fs fallback
    }
  }

  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(accountsPath, serialized, "utf8");
  } catch {
    // In read-only serverless filesystems, keep data in memory for runtime.
  }
}

export async function createAccount(email: string, password: string, username?: string): Promise<AppAccount> {
  await ensureLoaded();
  const normalized = normalizeEmail(email);
  if (accountIdByEmail.has(normalized)) {
    throw new Error("Account already exists for this email.");
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const account: AppAccount = {
    id: crypto.randomUUID(),
    email: normalized,
    username: normalizeUsername(username),
    passwordSalt: salt,
    passwordHash: hashPassword(password, salt),
    authProvider: "password",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  accounts.set(account.id, account);
  accountIdByEmail.set(normalized, account.id);
  await persist();
  return account;
}

export async function loginAccount(email: string, password: string): Promise<AppAccount> {
  await ensureLoaded();
  const normalized = normalizeEmail(email);
  const accountId = accountIdByEmail.get(normalized);
  const account = accountId ? accounts.get(accountId) : undefined;
  if (!account) {
    throw new Error("Invalid email or password.");
  }
  if (account.authProvider !== "password" || !account.passwordSalt || !account.passwordHash) {
    throw new Error("This account uses Google sign-in. Use Google to log in.");
  }
  const expected = hashPassword(password, account.passwordSalt);
  if (expected !== account.passwordHash) {
    throw new Error("Invalid email or password.");
  }
  return account;
}

export async function upsertGoogleAccount(email: string): Promise<AppAccount> {
  await ensureLoaded();
  const normalized = normalizeEmail(email);
  const existingId = accountIdByEmail.get(normalized);
  const existing = existingId ? accounts.get(existingId) : undefined;
  if (existing) {
    existing.authProvider = existing.authProvider ?? "google";
    existing.updatedAt = Date.now();
    accounts.set(existing.id, existing);
    await persist();
    return existing;
  }

  const account: AppAccount = {
    id: crypto.randomUUID(),
    email: normalized,
    authProvider: "google",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  accounts.set(account.id, account);
  accountIdByEmail.set(normalized, account.id);
  await persist();
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
