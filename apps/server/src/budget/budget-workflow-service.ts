import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import type { JsonStore } from "../store.js";
import type { AgentRunner } from "../types.js";
import {
  DEFAULT_BUDGET_POLICY,
  admitsNextTask,
  canApplyBudget,
  evaluateBudget,
  type BudgetInput,
} from "./budget-controller.js";
import { parsePlan } from "./plan-schema.js";
import type {
  BudgetEvent,
  BudgetEventType,
  BudgetWorkflow,
  PlannedTask,
} from "./types.js";
import { normalizeUsage } from "./usage.js";

const now = () => new Date().toISOString();

const TERMINAL_STATUSES = new Set(["COMPLETED", "STOPPED", "FAILED"]);

export interface CreateBudgetWorkflowInput {
  agentId: string;
  prompt: string;
  tokenBudget: number;
  /** Validated here rather than by the caller, so every source is checked alike. */
  tasks: unknown;
}

/**
 * Reduce a workflow's tasks to the three numbers the controller decides on.
 *
 * A completed task whose usage was never reported contributes neither cost nor
 * weight, so the observed rate stays a ratio of measured tokens to measured work
 * rather than being diluted by work nobody could price.
 */
export function deriveBudgetInput(workflow: BudgetWorkflow): BudgetInput {
  let consumedTokens = 0;
  let completedWeight = 0;
  let remainingWeight = 0;

  for (const task of workflow.tasks) {
    if (task.status === "COMPLETED") {
      if (task.usage) {
        consumedTokens += task.usage.totalTokens;
        completedWeight += task.weight;
      }
      continue;
    }
    if (task.status === "PENDING" || task.status === "RUNNING") {
      remainingWeight += task.weight;
    }
  }

  return {
    policy: workflow.policy,
    consumedTokens,
    completedWeight,
    remainingWeight,
  };
}

export class BudgetWorkflowService {
  /** In-flight loops, so a repeated start cannot admit the same task twice. */
  private readonly active = new Map<string, Promise<void>>();

  constructor(
    private readonly store: JsonStore,
    private readonly runner: AgentRunner,
  ) {}

  getWorkflow(id: string): BudgetWorkflow {
    const workflow = this.store
      .snapshot()
      .budgetWorkflows.find((item) => item.id === id);
    if (!workflow) {
      throw new HttpError(404, "Budget workflow not found");
    }
    return workflow;
  }

