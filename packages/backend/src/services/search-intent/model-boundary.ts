/**
 * The model boundary, in both directions (#95 "Model boundary").
 *
 * ONE module rather than two, because the two halves are one decision: what
 * Mercaria hands a model bounds what a model can plausibly return, and what it
 * accepts back is defined against exactly that vocabulary. Splitting them would
 * let the two drift, and the drift has a direction — a vocabulary that grows
 * without the validator growing is a field a model may name and nothing
 * checks.
 *
 * ## Outbound: a closed vocabulary and nothing about the shopper
 *
 * `buildModelVocabulary` composes what a model may NAME from #94's live
 * registry: attribute keys with their labels (including every localized label
 * the registry carries — rule 4's "translate attribute labels through the
 * registry, not model-generated canonical keys"), their unit families, their
 * enum values and their `hardConstraintCapable` flag. Plus #90's condition
 * segments, Mercaria's presentment currencies and the bounded use tags.
 *
 * Everything the model does NOT get is the enforcement, and it is held by
 * `ModelParseInput`'s own shape (`@mercaria/shared-types`): no account id, no
 * session id, no email, no address, no coordinate, no payment detail, no saved
 * list, no order history, no cart. Safety rule 6 is the SIGNATURE, not a
 * redaction pass.
 *
 * ## Inbound: a candidate is untrusted input, checked in five passes
 *
 * 1. **A strict zod schema.** Undeclared keys are refused rather than stripped,
 *    bounded string lengths, bounded array sizes.
 * 2. **The injection scan** (`scanCandidateForInjection`), which refuses a tool
 *    call, a URL, code or an instruction.
 * 3. **Vocabulary resolution.** Every attribute key must be one of the keys
 *    that went OUT; every unit must resolve in #94's conversion table AND
 *    belong to the attribute's declared family; every enum value must be one the
 *    definition admits; every currency must be in Mercaria's set; every
 *    condition group and use tag must be in its closed tuple.
 * 4. **Element-level reporting.** An element that fails pass 3 is reported as an
 *    `IntentUnresolvedPhrase` and DROPPED — never approximated — and the rest of
 *    the candidate survives. #95's central rule is that an unresolvable term is
 *    reported, and reporting it costs nothing when the other requirements are
 *    fine.
 * 5. **A floor.** A candidate whose every element failed resolution is not a
 *    parse; it is noise. The caller falls back with `model_output_unresolvable`,
 *    which is a different fact from a provider failure and is counted
 *    separately.
 *
 * Note what is NOT in that list, because it cannot be: there is no check for a
 * product id, a merchant id, an offer id, a price assertion, an availability
 * assertion or a specification value. `CandidateIntent` has no field capable of
 * carrying one, so a check for them would be one that can never fail — which is
 * worse than no check, because it reads as coverage.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  CONDITION_GROUPS,
  INTENT_BUDGET_BASES,
  INTENT_CLARIFICATION_KINDS,
  INTENT_PHRASE_MAX_LENGTH,
  INTENT_QUERY_MAX_LENGTH,
  MAX_CLARIFICATIONS_PER_RESULT,
  MAX_ENTITY_MENTIONS,
  MAX_UNRESOLVED_PHRASES,
  MAX_USE_TAGS,
  OFFER_KINDS,
  SHOPPING_INTENT_PROMPT_VERSION,
  SHOPPING_INTENT_SCHEMA_VERSION,
  SHOPPING_USE_TAGS,
  type ConditionGroup,
  type ConstraintStrength,
  type CurrencyCode,
  type IntentBudgetBasis,
  type IntentClarificationKind,
  type IntentUnresolvedPhrase,
  type ModelParseAttribute,
  type ModelParseInput,
  type ModelParseVocabulary,
  type OfferKind,
  type ShoppingUseTag,
} from '@mercaria/shared-types';
import { resolveUnit, toBaseUnit, unitFamilyOf } from '../canonical/units.js';
import type { ResolvedAttributeDefinition } from '../attributes/definition-registry.service.js';
import { boundedPhrase, scanCandidateForInjection, sanitizeQueryForModel } from './injection.js';
import type { InterpretationDraft, InterpretedRequirement } from './deterministic.js';

/* -------------------------------------------------------------------------- */
/*  Outbound                                                                   */
/* -------------------------------------------------------------------------- */

