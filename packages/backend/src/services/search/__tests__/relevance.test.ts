/**
 * Entity relevance (#70 "Ranking boundaries" 1–5) — the properties the ordering
 * rests on, pinned against exact inputs.
 *
 * The band structure is what makes the ordering explicable, so it is asserted
 * as a set of INEQUALITIES between stages rather than against literal numbers:
 * a test that pinned `0.9` would fail on every tuning change and prove nothing
 * about the property anybody cares about.
 */

import { describe, expect, it } from 'vitest';
import { SEARCH_MATCH_STAGES } from '@mercaria/shared-types';
import type { SearchMatchStage } from '@mercaria/shared-types';
import { filterAgreementRatio, scoreEntityRelevance, strongestStage } from '../relevance.js';

describe('scoreEntityRelevance', () => {
  it('an exact identifier can never be overtaken by a perfect fuzzy match', () => {
    // #70 acceptance 2 as arithmetic: the identifier floor sits above the best
    // a fuzzy match can reach, whatever the similarity. This is the property a
    // future weight change must not break, and the only one that makes "exact
    // identifiers are deterministic" true of the ORDERING rather than of the
    // retrieval alone.
    const identifier = scoreEntityRelevance({ stages: ['identifier'] });
    const perfectFuzzy = scoreEntityRelevance({
      stages: ['fuzzy'],
      trigramSimilarity: 1,
      filterAgreement: 1,
    });
    expect(identifier).toBeGreaterThan(perfectFuzzy);
  });

  it('the stage bands do not overlap, over EVERY adjacent pair', () => {
    // Derived from the tuple rather than listed by hand, so a stage added in the
    // middle is covered the moment it exists — a hand-written list of six pairs
    // would silently stop covering the seventh.
    const best = (stage: SearchMatchStage): number =>
      scoreEntityRelevance({
        stages: [stage],
        trigramSimilarity: 1,
        lexicalRank: 1,
        tokenOverlap: 1,
        filterAgreement: 1,
        aliasKind: 'former_name',
      });
    const worst = (stage: SearchMatchStage): number => scoreEntityRelevance({ stages: [stage] });

    expect(SEARCH_MATCH_STAGES.length).toBeGreaterThanOrEqual(7);
    for (let index = 1; index < SEARCH_MATCH_STAGES.length; index += 1) {
      const stronger = SEARCH_MATCH_STAGES[index - 1];
      const weaker = SEARCH_MATCH_STAGES[index];
      expect(
        worst(stronger),
        `the ${stronger} band overlaps the ${weaker} band; a perfect ${weaker} match ` +
          `would outrank a real ${stronger} one`,
      ).toBeGreaterThan(best(weaker));
    }
  });

  it('two weak stages agreeing never beat one strong stage', () => {
    // The reason `strongestStage` takes a maximum rather than a sum: a product
    // found by both a fuzzy name match and a token overlap is still a guess.
    const weakPair = scoreEntityRelevance({
      stages: ['fuzzy', 'token'],
      trigramSimilarity: 1,
      tokenOverlap: 1,
    });
    expect(weakPair).toBeLessThan(scoreEntityRelevance({ stages: ['exact_alias'] }));
  });

  it('a former name outranks a marketing name at the same stage (#70 input 3)', () => {
    const former = scoreEntityRelevance({ stages: ['exact_alias'], aliasKind: 'former_name' });
    const marketing = scoreEntityRelevance({ stages: ['exact_alias'], aliasKind: 'marketing_name' });
    const misspelling = scoreEntityRelevance({ stages: ['exact_alias'], aliasKind: 'misspelling' });
    expect(former).toBeGreaterThan(marketing);
    expect(marketing).toBeGreaterThan(misspelling);
  });

  it('filter agreement refines within a stage and never across one', () => {
    const agreeing = scoreEntityRelevance({ stages: ['lexical'], lexicalRank: 0.5, filterAgreement: 1 });
    const disagreeing = scoreEntityRelevance({
      stages: ['lexical'],
      lexicalRank: 0.5,
      filterAgreement: 0,
    });
    expect(agreeing).toBeGreaterThan(disagreeing);
    // …and still below the stage above it, so a filter cannot promote a lexical
    // hit past a prefix hit.
    expect(agreeing).toBeLessThan(scoreEntityRelevance({ stages: ['prefix'] }));
  });

  it('clamps a signal outside the unit interval instead of trusting it', () => {
    // A caller passing a raw `ts_rank` (unbounded above) or a negative value
    // must not be able to push a fuzzy result past an exact one.
    const absurd = scoreEntityRelevance({ stages: ['fuzzy'], trigramSimilarity: 1_000 });
    const perfect = scoreEntityRelevance({ stages: ['fuzzy'], trigramSimilarity: 1 });
    expect(absurd).toBe(perfect);
    expect(scoreEntityRelevance({ stages: ['fuzzy'], trigramSimilarity: -5 })).toBe(
      scoreEntityRelevance({ stages: ['fuzzy'], trigramSimilarity: 0 }),
    );
  });

  it('is bounded by 1 and deterministic', () => {
    const input = {
      stages: ['identifier'] as const,
      trigramSimilarity: 1,
      lexicalRank: 1,
      tokenOverlap: 1,
      filterAgreement: 1,
    };
    expect(scoreEntityRelevance(input)).toBeLessThanOrEqual(1);
    expect(scoreEntityRelevance(input)).toBe(scoreEntityRelevance(input));
  });
});

describe('strongestStage', () => {
  it('picks the strongest, whatever order the stages arrived in', () => {
    expect(strongestStage(['fuzzy', 'identifier', 'lexical'])).toBe('identifier');
    expect(strongestStage(['lexical', 'identifier', 'fuzzy'])).toBe('identifier');
  });

  it('degrades an unrecognised stage to the weakest rather than throwing', () => {
    // One malformed candidate must not empty a page, and the degraded value can
    // never outrank a real match.
    expect(strongestStage([])).toBe('fuzzy');
  });
});

describe('filterAgreementRatio', () => {
  it('answers 1 for an unfiltered request', () => {
    // Vacuously true, and the alternative is worse: 0 would push every result
    // of an unfiltered search to the bottom of its own band.
    expect(filterAgreementRatio(0, 0)).toBe(1);
  });

  it('is the satisfied fraction otherwise, clamped', () => {
    expect(filterAgreementRatio(1, 2)).toBe(0.5);
    expect(filterAgreementRatio(0, 3)).toBe(0);
    expect(filterAgreementRatio(5, 3)).toBe(1);
  });
});
