# Agent Runway

**A budget-governance layer that re-forecasts an agent workflow's token cost after every task and stops for human approval before the run is projected to overspend — not after.**

> Status: working prototype. The enforcement path (plan → measure → forecast → admit or pause → human approval) runs end to end against real Codex, backed by 65 passing tests. The forecasting model is deliberately simple, and several planned extensions (an automatic planner, rate smoothing, confidence bands) are **not built**. This document is explicit about which is which.

---

## 1. What this is

Agent Runway sits between the control plane and the agent runner. An operator hands it a task broken into weighted sub-tasks. It runs them one at a time on a single Codex thread, measures the real token usage reported after each one, projects what the rest of the plan will cost at the observed rate, and — before it calls the runner for the next task — decides whether to continue, warn, or pause and wait for a human to raise the budget or stop the run.

The decision point is a pure function with no I/O (`apps/server/src/budget/budget-controller.ts`). Everything that can spend tokens is on the far side of it.

### Challenge track

Track 1 — Agent Launchpad: design and build lightweight agent middleware. The track is open to any middleware the team chooses, provided it runs in a real backend, runtime, or data path rather than the UI alone. Agent Runway is a trust boundary in the backend data path: it sits between the control plane and the agent runner and decides whether, and when, a run proceeds.

---

## 2. Problem statement

Agent platforms can tell you what a run has already cost. They cannot reliably tell you, before it starts or while it is running, what it is *going* to cost. The Starter Kit is typical: it captures `turn.completed.usage` from Codex and stores per-run token counts (`apps/server/src/codex-runner.ts:63`), but nothing acts on those numbers. A run that is on track to spend five times its intended budget looks identical to one that is on track, until it is over.

Asking the agent to estimate its own cost up front does not close the gap. Recent work measuring LLM agents' self-estimates of token cost found weak correlation with actual spend (Pearson roughly 0.05 to 0.39) and a consistent bias toward underestimating `[cite: add source]`. Industry reports describe a matching pattern in production: a large share of enterprise agentic deployments run over budget, some by more than double, because the tooling reports spend after the fact rather than catching a run mid-overrun `[cite: add source]`.

Agent Runway does not try to predict an absolute cost. It compares the run against its own plan. The operator states, in relative terms, how much of the total effort each sub-task should represent. After each task completes, the middleware knows the real tokens-per-unit-of-planned-effort rate so far, and extrapolates it across the remaining planned effort. If that projection exceeds the budget the operator set, the run pauses. The signal is "this run is spending faster than its plan implied," which needs a plan and a ceiling but not an accurate cost prediction.

---

## 3. Rationale

**Why not a hard token cap?** A cap answers "have I spent too much yet?" It fires only once the money is gone, and it fires in the middle of a task with no clean stopping point — the agent has half-edited three files and the turn is billed regardless. Agent Runway keeps a hard cap as a backstop (`hardLimitEnabled`, `budget-controller.ts:133`) but the primary signal is the forecast, which can fire *between* tasks, while there is still budget left to make a decision with.

**Why not a raw per-turn heuristic** (e.g. "pause if any turn costs more than N tokens")? A fixed per-turn threshold has no notion of how much work the turn was supposed to do. A turn that costs 20k tokens is fine if it was the bulk of the plan and a problem if it was meant to be a quick check. Weighting each task by expected effort is what lets the same overspend be judged differently depending on where in the plan it happens.

**Why earned-value-style tracking specifically.** Earned Value Management, a standard project-controls technique, separates three quantities: planned value, actual cost, and earned value (value of work actually completed). Its forecasting move is to divide remaining planned work by the observed cost-efficiency ratio to get an estimate-at-completion, rather than assuming the original estimate still holds. Agent Runway borrows that structure: `observedTokensPerWeight = consumedTokens / completedWeight`, then `projectedTotal = consumed + observedTokensPerWeight * remainingWeight` (`budget-controller.ts:156`). It re-forecasts from measured reality after every task instead of trusting the initial plan.

