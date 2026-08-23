/**
 * The two catalog metrics the shadow counters produce (#367 line 324).
 *
 * `services/search/shadow.ts` — the precedent this shadow is copied from — has
 * its counters served on `/internal/search/*`. Without this pair, ours were
 * recorded into a module-scope integer nothing could read, which is a shadow
 * mode that measures nothing observable: green, inert, and indistinguishable
 * from one that works.
 *
 * The arithmetic is here rather than in `contract-gates.test.ts` because the
 * DENOMINATOR choice is the part that can be quietly wrong, and it is wrong in
 * a way that looks like an improving number.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG_METRICS } from '@mercaria/shared-types';
import {
  recordVariantAxisShadow,
  resetVariantAxisShadowCounters,
} from '../projection.js';
import { collectCatalogMetrics } from '../../catalog-observability/metrics.service.js';
import { closePostgres, connectPostgres } from '../../../db/postgres.js';

/**
 * The two readings, by key, out of a full collection.
 *
 * A real server, because `collectCatalogMetrics` walks EVERY producer and most
 * of them read Postgres. That is the point of driving the pair through the
 * collector rather than calling them directly: a metric is only readable if the
 * collection it lives in succeeds, and the census inside it refuses a report
 * where any definition has no producer.
 */
async function readings(): Promise<Record<string, unknown>> {
  const report = await collectCatalogMetrics();
  const wanted = ['variant_axis_typed_coverage', 'variant_axis_shadow_divergence'];
  const found: Record<string, unknown> = {};
  for (const reading of report.readings) {
    if (wanted.includes(reading.key)) found[reading.key] = reading;
  }
  return found;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  resetVariantAxisShadowCounters();
});

describe('the shadow counters are DEFINED as metrics', () => {
  it('both keys are in the registry and neither is declared unmeasured', () => {
    // The registry is what the collector walks, so a definition that is merely
    // produced would never be read. And `unmeasured` would make the pair a
    // documented gap rather than a working instrument.
    const defined = CATALOG_METRICS.filter((metric) =>
      metric.key.startsWith('variant_axis_'),
    );
    expect(defined.map((metric) => metric.key).sort()).toEqual([
      'variant_axis_shadow_divergence',
      'variant_axis_typed_coverage',
    ]);
    for (const metric of defined) {
      expect(metric.unmeasured, `${metric.key} is declared unmeasured`).toBeUndefined();
      expect(metric.source).toBe('variant_axis_shadow');
      expect(metric.kind).toBe('ratio');
    }
  });
});

describe('variant_axis_typed_coverage', () => {
  it('reports a ZERO DENOMINATOR rather than a rate when the lever is off', async () => {
    // `off` records nothing, so the population is genuinely empty. The registry's
    // own rule is that `0 / 0` stays MEASURED with `denominator: 0` and no
    // ratio — which is the difference between "the lever is off" and "no listing
    // is typed", and those lead an operator to opposite actions.
    const [coverage] = [(await readings()).variant_axis_typed_coverage] as [
      { state: string; denominator: number; ratio?: number },
    ];
    expect(coverage.state).toBe('measured');
    expect(coverage.denominator).toBe(0);
    expect(coverage.ratio).toBeUndefined();
  });

  it('counts a listing with typed axes and excludes one without', async () => {
    recordVariantAxisShadow('agreed');
    recordVariantAxisShadow('diverged');
    recordVariantAxisShadow('typed_absent');
    recordVariantAxisShadow('typed_absent');

    const coverage = (await readings()).variant_axis_typed_coverage as {
      numerator: number;
      denominator: number;
      ratio: number;
    };
    expect(coverage.denominator).toBe(4);
    expect(coverage.numerator).toBe(2);
    expect(coverage.ratio).toBeCloseTo(0.5);
  });
});

describe('variant_axis_shadow_divergence', () => {
  it('divides by the listings where BOTH sides carried something, not by every listing', async () => {
    // The denominator that matters. Using every hydrated listing would make the
    // rate track the migration BACKLOG rather than the drift — and it would FALL
    // as coverage rose, which reads on a dashboard like the drift improving
    // while nothing about it changed.
    recordVariantAxisShadow('agreed');
    recordVariantAxisShadow('diverged');
    // Eight listings the backfill has not reached. They are not disagreements.
    for (let i = 0; i < 8; i += 1) recordVariantAxisShadow('typed_absent');

    const divergence = (await readings()).variant_axis_shadow_divergence as {
      numerator: number;
      denominator: number;
      ratio: number;
    };
    expect(divergence.denominator).toBe(2);
    expect(divergence.numerator).toBe(1);
    expect(divergence.ratio).toBeCloseTo(0.5);
  });

  it('is a zero-denominator reading, never 0%, when nothing was comparable', async () => {
    // Every listing un-migrated: there is no comparison to have an opinion
    // about. A confident "0% divergence" here is the exact vacuity the
    // observability domain exists to prevent.
    recordVariantAxisShadow('typed_absent');
    recordVariantAxisShadow('typed_absent');

    const divergence = (await readings()).variant_axis_shadow_divergence as {
      state: string;
      denominator: number;
      ratio?: number;
    };
    expect(divergence.state).toBe('measured');
    expect(divergence.denominator).toBe(0);
    expect(divergence.ratio).toBeUndefined();
  });
});
