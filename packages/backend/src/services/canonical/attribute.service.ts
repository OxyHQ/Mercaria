/**
 * The attribute registry and the normalized attribute values (#56 attributes
 * 1–5).
 *
 * ## Applying a source fact, and the three things that can happen
 *
 * {@link applyAttributeObservation} records what a source said and then decides
 * whether it can be SELECTED — the value a read surface shows:
 *
 * 1. Nothing else has been said about this attribute: the fact is selected.
 * 2. Another source said the SAME normalized thing: the fact is recorded, the
 *    selection stands, and nothing moves.
 * 3. Another source said something DIFFERENT: neither is selected, both are
 *    marked `conflicting`, and the disagreement is the stored answer.
 *
 * Case 3 is the whole point of #56 attribute rule 4. There is no confidence
 * tie-break, no "most recent wins", no source ranking — every one of those is a
 * guess dressed as a policy, and the cost of guessing wrong is a product page
 * asserting a specification the manufacturer never published. An operator
 * resolves it with {@link selectAttributeValue}, which is a decision somebody
 * made rather than one the code invented.
 *
 * The one asymmetry: a HIGHER-confidence source (or a deterministic/human one,
 * which is `undefined` confidence and outranks every number — the ADR 0002 D19
 * reading) may replace a strictly weaker selection without a conflict. Filling
 * absence and improving evidence are not the same act as contradicting a peer.
 */

import type { AttributeNormalizationState } from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  addAttributeDefinitionCategory,
  clearAttributeValueSelection,
  findAttributeDefinitionByKey,
  findAttributeValueById,
  insertAttributeDefinition,
  listAttributeDefinitionCategories,
  listAttributeDefinitions,
  listAttributeDefinitionsForCategory,
  listAttributeValues,
  listAttributeValuesForKey,
  markAttributeValuesConflicting,
  setAttributeValueSelected,
  upsertAttributeValue,
  type AnnotationGrain,
  type AttributeDefinitionRow,
  type CanonicalAttributeValueRow,
} from '../../db/canonical/attributeRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { normalizeAttributeKey, normalizeOptionValue } from './variant-signature.js';
import { BASE_UNITS, normalizeQuantity } from './units.js';

/** The grains an attribute value may annotate. A family has no specifications. */
export type AttributeGrain = Extract<AnnotationGrain, { kind: 'product' | 'variant' }>;

export interface DefineAttributeInput {
  key: string;
  label: string;
  valueType: AttributeDefinitionRow['valueType'];
  unitFamily?: AttributeDefinitionRow['unitFamily'];
  allowedValues?: string[];
  description?: string;
  /** Category ids this definition applies to. Empty means it applies anywhere. */
  categoryIds?: string[];
}

/**
 * Register an attribute definition.
 *
 * `baseUnit` is DERIVED from the unit family rather than accepted from the
 * caller: a family has exactly one base unit, so letting a caller name a second
 * one would produce two definitions whose normalized magnitudes are in different
 * units while both claim to be normalized.
 */
export async function defineAttribute(
  input: DefineAttributeInput,
): Promise<AttributeDefinitionRow> {
  const key = normalizeAttributeKey(input.key);
  if (!/^[a-z][a-z0-9_]*$/u.test(key)) {
    throw validationError(
      `Attribute key '${input.key}' must match ^[a-z][a-z0-9_]*$ — it is a stable machine name, never a label.`,
    );
  }
  if ((input.valueType === 'quantity') !== (input.unitFamily !== undefined)) {
    throw validationError(
      'A quantity attribute needs a unit family, and no other value type may carry one.',
    );
  }
  if (input.valueType === 'enum' && (input.allowedValues ?? []).length === 0) {
    throw validationError('An enum attribute with no allowed values admits nothing.');
  }

  return getDb().transaction(async (tx) => {
    const existing = await findAttributeDefinitionByKey(tx, key);
    if (existing) throw conflict(`Attribute '${key}' is already defined.`);

    const definition = await insertAttributeDefinition(tx, {
      key,
      label: input.label.trim(),
      valueType: input.valueType,
      ...(input.unitFamily === undefined
        ? {}
        : { unitFamily: input.unitFamily, baseUnit: BASE_UNITS[input.unitFamily] }),
      ...(input.allowedValues === undefined ? {} : { allowedValues: input.allowedValues }),
      ...(input.description === undefined ? {} : { description: input.description }),
    });
    for (const categoryId of input.categoryIds ?? []) {
      await addAttributeDefinitionCategory(tx, definition.id, categoryId);
    }
    return definition;
  });
}

export async function getAttributeDefinition(
  key: string,
): Promise<AttributeDefinitionRow | undefined> {
  return findAttributeDefinitionByKey(getDb(), normalizeAttributeKey(key));
}

export async function listAllAttributeDefinitions(): Promise<AttributeDefinitionRow[]> {
  return listAttributeDefinitions(getDb());
}

export async function listAttributeDefinitionsInCategory(
  categoryId: string,
): Promise<AttributeDefinitionRow[]> {
  return listAttributeDefinitionsForCategory(getDb(), categoryId);
}

