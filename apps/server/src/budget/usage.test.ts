import { describe, expect, it } from "vitest";
import { normalizeUsage } from "./usage.js";

describe("normalizeUsage", () => {
  it("subtracts the cached prefix from the billable total", () => {
    expect(normalizeUsage({ inputTokens: 4_000, cachedInputTokens: 3_000, outputTokens: 500 }))
      .toEqual({
        inputTokens: 4_000,
        cachedInputTokens: 3_000,
        billableInputTokens: 1_000,
        outputTokens: 500,
        totalTokens: 1_500,
      });
  });

  it("treats an absent cached count as zero cached tokens", () => {
    const usage = normalizeUsage({ inputTokens: 1_200, outputTokens: 300 });
    expect(usage?.cachedInputTokens).toBe(0);
    expect(usage?.totalTokens).toBe(1_500);
  });

  it("keeps a partial report and defaults only the missing side", () => {
    expect(normalizeUsage({ outputTokens: 800 })?.totalTokens).toBe(800);
    expect(normalizeUsage({ inputTokens: 900 })?.totalTokens).toBe(900);
  });

  it("returns null when neither an input nor an output count was reported", () => {
    expect(normalizeUsage({})).toBeNull();
    expect(normalizeUsage({ cachedInputTokens: 5_000 })).toBeNull();
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage(undefined)).toBeNull();
  });

  it("distinguishes a reported zero from a missing measurement", () => {
    expect(normalizeUsage({ inputTokens: 0, outputTokens: 0 })?.totalTokens).toBe(0);
    expect(normalizeUsage({})).toBeNull();
  });

  it("ignores counts that are not finite non-negative numbers", () => {
    expect(normalizeUsage({ inputTokens: -5, outputTokens: 10 })?.totalTokens).toBe(10);
    expect(normalizeUsage({ inputTokens: Number.NaN, outputTokens: 10 })?.inputTokens).toBe(0);
    expect(normalizeUsage({ inputTokens: 10, cachedInputTokens: -1 })?.cachedInputTokens).toBe(0);
    expect(normalizeUsage({ inputTokens: Number.NaN })).toBeNull();
  });

  it("never reports more cached tokens than input tokens", () => {
    const usage = normalizeUsage({ inputTokens: 100, cachedInputTokens: 400, outputTokens: 50 });
    expect(usage?.cachedInputTokens).toBe(100);
    expect(usage?.billableInputTokens).toBe(0);
    expect(usage?.totalTokens).toBe(50);
  });
});
