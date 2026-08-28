# Agent Runway — Build Plan

Predictive budget-control middleware for the Volc Agent Launchpad.

Hard token limits answer "have I already spent too much?" This answers "can I still
afford to finish?" A trusted backend controller measures real token usage after each
task, re-forecasts the remaining workflow, and decides whether the next task is admitted
— **before** `AgentRunner` is called.

Two stages. Stage 1 builds the rate limiter and nothing else: plans are supplied by the
operator, so the only variable in the system is real token usage. Stage 2 adds the
planner and everything that improves the forecast.

## Progress

**Stage 1 — steps 1–7 of 11 complete.** Next: step 8, enforcement tests.

**The backend is now runnable end to end against real Codex.** Start the POC, create an
agent, then drive a workflow with the six routes below. Step 9 adds the browser UI.

| | Step | State |
| --- | --- | --- |
| 1 | Usage normalizer | Done — 7 tests |
| 2 | BudgetController | Done — 12 tests |
| 3 | Plan schema and workflow model | Done — 9 tests |
| 4 | Store extension and restart recovery | Done — 3 tests |
| 5 | Orchestrator | Done — 7 tests |
| 6 | Agent lock integration | Done — 4 tests |
| 7 | API routes | Done — 4 tests |
| 8 | Enforcement tests | Next |
| 9–11 | UI, hardening, docs | Not started |

58 tests, 57 passing.

## Trying it by hand

```bash
ARK_API_KEY=… ARK_MODEL=ep-… ./scripts/start-local-poc.sh

# Use a FRESH agent — an existing one resumes its old thread and the token
# numbers stop being legible.
AGENT=$(curl -sX POST localhost:3000/api/agents \
  -H 'content-type: application/json' \
  -d '{"name":"Runway demo"}' | jq -r .agent.id)

WF=$(curl -sX POST localhost:3000/api/agents/$AGENT/budget-workflows \
  -H 'content-type: application/json' -d '{
    "prompt": "add a health endpoint",
    "tokenBudget": 10000,
    "tasks": [
      {"title":"Inspect","instruction":"List the files in this workspace. Do not modify anything.","weight":1},
      {"title":"Implement","instruction":"Create health.txt containing OK.","weight":4},
      {"title":"Verify","instruction":"Print the contents of health.txt.","weight":3}
    ]}' | jq -r .workflow.id)

curl -sX POST localhost:3000/api/budget-workflows/$WF/start
curl -s localhost:3000/api/budget-workflows/$WF | jq '.workflow.budgetState, .workflow.status'

# When it pauses:
curl -sX POST localhost:3000/api/budget-workflows/$WF/budget \
  -H 'content-type: application/json' -d '{"totalTokenBudget":50000}'
curl -sX POST localhost:3000/api/budget-workflows/$WF/resume
curl -s localhost:3000/api/budget-workflows/$WF | jq '.events[] | {type, reason}'
```

**Check on the first real run:** whether `cachedInputTokens` on turn 2+ is a subset of
`inputTokens`. If it ever exceeds it, the step 1 subtraction is wrong and the clamp is
hiding it.

Known issue: `npm run check` fails on Windows only, in a pre-existing test
(`container-codex-runner.test.ts:36`) that hardcodes POSIX paths while `config.codexHome`
goes through `path.resolve()`. Unrelated to this work; passes on Linux and in Docker.

---

## Already in the repo — do not rebuild

Verified against the current tree. These were the plan's biggest assumed risks and they
are already solved:

| Capability | Where |
| --- | --- |
| Token usage capture | `apps/server/src/codex-runner.ts:63-76` parses `turn.completed.usage`; flows through `RunnerResult.usage` and is persisted at `agent-service.ts:260` |
| Persistent Codex sessions | `Agent.codexThreadId` (`types.ts:12`) → passed in at `agent-service.ts:251` → becomes `codex exec resume <id>` at `codex-runner.ts:36-40` |
| Async run pattern | `sendMessage` returns immediately; `executeRun` detaches (`agent-service.ts:204-213`) |
| Fake runner test harness | `agent-service.test.ts:11-25` already implements `AgentRunner` |
| Sandbox mode as a parameter | `buildCodexArgs(request, sandboxMode, workspacePath)` — both runners call it (`container-codex-runner.ts:87`) |

