import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoothEventListSchema,
  CallSessionListSchema,
  InstallationSchema,
  MessageSchema,
  QuestionSchema,
  StatsOverviewSchema,
  TranscriptionListSchema,
  type Message,
  type Question,
  type StatsOverview,
  type Transcription,
} from "@telephone-booth-operator/shared";
import { parse as parseEnvFile } from "dotenv";
import { z } from "zod";
import {
  activityTimeHighlights,
  approvedMessageDurationFacts,
  busiestExhibitionDay,
  buildLocalDayRanges,
  countsByLocalDay,
  countsFromOverview,
  exhibitionEmailHighlightLines,
  messagePlaybackFacts,
  promptMatches,
  renderExhibitionReportHtml,
  selectLatestSuccessfulTranscription,
  type ExhibitionQuestion,
  type ExhibitionReportData,
  type ExhibitionTranscript,
} from "../src/lib/exhibition-report.js";
import { DEFAULT_TIME_ZONE, dateKeyInTimeZone, isValidTimeZone } from "../src/lib/time-zone.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PAGE_LIMIT = 200;
const OBSERVABILITY_PAGE_LIMIT = 500;
const API_TIMEOUT_MS = 30_000;
const OVERVIEW_MESSAGE_LIMIT = 5_000;
export const DEFAULT_TRANSCRIPT_PROMPT = "What name would you give this space as it exists now?";
export const DEFAULT_FUTURE_TRANSCRIPT_PROMPT =
  "Week 4 - What do you hope the future holds for this space?";
export const DEFAULT_TRANSCRIPT_PROMPTS = [
  DEFAULT_TRANSCRIPT_PROMPT,
  DEFAULT_FUTURE_TRANSCRIPT_PROMPT,
] as const;

const QuestionPageSchema = z.object({
  items: z.array(QuestionSchema),
  nextCursor: z.string().nullable(),
});

const MessagePageSchema = z.object({
  items: z.array(MessageSchema),
  nextCursor: z.string().nullable(),
});

type QuestionPage = z.infer<typeof QuestionPageSchema>;
type MessagePage = z.infer<typeof MessagePageSchema>;

type CliOptions = {
  envFile: string | null;
  output: string | null;
  installation: string;
  timeZone: string;
  targetPrompts: string[];
  title: string | null;
  help: boolean;
};

type QuestionWithMessages = {
  question: Question;
  messages: Message[];
};

export type ApiClient = {
  get: <T>(path: string, schema: z.ZodType<T>) => Promise<T>;
};

type ExhibitionReportDependencies = {
  client?: ApiClient;
};

const help = `Usage: pnpm --filter @telephone-booth-operator/api run report:exhibition -- [options]

Environment:
  OPERATOR_API_URL   Operator API base URL
                     Falls back to PUBLIC_API_URL or BOOTH_OPERATOR_BASE_URL
  OPERATOR_TOKEN     OIDC operator bearer token
  OPERATOR_COOKIE    Raw authenticated Cookie header; used when no token is set

Options:
  --load-env <path>             Use report variables from an env file
  --installation <active|uuid>  Installation to report (default: active)
  --time-zone <iana-zone>       Calendar time zone (default: America/Toronto)
  --transcript-question <text>  Prompt fragment for the transcript section;
                                repeat to include multiple questions
  --title <text>                Report title
  --output <path>               Output HTML path, relative to the repository root
  --help                        Show this help
`;

const valueAfter = (argv: readonly string[], index: number, option: string): string => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
};

