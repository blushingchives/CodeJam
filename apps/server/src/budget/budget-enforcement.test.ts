/**
 * The trust boundary.
 *
 * The product claim is that a workflow which cannot afford its remaining plan
 * never reaches the runner. These tests assert that directly: they count calls
 * on the runner rather than inspecting status, because a correct status with a
 * spent token is not the property being claimed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import type {
  Agent,
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "../types.js";
import { BudgetWorkflowService } from "./budget-workflow-service.js";

class SpyRunner implements AgentRunner {
  readonly calls: string[] = [];

  constructor(private readonly script: RunUsage[] = []) {}

  get callCount(): number {
    return this.calls.length;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const usage = this.script[this.calls.length] ?? {
      inputTokens: 100,
      outputTokens: 10,
    };
    this.calls.push(request.prompt);
    return { output: "done", threadId: "thread-abc", usage };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const plan = [
  { title: "Inspect repository", instruction: "Inspect the files.", weight: 1 },
  { title: "Implement backend", instruction: "Implement the backend.", weight: 4 },
  { title: "Implement UI", instruction: "Implement the UI.", weight: 3 },
  { title: "Run tests", instruction: "Run the tests.", weight: 2 },
];

async function makeService(runner: AgentRunner): Promise<{
  service: BudgetWorkflowService;
  agentId: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-enforce-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();

  const timestamp = new Date().toISOString();
  const agent: Agent = {
    id: "agent-1",
    name: "Builder",
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: path.join(root, "workspace"),
    codexThreadId: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await store.mutate((database) => database.agents.push(agent));

  return { service: new BudgetWorkflowService(store, runner), agentId: agent.id };
}

/** Run until the forecast pauses the workflow, then hand back the frozen state. */
async function pausedWorkflow(runner: SpyRunner, tokenBudget = 10_000) {
  const { service, agentId } = await makeService(runner);
  const created = await service.create({
    agentId,
    prompt: "implement the feature",
    tokenBudget,
    tasks: plan,
  });
  const workflow = await service.runUntilBlocked(created.id);
  expect(workflow.status).toBe("PAUSED_BUDGET_APPROVAL");
  return { service, workflowId: created.id };
}

