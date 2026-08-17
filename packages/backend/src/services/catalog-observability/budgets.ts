/**
 * Latency budgets for the catalog read surfaces (#367 W16).
 *
 * ## A budget with no observation is NOT "within budget"
 *
 * This is the whole content of the file. The natural implementation compares an
 * observed p95 against a threshold and answers a boolean, and on a task that has
 * served none of those requests the observed value is zero, zero is below every
 * threshold, and the surface reports five green ticks for five surfaces nobody
 * has called. `CatalogLatencyReport` therefore omits BOTH `observed` and
 * `withinBudget` when there is no sample — a consumer cannot render a verdict it
 * was not given.
 *
 * That matters most on exactly the deployment where it is most misleading: a
 * freshly rolled task, in the minutes after a deploy, which is when somebody is
 * watching.
 *
 * ## The budgets are incident thresholds, not performance targets
 *
 * `CATALOG_LATENCY_BUDGETS` carries a `rationale` per route for the same reason
 * every metric carries an `attributionLimit`: a number with no reasoning beside
 * it is a number the next person on call raises until it stops firing. They are
 * deliberately generous — the point at which a surface has gone WRONG. A budget
 * set at the current p95 turns green into "unchanged" and fires on ordinary
 * fluctuation, which is how a latency alert gets muted in week two.
 *
 * ## p95, never the mean
 *
 * A mean hides the tail that is the entire reason a budget exists. The report
 * carries p50 and p99 beside it so the shape is visible, but the VERDICT is on
 * p95 alone, in one place.
 */

import { CATALOG_LATENCY_BUDGETS, type CatalogLatencyReport } from '@mercaria/shared-types';
import { readRouteObservation } from './route-observations.js';

/**
 * The W16 budgets against what this process has actually observed.
 *
 * Synchronous and reads no database: every input is in module scope. That is
 * also why it is safe on the operator route with no timeout concern.
 */
export function readCatalogLatencyReport(): CatalogLatencyReport {
  return {
    collectedAt: new Date().toISOString(),
    budgets: CATALOG_LATENCY_BUDGETS.map((budget) => {
      const observed = readRouteObservation(budget.method, budget.route)?.latency;
      if (!observed || observed.observations === 0) {
        // Neither field. See the header: a zeroed observation would clear every
        // budget on a task that has served nothing.
        return { budget };
      }
      return {
        budget,
        observed,
        withinBudget: observed.p95Ms <= budget.p95BudgetMs,
      };
    }),
  };
}

/**
 * The budgets currently exceeded, for an alert to name.
 *
 * A budget with no observation is NOT included — it is neither breached nor
 * clear, and including it would page somebody about a task that has served no
 * traffic. Returned as a list rather than a count so the alert can name the
 * route; a count would tell an operator that something is slow and not what.
 */
export function breachedCatalogLatencyBudgets(): readonly {
  readonly route: string;
  readonly method: string;
  readonly p95Ms: number;
  readonly budgetMs: number;
  readonly observations: number;
}[] {
  const breached: {
    route: string;
    method: string;
    p95Ms: number;
    budgetMs: number;
    observations: number;
  }[] = [];
  for (const entry of readCatalogLatencyReport().budgets) {
    if (entry.observed === undefined || entry.withinBudget !== false) continue;
    breached.push({
      route: entry.budget.route,
      method: entry.budget.method,
      p95Ms: entry.observed.p95Ms,
      budgetMs: entry.budget.p95BudgetMs,
      observations: entry.observed.observations,
    });
  }
  return breached;
}
