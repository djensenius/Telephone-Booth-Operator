import { describe, expect, it } from "vite-plus/test";
import { applyPublicPlaybackLanguagePolicy } from "../src/lib/ai/content-policy.js";
import type { ModerationResult } from "../src/lib/ai/types.js";

const cleanApproval: ModerationResult = {
  flagged: false,
  recommendation: "approve",
  maxScore: 0.01,
  categories: { hate: 0.01 },
};

describe("public playback language policy", () => {
  it("routes profanity to review instead of approve", () => {
    const result = applyPublicPlaybackLanguagePolicy("That was f*ucking intense.", cleanApproval);

    expect(result.flagged).toBe(false);
    expect(result.recommendation).toBe("review");
    expect(result.maxScore).toBeGreaterThanOrEqual(0.51);
    expect(result.reasonSummary).toContain("profanity");
  });

  it("rejects slurs even when the upstream provider would approve", () => {
    const result = applyPublicPlaybackLanguagePolicy(
      `This includes a ${"n"}igger slur.`,
      cleanApproval,
    );

    expect(result.flagged).toBe(true);
    expect(result.recommendation).toBe("reject");
    expect(result.maxScore).toBeGreaterThanOrEqual(0.85);
    expect(result.reasonSummary).toContain("slur");
  });

  it("does not downgrade an existing rejection", () => {
    const rejection: ModerationResult = {
      flagged: true,
      recommendation: "reject",
      maxScore: 0.9,
      categories: { violence: 0.9 },
      reasonSummary: "violence",
    };

    expect(applyPublicPlaybackLanguagePolicy("f*uck", rejection)).toEqual(rejection);
  });
});
