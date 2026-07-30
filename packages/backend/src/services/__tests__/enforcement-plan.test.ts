/**
 * The decision → Mercaria action mapping, as a table.
 *
 * `planEnforcement` is pure — no database, no clock, no config — which is exactly
 * why it can be tested this way, and why `observe` mode is a real audit: the plan
 * is computed identically in every mode and only its EXECUTION is gated.
 */

import { describe, it, expect } from 'vitest';
import type { Decision, RecommendedAction } from '@oxyhq/crowdsource-contracts';
import { planEnforcement } from '../moderation/enforcement-plan.js';

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'dec_1',
    caseId: 'case_1',
    revision: 1,
    status: 'final',
    outcome: 'violation',
    contextSufficiency: 'sufficient',
    findings: [],
    recommendedActions: [],
    policyVersions: { taxonomy: '2026.1', policy: 'baseline@1' },
    decidedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as Decision;
}

function recommend(action: RecommendedAction): Decision['recommendedActions'][number] {
  return { action } as unknown as Decision['recommendedActions'][number];
}

function actionsOf(result: ReturnType<typeof planEnforcement>): string[] {
  return result.map((entry) => entry.action).sort();
}

describe('removal-shaped recommendations become restrict', () => {
  it.each<RecommendedAction>(['remove', 'remove_or_restrict', 'hide'])(
    '%s → restrict',
    (action) => {
      const plan = planEnforcement(decision({ recommendedActions: [recommend(action)] }));
      expect(actionsOf(plan)).toEqual(['restrict']);
    },
  );
});

describe('the commerce actions, which no other Oxy app maps to an effect', () => {
  it('request_changes → request_changes (the seller can fix and republish)', () => {
    const plan = planEnforcement(
      decision({ recommendedActions: [recommend('request_changes')] }),
    );
    expect(actionsOf(plan)).toEqual(['request_changes']);
  });

  it('freeze_transaction → freeze_transaction (in-flight orders stop moving)', () => {
    const plan = planEnforcement(
      decision({ recommendedActions: [recommend('freeze_transaction')] }),
    );
    expect(actionsOf(plan)).toEqual(['freeze_transaction']);
  });

  it('restrict and freeze SURVIVE together — they act on different objects', () => {
    /**
     * The pairing a social app would collapse. Restricting the listing stops NEW
     * orders; freezing stops the ones already placed. Collapsing them leaves a
     * delisted counterfeit whose in-flight orders ship anyway.
     */
    const plan = planEnforcement(
      decision({
        recommendedActions: [recommend('remove'), recommend('freeze_transaction')],
      }),
    );
    expect(actionsOf(plan)).toEqual(['freeze_transaction', 'restrict']);
  });

  it('restrict ABSORBS request_changes — a removed listing awaits no edits', () => {
    const plan = planEnforcement(
      decision({
        recommendedActions: [recommend('remove'), recommend('request_changes')],
      }),
    );
    expect(actionsOf(plan)).toEqual(['restrict']);
  });
});

describe('recommendations Mercaria has no lever for', () => {
  it.each<RecommendedAction>([
    'label',
    'allow_with_label',
    'age_gate',
    'reduce_distribution',
    'suspend_user',
    'legal_queue',
  ])('%s → manual_review, never a fabricated effect', (action) => {
    const plan = planEnforcement(decision({ recommendedActions: [recommend(action)] }));
    expect(actionsOf(plan)).toEqual(['manual_review']);

    // The declined recommendation is RECORDED, so it cannot be mistaken later for
    // one that never arrived.
    expect(plan[0]?.recommendedAction).toBe(action);
  });
});

describe('no_violation always plans a restore', () => {
  it('even when the recommendation is no_action', () => {
    /**
     * The failure this prevents is very easy to ship and very hard to see. A
     * correction is a new revision whose outcome is `no_violation` and whose
     * recommendation is frequently `no_action` — meaning "take no NEW action",
     * not "leave what you already did in place". Mapping it straight through
     * leaves the listing its earlier revision restricted delisted forever, with
     * the case saying it was fine and nothing erroring anywhere.
     */
    const plan = planEnforcement(
      decision({ outcome: 'no_violation', recommendedActions: [recommend('no_action')] }),
    );
    expect(actionsOf(plan)).toContain('restore');
  });

  it('and when it recommended nothing at all', () => {
    const plan = planEnforcement(decision({ outcome: 'no_violation' }));
    expect(actionsOf(plan)).toEqual(['restore']);
  });

  it('without duplicating an explicit restore', () => {
    const plan = planEnforcement(
      decision({ outcome: 'no_violation', recommendedActions: [recommend('restore')] }),
    );
    expect(actionsOf(plan)).toEqual(['restore']);
  });
});

describe('severity fallback, used only when nothing was recommended', () => {
  it('high → restrict', () => {
    const plan = planEnforcement(
      decision({ findings: [{ severity: 'high' }] as unknown as Decision['findings'] }),
    );
    expect(actionsOf(plan)).toEqual(['restrict']);
  });

  it('medium → request_changes', () => {
    const plan = planEnforcement(
      decision({ findings: [{ severity: 'medium' }] as unknown as Decision['findings'] }),
    );
    expect(actionsOf(plan)).toEqual(['request_changes']);
  });

  it('critical → manual_review, NOT an automatic removal', () => {
    /**
     * Critical material routes to a specialist team under legal protocol. An
     * automatic removal driven by a webhook is not that, and the difference is a
     * policy decision with legal weight that a mapping table must not make.
     */
    const plan = planEnforcement(
      decision({ findings: [{ severity: 'critical' }] as unknown as Decision['findings'] }),
    );
    expect(actionsOf(plan)).toEqual(['manual_review']);
  });

  it('takes the HIGHEST severity present', () => {
    const plan = planEnforcement(
      decision({
        findings: [{ severity: 'low' }, { severity: 'high' }] as unknown as Decision['findings'],
      }),
    );
    expect(actionsOf(plan)).toEqual(['restrict']);
  });

  it('a violation with no findings asks a human rather than defaulting', () => {
    const plan = planEnforcement(decision({ findings: [] }));
    expect(actionsOf(plan)).toEqual(['manual_review']);
  });
});

describe('outcomes that are neither guilt nor innocence', () => {
  it.each(['insufficient_context', 'inconclusive', 'escalated'] as const)(
    '%s changes nothing on its own',
    (outcome) => {
      const plan = planEnforcement(decision({ outcome }));
      expect(actionsOf(plan)).toEqual(['manual_review']);
    },
  );

  it.each(['content_unavailable', 'duplicate'] as const)('%s → none', (outcome) => {
    const plan = planEnforcement(decision({ outcome }));
    expect(actionsOf(plan)).toEqual(['none']);
  });

  it('an outcome this version does not recognise asks a human', () => {
    const plan = planEnforcement(
      decision({ outcome: 'something_new_from_a_later_server' as never }),
    );
    expect(actionsOf(plan)).toEqual(['manual_review']);
  });
});

describe('a plan is never empty', () => {
  it('produces an explicit none rather than nothing', () => {
    /**
     * A row saying "we decided to do nothing, and why" is evidence. An absent row
     * is a question nobody can answer later.
     */
    const plan = planEnforcement(
      decision({ outcome: 'violation', recommendedActions: [recommend('allow')] }),
    );
    expect(plan.length).toBeGreaterThan(0);
    expect(actionsOf(plan)).toEqual(['none']);
  });
});