  getEvents(workflowId: string): BudgetEvent[] {
    this.getWorkflow(workflowId);
    return this.store
      .snapshot()
      .budgetEvents.filter((event) => event.workflowId === workflowId)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  listWorkflows(agentId?: string): BudgetWorkflow[] {
    return this.store
      .snapshot()
      .budgetWorkflows.filter((item) => !agentId || item.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async create(input: CreateBudgetWorkflowInput): Promise<BudgetWorkflow> {
    const plan = parsePlan(input.tasks);
    if (!plan.ok) {
      throw new HttpError(400, "Invalid plan: " + plan.errors.join("; "));
    }
    if (!canApplyBudget(input.tokenBudget, 0)) {
      throw new HttpError(400, "A token budget must be a positive number");
    }

    const timestamp = now();
    const workflowId = randomUUID();
    const policy = { ...DEFAULT_BUDGET_POLICY, totalTokenBudget: input.tokenBudget };
    const tasks: PlannedTask[] = plan.tasks.map((task, index) => ({
      id: randomUUID(),
      index,
      title: task.title,
      instruction: task.instruction,
      weight: task.weight,
      status: "PENDING",
      usage: null,
      error: null,
      startedAt: null,
      completedAt: null,
    }));

    const workflow: BudgetWorkflow = {
      id: workflowId,
      agentId: input.agentId,
      codexThreadId: null,
      originalPrompt: input.prompt,
      status: "READY",
      tasks,
      policy,
      budgetState: evaluateBudget({
        policy,
        consumedTokens: 0,
        completedWeight: 0,
        remainingWeight: tasks.reduce((total, task) => total + task.weight, 0),
      }),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === input.agentId);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      database.budgetWorkflows.push(workflow);
      database.budgetEvents.push(
        makeEvent(workflowId, "WORKFLOW_CREATED", timestamp, {
          configuredBudget: policy.totalTokenBudget,
          reason: "Workflow created against agent " + agent.name + ".",
        }),
        makeEvent(workflowId, "PLAN_CREATED", timestamp, {
          reason:
            "Operator-supplied plan: " +
            tasks.length +
            " tasks, total weight " +
            workflow.budgetState.remainingWeight +
            ".",
        }),
      );
      return structuredClone(workflow);
    });
  }

  /**
   * Claim the agent for this workflow and start executing, without waiting for
   * the plan to finish. The claim is taken before returning, so a second caller
   * is rejected rather than racing, but the loop itself runs detached.
   */
  async start(workflowId: string): Promise<BudgetWorkflow> {
    const claim = await this.claimAgent(workflowId);
    if (claim === "already-running" || claim === "finished") {
      return this.getWorkflow(workflowId);
    }

    const execution = this.execute(workflowId).finally(() =>
      this.releaseAgent(workflowId),
    );
    this.active.set(workflowId, execution);
    void execution.catch(() => undefined);
    return this.getWorkflow(workflowId);
  }

  /**
   * Execute admitted tasks until the workflow can no longer proceed.
   *
   * Returns when the plan completes, the forecast pauses it, the hard limit trips,
   * a task fails, or a stop was requested. Repeated calls join the running loop
   * rather than starting a second one.
   */
  async runUntilBlocked(workflowId: string): Promise<BudgetWorkflow> {
    await this.start(workflowId);
    const execution = this.active.get(workflowId);
    if (execution) {
      await execution;
    }
    return this.getWorkflow(workflowId);
  }

  /** Refuse to admit any further task. A task already in flight still finishes. */
  async stop(workflowId: string): Promise<BudgetWorkflow> {
    const timestamp = now();
    await this.store.mutate((database) => {
      const workflow = database.budgetWorkflows.find((item) => item.id === workflowId);
      if (!workflow) {
        throw new HttpError(404, "Budget workflow not found");
      }
      if (TERMINAL_STATUSES.has(workflow.status)) {
        return;
      }
      workflow.status = "STOPPED";
      workflow.updatedAt = timestamp;
      database.budgetEvents.push(
        makeEvent(workflowId, "STOPPED", timestamp, {
          consumedTokens: workflow.budgetState.consumedTokens,
          configuredBudget: workflow.policy.totalTokenBudget,
          reason: "Stopped by operator request.",
        }),
      );
    });
    const execution = this.active.get(workflowId);
    if (execution) {
      await execution;
    }
    return this.getWorkflow(workflowId);
  }

  /**
   * Change the ceiling. This records an approval; it does not resume anything,
   * so the decision to continue stays a separate, re-evaluated act.
   */
  async updateBudget(
    workflowId: string,
    totalTokenBudget: number,
  ): Promise<BudgetWorkflow> {
    const timestamp = now();
    await this.store.mutate((database) => {
      const workflow = database.budgetWorkflows.find((item) => item.id === workflowId);
      if (!workflow) {
        throw new HttpError(404, "Budget workflow not found");
      }
      if (TERMINAL_STATUSES.has(workflow.status)) {
        throw new HttpError(409, "This workflow has already finished");
      }

      const consumedTokens = deriveBudgetInput(workflow).consumedTokens;
      if (!canApplyBudget(totalTokenBudget, consumedTokens)) {
        throw new HttpError(
          400,
          "A budget must be positive and no lower than the " +
            consumedTokens +
            " tokens already consumed",
        );
      }

      workflow.policy = { ...workflow.policy, totalTokenBudget };
      workflow.budgetState = evaluateBudget(deriveBudgetInput(workflow));
      workflow.updatedAt = timestamp;
      database.budgetEvents.push(
        makeEvent(workflowId, "BUDGET_UPDATED", timestamp, {
          consumedTokens,
          configuredBudget: totalTokenBudget,
          ...(workflow.budgetState.projectedTotalTokens === null
            ? {}
            : { projectedTotalTokens: workflow.budgetState.projectedTotalTokens }),
          reason: "Budget updated to " + totalTokenBudget + " tokens.",
        }),
      );
    });
    return this.getWorkflow(workflowId);
  }

  /**
   * Re-evaluate a paused workflow and continue only if policy now permits it.
   *
   * An earlier approval is never carried forward: the forecast is recomputed from
   * current measurements against the current budget, so raising the budget by too
   * little leaves the workflow paused rather than admitting one more task.
   */
  async resume(workflowId: string): Promise<BudgetWorkflow> {
    const timestamp = now();
    const outcome = await this.store.mutate((database) => {
      const workflow = database.budgetWorkflows.find((item) => item.id === workflowId);
      if (!workflow) {
        throw new HttpError(404, "Budget workflow not found");
      }
      if (workflow.status !== "PAUSED_BUDGET_APPROVAL") {
        throw new HttpError(409, "Only a paused workflow can be resumed");
      }

      const state = evaluateBudget(deriveBudgetInput(workflow));
      workflow.budgetState = state;
      workflow.updatedAt = timestamp;

      if (state.decision === "COMPLETE") {
        workflow.status = "COMPLETED";
        database.budgetEvents.push(
          makeEvent(workflowId, "COMPLETED", timestamp, {
            consumedTokens: state.consumedTokens,
            configuredBudget: workflow.policy.totalTokenBudget,
            reason: state.reason,
          }),
        );
        return "completed" as const;
      }

      if (!admitsNextTask(state.decision)) {
        database.budgetEvents.push(
          makeEvent(workflowId, "PAUSED", timestamp, {
            consumedTokens: state.consumedTokens,
            configuredBudget: workflow.policy.totalTokenBudget,
            ...(state.projectedTotalTokens === null
              ? {}
              : { projectedTotalTokens: state.projectedTotalTokens }),
            reason: "Resume refused. " + state.reason,
          }),
        );
        return "refused" as const;
      }

      workflow.status = "READY";
      database.budgetEvents.push(
        makeEvent(workflowId, "RESUMED", timestamp, {
          consumedTokens: state.consumedTokens,
          configuredBudget: workflow.policy.totalTokenBudget,
          ...(state.projectedTotalTokens === null
            ? {}
            : { projectedTotalTokens: state.projectedTotalTokens }),
          reason: state.reason,
        }),
      );
      return "resumed" as const;
    });

    if (outcome !== "resumed") {
      return this.getWorkflow(workflowId);
    }
    return this.start(workflowId);
  }

  /**
   * Take the agent for the duration of the workflow.
   *
   * The workflow and the Playground share one agent and one Codex thread, so a
   * message sent mid-workflow would append a turn to the same conversation and
   * spend tokens the budget never sees. Holding `busy` is what prevents that:
   * `AgentService.sendMessage` already refuses a busy agent.
   */
  private async claimAgent(
    workflowId: string,
  ): Promise<"claimed" | "already-running" | "finished"> {
    return this.store.mutate((database) => {
      const workflow = database.budgetWorkflows.find((item) => item.id === workflowId);
      if (!workflow) {
        throw new HttpError(404, "Budget workflow not found");
      }
      if (TERMINAL_STATUSES.has(workflow.status)) {
        return "finished";
      }
      if (workflow.status === "PAUSED_BUDGET_APPROVAL") {
        throw new HttpError(409, "This workflow is paused and awaiting budget approval");
      }

      const agent = database.agents.find((item) => item.id === workflow.agentId);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        // Our own loop already holds the claim; anything else owns the agent.
        // Checked before the stale-task guard below, so re-entry joins rather
        // than tripping over the task this very workflow is running.
        if (workflow.status === "RUNNING") {
          return "already-running";
        }
        throw new HttpError(409, "This Agent is already running");
      }
      if (agent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before running this workflow");
      }
      if (workflow.tasks.some((task) => task.status === "RUNNING")) {
        throw new HttpError(409, "A task in this workflow is already running");
      }

      agent.status = "busy";
      agent.lastError = null;
      agent.updatedAt = now();
      workflow.status = "RUNNING";
      workflow.updatedAt = now();
      return "claimed";
    });
  }