/** The closed vocabulary a model may draw from, built from the live registry. */
export function buildModelVocabulary(
  definitions: readonly ResolvedAttributeDefinition[],
): ModelParseVocabulary {
  const attributes: ModelParseAttribute[] = definitions
    // A RETIRED or `draft` definition never reaches here: the caller resolves
    // active versions only. A DEPRECATED one does — #94 says a constraint on one
    // validates with a warning, and withholding it from the vocabulary would
    // make a model unable to express something a filter UI still offers.
    .filter((definition) => definition.row.filterable)
    .map((definition) => ({
      key: definition.row.key,
      label: definition.row.label,
      valueType: definition.row.valueType,
      ...(definition.row.baseUnit === null ? {} : { baseUnit: definition.row.baseUnit }),
      ...(definition.row.unitFamily === null ? {} : { unitFamily: definition.row.unitFamily }),
      ...(definition.enumValues.length === 0
        ? {}
        : { enumValues: definition.enumValues.map((value) => value.value) }),
      hardConstraintCapable: definition.row.hardConstraintCapable,
    }));
  return {
    attributes,
    conditionGroups: CONDITION_GROUPS,
    currencies: ALL_CURRENCY_CODES,
    useTags: SHOPPING_USE_TAGS,
    clarificationKinds: INTENT_CLARIFICATION_KINDS,
  };
}

/**
 * Compose the input a provider is handed.
 *
 * `deterministicSummary` is what the deterministic pass already understood, in
 * one line per element. It travels so a model is answering "what ELSE does this
 * say" rather than re-deriving what a rule already read correctly — and because
 * a model that re-derives it will occasionally derive it differently, which is
 * a disagreement nobody is in a position to adjudicate.
 */
export function buildModelInput(input: {
  readonly query: string;
  readonly locale: string;
  readonly language: string;
  readonly market?: string;
  readonly currency?: CurrencyCode;
  readonly categoryLabel?: string;
  readonly vocabulary: ModelParseVocabulary;
  readonly draft: InterpretationDraft;
}): ModelParseInput {
  return {
    query: sanitizeQueryForModel(input.query),
    locale: input.locale,
    language: input.language,
    ...(input.market === undefined ? {} : { market: input.market }),
    ...(input.currency === undefined ? {} : { currency: input.currency }),
    ...(input.categoryLabel === undefined ? {} : { categoryLabel: input.categoryLabel }),
    vocabulary: input.vocabulary,
    deterministicSummary: [
      ...input.draft.requirements.map((requirement) => requirement.explanation),
      ...(input.draft.budget === undefined ? [] : ['a budget was already read']),
      ...(input.draft.condition === undefined ? [] : ['a condition was already read']),
    ],
    promptVersion: SHOPPING_INTENT_PROMPT_VERSION,
    schemaVersion: SHOPPING_INTENT_SCHEMA_VERSION,
  };
}

/* -------------------------------------------------------------------------- */
/*  Inbound: the strict schema                                                 */
/* -------------------------------------------------------------------------- */

const boundedText = z.string().trim().min(1).max(INTENT_PHRASE_MAX_LENGTH);

const asEnum = <T extends string>(values: readonly T[]): readonly [T, ...T[]] => {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error('An enum schema needs at least one value.');
  return [first, ...rest];
};