Usage capture is Option A from the original spike list. The Stage 0 spike is complete;
skip it.

---

## Decisions already made

These are settled. Revisit only with a reason.

- **Operator-supplied plans for the MVP.** The middleware is the product, not the
  planner. A hand-written weighted plan removes the only source of nondeterminism and
  makes the overrun demo reproducible by construction. It stays a permanent feature, not
  a test fixture — the system takes a weighted plan from a human *or* a planner and
  trusts neither.
- **Single agent, sequential.** One workflow, one agent, one thread, one task at a time.
- **Planner and executor share a thread** (Stage 2), so task 1 inherits what the planner
  learned about the repo instead of paying to re-read it.
- **Planner runs read-only** (Stage 2) via a per-request sandbox override.
- **Planning is excluded from the budget** (Stage 2), shown as its own line in the UI.
- **`cachedInputTokens` is excluded from the total** but stored. Cached input is billed
  at a discount, and a shared thread makes it grow steadily.
- **JSON extraction strategy** (Stage 2): last fenced block → balanced-brace fallback →
  Zod validation → one retry quoting the validation error → FAILED.

---

## Stage 1 — The rate limiter

**Goal:** an operator-supplied weighted plan executes sequentially on one Codex thread.
Usage is measured after every task, and the next task is denied before the runner is
called when the forecast exceeds budget.

Steps are dependency-ordered. Each has a testable exit gate.

### 1. Usage normalizer

`apps/server/src/budget/usage.ts`

`RunUsage` has three *optional* fields and no total. Every forecast divides by this
number, so an `undefined` quietly coerced to `0` corrupts every decision downstream.

- [x] Define `UsageRecord { inputTokens, outputTokens, totalTokens }`
- [x] `normalizeUsage(RunUsage | null): UsageRecord | null` — returns **null**, never
      zero, when both counts are absent
- [x] Exclude `cachedInputTokens` from the total; store it separately
- [x] Tests: complete, partial, empty, null

`cachedInputTokens` is a *subset* of `inputTokens`, so exclusion means subtraction:
`billableInputTokens = inputTokens - cachedInputTokens` (floored at zero), and
`totalTokens = billableInputTokens + outputTokens`. The record keeps all four numbers, so
the assumption is reversible in one line. **Still unverified against a real cached turn** —
check it on the first second-turn in step 5.

**Exit:** a real runner result yields either a trustworthy number or an explicit null.

### 2. BudgetController — core

`apps/server/src/budget/budget-controller.ts`

The trusted decision point, and the one component the entire demo rests on. Pure — no
I/O, no store, no async — so it is completely testable before anything else exists.

- [x] Types: `TokenBudgetPolicy`, `BudgetState`, `BudgetDecision`
- [x] `evaluate()` in strict order — see the ordering note below
- [x] Weight validation: integers, 1–10
- [x] Eight unit tests: first task, under budget, warn band, predictive pause, hard stop,
      complete, invalid weights, budget floor

**Ordering deviation:** `COMPLETE` is checked *before* `HARD_STOP`, not after. A workflow
that finishes all its work having spent exactly its budget would otherwise report
`HARD_STOP` and be marked as stopped rather than completed. Nothing is admitted either
way — there is no task left — so it costs no safety. This relies on weights being ≥ 1,
which makes `remainingWeight === 0` equivalent to "no pending tasks"; a test pins that.

`admitsNextTask(decision)` is the orchestrator's only question: `ALLOW` and `WARN` admit,
`PAUSE` / `HARD_STOP` / `COMPLETE` do not. Projections are rounded *before* the ratio is
computed, so the numbers in an event always reproduce the decision they justify.

**Exit:** every forecast test passes against a controller that has never touched a
database.

### 3. Plan schema and workflow model

`apps/server/src/budget/plan-schema.ts`, `apps/server/src/budget/types.ts`

The same Zod schema validates operator input now and planner output later. Writing it
once is what makes Stage 2 additive instead of a refactor.

