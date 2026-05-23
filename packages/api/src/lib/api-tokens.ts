import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiToken } from "@prisma/client";
import argon2 from "argon2";
import { db } from "./db.js";

const tokenPrefix = "tb_";
const randomTokenLength = 32;
const tokenLength = tokenPrefix.length + randomTokenLength;
const lookupIdLength = 8;
const cacheCapacity = 256;
const cacheTtlMs = 60_000;
const usageFlushMs = 30_000;

type CacheEntry = {
  tokenId: string;
  expiresAt: number;
};

const validTokenCache = new Map<string, CacheEntry>();
const pendingUsageUpdates = new Map<string, Date>();
let usageFlushTimer: NodeJS.Timeout | null = null;

const constantTimeStringEqual = (a: string, b: string): boolean => {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
};

const isUrlSafeTokenBody = (value: string): boolean => {
  let invalid = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 45 ||
      code === 95;
    invalid |= valid ? 0 : 1;
  }
  return invalid === 0;
};

const lookupIdFromPlaintext = (plaintext: string): string | null => {
  if (plaintext.length !== tokenLength) return null;
  if (!constantTimeStringEqual(plaintext.slice(0, tokenPrefix.length), tokenPrefix)) return null;
  if (!isUrlSafeTokenBody(plaintext.slice(tokenPrefix.length))) return null;
  return plaintext.slice(0, lookupIdLength);
};

const cacheKeyForPlaintext = (plaintext: string): string =>
  createHash("sha256").update(plaintext).digest("base64url");

const cacheGet = (key: string): string | null => {
  const entry = validTokenCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    validTokenCache.delete(key);
    return null;
  }
  validTokenCache.delete(key);
  validTokenCache.set(key, entry);
  return entry.tokenId;
};

const cacheSet = (key: string, tokenId: string): void => {
  validTokenCache.delete(key);
  validTokenCache.set(key, { tokenId, expiresAt: Date.now() + cacheTtlMs });
  while (validTokenCache.size > cacheCapacity) {
    const oldestKey = validTokenCache.keys().next().value;
    if (oldestKey === undefined) break;
    validTokenCache.delete(oldestKey);
  }
};

const isUsableToken = (token: ApiToken | null, now = new Date()): token is ApiToken => {
  if (!token) return false;
  if (token.revokedAt) return false;
  if (token.expiresAt && token.expiresAt <= now) return false;
  return true;
};

export const invalidateApiTokenCache = (tokenId?: string): void => {
  if (!tokenId) {
    validTokenCache.clear();
    return;
  }
  for (const [key, entry] of validTokenCache.entries()) {
    if (constantTimeStringEqual(entry.tokenId, tokenId)) validTokenCache.delete(key);
  }
};

export const flushApiTokenUsageUpdates = async (): Promise<void> => {
  if (usageFlushTimer) {
    clearTimeout(usageFlushTimer);
    usageFlushTimer = null;
  }
  const updates = Array.from(pendingUsageUpdates.entries());
  pendingUsageUpdates.clear();
  await Promise.all(
    updates.map(([id, lastUsedAt]) =>
      db.apiToken.update({ where: { id }, data: { lastUsedAt } }).catch(() => undefined),
    ),
  );
};

const scheduleUsageFlush = (): void => {
  if (usageFlushTimer) return;
  usageFlushTimer = setTimeout(() => {
    void flushApiTokenUsageUpdates();
  }, usageFlushMs);
  usageFlushTimer.unref?.();
};

const queueLastUsedAtUpdate = (tokenId: string): void => {
  pendingUsageUpdates.set(tokenId, new Date());
  scheduleUsageFlush();
};

export const generateToken = async (): Promise<{
  plaintext: string;
  lookupId: string;
  hash: string;
  last4: string;
}> => {
  const plaintext = `${tokenPrefix}${randomBytes(24).toString("base64url")}`;
  const lookupId = plaintext.slice(0, lookupIdLength);
  const hash = await argon2.hash(plaintext, { type: argon2.argon2id });
  return {
    plaintext,
    lookupId,
    hash,
    last4: plaintext.slice(-4),
  };
};

const findActiveTokenById = async (id: string): Promise<ApiToken | null> => {
  const token = await db.apiToken.findUnique({ where: { id } });
  return isUsableToken(token) ? token : null;
};

export const verifyToken = async (plaintext: string): Promise<ApiToken | null> => {
  const lookupId = lookupIdFromPlaintext(plaintext);
  if (!lookupId) return null;

  const cacheKey = cacheKeyForPlaintext(plaintext);
  const cachedTokenId = cacheGet(cacheKey);
  if (cachedTokenId) {
    const cachedToken = await findActiveTokenById(cachedTokenId);
    if (!cachedToken) {
      validTokenCache.delete(cacheKey);
      return null;
    }
    queueLastUsedAtUpdate(cachedToken.id);
    return cachedToken;
  }

  const token = await db.apiToken.findUnique({ where: { lookupId } });
  if (!token) return null;
  if (!constantTimeStringEqual(token.lookupId, lookupId)) return null;
  if (!isUsableToken(token)) return null;

  const valid = await argon2.verify(token.tokenHash, plaintext);
  if (!valid) return null;

  cacheSet(cacheKey, token.id);
  queueLastUsedAtUpdate(token.id);
  return token;
};

export const resetApiTokenStateForTests = (): void => {
  validTokenCache.clear();
  pendingUsageUpdates.clear();
  if (usageFlushTimer) clearTimeout(usageFlushTimer);
  usageFlushTimer = null;
};