/**
 * The candidate, as this module reads it after parsing.
 *
 * Written out rather than inferred with `z.infer`, and the reason is the same
 * one `middleware/attribute-schemas.ts` records: the backend compiles with
 * `strict: false`, under which `undefined extends T` holds for every `T`, so
 * zod's `addQuestionMarks` marks EVERY key optional and the inferred type has
 * nothing required in it. A reader would then have to guard every field the
 * schema already guarantees — and the guards would be dead code that looks like
 * diligence. The `.transform` below is what bridges the two, in ONE place.
 */
interface ParsedCandidate {
  readonly searchText: string;
  readonly categoryLabel?: string;
  readonly requirements: readonly ParsedRequirement[];
  readonly preferenceOrder: readonly string[];
  readonly budget?: {
    readonly basis: IntentBudgetBasis;
    readonly currency: CurrencyCode;
    readonly minMinor?: number;
    readonly maxMinor?: number;
    readonly sourcePhrase: string;
  };
  readonly conditionGroups?: readonly ConditionGroup[];
  readonly offerKinds?: readonly OfferKind[];
  readonly officialChannelOnly?: boolean;
  readonly nearby?: boolean;
  readonly entityMentions: readonly { readonly kind: 'brand' | 'merchant'; readonly text: string }[];
  readonly useTags: readonly ShoppingUseTag[];
  readonly unreadablePhrases: readonly string[];
  readonly clarificationKinds: readonly IntentClarificationKind[];
}

/** One requirement, as this module reads it. See {@link ParsedCandidate}. */
interface ParsedRequirement {
  readonly attributeKey: string;
  readonly strength: ConstraintStrength;
  readonly operator: 'eq' | 'gte' | 'lte' | 'between' | 'in' | 'is';
  readonly numberValue?: number;
  readonly numberUpperValue?: number;
  readonly unit?: string;
  readonly textValue?: string;
  readonly booleanValue?: boolean;
  readonly textValues?: readonly string[];
  readonly sourcePhrase: string;
}

/**
 * The candidate schema. `.strict()` at every level.
 *
 * Strict rather than stripping, because a key nobody declared is a signal
 * rather than noise: a model that returned `productId` did so for a reason, and
 * silently discarding it would hide the one observation worth having. It is
 * refused, counted as `invalid_model_output`, and the deterministic answer is
 * served — which costs the shopper nothing.
 */
