/**
 * Recording one source's attribute fact, and deciding what Mercaria shows
 * (#94 normalized values, coverage rules 2, 5, 6 and 8).
 *
 * This is #56's `applyAttributeObservation` carried forward with the registry
 * now versioned and the outcomes now typed. The decision procedure is unchanged
 * in spirit and that is deliberate — it was right:
 *
 * 1. Nothing else has been said about this attribute slot: the fact is selected.
 * 2. Another source said the SAME normalized thing: the fact is recorded, the
 *    selection stands, and the value becomes `corroborated`.
 * 3. Another source said something DIFFERENT at comparable standing: neither is
 *    selected, both are `conflicting`, and a review is opened.
 *
 * Case 3 is the whole point. There is no confidence tie-break at equal standing,
 * no "most recent wins", no source ranking — every one of those is a guess
 * dressed as a policy, and the cost of guessing wrong is a product page
 * asserting a specification the manufacturer never published.
 *
 * The one asymmetry: a strictly STRONGER source (or a deterministic/human one,
 * whose confidence is absent and outranks every number — the ADR 0002 D19
 * reading) replaces a weaker selection without a conflict. Filling absence and
 * improving evidence are not the same act as contradicting a peer.
 *
 * ## What #94 added on top
 *
 * - Agreement is compared at DECLARED PRECISION, so two sources that both mean
 *   154.94 mm are not made to look like a conflict by a float's last bit.
 * - A refusal (`unknown_unit`, `implausible`, `marketing_claim`) opens a REVIEW
 *   rather than disappearing into a state nobody queries.
 * - Every selection change enqueues a reindex request, because a search index
 *   watching the product row would never see this.
 */

