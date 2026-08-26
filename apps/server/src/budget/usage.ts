import type { RunUsage } from "../types.js";

/**
 * A usage measurement the budget controller is allowed to trust.
 *
 * Every field is present and finite. The absence of a measurement is represented
 * by `null` in place of the whole record, never by a zero inside one, because a
 * zero here would silently understate the forecast rather than block it.
 */
export interface UsageRecord {
  /** Input tokens as reported by the provider, inclusive of any cached prefix. */
  inputTokens: number;
  /** The portion of `inputTokens` served from cache. A subset, not an addition. */
  cachedInputTokens: number;
  /** `inputTokens` less `cachedInputTokens`, floored at zero. */
  billableInputTokens: number;
  outputTokens: number;
  /** `billableInputTokens + outputTokens`. The figure budget policy is applied to. */
  totalTokens: number;
}

function toCount(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

/**
 * Convert a runner's usage payload into a record the forecast can divide by.
 *
 * Returns `null` when the provider reported neither an input nor an output count,
 * which callers must treat as "usage unavailable" rather than as no usage.
 * A provider that explicitly reports zero yields a record with a zero total; that
 * is a measurement, not a missing one.
 */
export function normalizeUsage(usage: RunUsage | null | undefined): UsageRecord | null {
  if (!usage) {
    return null;
  }

  const reportedInput = toCount(usage.inputTokens);
  const reportedOutput = toCount(usage.outputTokens);
  if (reportedInput === null && reportedOutput === null) {
    return null;
  }

  const inputTokens = reportedInput ?? 0;
  const outputTokens = reportedOutput ?? 0;
  const cachedInputTokens = Math.min(toCount(usage.cachedInputTokens) ?? 0, inputTokens);
  const billableInputTokens = inputTokens - cachedInputTokens;

  return {
    inputTokens,
    cachedInputTokens,
    billableInputTokens,
    outputTokens,
    totalTokens: billableInputTokens + outputTokens,
  };
}
