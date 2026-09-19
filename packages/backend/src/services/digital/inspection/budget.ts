/**
 * The wall-clock ceiling, as a value a pure parser can read.
 *
 * ## Why a budget object rather than a timeout
 *
 * Every parser in this directory is synchronous and CPU-bound, so a
 * `setTimeout` cannot interrupt one: the timer fires when the loop has already
 * finished. The only bound that works on a single-threaded runtime is a
 * COOPERATIVE one — the loop asks whether it has run out — and the only way to
 * make that testable is for the clock to be an injected dependency rather than
 * `Date.now()` spelled inside the loop.
 *
 * So a budget carries its own clock. A test drives a parser past its deadline by
 * handing it a clock that jumps, which is an exhaustive test of the refusal path
 * rather than a twenty-second illustration of it; production hands it
 * `Date.now`. `budget-and-limits.test.ts` exercises both.
 *
 * ## `expired()` is checked on a stride, and that is a real bound
 *
 * A caller checks every {@link DEADLINE_CHECK_STRIDE} iterations, so a loop can
 * overrun the deadline by up to one stride of its own cheapest iteration. That
 * is the price of not paying for a clock read per triangle, and it is bounded —
 * which is the property that matters, because the thing being defended against
 * is an input that never finishes, not one that finishes late.
 */

import { DEADLINE_CHECK_STRIDE, INSPECTION_TIME_BUDGET_MS } from './limits.js';

/** A wall-clock ceiling a bounded loop can consult. */
export interface InspectionBudget {
  /** Whether the budget is spent. Cheap: one clock read. */
  expired(): boolean;
  /**
   * Whether the budget is spent, checked only on the stride.
   *
   * `iteration & (STRIDE - 1)` — the stride is a power of two so this is a mask
   * rather than a modulo, and a loop can call it unconditionally.
   */
  expiredOnStride(iteration: number): boolean;
}

/**
 * A budget of `timeBudgetMs` from now, reading `now` for the current instant.
 *
 * Both parameters are optional and both defaults are production's: the time
 * budget from `limits.ts` and the real clock. A test overrides one, the other or
 * both without the parser knowing either happened.
 */
export function createInspectionBudget(options?: {
  readonly timeBudgetMs?: number;
  readonly now?: () => number;
}): InspectionBudget {
  const now = options?.now ?? Date.now;
  const budgetMs = options?.timeBudgetMs ?? INSPECTION_TIME_BUDGET_MS;
  const deadlineAt = now() + budgetMs;
  return {
    expired(): boolean {
      return now() >= deadlineAt;
    },
    expiredOnStride(iteration: number): boolean {
      if ((iteration & (DEADLINE_CHECK_STRIDE - 1)) !== 0) return false;
      return now() >= deadlineAt;
    },
  };
}

/**
 * A budget that never expires.
 *
 * For the tests of everything that is NOT the deadline, so a slow CI box cannot
 * turn a measurement assertion into a timeout one. It is exported rather than
 * rebuilt per test file so that "this test opted out of the clock" is one
 * greppable name.
 */
export const UNBOUNDED_INSPECTION_BUDGET: InspectionBudget = Object.freeze({
  expired: () => false,
  expiredOnStride: () => false,
});