const candidateSchema = z
  .object({
    searchText: z.string().trim().max(INTENT_QUERY_MAX_LENGTH),
    categoryLabel: boundedText.optional(),
    requirements: z
      .array(
        z
          .object({
            attributeKey: z.string().trim().min(1).max(64),
            strength: z.enum(['hard', 'preference']),
            operator: z.enum(['eq', 'gte', 'lte', 'between', 'in', 'is']),
            numberValue: z.number().finite().optional(),
            numberUpperValue: z.number().finite().optional(),
            unit: z.string().trim().min(1).max(16).optional(),
            textValue: boundedText.optional(),
            booleanValue: z.boolean().optional(),
            textValues: z.array(boundedText).min(1).max(16).optional(),
            sourcePhrase: boundedText,
          })
          .strict(),
      )
      .max(24),
    preferenceOrder: z.array(boundedText).max(24),
    budget: z
      .object({
        basis: z.enum(asEnum(INTENT_BUDGET_BASES)),
        currency: z.enum(asEnum(ALL_CURRENCY_CODES)),
        minMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        maxMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        sourcePhrase: boundedText,
      })
      .strict()
      .optional(),
    conditionGroups: z.array(z.enum(asEnum(CONDITION_GROUPS))).max(CONDITION_GROUPS.length).optional(),
    offerKinds: z.array(z.enum(asEnum(OFFER_KINDS))).max(OFFER_KINDS.length).optional(),
    officialChannelOnly: z.boolean().optional(),
    nearby: z.boolean().optional(),
    entityMentions: z
      .array(z.object({ kind: z.enum(['brand', 'merchant']), text: boundedText }).strict())
      .max(MAX_ENTITY_MENTIONS),
    useTags: z.array(z.enum(asEnum(SHOPPING_USE_TAGS))).max(MAX_USE_TAGS),
    unreadablePhrases: z.array(boundedText).max(MAX_UNRESOLVED_PHRASES),
    clarificationKinds: z
      .array(z.enum(asEnum(INTENT_CLARIFICATION_KINDS)))
      .max(MAX_CLARIFICATIONS_PER_RESULT),
  })
  .strict()
  .transform(
    (value): ParsedCandidate => ({
      searchText: value.searchText ?? '',
      ...(value.categoryLabel === undefined ? {} : { categoryLabel: value.categoryLabel }),
      requirements: (value.requirements ?? []).map((requirement) => ({
        attributeKey: requirement.attributeKey ?? '',
        strength: requirement.strength ?? 'preference',
        operator: requirement.operator ?? 'eq',
        ...(requirement.numberValue === undefined ? {} : { numberValue: requirement.numberValue }),
        ...(requirement.numberUpperValue === undefined
          ? {}
          : { numberUpperValue: requirement.numberUpperValue }),
        ...(requirement.unit === undefined ? {} : { unit: requirement.unit }),
        ...(requirement.textValue === undefined ? {} : { textValue: requirement.textValue }),
        ...(requirement.booleanValue === undefined
          ? {}
          : { booleanValue: requirement.booleanValue }),
        ...(requirement.textValues === undefined ? {} : { textValues: requirement.textValues }),
        sourcePhrase: requirement.sourcePhrase ?? '',
      })),
      preferenceOrder: value.preferenceOrder ?? [],
      ...(value.budget === undefined
        ? {}
        : {
            budget: {
              basis: value.budget.basis ?? 'item_price',
              currency: value.budget.currency ?? 'EUR',
              ...(value.budget.minMinor === undefined ? {} : { minMinor: value.budget.minMinor }),
              ...(value.budget.maxMinor === undefined ? {} : { maxMinor: value.budget.maxMinor }),
              sourcePhrase: value.budget.sourcePhrase ?? '',
            },
          }),
      ...(value.conditionGroups === undefined ? {} : { conditionGroups: value.conditionGroups }),
      ...(value.offerKinds === undefined ? {} : { offerKinds: value.offerKinds }),
      ...(value.officialChannelOnly === undefined
        ? {}
        : { officialChannelOnly: value.officialChannelOnly }),
      ...(value.nearby === undefined ? {} : { nearby: value.nearby }),
      entityMentions: (value.entityMentions ?? []).map((mention) => ({
        kind: mention.kind ?? 'brand',
        text: mention.text ?? '',
      })),
      useTags: value.useTags ?? [],
      unreadablePhrases: value.unreadablePhrases ?? [],
      clarificationKinds: value.clarificationKinds ?? [],
    }),
  );

/* -------------------------------------------------------------------------- */
/*  Inbound: resolution                                                        */
/* -------------------------------------------------------------------------- */

/** What validating a candidate produced. A string discriminant, as everywhere. */
export type CandidateValidation =
  | {
      readonly status: 'accepted';
      readonly requirements: readonly InterpretedRequirement[];
      readonly categoryLabel?: string;
      readonly budget?: ParsedCandidate['budget'];
      readonly conditionGroups?: readonly ConditionGroup[];
      readonly officialChannelOnly?: boolean;
      readonly nearby?: boolean;
      readonly useTags: readonly ShoppingUseTag[];
      readonly entityMentions: readonly { readonly kind: 'brand' | 'merchant'; readonly text: string }[];
      readonly clarificationKinds: readonly IntentClarificationKind[];
      readonly unresolved: readonly IntentUnresolvedPhrase[];
      readonly searchText: string;
    }
  | { readonly status: 'rejected'; readonly reason: 'invalid_shape' | 'unsafe' | 'unresolvable' };

/**
 * Validate one model candidate against the registry it was given.
 *
 * `idPrefix` keeps a model-derived requirement's id distinct from a
 * deterministic one's, so a merge cannot collide two constraints and so an
 * operator reading a trace can tell which interpreter produced which — the
 * `origin` field says it too, and two independent spellings of one fact is
 * acceptable here precisely because they are derived from different things (the
 * id from the builder, the origin from the merge).
 */