**What it borrows and what it does not.** The lineage is EVM; the implementation is a deliberately thin version of it. There is no cost performance index surfaced as a ratio, no schedule dimension, and the "value of completed work" is the planned weight of tasks whose runner call returned without error — see the limitations section for exactly what that does and does not verify.

---

## 4. Use case

An operator wants an agent to add a health endpoint to a small service. They decompose it and assign relative weights (integers, 1–10):

| # | Task | Weight | Meaning |
|---|------|--------|---------|
| 1 | Inspect the workspace and summarise the layout | 1 | quick, cheap |
| 2 | Implement the endpoint | 4 | the bulk of the work |
| 3 | Add a test and run it | 3 | substantial |
| 4 | Print the final file and report test status | 2 | wrap-up |

Total weight 10. They set a token budget of 12,000 — their honest guess at what a job this size should cost.

Task 1 runs. It was supposed to be a 10th of the effort, but the workspace is larger than expected and the agent reads a lot of it: the reported usage is 4,200 tokens. The middleware now has a rate: 4,200 tokens for 1 unit of weight. Projected remaining cost is `4,200 * 9 = 37,800`; projected total is `42,000` against a budget of `12,000`.

Before task 2 is sent to the runner, `evaluateBudget` returns `PAUSE`. The workflow status becomes `PAUSED_BUDGET_APPROVAL`, a `PAUSED` event is written with the numbers that justify it, and the agent is released. The operator sees: consumed 4,200, projected total 42,000, budget 12,000, and the reason string. They can raise the budget and resume (the forecast is recomputed against the new ceiling — raising it to 15,000 would still pause), or stop.

Without this layer, tasks 2–4 would have run and the operator would have found out at 40,000-plus tokens that the estimate was wrong.

The four-task plan above is close to the default plan seeded in the browser panel (`apps/web/src/BudgetRun.tsx:13`), which builds a small `fizzbuzz` module instead.

---

## 5. Architecture

```
Browser (apps/web/src/BudgetRun.tsx)
   |  POST /api/agents/:id/budget-workflows      create plan + budget
   |  POST /api/budget-workflows/:id/start       begin
   |  GET  /api/budget-workflows/:id             poll status, tasks, forecast, events
   |  POST /api/budget-workflows/:id/budget      raise the ceiling (records approval only)
   |  POST /api/budget-workflows/:id/resume      re-evaluate; continue only if policy now allows
   |  POST /api/budget-workflows/:id/stop
   v
Fastify control plane (apps/server/src/app.ts:142-189)
   v
BudgetWorkflowService (apps/server/src/budget/budget-workflow-service.ts)
   |   explicit loop, one task at a time:
   |     deriveBudgetInput  -> reduce tasks to (consumed, completedWeight, remainingWeight)
   |     evaluateBudget     -> ALLOW | WARN | PAUSE | HARD_STOP | COMPLETE
   |     admitsNextTask?    -> if not, settle (pause/complete) and stop
   |     runner.run(task on the workflow's Codex thread)
   |     normalizeUsage(result.usage)   -> UsageRecord | null
   |     persist task usage, write thread id back to workflow AND agent
   |     evaluateBudget again, emit TASK_COMPLETED + FORECAST_UPDATED
   |
   |----> BudgetController (apps/server/src/budget/budget-controller.ts)
   |         pure, import-free decision function. The trust boundary.
   |----> JsonStore (apps/server/src/store.ts)
   |         Database.budgetWorkflows[], Database.budgetEvents[]
   |----> budget events = the audit trail
   |
   |  admitted task only
   v
AgentRunner  (apps/server/src/codex-runner.ts / container-codex-runner.ts)
   |  the SAME runner instance the Playground uses (apps/server/src/index.ts:21)
   v
Codex CLI --json  ->  Volcengine Ark Responses API
   |  turn.completed.usage: input_tokens, cached_input_tokens, output_tokens
   v
parsed by codex-runner.ts:63, normalized by budget/usage.ts, fed back into the forecast
```

### Files added by this submission

