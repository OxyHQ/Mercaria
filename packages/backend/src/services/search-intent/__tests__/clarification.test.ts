/**
 * The bounded clarification state machine (#95 "Clarification policy").
 *
 * Rule 7 asks for a bounded state machine that avoids repetitive loops, and
 * "bounded" is only meaningful if the bound is on the SESSION: a per-request
 * bound is no bound at all, because every answer starts a new request. Every
 * case here is written against a session state rather than against a single
 * call, for that reason.
 */

import { describe, expect, it } from 'vitest';
import { MAX_CLARIFICATION_ROUNDS } from '@mercaria/shared-types';
import {
  clarificationRoundsRemaining,
  resolveClarificationAnswer,
  selectClarifications,
  type ClarificationCandidate,
} from '../clarification.js';

const budgetQuestion: ClarificationCandidate = {
  kind: 'budget_basis',
  question: 'Before delivery, or the total?',
  options: [
    { id: 'item_price', label: 'Before delivery' },
    { id: 'known_total', label: 'Total' },
  ],
};

const categoryQuestion: ClarificationCandidate = {
  kind: 'category',
  question: 'Which of these?',
  options: [
    { id: 'keep', label: 'Laptops' },
    { id: 'any', label: 'Anything' },
  ],
};

const attributeQuestion: ClarificationCandidate = {
  kind: 'attribute_disambiguation',
  question: 'What does 14 inches describe?',
  options: [
    { id: 'screen_size', label: 'Screen size' },
    { id: 'width', label: 'Width' },
  ],
};

describe('a kind is asked at most once per session', () => {
  it('asks a fresh kind', () => {
    const asked = selectClarifications({ askedKinds: [], rounds: 0 }, [budgetQuestion]);
    expect(asked.map((clarification) => clarification.kind)).toEqual(['budget_basis']);
    expect(asked[0]?.id).toBe('clar-budget_basis');
  });

  it('does NOT ask a kind this session already asked', () => {
    // The distinction the previous case cannot make: same candidate, same
    // rounds, one different fact about the session.
    const asked = selectClarifications({ askedKinds: ['budget_basis'], rounds: 1 }, [
      budgetQuestion,
    ]);
    expect(asked).toEqual([]);
  });

  it('asks a DIFFERENT kind after one was already asked', () => {
    const asked = selectClarifications({ askedKinds: ['budget_basis'], rounds: 1 }, [
      budgetQuestion,
      categoryQuestion,
    ]);
    expect(asked.map((clarification) => clarification.kind)).toEqual(['category']);
  });
});

describe('the session bound', () => {
  it('asks nothing once the rounds are spent', () => {
    const state = { askedKinds: [], rounds: MAX_CLARIFICATION_ROUNDS };
    expect(clarificationRoundsRemaining(state)).toBe(0);
    expect(selectClarifications(state, [budgetQuestion])).toEqual([]);
  });

  it('never reports a negative remaining count', () => {
    expect(clarificationRoundsRemaining({ askedKinds: [], rounds: 99 })).toBe(0);
  });

  it('asks at most two questions at once', () => {
    const asked = selectClarifications({ askedKinds: [], rounds: 0 }, [
      budgetQuestion,
      categoryQuestion,
      attributeQuestion,
    ]);
    expect(asked).toHaveLength(2);
  });

  it('drops a question with fewer than two options', () => {
    // One option is a statement and zero is a bug. Both would ask a shopper to
    // confirm something Mercaria had already decided, which is worse than
    // deciding it and saying so in the paraphrase.
    const asked = selectClarifications({ askedKinds: [], rounds: 0 }, [
      { kind: 'category', question: 'Which?', options: [{ id: 'keep', label: 'Laptops' }] },
    ]);
    expect(asked).toEqual([]);
  });
});

describe('an answer belongs to the OPEN question and to no other', () => {
  it('applies an answer to the question that is open', () => {
    expect(
      resolveClarificationAnswer('clar-budget_basis', {
        clarificationId: 'clar-budget_basis',
        optionId: 'known_total',
      }),
    ).toEqual({ status: 'applied', kind: 'budget_basis', optionId: 'known_total' });
  });

  it('refuses an answer to a question two rounds old', () => {
    // A client replaying an old answer would otherwise re-apply a decision the
    // shopper has since changed.
    expect(
      resolveClarificationAnswer('clar-category', {
        clarificationId: 'clar-budget_basis',
        optionId: 'known_total',
      }),
    ).toEqual({ status: 'not_open' });
  });

  it('refuses an answer when nothing is open', () => {
    expect(
      resolveClarificationAnswer(undefined, {
        clarificationId: 'clar-budget_basis',
        optionId: 'item_price',
      }),
    ).toEqual({ status: 'not_open' });
  });

  it('refuses an id whose suffix is not a real clarification kind', () => {
    // The kind is read BACK out of the closed tuple rather than cast out of the
    // id, so a client that guessed an id shape cannot name a kind the
    // vocabulary does not contain.
    expect(
      resolveClarificationAnswer('clar-not_a_kind', {
        clarificationId: 'clar-not_a_kind',
        optionId: 'x',
      }),
    ).toEqual({ status: 'not_open' });
  });
});
