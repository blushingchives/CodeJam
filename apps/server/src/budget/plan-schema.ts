import { z } from "zod";
import { MAX_TASK_WEIGHT, MIN_TASK_WEIGHT } from "./budget-controller.js";

export const MIN_PLAN_TASKS = 1;
export const MAX_PLAN_TASKS = 12;

export const plannedTaskInputSchema = z.object({
  title: z.string().trim().min(1, "a title is required").max(120),
  instruction: z.string().trim().min(1, "an instruction is required").max(10_000),
  weight: z
    .number({ error: "weight must be a number" })
    .int("weight must be a whole number")
    .min(MIN_TASK_WEIGHT, "weight must be at least " + MIN_TASK_WEIGHT)
    .max(MAX_TASK_WEIGHT, "weight must be at most " + MAX_TASK_WEIGHT),
});

export const taskListSchema = z
  .array(plannedTaskInputSchema, { error: "a plan must be a list of tasks" })
  .min(MIN_PLAN_TASKS, "a plan needs at least " + MIN_PLAN_TASKS + " task")
  .max(MAX_PLAN_TASKS, "a plan may not exceed " + MAX_PLAN_TASKS + " tasks");

export type PlannedTaskInput = z.infer<typeof plannedTaskInputSchema>;

export type PlanValidation =
  | { ok: true; tasks: PlannedTaskInput[] }
  | { ok: false; errors: string[] };

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>((accumulated, segment) => {
    return typeof segment === "number"
      ? accumulated + "[" + segment + "]"
      : accumulated + "." + String(segment);
  }, "tasks");
}

/**
 * Accept either a bare task array or the `{ "tasks": [...] }` envelope, so the
 * same validator serves an operator-supplied plan and a planner's JSON output.
 */
function unwrap(input: unknown): unknown {
  if (input && typeof input === "object" && !Array.isArray(input) && "tasks" in input) {
    return (input as { tasks: unknown }).tasks;
  }
  return input;
}

/**
 * Validate a plan, returning errors rather than throwing.
 *
 * Callers need the messages intact: a route reports them as a 400, and a planner
 * retry quotes them back to the model so it can see what it broke.
 */
export function parsePlan(input: unknown): PlanValidation {
  const result = taskListSchema.safeParse(unwrap(input));
  if (result.success) {
    return { ok: true, tasks: result.data };
  }
  const errors = result.error.issues.map(
    (issue) => formatPath(issue.path) + ": " + issue.message,
  );
  return { ok: false, errors };
}

export function totalPlanWeight(tasks: ReadonlyArray<{ weight: number }>): number {
  return tasks.reduce((total, task) => total + task.weight, 0);
}
