export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

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

export type BudgetDecision = "ALLOW" | "WARN" | "PAUSE" | "HARD_STOP" | "COMPLETE";

export interface UsageRecord {
  inputTokens: number;
  cachedInputTokens: number;
  billableInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface PlannedTask {
  id: string;
  index: number;
  title: string;
  instruction: string;
  weight: number;
  status: BudgetTaskStatus;
  usage: UsageRecord | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface BudgetState {
  consumedTokens: number;
  completedWeight: number;
  remainingWeight: number;
  observedTokensPerWeight: number | null;
  projectedRemainingTokens: number | null;
  projectedTotalTokens: number | null;
  budgetUtilization: number;
  projectedUtilization: number | null;
  decision: BudgetDecision;
  reason: string;
}

export interface BudgetWorkflow {
  id: string;
  agentId: string;
  codexThreadId: string | null;
  originalPrompt: string;
  planSource?: "OPERATOR" | "PLANNER";
  planningUsage?: UsageRecord | null;
  planningError?: string | null;
  status: BudgetWorkflowStatus;
  tasks: PlannedTask[];
  policy: {
    totalTokenBudget: number;
    warningRatio: number;
    pauseRatio: number;
    hardLimitEnabled: boolean;
  };
  budgetState: BudgetState;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetEvent {
  id: string;
  workflowId: string;
  type: string;
  timestamp: string;
  taskId?: string;
  consumedTokens?: number;
  projectedTotalTokens?: number;
  configuredBudget?: number;
  reason?: string;
}

export interface TaskDraft {
  title: string;
  instruction: string;
  weight: number;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