  private async stopForWithdrawnAgent(workflowId: string): Promise<void> {
    const timestamp = now();
    await this.store.mutate((database) => {
      const workflow = database.budgetWorkflows.find((item) => item.id === workflowId);
      if (!workflow || TERMINAL_STATUSES.has(workflow.status)) return;
      workflow.status = "STOPPED";
      workflow.updatedAt = timestamp;
      database.budgetEvents.push(
        makeEvent(workflowId, "STOPPED", timestamp, {
          consumedTokens: workflow.budgetState.consumedTokens,
          configuredBudget: workflow.policy.totalTokenBudget,
          reason: "The Agent was stopped, so no further task could be admitted.",
        }),
      );
    });
  }

  private async releaseAgent(workflowId: string): Promise<void> {
    this.active.delete(workflowId);
    await this.store.mutate((database) => {
      const workflow = database.budgetWorkflows.find((item) => item.id === workflowId);
      if (!workflow) return;
      const agent = database.agents.find((item) => item.id === workflow.agentId);
      // A concurrent stopAgent wins: never resurrect an agent the operator stopped.
      if (!agent || agent.status === "stopped") return;
      const failed = workflow.status === "FAILED";
      agent.status = failed ? "error" : "ready";
      agent.lastError = failed
        ? (workflow.tasks.find((task) => task.error)?.error ?? "Workflow failed")
        : null;
      agent.updatedAt = now();
    });
  }