- [x] Schema: 1–12 tasks, integer weight 1–10, title and instruction both required
- [x] Model `BudgetWorkflow`, `PlannedTask`, `BudgetEvent` and the status enums
- [x] Keep `PLANNING` in the enum though nothing sets it yet

`parsePlan()` returns errors rather than throwing — a route needs them for a 400, and the
Stage 2 planner retry quotes them back to the model. It accepts a bare array *or* the
`{ "tasks": [...] }` envelope, so one validator serves both sources. Errors name the exact
task and field (`tasks[1].weight: weight must be at least 1`) and report in one pass.

Two event types were added beyond the original spec — `TASK_FAILED` and `FAILED` — because
step 10 requires failures to be recorded and the original list could not express them.

Deferred deliberately: `planningTokens` on the workflow (Stage 2, and the store defaults
new fields on load), and deriving weights from a workflow's tasks (step 5, where it is
used).

**Exit:** a malformed plan is rejected with a message naming the task and the field.

### 4. Store extension and restart recovery

`apps/server/src/types.ts`, `store.ts`, `agent-service.ts`

A paused workflow has to survive a restart. `initialize()` validates only the version and
the agents array (`store.ts:23`), so a new field loads as `undefined` and the first push
throws on any existing data file.

- [ ] Add `budgetWorkflows` and `budgetEvents` to `Database`
- [ ] Default both arrays on load
- [ ] Extend the restart sweep (`agent-service.ts:32-46`): running workflows become
      failed, paused stays paused, nothing auto-resumes
- [ ] Store test covering round-trip and loading a pre-migration file

**Exit:** kill the server mid-workflow, restart it, and state is intact with nothing
running.

### 5. Orchestrator — core

`apps/server/src/budget/budget-workflow-service.ts`

Where enforcement physically sits — an explicit loop, not recursion, with the controller
consulted between every pair of tasks.

- [x] `create()` validates the supplied plan, persists it, lands in `READY`
- [x] `runUntilBlocked()`: evaluate → mark running → call runner with thread id →
      normalize usage → persist → recalculate → emit → repeat
- [x] Exit the loop on completion, pause, hard stop, task failure, or stop request
- [x] Write the thread id back after each task (mirroring `agent-service.ts:271`)
- [x] Refuse re-entry while a task is already running

`deriveBudgetInput()` (deferred from step 3) reduces a workflow's tasks to the three
numbers the controller decides on. A completed task whose usage was never reported
contributes **neither cost nor weight**, so the observed rate stays a ratio of measured
tokens to measured work rather than being diluted by work nobody could price.

**Pulled forward from step 10:** a task that completes without reported usage pauses the
workflow instead of being treated as free. Building it later would have meant building on
a silently under-counting foundation. Resume still works — the unmeasured task is excluded
from the rate, so an operator who approves continuation gets an honest forecast from
whatever was measured.

The thread id is written back to both the workflow (for audit) and the agent (so the
Playground stays on the same conversation), matching existing runner behaviour.

**Exit:** a four-task workflow runs to completion on one thread with usage recorded per
task.

### 6. Agent lock integration

`apps/server/src/agent-service.ts`

The Playground and a workflow share one thread and one agent. Without a deliberate lock
they race each other and token accounting silently loses turns.

- [x] The workflow marks the agent busy for its duration, releasing on pause, stop,
      completion, or failure
- [x] Return 409 if the agent is already busy when a workflow starts
- [x] Detach the loop so the HTTP handler returns immediately

`start()` claims the agent (awaited, so a second caller is rejected rather than racing)
then runs the loop detached. `runUntilBlocked()` is `start()` plus awaiting the loop, for
tests. Release sets the agent `ready`, or `error` with the task's message on failure, and
never resurrects an agent a concurrent `stopAgent` has stopped.

Claim order matters: the "our own loop already holds it" case is checked **before** the
stale-running-task guard, otherwise re-entry trips over the task the workflow is itself
running.

Also added here: `stop()`; the loop aborts if the agent is stopped mid-workflow (the
operator withdrew the runtime); and `deleteAgent` now removes that agent's workflows and
events rather than orphaning them.

**Exit:** a Playground turn cannot interleave mid-workflow, and starting a run does not
block the request.

### 7. API routes

