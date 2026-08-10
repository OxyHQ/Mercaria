/**
 * Entity relevance (#70 "Ranking boundaries" 1–5) — a pure, deterministic,
 * weighted combination of signals about the QUERY against the ENTITY.
 *
 * ## The signature is the security property
 *
 * {@link EntityRelevanceInput} has a field for every member of
 * `SEARCH_RELEVANCE_SIGNALS` and no field for any member of
 * `SEARCH_FORBIDDEN_RELEVANCE_SIGNALS`. There is therefore no parameter through
 * which an affiliate commission, a marketplace fee, a referral reward, a Pro
 * plan, FAIR acceptance, a retail cost variance or a sponsored payment could
 * reach the score — the `SourcingCandidateFacts` device (#122), applied to
 * organic ranking. `search-relevance-isolation.test.ts` holds the other
 * direction: no module on the discovery path may IMPORT those domains, so the
 * absence cannot be worked around by a caller pre-computing a number and
 * passing it in as `filterAgreement`.
 *
 * ## Why this is not #74
 *
 * This function scores whether an ENTITY answers a query. #74 chooses which
 * OFFER of a matched product a shopper should see. They are different questions
 * over different inputs, and #70's pipeline note says so in as many words: #74
 * "must not decide whether an unrelated product matches the query". Nothing
 * here reads an offer, a price or a seller — a product with no offers at all
 * scores exactly as it would with a hundred.
 *
 * ## Why the score is a bounded 0–1 and not a rank
 *
 * The composition merges FIVE entity kinds retrieved by SEVEN stages into one
 * ordering. A rank per stage cannot be merged without inventing a conversion;
 * a bounded score can, and it is also what a keyset cursor can carry. The
 * consequence is stated in the DTO: the number means nothing across two
 * different queries.
 */

import { SEARCH_MATCH_STAGES } from '@mercaria/shared-types';
import type { CanonicalAliasKind, SearchMatchStage } from '@mercaria/shared-types';

/**
 * The floor each stage contributes, before any signal refines it.
 *
 * ## The bands do not OVERLAP, and that is the load-bearing property
 *
 * `floor(n) + headroom(n) < floor(n - 1)` for every adjacent pair, so a
 * perfect match at one stage still scores below the WORST match at the stage
 * above it. Three consequences follow, and all three are things the ordering
 * would otherwise only have by luck:
 *
 * - #70 acceptance 2 becomes arithmetic rather than a sort somebody has to keep
 *   stable — an exact identifier can never be overtaken by a very good fuzzy
 *   match, whatever the similarity;
 * - the signals become TIEBREAKERS WITHIN a stage, which is the only role a
 *   `ts_rank` and a trigram distance can honestly play against each other,
 *   since neither is calibrated against the other;
 * - the ordering is explicable to a person: the stage decides the band and the
 *   signal decides the position in it.
 *
 * `relevance.test.ts` asserts the non-overlap across every adjacent pair, so a
 * tuning change that broke it fails the build instead of quietly reordering the
 * first page of every query.
 */
const STAGE_FLOOR: Readonly<Record<SearchMatchStage, number>> = {
  identifier: 0.88,
  exact_name: 0.76,
  exact_alias: 0.62,
  prefix: 0.48,
  lexical: 0.34,
  token: 0.22,
  fuzzy: 0.1,
};

/** The most a stage's own refinements may add on top of its floor. */
const STAGE_HEADROOM: Readonly<Record<SearchMatchStage, number>> = {
  identifier: 0.12,
  exact_name: 0.1,
  exact_alias: 0.12,
  prefix: 0.12,
  lexical: 0.12,
  token: 0.1,
  fuzzy: 0.1,
};

/**
 * What kind of alias matched, as a multiplier on the alias stage's headroom.
 *
 * `former_name` outranks `marketing_name`: somebody searching a discontinued
 * brand's old name means that company, while a marketing slogan is a weaker
 * claim on identity. `misspelling` is the lowest because it is the alias kind
 * an ingestion pipeline records automatically, so it is the one most likely to
 * be wrong.
 *
 * This is #70's ranking input 3 ("alias quality") and it is the ONLY place the
 * kind is read — the retrieval stage does not filter on it, because an alias
 * somebody recorded is an alias, and hiding a misspelling would make the typo
 * case the alias exists for stop working.
 */
const ALIAS_QUALITY: Readonly<Record<CanonicalAliasKind, number>> = {
  former_name: 1,
  name_variant: 0.9,
  localized_name: 0.85,
  marketing_name: 0.7,
  misspelling: 0.55,
};

