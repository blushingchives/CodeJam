import type { BudgetState, TokenBudgetPolicy } from "./budget-controller.js";
import type { UsageRecord } from "./usage.js";

/**
 * `PLANNING` is unused while plans are supplied by the operator. It is kept so a
 * planner can occupy the state later without a store migration.
 */
export type BudgetWorkflowStatus =
  | "PLANNING"
  | "READY"
  | "RUNNING"
  | "PAUSED_BUDGET_APPROVAL"
  | "COMPLETED"
  | "STOPPED"
  | "FAILED";

export type BudgetTaskStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "SKIPPED";

export type BudgetEventType =
  | "WORKFLOW_CREATED"
  | "PLAN_CREATED"
  | "TASK_STARTED"
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "FORECAST_UPDATED"
  | "WARNING"
  | "PAUSED"
  | "BUDGET_UPDATED"
  | "RESUMED"
  | "STOPPED"
  | "COMPLETED"
  | "FAILED";

export interface PlannedTask {
  id: string;
  index: number;

  title: string;
  instruction: string;

  /** Relative effort, not a token estimate. Always an integer in 1..10. */
  weight: number;

  status: BudgetTaskStatus;

  /** Null until the task completes, and after a task whose usage was unreported. */
  usage: UsageRecord | null;
  error: string | null;

  startedAt: string | null;
  completedAt: string | null;
}

export interface BudgetWorkflow {
  id: string;
  agentId: string;

  /** The Codex thread every task in this workflow runs on. */
  codexThreadId: string | null;

  originalPrompt: string;
  status: BudgetWorkflowStatus;

  tasks: PlannedTask[];
  policy: TokenBudgetPolicy;
  budgetState: BudgetState;

  createdAt: string;
  updatedAt: string;
}

/**
 * The audit trail. Every admission decision leaves one of these behind, which is
 * what lets a paused run explain itself without replaying the workflow.
 */
export interface BudgetEvent {
  id: string;
  workflowId: string;
  type: BudgetEventType;
  timestamp: string;

  taskId?: string;
  consumedTokens?: number;
  projectedTotalTokens?: number;
  configuredBudget?: number;
  reason?: string;
}