import {
  type AttributeEntityKind,
  type SourceLinkMethod,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import {
  clearAttributeValueSelection,
  findAttributeValueById,
  listAttributeValues,
  listAttributeValuesForKey,
  markAttributeValuesConflicting,
  setAttributeValueSelectionState,
  setAttributeValueVerification,
  upsertAttributeValue,
  type AnnotationGrain,
  type CanonicalAttributeValueRow,
} from '../../db/canonical/attributeRepository.js';
import {
  enqueueAttributeReindex,
  findAttributeSourceMapping,
  openAttributeReview,
} from '../../db/attributes/attributeOpsRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { normalizeAttributeKey } from '../canonical/variant-signature.js';
import { resolveActiveDefinition, type ResolvedAttributeDefinition } from './definition-registry.service.js';
import {
  normalizeAttributeObservation,
  normalizedFactsAgree,
  RULE_VERSION,
  type NormalizedAttributeFact,
} from './normalization.service.js';

/** The grains an attribute value may annotate. A family has no specifications. */
export type AttributeGrain = Extract<AnnotationGrain, { kind: 'product' | 'variant' }>;

export interface ApplyAttributeObservationInput {
  grain: AttributeGrain;
  attributeKey: string;
  /** The source's own words. Stored verbatim whatever happens next. */
  displayValue: string;
  sourceRecordId: string;
  /** The registry source this observation came from, for its field mappings. */
  catalogSourceId?: string;
  /** The source's own field name, when it differs from the attribute key. */
  sourceField?: string;
  method?: SourceLinkMethod;
  observedAt?: Date;
  locale?: string;
  /** 0–1; omit for a deterministic or human assertion. */
  confidence?: number;
}

export type ApplyAttributeObservationOutcome =
  /** Recorded and selected — nothing contradicted it. */
  | 'selected'
  /** Recorded; an equal value was already selected, which is now corroborated. */
  | 'agreed'
  /** Recorded; it contradicts the selection, so BOTH are now conflicting. */
  | 'conflicting'
  /** Recorded; a stronger source's selection stands. */
  | 'weaker'
  /** Recorded, and unshowable: it could not be read, or it was refused. */
  | 'unusable'
  /** Identical observation re-applied. Nothing was written at all. */
  | 'unchanged';

export interface ApplyAttributeObservationResult {
  readonly outcome: ApplyAttributeObservationOutcome;
  readonly values: readonly CanonicalAttributeValueRow[];
}

/**
 * Record one attribute observation and decide the selection.
 *
 * ONE transaction, because a fact, its conflict marking, its review row and its
 * reindex request are one statement about the catalogue: a crash between them
 * would leave a conflict nobody was told about, or a review naming a value that
 * was never written.
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
    const definition = await resolveActiveDefinition(tx, attributeKey);
    const mapping =
      input.catalogSourceId === undefined
        ? undefined
        : await findAttributeSourceMapping(
            tx,
            input.catalogSourceId,
            (input.sourceField ?? attributeKey).trim().toLowerCase(),
          );

    const facts = normalizeAttributeObservation({
      displayValue: input.displayValue,
      ...(definition === undefined ? {} : { definition }),
      ...(mapping?.assumedUnit == null ? {} : { assumedUnit: mapping.assumedUnit }),
      ...(mapping?.componentAxis == null ? {} : { assumedAxis: mapping.componentAxis }),
    });

    const written: CanonicalAttributeValueRow[] = [];
    const outcomes: ApplyAttributeObservationOutcome[] = [];

    for (const fact of facts) {
      const result = await applyOneFact(tx, input, attributeKey, definition, fact);
      outcomes.push(result.outcome);
      if (result.value) written.push(result.value);
    }

    return { outcome: worstOutcome(outcomes), values: written };
  });
}

/**
 * The outcome a multi-component observation reports.
 *
 * The WORST of its parts, in the order below, because a caller deciding whether
 * to alert somebody cares about the component that went wrong, not the two that
 * went right. Reporting `selected` for a dimensions reading whose depth was
 * unreadable would be the exact shape of the false-pass this codebase's testing
 * rules warn about.
 */
const OUTCOME_SEVERITY: readonly ApplyAttributeObservationOutcome[] = [
  'unchanged',
  'agreed',
  'selected',
  'weaker',
  'conflicting',
  'unusable',
];

function worstOutcome(
  outcomes: readonly ApplyAttributeObservationOutcome[],
): ApplyAttributeObservationOutcome {
  let worst: ApplyAttributeObservationOutcome = 'unchanged';
  for (const outcome of outcomes) {
    if (OUTCOME_SEVERITY.indexOf(outcome) > OUTCOME_SEVERITY.indexOf(worst)) worst = outcome;
  }
  return worst;
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

async function applyOneFact(
  tx: Tx,
  input: ApplyAttributeObservationInput,
  attributeKey: string,
  definition: ResolvedAttributeDefinition | undefined,
  fact: NormalizedAttributeFact,
): Promise<{ outcome: ApplyAttributeObservationOutcome; value?: CanonicalAttributeValueRow }> {
  const inserted = await upsertAttributeValue(tx, {
    grain: input.grain,
    attributeKey,
    sourceDisplayValue: fact.sourceDisplayValue,
    sourceRecordId: input.sourceRecordId,
    normalizationState: fact.normalizationState,
    normalizationRuleVersion: RULE_VERSION,
    method: input.method ?? 'connector_declared',
    ...(definition === undefined
      ? {}
      : { attributeDefinitionId: definition.row.id, definitionVersion: definition.row.version }),
    ...(fact.sourceUnit === undefined ? {} : { sourceUnit: fact.sourceUnit }),
    ...(fact.normalizedText === undefined ? {} : { normalizedText: fact.normalizedText }),
    ...(fact.normalizedNumber === undefined ? {} : { normalizedNumber: fact.normalizedNumber }),
    ...(fact.normalizedNumberMax === undefined
      ? {}
      : { normalizedNumberMax: fact.normalizedNumberMax }),
    ...(fact.rangeLowerInclusive === undefined
      ? {}
      : { rangeLowerInclusive: fact.rangeLowerInclusive }),
    ...(fact.rangeUpperInclusive === undefined
      ? {}
      : { rangeUpperInclusive: fact.rangeUpperInclusive }),
    ...(fact.normalizedUnit === undefined ? {} : { normalizedUnit: fact.normalizedUnit }),
    ...(fact.normalizedBoolean === undefined ? {} : { normalizedBoolean: fact.normalizedBoolean }),
    ...(fact.normalizedDate === undefined ? {} : { normalizedDate: fact.normalizedDate }),
    ...(fact.normalizedAmountMinor === undefined
      ? {}
      : { normalizedAmountMinor: fact.normalizedAmountMinor }),
    ...(fact.normalizedCurrency === undefined
      ? {}
      : { normalizedCurrency: fact.normalizedCurrency }),
    ...(fact.componentAxis === undefined ? {} : { componentAxis: fact.componentAxis }),
    position: fact.position,
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt }),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
  });

  const slot = `${fact.componentAxis ?? ''}#${fact.position}`;
  const siblings = await listAttributeValuesForKey(tx, input.grain, attributeKey);
  const sameSlot = siblings.filter((row) => row.valueSlot === slot);

  if (!inserted) {
    // The convergence unique absorbed it: this exact observation was already
    // recorded. A genuine no-op — no tuple version, no selection change.
    const existing = sameSlot.find((row) => row.sourceRecordId === input.sourceRecordId);
    if (!existing) {
      throw new Error(
        `Attribute '${attributeKey}' for ${input.grain.kind} ${input.grain.id} slot ${slot} was neither inserted nor found.`,
      );
    }
    return { outcome: 'unchanged', value: existing };
  }

  // Only a NORMALIZED fact is eligible to be shown. An unreadable, out-of-range,
  // implausible or promotional reading is kept as a source fact, shows nothing,
  // and opens a review so the gap is visible rather than merely absent.
  if (fact.normalizationState !== 'normalized') {
    await openReviewForRefusal(tx, input, attributeKey, definition, fact);
    return { outcome: 'unusable', value: inserted };
  }

  const declaredDecimals = definition?.row.decimalPlaces ?? null;
  const selected = sameSlot.find(
    (row) => row.selectionState === 'selected' && row.id !== inserted.id,
  );

  if (!selected) {
    const marked = await selectValue(tx, input, attributeKey, inserted.id);
    return { outcome: 'selected', value: marked ?? inserted };
  }

  if (normalizedFactsAgree(toFact(selected), fact, declaredDecimals)) {
    // Two independent sources agreeing is CORROBORATION — a fact about the
    // world, not a confidence number either of them asserted about itself.
    if (selected.sourceRecordId !== inserted.sourceRecordId) {
      await setAttributeValueVerification(tx, [selected.id, inserted.id], 'corroborated');
    }
    return { outcome: 'agreed', value: inserted };
  }

  if (strengthOf(input.confidence) > strengthOf(selected.confidence)) {
    const marked = await selectValue(tx, input, attributeKey, inserted.id, slot);
    return { outcome: 'selected', value: marked ?? inserted };
  }
  if (strengthOf(input.confidence) < strengthOf(selected.confidence)) {
    return { outcome: 'weaker', value: inserted };
  }

  // Equal standing, different answers. Neither is shown, both say so, and a
  // person is asked.
  await markAttributeValuesConflicting(tx, [selected.id, inserted.id]);
  await openAttributeReview(tx, {
    entityKind: input.grain.kind,
    entityId: input.grain.id,
    attributeKey,
    definitionVersion: definition?.row.version ?? 0,
    reason: 'conflicting_sources',
    priority: reviewPriority(definition, 'conflicting_sources'),
    summary: `Two sources disagree on '${attributeKey}': ${selected.sourceDisplayValue} vs ${fact.sourceDisplayValue}.`,
  });
  await enqueueAttributeReindex(tx, {
    entityKind: input.grain.kind,
    entityId: input.grain.id,
    attributeKey,
    reason: 'selected_value_changed',
    ...(definition === undefined ? {} : { definitionVersion: definition.row.version }),
  });

  const refreshed = await listAttributeValuesForKey(tx, input.grain, attributeKey);
  const mine = refreshed.find((row) => row.id === inserted.id);
  return { outcome: 'conflicting', value: mine ?? inserted };
}

