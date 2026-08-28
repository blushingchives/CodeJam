/**
 * The trusted admission decision.
 *
 * This module is deliberately free of imports: it performs no I/O, touches no
 * store, and knows nothing about Codex. It takes measured numbers and returns a
 * decision, which is what makes the policy testable in isolation and what keeps
 * the enforcement boundary auditable.
 */

export const MIN_TASK_WEIGHT = 1;
export const MAX_TASK_WEIGHT = 10;

export type BudgetDecision = "ALLOW" | "WARN" | "PAUSE" | "HARD_STOP" | "COMPLETE";

export interface TokenBudgetPolicy {
  totalTokenBudget: number;
  /** Warn once projected usage passes this fraction of the budget. */
  warningRatio: number;
  /** Pause once projected usage passes this fraction of the budget. */
  pauseRatio: number;
  /** Stop unconditionally once actual consumption reaches the budget. */
  hardLimitEnabled: boolean;
}

export const DEFAULT_BUDGET_POLICY: Omit<TokenBudgetPolicy, "totalTokenBudget"> = {
  warningRatio: 0.8,
  pauseRatio: 1,
  hardLimitEnabled: true,
};

export interface BudgetInput {
  policy: TokenBudgetPolicy;
  consumedTokens: number;
  completedWeight: number;
  remainingWeight: number;
}

export interface BudgetState {
  consumedTokens: number;
  completedWeight: number;
  remainingWeight: number;

  /** Null until at least one task has completed. */
  observedTokensPerWeight: number | null;
  projectedRemainingTokens: number | null;
  projectedTotalTokens: number | null;

  budgetUtilization: number;
  /** Null while no forecast is available. */
  projectedUtilization: number | null;

  decision: BudgetDecision;
  reason: string;
}

/** Whether the next task may be sent to the runner. */
export function admitsNextTask(decision: BudgetDecision): boolean {
  return decision === "ALLOW" || decision === "WARN";
}

export function isValidTaskWeight(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_TASK_WEIGHT &&
    value <= MAX_TASK_WEIGHT
  );
}

/**
 * A budget may be raised, or lowered only as far as what has already been spent.
 * Allowing it below consumption would leave a workflow permanently over budget
 * with no honest way to resume.
 */
export function canApplyBudget(totalTokenBudget: number, consumedTokens: number): boolean {
  return (
    Number.isFinite(totalTokenBudget) &&
    totalTokenBudget > 0 &&
    totalTokenBudget >= consumedTokens
  );
}

function assertMeasurable(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("BudgetController received a non-measurable " + name + ": " + value);
  }
}

/**
 * Decide whether the next task may be admitted.
 *
 * Order matters and is fixed: completion, then the hard limit, then the
 * calibration case, then the forecast. Completion is checked first because when
 * no task remains there is nothing to admit, and reporting a hard stop on a
 * workflow that finished its work would misdescribe a run that never overran.
 */
export function evaluateBudget(input: BudgetInput): BudgetState {
  const { policy, consumedTokens, completedWeight, remainingWeight } = input;

  assertMeasurable("consumedTokens", consumedTokens);
  assertMeasurable("completedWeight", completedWeight);
  assertMeasurable("remainingWeight", remainingWeight);
  if (!Number.isFinite(policy.totalTokenBudget) || policy.totalTokenBudget <= 0) {
    throw new Error(
      "BudgetController requires a positive token budget, received: " +
        policy.totalTokenBudget,
    );
  }

  const budgetUtilization = consumedTokens / policy.totalTokenBudget;
  const base = {
    consumedTokens,
    completedWeight,
    remainingWeight,
    budgetUtilization,
  };
  const withoutForecast = {
    observedTokensPerWeight: null,
    projectedRemainingTokens: null,
    projectedTotalTokens: null,
    projectedUtilization: null,
  };

  if (remainingWeight === 0) {
    return {
      ...base,
      ...withoutForecast,
      decision: "COMPLETE",
      reason: "All planned work is complete.",
    };
  }

  if (policy.hardLimitEnabled && consumedTokens >= policy.totalTokenBudget) {
    return {
      ...base,
      ...withoutForecast,
      decision: "HARD_STOP",
      reason:
        "Consumed " +
        consumedTokens +
        " tokens against a hard budget of " +
        policy.totalTokenBudget +
        ".",
    };
  }

  if (completedWeight === 0) {
    return {
      ...base,
      ...withoutForecast,
      decision: "ALLOW",
      reason: "Forecast unavailable until the first task completes.",
    };
  }

  const observedTokensPerWeight = consumedTokens / completedWeight;
  const projectedRemainingTokens = Math.round(observedTokensPerWeight * remainingWeight);
  const projectedTotalTokens = consumedTokens + projectedRemainingTokens;
  const projectedUtilization = projectedTotalTokens / policy.totalTokenBudget;

  const forecast = {
    observedTokensPerWeight,
    projectedRemainingTokens,
    projectedTotalTokens,
    projectedUtilization,
  };
  const projection =
    "Observed " +
    Math.round(observedTokensPerWeight) +
    " tokens per work unit over " +
    completedWeight +
    " completed weight projects " +
    projectedTotalTokens +
    " total against a budget of " +
    policy.totalTokenBudget +
    ".";

  if (projectedUtilization > policy.pauseRatio) {
    return {
      ...base,
      ...forecast,
      decision: "PAUSE",
      reason: "Projected total exceeds the token budget. " + projection,
    };
  }

  if (projectedUtilization > policy.warningRatio) {
    return {
      ...base,
      ...forecast,
      decision: "WARN",
      reason: "Projected total is approaching the token budget. " + projection,
    };
  }

  return {
    ...base,
    ...forecast,
    decision: "ALLOW",
    reason: "Remaining work is projected to fit the budget. " + projection,
  };
}
