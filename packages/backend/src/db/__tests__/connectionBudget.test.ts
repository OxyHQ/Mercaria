/**
 * The connection budget is arithmetic, and arithmetic that nothing checks drifts
 * (#610).
 *
 * Two numbers multiply into what the suite holds open, and they live in two
 * different roles: `TEST_POOL_SIZE` is what one worker may hold and is bounded
 * BELOW by the race-arity census, while `MAX_TEST_WORKERS` is what bounds the
 * product ABOVE. Raising either without the other is the change that silently
 * re-creates the ceiling breach, and it looks like a performance tweak.
 *
 * These assertions are cheap and none of them is a restatement of the code:
 * each names an external fact the numbers must respect.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CONNECTION_BUDGET,
  MAX_TEST_WORKERS,
  TEST_POOL_SIZE,
} from '../../../vitest.connection-budget.js';

/** `max_connections` on the servers this suite runs against — compose and CI alike. */
const MAX_CONNECTIONS = 100;

/**
 * The highest arity at which a realdb test asserts an outcome that only differs
 * under true concurrency: three concurrent `ensureConnectedAccount` calls
 * converging on one id. Below this a race SERIALIZES and still passes, which is
 * the green-and-inert failure the pool must not be lowered into.
 */
const HIGHEST_TRUE_RACE_ARITY = 3;

describe('#610 — the suite cannot be configured above the connection ceiling', () => {
  it('keeps one suite inside its budget', () => {
    expect(MAX_TEST_WORKERS * TEST_POOL_SIZE).toBeLessThanOrEqual(CONNECTION_BUDGET);
    // A budget of zero workers satisfies every bound above and runs nothing.
    expect(MAX_TEST_WORKERS).toBeGreaterThanOrEqual(1);
  });

  it('leaves room for a SECOND concurrent suite, which is the measured failure', () => {
    // #610's failure is two suites at once, neither of them at fault. A budget
    // that only fits one is the state this change exists to leave.
    expect(CONNECTION_BUDGET * 2).toBeLessThan(MAX_CONNECTIONS);
  });

  it('keeps the pool at or above the highest TRUE-race arity', () => {
    // The direction that fails SILENTLY. postgres.js queues rather than
    // erroring, so a pool below this serializes the three-way connected-account
    // race and it passes while testing nothing.
    expect(TEST_POOL_SIZE).toBeGreaterThanOrEqual(HIGHEST_TRUE_RACE_ARITY);
  });

  it('is the SAME pool size the harness actually exports to the backend', () => {
    // Two spellings of one number can disagree. The globalSetup must read this
    // constant rather than carry its own copy, which is what it did before.
    const setup = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'vitest.pg.globalSetup.ts'),
      'utf8',
    );
    expect(setup).toContain("from './vitest.connection-budget.js'");
    expect(setup).toContain('process.env.PG_MAX_POOL_SIZE = String(TEST_POOL_SIZE)');
    expect(setup, 'the harness re-declared its own pool size').not.toMatch(
      /const TEST_POOL_SIZE\s*=/,
    );
  });

  it('is the same cap vitest actually applies', () => {
    // A budget nothing reads is a comment. `maxWorkers` must come from the
    // derived constant, not from a literal beside it.
    const config = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'vitest.config.ts'),
      'utf8',
    );
    expect(config).toContain('maxWorkers: MAX_TEST_WORKERS');
    expect(config, 'maxWorkers was given a literal, which drifts from the pool size').not.toMatch(
      /maxWorkers:\s*\d+/,
    );
  });
});
