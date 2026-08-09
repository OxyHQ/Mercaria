/**
 * Request schemas for `/internal/catalog-condition/*` (#90).
 *
 * Every one is `.strict()`, which is doing real work here rather than being a
 * habit: the operator surface is the only place a mapping rule and a category
 * restriction can be created, and an unrecognised key silently ignored is how a
 * `confidence` that was meant to be `0.4` lands as the column default nobody
 * chose.
 */

import { z } from 'zod';
import {
  CONDITION_RESTRICTION_REASONS,
  CONNECTOR_PROVIDER_IDS,
  ITEM_CONDITION_KEYS,
} from '@mercaria/shared-types';
import type {
  ConditionRestrictionReason,
  ConnectorProviderId,
  ItemConditionKey,
} from '@mercaria/shared-types';

/**
 * A shared tuple, narrowed to the non-empty form `z.enum` requires.
 *
 * The `asEnumValues` reasoning at the HTTP boundary: reading the SAME tuples the
 * Postgres CHECKs are rendered from is what stops a taxonomy key being storable
 * and unreachable, and checking non-emptiness at module load beats asserting it
 * with a cast.
 */
function enumValues<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error('A z.enum of no values rejects every request');
  }
  return [first, ...rest];
}

const CONDITION_KEY_VALUES = enumValues<ItemConditionKey>(ITEM_CONDITION_KEYS);
const PROVIDER_VALUES = enumValues<ConnectorProviderId>(CONNECTOR_PROVIDER_IDS);
const RESTRICTION_VALUES = enumValues<ConditionRestrictionReason>(CONDITION_RESTRICTION_REASONS);

/** `POST /internal/catalog-condition/mapping-rulesets` — open a DRAFT version. */
export const conditionRulesetDraftSchema = z
  .object({
    provider: z.enum(PROVIDER_VALUES),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/**
 * `PUT /internal/catalog-condition/mapping-rulesets/:id/mappings` — replace a
 * draft's rules.
 *
 * `confidence` is REQUIRED and unbounded by the schema beyond `[0, 1]`, on
 * purpose: a rule below `CONDITION_MAPPING_CONFIDENCE_FLOOR` is a legitimate,
 * reviewable statement that a source's wording PROBABLY means something. What
 * it may not do is reach an offer, and that is enforced by the `offers` CHECKs
 * rather than by refusing to record it here — deleting the evidence would make
 * the review queue impossible to build.
 */
export const conditionRulesetMappingsSchema = z
  .object({
    mappings: z
      .array(
        z
          .object({
            sourceLabel: z.string().trim().min(1).max(200),
            conditionKey: z.enum(CONDITION_KEY_VALUES),
            confidence: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

/** `POST /internal/catalog-condition/mapping-rulesets/:id/publish`. */
export const conditionRulesetPublishSchema = z.object({}).strict();

/** `PUT /internal/catalog-condition/category-policies` — record a restriction. */
export const conditionCategoryPolicySchema = z
  .object({
    categoryId: z.string().trim().min(1),
    conditionKey: z.enum(CONDITION_KEY_VALUES),
    restriction: z.enum(RESTRICTION_VALUES),
    includeDescendants: z.boolean().optional(),
    // A refusal quotes this back to the seller, so an empty one would produce
    // "This category does not accept this condition: " — a message that reads as
    // a bug and tells them nothing.
    reason: z.string().trim().min(10).max(500),
  })
  .strict();
