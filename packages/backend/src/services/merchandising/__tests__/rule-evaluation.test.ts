import { describe, expect, it } from 'vitest';
import { MAX_LIVE_MERCHANDISING_SPOTLIGHTS } from '@mercaria/shared-types';
import { applyingRules, evaluateRules, type EvaluatedRuleInput } from '../rule-evaluation.js';

const AT = new Date(Date.UTC(2020, 0, 10, 12));
const HOUR = 60 * 60 * 1000;
const shift = (ms: number) => new Date(AT.getTime() + ms);

function rule(id: string, overrides: Partial<EvaluatedRuleInput> = {}): EvaluatedRuleInput {
  return {
    id,
    kind: 'sort',
    target: 'store',
    collectionId: null,
    enabled: true,
    startsAt: null,
    endsAt: null,
    createdAt: shift(-100 * HOUR),
    ...overrides,
  };
}

describe('a rule window, at an injected clock', () => {
  it('is scheduled before its start, live from it, and ended AT its end (exclusive)', () => {
    const window = rule('w', { startsAt: shift(HOUR), endsAt: shift(2 * HOUR) });
    expect(evaluateRules([window], AT).get('w')).toBe('scheduled');
    expect(evaluateRules([window], shift(HOUR)).get('w')).toBe('live');
    expect(evaluateRules([window], shift(2 * HOUR - 1)).get('w')).toBe('live');
    expect(evaluateRules([window], shift(2 * HOUR)).get('w')).toBe('ended');
  });

  it('paused beats the window, and a collection rule without its collection is detached', () => {
    expect(evaluateRules([rule('p', { enabled: false })], AT).get('p')).toBe('paused');
    expect(
      evaluateRules([rule('d', { target: 'collection', collectionId: null })], AT).get('d'),
    ).toBe('detached');
  });
});

describe('precedence', () => {
  it('one sort per target: the latest-started wins, then the newer rule', () => {
    const always = rule('always');
    const override = rule('override', { startsAt: shift(-HOUR) });
    const newer = rule('newer', { createdAt: shift(-HOUR) });
    const otherTarget = rule('other', { target: 'collection', collectionId: 'c1' });
    const statuses = evaluateRules([always, override, newer, otherTarget], AT);
    expect(statuses.get('override')).toBe('live');
    expect(statuses.get('always')).toBe('superseded');
    expect(statuses.get('newer')).toBe('superseded');
    expect(statuses.get('other')).toBe('live');
    expect(evaluateRules([always, newer], AT).get('newer')).toBe('live');
  });

  it('shows at most the cap of spotlights, most recently started first', () => {
    const spotlights = Array.from({ length: MAX_LIVE_MERCHANDISING_SPOTLIGHTS + 1 }, (_, i) =>
      rule(`s${i}`, {
        kind: 'spotlight',
        target: 'collection',
        collectionId: `c${i}`,
        startsAt: shift(-(i + 1) * HOUR),
      }),
    );
    const { spotlights: shown } = applyingRules(spotlights, AT);
    expect(shown.map((s) => s.id)).toEqual(['s0', 's1', 's2']);
    expect(evaluateRules(spotlights, AT).get('s3')).toBe('superseded');
  });
});
