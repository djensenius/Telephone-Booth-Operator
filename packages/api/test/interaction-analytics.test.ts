import { describe, expect, it } from "vite-plus/test";

import {
  buildInteractionPerDay,
  summarizeInteractionActions,
  summarizeInteractionBreakdown,
  summarizeInteractionSessions,
  tallyLegacyDigitHistogram,
} from "../src/lib/interaction-analytics.js";

describe("interaction analytics helpers", () => {
  it("summarizes interaction outcomes and durations from the start cohort", () => {
    const summary = summarizeInteractionSessions([
      {
        startedAt: new Date("2026-08-08T12:00:00.000Z"),
        endedAt: new Date("2026-08-08T12:01:00.000Z"),
        outcome: "recording_completed",
        durationMs: 60_000,
        digitsDialed: "1",
      },
      {
        startedAt: new Date("2026-08-08T13:00:00.000Z"),
        endedAt: new Date("2026-08-08T13:00:05.000Z"),
        outcome: "hung_up_before_dial",
        durationMs: 5_000,
        digitsDialed: null,
      },
      {
        startedAt: new Date("2026-08-08T14:00:00.000Z"),
        endedAt: new Date("2026-08-08T14:00:05.000Z"),
        outcome: null,
        durationMs: 5_000,
        digitsDialed: null,
      },
      {
        startedAt: new Date("2026-08-08T15:00:00.000Z"),
        endedAt: null,
        outcome: null,
        durationMs: null,
        digitsDialed: null,
      },
    ]);

    expect(summary).toEqual({
      total: 4,
      noSelection: 1,
      messagesLeft: 1,
      averageDurationMs: (60_000 + 5_000 + 5_000) / 3,
      longestDurationMs: 60_000,
      outcomes: {
        recording_completed: 1,
        hung_up_before_dial: 1,
        unknown: 1,
      },
    });
  });

  it("zero-fills per-day interaction buckets across the selected range", () => {
    const perDay = buildInteractionPerDay(
      new Date("2026-08-08T00:00:00.000Z"),
      new Date("2026-08-10T12:00:00.000Z"),
      [
        {
          startedAt: new Date("2026-08-08T12:00:00.000Z"),
          endedAt: new Date("2026-08-08T12:01:00.000Z"),
          outcome: "recording_completed",
          durationMs: 60_000,
          digitsDialed: "1",
        },
        {
          startedAt: new Date("2026-08-10T01:00:00.000Z"),
          endedAt: new Date("2026-08-10T01:00:05.000Z"),
          outcome: "hung_up_before_dial",
          durationMs: 5_000,
          digitsDialed: null,
        },
      ],
    );

    expect(perDay).toEqual([
      { date: "2026-08-08", total: 1, noSelection: 0, messagesLeft: 1 },
      { date: "2026-08-09", total: 0, noSelection: 0, messagesLeft: 0 },
      { date: "2026-08-10", total: 1, noSelection: 1, messagesLeft: 0 },
    ]);
  });

  it("counts repeated actions and ignores malformed payloads", () => {
    const actions = summarizeInteractionActions([
      { type: "digit_dialed", payload: { digit: 1 } },
      { type: "digit_dialed", payload: { digit: 1 } },
      { type: "digit_dialed", payload: { digit: 2 } },
      { type: "digit_dialed", payload: { digit: 0 } },
      { type: "digit_dialed", payload: { digit: 7 } },
      { type: "digit_dialed", payload: { digit: 12 } },
      { type: "digit_dialed", payload: { digit: "3" } },
      { type: "state_transition", payload: { to: "playing_message" } },
      { type: "state_transition", payload: { to: "playing_message" } },
      { type: "state_transition", payload: { to: "playing_instructions" } },
      { type: "state_transition", payload: { to: "idle" } },
      { type: "state_transition", payload: null },
    ]);

    expect(actions).toEqual({
      digitsDialed: {
        "0": 1,
        "1": 2,
        "2": 1,
        "3": 0,
        "4": 0,
        "5": 0,
        "6": 0,
        "7": 1,
        "8": 0,
        "9": 0,
      },
      leaveMessageSelections: 2,
      listenMessageSelections: 1,
      instructionSelections: 1,
      wrongNumberAttempts: 1,
      messagePlaybackStarts: 2,
      instructionPlaybackStarts: 1,
    });
  });

  it("uses session summaries only when the range has no digit events", () => {
    expect(
      tallyLegacyDigitHistogram(
        [
          {
            startedAt: new Date("2026-08-08T12:00:00.000Z"),
            endedAt: new Date("2026-08-08T12:01:00.000Z"),
            outcome: "recording_completed",
            durationMs: 60_000,
            digitsDialed: "203",
          },
        ],
        [],
      ),
    ).toEqual({
      "0": 1,
      "1": 0,
      "2": 1,
      "3": 1,
      "4": 0,
      "5": 0,
      "6": 0,
      "7": 0,
      "8": 0,
      "9": 0,
    });
  });

  it("treats persisted digit events as authoritative for the whole range", () => {
    const digits = tallyLegacyDigitHistogram(
      [
        {
          startedAt: new Date("2026-08-08T12:00:00.000Z"),
          endedAt: new Date("2026-08-08T12:01:00.000Z"),
          outcome: "recording_completed",
          durationMs: 60_000,
          digitsDialed: "12",
        },
        {
          startedAt: new Date("2026-08-08T13:00:00.000Z"),
          endedAt: new Date("2026-08-08T13:01:00.000Z"),
          outcome: "recording_completed",
          durationMs: 60_000,
          digitsDialed: "9",
        },
      ],
      [
        { type: "digit_dialed", payload: { digit: 1 } },
        { type: "digit_dialed", payload: { digit: 5 } },
        { type: "digit_dialed", payload: { digit: "9" } },
      ],
    );

    expect(digits).toEqual({
      "0": 0,
      "1": 1,
      "2": 0,
      "3": 0,
      "4": 0,
      "5": 1,
      "6": 0,
      "7": 0,
      "8": 0,
      "9": 0,
    });
  });

  it("builds the shared breakdown for monitor and installation summaries", () => {
    const breakdown = summarizeInteractionBreakdown(
      [
        {
          startedAt: new Date("2026-08-08T12:00:00.000Z"),
          endedAt: new Date("2026-08-08T12:01:00.000Z"),
          outcome: "recording_completed",
          durationMs: 60_000,
          digitsDialed: "1",
        },
        {
          startedAt: new Date("2026-08-08T13:00:00.000Z"),
          endedAt: new Date("2026-08-08T13:00:05.000Z"),
          outcome: "hung_up_before_dial",
          durationMs: 5_000,
          digitsDialed: null,
        },
      ],
      [
        { type: "digit_dialed", payload: { digit: 7 } },
        { type: "state_transition", payload: { to: "playing_message" } },
        { type: "state_transition", payload: { to: "playing_instructions" } },
      ],
    );

    expect(breakdown).toEqual({
      noSelection: 1,
      wrongNumberAttempts: 1,
      messagesLeft: 1,
      messagePlaybackStarts: 1,
      instructionPlaybackStarts: 1,
    });
  });
});