  private async execute(workflowId: string): Promise<void> {
    for (;;) {
      const workflow = this.getWorkflow(workflowId);
      if (
        TERMINAL_STATUSES.has(workflow.status) ||
        workflow.status === "PAUSED_BUDGET_APPROVAL"
      ) {
        return;
      }

      // An operator who stops the Agent mid-workflow has withdrawn the runtime,
      // so no further task may be admitted onto it.
      const agent = this.store
        .snapshot()
        .agents.find((item) => item.id === workflow.agentId);
      if (!agent || agent.status === "stopped") {
        await this.stopForWithdrawnAgent(workflowId);
        return;
      }

      const state = evaluateBudget(deriveBudgetInput(workflow));
      const next = workflow.tasks.find((task) => task.status === "PENDING");

      if (!admitsNextTask(state.decision) || !next) {
        await this.settle(workflowId, state);
        return;
      }

      if (state.decision === "WARN") {
        await this.record(workflowId, state, "WARNING");
      }

      const proceeded = await this.runTask(workflowId, next.id, state);
      if (!proceeded) {
        return;
      }
    }
  }

  /** Apply a non-admitting decision to the workflow and record why. */
  private async settle(
    workflowId: string,
    state: ReturnType<typeof evaluateBudget>,
  ): Promise<void> {
    const status =
      state.decision === "COMPLETE"
        ? "COMPLETED"
        : state.decision === "PAUSE"
          ? "PAUSED_BUDGET_APPROVAL"
          : state.decision === "HARD_STOP"
            ? "STOPPED"
            : "PAUSED_BUDGET_APPROVAL";
    const type: BudgetEventType =
      state.decision === "COMPLETE"
        ? "COMPLETED"
        : state.decision === "HARD_STOP"
          ? "STOPPED"
          : "PAUSED";

    await this.store.mutate((database) => {
      const workflow = database.budgetWorkflows.find((item) => item.id === workflowId);
      if (!workflow) return;
      workflow.status = status;
      workflow.budgetState = state;
      workflow.updatedAt = now();
      database.budgetEvents.push(
        makeEvent(workflowId, type, workflow.updatedAt, {
          consumedTokens: state.consumedTokens,
          configuredBudget: workflow.policy.totalTokenBudget,
          ...(state.projectedTotalTokens === null
            ? {}
            : { projectedTotalTokens: state.projectedTotalTokens }),
          reason: state.reason,
        }),
      );
    });
  }

  /** Returns false when the loop must stop rather than admit another task. */
  private async runTask(
    workflowId: string,
    taskId: string,
    state: ReturnType<typeof evaluateBudget>,
  ): Promise<boolean> {
    const started = now();
    const context = await this.store.mutate((database) => {
      const workflow = database.budgetWorkflows.find((item) => item.id === workflowId);
      const task = workflow?.tasks.find((item) => item.id === taskId);
      if (!workflow || !task) {
        throw new HttpError(404, "Budget workflow task not found");
      }
      const agent = database.agents.find((item) => item.id === workflow.agentId);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }

      task.status = "RUNNING";
      task.startedAt = started;
      workflow.status = "RUNNING";
      workflow.budgetState = state;
      workflow.updatedAt = started;
      database.budgetEvents.push(
        makeEvent(workflowId, "TASK_STARTED", started, {
          taskId,
          consumedTokens: state.consumedTokens,
          configuredBudget: workflow.policy.totalTokenBudget,
          reason: "Admitted task " + (task.index + 1) + ": " + task.title,
        }),
      );

      return {
        agentId: agent.id,
        workspacePath: agent.workspacePath,
        instruction: task.instruction,
        threadId: workflow.codexThreadId ?? agent.codexThreadId,
      };
    });