export async function listAttributeCategoryScope(
  attributeDefinitionId: string,
): Promise<string[]> {
  return listAttributeDefinitionCategories(getDb(), attributeDefinitionId);
}

/** The normalization of one display string, against its definition when one exists. */
export interface AttributeNormalizationResult {
  readonly state: AttributeNormalizationState;
  readonly normalizedText?: string;
  readonly normalizedNumber?: number;
  readonly normalizedUnit?: string;
  readonly normalizedBoolean?: boolean;
}

/**
 * Normalize a source display string for storage.
 *
 * With no definition the value is folded text — the honest reading, since
 * nothing has declared what the attribute measures. With one, the declared
 * `valueType` decides, and a value that does not fit its declaration is
 * `unparsed` rather than coerced: "about 3" is not the number 3.
 */
export function normalizeAttributeValue(
  displayValue: string,
  definition?: AttributeDefinitionRow,
): AttributeNormalizationResult {
  const trimmed = displayValue.trim();
  if (trimmed.length === 0) return { state: 'unparsed' };

  if (!definition) return { state: 'normalized', normalizedText: normalizeOptionValue(trimmed) };

  switch (definition.valueType) {
    case 'quantity': {
      const quantity = normalizeQuantity(trimmed);
      if (quantity.state !== 'normalized') return { state: quantity.state };
      if (quantity.baseMagnitude === undefined || quantity.baseUnit === undefined) {
        return { state: 'unparsed' };
      }
      // A magnitude in the wrong dimension is not a rounding problem: 6 kg is
      // not a screen size, and storing it would compare against millimetres.
      if (definition.baseUnit !== null && quantity.baseUnit !== definition.baseUnit) {
        return { state: 'unknown_unit' };
      }
      return {
        state: 'normalized',
        normalizedNumber: quantity.baseMagnitude,
        normalizedUnit: quantity.baseUnit,
      };
    }
    case 'number': {
      if (!/^-?\d+(?:\.\d+)?$/u.test(trimmed)) return { state: 'unparsed' };
      return { state: 'normalized', normalizedNumber: Number(trimmed) };
    }
    case 'boolean': {
      const folded = trimmed.toLowerCase();
      if (['true', 'yes', '1'].includes(folded)) {
        return { state: 'normalized', normalizedBoolean: true };
      }
      if (['false', 'no', '0'].includes(folded)) {
        return { state: 'normalized', normalizedBoolean: false };
      }
      return { state: 'unparsed' };
    }
    case 'enum': {
      const folded = normalizeOptionValue(trimmed);
      const match = definition.allowedValues.find(
        (allowed) => normalizeOptionValue(allowed) === folded,
      );
      if (match === undefined) return { state: 'unparsed' };
      return { state: 'normalized', normalizedText: normalizeOptionValue(match) };
    }
    case 'text':
      return { state: 'normalized', normalizedText: normalizeOptionValue(trimmed) };
  }
}

/** Two normalized values agree when every normalized column agrees. */
function normalizedValuesAgree(
  left: CanonicalAttributeValueRow,
  right: AttributeNormalizationResult,
): boolean {
  return (
    left.normalizationState === right.state &&
    left.normalizedText === (right.normalizedText ?? null) &&
    left.normalizedNumber === (right.normalizedNumber ?? null) &&
    left.normalizedUnit === (right.normalizedUnit ?? null) &&
    left.normalizedBoolean === (right.normalizedBoolean ?? null)
  );
}

/** NULL confidence means deterministic or human, which outranks every number. */
function strengthOf(confidence: number | null | undefined): number {
  return confidence === null || confidence === undefined ? 1 : confidence;
}

export interface ApplyAttributeObservationInput {
  grain: AttributeGrain;
  attributeKey: string;
  /** The source's own words. Stored verbatim whatever happens next. */
  displayValue: string;
  sourceRecordId: string;
  /** 0–1; omit for a deterministic or human assertion. */
  confidence?: number;
}

export type ApplyAttributeObservationOutcome =
  /** Recorded and selected — nothing contradicted it. */
  | 'selected'
  /** Recorded; an equal value was already selected, so nothing moved. */
  | 'agreed'
  /** Recorded; it contradicts the selection, so BOTH are now conflicting. */
  | 'conflicting'
  /** Recorded; a stronger source's selection stands. */
  | 'weaker'
  /** Identical observation re-applied. Nothing was written at all. */
  | 'unchanged';

export interface ApplyAttributeObservationResult {
  readonly outcome: ApplyAttributeObservationOutcome;
  readonly value: CanonicalAttributeValueRow;
}

/**
 * Record one attribute fact and decide the selection. See the module header for
 * the three cases and why none of them guesses.
 */
