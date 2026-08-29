import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import BudgetChart from "./BudgetChart";
import BudgetHistory from "./BudgetHistory";
import type {
  Agent,
  BudgetEvent,
  BudgetWorkflow,
  PlannedTask,
  TaskDraft,
} from "./types";

const LIVE_STATUSES = ["RUNNING"];

const defaultPlan: TaskDraft[] = [
  {
    title: "Inspect workspace",
    instruction:
      "List the files in this workspace and summarise in two sentences what is here. Do not create or modify anything.",
    weight: 1,
  },
  {
    title: "Implement fizzbuzz",
    instruction:
      "Create fizzbuzz.js exporting a function fizzbuzz(n) that returns 'Fizz' for multiples of 3, 'Buzz' for multiples of 5, 'FizzBuzz' for both, and otherwise the number as a string.",
    weight: 4,
  },
  {
    title: "Add tests",
    instruction:
      "Create fizzbuzz.test.js using node:test and node:assert covering the four cases of the function you just wrote, then run it with 'node --test'.",
    weight: 3,
  },
  {
    title: "Report",
    instruction:
      "Print the final contents of fizzbuzz.js and state whether the tests passed.",
    weight: 2,
  },
];

const tokens = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : Math.round(value).toLocaleString();

const taskMark: Record<PlannedTask["status"], string> = {
  COMPLETED: "✓",
  RUNNING: "",
  PENDING: "○",
  FAILED: "✕",
  SKIPPED: "–",
};

function TaskMark({ status }: { status: PlannedTask["status"] }) {
  if (status === "RUNNING") {
    return <span className="spinner" role="status" aria-label="Task running" />;
  }
  return <span aria-hidden="true">{taskMark[status]}</span>;
}

function statusLabel(workflow: BudgetWorkflow): string {
  switch (workflow.status) {
    case "PAUSED_BUDGET_APPROVAL":
      return workflow.budgetState.decision === "HARD_STOP"
        ? "Budget spent"
        : "Projected overrun";
    case "RUNNING":
      return workflow.budgetState.decision === "WARN" ? "Approaching budget" : "On track";
    case "READY":
      return "Ready";
    case "COMPLETED":
      return "Completed";
    case "STOPPED":
      return "Stopped";
    case "FAILED":
      return "Failed";
    default:
      return workflow.status;
  }
}

