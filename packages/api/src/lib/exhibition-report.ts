import type {
  MessageStatus,
  QuestionStatus,
  Transcription,
} from "@telephone-booth-operator/shared";
import { dateKeysInUtcRange, rangesForDateInTimeZone } from "./time-zone.js";

export type ExhibitionMetricCounts = {
  interactions: number;
  messagesLeft: number;
  messagesApproved: number;
  messagesListenedTo: number;
};

export type ExhibitionDay = {
  date: string;
  counts: ExhibitionMetricCounts;
};

export type ExhibitionQuestion = {
  questionId: string;
  prompt: string;
  status: QuestionStatus;
  answers: number;
  approvedAnswers: number;
};

export type ExhibitionTranscript = {
  messageId: string;
  prompt: string;
  recordedAt: string;
  messageStatus: MessageStatus;
  text: string | null;
};

export type ExhibitionReportData = {
  title: string;
  installationName: string;
  location: string | null;
  installationStartedAt: string;
  installationEndedAt: string | null;
  reportCutoffAt: string;
  generatedAt: string;
  timeZone: string;
  sourceHost: string;
  targetPrompt: string;
  matchedPrompts: string[];
  totals: ExhibitionMetricCounts;
  days: ExhibitionDay[];
  questions: ExhibitionQuestion[];
  transcripts: ExhibitionTranscript[];
};

export type OverviewMetricSource = {
  interactions: {
    total: number;
    messagesLeft: number;
  };
  messages: {
    total: number;
    approved?: number | undefined;
  };
  playback: {
    totalPlaybacks: number;
  };
};

export type LocalDayRange = {
  date: string;
  start: Date;
  end: Date;
};

