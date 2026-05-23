import { beforeEach, describe, expect, it, vi } from "vitest";

const { fakeDb, store, argonHash, argonVerify } = vi.hoisted(() => {
  const tokens = new Map<string, Record<string, unknown>>();
  const argonHash = vi.fn(async (plaintext: string) => `hash:${plaintext}`);
  const argonVerify = vi.fn(async (hash: string, plaintext: string) => hash === `hash:${plaintext}`);

  return {
    store: { tokens },
    argonHash,
    argonVerify,
    fakeDb: {
      apiToken: {
        findUnique: vi.fn(async ({ where }) => {
          if (where.id) return tokens.get(where.id) ?? null;
          return Array.from(tokens.values()).find((token) => token.lookupId === where.lookupId) ?? null;
        }),
        update: vi.fn(async ({ where, data }) => {
          const row = tokens.get(where.id);
          if (!row) throw new Error("missing token");
          const next = { ...row, ...data };
          tokens.set(where.id, next);
          return next;
        }),
      },
    },
  };
});

vi.mock("argon2", () => ({
  default: {
    argon2id: 2,
    hash: argonHash,
    verify: argonVerify,
  },
}));
vi.mock("../src/lib/db.js", () => ({ db: fakeDb }));

import { generateToken, resetApiTokenStateForTests, verifyToken } from "../src/lib/api-tokens.js";

const seedToken = async (overrides: Record<string, unknown> = {}) => {
  const generated = await generateToken();
  const token = {
    id: crypto.randomUUID(),
    name: "Booth Pi",
    lookupId: generated.lookupId,
    tokenHash: generated.hash,
    last4: generated.last4,
    createdByUserId: "user-1",
    createdAt: new Date(),
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
  store.tokens.set(token.id, token);
  return { generated, token };
};

describe("api token verification", () => {
  beforeEach(() => {
    store.tokens.clear();
    argonHash.mockClear();
    argonVerify.mockClear();
    resetApiTokenStateForTests();
  });

  it("returns the token for a valid plaintext token", async () => {
    const { generated, token } = await seedToken();
    await expect(verifyToken(generated.plaintext)).resolves.toMatchObject({ id: token.id });
    expect(argonVerify).toHaveBeenCalledTimes(1);
  });

  it("rejects expired tokens", async () => {
    const { generated } = await seedToken({ expiresAt: new Date(Date.now() - 1000) });
    await expect(verifyToken(generated.plaintext)).resolves.toBeNull();
    expect(argonVerify).not.toHaveBeenCalled();
  });

  it("rejects revoked tokens", async () => {
    const { generated } = await seedToken({ revokedAt: new Date() });
    await expect(verifyToken(generated.plaintext)).resolves.toBeNull();
    expect(argonVerify).not.toHaveBeenCalled();
  });

  it("uses the cache after the first successful argon2 verification", async () => {
    const { generated, token } = await seedToken();
    await expect(verifyToken(generated.plaintext)).resolves.toMatchObject({ id: token.id });
    await expect(verifyToken(generated.plaintext)).resolves.toMatchObject({ id: token.id });
    expect(argonVerify).toHaveBeenCalledTimes(1);
  });
});