`apps/server/src/app.ts`

The browser must never hold state that decides admission.

- [x] `POST /api/agents/:id/budget-workflows` — body carries `tasks[]`
- [x] `POST /api/budget-workflows/:id/start`
- [x] `GET /api/budget-workflows/:id` — status, tasks, budget, forecast, events
- [x] `POST /api/budget-workflows/:id/budget` — validates new budget ≥ consumed, emits
      `BUDGET_UPDATED`
- [x] `POST /api/budget-workflows/:id/resume` — **re-evaluates**, never trusts the
      earlier approval
- [x] `POST /api/budget-workflows/:id/stop`
- [x] Zod bodies matching existing `app.ts` conventions

Also added: `GET /api/agents/:id/budget-workflows` to list an agent's runs, for the UI.

Budget update and resume are deliberately **separate acts**. Raising the budget records an
approval and re-forecasts, but admits nothing; resume recomputes from current measurements
against the current budget and continues only if policy now permits. Raising the budget by
too little leaves the workflow paused — there is an API test for exactly that.

`index.ts` passes the **same runner instance** to both services, so the Playground and a
budgeted workflow contend for one agent instead of quietly running two turns on one thread.

**Exit:** the whole lifecycle is drivable from curl, with no UI in the loop.

### 8. Enforcement tests — proof

`apps/server/src/budget/budget-workflow-service.test.ts`

The product claim is that a paused workflow cannot reach the runner. This is the test
that proves it, and the reason to spy rather than assert on status alone.

- [ ] Paused workflow → start and resume → runner spy records **zero** calls
- [ ] Raise the budget, resume → runner called only if policy now allows
- [ ] A stopped workflow never calls the runner
- [ ] Usage stored, forecast recalculated, events emitted in order
- [ ] API-level: malformed budget, resume after completion, duplicate start

**Exit:** `npm run test` is the evidence that the trust boundary holds.

### 9. Minimum UI

`apps/web/src/App.tsx`, `api.ts`, `types.ts`

The paused state is the demo. Everything else can be plain numbers.

- [ ] Budget field plus an editable task list — title, instruction, weight
- [ ] Consumed, projected total, status
- [ ] Per-task token counts as they land
- [ ] Paused panel: the four numbers, the reason, and the two buttons
- [ ] Event history
- [ ] Poll the workflow endpoint using the existing run-polling pattern

**Exit:** a viewer who has never seen the code can read why the run stopped.

### 10. Failure handling

`apps/server/src/budget/budget-workflow-service.ts`

A single silent path around the controller voids the entire claim.

- [ ] Missing usage pauses with a stated reason — never treated as zero
- [ ] A failed task fails the workflow; later tasks do not run
- [ ] The hard limit is enforced on actual consumption, independent of the forecast
- [ ] Nothing auto-resumes after a restart

**Exit:** `npm run check` passes — typecheck, tests, and build.

### 11. Demo fixtures and documentation

`README.md`, `docs/`

A hand-set plan makes the overrun reproducible by construction. Underweight task one
against its real cost and the pause fires every time.

- [ ] Demo A completes inside budget; Demo B pauses before task two
- [ ] Use a fresh agent so the thread starts clean and token numbers are legible
- [ ] README: problem, architecture, and the honest limitations
- [ ] One-page diagram with the trust boundary drawn between controller and runner

**Exit:** someone else can clone the repo and reproduce both demos from the README.

---

## Stage 1 definition of done

A weighted plan runs sequentially on one thread, real usage is recorded per task, the
forecast updates after each one, an under-budget run continues on its own, an
over-budget forecast pauses before the runner is called, the pause survives a restart,
raising the budget and resuming re-evaluates policy, every decision is an event, and a
test proves a paused workflow cannot reach the runner.

Steps 2, 5 and 8 are the product. The rest is plumbing around them.

---

## Stage 2 — Improvements

Ranked by value, not sequenced. None are on the critical path; each is independently
shippable and assumes Stage 1 is green.

### Planner

Replaces the operator plan with a Codex turn that reads the workspace before estimating.
Grounded weights are the single biggest lever on forecast quality — a blind planner
guesses effort from prompt text alone.