    try {
      const result = await this.runner.run({
        agentId: context.agentId,
        workspacePath: context.workspacePath,
        prompt: context.instruction,
        threadId: context.threadId,
      });
      const usage = normalizeUsage(result.usage);
      const completedAt = now();

      await this.store.mutate((database) => {
        const workflow = database.budgetWorkflows.find((item) => item.id === workflowId);
        const task = workflow?.tasks.find((item) => item.id === taskId);
        if (!workflow || !task) return;

        task.status = "COMPLETED";
        task.usage = usage;
        task.completedAt = completedAt;

        // Every task in a workflow continues the same Codex thread, and the agent
        // keeps it so the Playground stays on that conversation too.
        workflow.codexThreadId = result.threadId;
        const agent = database.agents.find((item) => item.id === workflow.agentId);
        if (agent) {
          agent.codexThreadId = result.threadId;
          agent.updatedAt = completedAt;
        }

        const updated = evaluateBudget(deriveBudgetInput(workflow));
        workflow.budgetState = updated;
        workflow.updatedAt = completedAt;

        database.budgetEvents.push(
          makeEvent(workflowId, "TASK_COMPLETED", completedAt, {
            taskId,
            consumedTokens: updated.consumedTokens,
            configuredBudget: workflow.policy.totalTokenBudget,
            reason: usage
              ? "Task used " + usage.totalTokens + " tokens."
              : "Task completed without reported token usage.",
          }),
          makeEvent(workflowId, "FORECAST_UPDATED", completedAt, {
            consumedTokens: updated.consumedTokens,
            configuredBudget: workflow.policy.totalTokenBudget,
            ...(updated.projectedTotalTokens === null
              ? {}
              : { projectedTotalTokens: updated.projectedTotalTokens }),
            reason: updated.reason,
          }),
        );
      });

      if (!usage) {
        await this.pauseForUnmeasuredUsage(workflowId, taskId);
        return false;
      }
      return true;
    } catch (error) {
      await this.failTask(workflowId, taskId, error);
      return false;
    }
  }

  /**
   * A task that reports no usage leaves the forecast blind. Pausing is the only
   * honest response: treating the absence as zero would understate every
   * subsequent projection.
   */
  private async pauseForUnmeasuredUsage(
    workflowId: string,
    taskId: string,
  ): Promise<void> {
    const timestamp = now();
    const reason =
      "Token usage was not reported for this task, so the forecast cannot be " +
      "safely updated.";
    await this.store.mutate((database) => {
      const workflow = database.budgetWorkflows.find((item) => item.id === workflowId);
      if (!workflow) return;
      workflow.status = "PAUSED_BUDGET_APPROVAL";
      workflow.updatedAt = timestamp;
      database.budgetEvents.push(
        makeEvent(workflowId, "PAUSED", timestamp, {
          taskId,
          consumedTokens: workflow.budgetState.consumedTokens,
          configuredBudget: workflow.policy.totalTokenBudget,
          reason,
        }),
      );
    });
  }

  private async failTask(
    workflowId: string,
    taskId: string,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const timestamp = now();
    await this.store.mutate((database) => {
      const workflow = database.budgetWorkflows.find((item) => item.id === workflowId);
      const task = workflow?.tasks.find((item) => item.id === taskId);
      if (!workflow) return;
      if (task) {
        task.status = "FAILED";
        task.error = message;
        task.completedAt = timestamp;
      }
      workflow.status = "FAILED";
      workflow.updatedAt = timestamp;
      database.budgetEvents.push(
        makeEvent(workflowId, "TASK_FAILED", timestamp, {
          taskId,
          reason: message,
        }),
        makeEvent(workflowId, "FAILED", timestamp, {
          consumedTokens: workflow.budgetState.consumedTokens,
          configuredBudget: workflow.policy.totalTokenBudget,
          reason: "Workflow stopped because a task failed.",
        }),
      );
    });
  }

  private async record(
    workflowId: string,
    state: ReturnType<typeof evaluateBudget>,
    type: BudgetEventType,
  ): Promise<void> {
    const timestamp = now();
    await this.store.mutate((database) => {
      const workflow = database.budgetWorkflows.find((item) => item.id === workflowId);
      if (!workflow) return;
      workflow.budgetState = state;
      workflow.updatedAt = timestamp;
      database.budgetEvents.push(
        makeEvent(workflowId, type, timestamp, {
          consumedTokens: state.consumedTokens,
          configuredBudget: workflow.policy.totalTokenBudget,
          ...(state.projectedTotalTokens === null
            ? {}
            : { projectedTotalTokens: state.projectedTotalTokens }),
          reason: state.reason,
        }),
      );
    });
  }
}

function makeEvent(
  workflowId: string,
  type: BudgetEventType,
  timestamp: string,
  details: Omit<BudgetEvent, "id" | "workflowId" | "type" | "timestamp">,
): BudgetEvent {
  return {
    id: randomUUID(),
    workflowId,
    type,
    timestamp,
    ...details,
  };
}
