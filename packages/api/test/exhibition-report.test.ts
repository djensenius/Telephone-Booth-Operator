import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { Transcription } from "@telephone-booth-operator/shared";
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
  loadExhibitionReportEnvironment,
  messagesForReport,
  operatorApiRoot,
  operatorCookieHeader,
  parseExhibitionReportArgs,
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
