import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import type { StatsOverview, Transcription } from "@telephone-booth-operator/shared";
import {
  buildLocalDayRanges,
  countsByLocalDay,
  countsFromOverview,
  promptMatches,
  renderExhibitionReportHtml,
  selectLatestSuccessfulTranscription,
  type ExhibitionReportData,
} from "../src/lib/exhibition-report.js";
import {
  DEFAULT_TRANSCRIPT_PROMPT,
  assertOverviewMessagesComplete,
  generateExhibitionReport,
  loadExhibitionReportEnvironment,
  messagesForReport,
  operatorApiRoot,
  operatorCookieHeader,
  parseExhibitionReportArgs,
  type ApiClient,
} from "../scripts/exhibition-report.js";

describe("exhibition report helpers", () => {
  it("builds local calendar ranges across daylight-saving changes", () => {
    const ranges = buildLocalDayRanges(
      new Date("2026-03-07T05:00:00.000Z"),
      new Date("2026-03-10T03:59:59.999Z"),
      "America/Toronto",
    );

    expect(ranges.map((range) => range.date)).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
    expect(ranges[0]?.end.getTime() - ranges[0].start.getTime() + 1).toBe(24 * 60 * 60 * 1000);
    expect(ranges[1]?.end.getTime() - ranges[1].start.getTime() + 1).toBe(23 * 60 * 60 * 1000);
  });

  it("maps existing overview fields to the requested report metrics", () => {
    expect(
      countsFromOverview({
        interactions: { total: 42, messagesLeft: 17 },
        messages: { total: 12, approved: 11 },
        playback: { totalPlaybacks: 9 },
      }),
    ).toEqual({
      interactions: 42,
      messagesLeft: 17,
      messagesApproved: 11,
      messagesListenedTo: 9,
    });
  });

  it("combines non-contiguous UTC segments for the same local calendar day", () => {
    const ranges = [
      {
        date: "2000-10-29",
        start: new Date("2000-10-29T02:30:00.000Z"),
        end: new Date("2000-10-29T02:59:59.999Z"),
      },
      {
        date: "2000-10-29",
        start: new Date("2000-10-29T03:30:00.000Z"),
        end: new Date("2000-10-30T03:29:59.999Z"),
      },
    ];
    const overview = (interactions: number) => ({
      interactions: { total: interactions, messagesLeft: interactions },
      messages: { total: interactions, approved: interactions },
      playback: { totalPlaybacks: interactions },
    });

    expect(countsByLocalDay(ranges, [overview(2), overview(3)])).toEqual([
      {
        date: "2000-10-29",
        counts: {
          interactions: 5,
          messagesLeft: 5,
          messagesApproved: 5,
          messagesListenedTo: 5,
        },
      },
    ]);
  });

  it("covers every local date encountered when a rollback crosses midnight", () => {
    const start = new Date("2000-10-29T02:30:30.000Z");
    const end = new Date("2000-10-29T04:00:00.000Z");
    const ranges = buildLocalDayRanges(start, end, "America/St_Johns");

    expect([...new Set(ranges.map((range) => range.date))]).toEqual(["2000-10-28", "2000-10-29"]);
    expect(
      ranges.reduce(
        (duration, range) => duration + range.end.getTime() - range.start.getTime() + 1,
        0,
      ),
    ).toBe(end.getTime() - start.getTime() + 1);
  });

  it("matches prompt fragments without depending on punctuation or case", () => {
    expect(promptMatches("What Would You Name This Space?", "what would you name this space")).toBe(
      true,
    );
    expect(promptMatches("Describe this place.", "what would you name this space")).toBe(false);
  });

  it("matches prompt fragments written in non-Latin scripts", () => {
    expect(promptMatches("你会给这个空间起什么名字？", "这个空间")).toBe(true);
    expect(promptMatches("ماذا تسمي هذه المساحة؟", "تسمي هذه المساحة")).toBe(true);
  });

  it("accepts the package-manager argument separator", () => {
    expect(
      parseExhibitionReportArgs(["--", "--load-env", "../env", "--time-zone", "America/Vancouver"]),
    ).toMatchObject({
      envFile: "../env",
      timeZone: "America/Vancouver",
    });
  });

  it("uses the live installation prompt by default", () => {
    expect(parseExhibitionReportArgs([]).targetPrompt).toBe(DEFAULT_TRANSCRIPT_PROMPT);
  });

  it("loads an explicit env file without mixing ambient report credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exhibition-report-"));
    const envPath = join(directory, "operator.env");
    try {
      await writeFile(
        envPath,
        "OPERATOR_API_URL=https://operator.example.test\nOPERATOR_COOKIE=file-cookie\n",
      );
      const env = await loadExhibitionReportEnvironment(envPath, {
        OPERATOR_API_URL: "https://other.example.test",
        OPERATOR_TOKEN: "ambient-token",
      });

      expect(env).toEqual({
        OPERATOR_API_URL: "https://operator.example.test",
        OPERATOR_COOKIE: "file-cookie",
      });
      expect(env.OPERATOR_TOKEN).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires HTTPS except for loopback API URLs", () => {
    expect(operatorApiRoot("https://operator.example.test/")).toBe("https://operator.example.test");
    expect(operatorApiRoot("http://localhost:8787/")).toBe("http://localhost:8787");
    expect(operatorApiRoot("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(operatorApiRoot("http://[::1]:8787/")).toBe("http://[::1]:8787");
    expect(() => operatorApiRoot("http://operator.example.test")).toThrow(
      "must use https except for localhost loopback addresses",
    );
    expect(() => operatorApiRoot("https://operator.example.test?tenant=gallery")).toThrow(
      "must not include a query string or fragment",
    );
    expect(() => operatorApiRoot("https://operator.example.test#operator")).toThrow(
      "must not include a query string or fragment",
    );
  });

  it("filters question messages to the selected installation report window", () => {
    const messages = [
      {
        id: "inside",
        installationId: "installation-a",
        createdAt: "2026-08-20T12:00:00.000Z",
      },
      {
        id: "before",
        installationId: "installation-a",
        createdAt: "2026-08-19T23:59:59.999Z",
      },
      {
        id: "after",
        installationId: "installation-a",
        createdAt: "2026-08-21T00:00:00.001Z",
      },
      {
        id: "other-installation",
        installationId: "installation-b",
        createdAt: "2026-08-20T12:00:00.000Z",
      },
      {
        id: "legacy",
        installationId: null,
        createdAt: "2026-08-20T18:00:00.000Z",
      },
    ];

    expect(
      messagesForReport(
        messages,
        "installation-a",
        new Date("2026-08-20T00:00:00.000Z"),
        new Date("2026-08-21T00:00:00.000Z"),
      ).map((message) => message.id),
    ).toEqual(["inside"]);
  });

  it("rejects in-window question messages without installation scope", () => {
    expect(() =>
      messagesForReport(
        [
          {
            id: "missing-installation",
            createdAt: "2026-08-20T12:00:00.000Z",
          },
        ],
        "installation-a",
        new Date("2026-08-20T00:00:00.000Z"),
        new Date("2026-08-21T00:00:00.000Z"),
      ),
    ).toThrow("did not include installationId, so report scoping cannot be verified");
  });

  it("refuses to report when the stats API may have truncated recordings", () => {
    expect(() => assertOverviewMessagesComplete({ allRecordings: 4_999 })).not.toThrow();
    expect(() => assertOverviewMessagesComplete({ allRecordings: 5_000 })).toThrow(
      "can exceed the stats API limit",
    );
    expect(() => assertOverviewMessagesComplete({ allRecordings: undefined })).toThrow(
      "report completeness cannot be verified",
    );
  });

  it("accepts either a raw session value or a complete cookie pair", () => {
    expect(operatorCookieHeader("signed-value")).toBe("__Host-booth_session=signed-value");
    expect(operatorCookieHeader("__Host-booth_session=signed-value")).toBe(
      "__Host-booth_session=signed-value",
    );
    expect(operatorCookieHeader("other=value; __Host-booth_session=signed-value")).toBe(
      "other=value; __Host-booth_session=signed-value",
    );
  });

  it("selects the newest successful transcription", () => {
    const base: Transcription = {
      id: "00000000-0000-4000-8000-000000000001",
      messageId: "00000000-0000-4000-8000-000000000002",
      provider: "on_device",
      model: null,
      status: "succeeded",
      text: "First",
      language: "en",
      durationMs: 1000,
      latencyMs: 20,
      error: null,
      requestedById: null,
      createdAt: "2026-08-20T12:00:00.000Z",
      completedAt: "2026-08-20T12:00:01.000Z",
      translationStatus: null,
      translatedText: null,
      translatedLanguage: null,
      translationProvider: null,
      translationModel: null,
      translationError: null,
      translationLatencyMs: null,
      translationCompletedAt: null,
    };

    expect(
      selectLatestSuccessfulTranscription([
        base,
        {
          ...base,
          id: "00000000-0000-4000-8000-000000000003",
          status: "failed",
          text: null,
          createdAt: "2026-08-22T12:00:00.000Z",
        },
        {
          ...base,
          id: "00000000-0000-4000-8000-000000000004",
          text: "Newest success",
          createdAt: "2026-08-21T12:00:00.000Z",
        },
      ])?.text,
    ).toBe("Newest success");
  });

  it("paginates and renders an active cross-era report with bounded transcription requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exhibition-report-orchestration-"));
    const output = join(directory, "report.html");
    const apiRoot = "https://operator.example.test";
    const fixedNow = new Date("2026-08-20T05:00:00.000Z");
    const installationId = "11111111-1111-4111-8111-111111111111";
    const currentQuestionId = "22222222-2222-4222-8222-222222222222";
    const unrelatedQuestionId = "33333333-3333-4333-8333-333333333333";
    const rolloverQuestionId = "44444444-4444-4444-8444-444444444444";
    const afterCutoffMessageId = "55555555-5555-4555-8555-555555555555";
    const embeddedMessageId = "66666666-6666-4666-8666-666666666666";
    const noTranscriptMessageId = "77777777-7777-4777-8777-777777777777";
    const failedMessageId = "88888888-8888-4888-8888-888888888888";
    const rolloverMessageId = "99999999-9999-4999-8999-999999999999";
    const unrelatedMessageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const audio = {
      url: `${apiRoot}/audio/test.flac`,
      sha256: "a".repeat(64),
      durationMs: 1_000,
    };
    const transcription = (
      id: string,
      messageId: string,
      status: Transcription["status"],
      text: string | null,
      createdAt: string,
    ): Transcription => ({
      id,
      messageId,
      provider: "on_device",
      model: null,
      status,
      text,
      language: "en",
      durationMs: 1_000,
      latencyMs: 20,
      error: status === "failed" ? "provider failed" : null,
      requestedById: null,
      createdAt,
      completedAt: status === "pending" ? null : createdAt,
      translationStatus: null,
      translatedText: null,
      translatedLanguage: null,
      translationProvider: null,
      translationModel: null,
      translationError: null,
      translationLatencyMs: null,
      translationCompletedAt: null,
    });
    const embeddedTranscription = transcription(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      embeddedMessageId,
      "succeeded",
      "Embedded success",
      "2026-08-20T04:51:00.000Z",
    );
    const failedTranscription = transcription(
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      failedMessageId,
      "failed",
      null,
      "2026-08-20T04:31:00.000Z",
    );
    const recoveredTranscription = transcription(
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      failedMessageId,
      "succeeded",
      "Recovered success",
      "2026-08-20T04:30:30.000Z",
    );
    const rolloverTranscription = transcription(
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      rolloverMessageId,
      "succeeded",
      "Cross-era success",
      "2026-08-20T04:21:00.000Z",
    );
    const overview: StatsOverview = {
      window: "custom",
      rangeStart: "2026-08-20T04:00:00.000Z",
      rangeEnd: fixedNow.toISOString(),
      generatedAt: fixedNow.toISOString(),
      timezone: "UTC",
      interactions: {
        total: 5,
        inProgressNow: 0,
        noSelection: 1,
        messagesLeft: 4,
        averageDurationMs: 10_000,
        longestDurationMs: 20_000,
        outcomes: { recording_completed: 4 },
        perDay: [],
      },
      calls: {
        total: 5,
        completed: 5,
        inProgress: 0,
        averageDurationMs: 10_000,
        longestDurationMs: 20_000,
        outcomes: { recording_completed: 4 },
        perDay: [],
      },
      messages: {
        total: 3,
        approved: 3,
        allRecordings: 4,
        byStatus: { approved: 3, pending: 1 },
        averageDurationMs: 1_000,
      },
      playback: { totalPlaybacks: 2 },
      actions: {
        digitsDialed: {},
        leaveMessageSelections: 4,
        listenMessageSelections: 2,
        instructionSelections: 0,
        wrongNumberAttempts: 0,
        messagePlaybackStarts: 2,
        instructionPlaybackStarts: 0,
      },
      pickupsHangups: { pickups: 5, hangups: 5, digitsDialed: {} },
      uploads: { succeeded: 4, failed: 0, failureRate: 0 },
      topQuestions: [],
      hourly: [],
      busiest: { hour: 0, dayOfWeek: 4 },
      lastActivityAt: "2026-08-20T04:50:00.000Z",
      boothBreakdown: [],
    };
    const currentQuestion = {
      id: currentQuestionId,
      prompt: DEFAULT_TRANSCRIPT_PROMPT,
      status: "active",
      weight: 1,
      messageCount: 4,
      createdAt: "2026-08-20T04:00:00.000Z",
      audio,
    };
    const unrelatedQuestion = {
      id: unrelatedQuestionId,
      prompt: "Describe an unrelated installation.",
      status: "archived",
      weight: 1,
      messageCount: 1,
      createdAt: "2026-08-01T04:00:00.000Z",
      audio,
    };
    const rolloverQuestion = {
      id: rolloverQuestionId,
      prompt: `${DEFAULT_TRANSCRIPT_PROMPT} Please be specific.`,
      status: "archived",
      weight: 1,
      messageCount: 1,
      createdAt: "2026-08-01T04:00:00.000Z",
      audio,
    };
    const message = (
      id: string,
      questionId: string,
      installation: string,
      createdAt: string,
      latestTranscription?: Transcription | null,
    ) => ({
      id,
      status: "approved",
      installationId: installation,
      questionId,
      createdAt,
      audio,
      ...(latestTranscription !== undefined ? { latestTranscription } : {}),
    });
    const requests: string[] = [];
    const responseFor = (path: string): unknown => {
      const url = new URL(path, apiRoot);
      if (url.pathname === "/v1/installations/current") {
        return {
          id: installationId,
          name: "Orchestration Test",
          notes: null,
          location: "Test Gallery",
          startedAt: "2026-08-20T04:00:00.000Z",
          endedAt: null,
          endedById: null,
          summary: null,
          createdAt: "2026-08-20T04:00:00.000Z",
          isActive: true,
        };
      }
      if (url.pathname === "/v1/stats/overview") return overview;
      if (url.pathname === "/v1/questions") {
        const scope = url.searchParams.get("installationId");
        const cursor = url.searchParams.get("cursor");
        if (scope === installationId) {
          return { items: [currentQuestion], nextCursor: null };
        }
        if (scope === "all" && cursor === null) {
          return {
            items: [currentQuestion, unrelatedQuestion],
            nextCursor: "question-page-2",
          };
        }
        if (scope === "all" && cursor === "question-page-2") {
          return { items: [rolloverQuestion], nextCursor: null };
        }
      }
      if (url.pathname === `/v1/questions/${currentQuestionId}/messages`) {
        if (url.searchParams.get("cursor") === null) {
          return {
            items: [
              message(
                afterCutoffMessageId,
                currentQuestionId,
                installationId,
                "2026-08-20T05:00:00.001Z",
                transcription(
                  "ffffffff-ffff-4fff-8fff-ffffffffffff",
                  afterCutoffMessageId,
                  "succeeded",
                  "After cutoff",
                  "2026-08-20T05:00:01.000Z",
                ),
              ),
              message(
                embeddedMessageId,
                currentQuestionId,
                installationId,
                "2026-08-20T04:50:00.000Z",
                embeddedTranscription,
              ),
            ],
            nextCursor: "current-message-page-2",
          };
        }
        return {
          items: [
            message(
              noTranscriptMessageId,
              currentQuestionId,
              installationId,
              "2026-08-20T04:40:00.000Z",
              null,
            ),
            message(
              failedMessageId,
              currentQuestionId,
              installationId,
              "2026-08-20T04:30:00.000Z",
              failedTranscription,
            ),
          ],
          nextCursor: null,
        };
      }
      if (url.pathname === `/v1/questions/${unrelatedQuestionId}/messages`) {
        return {
          items: [
            message(
              unrelatedMessageId,
              unrelatedQuestionId,
              "abababab-abab-4bab-8bab-abababababab",
              "2026-08-20T04:25:00.000Z",
              null,
            ),
          ],
          nextCursor: null,
        };
      }
      if (url.pathname === `/v1/questions/${rolloverQuestionId}/messages`) {
        return {
          items: [
            message(
              rolloverMessageId,
              rolloverQuestionId,
              installationId,
              "2026-08-20T04:20:00.000Z",
            ),
          ],
          nextCursor: null,
        };
      }
      if (url.pathname === `/v1/messages/${failedMessageId}/transcriptions`) {
        return { items: [failedTranscription, recoveredTranscription] };
      }
      if (url.pathname === `/v1/messages/${rolloverMessageId}/transcriptions`) {
        return { items: [rolloverTranscription] };
      }
      throw new Error(`Unexpected report request: ${url.pathname}${url.search}`);
    };
    const client: ApiClient = {
      get: (path, schema) => {
        requests.push(path);
        return Promise.resolve(schema.parse(responseFor(path)));
      },
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await writeFile(output, "stale report", { mode: 0o644 });
      await chmod(output, 0o644);
      await expect(
        generateExhibitionReport(
          {
            envFile: null,
            output,
            installation: "active",
            timeZone: "America/Toronto",
            targetPrompt: DEFAULT_TRANSCRIPT_PROMPT,
            title: "Orchestration report",
            help: false,
          },
          { OPERATOR_API_URL: apiRoot },
          { client, now: () => fixedNow },
        ),
      ).resolves.toBe(output);

      const html = await readFile(output, "utf8");
      expect(html).toContain("Orchestration report");
      expect(html).toContain("Embedded success");
      expect(html).toContain("Recovered success");
      expect(html).toContain("Cross-era success");
      expect(html).toContain("No successful transcription is available");
      expect(html).not.toContain("After cutoff");
      expect(html).not.toContain("Describe an unrelated installation.");
      expect((await stat(output)).mode & 0o777).toBe(0o600);

      const requestUrls = requests.map((path) => new URL(path, apiRoot));
      const overviewRequests = requestUrls.filter((url) => url.pathname === "/v1/stats/overview");
      expect(overviewRequests).toHaveLength(2);
      expect(
        overviewRequests.every((url) => url.searchParams.get("end") === fixedNow.toISOString()),
      ).toBe(true);
      expect(
        requestUrls.some(
          (url) =>
            url.pathname === "/v1/questions" &&
            url.searchParams.get("cursor") === "question-page-2",
        ),
      ).toBe(true);
      expect(
        requestUrls.some(
          (url) =>
            url.pathname === `/v1/questions/${currentQuestionId}/messages` &&
            url.searchParams.get("cursor") === "current-message-page-2",
        ),
      ).toBe(true);
      expect(
        requestUrls
          .filter((url) => /^\/v1\/messages\/[^/]+\/transcriptions$/.test(url.pathname))
          .map((url) => url.pathname)
          .sort(),
      ).toEqual(
        [
          `/v1/messages/${failedMessageId}/transcriptions`,
          `/v1/messages/${rolloverMessageId}/transcriptions`,
        ].sort(),
      );
    } finally {
      log.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("renders escaped report content and printable controls", () => {
    const report: ExhibitionReportData = {
      title: "Exhibition <Report>",
      installationName: "Summer & Fall",
      location: "Gallery",
      installationStartedAt: "2026-08-20T14:00:00.000Z",
      installationEndedAt: null,
      generatedAt: "2026-08-21T14:00:00.000Z",
      timeZone: "America/Toronto",
      sourceHost: "operator.example.test",
      targetPrompt: "what would you name this space",
      matchedPrompts: ["What would you name this space?"],
      totals: {
        interactions: 10,
        messagesLeft: 4,
        messagesApproved: 3,
        messagesListenedTo: 2,
      },
      days: [
        {
          date: "2026-08-20",
          counts: {
            interactions: 10,
            messagesLeft: 4,
            messagesApproved: 3,
            messagesListenedTo: 2,
          },
        },
      ],
      questions: [
        {
          questionId: "00000000-0000-4000-8000-000000000005",
          prompt: "Question <one>?",
          status: "active",
          answers: 4,
          approvedAnswers: 3,
        },
      ],
      transcripts: [
        {
          messageId: "00000000-0000-4000-8000-000000000006",
          prompt: "What would you name this space?",
          recordedAt: "2026-08-20T15:00:00.000Z",
          messageStatus: "approved",
          text: "<script>alert('no')</script>",
        },
      ],
    };

    const html = renderExhibitionReportHtml(report);
    expect(html).toContain("Exhibition &lt;Report&gt;");
    expect(html).toContain("&lt;script&gt;alert(&#39;no&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("Print / Save PDF");
    expect(html).toContain('class="hero-booth"');
    expect(html).toContain('class="hero-booth-sign"');
    expect(html).toContain(">TELEPHONE</text>");
    expect(html).toContain('stroke-linecap="round"');
    expect(html).not.toContain(".hero::after");
    expect(html).toContain("--red: rgb(210 15 57)");
    expect(html).toContain("--red-strong: rgb(179 19 47)");
    expect(html).toContain('local("Univers Bold")');
    expect(html).toContain('local("Univers Condensed")');
    expect(html).toContain("<h2>Selected answer transcriptions</h2>");
    expect(html).not.toContain("<h2>Name this space</h2>");
  });
});