async function selectValue(
  tx: Tx,
  input: ApplyAttributeObservationInput,
  attributeKey: string,
  valueId: string,
  slot?: string,
): Promise<CanonicalAttributeValueRow | undefined> {
  if (slot !== undefined) {
    await clearAttributeValueSelection(tx, input.grain, attributeKey, slot);
  }
  const marked = await setAttributeValueSelectionState(tx, valueId, 'selected');
  await enqueueAttributeReindex(tx, {
    entityKind: input.grain.kind,
    entityId: input.grain.id,
    attributeKey,
    reason: 'selected_value_changed',
  });
  return marked;
}

/** A refusal opens a review naming which refusal it was. */
async function openReviewForRefusal(
  tx: Tx,
  input: ApplyAttributeObservationInput,
  attributeKey: string,
  definition: ResolvedAttributeDefinition | undefined,
  fact: NormalizedAttributeFact,
): Promise<void> {
  const reason =
    fact.normalizationState === 'unknown_unit'
      ? 'unknown_unit'
      : fact.normalizationState === 'implausible'
        ? 'implausible_value'
        : fact.normalizationState === 'marketing_claim'
          ? 'marketing_claim'
          : undefined;
  // `unparsed` and `out_of_range` deliberately open NO review: an unreadable
  // free-text field is the normal state of a messy feed and would flood the
  // queue past the point anyone works it, which is how a queue stops being read
  // at all. The three above are each a specific, fixable defect.
  if (reason === undefined) return;

  await openAttributeReview(tx, {
    entityKind: input.grain.kind,
    entityId: input.grain.id,
    attributeKey,
    definitionVersion: definition?.row.version ?? 0,
    reason,
    priority: reviewPriority(definition, reason),
    summary: `'${attributeKey}' from a source reads '${fact.sourceDisplayValue}' (${fact.normalizationState}).`,
  });
}

