import { describe, expect, it } from "vitest";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { CodexPlanner, extractPlan } from "./planner.js";

class PlannerRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];
  constructor(private readonly results: RunnerResult[]) {}
  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(request);
    const result = this.results[this.requests.length - 1];
    if (!result) throw new Error("Unexpected planner call");
    return result;
  }
  async cancel() { return false; }
  async isAvailable() { return true; }
}

const valid = '{"tasks":[{"title":"Inspect","instruction":"Inspect the repository.","weight":1}]}';

describe("CodexPlanner", () => {
  it("extracts and validates the final fenced plan", () => {
    const result = extractPlan("draft\n```json\n" + valid + "\n```");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tasks[0]?.title).toBe("Inspect");
  });

  it("plans read-only and retries invalid output once on the same thread", async () => {
    const runner = new PlannerRunner([
      { output: "not json", threadId: "planner-thread", usage: { inputTokens: 100, outputTokens: 20 } },
      { output: valid, threadId: "planner-thread", usage: { inputTokens: 50, outputTokens: 10 } },
    ]);
    const result = await new CodexPlanner(runner).plan({
      agentId: "agent-1", workspacePath: "workspace", objective: "Add auth", threadId: null,
    });

    expect(result.retried).toBe(true);
    expect(result.usage?.totalTokens).toBe(180);
    expect(runner.requests).toHaveLength(2);
    expect(runner.requests.every((request) => request.sandboxMode === "read-only")).toBe(true);
    expect(runner.requests[1]?.threadId).toBe("planner-thread");
  });
});
