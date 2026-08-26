import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/require-api-token.js", () => ({
  requireApiToken:
    () =>
    async (_context: unknown, next: () => Promise<void>): Promise<void> =>
      next(),
}));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);

import { createApp } from "../src/index.js";
import { db } from "../src/lib/db.js";
import { resetInstallationCacheForTests } from "../src/lib/installation.js";

const describeWithDatabase = process.env["RUN_DATABASE_TESTS"] === "1" ? describe : describe.skip;

describeWithDatabase("question draws with PostgreSQL", () => {
  let installationId = "";
  let fileIds: string[] = [];
  let questionIds: string[] = [];

  beforeEach(async () => {
    resetInstallationCacheForTests();
    const installation = await db.installation.findFirst({
      where: { endedAt: null },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    });
    if (!installation) throw new Error("PostgreSQL test database has no open installation");
    installationId = installation.id;
    await db.installation.update({
      where: { id: installationId },
      data: {
        questionSelectionCycle: 0,
        lastSelectedQuestionId: null,
        recentQuestionDraws: [],
      },
    });
    const suffix = randomUUID();
    const files = await Promise.all(
      [0, 1].map((index) =>
        db.file.create({
          data: {
            blobContainer: "audio",
            blobKey: `questions/postgres-${suffix}-${index}.flac`,
            sha256: `${suffix.replaceAll("-", "")}${index}`.padEnd(64, "0"),
            sizeBytes: 1,
            durationMs: 1_000,
            contentType: "audio/flac",
          },
        }),
      ),
    );
    fileIds = files.map((file) => file.id);
    const questions = await Promise.all(
      files.map((file, index) =>
        db.question.create({
          data: {
            prompt: `PostgreSQL question ${suffix} ${index}`,
            status: "active",
            audioId: file.id,
            installationId,
          },
        }),
      ),
    );
    questionIds = questions.map((question) => question.id);
  });

  afterEach(async () => {
    resetInstallationCacheForTests();
    await db.question.deleteMany({ where: { id: { in: questionIds } } });
    await db.file.deleteMany({ where: { id: { in: fileIds } } });
    await db.installation.update({
      where: { id: installationId },
      data: {
        questionSelectionCycle: 0,
        lastSelectedQuestionId: null,
        recentQuestionDraws: [],
      },
    });
  });

  it("serializes concurrent draws into distinct ticket consumption", async () => {
    const app = createApp();
    const responses = await Promise.all([
      app.request("/v1/questions/random"),
      app.request("/v1/questions/random"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const ids = await Promise.all(
      responses.map(async (response) => ((await response.json()) as { id: string }).id),
    );
    expect(new Set(ids).size).toBe(2);
    const questions = await db.question.findMany({
      where: { installationId },
      select: { selectionsInCycle: true },
    });
    expect(questions.reduce((total, question) => total + question.selectionsInCycle, 0)).toBe(2);
  });

  it("returns a retryable response when PostgreSQL cancels a blocked row lock", async () => {
    let markLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`
            SELECT "id"
            FROM "Installation"
            WHERE "id" = ${installationId}::uuid
            FOR UPDATE
          `;
        markLocked();
        await released;
      },
      { timeout: 10_000 },
    );
    await locked;

    let response: Response;
    try {
      response = await createApp().request("/v1/questions/random");
    } finally {
      releaseLock();
      await blocker;
    }

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toEqual({ error: "question_draw_busy" });
  }, 10_000);
});