export default function BudgetRun({
  agent,
  onAgentChanged,
}: {
  agent: Agent;
  onAgentChanged: () => void;
}) {
  const [workflow, setWorkflow] = useState<BudgetWorkflow | null>(null);
  const [history, setHistory] = useState<BudgetWorkflow[]>([]);
  const [events, setEvents] = useState<BudgetEvent[]>([]);
  const [draft, setDraft] = useState<TaskDraft[]>(defaultPlan);
  const [budgetInput, setBudgetInput] = useState("20000");
  const [planMode, setPlanMode] = useState<"planner" | "manual">("planner");
  const [objective, setObjective] = useState("");
  const [increaseInput, setIncreaseInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (workflowId: string) => {
    const result = await api.budgetWorkflow(workflowId);
    if (!mounted.current) return result.workflow;
    setWorkflow(result.workflow);
    setEvents(result.events);
    return result.workflow;
  }, []);

  const refreshHistory = useCallback(async () => {
    const result = await api.budgetWorkflows(agent.id);
    if (mounted.current) setHistory(result.workflows);
    return result.workflows;
  }, [agent.id]);

  // Pick up the agent's most recent run, so a reload lands back on a paused run.
  useEffect(() => {
    setWorkflow(null);
    setEvents([]);
    setError(null);
    void refreshHistory()
      .then((workflows) => {
        const latest = workflows[0];
        if (latest && mounted.current) void load(latest.id);
      })
      .catch(() => undefined);
  }, [refreshHistory, load]);

  // Poll only while the backend can still change state on its own.
  useEffect(() => {
    if (!workflow || !LIVE_STATUSES.includes(workflow.status)) return;
    const timer = window.setInterval(() => {
      void load(workflow.id)
        .then((updated) => {
          onAgentChanged();
          if (!LIVE_STATUSES.includes(updated.status)) {
            void refreshHistory().catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [workflow, load, onAgentChanged, refreshHistory]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onAgentChanged();
      await refreshHistory().catch(() => undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const startRun = () =>
    act(async () => {
      const created = await api.createBudgetWorkflow(agent.id, {
        prompt: "Budgeted run for " + agent.name,
        tokenBudget: Number(budgetInput),
        tasks: draft,
      });
      await api.startBudgetWorkflow(created.workflow.id);
      await load(created.workflow.id);
    });

  const generatePlan = () =>
    act(async () => {
      const created = await api.createBudgetWorkflow(agent.id, {
        prompt: objective,
        tokenBudget: Number(budgetInput),
      });
      await load(created.workflow.id);
    });

  const startReadyWorkflow = () =>
    act(async () => {
      if (!workflow) return;
      await api.startBudgetWorkflow(workflow.id);
      await load(workflow.id);
    });

  const regeneratePlan = () =>
    act(async () => {
      if (!workflow) return;
      await api.stopBudgetWorkflow(workflow.id);
      const created = await api.createBudgetWorkflow(agent.id, {
        prompt: workflow.originalPrompt,
        tokenBudget: workflow.policy.totalTokenBudget,
      });
      await load(created.workflow.id);
    });

  const approve = () =>
    act(async () => {
      if (!workflow) return;
      await api.setBudget(workflow.id, Number(increaseInput));
      await api.resumeBudgetWorkflow(workflow.id, true);
      await load(workflow.id);
      setIncreaseInput("");
    });

  const forceNextTask = () =>
    act(async () => {
      if (!workflow) return;
      await api.resumeBudgetWorkflow(workflow.id, true);
      await load(workflow.id);
    });

  const stopRun = () =>
    act(async () => {
      if (!workflow) return;
      await api.stopBudgetWorkflow(workflow.id);
      await load(workflow.id);
    });

  const newRun = () => {
    setWorkflow(null);
    setEvents([]);
    setError(null);
  };

  // An Agent left in `error` or `stopped` by earlier work cannot accept a task.
  // Starting it clears the status and the stored error in one call.
  const readyAgent = () => act(() => api.startAgent(agent.id));

  const totalWeight = draft.reduce((sum, task) => sum + task.weight, 0);

  if (!workflow) {
    return (
      <>
      <section className="budget-panel">
        <div className="budget-head">
          <div>
            <span className="eyebrow">Budgeted run</span>
            <h2>Plan the work, then set a ceiling</h2>
          </div>
        </div>
        <p className="budget-lede">
          Weights are relative effort, not token estimates. After each task the middleware
          measures what was actually spent and re-forecasts the rest of the plan.
        </p>

        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}

        {agent.status !== "ready" && (
          <div className="agent-gate">
            <div>
              <strong>
                {agent.status === "busy"
                  ? "This Agent is already running something."
                  : agent.status === "stopped"
                    ? "This Agent is stopped."
                    : "This Agent stopped with an error."}
              </strong>
              {agent.lastError && <span>{agent.lastError}</span>}
            </div>
            {agent.status !== "busy" && (
              <button
                className="button button-primary"
                onClick={readyAgent}
                disabled={busy}
              >
                Make ready
              </button>
            )}
          </div>
        )}

        <label className="budget-field">
          <span>Token budget</span>
          <input
            type="number"
            min={1}
            value={budgetInput}
            onChange={(event) => setBudgetInput(event.target.value)}
          />
        </label>

        <div className="plan-mode" role="group" aria-label="Planning method">
          <button className={"button " + (planMode === "planner" ? "button-primary" : "button-ghost")} onClick={() => setPlanMode("planner")}>Generate plan</button>
          <button className={"button " + (planMode === "manual" ? "button-primary" : "button-ghost")} onClick={() => setPlanMode("manual")}>Manual plan</button>
        </div>

        {planMode === "planner" && (
          <div className="planner-input">
            <label>
              <span>What should the workflow accomplish?</span>
              <textarea rows={4} value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Describe the feature or change to plan." />
            </label>
            <button className="button button-primary" onClick={generatePlan} disabled={busy || agent.status !== "ready" || !objective.trim() || !Number(budgetInput)}>
              {busy ? "Planning…" : "Generate plan"}
            </button>
          </div>
        )}

        <div className={"plan-editor" + (planMode === "manual" ? "" : " is-hidden")}>
          {draft.map((task, index) => (
            <div className="plan-row" key={index}>
              <input
                className="plan-title"
                value={task.title}
                onChange={(event) =>
                  setDraft((rows) =>
                    rows.map((row, position) =>
                      position === index ? { ...row, title: event.target.value } : row,
                    ),
                  )
                }
              />
              <input
                className="plan-weight"
                type="number"
                min={1}
                max={10}
                value={task.weight}
                onChange={(event) =>
                  setDraft((rows) =>
                    rows.map((row, position) =>
                      position === index
                        ? { ...row, weight: Number(event.target.value) }
                        : row,
                    ),
                  )
                }
              />
              <textarea
                className="plan-instruction"
                rows={2}
                value={task.instruction}
                onChange={(event) =>
                  setDraft((rows) =>
                    rows.map((row, position) =>
                      position === index
                        ? { ...row, instruction: event.target.value }
                        : row,
                    ),
                  )
                }
              />
              <button
                className="button button-ghost plan-remove"
                onClick={() =>
                  setDraft((rows) => rows.filter((_, position) => position !== index))
                }
                disabled={draft.length <= 1}
                aria-label={"Remove task " + (index + 1)}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className={"budget-actions" + (planMode === "manual" ? "" : " is-hidden")}>
          <button
            className="button button-ghost"
            onClick={() =>
              setDraft((rows) => [
                ...rows,
                { title: "New task", instruction: "Describe the work.", weight: 1 },
              ])
            }
            disabled={draft.length >= 12}
          >
            Add task
          </button>
          <span className="budget-total">Total weight {totalWeight}</span>
          <button
            className="button button-primary"
            onClick={startRun}
            disabled={busy || agent.status !== "ready" || !Number(budgetInput)}
          >
            Start budgeted run
          </button>
        </div>
      </section>
      <BudgetHistory
        workflows={history}
        currentId={null}
        onSelect={(id) => void load(id).catch(() => undefined)}
      />
      </>
    );
  }

  const state = workflow.budgetState;
  const budget = workflow.policy.totalTokenBudget;
  const paused = workflow.status === "PAUSED_BUDGET_APPROVAL";

  return (
    <>
    <section className={"budget-panel" + (paused ? " budget-panel-paused" : "")}>
      <div className="budget-head">
        <div>
          <span className="eyebrow">Budgeted run</span>
          <h2>{statusLabel(workflow)}</h2>
        </div>
        <div className="budget-figures">
          <div>
            <span>Consumed</span>
            <strong>{tokens(state.consumedTokens)}</strong>
          </div>
          <div>
            <span>Projected total</span>
            <strong>{tokens(state.projectedTotalTokens)}</strong>
          </div>
          <div>
            <span>Budget</span>
            <strong>{tokens(budget)}</strong>
          </div>
        </div>
      </div>

      <BudgetChart workflow={workflow} events={events} />
      <p className="budget-reason">{state.reason}</p>

      {workflow.planSource === "PLANNER" && workflow.status === "READY" && (
        <div className="planner-review">
          <div className="planner-review-head">
            <div>
              <span className="eyebrow">Generated plan</span>
              <strong>Review before execution</strong>
            </div>
            <span>{tokens(workflow.planningUsage?.totalTokens)} planning tokens · excluded from budget</span>
          </div>
          <pre>{JSON.stringify({ tasks: workflow.tasks.map(({ title, instruction, weight }) => ({ title, instruction, weight })) }, null, 2)}</pre>
          <div className="budget-actions">
            <button className="button button-ghost" onClick={newRun}>Cancel</button>
            <button className="button" onClick={regeneratePlan} disabled={busy || agent.status !== "ready"}>Regenerate plan</button>
            <button className="button button-primary" onClick={startReadyWorkflow} disabled={busy || agent.status !== "ready"}>Start workflow</button>
          </div>
        </div>
      )}

      {workflow.planSource === "PLANNER" && workflow.status === "FAILED" && workflow.planningError && (
        <div className="error-banner" role="alert">Planning failed: {workflow.planningError}</div>
      )}

      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      {paused && (
        <div className="approval-panel">
          <h3>The next task has not been started.</h3>
          <dl className="approval-figures">
            <div>
              <dt>Configured budget</dt>
              <dd>{tokens(budget)}</dd>
            </div>
            <div>
              <dt>Consumed</dt>
              <dd>{tokens(state.consumedTokens)}</dd>
            </div>
            <div>
              <dt>Projected remaining</dt>
              <dd>{tokens(state.projectedRemainingTokens)}</dd>
            </div>
            <div>
              <dt>Projected total</dt>
              <dd>{tokens(state.projectedTotalTokens)}</dd>
            </div>
          </dl>
          <div className="approval-actions">
            <input
              type="number"
              min={Math.max(state.consumedTokens, budget) + 1}
              placeholder={"New budget, above " + tokens(Math.max(state.consumedTokens, budget))}
              value={increaseInput}
              onChange={(event) => setIncreaseInput(event.target.value)}
            />
            <button
              className="button button-primary"
              onClick={approve}
              disabled={busy || Number(increaseInput) <= Math.max(state.consumedTokens, budget)}
            >
              Increase budget and resume
            </button>
            {state.decision === "PAUSE" && (
              <button className="button" onClick={forceNextTask} disabled={busy}>
                Run next task anyway
              </button>
            )}
            <button className="button button-danger" onClick={stopRun} disabled={busy}>
              Stop
            </button>
          </div>
        </div>
      )}

      <ol className="budget-tasks">
        {workflow.tasks.map((task, index) => (
          <li key={task.id} className={"budget-task budget-task-" + task.status}>
            <span className="budget-task-mark">
              <TaskMark status={task.status} />
            </span>
            <span className="budget-task-weight">W{index + 1}</span>
            <span className="budget-task-title">
              {task.title}
              <small>{task.weight} weight {task.weight === 1 ? "unit" : "units"}</small>
            </span>
            <span className="budget-task-usage">
              {task.usage ? tokens(task.usage.totalTokens) + " tokens" : ""}
              {task.error ? task.error : ""}
            </span>
          </li>
        ))}
      </ol>

      <details className="budget-events">
        <summary>Decision history ({events.length})</summary>
        <ol>
          {events.map((event) => (
            <li key={event.id}>
              <strong>{event.type}</strong>
              {event.reason ? <span>{event.reason}</span> : null}
            </li>
          ))}
        </ol>
      </details>

      <div className="budget-actions">
        {!LIVE_STATUSES.includes(workflow.status) && workflow.status !== "READY" && !paused && (
          <button className="button button-ghost" onClick={newRun}>
            Plan another run
          </button>
        )}
        {workflow.status === "RUNNING" && (
          <button className="button button-danger" onClick={stopRun} disabled={busy}>
            Stop
          </button>
        )}
      </div>
    </section>
    <BudgetHistory
      workflows={history}
      currentId={workflow.id}
      onSelect={(id) => void load(id).catch(() => undefined)}
    />
    </>
  );
}
