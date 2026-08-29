import type { BudgetWorkflow } from "./types";

const OUTCOMES: Record<string, { label: string; tone: string }> = {
  COMPLETED: { label: "Completed", tone: "good" },
  PAUSED_BUDGET_APPROVAL: { label: "Awaiting approval", tone: "warning" },
  RUNNING: { label: "Running", tone: "active" },
  READY: { label: "Ready", tone: "active" },
  STOPPED: { label: "Stopped", tone: "critical" },
  FAILED: { label: "Failed", tone: "critical" },
  PLANNING: { label: "Planning", tone: "muted" },
};

const day = (value: string): string =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * Past runs, and what they taught us.
 *
 * The rate column is the point: it is the same tokens-per-work-unit the
 * controller forecasts with, so a spread across runs shows how well any single
 * run's calibration generalises.
 */
export default function BudgetHistory({
  workflows,
  currentId,
  onSelect,
}: {
  workflows: BudgetWorkflow[];
  currentId: string | null;
  onSelect: (id: string) => void;
}) {
  if (workflows.length === 0) return null;

  const measured = workflows.filter(
    (workflow) => workflow.budgetState.observedTokensPerWeight !== null,
  );
  const rates = measured.map(
    (workflow) => workflow.budgetState.observedTokensPerWeight ?? 0,
  );
  const averageRate = rates.length
    ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length
    : null;
  const spent = workflows.reduce(
    (sum, workflow) => sum + workflow.budgetState.consumedTokens,
    0,
  );
  const completed = workflows.filter(
    (workflow) => workflow.status === "COMPLETED",
  ).length;
  const paused = workflows.filter(
    (workflow) => workflow.status === "PAUSED_BUDGET_APPROVAL",
  ).length;

  return (
    <section className="budget-history">
      <div className="budget-head">
        <div>
          <span className="eyebrow">History</span>
          <h2>Past runs on this Agent</h2>
        </div>
        <div className="budget-figures">
          <div>
            <span>Runs</span>
            <strong>{workflows.length}</strong>
          </div>
          <div>
            <span>Completed</span>
            <strong>{completed}</strong>
          </div>
          <div>
            <span>Paused</span>
            <strong>{paused}</strong>
          </div>
          <div>
            <span>Tokens spent</span>
            <strong>{Math.round(spent).toLocaleString()}</strong>
          </div>
          <div>
            <span>Avg rate</span>
            <strong>
              {averageRate === null
                ? "—"
                : Math.round(averageRate).toLocaleString() + " /w"}
            </strong>
          </div>
        </div>
      </div>

      <table className="history-table">
        <thead>
          <tr>
            <th scope="col">Started</th>
            <th scope="col">Outcome</th>
            <th scope="col" className="numeric">Tasks</th>
            <th scope="col" className="numeric">Spent</th>
            <th scope="col" className="numeric">Budget</th>
            <th scope="col" className="numeric">Rate</th>
          </tr>
        </thead>
        <tbody>
          {workflows.map((workflow) => {
            const outcome = OUTCOMES[workflow.status] ?? {
              label: workflow.status,
              tone: "muted",
            };
            const done = workflow.tasks.filter(
              (task) => task.status === "COMPLETED",
            ).length;
            const rate = workflow.budgetState.observedTokensPerWeight;
            return (
              <tr
                key={workflow.id}
                className={workflow.id === currentId ? "history-current" : undefined}
              >
                <td>
                  <button className="history-link" onClick={() => onSelect(workflow.id)}>
                    {day(workflow.createdAt)}
                  </button>
                </td>
                <td>
                  <span className={"outcome outcome-" + outcome.tone}>
                    {outcome.label}
                  </span>
                </td>
                <td className="numeric">
                  {done}/{workflow.tasks.length}
                </td>
                <td className="numeric">
                  {Math.round(workflow.budgetState.consumedTokens).toLocaleString()}
                </td>
                <td className="numeric">
                  {workflow.policy.totalTokenBudget.toLocaleString()}
                </td>
                <td className="numeric">
                  {rate === null ? "—" : Math.round(rate).toLocaleString()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