| File | Role |
|------|------|
| `apps/server/src/budget/budget-controller.ts` | Pure admission decision. `evaluateBudget(input): BudgetState` returning `ALLOW`/`WARN`/`PAUSE`/`HARD_STOP`/`COMPLETE`; `admitsNextTask`, `canApplyBudget`, weight validation. No imports. |
| `apps/server/src/budget/budget-workflow-service.ts` | The orchestrator. Creates workflows, runs the sequential loop, claims/releases the agent, handles pause/resume/stop/budget-update, writes events. |
| `apps/server/src/budget/usage.ts` | `normalizeUsage(RunUsage): UsageRecord \| null`. Returns `null` (never a zero) when neither input nor output tokens were reported. Excludes cached input from the billable total by subtraction. |
| `apps/server/src/budget/plan-schema.ts` | Zod validation for an operator plan: 1–12 tasks, integer weight 1–10, title and instruction required. Accepts a bare array or a `{ "tasks": [...] }` envelope. Returns errors instead of throwing. |
| `apps/server/src/budget/types.ts` | `BudgetWorkflow`, `PlannedTask`, `BudgetEvent`, and the status/event enums. |
| `apps/server/src/budget/*.test.ts` | `budget-controller.test.ts`, `usage.test.ts`, `plan-schema.test.ts`, `budget-workflow-service.test.ts`, `budget-enforcement.test.ts`, `budget-api.test.ts`. |
| `apps/web/src/BudgetRun.tsx` | The entire browser feature: plan editor, live view, paused-approval panel, event history, polling. |

### Files modified

| File | Change |
|------|--------|
| `apps/server/src/types.ts` | `Database` gains `budgetWorkflows` and `budgetEvents`. |
| `apps/server/src/store.ts` | `withDefaults` defaults the two new arrays on load, so a pre-existing data file still opens. |
| `apps/server/src/agent-service.ts` | Restart sweep marks a `RUNNING` workflow `FAILED` on boot (`:46`); `deleteAgent` removes that agent's workflows and events (`:137`). The existing `busy` guard in `sendMessage` (`:229`) is what stops the Playground from interleaving a turn mid-workflow. |
| `apps/server/src/app.ts` | Seven `/api/budget-workflows` routes plus `GET /api/agents/:id/budget-workflows`. |
| `apps/server/src/index.ts` | Constructs `BudgetWorkflowService` with the **same** runner instance passed to `AgentService`. |
| `apps/web/src/App.tsx`, `api.ts`, `types.ts` | A header toggle and one render line; the API client methods; the shared types. The Playground itself is untouched. |

### The trust boundary

`BudgetController -> AgentRunner`. The browser sends plans and approvals; it never decides whether a task may run. `apps/server/src/budget/budget-enforcement.test.ts` asserts this directly by counting calls on a spy runner: once a workflow is paused, `start` and `resume` do not increase the call count.

---

## 6. Setup and installation

Requirements (from the Starter Kit, unchanged): Node.js 22+, npm 10+, one container engine (Docker, Colima, or Podman), and a Volcengine Ark API key with an endpoint that supports the Responses API. Codex CLI ships in the Runtime image.

### Run the whole thing locally

