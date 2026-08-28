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

type ScriptEntry = RunUsage | null | "throw";

class ScriptedRunner implements AgentRunner {
  readonly prompts: string[] = [];
  readonly threadIds: Array<string | null> = [];

  constructor(private readonly script: ScriptEntry[] = []) {}

  get callCount(): number {
    return this.prompts.length;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.prompts.push(request.prompt);
    this.threadIds.push(request.threadId);
    // A scripted `null` means "reported no usage" and must not fall through to
    // the default, which is why this checks the index rather than using `??`.
    const index = this.prompts.length - 1;
    const scripted = index < this.script.length ? this.script[index] : undefined;
    const entry: ScriptEntry =
      scripted === undefined ? { inputTokens: 100, outputTokens: 10 } : scripted;
    if (entry === "throw") {
      throw new Error("Codex exited with code 1");
    }
    return { output: "done", threadId: "thread-abc", usage: entry };
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
  store: JsonStore;
  agentId: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-budget-test-"));
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

  return { service: new BudgetWorkflowService(store, runner), store, agentId: agent.id };
}

describe("BudgetWorkflowService", () => {
  it("runs a four-task plan to completion on one thread, recording usage per task", async () => {
    const runner = new ScriptedRunner();
    const { service, store, agentId } = await makeService(runner);

    const created = await service.create({
      agentId,
      prompt: "implement the feature",
      tokenBudget: 10_000,
      tasks: plan,
    });
    expect(created.status).toBe("READY");

    const workflow = await service.runUntilBlocked(created.id);

    expect(workflow.status).toBe("COMPLETED");
    expect(runner.callCount).toBe(4);
    expect(runner.prompts).toEqual([
      "Inspect the files.",
      "Implement the backend.",
      "Implement the UI.",
      "Run the tests.",
    ]);

    expect(workflow.tasks.map((task) => task.status)).toEqual([
      "COMPLETED",
      "COMPLETED",
      "COMPLETED",
      "COMPLETED",
    ]);
    expect(workflow.tasks.every((task) => task.usage?.totalTokens === 110)).toBe(true);
    expect(workflow.budgetState.consumedTokens).toBe(440);

    // One session: the first turn opens it, every later turn resumes it.
    expect(runner.threadIds).toEqual([null, "thread-abc", "thread-abc", "thread-abc"]);
    expect(workflow.codexThreadId).toBe("thread-abc");
    expect(store.snapshot().agents[0]?.codexThreadId).toBe("thread-abc");

    expect(service.getEvents(workflow.id).map((event) => event.type)).toContain(
      "COMPLETED",
    );
  });

  it("pauses before the next task when the remaining plan is projected to overrun", async () => {
    const runner = new ScriptedRunner([{ inputTokens: 4_000, outputTokens: 200 }]);
    const { service, agentId } = await makeService(runner);

    const created = await service.create({
      agentId,
      prompt: "implement the feature",
      tokenBudget: 10_000,
      tasks: plan,
    });
    const workflow = await service.runUntilBlocked(created.id);

    expect(workflow.status).toBe("PAUSED_BUDGET_APPROVAL");
    expect(runner.callCount).toBe(1);
    expect(workflow.tasks.map((task) => task.status)).toEqual([
      "COMPLETED",
      "PENDING",
      "PENDING",
      "PENDING",
    ]);

    expect(workflow.budgetState.consumedTokens).toBe(4_200);
    expect(workflow.budgetState.observedTokensPerWeight).toBe(4_200);
    expect(workflow.budgetState.projectedRemainingTokens).toBe(37_800);
    expect(workflow.budgetState.projectedTotalTokens).toBe(42_000);
    expect(workflow.budgetState.decision).toBe("PAUSE");

    const events = service.getEvents(workflow.id).map((event) => event.type);
    expect(events).toEqual([
      "WORKFLOW_CREATED",
      "PLAN_CREATED",
      "TASK_STARTED",
      "TASK_COMPLETED",
      "FORECAST_UPDATED",
      "PAUSED",
    ]);
  });

  it("refuses to resume a paused workflow without an explicit approval", async () => {
    const runner = new ScriptedRunner([{ inputTokens: 4_000, outputTokens: 200 }]);
    const { service, agentId } = await makeService(runner);

    const created = await service.create({
      agentId,
      prompt: "implement the feature",
      tokenBudget: 10_000,
      tasks: plan,
    });
    await service.runUntilBlocked(created.id);

    await expect(service.runUntilBlocked(created.id)).rejects.toThrow(/paused/i);
    expect(runner.callCount).toBe(1);
  });

  it("fails the workflow when a task fails and does not start later tasks", async () => {
    const runner = new ScriptedRunner([{ inputTokens: 100, outputTokens: 10 }, "throw"]);
    const { service, agentId } = await makeService(runner);

    const created = await service.create({
      agentId,
      prompt: "implement the feature",
      tokenBudget: 100_000,
      tasks: plan,
    });
    const workflow = await service.runUntilBlocked(created.id);

    expect(workflow.status).toBe("FAILED");
    expect(runner.callCount).toBe(2);
    expect(workflow.tasks.map((task) => task.status)).toEqual([
      "COMPLETED",
      "FAILED",
      "PENDING",
      "PENDING",
    ]);
    expect(workflow.tasks[1]?.error).toContain("Codex exited with code 1");
    expect(service.getEvents(workflow.id).map((event) => event.type)).toContain(
      "TASK_FAILED",
    );
  });

  it("pauses rather than assuming zero when a task reports no usage", async () => {
    const runner = new ScriptedRunner([null]);
    const { service, agentId } = await makeService(runner);

    const created = await service.create({
      agentId,
      prompt: "implement the feature",
      tokenBudget: 100_000,
      tasks: plan,
    });
    const workflow = await service.runUntilBlocked(created.id);

    expect(workflow.status).toBe("PAUSED_BUDGET_APPROVAL");
    expect(runner.callCount).toBe(1);
    expect(workflow.tasks[0]?.status).toBe("COMPLETED");
    expect(workflow.tasks[0]?.usage).toBeNull();
    // Unmeasured work is excluded from the rate rather than counted as free.
    expect(workflow.budgetState.consumedTokens).toBe(0);
    expect(workflow.budgetState.completedWeight).toBe(0);

    const paused = service
      .getEvents(workflow.id)
      .find((event) => event.type === "PAUSED");
    expect(paused?.reason).toContain("not reported");
  });

  it("admits each task once when a run is requested concurrently", async () => {
    const runner = new ScriptedRunner();
    const { service, agentId } = await makeService(runner);

    const created = await service.create({
      agentId,
      prompt: "implement the feature",
      tokenBudget: 10_000,
      tasks: plan,
    });

    await Promise.all([
      service.runUntilBlocked(created.id),
      service.runUntilBlocked(created.id),
    ]);

    expect(runner.callCount).toBe(4);
  });

  it("rejects an invalid plan and an unusable budget at creation", async () => {
    const { service, agentId } = await makeService(new ScriptedRunner());

    await expect(
      service.create({
        agentId,
        prompt: "implement",
        tokenBudget: 10_000,
        tasks: [{ title: "Do it", instruction: "Do it.", weight: 0 }],
      }),
    ).rejects.toThrow(/weight must be at least 1/);

    await expect(
      service.create({ agentId, prompt: "implement", tokenBudget: 0, tasks: plan }),
    ).rejects.toThrow(/positive number/);

    await expect(
      service.create({
        agentId: "missing-agent",
        prompt: "implement",
        tokenBudget: 10_000,
        tasks: plan,
      }),
    ).rejects.toThrow(/Agent not found/);
  });
});