export const parseExhibitionReportArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    envFile: null,
    output: null,
    installation: "active",
    timeZone: DEFAULT_TIME_ZONE,
    targetPrompts: [],
    title: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    switch (option) {
      case "--load-env":
        options.envFile = valueAfter(argv, index, option);
        index += 1;
        break;
      case "--output":
        options.output = valueAfter(argv, index, option);
        index += 1;
        break;
      case "--installation":
        options.installation = valueAfter(argv, index, option);
        index += 1;
        break;
      case "--time-zone":
        options.timeZone = valueAfter(argv, index, option);
        index += 1;
        break;
      case "--transcript-question":
        options.targetPrompts.push(valueAfter(argv, index, option));
        index += 1;
        break;
      case "--title":
        options.title = valueAfter(argv, index, option);
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--":
        break;
      default:
        throw new Error(`Unknown option: ${option ?? ""}.`);
    }
  }

  if (
    options.installation !== "active" &&
    !z.string().guid().safeParse(options.installation).success
  ) {
    throw new Error("--installation must be 'active' or an installation UUID.");
  }
  if (!isValidTimeZone(options.timeZone)) {
    throw new Error(`Invalid IANA time zone: ${options.timeZone}.`);
  }
  if (options.targetPrompts.some((targetPrompt) => targetPrompt.trim().length === 0)) {
    throw new Error("--transcript-question cannot be empty.");
  }
  if (options.targetPrompts.length === 0) {
    options.targetPrompts = [...DEFAULT_TRANSCRIPT_PROMPTS];
  }
  return options;
};

const safeHeader = (name: string, value: string): string => {
  if (/[\r\n]/.test(value)) throw new Error(`${name} contains an invalid newline.`);
  return value;
};

export const loadExhibitionReportEnvironment = async (
  envFile: string | null,
  fallbackEnv: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> => {
  if (!envFile) return fallbackEnv;
  const envPath = isAbsolute(envFile) ? envFile : resolve(REPOSITORY_ROOT, envFile);
  try {
    return parseEnvFile(await readFile(envPath));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load env file ${envPath}: ${detail}`, { cause: error });
  }
};

export const operatorCookieHeader = (raw: string): string => {
  const cookie = raw.trim();
  if (cookie.length === 0) throw new Error("OPERATOR_COOKIE cannot be empty.");
  if (/(?:^|;\s*)(?:__Host-booth_session|booth_session)=/.test(cookie)) {
    return cookie;
  }
  return `__Host-booth_session=${cookie}`;
};

export const operatorApiRoot = (baseUrl: string): string => {
  const parsedBase = new URL(baseUrl);
  if (parsedBase.protocol !== "https:" && parsedBase.protocol !== "http:") {
    throw new Error("OPERATOR_API_URL must use http or https.");
  }
  if (parsedBase.search.length > 0 || parsedBase.hash.length > 0) {
    throw new Error("OPERATOR_API_URL must not include a query string or fragment.");
  }
  const hostname = parsedBase.hostname.toLowerCase();
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  if (parsedBase.protocol === "http:" && !isLoopback) {
    throw new Error("OPERATOR_API_URL must use https except for localhost loopback addresses.");
  }
  return parsedBase.toString().replace(/\/+$/, "");
};

const createApiClient = (root: string, token: string | undefined, cookie: string | undefined) => {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) {
    const value = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
    headers.authorization = safeHeader("OPERATOR_TOKEN", value);
  } else if (cookie) {
    headers.cookie = safeHeader("OPERATOR_COOKIE", operatorCookieHeader(cookie));
  } else {
    throw new Error("Set OPERATOR_TOKEN or OPERATOR_COOKIE for an authenticated operator.");
  }

  const get = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
    const response = await fetch(`${root}${path}`, {
      headers,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = text.trim().slice(0, 500);
      throw new Error(`GET ${path} failed with ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`GET ${path} returned invalid JSON.`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new Error(`GET ${path} returned an unexpected response: ${parsed.error.message}`);
    }
    return parsed.data;
  };

  return { get } satisfies ApiClient;
};

const queryPath = (
  path: string,
  values: Record<string, string | number | null | undefined>,
): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
};