```bash
npm install
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

`npm run poc` runs `scripts/start-local-poc.sh`, which builds the Runtime image on first run, picks a container engine, and serves the UI at <http://localhost:3000>. State persists between runs under `~/.volc-agent-launchpad/` (macOS) or `.local/` (Linux); override with `LOCAL_POC_DATA_ROOT`.

### Dev mode (two processes, hot reload)

```bash
npm install
cp .env.example .env
npm install --global @openai/codex@0.111.0
npm run dev
```

Web UI on <http://localhost:5173>, API on <http://localhost:3000>. Set local paths in `.env` when running outside Docker:

```dotenv
APP_DATA_DIR=.data
AGENT_WORKSPACE_ROOT=workspaces
CODEX_HOME=codex-home
```

### Validate

```bash
npm run check      # typecheck + tests + build
```

Expected: **65 of 66 tests pass.** The one failure, `apps/server/src/container-codex-runner.test.ts:36`, is a pre-existing Windows-only assertion in the Starter Kit (it hard-codes POSIX paths while `config.codexHome` goes through `path.resolve()`). It is unrelated to this submission and passes on Linux and in Docker. On Windows, `npm run check` will exit non-zero because of it; run `npx vitest run apps/server/src/budget` to see the budget suite alone (green).

To exercise just the middleware:

```bash
npx vitest run apps/server/src/budget
```

---

## 7. Reproducing the demo

There is **no scripted demo** in the repo yet. Use the browser or curl.

### In the browser

1. `npm run poc`, open <http://localhost:3000>.
2. **Create Agent** — give it a name. Use a **fresh agent**: an agent that has been used in the Playground already has a `codexThreadId`, and task 1 will resume that old conversation, which makes the token numbers hard to read.
3. With the agent selected, click **Budgeted run** in the header.
4. The panel opens with a default 4-task `fizzbuzz` plan (weights 1 / 4 / 3 / 2) and a token budget field.
5. **To see a clean completion:** leave the plan as is, set the budget high (e.g. `40000`), click **Start budgeted run**. All four tasks run; status ends `Completed`.
6. **To see the pause:** set the budget low — `4000` is usually enough to force it, because the first real Codex turn on a fresh workspace typically costs more than a 10th of that. Start the run. After task 1 the panel switches to **Projected overrun**, shows consumed / projected total / budget, and offers "Increase budget and resume" or "Stop". The three later tasks stay `PENDING` and the runner is not called again until you resume with a budget the forecast clears.

Exact token counts vary per run, so the precise budget that triggers the pause is not deterministic against a live model. The mechanism is: pause when `projected total > budget`. Set the budget below the projection and it pauses every time.

### With curl

Adapted from `PLAN.md`. Requires `jq`. If `APP_AUTH_TOKEN` is set, add `-H "authorization: Bearer $APP_AUTH_TOKEN"` to each call.

```bash
AGENT=$(curl -sX POST localhost:3000/api/agents \
  -H 'content-type: application/json' \
  -d '{"name":"Runway demo"}' | jq -r .agent.id)

WF=$(curl -sX POST localhost:3000/api/agents/$AGENT/budget-workflows \
  -H 'content-type: application/json' -d '{
    "prompt": "add a health endpoint",
    "tokenBudget": 4000,
    "tasks": [
      {"title":"Inspect","instruction":"List the files in this workspace. Do not modify anything.","weight":1},
      {"title":"Implement","instruction":"Create health.txt containing OK.","weight":4},
      {"title":"Verify","instruction":"Print the contents of health.txt.","weight":3}
    ]}' | jq -r .workflow.id)

curl -sX POST localhost:3000/api/budget-workflows/$WF/start
sleep 20
curl -s localhost:3000/api/budget-workflows/$WF | jq '.workflow.status, .workflow.budgetState'

# When it pauses, raise the budget and resume:
curl -sX POST localhost:3000/api/budget-workflows/$WF/budget \
  -H 'content-type: application/json' -d '{"totalTokenBudget":50000}'
