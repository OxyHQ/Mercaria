/**
 * Turning an external source's own condition wording into a taxonomy key —
 * or refusing to (#90 evidence rules 5 and 6, acceptance 5).
 *
 * ## The one rule this module exists to hold
 *
 * A low-confidence mapping is never upgraded. It stays `unknown`, it records
 * WHY, and the review queue can find it. The enforcement is not here: it is the
 * five `offers_condition_*_shape_check` constraints, which make every
 * disagreeing shape unrepresentable. This module's job is to produce the honest
 * one in the first place, and to make the sub-floor case visible rather than
 * discarding it.
 *
 * ## Absence, no rule, and a weak rule are three different outcomes
 *
 * - The source published no condition at all → `unmapped`, no label.
 * - The source published words nothing matched → `unmapped`, label preserved.
 *   Somebody can read the label and write a rule for it.
 * - A rule matched below the floor → `review_pending`, label and confidence
 *   preserved. Somebody has already guessed; the guess is recorded and unused.
 *
 * Collapsing the last two would lose the distinction between "we have no
 * opinion" and "we have an opinion we do not trust", which is the difference
 * between a taxonomy gap and a calibration problem.
 */

import {
  CONDITION_MAPPING_CONFIDENCE_FLOOR,
  normalizeSourceConditionLabel,
} from '@mercaria/shared-types';
import type {
  ConditionMappingProviderId,
  ConditionMappingState,
  OfferConditionKey,
} from '@mercaria/shared-types';
import {
  findActiveRuleset,
  findMappingForLabel,
} from '../../db/condition/conditionMappingRepository.js';

/**
 * The columns an offer write puts on the row.
 *
 * Shaped as the columns rather than as a verdict plus a lookup, because the
 * `offers` CHECKs constrain the COMBINATION and a caller assembling it from
 * three separate answers is a caller that can assemble an impossible one.
 */
export interface OfferConditionColumns {
  condition: OfferConditionKey;
  conditionSourceLabel: string | null;
  conditionMappingState: ConditionMappingState;
  conditionMappingConfidence: number | null;
  conditionMappingRulesetId: string | null;
}

/**
 * The columns a NATIVE offer carries.
 *
 * A native offer projects a listing Mercaria already holds, so its condition is
 * a first-party declaration: no source label, no confidence, no ruleset. There
 * is nothing to map, which is what `declared` means.
 */
export function declaredOfferCondition(condition: OfferConditionKey): OfferConditionColumns {
  return {
    condition,
    conditionSourceLabel: null,
    conditionMappingState: 'declared',
    conditionMappingConfidence: null,
    conditionMappingRulesetId: null,
  };
}

/** The columns an offer carries when its source said nothing about condition. */
export function unmappedOfferCondition(sourceLabel: string | null): OfferConditionColumns {
  return {
    condition: 'unknown',
    conditionSourceLabel: sourceLabel,
    conditionMappingState: 'unmapped',
    conditionMappingConfidence: null,
    conditionMappingRulesetId: null,
  };
}

/**
 * Map one source's condition wording under that provider's ACTIVE ruleset.
 *
 * Every path that cannot produce a confident key returns `unknown`, and none of
 * them throws: an unmappable condition is an ordinary property of a messy feed,
 * and refusing the whole observation over it would lose a price, an
 * availability and a destination because a retailer wrote "Grade B".
 *
 * `rulesetId` on the returned columns is the version that ACTUALLY read the
 * label, which is what makes a later correction traceable: publishing v2 does
 * not re-read anything, so an offer keeps saying which rules produced it until
 * something observes its source again.
 */
export async function mapSourceCondition(
  provider: ConditionMappingProviderId,
  rawLabel: string | null | undefined,
): Promise<OfferConditionColumns> {
  const label = rawLabel?.trim();
  if (!label) return unmappedOfferCondition(null);

  const ruleset = await findActiveRuleset(provider);
  if (!ruleset) {
    // No published rules for this provider yet. The words are kept so the first
    // ruleset can be written from what sources actually say rather than from a
    // guess about what they might.
    return unmappedOfferCondition(label);
  }

  const rule = await findMappingForLabel(ruleset.id, normalizeSourceConditionLabel(label));
  if (!rule) return unmappedOfferCondition(label);

  if (rule.confidence < CONDITION_MAPPING_CONFIDENCE_FLOOR) {
    // #90 evidence rule 6. The key the rule proposes is deliberately NOT carried
    // onto the offer — there is no column that could hold "we think it is
    // refurbished but are not sure", and inventing one is how a maybe becomes a
    // claim on a product page.
    return {
      condition: 'unknown',
      conditionSourceLabel: label,
      conditionMappingState: 'review_pending',
      conditionMappingConfidence: rule.confidence,
      conditionMappingRulesetId: ruleset.id,
    };
  }

  return {
    condition: rule.conditionKey,
    conditionSourceLabel: label,
    conditionMappingState: 'mapped',
    conditionMappingConfidence: rule.confidence,
    conditionMappingRulesetId: ruleset.id,
  };
}