- [ ] `Planner` interface + `MockPlanner` for deterministic tests
- [ ] `CodexPlanner` on the same thread as execution
- [ ] Read-only sandbox: add optional `sandboxMode` to `RunnerRequest` and thread it
      through `buildCodexArgs` (already a parameter; both runners call it)
- [ ] Extraction: last fenced block → balanced-brace fallback → Zod → one retry quoting
      the validation error → FAILED
- [ ] Planning excluded from the budget, shown as its own line
- [ ] Shorter timeout than the ten-minute `CODEX_TIMEOUT_MS` default
- [ ] Create without `tasks[]` plans; create with `tasks[]` stays manual — both paths
      permanent

The planner never sees the budget. If it knows the ceiling it will shrink weights to fit
and the forecast becomes self-fulfilling.

### Smoothing prior

One unusually expensive first task currently dominates the whole forecast.

- [ ] Blend a prior rate and prior weight into the observed rate
- [ ] Seed the prior from completed workflows on the same agent

*Depends on nothing — pure controller change.*

### Confidence band

Turns a single projected number into a range, so a borderline run warns instead of
silently proceeding.

- [ ] Heuristic multipliers that tighten as more tasks complete
- [ ] Allow when both expected and upper fit; warn when only expected does
- [ ] Label it heuristic — it is not a calibrated interval

*Depends on nothing — pure controller change.*

### Replanning

A third option at the pause besides raising the budget or stopping.

- [ ] Send objective, completed work, remaining work, remaining budget
- [ ] Record the revision as an event with old and new remaining weight
- [ ] Re-evaluate before resuming — replanning never bypasses the controller

*Blocked on the planner.*

### Per-call ceiling

Today a single admitted task can exceed the whole budget; the hard limit only catches it
afterward.

- [ ] Needs a max-tokens knob that Codex and the model config do not currently expose
- [ ] Until then, the turn timeout and output-byte cap are the only per-turn bounds

*Blocked on provider capability.*

### Shared budget pool

Several agents drawing on one budget. A genuinely different system, not a bigger version
of this one.

- [ ] The rate calculation breaks once streams spend concurrently
- [ ] Admission becomes allocation — which agent gets paused
- [ ] Check-then-execute turns racy; needs a lock and per-workflow attribution

The enforcement *boundary* survives; the controller *signature* does not.

### Other budget dimensions

- [ ] Dollar budgets via per-model pricing
- [ ] Wall-clock and tool-call ceilings
- [ ] Several dimensions evaluated together, pausing on whichever binds first

### Cross-run analytics

- [ ] Observed rate per task category over time
- [ ] Forecast accuracy: predicted total against actual, per run
- [ ] Feeds the smoothing prior with real history

---

## Limitations to document

Write these into the README rather than discovering them on day three.

- **Admission, not interruption.** The controller admits tasks; it cannot stop one
  already in flight. A single task can exceed the budget, caught only afterward by the
  hard limit. `buildCodexArgs` passes no max-tokens flag and the model is fixed in static
  TOML, so there is no per-turn ceiling to configure.
- **Single agent, sequential.** The rate calculation assumes one serial stream.
  Concurrent workflows on separate agents each need their own budget.
- **Planning cost is not cleanly separable.** Once the planner shares the execution
  thread, its exploration stays in context and inflates input tokens on every later turn.
  Stage 2 excludes the planning *turn*, not planning's *cost*.
- **Thread state carries over.** `agent.codexThreadId` may already be non-null from prior
  Playground use, so task 1 resumes whatever thread the agent has. Use a fresh agent for
  demo runs.

---

## Architecture

```text
Browser
   |
   v
Fastify control plane
   |
   +--> BudgetWorkflowService
   |        |
   |        +--> BudgetController   <-- trusted decision: ALLOW / WARN / PAUSE / HARD_STOP
   |        +--> WorkflowStore
   |        +--> Budget events
   |
   |   admitted task only
   v
AgentRunner  (persistent Codex session)
   |
   v
Codex / ModelArk
   |
   |  UsageRecord
   v
Forecast recalculated
```

The trust boundary is `BudgetController → AgentRunner`. The browser never decides
whether a task may execute.