describe("Trust boundary: the runner is unreachable without admission", () => {
  it("never calls the runner again once a workflow is paused", async () => {
    const runner = new SpyRunner([{ inputTokens: 4_000, outputTokens: 200 }]);
    const { service, workflowId } = await pausedWorkflow(runner);

    const callsAtPause = runner.callCount;
    expect(callsAtPause).toBe(1);

    await expect(service.start(workflowId)).rejects.toThrow(/paused/i);
    await expect(service.runUntilBlocked(workflowId)).rejects.toThrow(/paused/i);
    await service.resume(workflowId);

    // The single assertion the whole design exists to make.
    expect(runner.callCount).toBe(callsAtPause);

    const workflow = service.getWorkflow(workflowId);
    expect(workflow.status).toBe("PAUSED_BUDGET_APPROVAL");
    expect(workflow.tasks.slice(1).every((task) => task.status === "PENDING")).toBe(true);
  });

  it("admits work only when the raised budget actually clears the forecast", async () => {
    const runner = new SpyRunner([{ inputTokens: 4_000, outputTokens: 200 }]);
    const { service, workflowId } = await pausedWorkflow(runner);

    // Clears what was spent, nowhere near the projected 42,000.
    await service.updateBudget(workflowId, 12_000);
    await service.resume(workflowId);
    expect(runner.callCount).toBe(1);
    expect(service.getWorkflow(workflowId).status).toBe("PAUSED_BUDGET_APPROVAL");

    // Enough for the whole remaining plan.
    await service.updateBudget(workflowId, 100_000);
    await service.resume(workflowId);
    await service.runUntilBlocked(workflowId);

    expect(runner.callCount).toBe(4);
    expect(service.getWorkflow(workflowId).status).toBe("COMPLETED");
  });

  it("halts admission on the hard limit, and stays recoverable", async () => {
    // One task outspends the whole budget. Prediction cannot catch this: the
    // check happens between tasks, and nothing caps a single turn.
    const runner = new SpyRunner([{ inputTokens: 6_000, outputTokens: 0 }]);
    const { service, agentId } = await makeService(runner);
    const created = await service.create({
      agentId,
      prompt: "implement the feature",
      tokenBudget: 5_000,
      tasks: plan,
    });

    const workflow = await service.runUntilBlocked(created.id);

    expect(workflow.status).toBe("PAUSED_BUDGET_APPROVAL");
    expect(workflow.budgetState.decision).toBe("HARD_STOP");
    expect(runner.callCount).toBe(1);

    // No further task is admitted while the hard limit stands.
    await expect(service.start(created.id)).rejects.toThrow(/paused/i);
    await service.resume(created.id);
    expect(runner.callCount).toBe(1);

    // Raising the budget clears the hard limit and the forecast takes over.
    await service.updateBudget(created.id, 100_000);
    await service.resume(created.id);
    await service.runUntilBlocked(created.id);

    expect(runner.callCount).toBe(4);
    expect(service.getWorkflow(created.id).status).toBe("COMPLETED");
  });

  it("admits nothing after an operator stop", async () => {
    const runner = new SpyRunner();
    const { service, agentId } = await makeService(runner);
    const created = await service.create({
      agentId,
      prompt: "implement the feature",
      tokenBudget: 100_000,
      tasks: plan,
    });

    await service.stop(created.id);
    await service.start(created.id);
    await service.runUntilBlocked(created.id);

    expect(runner.callCount).toBe(0);
    expect(service.getWorkflow(created.id).status).toBe("STOPPED");
  });

  it("refuses to resume anything that is not paused", async () => {
    const runner = new SpyRunner();
    const { service, agentId } = await makeService(runner);
    const created = await service.create({
      agentId,
      prompt: "implement the feature",
      tokenBudget: 100_000,
      tasks: plan,
    });

    await expect(service.resume(created.id)).rejects.toThrow(/Only a paused workflow/);

    await service.runUntilBlocked(created.id);
    expect(service.getWorkflow(created.id).status).toBe("COMPLETED");
    await expect(service.resume(created.id)).rejects.toThrow(/Only a paused workflow/);
    await expect(service.updateBudget(created.id, 200_000)).rejects.toThrow(
      /already finished/,
    );
    expect(runner.callCount).toBe(4);
  });

  it("records usage, recalculates the forecast, and logs the decision in order", async () => {
    const runner = new SpyRunner([{ inputTokens: 4_000, outputTokens: 200 }]);
    const { service, workflowId } = await pausedWorkflow(runner);
    const workflow = service.getWorkflow(workflowId);

    expect(workflow.tasks[0]?.usage).toEqual({
      inputTokens: 4_000,
      cachedInputTokens: 0,
      billableInputTokens: 4_000,
      outputTokens: 200,
      totalTokens: 4_200,
    });
    expect(workflow.budgetState.observedTokensPerWeight).toBe(4_200);
    expect(workflow.budgetState.projectedTotalTokens).toBe(42_000);

    const events = service.getEvents(workflowId);
    expect(events.map((event) => event.type)).toEqual([
      "WORKFLOW_CREATED",
      "PLAN_CREATED",
      "TASK_STARTED",
      "TASK_COMPLETED",
      "FORECAST_UPDATED",
      "PAUSED",
    ]);

    const paused = events.at(-1);
    expect(paused?.consumedTokens).toBe(4_200);
    expect(paused?.projectedTotalTokens).toBe(42_000);
    expect(paused?.configuredBudget).toBe(10_000);
    expect(paused?.reason).toContain("Projected total exceeds the token budget");
  });
});
