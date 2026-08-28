import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../agent-service.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import { BudgetWorkflowService } from "./budget-workflow-service.js";

class ScriptedRunner implements AgentRunner {
  calls = 0;

  constructor(private readonly script: RunUsage[] = []) {}

  async run(_request: RunnerRequest): Promise<RunnerResult> {
    const usage = this.script[this.calls] ?? { inputTokens: 100, outputTokens: 10 };
    this.calls += 1;
    return { output: "done", threadId: "thread-abc", usage };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const plan = [
  { title: "Inspect repository", instruction: "Inspect the files.", weight: 1 },
  { title: "Implement backend", instruction: "Implement the backend.", weight: 4 },
  { title: "Implement UI", instruction: "Implement the UI.", weight: 3 },
  { title: "Run tests", instruction: "Run the tests.", weight: 2 },
];

const temporaryDirectories: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeApp(runner: AgentRunner): Promise<{
  app: FastifyInstance;
  agentId: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-api-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  const agent = await service.createAgent({ name: "Builder" });

  const app = await createApp(config, service, new BudgetWorkflowService(store, runner));
  apps.push(app);
  return { app, agentId: agent.id };
}

const readWorkflow = async (app: FastifyInstance, id: string) => {
  const response = await app.inject({ method: "GET", url: "/api/budget-workflows/" + id });
  return response.json() as {
    workflow: { status: string; budgetState: Record<string, number | null> };
    events: Array<{ type: string; reason?: string }>;
  };
};

describe("Budget workflow HTTP lifecycle", () => {
  it("drives create, pause, budget increase, resume and completion over HTTP", async () => {
    const runner = new ScriptedRunner([{ inputTokens: 4_000, outputTokens: 200 }]);
    const { app, agentId } = await makeApp(runner);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/budget-workflows",
      payload: { prompt: "implement the feature", tokenBudget: 10_000, tasks: plan },
    });
    expect(created.statusCode).toBe(201);
    const workflowId = (created.json() as { workflow: { id: string } }).workflow.id;

    const started = await app.inject({
      method: "POST",
      url: "/api/budget-workflows/" + workflowId + "/start",
    });
    expect(started.statusCode).toBe(202);

    await expect
      .poll(async () => (await readWorkflow(app, workflowId)).workflow.status)
      .toBe("PAUSED_BUDGET_APPROVAL");

    const paused = await readWorkflow(app, workflowId);
    expect(paused.workflow.budgetState.consumedTokens).toBe(4_200);
    expect(paused.workflow.budgetState.projectedTotalTokens).toBe(42_000);
    expect(paused.events.map((event) => event.type)).toContain("PAUSED");
    expect(runner.calls).toBe(1);

    const raised = await app.inject({
      method: "POST",
      url: "/api/budget-workflows/" + workflowId + "/budget",
      payload: { totalTokenBudget: 100_000 },
    });
    expect(raised.statusCode).toBe(200);

    const resumed = await app.inject({
      method: "POST",
      url: "/api/budget-workflows/" + workflowId + "/resume",
    });
    expect(resumed.statusCode).toBe(202);

    await expect
      .poll(async () => (await readWorkflow(app, workflowId)).workflow.status)
      .toBe("COMPLETED");

    expect(runner.calls).toBe(4);
    const finished = await readWorkflow(app, workflowId);
    expect(finished.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "WORKFLOW_CREATED",
        "TASK_COMPLETED",
        "FORECAST_UPDATED",
        "PAUSED",
        "BUDGET_UPDATED",
        "RESUMED",
        "COMPLETED",
      ]),
    );
  });

  it("refuses a resume that the recalculated forecast still cannot afford", async () => {
    const runner = new ScriptedRunner([{ inputTokens: 4_000, outputTokens: 200 }]);
    const { app, agentId } = await makeApp(runner);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/budget-workflows",
      payload: { prompt: "implement the feature", tokenBudget: 10_000, tasks: plan },
    });
    const workflowId = (created.json() as { workflow: { id: string } }).workflow.id;

    await app.inject({ method: "POST", url: "/api/budget-workflows/" + workflowId + "/start" });
    await expect
      .poll(async () => (await readWorkflow(app, workflowId)).workflow.status)
      .toBe("PAUSED_BUDGET_APPROVAL");

    // Enough to clear what was spent, nowhere near enough for the remaining plan.
    await app.inject({
      method: "POST",
      url: "/api/budget-workflows/" + workflowId + "/budget",
      payload: { totalTokenBudget: 12_000 },
    });
    await app.inject({
      method: "POST",
      url: "/api/budget-workflows/" + workflowId + "/resume",
    });

    const after = await readWorkflow(app, workflowId);
    expect(after.workflow.status).toBe("PAUSED_BUDGET_APPROVAL");
    expect(runner.calls).toBe(1);
    expect(
      after.events.some((event) => event.reason?.startsWith("Resume refused")),
    ).toBe(true);
  });

  it("rejects a malformed plan, an unusable budget, and a lowered budget", async () => {
    const { app, agentId } = await makeApp(new ScriptedRunner());

    const badWeight = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/budget-workflows",
      payload: {
        prompt: "implement",
        tokenBudget: 10_000,
        tasks: [{ title: "Do it", instruction: "Do it.", weight: 99 }],
      },
    });
    expect(badWeight.statusCode).toBe(400);
    expect(badWeight.json().error).toContain("tasks[0].weight");

    const badBudget = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/budget-workflows",
      payload: { prompt: "implement", tokenBudget: -5, tasks: plan },
    });
    expect(badBudget.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/budget-workflows",
      payload: { prompt: "implement", tokenBudget: 10_000, tasks: plan },
    });
    const workflowId = (created.json() as { workflow: { id: string } }).workflow.id;
    await app.inject({ method: "POST", url: "/api/budget-workflows/" + workflowId + "/start" });
    await expect
      .poll(async () => (await readWorkflow(app, workflowId)).workflow.status)
      .toBe("COMPLETED");

    const lowered = await app.inject({
      method: "POST",
      url: "/api/budget-workflows/" + workflowId + "/budget",
      payload: { totalTokenBudget: 1 },
    });
    expect(lowered.statusCode).toBe(409);
  });

  it("returns 404 for an unknown workflow", async () => {
    const { app } = await makeApp(new ScriptedRunner());
    const response = await app.inject({
      method: "GET",
      url: "/api/budget-workflows/6f1a3d2e-0000-4000-8000-000000000000",
    });
    expect(response.statusCode).toBe(404);
  });
});