export function validateCandidate(
  raw: unknown,
  definitions: readonly ResolvedAttributeDefinition[],
  idPrefix: string,
): CandidateValidation {
  const parsed = candidateSchema.safeParse(raw);
  if (!parsed.success) return { status: 'rejected', reason: 'invalid_shape' };
  const candidate = parsed.data;

  const scan = scanCandidateForInjection(candidate);
  if (scan.verdict === 'rejected') return { status: 'rejected', reason: 'unsafe' };

  const byKey = new Map(definitions.map((definition) => [definition.row.key, definition]));
  const unresolved: IntentUnresolvedPhrase[] = [];
  const requirements: InterpretedRequirement[] = [];
  let sequence = 0;

  for (const requirement of candidate.requirements) {
    sequence += 1;
    const definition = byKey.get(requirement.attributeKey);
    if (definition === undefined) {
      // Model-boundary rule 4: a model may MAP language to a known attribute and
      // may not create one. A key nobody defined resolves against nothing.
      unresolved.push({
        kind: 'unknown_attribute',
        phrase: boundedPhrase(requirement.sourcePhrase),
        explanation: `We do not have an attribute called “${boundedPhrase(requirement.attributeKey)}”, so we could not use “${boundedPhrase(requirement.sourcePhrase)}”.`,
      });
      continue;
    }
    const built = buildRequirement(requirement, definition, `${idPrefix}-${sequence}`);
    if (built.status === 'unresolved') {
      unresolved.push(built.report);
      continue;
    }
    requirements.push(built.requirement);
  }

  // Pass 5: a candidate whose every element failed is not a parse. The floor is
  // "at least one element resolved OR the model correctly claimed there was
  // nothing structured to find" — the second half matters, because a query that
  // genuinely carries no requirements is a legitimate parse and treating it as
  // a failure would make the fallback rate read high on exactly the simple
  // queries the model handles fine.
  const claimedSomething =
    candidate.requirements.length > 0 ||
    candidate.budget !== undefined ||
    candidate.conditionGroups !== undefined ||
    candidate.entityMentions.length > 0;
  if (claimedSomething && requirements.length === 0 && candidate.budget === undefined) {
    return { status: 'rejected', reason: 'unresolvable' };
  }

  return {
    status: 'accepted',
    requirements,
    ...(candidate.categoryLabel === undefined ? {} : { categoryLabel: candidate.categoryLabel }),
    ...(candidate.budget === undefined ? {} : { budget: candidate.budget }),
    ...(candidate.conditionGroups === undefined
      ? {}
      : { conditionGroups: candidate.conditionGroups }),
    ...(candidate.officialChannelOnly === undefined
      ? {}
      : { officialChannelOnly: candidate.officialChannelOnly }),
    ...(candidate.nearby === undefined ? {} : { nearby: candidate.nearby }),
    useTags: candidate.useTags,
    entityMentions: candidate.entityMentions,
    clarificationKinds: candidate.clarificationKinds,
    unresolved: [
      ...unresolved,
      ...candidate.unreadablePhrases.map((phrase) => ({
        kind: 'ambiguous_phrase' as const,
        phrase: boundedPhrase(phrase),
        explanation: `We could not work out what “${boundedPhrase(phrase)}” should narrow, so we left it in your search text.`,
      })),
    ].slice(0, MAX_UNRESOLVED_PHRASES),
    searchText: candidate.searchText,
  };
}

/** One requirement, resolved or reported. */
type BuiltRequirement =
  | { readonly status: 'built'; readonly requirement: InterpretedRequirement }
  | { readonly status: 'unresolved'; readonly report: IntentUnresolvedPhrase };

