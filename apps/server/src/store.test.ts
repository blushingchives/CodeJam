import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_POLICY,
  evaluateBudget,
} from "./budget/budget-controller.js";
import type { BudgetWorkflow } from "./budget/types.js";
import { JsonStore } from "./store.js";

function makeWorkflow(id: string): BudgetWorkflow {
  const policy = { ...DEFAULT_BUDGET_POLICY, totalTokenBudget: 10_000 };
  const timestamp = new Date().toISOString();
  return {
    id,
    agentId: "agent-1",
    codexThreadId: null,
    originalPrompt: "implement the feature",
    status: "READY",
    tasks: [
      {
        id: "task-1",
        index: 0,
        title: "Inspect the repository",
        instruction: "Inspect the relevant files.",
        weight: 1,
        status: "PENDING",
        usage: null,
        error: null,
        startedAt: null,
        completedAt: null,
      },
    ],
    policy,
    budgetState: evaluateBudget({
      policy,
      consumedTokens: 0,
      completedWeight: 0,
      remainingWeight: 1,
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });

  it("round-trips budget workflows and events across a reopen", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");

    const store = new JsonStore(filePath);
    await store.initialize();
    await store.mutate((database) => {
      database.budgetWorkflows.push(makeWorkflow("workflow-1"));
      database.budgetEvents.push({
        id: "event-1",
        workflowId: "workflow-1",
        type: "WORKFLOW_CREATED",
        timestamp: new Date().toISOString(),
        configuredBudget: 10_000,
        reason: "Workflow created with an operator-supplied plan.",
      });
    });

    const reopened = new JsonStore(filePath);
    await reopened.initialize();
    const database = reopened.snapshot();

    expect(database.budgetWorkflows).toHaveLength(1);
    expect(database.budgetWorkflows[0]?.tasks[0]?.weight).toBe(1);
    expect(database.budgetWorkflows[0]?.budgetState.decision).toBe("ALLOW");
    expect(database.budgetEvents[0]?.type).toBe("WORKFLOW_CREATED");
  });

  it("defaults collections a stored file predates instead of throwing on first push", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "data", "db.json");
    await mkdir(path.dirname(filePath), { recursive: true });

    // A database written before the budget collections existed.
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, agents: [], messages: [], runs: [] }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();

    expect(store.snapshot().budgetWorkflows).toEqual([]);
    expect(store.snapshot().budgetEvents).toEqual([]);

    await store.mutate((database) => {
      database.budgetWorkflows.push(makeWorkflow("workflow-1"));
    });
    expect(store.snapshot().budgetWorkflows).toHaveLength(1);
  });
});
