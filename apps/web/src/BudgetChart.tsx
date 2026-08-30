import { useState } from "react";
import type { BudgetEvent, BudgetWorkflow } from "./types";

/**
 * Cumulative token spend against planned work.
 *
 * X is work units rather than time, because that is the unit the forecast is
 * calibrated in: the slope of this line *is* the observed tokens-per-work-unit.
 * The dashed continuation carries that slope forward over the remaining plan,
 * so an overrun is visible as a line crossing the budget before the work ends.
 */

const WIDTH = 780;
const HEIGHT = 260;
const PAD = { top: 22, right: 126, bottom: 52, left: 68 };

const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

const compact = (value: number): string =>
  value >= 1_000 ? Math.round(value / 100) / 10 + "k" : String(Math.round(value));

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

interface Point {
  weight: number;
  tokens: number;
  title: string;
}

export default function BudgetChart({
  workflow,
  events,
}: {
  workflow: BudgetWorkflow;
  events: BudgetEvent[];
}) {
  const [hoverTaskIndex, setHoverTaskIndex] = useState<number | null>(null);

  const state = workflow.budgetState;
  const budget = workflow.policy.totalTokenBudget;
  const totalWeight = workflow.tasks.reduce((sum, task) => sum + task.weight, 0);

  // Cumulative spend at each measured task, and every task boundary for the axis.
  const points: Point[] = [{ weight: 0, tokens: 0, title: "Start" }];
  const boundaries: Array<{
    startWeight: number;
    weight: number;
    title: string;
    measured: boolean;
  }> = [];
  let weight = 0;
  let tokens = 0;
  for (const task of workflow.tasks) {
    const startWeight = weight;
    weight += task.weight;
    const measuredTask = task.status === "COMPLETED" && task.usage !== null;
    if (measuredTask && task.usage) {
      tokens += task.usage.totalTokens;
      points.push({ weight, tokens, title: task.title });
    }
    boundaries.push({ startWeight, weight, title: task.title, measured: measuredTask });
  }

  const measured = points.length > 1;
  const projectedTotal = state.projectedTotalTokens;
  const rate = state.observedTokensPerWeight;
  const yMax = Math.max(budget, projectedTotal ?? 0, state.consumedTokens, 1) * 1.12;
  const xMax = Math.max(totalWeight, 1);

  const x = (value: number) => PAD.left + (value / xMax) * PLOT_W;
  const y = (value: number) => PAD.top + PLOT_H - (value / yMax) * PLOT_H;
  const segmentTitle = (boundary: (typeof boundaries)[number]): string => {
    const pixelWidth = x(boundary.weight) - x(boundary.startWeight);
    const availableCharacters = Math.max(4, Math.floor((pixelWidth - 10) / 4.8));
    return boundary.title.length > availableCharacters
      ? boundary.title.slice(0, Math.max(1, availableCharacters - 1)) + "…"
      : boundary.title;
  };

  const actualPath = points.map((p) => x(p.weight) + "," + y(p.tokens)).join(" ");
  const last = points[points.length - 1] ?? { weight: 0, tokens: 0 };
  const overBudget = (projectedTotal ?? 0) > budget;

  const gridValues = [0.25, 0.5, 0.75, 1].map((fraction) => fraction * yMax);

  // Nudge the two rules' labels apart when they nearly coincide.
  const budgetY = y(budget);
  const projectedY = projectedTotal === null ? null : y(projectedTotal);
  const collides = projectedY !== null && Math.abs(projectedY - budgetY) < 14;
  const budgetLabelY = budgetY + (collides ? (projectedY < budgetY ? 9 : -5) : 4);
  const projectedLabelY =
    projectedY === null ? 0 : projectedY + (collides ? (projectedY < budgetY ? -5 : 9) : 4);

  // Reconstruct the forecast that existed before each task. Before any usage
  // exists, allocate the budget by task weight; later tasks use observed rate.
  let priorWeight = 0;
  let priorTokens = 0;
  let segmentStart = 0;
  const initialBudget =
    events.find(
      (event) => event.type === "WORKFLOW_CREATED" && event.configuredBudget !== undefined,
    )?.configuredBudget ?? budget;
  const budgetRate = initialBudget / Math.max(totalWeight, 1);
  const segments = workflow.tasks.map((task, index) => {
    const startWeight = segmentStart;
    const endWeight = startWeight + task.weight;
    const priorRate = priorWeight > 0 ? priorTokens / priorWeight : budgetRate;
    const predicted = Math.round(priorRate * task.weight);
    const actual = task.status === "COMPLETED" && task.usage ? task.usage.totalTokens : null;
    const variance = predicted > 0 && actual !== null ? ((actual - predicted) / predicted) * 100 : null;
    if (actual !== null) {
      priorWeight += task.weight;
      priorTokens += actual;
    }
    segmentStart = endWeight;
    return { index, task, startWeight, endWeight, predicted, actual, variance };
  });

  const track = (event: React.MouseEvent<SVGRectElement>) => {
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const pixel = ((event.clientX - box.left) / box.width) * WIDTH;
    const raw = ((pixel - PAD.left) / PLOT_W) * xMax;
    const index = segments.findIndex((segment) => raw <= segment.endWeight);
    setHoverTaskIndex(index < 0 ? segments.length - 1 : index);
  };

  const hover = hoverTaskIndex === null ? null : segments[hoverTaskIndex] ?? null;
  const tooltipWidth = 224;
  const tooltipHeight = 92;
  const hoverMidpoint = hover ? (hover.startWeight + hover.endWeight) / 2 : 0;
  const hoverTitle = hover
    ? hover.task.title.length > 18
      ? hover.task.title.slice(0, 17) + "…"
      : hover.task.title
    : "";
  const tooltipX = hover
    ? clamp(x(hoverMidpoint) + 12, PAD.left + 8, PAD.left + PLOT_W - tooltipWidth - 8)
    : 0;
  const tooltipY = hover
    ? PAD.top + 10
    : 0;

  return (
    <figure className="budget-chart">
      <svg
        viewBox={"0 0 " + WIDTH + " " + HEIGHT}
        role="img"
        aria-label={
          "Cumulative token spend across " +
          totalWeight +
          " work units against a budget of " +
          budget +
          " tokens. " +
          state.reason
        }
      >
        <defs>
          <linearGradient id="chart-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--purple)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--purple)" stopOpacity="0.01" />
          </linearGradient>
        </defs>
        <rect className="chart-plot-background" x={PAD.left} y={PAD.top} width={PLOT_W} height={PLOT_H} rx={10} />
        {gridValues.map((value) => (
          <g key={value}>
            <line
              className="chart-grid"
              x1={PAD.left}
              x2={PAD.left + PLOT_W}
              y1={y(value)}
              y2={y(value)}
            />
            <text className="chart-tick" x={PAD.left - 10} y={y(value) + 4}>
              {compact(value)}
            </text>
          </g>
        ))}

        {/* One step per planned task, so the plan's structure is visible. */}
        {boundaries.map((boundary, index) => (
          <g key={boundary.weight + "-" + index}>
            <line
              className={"chart-step" + (boundary.measured ? " chart-step-done" : "")}
              x1={x(boundary.weight)}
              x2={x(boundary.weight)}
              y1={PAD.top}
              y2={y(0)}
            />
            <text className="chart-step-label" x={x(boundary.weight)} y={y(0) + 18}>
              {"Task " + (index + 1)}
            </text>
            <text
              className="chart-step-index"
              x={x((boundary.startWeight + boundary.weight) / 2)}
              y={y(0) + 32}
            >
              <title>{boundary.title}</title>
              {segmentTitle(boundary)}
            </text>
          </g>
        ))}

        <line
          className="chart-axis"
          x1={PAD.left}
          x2={PAD.left + PLOT_W}
          y1={y(0)}
          y2={y(0)}
        />
        <text className="chart-step-label" x={PAD.left} y={y(0) + 18}>
          Start
        </text>

        {projectedTotal !== null && (
          <>
            <line
              className="chart-projected-rule"
              x1={PAD.left}
              x2={PAD.left + PLOT_W}
              y1={y(projectedTotal)}
              y2={y(projectedTotal)}
            />
            <text
              className="chart-label chart-label-projected"
              x={PAD.left + PLOT_W + 8}
              y={projectedLabelY}
            >
              Projected {Math.round(projectedTotal).toLocaleString()}
            </text>
          </>
        )}

        {/* The budget: a threshold, not a series. Labelled, never colour alone. */}
        <line
          className="chart-budget-rule"
          x1={PAD.left}
          x2={PAD.left + PLOT_W}
          y1={y(budget)}
          y2={y(budget)}
        />
        <text
          className="chart-label chart-label-budget"
          x={PAD.left + PLOT_W + 8}
          y={budgetLabelY}
        >
          Budget {budget.toLocaleString()}
        </text>

        {measured && (
          <>
            <polygon className="chart-area" points={actualPath + " " + x(last.weight) + "," + y(0) + " " + x(0) + "," + y(0)} />
            {projectedTotal !== null && (
              <line
                className="chart-forecast"
                x1={x(last.weight)}
                y1={y(last.tokens)}
                x2={x(xMax)}
                y2={y(projectedTotal)}
              />
            )}
            <polyline className="chart-actual" points={actualPath} />
            {points.slice(1).map((point) => (
              <circle
                key={point.weight}
                className="chart-point"
                cx={x(point.weight)}
                cy={y(point.tokens)}
                r={4}
              />
            ))}
          </>
        )}

        {hover && (
          <g className="chart-hover">
            <rect
              className="chart-segment-hover"
              x={x(hover.startWeight)}
              y={PAD.top}
              width={x(hover.endWeight) - x(hover.startWeight)}
              height={PLOT_H}
            />
            <g transform={"translate(" + tooltipX + "," + tooltipY + ")"}>
              <rect className="chart-tooltip" width={tooltipWidth} height={tooltipHeight} rx={9} />
              <text className="chart-tooltip-title" x={12} y={20}>
                {hover.index === 0 ? "Start" : "Task " + hover.index}
                {" → Task " + (hover.index + 1) + " · " + hoverTitle}
              </text>
              <text className="chart-tooltip-row" x={12} y={43}>
                Predicted
                <tspan className="chart-tooltip-number" x={tooltipWidth - 12} textAnchor="end">
                  {hover.predicted.toLocaleString()}
                </tspan>
              </text>
              <text className="chart-tooltip-row" x={12} y={64}>
                Actual
                <tspan className="chart-tooltip-number" x={tooltipWidth - 12} textAnchor="end">
                  {hover.actual === null ? "Pending" : hover.actual.toLocaleString()}
                </tspan>
              </text>
              <text
                className={"chart-tooltip-variance " + (hover.variance !== null && hover.variance > 0 ? "is-over" : "is-under")}
                x={12}
                y={83}
              >
                {hover.variance === null
                  ? "Variance available after completion"
                  : hover.variance === 0
                    ? "→ 0.0% vs predicted"
                    : (hover.variance > 0 ? "↑ " : "↓ ") +
                      Math.abs(hover.variance).toFixed(1) +
                      "% vs predicted"}
              </text>
            </g>
          </g>
        )}

        <rect
          className="chart-surface"
          x={PAD.left}
          y={PAD.top}
          width={PLOT_W}
          height={PLOT_H}
          onMouseMove={track}
          onMouseLeave={() => setHoverTaskIndex(null)}
        />
      </svg>

      <figcaption>
        {measured
          ? overBudget
            ? "At the observed rate, the remaining plan crosses the budget before the work ends. Hover to read the forecast at any point."
            : "At the observed rate, the remaining plan finishes inside the budget. Hover to read the forecast at any point."
          : "No forecast yet — the line begins once the first task reports its usage."}
      </figcaption>
    </figure>
  );
}