const fetchQuestions = async (client: ApiClient, installationId: string): Promise<Question[]> => {
  const questions: Question[] = [];
  let cursor: string | null = null;
  do {
    const page: QuestionPage = await client.get(
      queryPath("/v1/questions", {
        installationId,
        status: "any",
        limit: PAGE_LIMIT,
        cursor,
      }),
      QuestionPageSchema,
    );
    questions.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return questions;
};

const fetchQuestionMessages = async (
  client: ApiClient,
  questionId: string,
  installationId: string,
  start: Date,
  end: Date,
): Promise<Message[]> => {
  const messages: Message[] = [];
  let cursor: string | null = null;
  do {
    const page: MessagePage = await client.get(
      queryPath(`/v1/questions/${encodeURIComponent(questionId)}/messages`, {
        limit: PAGE_LIMIT,
        cursor,
      }),
      MessagePageSchema,
    );
    messages.push(...messagesForReport(page.items, installationId, start, end));
    const oldest = page.items.at(-1);
    if (!oldest || new Date(oldest.createdAt).getTime() < start.getTime()) break;
    cursor = page.nextCursor;
  } while (cursor !== null);
  return messages;
};

const mapInBatches = async <T, R>(
  values: readonly T[],
  batchSize: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = [];
  for (let index = 0; index < values.length; index += batchSize) {
    const batch = values.slice(index, index + batchSize);
    results.push(...(await Promise.all(batch.map(worker))));
  }
  return results;
};

const fetchOverview = (client: ApiClient, installationId: string, start: Date, end: Date | "now") =>
  client.get(
    queryPath("/v1/stats/overview", {
      installationId,
      start: start.toISOString(),
      end: end === "now" ? end : end.toISOString(),
    }),
    StatsOverviewSchema,
  );

const fetchCallSessions = async (
  client: ApiClient,
  installationId: string,
  start: Date,
  end: Date,
): Promise<z.infer<typeof CallSessionListSchema>["items"]> => {
  const sessions: z.infer<typeof CallSessionListSchema>["items"] = [];
  let cursor: string | null = null;
  do {
    const page: z.infer<typeof CallSessionListSchema> = await client.get(
      queryPath("/v1/sessions", {
        installationId,
        limit: OBSERVABILITY_PAGE_LIMIT,
        cursor,
      }),
      CallSessionListSchema,
    );
    for (const session of page.items) {
      const startedAt = new Date(session.startedAt).getTime();
      if (!Number.isFinite(startedAt)) {
        throw new Error(`Session ${session.id} has an invalid startedAt value.`);
      }
      if (startedAt >= start.getTime() && startedAt <= end.getTime()) sessions.push(session);
    }
    const oldest = page.items.at(-1);
    if (oldest && new Date(oldest.startedAt).getTime() < start.getTime()) break;
    cursor = page.nextCursor;
  } while (cursor !== null);
  return sessions;
};

const fetchStateTransitionEvents = async (
  client: ApiClient,
  installationId: string,
  start: Date,
  end: Date,
): Promise<z.infer<typeof BoothEventListSchema>["items"]> => {
  const events: z.infer<typeof BoothEventListSchema>["items"] = [];
  let cursor: string | null = null;
  do {
    const page: z.infer<typeof BoothEventListSchema> = await client.get(
      queryPath("/v1/events", {
        installationId,
        type: "state_transition",
        since: start.toISOString(),
        until: end.toISOString(),
        limit: OBSERVABILITY_PAGE_LIMIT,
        cursor,
      }),
      BoothEventListSchema,
    );
    events.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return events;
};

const slugify = (value: string): string => {
  const slug = value
    .toLocaleLowerCase("en-CA")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "exhibition";
};

const outputPathFor = (
  configured: string | null,
  installationName: string,
  reportDate: string,
): string => {
  const requested = configured ?? `reports/${slugify(installationName)}-report-${reportDate}.html`;
  return isAbsolute(requested) ? requested : resolve(REPOSITORY_ROOT, requested);
};

export const messagesForReport = <T extends Pick<Message, "id" | "createdAt" | "installationId">>(
  messages: readonly T[],
  installationId: string,
  start: Date,
  end: Date,
): T[] =>
  messages.filter((message) => {
    const createdAt = new Date(message.createdAt).getTime();
    if (!Number.isFinite(createdAt)) {
      throw new Error(`Message has an invalid createdAt value: ${message.createdAt}.`);
    }
    if (createdAt < start.getTime() || createdAt > end.getTime()) return false;
    if (message.installationId === undefined) {
      throw new Error(
        `Message ${message.id} did not include installationId, so report scoping cannot be verified.`,
      );
    }
    return message.installationId === installationId;
  });

export const assertOverviewMessagesComplete = (
  messages: Pick<StatsOverview["messages"], "allRecordings">,
): void => {
  if (messages.allRecordings === undefined) {
    throw new Error(
      "The stats API did not return messages.allRecordings, so report completeness cannot be verified.",
    );
  }
  if (messages.allRecordings >= OVERVIEW_MESSAGE_LIMIT) {
    throw new Error(
      `The selected report window contains at least ${OVERVIEW_MESSAGE_LIMIT.toLocaleString("en-CA")} recordings, which can exceed the stats API limit. Narrow the report window or add an uncapped reporting API before generating this report.`,
    );
  }
};

const buildQuestionReports = (rows: readonly QuestionWithMessages[]): ExhibitionQuestion[] =>
  rows
    .map(({ question, messages }) => {
      const answers = messages.filter((message) => message.status !== "uploading");
      return {
        questionId: question.id,
        prompt: question.prompt,
        status: question.status,
        answers: answers.length,
        approvedAnswers: answers.filter((message) => message.status === "approved").length,
      };
    })
    .sort(
      (left, right) =>
        right.answers - left.answers ||
        left.prompt.localeCompare(right.prompt, "en-CA", { sensitivity: "base" }),
    );

const buildTranscripts = async (
  client: ApiClient,
  rows: readonly QuestionWithMessages[],
  targetPrompts: readonly string[],
): Promise<ExhibitionTranscript[]> => {
  const targetMessages = rows.flatMap(({ question, messages }) =>
    targetPrompts.some((targetPrompt) => promptMatches(question.prompt, targetPrompt))
      ? messages
          .filter((message) => message.status !== "uploading")
          .map((message) => ({ question, message }))
      : [],
  );

  const transcripts = await mapInBatches(targetMessages, 6, async ({ question, message }) => {
    const embedded = message.latestTranscription;
    let transcription: Transcription | null;
    if (embedded === null || embedded?.status === "succeeded") {
      transcription = embedded;
    } else {
      const history = await client.get(
        `/v1/messages/${encodeURIComponent(message.id)}/transcriptions`,
        TranscriptionListSchema,
      );
      transcription = selectLatestSuccessfulTranscription(history.items);
    }
    const operatorReason = message.notes?.trim();
    const moderation = message.latestModeration;
    const moderationReason =
      transcription !== null &&
      moderation?.status === "succeeded" &&
      moderation.transcriptionId === transcription.id &&
      moderation.reasonSummary?.trim()
        ? moderation.reasonSummary.trim()
        : null;
    return {
      messageId: message.id,
      prompt: question.prompt,
      recordedAt: message.receivedAt ?? message.createdAt,
      messageStatus: message.status,
      text: transcription?.text ?? null,
      nonApprovalReason:
        message.status === "approved" ? null : operatorReason || moderationReason || null,
    } satisfies ExhibitionTranscript;
  });

  return transcripts.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
};

export const generateExhibitionReport = async (
  options: CliOptions,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ExhibitionReportDependencies = {},
): Promise<string> => {
  const baseUrl = (
    env.OPERATOR_API_URL ??
    env.BOOTH_OPERATOR_BASE_URL ??
    env.PUBLIC_API_URL
  )?.trim();
  if (!baseUrl) {
    throw new Error("Set OPERATOR_API_URL, PUBLIC_API_URL, or BOOTH_OPERATOR_BASE_URL.");
  }
  const root = operatorApiRoot(baseUrl);
  const client =
    dependencies.client ?? createApiClient(root, env.OPERATOR_TOKEN, env.OPERATOR_COOKIE);
  const installation =
    options.installation === "active"
      ? await client.get("/v1/installations/current", InstallationSchema)
      : await client.get(
          `/v1/installations/${encodeURIComponent(options.installation)}`,
          InstallationSchema,
        );

  const installationStart = new Date(installation.startedAt);
  const requestedEnd = installation.endedAt ? new Date(installation.endedAt) : "now";
  const totalOverview = await fetchOverview(
    client,
    installation.id,
    installationStart,
    requestedEnd,
  );
  assertOverviewMessagesComplete(totalOverview.messages);
  const reportEnd = new Date(totalOverview.rangeEnd);
  const dayRanges = buildLocalDayRanges(installationStart, reportEnd, options.timeZone);

  const [dailyOverviews, scopedQuestions, allQuestions, sessions, stateTransitionEvents] =
    await Promise.all([
      mapInBatches(dayRanges, 4, (range) =>
        fetchOverview(client, installation.id, range.start, range.end),
      ),
      fetchQuestions(client, installation.id),
      fetchQuestions(client, "all"),
      fetchCallSessions(client, installation.id, installationStart, reportEnd),
      fetchStateTransitionEvents(client, installation.id, installationStart, reportEnd),
    ]);

  const scopedQuestionIds = new Set(scopedQuestions.map((question) => question.id));
  const questions = [
    ...new Map(
      [...scopedQuestions, ...allQuestions].map((question) => [question.id, question]),
    ).values(),
  ];
  const questionsAtCutoff = questions.filter(
    (question) => new Date(question.createdAt).getTime() <= reportEnd.getTime(),
  );

  const questionsWithMessages = (
    await mapInBatches(questionsAtCutoff, 4, async (question) => {
      const messages =
        question.messageCount === 0
          ? []
          : await fetchQuestionMessages(
              client,
              question.id,
              installation.id,
              installationStart,
              reportEnd,
            );
      return { question, messages };
    })
  ).filter(({ question, messages }) => scopedQuestionIds.has(question.id) || messages.length > 0);
  const questionReports = buildQuestionReports(questionsWithMessages);
  const transcripts = await buildTranscripts(client, questionsWithMessages, options.targetPrompts);
  const reportMessages = [
    ...new Map(
      questionsWithMessages
        .flatMap(({ messages }) => messages)
        .map((message) => [message.id, message]),
    ).values(),
  ];
  const approvedQuestionMessageCount = questionReports.reduce(
    (total, question) => total + question.approvedAnswers,
    0,
  );
  const durationFacts = approvedMessageDurationFacts(reportMessages, approvedQuestionMessageCount);
  const playbackFacts = messagePlaybackFacts(
    stateTransitionEvents,
    totalOverview.playback.totalPlaybacks,
    sessions,
  );
  const pickupHours = activityTimeHighlights(
    sessions.map((session) => session.startedAt),
    options.timeZone,
    totalOverview.interactions.total,
    "interactions",
  );
  const messageLeavingHours = activityTimeHighlights(
    sessions
      .filter((session) => session.outcome === "recording_completed")
      .map((session) => session.startedAt),
    options.timeZone,
    totalOverview.interactions.messagesLeft,
    "message-leaving interactions",
  );
  const messageListeningHours = activityTimeHighlights(
    playbackFacts.playbackOccurredAts,
    options.timeZone,
    totalOverview.playback.totalPlaybacks,
    "message playbacks",
  );
  const days = countsByLocalDay(dayRanges, dailyOverviews);
  const mostAnsweredQuestion = questionReports.find((question) => question.answers > 0) ?? null;
  const matchedPrompts = [
    ...new Set(
      questionsWithMessages
        .filter(({ question }) =>
          options.targetPrompts.some((targetPrompt) =>
            promptMatches(question.prompt, targetPrompt),
          ),
        )
        .map(({ question }) => question.prompt),
    ),
  ].sort((left, right) => {
    const rank = (prompt: string): number => {
      const index = options.targetPrompts.findIndex((targetPrompt) =>
        promptMatches(prompt, targetPrompt),
      );
      return index === -1 ? options.targetPrompts.length : index;
    };
    return rank(left) - rank(right) || left.localeCompare(right, "en-CA", { sensitivity: "base" });
  });
  const sourceHost = new URL(root).host;
  const report: ExhibitionReportData = {
    title: options.title ?? `${installation.name} Exhibition Report`,
    installationName: installation.name,
    location: installation.location,
    installationStartedAt: installation.startedAt,
    installationEndedAt: installation.endedAt,
    reportCutoffAt: reportEnd.toISOString(),
    generatedAt: totalOverview.generatedAt,
    timeZone: options.timeZone,
    sourceHost,
    targetPrompts: options.targetPrompts,
    matchedPrompts,
    totals: countsFromOverview(totalOverview),
    funFacts: {
      approvedQuestionMessageCount,
      averageApprovedMessageDurationMs: durationFacts.averageDurationMs,
      longestApprovedMessageDurationMs: durationFacts.longestDurationMs,
      maxMessagePlaybacksInInteraction: playbackFacts.maxMessagePlaybacksInInteraction,
    },
    emailHighlights: {
      pickupHours,
      messageLeavingHours,
      messageListeningHours,
      busiestDay: busiestExhibitionDay(days),
      approvedAudioDurationMs: durationFacts.totalDurationMs,
      listeningInteractions: playbackFacts.listeningInteractions,
      repeatListeningInteractions: playbackFacts.repeatListeningInteractions,
      mostAnsweredQuestion: mostAnsweredQuestion
        ? { prompt: mostAnsweredQuestion.prompt, answers: mostAnsweredQuestion.answers }
        : null,
    },
    days,
    questions: questionReports,
    transcripts,
  };
  const outputPath = outputPathFor(
    options.output,
    installation.name,
    dateKeyInTimeZone(reportEnd, options.timeZone),
  );
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const outputFile = await open(outputPath, "a", 0o600);
  try {
    await outputFile.chmod(0o600);
    await outputFile.truncate(0);
    await outputFile.writeFile(renderExhibitionReportHtml(report), "utf8");
  } finally {
    await outputFile.close();
  }

  // oxlint-disable-next-line no-console
  console.log(`Wrote exhibition report to ${outputPath}`);
  // oxlint-disable-next-line no-console
  console.log(
    `Interactions ${report.totals.interactions}; messages left ${report.totals.messagesLeft}; approved ${report.totals.messagesApproved}; listened to ${report.totals.messagesListenedTo}.`,
  );
  if (matchedPrompts.length > 0) {
    // oxlint-disable-next-line no-console
    console.log(`Transcript prompt: ${matchedPrompts.join(" | ")}`);
  } else {
    // oxlint-disable-next-line no-console
    console.warn(
      `No question matched the configured transcript prompts: ${options.targetPrompts.join(" | ")}.`,
    );
  }
  // oxlint-disable-next-line no-console
  console.log("Email highlights:");
  for (const line of exhibitionEmailHighlightLines(report)) {
    // oxlint-disable-next-line no-console
    console.log(`- ${line}`);
  }
  return outputPath;
};

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseExhibitionReportArgs(argv);
  if (options.help) {
    // oxlint-disable-next-line no-console
    console.log(help);
    return;
  }
  const env = await loadExhibitionReportEnvironment(options.envFile);
  await generateExhibitionReport(options, env);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    // oxlint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