export async function applyAttributeObservation(
  input: ApplyAttributeObservationInput,
): Promise<ApplyAttributeObservationResult> {
  if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1)) {
    throw validationError('applyAttributeObservation: confidence must be within [0, 1].');
  }
  const attributeKey = normalizeAttributeKey(input.attributeKey);
  if (attributeKey.length === 0) {
    throw validationError('applyAttributeObservation: attributeKey must be non-empty.');
  }

  return getDb().transaction(async (tx) => {
    const definition = await findAttributeDefinitionByKey(tx, attributeKey);
    const normalized = normalizeAttributeValue(input.displayValue, definition);

    const inserted = await upsertAttributeValue(tx, {
      grain: input.grain,
      attributeKey,
      sourceDisplayValue: input.displayValue.trim(),
      sourceRecordId: input.sourceRecordId,
      normalizationState: normalized.state,
      ...(definition === undefined ? {} : { attributeDefinitionId: definition.id }),
      ...(normalized.normalizedText === undefined
        ? {}
        : { normalizedText: normalized.normalizedText }),
      ...(normalized.normalizedNumber === undefined
        ? {}
        : { normalizedNumber: normalized.normalizedNumber }),
      ...(normalized.normalizedUnit === undefined
        ? {}
        : { normalizedUnit: normalized.normalizedUnit }),
      ...(normalized.normalizedBoolean === undefined
        ? {}
        : { normalizedBoolean: normalized.normalizedBoolean }),
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    });

    const siblings = await listAttributeValuesForKey(tx, input.grain, attributeKey);
    if (!inserted) {
      // The convergence unique absorbed it: this exact observation was already
      // recorded. A genuine no-op — no tuple version, no selection change.
      const existing = siblings.find((row) => row.sourceRecordId === input.sourceRecordId);
      if (!existing) {
        throw new Error(
          `Attribute '${attributeKey}' for ${input.grain.kind} ${input.grain.id} was neither inserted nor found.`,
        );
      }
      return { outcome: 'unchanged', value: existing };
    }

    // Only a NORMALIZED fact is eligible to be shown. An unparsed or
    // unknown-unit reading is kept as a source fact and shows nothing.
    if (normalized.state !== 'normalized') return { outcome: 'weaker', value: inserted };

    const selected = siblings.find((row) => row.selected && row.id !== inserted.id);
    if (!selected) {
      const marked = await setAttributeValueSelected(tx, inserted.id, true);
      return { outcome: 'selected', value: marked ?? inserted };
    }
    if (normalizedValuesAgree(selected, normalized)) {
      return { outcome: 'agreed', value: inserted };
    }

    // A strictly stronger source may replace a weaker selection: improving the
    // evidence behind a value is not the same act as contradicting a peer.
    if (strengthOf(input.confidence) > strengthOf(selected.confidence)) {
      await clearAttributeValueSelection(tx, input.grain, attributeKey);
      const marked = await setAttributeValueSelected(tx, inserted.id, true);
      return { outcome: 'selected', value: marked ?? inserted };
    }
    if (strengthOf(input.confidence) < strengthOf(selected.confidence)) {
      return { outcome: 'weaker', value: inserted };
    }

    // Equal standing, different answers. Neither is shown, both say so.
    await markAttributeValuesConflicting(tx, [selected.id, inserted.id]);
    const refreshed = await listAttributeValuesForKey(tx, input.grain, attributeKey);
    const mine = refreshed.find((row) => row.id === inserted.id);
    return { outcome: 'conflicting', value: mine ?? inserted };
  });
}

/**
 * An operator picks the value to show — the resolution a conflict waits for.
 *
 * The chosen row's normalized value is left exactly as it was recorded; nothing
 * here rewrites a source's words or magnitude. Choosing which existing fact is
 * authoritative is a decision; inventing a value is not available at all.
 */
export async function selectAttributeValue(
  valueId: string,
  actorOxyUserId: string,
): Promise<CanonicalAttributeValueRow> {
  if (actorOxyUserId.trim().length === 0) {
    throw validationError('selectAttributeValue: an actor is required.');
  }
  return getDb().transaction(async (tx) => {
    const row = await findAttributeValueById(tx, valueId);
    if (!row) throw notFound(`Attribute value ${valueId} does not exist.`);
    if (row.normalizationState !== 'normalized') {
      throw conflict(
        `Attribute value ${valueId} is '${row.normalizationState}' and carries no normalized value to show.`,
      );
    }
    const grain = attributeGrainOf(row);
    await clearAttributeValueSelection(tx, grain, row.attributeKey);
    const selected = await setAttributeValueSelected(tx, valueId, true);
    if (!selected) throw notFound(`Attribute value ${valueId} does not exist.`);
    return selected;
  });
}

/**
 * The grain a stored value belongs to.
 *
 * `canonical_attribute_values_grain_check` makes the third branch unreachable
 * for any row the database accepted; throwing rather than defaulting means a
 * schema change that dropped the CHECK surfaces here instead of quietly
 * treating a grain-less row as a product's.
 */
function attributeGrainOf(row: CanonicalAttributeValueRow): AttributeGrain {
  if (row.productId !== null) return { kind: 'product', id: row.productId };
  if (row.variantId !== null) return { kind: 'variant', id: row.variantId };
  throw new Error(`canonical_attribute_values ${row.id} has neither a product nor a variant.`);
}

/** Every recorded fact about one entity's attributes, conflicts included. */
export async function listEntityAttributeValues(
  grain: AttributeGrain,
): Promise<CanonicalAttributeValueRow[]> {
  return listAttributeValues(getDb(), grain);
}
