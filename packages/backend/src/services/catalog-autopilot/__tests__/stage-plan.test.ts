import { describe, expect, it } from 'vitest';
import type { CatalogBackfillRunStatus, CatalogBackfillStage } from '@mercaria/shared-types';
import { CATALOG_BACKFILL_STAGES } from '@mercaria/shared-types';
import { AUTOPILOT_STAGE_SEQUENCE, planNextStage, type StageRunFacts } from '../stage-plan.js';

const SEQUENCE: readonly CatalogBackfillStage[] = ['store_merchants', 'reference_products', 'reference_promotion'];
const INTERVAL_MS = 30 * 60 * 1_000;
const T0 = new Date('2025-06-02T10:00:00.000Z');

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60 * 1_000);
}

function run(status: CatalogBackfillRunStatus, created: number, finished: number | null = null): StageRunFacts {
  return {
    status,
    createdAt: at(created),
    completedAt: status === 'completed' && finished !== null ? at(finished) : null,
    lastRunAt: finished === null ? null : at(finished),
  };
}

function plan(entries: readonly [CatalogBackfillStage, StageRunFacts][], now: Date): CatalogBackfillStage | null {
  return planNextStage(new Map(entries), now, SEQUENCE, INTERVAL_MS);
}

describe('planNextStage', () => {
  it('starts with the first stage when nothing has ever run', () => {
    expect(plan([], T0)).toBe('store_merchants');
  });

  it('waits while any stage of the cycle is open', () => {
    expect(plan([['store_merchants', run('running', 0)]], at(1))).toBeNull();
    expect(plan([['store_merchants', run('completed', 0, 1)], ['reference_products', run('paused', 2)]], at(3))).toBeNull();
  });

  it('opens each stage once its predecessor finished, in order', () => {
    const first: [CatalogBackfillStage, StageRunFacts] = ['store_merchants', run('completed', 0, 1)];
    expect(plan([first], at(2))).toBe('reference_products');
    const second: [CatalogBackfillStage, StageRunFacts] = ['reference_products', run('completed', 2, 3)];
    expect(plan([first, second], at(4))).toBe('reference_promotion');
  });

  it('treats a failed run as finished, so one stage cannot freeze the cycle', () => {
    expect(plan([['store_merchants', run('failed', 0, 1)]], at(2))).toBe('reference_products');
  });

  it('waits out the interval after a complete cycle, then starts the next one', () => {
    const cycle: [CatalogBackfillStage, StageRunFacts][] = [
      ['store_merchants', run('completed', 0, 1)],
      ['reference_products', run('completed', 2, 3)],
      ['reference_promotion', run('completed', 4, 5)],
    ];
    expect(plan(cycle, at(29))).toBeNull();
    expect(plan(cycle, at(30))).toBe('store_merchants');
  });

  it('re-runs a stage from the previous cycle once the new cycle reaches it', () => {
    // The new cycle's first stage finished at 32; the second stage's newest run
    // (created at 2) belongs to the previous cycle.
    const entries: [CatalogBackfillStage, StageRunFacts][] = [
      ['store_merchants', run('completed', 31, 32)],
      ['reference_products', run('completed', 2, 3)],
      ['reference_promotion', run('completed', 4, 5)],
    ];
    expect(plan(entries, at(33))).toBe('reference_products');
  });

  it('cycles real stages only, in the documented dependency order, without search_reindex', () => {
    expect(AUTOPILOT_STAGE_SEQUENCE).not.toContain('search_reindex');
    const order = AUTOPILOT_STAGE_SEQUENCE.map((stage) => CATALOG_BACKFILL_STAGES.indexOf(stage));
    expect(order.every((index) => index >= 0)).toBe(true);
    // ADR 0014's three run after the listing stages and before the projections.
    const indexOf = (stage: CatalogBackfillStage) => AUTOPILOT_STAGE_SEQUENCE.indexOf(stage);
    expect(indexOf('provisional_products')).toBeLessThan(indexOf('reference_products'));
    expect(indexOf('reference_products')).toBeLessThan(indexOf('source_readvance'));
    expect(indexOf('source_readvance')).toBeLessThan(indexOf('reference_promotion'));
    expect(indexOf('reference_promotion')).toBeLessThan(indexOf('rebuild_projections'));
    expect(AUTOPILOT_STAGE_SEQUENCE.at(-1)).toBe('consistency');
  });
});
