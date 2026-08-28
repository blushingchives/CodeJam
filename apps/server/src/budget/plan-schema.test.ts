import { describe, expect, it } from "vitest";
import { MAX_PLAN_TASKS, parsePlan, totalPlanWeight } from "./plan-schema.js";

const task = (overrides: Record<string, unknown> = {}) => ({
  title: "Inspect the current auth flow",
  instruction: "Inspect the relevant files and identify the required changes.",
  weight: 1,
  ...overrides,
});

describe("parsePlan", () => {
  it("accepts a bare task array", () => {
    const result = parsePlan([task(), task({ title: "Implement backend", weight: 4 })]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tasks).toHaveLength(2);
      expect(totalPlanWeight(result.tasks)).toBe(5);
    }
  });

  it("accepts the planner's tasks envelope", () => {
    const result = parsePlan({ tasks: [task()] });

    expect(result.ok).toBe(true);
  });

  it("trims surrounding whitespace from text fields", () => {
    const result = parsePlan([task({ title: "  Add tests  " })]);

    expect(result.ok && result.tasks[0]?.title).toBe("Add tests");
  });

  it("names the offending task and field when a weight is invalid", () => {
    const result = parsePlan([task(), task({ weight: 0 })]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(["tasks[1].weight: weight must be at least 1"]);
    }
  });

  it("rejects weights above the ceiling and non-integer weights", () => {
    expect(parsePlan([task({ weight: 11 })])).toEqual({
      ok: false,
      errors: ["tasks[0].weight: weight must be at most 10"],
    });
    expect(parsePlan([task({ weight: 2.5 })])).toEqual({
      ok: false,
      errors: ["tasks[0].weight: weight must be a whole number"],
    });
    expect(parsePlan([task({ weight: "4" })])).toEqual({
      ok: false,
      errors: ["tasks[0].weight: weight must be a number"],
    });
  });

  it("requires a title and an instruction on every task", () => {
    const result = parsePlan([task({ title: "   ", instruction: "" })]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("tasks[0].title: a title is required");
      expect(result.errors).toContain("tasks[0].instruction: an instruction is required");
    }
  });

  it("reports every problem in one pass rather than only the first", () => {
    const result = parsePlan([task({ weight: 0 }), task({ title: "" })]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(2);
    }
  });

  it("rejects an empty plan and one that exceeds the task ceiling", () => {
    expect(parsePlan([])).toEqual({
      ok: false,
      errors: ["tasks: a plan needs at least 1 task"],
    });

    const tooMany = Array.from({ length: MAX_PLAN_TASKS + 1 }, () => task());
    expect(parsePlan(tooMany)).toEqual({
      ok: false,
      errors: ["tasks: a plan may not exceed 12 tasks"],
    });
  });

  it("rejects input that is not a list of tasks at all", () => {
    expect(parsePlan(null).ok).toBe(false);
    expect(parsePlan("implement the feature").ok).toBe(false);
    expect(parsePlan({ steps: [] }).ok).toBe(false);
  });
});
