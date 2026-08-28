import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));

import {
  fanOutBadgeNotification,
  fanOutQueueCycleNotification,
  fanOutNotification,
  findTargetDevices,
  resetApnsSenderForTests,
  setApnsSenderForTests,
} from "../src/lib/apns.js";
import type { ApnsNotification } from "../src/lib/apns.js";
import { log } from "../src/lib/logger.js";
import { resetFakeDb, seedMobileDevice } from "./support/fake-db.js";

describe("APNs fan-out diagnostics", () => {
  beforeEach(() => {
    resetFakeDb();
    resetApnsSenderForTests();
  });

  it("logs rejected per-user sender results without payload or token fields", async () => {
    seedMobileDevice({ userId: "operator-1", platform: "ios" });
    setApnsSenderForTests({
      send: async () => {
        throw new TypeError("provider key rejected");
      },
    });
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined as never);

    await fanOutNotification({
      kind: "alert",
      preferenceKey: "messageReceived",
      title: "title",
      body: "body",
      data: { messageId: "message-1" },
    });

    expect(error).toHaveBeenCalledWith(
      {
        component: "apns",
        errorName: "TypeError",
        notificationKind: "alert",
        preferenceKey: "messageReceived",
        userId: "operator-1",
      },
      "APNs sender rejected fan-out",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("message-1");
    expect(JSON.stringify(error.mock.calls)).not.toContain("apnsToken");
  });

  it("targets every active device for badge sync regardless of alert preferences", async () => {
    const optedOut = seedMobileDevice({
      userId: "operator-1",
      preferences: { messageReceived: false },
    });
    const optedIn = seedMobileDevice({
      userId: "operator-1",
      preferences: { messageReceived: true },
    });
    seedMobileDevice({
      userId: "operator-1",
      revokedAt: new Date(),
    });

    await expect(findTargetDevices("operator-1", "messageReceived")).resolves.toEqual([
      expect.objectContaining({ id: optedIn.id }),
    ]);
    await expect(findTargetDevices("operator-1", null)).resolves.toEqual([
      expect.objectContaining({ id: optedOut.id }),
      expect.objectContaining({ id: optedIn.id }),
    ]);
  });

  it("propagates badge fan-out failures for durable retry", async () => {
    seedMobileDevice({ userId: "operator-1", platform: "ios" });
    setApnsSenderForTests({
      send: async () => {
        throw new Error("APNs unavailable");
      },
    });

    await expect(
      fanOutBadgeNotification({
        kind: "badge",
        badge: 3,
      }),
    ).rejects.toThrow("APNs badge fan-out failed for 1 user");
  });

  it("does not retry a queue-cycle alert after a partial fan-out failure", async () => {
    seedMobileDevice({ userId: "operator-1", platform: "ios" });
    setApnsSenderForTests({
      send: async () => {
        throw new Error("APNs unavailable");
      },
    });
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined as never);

    await fanOutQueueCycleNotification({
      kind: "alert",
      preferenceKey: "messageReceived",
      title: "Messages waiting",
      body: "Open the moderation queue to review new booth recordings.",
    });

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "apns",
        notificationKind: "alert",
        preferenceKey: "messageReceived",
        userId: "operator-1",
      }),
      "APNs sender rejected queue-cycle alert",
    );
  });

  it("passes the badge delivery fence through fan-out", async () => {
    seedMobileDevice({ userId: "operator-1", platform: "ios" });
    const fence = vi.fn(async () => new Date(Date.now() + 60_000));
    const send = vi.fn(
      async (_userId: string, _notification: ApnsNotification, beforeSubmit?: typeof fence) => {
        expect(beforeSubmit).toBe(fence);
      },
    );
    setApnsSenderForTests({ send });

    await fanOutBadgeNotification({ kind: "badge", badge: 2 }, fence);

    expect(send).toHaveBeenCalledTimes(1);
  });
});
