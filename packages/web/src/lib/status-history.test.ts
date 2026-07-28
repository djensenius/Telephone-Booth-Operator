import { describe, expect, it } from "vite-plus/test";
import type { BoothStatus } from "@telephone-booth-operator/shared";

import { collapseStatusHistory, mergeLiveStatus } from "./status-history.js";

const status = (overrides: Partial<BoothStatus> & { updatedAt: string }): BoothStatus => ({
  state: "idle",
  currentQuestionId: null,
  currentMessageId: null,
  lastError: null,
  runtimeMode: null,
  ...overrides,
});

describe("collapseStatusHistory", () => {
  it("folds a run of identical snapshots into one counted entry", () => {
    const collapsed = collapseStatusHistory([
      status({ updatedAt: "2026-07-28T12:00:20.000Z" }),
      status({ updatedAt: "2026-07-28T12:00:10.000Z" }),
      status({ updatedAt: "2026-07-28T12:00:00.000Z" }),
    ]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toMatchObject({
      state: "idle",
      repeatCount: 3,
      firstSeenAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:20.000Z",
    });
  });

  it("sums the server-side repeat counts of a run", () => {
    const collapsed = collapseStatusHistory([
      status({
        updatedAt: "2026-07-28T12:01:00.000Z",
        firstSeenAt: "2026-07-28T12:00:40.000Z",
        repeatCount: 4,
      }),
      status({
        updatedAt: "2026-07-28T12:00:30.000Z",
        firstSeenAt: "2026-07-28T12:00:00.000Z",
        repeatCount: 7,
      }),
    ]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toMatchObject({
      repeatCount: 11,
      firstSeenAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:01:00.000Z",
    });
  });

  it("keeps genuine transitions as separate entries", () => {
    const collapsed = collapseStatusHistory([
      status({ updatedAt: "2026-07-28T12:00:30.000Z" }),
      status({ state: "recording", updatedAt: "2026-07-28T12:00:20.000Z" }),
      status({ updatedAt: "2026-07-28T12:00:10.000Z" }),
    ]);

    expect(collapsed.map((item) => item.state)).toEqual(["idle", "recording", "idle"]);
    expect(collapsed.every((item) => item.repeatCount === 1)).toBe(true);
  });

  it("does not merge snapshots that differ only by error text", () => {
    const collapsed = collapseStatusHistory([
      status({ state: "error", lastError: "line down", updatedAt: "2026-07-28T12:00:10.000Z" }),
      status({ state: "error", lastError: "no dial tone", updatedAt: "2026-07-28T12:00:00.000Z" }),
    ]);

    expect(collapsed).toHaveLength(2);
  });

  it("returns an empty list unchanged", () => {
    expect(collapseStatusHistory([])).toEqual([]);
  });
});

describe("mergeLiveStatus", () => {
  it("replaces the head when the live frame repeats it", () => {
    const history = [
      status({
        updatedAt: "2026-07-28T12:00:10.000Z",
        firstSeenAt: "2026-07-28T12:00:00.000Z",
        repeatCount: 2,
      }),
      status({ state: "recording", updatedAt: "2026-07-28T11:59:00.000Z" }),
    ];
    const live = status({
      updatedAt: "2026-07-28T12:00:20.000Z",
      firstSeenAt: "2026-07-28T12:00:00.000Z",
      repeatCount: 3,
    });

    const merged = mergeLiveStatus(history, live);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ repeatCount: 3, updatedAt: "2026-07-28T12:00:20.000Z" });
    expect(merged[1]).toMatchObject({ state: "recording" });
  });

  it("prepends a genuine transition", () => {
    const history = [status({ updatedAt: "2026-07-28T12:00:00.000Z" })];

    const merged = mergeLiveStatus(
      history,
      status({ state: "recording", updatedAt: "2026-07-28T12:00:05.000Z" }),
    );

    expect(merged.map((item) => item.state)).toEqual(["recording", "idle"]);
  });

  it("caps the history at the requested limit", () => {
    const history = Array.from({ length: 50 }, (_, index) =>
      status({
        state: index % 2 === 0 ? "idle" : "recording",
        updatedAt: `2026-07-28T12:00:0${0}.000Z`,
      }),
    );

    const merged = mergeLiveStatus(
      history,
      status({ state: "uploading", updatedAt: "2026-07-28T12:01:00.000Z" }),
    );

    expect(merged).toHaveLength(50);
    expect(merged[0]?.state).toBe("uploading");
  });

  it("seeds an empty history", () => {
    expect(mergeLiveStatus([], status({ updatedAt: "2026-07-28T12:00:00.000Z" }))).toHaveLength(1);
  });
});