/**
 * Turn one candidate requirement into a real one, or report why not.
 *
 * The UNIT check is the one worth reading. A unit must resolve in #94's
 * conversion table AND belong to the attribute's own declared family, and both
 * halves are load-bearing in different ways: the first stops a unit nobody
 * defined, and the second stops `14 kg` being accepted as a screen size because
 * the model paired a real unit with the wrong attribute. Either failure is
 * reported and neither is corrected — correcting it would mean choosing an
 * attribute the shopper did not name.
 */
function buildRequirement(
  requirement: ParsedRequirement,
  definition: ResolvedAttributeDefinition,
  id: string,
): BuiltRequirement {
  const phrase = boundedPhrase(requirement.sourcePhrase);
  const strength: ConstraintStrength =
    requirement.strength === 'hard' && definition.row.hardConstraintCapable
      ? 'hard'
      : 'preference';

  if (requirement.operator === 'is') {
    if (definition.row.valueType !== 'boolean' || requirement.booleanValue === undefined) {
      return {
        status: 'unresolved',
        report: {
          kind: 'unknown_attribute',
          phrase,
          explanation: `“${boundedPhrase(definition.row.label)}” is not a yes/no attribute, so we could not read “${phrase}” as one.`,
        },
      };
    }
    return {
      status: 'built',
      requirement: {
        id,
        attributeKey: definition.row.key,
        definitionVersion: definition.row.version,
        strength,
        predicate: { op: 'is', value: requirement.booleanValue },
        origin: 'model_inferred',
        sourcePhrase: phrase,
        explanation: `${definition.row.label} is ${requirement.booleanValue ? 'yes' : 'no'}`,
      },
    };
  }

  if (requirement.operator === 'eq' && requirement.textValue !== undefined) {
    const resolved = resolveEnumValue(definition, requirement.textValue);
    if (resolved === undefined) {
      return {
        status: 'unresolved',
        report: {
          kind: 'unknown_enum_value',
          phrase,
          explanation: `“${boundedPhrase(requirement.textValue)}” is not a value ${definition.row.label} can take.`,
        },
      };
    }
    return {
      status: 'built',
      requirement: {
        id,
        attributeKey: definition.row.key,
        definitionVersion: definition.row.version,
        strength,
        predicate: { op: 'eq', value: { type: 'string', value: resolved } },
        origin: 'model_inferred',
        sourcePhrase: phrase,
        explanation: `${definition.row.label} is ${resolved}`,
      },
    };
  }

  if (requirement.numberValue === undefined) {
    return {
      status: 'unresolved',
      report: {
        kind: 'unattached_quantity',
        phrase,
        explanation: `We could not read a value for ${definition.row.label} out of “${phrase}”.`,
      },
    };
  }

  // A measurement requirement needs a unit, and it must be the attribute's own
  // family. A NUMERIC (integer/decimal) attribute takes no unit at all.
  if (definition.row.valueType === 'measurement' || definition.row.valueType === 'structured') {
    const unit = requirement.unit === undefined ? null : resolveUnit(requirement.unit);
    if (unit === null) {
      return {
        status: 'unresolved',
        report: {
          kind: 'unknown_unit',
          phrase,
          explanation: `We do not recognise “${boundedPhrase(requirement.unit ?? '')}” as a unit for ${definition.row.label}.`,
        },
      };
    }
    if (unitFamilyOf(unit) !== definition.row.unitFamily) {
      return {
        status: 'unresolved',
        report: {
          kind: 'unknown_unit',
          phrase,
          explanation: `${definition.row.label} is not measured in ${boundedPhrase(unit)}.`,
        },
      };
    }
    if (toBaseUnit(requirement.numberValue, unit) === null) {
      return {
        status: 'unresolved',
        report: {
          kind: 'unknown_unit',
          phrase,
          explanation: `We could not convert “${phrase}” into the unit ${definition.row.label} is compared in.`,
        },
      };
    }
    return {
      status: 'built',
      requirement: {
        id,
        attributeKey: definition.row.key,
        definitionVersion: definition.row.version,
        strength,
        predicate: numericPredicate(requirement, {
          type: 'measurement',
          magnitude: requirement.numberValue,
          unit,
        }, requirement.numberUpperValue === undefined
          ? undefined
          : { type: 'measurement', magnitude: requirement.numberUpperValue, unit }),
        origin: 'model_inferred',
        sourcePhrase: phrase,
        explanation: `${definition.row.label} ${describeOperator(requirement.operator)} ${requirement.numberValue} ${unit}`,
      },
    };
  }

  if (definition.row.valueType !== 'integer' && definition.row.valueType !== 'decimal') {
    return {
      status: 'unresolved',
      report: {
        kind: 'unknown_attribute',
        phrase,
        explanation: `${definition.row.label} does not take a number.`,
      },
    };
  }
  const numberType = definition.row.valueType === 'integer' ? 'integer' : 'decimal';
  return {
    status: 'built',
    requirement: {
      id,
      attributeKey: definition.row.key,
      definitionVersion: definition.row.version,
      strength,
      predicate: numericPredicate(
        requirement,
        { type: numberType, value: requirement.numberValue },
        requirement.numberUpperValue === undefined
          ? undefined
          : { type: numberType, value: requirement.numberUpperValue },
      ),
      origin: 'model_inferred',
      sourcePhrase: phrase,
      explanation: `${definition.row.label} ${describeOperator(requirement.operator)} ${requirement.numberValue}`,
    },
  };
}