const numberFormat = new Intl.NumberFormat("en-CA");

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const parseDateKey = (date: string): { year: number; month: number; day: number } => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Invalid date key: ${date}.`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
};

const formatDateKey = (date: string): string => {
  const parts = parseDateKey(date);
  const noon = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "full",
    timeZone: "UTC",
  }).format(noon);
};

const formatInstant = (value: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone,
  }).format(new Date(value));

const humanStatus = (status: string): string =>
  status
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");

const metricCard = (label: string, value: number, detail: string): string => `
  <article class="metric-card">
    <p class="metric-label">${escapeHtml(label)}</p>
    <p class="metric-value">${numberFormat.format(value)}</p>
    <p class="metric-detail">${escapeHtml(detail)}</p>
  </article>`;

const normalizePrompt = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("en-CA")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();

export const promptMatches = (prompt: string, target: string): boolean => {
  const normalizedPrompt = normalizePrompt(prompt);
  const normalizedTarget = normalizePrompt(target);
  return normalizedTarget.length > 0 && normalizedPrompt.includes(normalizedTarget);
};

export const countsFromOverview = (overview: OverviewMetricSource): ExhibitionMetricCounts => ({
  interactions: overview.interactions.total,
  messagesLeft: overview.interactions.messagesLeft,
  messagesApproved: overview.messages.approved ?? overview.messages.total,
  messagesListenedTo: overview.playback.totalPlaybacks,
});

export const countsByLocalDay = (
  ranges: readonly LocalDayRange[],
  overviews: readonly OverviewMetricSource[],
): ExhibitionDay[] => {
  if (ranges.length !== overviews.length) {
    throw new Error("Daily ranges and overview results must have the same length.");
  }
  const countsByDate = new Map<string, ExhibitionMetricCounts>();
  for (const [index, range] of ranges.entries()) {
    const counts = countsFromOverview(overviews[index]!);
    const existing = countsByDate.get(range.date) ?? {
      interactions: 0,
      messagesLeft: 0,
      messagesApproved: 0,
      messagesListenedTo: 0,
    };
    countsByDate.set(range.date, {
      interactions: existing.interactions + counts.interactions,
      messagesLeft: existing.messagesLeft + counts.messagesLeft,
      messagesApproved: existing.messagesApproved + counts.messagesApproved,
      messagesListenedTo: existing.messagesListenedTo + counts.messagesListenedTo,
    });
  }
  return [...countsByDate].map(([date, counts]) => ({ date, counts }));
};

export const selectLatestSuccessfulTranscription = (
  transcriptions: readonly Transcription[],
): Transcription | null =>
  transcriptions
    .filter((item) => item.status === "succeeded")
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;

export const buildLocalDayRanges = (start: Date, end: Date, timeZone: string): LocalDayRange[] => {
  if (end.getTime() < start.getTime()) {
    throw new Error("Report end must be on or after report start.");
  }

  const ranges: LocalDayRange[] = [];
  for (const date of dateKeysInUtcRange(start, end, timeZone)) {
    for (const localRange of rangesForDateInTimeZone(date, timeZone)) {
      const rangeStart = new Date(Math.max(start.getTime(), localRange.start.getTime()));
      const rangeEnd = new Date(Math.min(end.getTime(), localRange.end.getTime()));
      if (rangeStart.getTime() <= rangeEnd.getTime()) {
        ranges.push({ date, start: rangeStart, end: rangeEnd });
      }
    }
  }

  return ranges;
};

export const renderExhibitionReportHtml = (report: ExhibitionReportData): string => {
  const maxAnswers = Math.max(1, ...report.questions.map((question) => question.answers));
  const location = report.location
    ? `<span>${escapeHtml(report.location)}</span><span class="separator">/</span>`
    : "";
  const promptSummary =
    report.matchedPrompts.length > 0
      ? report.matchedPrompts.map((prompt) => `&ldquo;${escapeHtml(prompt)}&rdquo;`).join(", ")
      : `No question matched &ldquo;${escapeHtml(report.targetPrompt)}&rdquo;.`;

  const dayRows = report.days
    .map(
      (day) => `
        <tr>
          <th scope="row">${escapeHtml(formatDateKey(day.date))}</th>
          <td>${numberFormat.format(day.counts.interactions)}</td>
          <td>${numberFormat.format(day.counts.messagesLeft)}</td>
          <td>${numberFormat.format(day.counts.messagesApproved)}</td>
          <td>${numberFormat.format(day.counts.messagesListenedTo)}</td>
        </tr>`,
    )
    .join("");

  const questionRows = report.questions
    .map((question) => {
      const width = Math.round((question.answers / maxAnswers) * 100);
      return `
        <tr>
          <th scope="row">
            <span class="question-prompt">${escapeHtml(question.prompt)}</span>
            <span class="question-status">${escapeHtml(humanStatus(question.status))}</span>
          </th>
          <td class="number-cell">${numberFormat.format(question.answers)}</td>
          <td class="number-cell">${numberFormat.format(question.approvedAnswers)}</td>
          <td class="bar-cell" aria-label="${numberFormat.format(question.answers)} answers">
            <span class="bar-track"><span class="bar-fill" style="width: ${width}%"></span></span>
          </td>
        </tr>`;
    })
    .join("");

  const transcriptEntries =
    report.transcripts.length === 0
      ? `<p class="empty-state">No answers with transcripts were found for the matching question.</p>`
      : report.transcripts
          .map((transcript, index) => {
            const original =
              transcript.text === null
                ? `<p class="transcript-unavailable">No successful transcription is available for this answer.</p>`
                : transcript.text.length === 0
                  ? `<p class="transcript-unavailable">No speech was detected in this recording.</p>`
                  : `<p class="transcript-text">${escapeHtml(transcript.text)}</p>`;
            return `
              <article class="transcript">
                <header>
                  <span class="transcript-number">${index + 1}</span>
                  <div>
                    <h3>${escapeHtml(transcript.prompt)}</h3>
                    <p>
                      ${escapeHtml(formatInstant(transcript.recordedAt, report.timeZone))}
                      <span class="separator">/</span>
                      ${escapeHtml(humanStatus(transcript.messageStatus))}
                    </p>
                  </div>
                </header>
                ${original}
              </article>`;
          })
          .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(report.title)}</title>
  <style>
    @font-face {
      font-family: "Telephone Booth Univers 57";
      src:
        local("Univers-Condensed"),
        local("Univers Condensed"),
        local("Univers Condensed Regular"),
        local("Univers Pro 57 Condensed"),
        local("Univers LT Pro 57 Condensed"),
        local("Univers Next Pro 57 Condensed"),
        local("Univers LT Std 57 Condensed"),
        local("Univers 57 Condensed"),
        local("UniversLTPro-57Condensed"),
        local("UniversLTStd-Cn");
      font-style: normal;
      font-weight: 400;
      font-stretch: condensed;
    }
    @font-face {
      font-family: "Telephone Booth Univers 65";
      src:
        local("Univers-Bold"),
        local("Univers Bold"),
        local("Univers Pro 65 Bold"),
        local("Univers LT Pro 65 Bold"),
        local("Univers Next Pro 65 Bold"),
        local("Univers LT Std 65 Bold"),
        local("Univers 65 Bold"),
        local("UniversLTPro-65Bold"),
        local("UniversLTStd-Bold");
      font-style: normal;
      font-weight: 700;
    }
    :root {
      color-scheme: light;
      --ink: rgb(43 23 28);
      --muted: rgb(118 84 91);
      --line: rgb(222 200 194);
      --paper: rgb(255 250 248);
      --paper-raised: rgb(255 255 255);
      --wash: rgb(244 236 233);
      --inset: rgb(246 239 236);
      --red: rgb(210 15 57);
      --red-strong: rgb(179 19 47);
      --red-soft: rgb(234 113 134);
      --red-wash: rgb(251 229 234);
      --shadow: 0 16px 38px rgb(83 38 45 / 18%);
      --font-body:
        "Telephone Booth Univers 57", "Univers LT Pro", "Univers Next Pro", "Univers LT Std",
        Univers, "Avenir Next", Avenir, "Helvetica Neue", Arial, sans-serif;
      --font-display:
        "Telephone Booth Univers 65", "Univers LT Pro", "Univers Next Pro", "Univers LT Std",
        Univers, "Avenir Next", Avenir, "Helvetica Neue", Arial, sans-serif;
      font-family: var(--font-body);
      font-synthesis: none;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      color: var(--ink);
      background: var(--wash);
      line-height: 1.5;
    }
    main {
      width: min(1080px, calc(100% - 32px));
      margin: 32px auto 64px;
      background: var(--paper);
      box-shadow: var(--shadow);
    }
    .hero {
      position: relative;
      overflow: hidden;
      padding: 64px 64px 52px;
      color: var(--paper-raised);
      background: linear-gradient(135deg, var(--red), var(--red-strong));
    }
    .hero-booth {
      position: absolute;
      top: 0;
      right: 28px;
      z-index: 0;
      width: auto;
      height: 100%;
      color: rgb(255 255 255 / 12%);
      pointer-events: none;
    }
    .hero-booth-sign {
      fill: currentColor;
      stroke: none;
      font-family: var(--font-display);
      font-size: 9.2px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-anchor: middle;
    }
    .eyebrow,
    .section-kicker {
      margin: 0 0 10px;
      font-family: var(--font-display);
      font-size: 0.76rem;
      font-weight: 750;
      letter-spacing: 0.13em;
      text-transform: uppercase;
    }
    .hero .eyebrow {
      position: relative;
      z-index: 1;
    }
    .hero h1 {
      position: relative;
      z-index: 1;
      max-width: 760px;
      margin: 0;
      font-family: var(--font-display);
      font-size: clamp(2.4rem, 6vw, 4.8rem);
      font-weight: 700;
      line-height: 0.98;
      letter-spacing: -0.045em;
    }
    .hero-meta {
      position: relative;
      z-index: 1;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 28px 0 0;
      color: rgb(255 255 255 / 82%);
    }
    .separator {
      color: currentColor;
      opacity: 0.48;
    }
    section {
      padding: 48px 64px;
      border-bottom: 1px solid var(--line);
    }
    section:last-child {
      border-bottom: 0;
    }
    .section-kicker {
      color: var(--red);
    }
    h2 {
      margin: 0 0 8px;
      font-family: var(--font-display);
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: -0.025em;
    }
    .section-intro {
      max-width: 780px;
      margin: 0 0 28px;
      color: var(--muted);
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
    }
    .metric-card {
      min-height: 170px;
      padding: 22px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: linear-gradient(145deg, var(--paper-raised), var(--inset));
    }
    .metric-label,
    .metric-detail {
      margin: 0;
      color: var(--muted);
    }
    .metric-label {
      font-family: var(--font-display);
      font-size: 0.84rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .metric-value {
      margin: 12px 0 6px;
      color: var(--red);
      font-family: var(--font-display);
      font-size: 3rem;
      font-weight: 700;
      line-height: 1;
      letter-spacing: -0.05em;
    }
    .metric-detail {
      font-size: 0.82rem;
    }
    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-variant-numeric: tabular-nums;
    }
    th,
    td {
      padding: 13px 16px;
      border-bottom: 1px solid var(--line);
      text-align: right;
      vertical-align: middle;
    }
    thead th {
      color: var(--muted);
      background: var(--inset);
      font-family: var(--font-display);
      font-size: 0.75rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    th:first-child,
    td:first-child {
      text-align: left;
    }
    tbody tr:last-child th,
    tbody tr:last-child td {
      border-bottom: 0;
    }
    tbody tr:nth-child(even) {
      background: var(--inset);
    }
    .question-prompt {
      display: block;
      max-width: 600px;
      font-family: var(--font-display);
      font-weight: 650;
    }
    .question-status {
      display: block;
      margin-top: 2px;
      color: var(--muted);
      font-size: 0.72rem;
      font-weight: 500;
    }
    .number-cell {
      width: 92px;
      font-family: var(--font-display);
      font-weight: 700;
    }
    .bar-cell {
      width: 22%;
    }
    .bar-track,
    .bar-fill {
      display: block;
      height: 8px;
      border-radius: 999px;
    }
    .bar-track {
      min-width: 90px;
      background: var(--red-wash);
    }
    .bar-fill {
      background: var(--red);
    }
    .transcript-prompt {
      margin: -12px 0 30px;
      color: var(--muted);
      font-style: italic;
    }
    .transcript {
      padding: 28px 0;
      border-top: 1px solid var(--line);
      break-inside: avoid;
    }
    .transcript:first-of-type {
      border-top: 0;
    }
    .transcript header {
      display: flex;
      gap: 16px;
      align-items: flex-start;
    }
    .transcript-number {
      display: grid;
      flex: 0 0 38px;
      width: 38px;
      height: 38px;
      place-items: center;
      border-radius: 50%;
      color: var(--paper-raised);
      background: var(--red);
      font-family: var(--font-display);
      font-weight: 750;
    }
    .transcript h3 {
      margin: 0;
      font-family: var(--font-display);
      font-size: 1rem;
    }
    .transcript header p {
      margin: 2px 0 0;
      color: var(--muted);
      font-size: 0.78rem;
    }
    .transcript-text,
    .transcript-unavailable {
      margin: 20px 0 0 54px;
      white-space: pre-wrap;
    }
    .transcript-text {
      font-family: var(--font-body);
      font-size: 1.08rem;
      line-height: 1.7;
    }
    .transcript-unavailable,
    .empty-state {
      color: var(--muted);
      font-style: italic;
    }
    .report-note {
      color: var(--muted);
      font-size: 0.82rem;
    }
    footer {
      padding: 24px 64px 32px;
      color: var(--muted);
      font-size: 0.76rem;
    }
    .print-button {
      position: fixed;
      right: 22px;
      bottom: 22px;
      z-index: 3;
      padding: 12px 18px;
      border: 0;
      border-radius: 999px;
      color: var(--paper-raised);
      background: var(--red);
      box-shadow: var(--shadow);
      font-family: var(--font-display);
      font-size: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    @media (max-width: 820px) {
      .hero,
      section,
      footer {
        padding-right: 28px;
        padding-left: 28px;
      }
      .hero-booth {
        right: 4px;
      }
      .metrics {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (max-width: 520px) {
      main {
        width: 100%;
        margin: 0;
      }
      .metrics {
        grid-template-columns: 1fr;
      }
      .bar-cell {
        display: none;
      }
      .hero-booth {
        right: -68px;
      }
    }
    @media print {
      @page {
        size: letter;
        margin: 0.55in;
      }
      body {
        background: var(--paper);
      }
      main {
        width: 100%;
        margin: 0;
        box-shadow: none;
      }
      .hero {
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }
      section {
        padding: 34px 0;
      }
      .metrics {
        gap: 8px;
      }
      .metric-card {
        min-height: 145px;
        padding: 16px;
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }
      .metric-value {
        font-size: 2.35rem;
      }
      thead {
        display: table-header-group;
      }
      .transcripts-section {
        break-before: page;
      }
      .print-button {
        display: none;
      }
      footer {
        padding-right: 0;
        padding-left: 0;
      }
    }
  </style>
</head>
<body>
  <button class="print-button" type="button" onclick="window.print()">Print / Save PDF</button>
  <main>
    <header class="hero">
      <svg
        class="hero-booth"
        viewBox="0 0 190 300"
        aria-hidden="true"
        focusable="false"
      >
        <g
          fill="none"
          stroke="currentColor"
          stroke-width="3.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M29 32h108l28 11" />
          <path d="M29 32v7h108l28 11v-7" />
          <rect x="34" y="39" width="103" height="36" rx="2" />
          <path d="M137 39l24 10v36l-24-10" />
          <path d="M38 75v199h94V75" />
          <path d="M132 75l29 10v189h-29" />
          <path d="M38 83h94l29 10" />
          <path d="M69.33 83v191M100.67 83v191" />
          <path d="M38 207h94M132 207h29" />
          <path d="M146.5 80v194" />
          <path d="M38 274h123" />
          <path d="M38 274v17M132 274v17M161 274v17" />
        </g>
        <text class="hero-booth-sign" x="85.5" y="62">TELEPHONE</text>
      </svg>
      <p class="eyebrow">Telephone Booth</p>
      <h1>${escapeHtml(report.title)}</h1>
      <p class="hero-meta">
        <span>${escapeHtml(report.installationName)}</span>
        <span class="separator">/</span>
        ${location}
        <span>${escapeHtml(formatInstant(report.installationStartedAt, report.timeZone))}</span>
        <span class="separator">to</span>
        <span>${escapeHtml(formatInstant(report.reportCutoffAt, report.timeZone))}</span>
      </p>
    </header>

    <section>
      <p class="section-kicker">At a glance</p>
      <h2>Exhibition totals</h2>
      <p class="section-intro">A snapshot of visitor activity across the selected installation.</p>
      <div class="metrics">
        ${metricCard("Interactions", report.totals.interactions, "Handset pickups")}
        ${metricCard("Messages left", report.totals.messagesLeft, "Completed recordings")}
        ${metricCard("Messages approved", report.totals.messagesApproved, "Recordings approved for playback")}
        ${metricCard("Messages listened to", report.totals.messagesListenedTo, "Message playback starts")}
      </div>
    </section>

    <section>
      <p class="section-kicker">Daily activity</p>
      <h2>Day-by-day breakdown</h2>
      <p class="section-intro">Calendar days use ${escapeHtml(report.timeZone)}.</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Interactions</th>
              <th scope="col">Messages left</th>
              <th scope="col">Approved</th>
              <th scope="col">Listened to</th>
            </tr>
          </thead>
          <tbody>${dayRows}</tbody>
        </table>
      </div>
    </section>

    <section>
      <p class="section-kicker">Questions</p>
      <h2>Answers generated by question</h2>
      <p class="section-intro">Answers include every completed upload associated with the question; approved answers are shown separately.</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Question</th>
              <th scope="col">Answers</th>
              <th scope="col">Approved</th>
              <th scope="col">Relative volume</th>
            </tr>
          </thead>
          <tbody>${questionRows}</tbody>
        </table>
      </div>
    </section>

    <section class="transcripts-section">
      <p class="section-kicker">Visitor voices</p>
      <h2>Selected answer transcriptions</h2>
      <p class="transcript-prompt">${promptSummary}</p>
      ${transcriptEntries}
    </section>

    <section>
      <p class="section-kicker">Method</p>
      <h2>How these numbers are counted</h2>
      <p class="report-note">
        An interaction is a handset pickup. A message left is an interaction ending in a completed recording.
        A message approved is a recording currently approved for booth playback. A message listened to is a
        booth transition into message playback, so repeat listens are counted. Question answer counts use
        message creation times within the same installation report window. Data was read from
        ${escapeHtml(report.sourceHost)} at ${escapeHtml(formatInstant(report.generatedAt, report.timeZone))}.
      </p>
    </section>

    <footer>Generated by the Telephone Booth Operator exhibition report.</footer>
  </main>
</body>
</html>
`;
};
