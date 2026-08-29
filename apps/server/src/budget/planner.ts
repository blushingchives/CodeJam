import type { AgentRunner } from "../types.js";
import { parsePlan, type PlannedTaskInput } from "./plan-schema.js";
import { normalizeUsage, type UsageRecord } from "./usage.js";

export interface PlannerRequest {
  agentId: string;
  workspacePath: string;
  objective: string;
  threadId: string | null;
}

export interface PlannerResult {
  tasks: PlannedTaskInput[];
  threadId: string | null;
  usage: UsageRecord | null;
  retried: boolean;
}

const systemPrompt = (objective: string) => `You are planning a coding workflow.
Inspect the workspace read-only. Do not modify files or execute the requested work.
Create 1 to 12 sequential tasks for this objective: ${JSON.stringify(objective)}
Each task needs a concise title, a precise instruction, and an integer weight from 1 to 10 representing relative effort.
Include verification when appropriate. Return only JSON in this exact shape:
{"tasks":[{"title":"...","instruction":"...","weight":1}]}`;

function jsonCandidates(output: string): string[] {
  const fenced = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(
    (match) => match[1]?.trim() ?? "",
  );
  const candidates = [...fenced].reverse();
  for (let start = output.lastIndexOf("{"); start >= 0; ) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const character = output[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        candidates.push(output.slice(start, index + 1));
        break;
      }
    }
    if (start === 0) break;
    start = output.lastIndexOf("{", start - 1);
  }
  return candidates;
}

export function extractPlan(output: string) {
  const errors: string[] = [];
  for (const candidate of jsonCandidates(output)) {
    try {
      const result = parsePlan(JSON.parse(candidate));
      if (result.ok) return result;
      errors.push(...result.errors);
    } catch {
      // Try the next candidate.
    }
  }
  return { ok: false as const, errors: errors.length ? errors : ["No valid plan JSON found"] };
}

function addUsage(left: UsageRecord | null, right: UsageRecord | null): UsageRecord | null {
  if (!left) return right;
  if (!right) return left;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    billableInputTokens: left.billableInputTokens + right.billableInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

export class CodexPlanner {
  constructor(private readonly runner: AgentRunner) {}

  async plan(request: PlannerRequest): Promise<PlannerResult> {
    const first = await this.runner.run({
      agentId: request.agentId,
      workspacePath: request.workspacePath,
      prompt: systemPrompt(request.objective),
      threadId: request.threadId,
      sandboxMode: "read-only",
    });
    let usage = normalizeUsage(first.usage);
    const parsed = extractPlan(first.output);
    if (parsed.ok) {
      return { tasks: parsed.tasks, threadId: first.threadId, usage, retried: false };
    }

    const retry = await this.runner.run({
      agentId: request.agentId,
      workspacePath: request.workspacePath,
      threadId: first.threadId,
      sandboxMode: "read-only",
      prompt:
        "Your plan was invalid: " +
        parsed.errors.join("; ") +
        '. Return only valid JSON shaped as {"tasks":[{"title":"...","instruction":"...","weight":1}]}.',
    });
    usage = addUsage(usage, normalizeUsage(retry.usage));
    const repaired = extractPlan(retry.output);
    if (!repaired.ok) throw new Error("Planner returned an invalid plan: " + repaired.errors.join("; "));
    return { tasks: repaired.tasks, threadId: retry.threadId, usage, retried: true };
  }
}