/**
 * The predicate for a numeric candidate requirement.
 *
 * `between` degrades to `gte` when no upper bound arrived, rather than being
 * refused: a model that said "between 14 and …" and lost the second number has
 * still expressed a floor, and the floor is a strictly weaker requirement than
 * the range — so keeping it cannot exclude anything the range would have
 * admitted. Widening in the OTHER direction (inventing an upper bound) is what
 * this module never does.
 */
function numericPredicate(
  requirement: { readonly operator: 'eq' | 'gte' | 'lte' | 'between' | 'in' | 'is' },
  lower: { readonly type: 'measurement'; readonly magnitude: number; readonly unit: string }
    | { readonly type: 'integer' | 'decimal'; readonly value: number },
  upper?:
    | { readonly type: 'measurement'; readonly magnitude: number; readonly unit: string }
    | { readonly type: 'integer' | 'decimal'; readonly value: number },
): InterpretedRequirement['predicate'] {
  if (requirement.operator === 'between' && upper !== undefined) {
    return {
      op: 'between',
      lower: { value: lower, inclusive: true },
      upper: { value: upper, inclusive: true },
    };
  }
  if (requirement.operator === 'lte') return { op: 'lte', value: lower };
  if (requirement.operator === 'eq') return { op: 'eq', value: lower };
  return { op: 'gte', value: lower };
}

/**
 * The canonical enum value a model's text names, through the registry's own
 * aliases.
 *
 * The ALIAS map is #94's, recorded per definition, so `usb c` resolving to
 * `usb_c` is a fact somebody recorded rather than a normalisation this module
 * invented. A value that matches nothing is reported, never fuzzy-matched:
 * picking the nearest enum value is how "waterproof" becomes "water resistant",
 * which is a different product claim.
 */
function resolveEnumValue(
  definition: ResolvedAttributeDefinition,
  text: string,
): string | undefined {
  const folded = text.trim().toLowerCase();
  const exact = definition.enumValues.find(
    (value) => value.value.toLowerCase() === folded || value.label.toLowerCase() === folded,
  );
  if (exact !== undefined) return exact.value;
  return definition.aliases.get(folded);
}

/** One word for an operator, for the explanation line. */
function describeOperator(operator: 'eq' | 'gte' | 'lte' | 'between' | 'in' | 'is'): string {
  if (operator === 'gte') return 'at least';
  if (operator === 'lte') return 'at most';
  if (operator === 'between') return 'between';
  return 'about';
}
