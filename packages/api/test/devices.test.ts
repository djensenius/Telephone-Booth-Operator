import { createHmac, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index.js";

type DeviceRow = {
  id: string;
  userId: string;
  apnsToken: string;
  platform: string;
  deviceName: string | null;
  preferences: Record<string, unknown>;
  registeredAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
};

const { fakeDb, store } = vi.hoisted(() => {
  const users = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const devices = new Map<string, DeviceRow>();

  const withUser = (session: Record<string, unknown>) => ({
    ...session,
    user: users.get(session.userId as string),
  });

  const matches = (row: DeviceRow, where: Record<string, unknown>): boolean => {
    for (const [key, value] of Object.entries(where)) {
      if (key === "apnsToken_platform") continue;
      const rowValue = (row as unknown as Record<string, unknown>)[key];
      if (value === null) {
        if (rowValue !== null) return false;
      } else if (rowValue !== value) {
        return false;
      }
    }
    return true;
  };

  return {
    store: { users, sessions, devices },
    fakeDb: {
      operatorSession: {
        findUnique: vi.fn(async ({ where, include }) => {
          const session = sessions.get(where.id);
          if (!session) return null;
          return include?.user ? withUser(session) : session;
        }),
        update: vi.fn(async ({ where, data, include }) => {
          const session = sessions.get(where.id);
          if (!session) throw new Error("missing session");
          const next = { ...session, ...data };
          sessions.set(where.id, next);
          return include?.user ? withUser(next) : next;
        }),
      },
      mobileDevice: {
        findMany: vi.fn(async ({ where, orderBy }) => {
          const rows = Array.from(devices.values()).filter((row) => matches(row, where));
          if (orderBy?.registeredAt === "desc") {
            rows.sort((a, b) => b.registeredAt.getTime() - a.registeredAt.getTime());
          }
          return rows;
        }),
        findFirst: vi.fn(async ({ where }) => {
          return Array.from(devices.values()).find((row) => matches(row, where)) ?? null;
        }),
        upsert: vi.fn(async ({ where, create, update }) => {
          const { apnsToken, platform } = where.apnsToken_platform as { apnsToken: string; platform: string };
          const existing = Array.from(devices.values()).find(
            (row) => row.apnsToken === apnsToken && row.platform === platform,
          );
          if (existing) {
            const next: DeviceRow = { ...existing, ...update };
            devices.set(existing.id, next);
            return next;
          }
          const row: DeviceRow = {
            id: randomUUID(),
            apnsToken,
            platform,
            deviceName: null,
            preferences: {},
            registeredAt: new Date(),
            lastSeenAt: new Date(),
            revokedAt: null,
            ...create,
          } as DeviceRow;
          devices.set(row.id, row);
          return row;
        }),
        update: vi.fn(async ({ where, data }) => {
          const row = devices.get(where.id);
          if (!row) throw new Error("missing device");
          const next: DeviceRow = { ...row, ...data };
          devices.set(row.id, next);
          return next;
        }),
        updateMany: vi.fn(async ({ where, data }) => {
          let count = 0;
          for (const [id, row] of devices.entries()) {
            if (!matches(row, where)) continue;
            devices.set(id, { ...row, ...data });
            count += 1;
          }
          return { count };
        }),
      },
    },
  };
});

vi.mock("../src/lib/db.js", () => ({ db: fakeDb }));

const sessionSecret = "test-session-secret";
const cookieForSession = (sessionId: string): string => {
  const signature = createHmac("sha256", sessionSecret).update(sessionId).digest("base64url");
  return `__Host-booth_session=${sessionId}.${signature}`;
};

const seedSession = (id: string, sessionId: string): string => {
  const user = { id, oidcSub: id, email: `${id}@example.com`, name: id, groups: [] };
  store.users.set(user.id, user);
  store.sessions.set(sessionId, {
    id: sessionId,
    userId: user.id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    lastSeenAt: new Date(),
  });
  return cookieForSession(sessionId);
};

describe("mobile device registry", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.SESSION_SECRET = sessionSecret;
    store.users.clear();
    store.sessions.clear();
    store.devices.clear();
  });

  it("registers, lists, updates, and revokes a device", async () => {
    const cookie = seedSession("user-1", "session-1");
    const app = createApp();

    const register = await app.request("/v1/devices", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        apnsToken: "a".repeat(64),
        platform: "ios",
        deviceName: "Test iPhone",
        preferences: { messageReceived: false },
      }),
    });
    expect(register.status, await register.clone().text()).toBe(201);
    const created = (await register.json()) as {
      id: string;
      platform: string;
      preferences: Record<string, boolean>;
    };
    expect(created.platform).toBe("ios");
    expect(created.preferences.messageReceived).toBe(false);
    expect(created.preferences.callStarted).toBe(true);

    const list = await app.request("/v1/devices", { headers: { cookie } });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as Array<{ id: string }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);

    const patch = await app.request(`/v1/devices/${created.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ preferences: { messageReceived: true, moderationQueueHigh: true } }),
    });
    expect(patch.status, await patch.clone().text()).toBe(200);
    const patched = (await patch.json()) as { preferences: Record<string, boolean> };
    expect(patched.preferences.messageReceived).toBe(true);
    expect(patched.preferences.moderationQueueHigh).toBe(true);
    expect(patched.preferences.callStarted).toBe(true);

    const revoke = await app.request(`/v1/devices/${created.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(revoke.status).toBe(204);
    expect(store.devices.get(created.id)?.revokedAt).toBeInstanceOf(Date);

    const afterRevoke = await app.request("/v1/devices", { headers: { cookie } });
    expect(afterRevoke.status).toBe(200);
    await expect(afterRevoke.json()).resolves.toEqual([]);
  });

  it("re-registering the same token clears revokedAt and transfers ownership", async () => {
    const cookieA = seedSession("user-a", "session-a");
    const cookieB = seedSession("user-b", "session-b");
    const app = createApp();
    const token = "b".repeat(64);

    const first = await app.request("/v1/devices", {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ apnsToken: token, platform: "ios" }),
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string };
    await app.request(`/v1/devices/${created.id}`, { method: "DELETE", headers: { cookie: cookieA } });
    expect(store.devices.get(created.id)?.revokedAt).toBeInstanceOf(Date);

    const second = await app.request("/v1/devices", {
      method: "POST",
      headers: { cookie: cookieB, "content-type": "application/json" },
      body: JSON.stringify({ apnsToken: token, platform: "ios", deviceName: "Borrowed" }),
    });
    expect(second.status).toBe(201);
    const reregistered = (await second.json()) as { id: string; deviceName: string | null };
    expect(reregistered.id).toBe(created.id);
    expect(reregistered.deviceName).toBe("Borrowed");
    expect(store.devices.get(created.id)?.userId).toBe("user-b");
    expect(store.devices.get(created.id)?.revokedAt).toBeNull();
  });

  it("isolates devices between users", async () => {
    const cookieA = seedSession("user-a", "session-a");
    const cookieB = seedSession("user-b", "session-b");
    const app = createApp();

    const register = await app.request("/v1/devices", {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ apnsToken: "c".repeat(64), platform: "ios" }),
    });
    const created = (await register.json()) as { id: string };

    const otherList = await app.request("/v1/devices", { headers: { cookie: cookieB } });
    await expect(otherList.json()).resolves.toEqual([]);

    const otherPatch = await app.request(`/v1/devices/${created.id}`, {
      method: "PATCH",
      headers: { cookie: cookieB, "content-type": "application/json" },
      body: JSON.stringify({ preferences: { callStarted: false } }),
    });
    expect(otherPatch.status).toBe(404);

    const otherDelete = await app.request(`/v1/devices/${created.id}`, {
      method: "DELETE",
      headers: { cookie: cookieB },
    });
    expect(otherDelete.status).toBe(404);
    expect(store.devices.get(created.id)?.revokedAt).toBeNull();
  });
});