/** Every signal the score may read. See the module docblock. */
export interface EntityRelevanceInput {
  /** Which stages retrieved this entity. At least one; the strongest wins. */
  readonly stages: readonly SearchMatchStage[];
  /** `pg_trgm` similarity, 0–1. */
  readonly trigramSimilarity?: number;
  /** `ts_rank` of the entity's vector against the query, already 0–1. */
  readonly lexicalRank?: number;
  /** Fraction of the query's discriminating tokens the entity carries, 0–1. */
  readonly tokenOverlap?: number;
  /** Which alias kind matched, when `exact_alias` is among the stages. */
  readonly aliasKind?: CanonicalAliasKind;
  /**
   * Fraction of the request's structured filters this entity satisfies, 0–1.
   *
   * A REFINEMENT and never a gate: a filter that must exclude is applied as a
   * predicate, so anything reaching this function already passed every
   * exclusive filter. What this expresses is #70 ranking input 4 — among
   * results that all qualify, one matching the requested brand AND category is
   * a better answer than one matching only the category.
   */
  readonly filterAgreement?: number;
}

/** Clamp to the unit interval; a caller's out-of-range signal cannot escape it. */
function unit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

/**
 * The strongest stage among those that retrieved an entity.
 *
 * Strongest rather than a sum, because two weak stages agreeing is not evidence
 * of the strength of one strong one: a product found by both a fuzzy name match
 * and a token overlap is still a guess, and letting the two add up would let it
 * outrank an exact alias match. `SEARCH_MATCH_STAGES` order IS the strength
 * order — see the tuple's own doc comment.
 */
export function strongestStage(stages: readonly SearchMatchStage[]): SearchMatchStage {
  let best: SearchMatchStage | undefined;
  // Annotated, because `SEARCH_MATCH_STAGES.length` on an `as const` tuple is
  // the LITERAL type `7`, and an unannotated `let` would then refuse every
  // assignment below it.
  let bestIndex: number = SEARCH_MATCH_STAGES.length;
  for (const stage of stages) {
    const index = SEARCH_MATCH_STAGES.indexOf(stage);
    if (index >= 0 && index < bestIndex) {
      bestIndex = index;
      best = stage;
    }
  }
  // An entity with no recognised stage cannot have been retrieved; treating it
  // as the weakest stage rather than throwing keeps one malformed candidate
  // from emptying a page, and it can never outrank a real match.
  return best ?? 'fuzzy';
}

/**
 * How much of a stage's headroom this entity's signals earn, 0–1.
 *
 * Each stage reads the signal it is ABOUT, so a fuzzy match is refined by its
 * similarity and a lexical one by its rank — and neither is refined by the
 * other, because a `ts_rank` computed for a different retrieval says nothing
 * about a trigram distance. The `filterAgreement` term is added to every stage
 * at a fixed small weight, since it is a property of the request rather than of
 * the retrieval.
 */
function stageRefinement(stage: SearchMatchStage, input: EntityRelevanceInput): number {
  const agreement = unit(input.filterAgreement);
  switch (stage) {
    case 'identifier':
      // Nothing refines an exact identifier: it either resolved to this entity
      // or it did not. The agreement term still applies, so a filtered request
      // orders two identifier hits sensibly.
      return agreement;
    case 'exact_name':
      return Math.max(agreement, unit(input.tokenOverlap) * 0.5 + agreement * 0.5);
    case 'exact_alias':
      return (
        ALIAS_QUALITY[input.aliasKind ?? 'name_variant'] * 0.7 + agreement * 0.3
      );
    case 'prefix':
      return unit(input.trigramSimilarity) * 0.6 + agreement * 0.4;
    case 'lexical':
      return unit(input.lexicalRank) * 0.7 + agreement * 0.3;
    case 'token':
      return unit(input.tokenOverlap) * 0.7 + agreement * 0.3;
    case 'fuzzy':
      return unit(input.trigramSimilarity) * 0.8 + agreement * 0.2;
  }
}

/**
 * Score one entity against one query.
 *
 * Total: the strongest stage's floor plus its earned headroom, clamped to 1.
 * Deterministic — the same inputs always give the same number, on every
 * machine, which is what makes the keyset cursor able to resume from a score.
 */
export function scoreEntityRelevance(input: EntityRelevanceInput): number {
  const stage = strongestStage(input.stages);
  const score = STAGE_FLOOR[stage] + STAGE_HEADROOM[stage] * unit(stageRefinement(stage, input));
  return score >= 1 ? 1 : score;
}

/**
 * How many of the requested structured filters an entity satisfies.
 *
 * `requested` of zero answers 1 rather than 0: an unfiltered request must not
 * push every result to the bottom of its own stage's band, and "satisfied all
 * nothing of them" is vacuously true.
 */
export function filterAgreementRatio(satisfied: number, requested: number): number {
  if (requested <= 0) return 1;
  return unit(satisfied / requested);
}
