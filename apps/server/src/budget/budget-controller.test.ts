import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_POLICY,
  admitsNextTask,
  canApplyBudget,
  evaluateBudget,
  isValidTaskWeight,
  type TokenBudgetPolicy,
} from "./budget-controller.js";

const policy = (totalTokenBudget: number, overrides: Partial<TokenBudgetPolicy> = {}) => ({
  ...DEFAULT_BUDGET_POLICY,
  totalTokenBudget,
  ...overrides,
});

describe("evaluateBudget", () => {
  it("admits the first task as a calibration run with no forecast", () => {
    const state = evaluateBudget({
      policy: policy(10_000),
      consumedTokens: 0,
      completedWeight: 0,
      remainingWeight: 10,
    });

    expect(state.decision).toBe("ALLOW");
    expect(state.observedTokensPerWeight).toBeNull();
    expect(state.projectedTotalTokens).toBeNull();
    expect(state.reason).toContain("Forecast unavailable");
  });

  it("allows work that is projected to fit", () => {
    const state = evaluateBudget({
      policy: policy(100),
      consumedTokens: 20,
      completedWeight: 2,
      remainingWeight: 3,
    });

    expect(state.observedTokensPerWeight).toBe(10);
    expect(state.projectedRemainingTokens).toBe(30);
    expect(state.projectedTotalTokens).toBe(50);
    expect(state.decision).toBe("ALLOW");
  });

  it("warns between the warning threshold and the budget", () => {
    const state = evaluateBudget({
      policy: policy(100),
      consumedTokens: 30,
      completedWeight: 3,
      remainingWeight: 6,
    });

    expect(state.projectedTotalTokens).toBe(90);
    expect(state.decision).toBe("WARN");
    expect(admitsNextTask(state.decision)).toBe(true);
  });

  it("pauses when the remaining plan is projected to overrun", () => {
    const state = evaluateBudget({
      policy: policy(90),
      consumedTokens: 50,
      completedWeight: 1,
      remainingWeight: 5,
    });

    expect(state.observedTokensPerWeight).toBe(50);
    expect(state.projectedRemainingTokens).toBe(250);
    expect(state.projectedTotalTokens).toBe(300);
    expect(state.decision).toBe("PAUSE");
    expect(admitsNextTask(state.decision)).toBe(false);
  });

  it("hard stops once actual consumption reaches the budget", () => {
    const state = evaluateBudget({
      policy: policy(100),
      consumedTokens: 100,
      completedWeight: 5,
      remainingWeight: 5,
    });

    expect(state.decision).toBe("HARD_STOP");
    expect(state.observedTokensPerWeight).toBe(20);
    expect(state.projectedRemainingTokens).toBe(100);
    expect(state.projectedTotalTokens).toBe(200);
    expect(state.projectedUtilization).toBe(2);
    expect(admitsNextTask(state.decision)).toBe(false);
  });

  it("skips the hard stop when the hard limit is disabled", () => {
    const state = evaluateBudget({
      policy: policy(100, { hardLimitEnabled: false }),
      consumedTokens: 100,
      completedWeight: 5,
      remainingWeight: 5,
    });

    expect(state.decision).toBe("PAUSE");
  });

  it("reports completion when no weight remains, even at the hard limit", () => {
    const state = evaluateBudget({
      policy: policy(100),
      consumedTokens: 100,
      completedWeight: 10,
      remainingWeight: 0,
    });

    expect(state.decision).toBe("COMPLETE");
    expect(admitsNextTask(state.decision)).toBe(false);
  });

  it("keeps the reported projection consistent with the decision it justifies", () => {
    const state = evaluateBudget({
      policy: policy(1_000),
      consumedTokens: 333,
      completedWeight: 3,
      remainingWeight: 7,
    });

    expect(state.projectedTotalTokens).toBe(
      state.consumedTokens + (state.projectedRemainingTokens ?? 0),
    );
    expect(state.projectedUtilization).toBe((state.projectedTotalTokens ?? 0) / 1_000);
  });

  it("refuses to decide on unmeasurable input", () => {
    expect(() =>
      evaluateBudget({
        policy: policy(100),
        consumedTokens: Number.NaN,
        completedWeight: 1,
        remainingWeight: 1,
      }),
    ).toThrow(/non-measurable/);

    expect(() =>
      evaluateBudget({
        policy: policy(100),
        consumedTokens: -1,
        completedWeight: 1,
        remainingWeight: 1,
      }),
    ).toThrow(/non-measurable/);

    expect(() =>
      evaluateBudget({
        policy: policy(0),
        consumedTokens: 0,
        completedWeight: 0,
        remainingWeight: 1,
      }),
    ).toThrow(/positive token budget/);
  });
});

describe("isValidTaskWeight", () => {
  it("accepts small positive integers only", () => {
    expect(isValidTaskWeight(1)).toBe(true);
    expect(isValidTaskWeight(10)).toBe(true);
    expect(isValidTaskWeight(0)).toBe(false);
    expect(isValidTaskWeight(-1)).toBe(false);
    expect(isValidTaskWeight(11)).toBe(false);
    expect(isValidTaskWeight(2.5)).toBe(false);
    expect(isValidTaskWeight("3")).toBe(false);
    expect(isValidTaskWeight(Number.NaN)).toBe(false);
  });

  it("guarantees that zero remaining weight means no pending tasks", () => {
    expect(isValidTaskWeight(0)).toBe(false);
  });
});

describe("canApplyBudget", () => {
  it("permits raising the budget and refuses dropping it below what is spent", () => {
    expect(canApplyBudget(50_000, 12_400)).toBe(true);
    expect(canApplyBudget(12_400, 12_400)).toBe(true);
    expect(canApplyBudget(12_399, 12_400)).toBe(false);
    expect(canApplyBudget(0, 0)).toBe(false);
    expect(canApplyBudget(Number.NaN, 0)).toBe(false);
  });
});
