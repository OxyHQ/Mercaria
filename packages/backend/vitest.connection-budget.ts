/**
 * The suite's PostgreSQL connection budget, and the two numbers that spend it.
 *
 * These live together because they are ONE fact: what the suite may hold open at
 * once is `workers × pool`, and a change to either number is a change to that
 * product. Split across two files they drift — `vitest.config.ts` would carry a
 * bare `maxWorkers: 10` that reads as a performance knob rather than as half of
 * a connection budget, and the next person tuning parallelism would raise it
 * without seeing what it multiplies.
 *
 * ## Why there is a budget at all (#610)
 *
 * MEASURED on `postgis/postgis:17-3.5` at `max_connections = 100`, sampling
 * `pg_stat_activity` at 150-200ms through full runs — never the client's idea of
 * its pool, because `postgres.js`'s `release()` returns a connection without
 * ending the session, so "open" and "in use" diverge:
 *
 *     configured before this file:  4 x ~32 workers = ~128   against 100
 *     peak actually open:           65  (of a 76 fleet peak)
 *     peak actually ACTIVE:         22
 *
 * So the suite was configured ABOVE the ceiling and stayed under it only because
 * not every worker held a full pool at once. Two concurrent suites exceed
 * `max_connections` while neither is at fault, which is why the failures move
 * between files run to run.
 *
 * The whole overshoot is ONE database: the shared globalSetup database, holding
 * 65 connections to run 22 queries across ~16 worker pools. The per-file
 * throwaway databases are correctly sized at 2-4.
 *
 * ## Why the POOL is not the thing that was lowered
 *
 * The aggregate above (65 open to do 22 queries) argues for halving the pool.
 * It is the wrong instrument, and this is the trap to not walk back into.
 *
 * `postgres.js` QUEUES when a pool is exhausted rather than erroring. So a race
 * test needing more connections than the pool allows does not fail — it
 * SERIALIZES, its assertions still pass, and the race stops being tested. A race
 * test that serializes is green and inert.
 *
 * Censused over all 172 `*.realdb.test.ts` files by the arity of concurrent
 * operations, classified by whether the outcome depends on true concurrency:
 *
 *     3  services/payments/stripe/.../account.service  3 x ensureConnectedAccount
 *                                                      converging on ONE id -- a RACE
 *     2  cart-merge, guest-claim, buyers (one winner), concurrent-publish, ...
 *     7  guest-session -- SEVEN rejection checks all asserting null. NOT a race;
 *        independent, so serializing them costs nothing. The raw maximum is not
 *        the constraint, and provisioning for it would be the opposite error.
 *
 * **The highest TRUE-race arity is 3**, so the floor is 3 and {@link TEST_POOL_SIZE}
 * of 4 carries exactly one connection of margin. Lowering it to 2 would
 * serialize the three-way connected-account race — whose entire point is that a
 * Stripe account cannot be un-created, so two racers deriving an idempotency key
 * from a freshly-minted row id defeat themselves — and leave zero margin on
 * every two-way race.
 *
 * **So the pool is correctly sized and the PARALLELISM is what exceeded the
 * ceiling.** That is what {@link MAX_TEST_WORKERS} bounds.
 */

/**
 * Connections one vitest worker may hold against the server.
 *
 * Read by `vitest.pg.globalSetup.ts` into `PG_MAX_POOL_SIZE`, down from the
 * production default of 20. **Do not lower this to 2** — see the race-arity
 * census above; the floor is 3.
 */
export const TEST_POOL_SIZE = 4;

/**
 * What ONE suite run may hold open, in connections.
 *
 * Derived rather than chosen: the documented failure in #610 is TWO concurrent
 * suites, so the budget is set so two fit with real margin.
 *
 *     max_connections                     100
 *     usable (measured, not computed)      99   -- 99 held, first refusal at 100
 *     two concurrent suites at 40          80
 *     margin left for a third partial run,
 *       a dev's psql, and an operator      19
 *
 * The usable figure is MEASURED and is not `max_connections - superuser_reserved
 * (= 97)`: the `mercaria` role is a SUPERUSER, so the reserve withholds nothing
 * from it. That is tracked separately as its own hazard — when the fleet
 * saturates there is no reserved slot left for anyone to diagnose it — and it is
 * a role-design question rather than a test-config one.
 */
export const CONNECTION_BUDGET = 40;

/**
 * The worker cap, which is the budget divided by what each worker spends.
 *
 * Computed, never written down, so raising the pool lowers the worker count
 * automatically instead of silently doubling the product. `vitest.config.ts` set
 * NO pool option at all before this, so the ceiling was however many cores the
 * box had — 32 here, 2-4 on a GitHub runner, something else on a laptop. A
 * connection budget that varies by hardware is not a budget.
 */
export const MAX_TEST_WORKERS = Math.max(1, Math.floor(CONNECTION_BUDGET / TEST_POOL_SIZE));
