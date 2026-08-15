import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));

import {
  fanOutNotification,
  resetApnsSenderForTests,
  setApnsSenderForTests,
} from "../src/lib/apns.js";
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
      preferenceKey: "messageReceived",
      title: "title",
      body: "body",
      data: { messageId: "message-1" },
    });

    expect(error).toHaveBeenCalledWith(
      {
        component: "apns",
        errorName: "TypeError",
        preferenceKey: "messageReceived",
        userId: "operator-1",
      },
      "APNs sender rejected fan-out",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("message-1");
    expect(JSON.stringify(error.mock.calls)).not.toContain("apnsToken");
  });
});