/**
 * How urgent a review is, frozen at open time.
 *
 * "High-impact" is a product judgement, and the two facts that make one are
 * whether a shopper can EXCLUDE on this attribute (a wrong hard-constrainable
 * value removes correct results) and whether the value is a contradiction rather
 * than a parse failure. Re-deriving this later against a changed catalogue would
 * silently reorder a queue somebody is working through, which is why it is a
 * stored integer.
 */
function reviewPriority(
  definition: ResolvedAttributeDefinition | undefined,
  reason: 'conflicting_sources' | 'implausible_value' | 'unknown_unit' | 'marketing_claim',
): number {
  let priority = reason === 'conflicting_sources' ? 50 : 20;
  if (definition?.row.hardConstraintCapable === true) priority += 40;
  if (definition?.row.filterable === true) priority += 10;
  return priority;
}

/** NULL confidence means deterministic or human, which outranks every number. */
function strengthOf(confidence: number | null | undefined): number {
  return confidence === null || confidence === undefined ? 1 : confidence;
}

/** A stored row, read back in the shape the comparator takes. */
function toFact(row: CanonicalAttributeValueRow): NormalizedAttributeFact {
  return {
    normalizationState: row.normalizationState,
    sourceDisplayValue: row.sourceDisplayValue,
    ...(row.sourceUnit === null ? {} : { sourceUnit: row.sourceUnit }),
    ...(row.normalizedText === null ? {} : { normalizedText: row.normalizedText }),
    ...(row.normalizedNumber === null ? {} : { normalizedNumber: row.normalizedNumber }),
    ...(row.normalizedNumberMax === null ? {} : { normalizedNumberMax: row.normalizedNumberMax }),
    ...(row.rangeLowerInclusive === null ? {} : { rangeLowerInclusive: row.rangeLowerInclusive }),
    ...(row.rangeUpperInclusive === null ? {} : { rangeUpperInclusive: row.rangeUpperInclusive }),
    ...(row.normalizedUnit === null ? {} : { normalizedUnit: row.normalizedUnit }),
    ...(row.normalizedBoolean === null ? {} : { normalizedBoolean: row.normalizedBoolean }),
    ...(row.normalizedDate === null ? {} : { normalizedDate: row.normalizedDate }),
    ...(row.normalizedAmountMinor === null
      ? {}
      : { normalizedAmountMinor: row.normalizedAmountMinor }),
    ...(row.normalizedCurrency === null ? {} : { normalizedCurrency: row.normalizedCurrency }),
    ...(row.componentAxis === null ? {} : { componentAxis: row.componentAxis }),
    position: row.position,
  };
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
    await clearAttributeValueSelection(tx, grain, row.attributeKey, row.valueSlot);
    const selected = await setAttributeValueSelectionState(tx, valueId, 'selected');
    if (!selected) throw notFound(`Attribute value ${valueId} does not exist.`);
    await setAttributeValueVerification(tx, [valueId], 'operator_verified');
    await enqueueAttributeReindex(tx, {
      entityKind: grain.kind,
      entityId: grain.id,
      attributeKey: row.attributeKey,
      reason: 'operator_correction',
    });
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

/** Narrow a raw string to the entity kinds this domain annotates. */
export function isAttributeEntityKind(value: string): value is AttributeEntityKind {
  return value === 'product' || value === 'variant';
}