curl -sX POST localhost:3000/api/budget-workflows/$WF/resume
curl -s localhost:3000/api/budget-workflows/$WF | jq '.events[] | {type, reason}'
```

The `events` array is the audit trail: `WORKFLOW_CREATED`, `PLAN_CREATED`, `TASK_STARTED`, `TASK_COMPLETED`, `FORECAST_UPDATED`, `PAUSED`, `BUDGET_UPDATED`, `RESUMED`, then either more tasks or `COMPLETED`.

---

## 8. Limitations

Written from the code, not around it.

### How goal weights are assigned

**Entirely by the operator, by hand.** There is no planner. Weights are integers 1–10, 1–12 tasks per plan, validated by `apps/server/src/budget/plan-schema.ts`. The browser seeds a fixed default plan (`BudgetRun.tsx:13`); the operator edits titles, instructions, and weights freely. An automatic planner that would read the workspace and assign grounded weights is a design goal but is **not built.** The quality of the forecast is therefore bounded by how well the operator guessed the effort split up front. A misjudged weight on task 1 skews every projection after it.

### What "earned" is verified against

**Nothing external.** A task's weight is credited as completed when `runner.run()` returns without throwing and the runner reported token usage (`budget-workflow-service.ts:556`, `deriveBudgetInput` at `:40`). Concretely:

- If Codex exits 0 with a final agent message, the task is `COMPLETED` and earns its **full** weight — whether or not it actually accomplished the instruction. A task told to "add a passing test" that writes a broken test and exits cleanly still earns full weight.
- The middleware does **not** run the test, diff the workspace, or check any condition. Task instructions can *ask* the agent to run a test and report, but that output is not parsed.
- If the runner throws (non-zero exit, timeout, output cap), the task is `FAILED` and the whole workflow is `FAILED`; later tasks do not run.
- If the runner returns but reports **no** token usage, the task is `COMPLETED` but contributes neither cost nor weight to the rate, and the workflow pauses (`pauseForUnmeasuredUsage`, `:609`) rather than treating the absence as zero.

So "earned value" here means "planned weight of tasks the runner finished without error," not "verified working output." This is a deliberate simplification for the prototype: the cost signal does not depend on judging output quality, only on whether a task ran to completion without failing. A stronger version would gate a task's weight on a per-task check command exiting 0, and the plan model has room for it.

### Other limitations

- **Admission, not interruption.** The controller decides *between* tasks. It cannot stop a task already running. A single task can exceed the entire budget; that is caught only afterward, by the hard limit (`consumedTokens >= totalTokenBudget`), on the next evaluation. `buildCodexArgs` passes no max-tokens flag and the model is fixed in static Codex config, so there is no per-turn ceiling to set. `budget-enforcement.test.ts:147` covers this case explicitly.
- **The forecast is linear from a single blended rate.** `consumedTokens / completedWeight` over all completed tasks, extrapolated across remaining weight. One unusually expensive early task dominates the projection. No smoothing prior, no confidence band — both are planned, neither is built.
- **A hard stop is recoverable, not terminal.** `HARD_STOP` and `PAUSE` both land in `PAUSED_BUDGET_APPROVAL`. The operator can raise the budget and resume from either. `STOPPED` means only that a human stopped the run or the agent was withdrawn — never that a budget was hit. This deviates from the original state machine, which made the hard limit terminal.
- **Single agent, sequential.** One workflow, one agent, one Codex thread, one task at a time. The rate calculation assumes a single serial stream; concurrent workflows on separate agents are not supported.
- **Thread state carries over.** `agent.codexThreadId` may already be non-null from prior Playground use, so task 1 resumes whatever thread the agent has. Use a fresh agent for demo runs.
- **`cachedInputTokens` handling is unverified against a real cached turn.** `normalizeUsage` treats cached input as a subset of input and subtracts it from the billable total. The assumption (cached ⊆ input) is clamped defensively but has not been confirmed against a real second-turn Ark response.
- **Persistence is a single JSON file** (`JsonStore`), inherited from the Starter Kit. Fine for a single-user POC, not concurrent-safe beyond its internal mutation queue.
- **No auth on the budget routes beyond the Starter Kit's shared-token check.** Any caller who can reach the API can create, start, and resume workflows.

---

## Appendix: decision reference

`evaluateBudget` (`apps/server/src/budget/budget-controller.ts`) checks, in this fixed order:

1. `remainingWeight === 0` -> `COMPLETE`
2. `hardLimitEnabled && consumedTokens >= totalTokenBudget` -> `HARD_STOP`
3. `completedWeight === 0` -> `ALLOW` (no forecast possible yet)
4. `projectedUtilization > pauseRatio` (default 1.0) -> `PAUSE`
5. `projectedUtilization > warningRatio` (default 0.8) -> `WARN`
6. otherwise -> `ALLOW`

`admitsNextTask` returns true only for `ALLOW` and `WARN`. Projections are rounded before the ratio is formed, so the numbers stored in an event reproduce the decision they justify.
