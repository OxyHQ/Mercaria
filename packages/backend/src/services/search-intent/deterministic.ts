/**
 * The deterministic interpreter — the FLOOR, not a degraded mode (#95
 * "Deterministic fallback").
 *
 * This module reads a shopping query with no model of any kind: identifiers
 * through #70's normalizer, money through the locale reader, magnitudes against
 * #94's live registry and its unit conversion table, and condition, channel,
 * category and product-use through the bounded per-language dictionaries. What
 * it produces is a complete {@link InterpretationDraft} — the same structure a
 * model candidate is turned into, so everything downstream (constraint
 * building, validation, filter derivation, paraphrase, clarification) has ONE
 * input shape and cannot behave differently depending on which interpreter ran.
 *
 * That single-shape property is what makes "with no model configured at all the
 * surface still works through #70" a fact about the call graph rather than a
 * claim: `plan.service.ts` builds this draft FIRST, always, and a model can only
 * ever produce a second draft that is merged into it.
 *
 * ## Four rules that shape the readings
 *
 * 1. **A numeric bound is HARD; a bare word is a PREFERENCE.** "At least 16 GB"
 *    is an explicit threshold and excluding below it is what the shopper asked
 *    for. "Gaming laptop" is a leaning, and promoting it would exclude machines
 *    they would have bought — the direction #94's whole hard/preference
 *    apparatus exists to prevent. An explicit strength word overrides both.
 * 2. **A magnitude resolves to an attribute by NAME first, by unit family
 *    second, and refuses when the family fits several.** Picking one of three
 *    length attributes silently is a hard requirement Mercaria invented, which
 *    is exactly the "false hard constraint" the benchmark measures.
 * 3. **An unreadable number is reported, never guessed.** `1,299` in a language
 *    with no decimal convention on file, a unit outside the conversion table, a
 *    currency outside Mercaria's set — each becomes an
 *    {@link IntentUnresolvedPhrase} the shopper can see and correct.
 * 4. **The shopper's words are never rewritten.** `searchText` is the bounded
 *    query, with only the phrases that BECAME structured facts removed — so a
 *    condition word does not also search as a term, and everything else still
 *    reaches #70 as typed.
 */

import {
  MAX_UNRESOLVED_PHRASES,
  MAX_USE_TAGS,
  type AttributePredicate,
  type ConditionGroup,
  type ConstraintStrength,
  type CurrencyCode,
  type IntentBudget,
  type IntentClarificationKind,
  type IntentElementOrigin,
  type IntentUnresolvedPhrase,
  type OfferAvailability,
  type ShoppingUseTag,
} from '@mercaria/shared-types';
import { normalizeSearchQuery } from '../search/normalize.js';
import { resolveUnit, toBaseUnit, unitFamilyOf } from '../canonical/units.js';
import type { ResolvedAttributeDefinition } from '../attributes/definition-registry.service.js';
import { boundedPhrase } from './injection.js';
import {
  foldPhrase,
  readBudgetBound,
  readCategoryColloquialism,
  readChannelLeanings,
  readConditionGroups,
  readStatedStrength,
  readUseTags,
  readsAsDeliveredTotal,
} from './dictionaries.js';
import { languageOf, readCurrency, readLocalizedNumber, toMinorUnits } from './locale.js';

/** One requirement, already bound to a registry definition VERSION. */
export interface InterpretedRequirement {
  /** Stable within the draft — what an explanation, a chip and an edit cite. */
  readonly id: string;
  readonly attributeKey: string;
  readonly definitionVersion: number;
  readonly strength: ConstraintStrength;
  readonly predicate: AttributePredicate;
  readonly origin: IntentElementOrigin;
  /** The shopper's own words. Never rewritten. */
  readonly sourcePhrase: string;
  /** One line a shopper reads, composed here from the definition's LABEL. */
  readonly explanation: string;
}

/** A condition leaning, with the words that produced it. */
export interface InterpretedCondition {
  readonly groups: readonly ConditionGroup[];
  readonly origin: IntentElementOrigin;
  readonly sourcePhrase: string;
}

/** Everything an interpretation understood, before it becomes constraints. */
export interface InterpretationDraft {
  /** What #70 searches on: the query minus the phrases that became facts. */
  readonly searchText: string;
  /** A category SLUG, resolved against the real table by the caller. */
  readonly categorySlug?: { readonly slug: string; readonly sourcePhrase: string };
  readonly requirements: readonly InterpretedRequirement[];
  readonly budget?: IntentBudget;
  readonly condition?: InterpretedCondition;
  readonly availability?: readonly OfferAvailability[];
  readonly officialChannelOnly?: boolean;
  readonly nativeOnly?: boolean;
  readonly nearby?: boolean;
  readonly useTags: readonly ShoppingUseTag[];
  /** Brand and merchant WORDS. Resolved by the caller, or reported unresolved. */
  readonly entityMentions: readonly { readonly kind: 'brand' | 'merchant'; readonly text: string }[];
  readonly unresolved: readonly IntentUnresolvedPhrase[];
  /** Ambiguities that would materially change the answer, as clarification kinds. */
  readonly ambiguities: readonly IntentClarificationKind[];
  /**
   * The magnitudes whose unit fitted SEVERAL attributes, with the candidates.
   *
   * Carried on the draft rather than recomputed by the question composer,
   * because the composer would otherwise have to re-run the unit-family lookup
   * to know what to offer — a second derivation of the same fact, and the two
   * could disagree the moment the registry changed between them.
   */
  readonly attributeAmbiguities: readonly {
    readonly phrase: string;
    readonly candidates: readonly { readonly key: string; readonly label: string }[];
  }[];
  /** Identifiers the query read as, so a barcode search is visibly one. */
  readonly identifiers: readonly string[];
}

/** What the interpreter needs. No database handle — the caller loads the registry. */
export interface DeterministicInterpretInput {
  /** Already sanitized and bounded by `sanitizeQueryForModel`. */
  readonly query: string;
  readonly locale: string;
  /** The currency a bare amount is read in when the query names no symbol. */
  readonly currency?: CurrencyCode;
  /** The active definitions in scope — the category's, or every active one. */
  readonly definitions: readonly ResolvedAttributeDefinition[];
  /**
   * Attribute keys a shopper has already CHOSEN, answering an earlier
   * `attribute_disambiguation` question.
   *
   * Applied only where the interpreter would otherwise refuse — it narrows a
   * genuine ambiguity and can never override a magnitude the query itself
   * named. So an answer resolves the question it was asked and reaches nothing
   * else, which is clarification rule 4's "updates only the active search
   * session" at the level of one reading rather than one session.
   */
  readonly preferredAttributeKeys?: readonly string[];
}

/**
 * A magnitude with its unit, and the words around it that give it meaning.
 *
 * `prefix` is the up-to-thirty characters BEFORE the number, which is where a
 * bound word lives (`at least 16 GB`), and `suffix` is the up-to-thirty after,
 * which is where an attribute name lives (`16 GB of RAM`). Thirty characters is
 * about four words in every launch language and is what keeps a bound word from
 * one clause reaching a magnitude in the next.
 */
interface MagnitudeMatch {
  readonly numberText: string;
  readonly unitToken: string;
  readonly whole: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly index: number;
}

/**
 * Every `<number><unit>` in a query, in order.
 *
 * The unit is allowed to be attached (`16GB`) or separated by a single space
 * (`16 GB`), and nothing else — `16 great big GB` is not a magnitude, and a
 * looser rule would attach a number to the first unit-shaped word anywhere
 * after it. The number pattern admits both separators so
 * `readLocalizedNumber` gets the whole token and can refuse an ambiguous one.
 */
function findMagnitudes(query: string): MagnitudeMatch[] {
  const matches: MagnitudeMatch[] = [];
  const pattern = /(\d[\d.,]*)\s?([a-zA-Z"”′″]{1,12})\b/gu;
  for (const match of query.matchAll(pattern)) {
    const index = match.index ?? 0;
    matches.push({
      numberText: match[1] ?? '',
      unitToken: match[2] ?? '',
      whole: match[0],
      prefix: query.slice(Math.max(0, index - 30), index),
      suffix: query.slice(index + match[0].length, index + match[0].length + 30),
      index,
    });
  }
  return matches;
}

/** Amounts written with a currency symbol or code, anywhere in the query. */
interface MoneyMatch {
  readonly numberText: string;
  readonly whole: string;
  readonly prefix: string;
  readonly index: number;
}

/**
 * Every amount that is unambiguously MONEY, in order.
 *
 * "Unambiguously" means a currency symbol or an ISO code adjacent to the
 * number, on either side — `900 €`, `€900`, `900 EUR`, `EUR 900`. A bare number
 * is deliberately NOT money: `16` in "16 GB laptop" is a capacity, and reading
 * every bare number as a budget is how a search for a 14-inch laptop acquires a
 * fourteen-euro price ceiling.
 */
function findMoneyAmounts(query: string): MoneyMatch[] {
  const matches: MoneyMatch[] = [];
  const symbols = '€£₹⊜$¥';
  const pattern = new RegExp(
    `(?:([${symbols}]|\\b[A-Za-z]{3}\\b|\\bzł\\b|\\bR\\$)\\s?(\\d[\\d.,]*)|(\\d[\\d.,]*)\\s?([${symbols}]|\\b[A-Za-z]{3}\\b|\\bzł\\b|\\bkr\\b))`,
    'giu',
  );
  for (const match of query.matchAll(pattern)) {
    const index = match.index ?? 0;
    const numberText = match[2] ?? match[3] ?? '';
    if (numberText === '') continue;
    matches.push({
      numberText,
      whole: match[0],
      prefix: query.slice(Math.max(0, index - 30), index),
      index,
    });
  }
  return matches;
}

/**
 * Which definitions a unit could belong to, by unit FAMILY.
 *
 * Only `measurement` definitions with a declared family are candidates: a
 * `structured` attribute is constrained through one of its AXES and a query
 * that names no axis cannot say which, so those are deliberately not reachable
 * deterministically. A shopper meaning a depth writes "8 mm deep", which the
 * name pass below resolves.
 */
function definitionsForUnit(
  unit: string,
  definitions: readonly ResolvedAttributeDefinition[],
): ResolvedAttributeDefinition[] {
  const family = unitFamilyOf(unit);
  if (family === null) return [];
  return definitions.filter(
    (definition) =>
      definition.row.valueType === 'measurement' && definition.row.unitFamily === family,
  );
}

/**
 * The shortest word that may name an attribute on its own.
 *
 * FOUR. A shopper writes "14 inch screen", not "14 inch screen size", so a
 * single TOKEN of a definition's name has to count — and a shorter floor would
 * let `size`, `type` and `port` name three different attributes from any
 * sentence that happened to contain one of them.
 */
const MIN_ATTRIBUTE_NAME_TOKEN = 4;

/**
 * The definition a magnitude's surrounding words NAME, if any.
 *
 * Every label the definition carries is tried — the default one plus every
 * localized `attribute_labels` row — which is #95 localization rule 4 in one
 * line: an attribute is named through the REGISTRY's own translations, so
 * `memoria` finds `ram` because somebody recorded that label, and never because
 * a model produced a canonical key.
 *
 * A name matches WHOLE or by one of its tokens, and the NEAREST match wins with
 * length as the tie-break. Nearness rather than length is the load-bearing
 * half, and it was measured: `16 GB de memoria y almacenamiento de al menos 512
 * GB` puts both `memoria` and `almacenamiento` inside the first magnitude's
 * thirty-character window, and a longest-match rule reads `16 GB` as STORAGE —
 * so the query asks for 512 GB of storage twice and never mentions memory at
 * all. Distance is what tells one clause from the next when a comma does not.
 */
function definitionNamedNear(
  match: MagnitudeMatch,
  candidates: readonly ResolvedAttributeDefinition[],
): ResolvedAttributeDefinition | undefined {
  const prefix = foldPhrase(match.prefix);
  const suffix = foldPhrase(match.suffix);
  let best: ResolvedAttributeDefinition | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestLength = 0;
  for (const definition of candidates) {
    const names = [
      definition.row.key.replace(/_/gu, ' '),
      definition.row.label,
      ...definition.labels.map((label) => label.label),
    ];
    for (const name of names) {
      const folded = foldPhrase(name);
      if (folded.length === 0) continue;
      const spellings = [
        folded,
        ...folded.split(' ').filter((token) => token.length >= MIN_ATTRIBUTE_NAME_TOKEN),
      ];
      for (const spelling of spellings) {
        const distance = nearestDistance(prefix, suffix, spelling);
        if (distance === undefined) continue;
        if (distance < bestDistance || (distance === bestDistance && spelling.length > bestLength)) {
          best = definition;
          bestDistance = distance;
          bestLength = spelling.length;
        }
      }
    }
  }
  return best;
}

/**
 * How far a spelling sits from the magnitude, in characters, or `undefined`.
 *
 * The prefix is measured from its END (the words nearest the number are the
 * last ones) and the suffix from its START. A spelling appearing on both sides
 * takes the nearer.
 */
function nearestDistance(
  prefix: string,
  suffix: string,
  spelling: string,
): number | undefined {
  const inPrefix = prefix.lastIndexOf(spelling);
  const inSuffix = suffix.indexOf(spelling);
  const distances: number[] = [];
  if (inPrefix >= 0) distances.push(prefix.length - (inPrefix + spelling.length));
  if (inSuffix >= 0) distances.push(inSuffix);
  return distances.length === 0 ? undefined : Math.min(...distances);
}

/** Words that make a magnitude a lower bound, an upper bound, or an equality. */
const AT_LEAST_PHRASES: readonly string[] = [
  'at least',
  'minimum',
  'min',
  'more than',
  'over',
  'from',
  'al menos',
  'minimo',
  'mas de',
  'a partir de',
  'desde',
  'com a minim',
  'mindestens',
  'au moins',
  'almeno',
  'pelo menos',
];

const AT_MOST_PHRASES: readonly string[] = [
  'at most',
  'maximum',
  'max',
  'under',
  'below',
  'less than',
  'up to',
  'or smaller',
  'or less',
  'como maximo',
  'maximo',
  'menos de',
  'hasta',
  'o menos',
  'o mas pequeno',
  'com a maxim',
  'hochstens',
  'höchstens',
  'bis zu',
  'au plus',
  'moins de',
  'al massimo',
  'no maximo',
];

/** Which comparison a magnitude's surrounding words express. */
function boundFor(match: MagnitudeMatch): 'gte' | 'lte' | 'eq' {
  const prefix = foldPhrase(match.prefix);
  const suffix = foldPhrase(match.suffix);
  const atLeast = AT_LEAST_PHRASES.some(
    (phrase) => prefix.endsWith(phrase) || prefix.includes(`${phrase} `),
  );
  const atMost =
    AT_MOST_PHRASES.some((phrase) => prefix.endsWith(phrase) || prefix.includes(`${phrase} `)) ||
    AT_MOST_PHRASES.some((phrase) => suffix.startsWith(phrase) || suffix.startsWith(` ${phrase}`));
  if (atLeast && !atMost) return 'gte';
  if (atMost && !atLeast) return 'lte';
  return 'eq';
}

/**
 * Read one query, deterministically.
 *
 * Nothing here is asynchronous and nothing reads a database: the registry
 * definitions arrive already resolved, so the whole interpretation is a pure
 * function of a string, a locale and a snapshot of the registry — which is what
 * makes the benchmark reproducible and what lets the injection fixtures be
 * exercised without a server.
 */
export function interpretDeterministically(
  input: DeterministicInterpretInput,
): InterpretationDraft {
  const query = input.query;
  const folded = foldPhrase(query);
  const language = languageOf(input.locale);
  const unresolved: IntentUnresolvedPhrase[] = [];
  const ambiguities: IntentClarificationKind[] = [];
  const attributeAmbiguities: {
    phrase: string;
    candidates: { key: string; label: string }[];
  }[] = [];
  const preferred = new Set(input.preferredAttributeKeys ?? []);
  const consumed: string[] = [];
  let sequence = 0;
  const nextId = (prefix: string): string => {
    sequence += 1;
    return `${prefix}-${sequence}`;
  };

  const normalized = normalizeSearchQuery(query);
  const identifiers = normalized.identifiers.map(
    (identifier) => `${identifier.scheme}:${identifier.normalizedValue}`,
  );

  // ── Money, before magnitudes: `900 €` must not be read as a magnitude whose
  // unit is a currency code, and the money pass consumes the phrase so the
  // magnitude pass never sees it. ──────────────────────────────────────────
  let budget: IntentBudget | undefined;
  const deliveredPhrase = readsAsDeliveredTotal(folded);
  for (const money of findMoneyAmounts(query)) {
    const amount = readLocalizedNumber(money.numberText, input.locale);
    if (amount.status === 'unreadable') {
      unresolved.push({
        kind: 'ambiguous_phrase',
        phrase: boundedPhrase(money.whole),
        explanation: `We could not tell whether "${boundedPhrase(money.numberText)}" is a decimal or a thousands separator in ${language || 'this language'}, so we did not use it as a budget.`,
      });
      continue;
    }
    const read = readCurrency(money.whole);
    let currency: CurrencyCode | undefined;
    if (read.status === 'read') currency = read.currency;
    else if (input.currency !== undefined) currency = input.currency;
    if (currency === undefined) {
      unresolved.push({
        kind: 'unknown_currency',
        phrase: boundedPhrase(money.whole),
        explanation:
          read.status === 'ambiguous'
            ? `"${boundedPhrase(read.token)}" names more than one currency we support, so we did not guess which one you meant.`
            : `We could not tell which currency "${boundedPhrase(money.whole)}" is in.`,
      });
      continue;
    }
    const minor = toMinorUnits(amount.value, currency);
    if (minor === undefined) {
      unresolved.push({
        kind: 'ambiguous_phrase',
        phrase: boundedPhrase(money.whole),
        explanation: 'That amount is larger than we can price against.',
      });
      continue;
    }
    const phrasing = readBudgetBound(foldPhrase(money.prefix));
    // Only ONE budget: a query naming two amounts without an explicit range is
    // two different questions, and picking one is the guess this whole module
    // refuses to make. The second is reported.
    if (budget !== undefined) {
      unresolved.push({
        kind: 'ambiguous_phrase',
        phrase: boundedPhrase(money.whole),
        explanation: 'We used the first budget in your search and ignored this second amount.',
      });
      continue;
    }
    budget = {
      basis: deliveredPhrase === undefined ? 'item_price' : 'known_total',
      currency,
      ...(phrasing?.bound === 'min' ? { minMinor: minor } : { maxMinor: minor }),
      origin: 'deterministic_rule',
      sourcePhrase: boundedPhrase(money.whole),
    };
    consumed.push(money.whole);
    // Clarification rule 1: ask only where the ambiguity MATERIALLY changes a
    // hard constraint. "Under 900" versus "under 900 delivered" changes which
    // products qualify on every multi-seller product, so it qualifies; the
    // default is stated in the paraphrase either way.
    if (deliveredPhrase === undefined) ambiguities.push('budget_basis');
  }

  // ── Magnitudes against #94's registry ───────────────────────────────────
  const requirements: InterpretedRequirement[] = [];
  const statedStrength = readStatedStrength(folded);
  for (const magnitude of findMagnitudes(query)) {
    if (consumed.some((phrase) => phrase.includes(magnitude.whole))) continue;
    const unit = resolveUnit(magnitude.unitToken);
    if (unit === null) {
      // A bare word after a number is usually a noun, not a unit — `16 laptops`
      // is not a requirement and reporting it would fill the unresolved list
      // with noise a shopper cannot act on. What tells the two apart is the
      // BOUND WORD: somebody who wrote "at least 16 zorks" expressed a
      // comparison, so they meant a measurable quantity and Mercaria owes them
      // the news that it does not know the unit. Somebody who wrote "16 zorks"
      // may simply have been describing what they want, and their words still
      // reach #70 as search text.
      if (boundFor(magnitude) !== 'eq') {
        unresolved.push({
          kind: 'unknown_unit',
          phrase: boundedPhrase(magnitude.whole),
          explanation: `We do not recognise "${boundedPhrase(magnitude.unitToken)}" as a unit, so we did not turn it into a requirement.`,
        });
      }
      continue;
    }
    const amount = readLocalizedNumber(magnitude.numberText, input.locale);
    if (amount.status === 'unreadable') {
      unresolved.push({
        kind: 'ambiguous_phrase',
        phrase: boundedPhrase(magnitude.whole),
        explanation: `We could not read "${boundedPhrase(magnitude.numberText)}" as a number in ${language || 'this language'}.`,
      });
      continue;
    }

    const candidates = definitionsForUnit(unit, input.definitions);
    if (candidates.length === 0) {
      unresolved.push({
        kind: 'unknown_attribute',
        phrase: boundedPhrase(magnitude.whole),
        explanation: `Nothing in this category is measured in ${boundedPhrase(unit)}, so we could not turn "${boundedPhrase(magnitude.whole)}" into a requirement.`,
      });
      continue;
    }
    const named = definitionNamedNear(magnitude, candidates);
    let definition = named;
    if (definition === undefined) {
      if (candidates.length > 1) {
        // A shopper who already ANSWERED this question has chosen; the choice
        // resolves the ambiguity and nothing else.
        const chosen = candidates.find((candidate) => preferred.has(candidate.row.key));
        if (chosen === undefined) {
          // Rule 2: several attributes share the unit family and the query named
          // none of them. Choosing would be a hard requirement Mercaria invented.
          ambiguities.push('attribute_disambiguation');
          attributeAmbiguities.push({
            phrase: boundedPhrase(magnitude.whole),
            candidates: candidates
              .slice(0, 3)
              .map((candidate) => ({ key: candidate.row.key, label: candidate.row.label })),
          });
          unresolved.push({
            kind: 'ambiguous_phrase',
            phrase: boundedPhrase(magnitude.whole),
            explanation: `"${boundedPhrase(magnitude.whole)}" could describe ${candidates
              .slice(0, 3)
              .map((candidate) => candidate.row.label)
              .join(', ')}, so we did not pick one.`,
          });
          continue;
        }
        definition = chosen;
      } else {
        definition = candidates[0];
      }
    }
    if (definition === undefined) continue;

    const baseMagnitude = toBaseUnit(amount.value, unit);
    if (baseMagnitude === null) {
      unresolved.push({
        kind: 'unknown_unit',
        phrase: boundedPhrase(magnitude.whole),
        explanation: `We could not convert ${boundedPhrase(magnitude.whole)} into the unit this attribute is compared in.`,
      });
      continue;
    }

    const operator = boundFor(magnitude);
    // Rule 1: a numeric BOUND is hard on its own; an equality is only hard when
    // the shopper said so. `16 GB` in a title is often descriptive, and
    // excluding every 32 GB machine from "16GB gaming laptop" is a false hard
    // constraint — the thing the benchmark measures directly.
    const strength: ConstraintStrength =
      statedStrength ?? (operator === 'eq' ? 'preference' : 'hard');
    if (strength === 'hard' && !definition.row.hardConstraintCapable) {
      unresolved.push({
        kind: 'unsupported_by_retrieval',
        phrase: boundedPhrase(magnitude.whole),
        explanation: `${definition.row.label} is not recorded reliably enough to exclude products on, so we treated it as a preference.`,
      });
    }
    const usable: ConstraintStrength =
      strength === 'hard' && !definition.row.hardConstraintCapable ? 'preference' : strength;
    requirements.push({
      id: nextId('req'),
      attributeKey: definition.row.key,
      definitionVersion: definition.row.version,
      strength: usable,
      predicate: {
        op: operator,
        value: { type: 'measurement', magnitude: amount.value, unit },
      },
      origin: 'deterministic_rule',
      sourcePhrase: boundedPhrase(magnitude.whole),
      explanation: describeBound(definition.row.label, operator, magnitude.whole),
    });
    consumed.push(magnitude.whole);
  }

  // ── Enum and boolean attributes named outright (`usb-c`, `waterproof`) ────
  for (const definition of input.definitions) {
    if (definition.row.valueType === 'enum') {
      for (const enumValue of definition.enumValues) {
        const label = foldPhrase(enumValue.label);
        const value = foldPhrase(enumValue.value);
        const matched = [label, value].find(
          (candidate) => candidate.length >= 3 && folded.includes(candidate),
        );
        if (matched === undefined) continue;
        requirements.push({
          id: nextId('req'),
          attributeKey: definition.row.key,
          definitionVersion: definition.row.version,
          strength: statedStrength ?? 'preference',
          predicate: { op: 'eq', value: { type: 'string', value: enumValue.value } },
          origin: 'deterministic_rule',
          sourcePhrase: boundedPhrase(matched),
          explanation: `${definition.row.label} is ${enumValue.label}`,
        });
        consumed.push(matched);
        break;
      }
    }
  }

  // ── Condition, channel, use tags, category ──────────────────────────────
  const conditionMatches = readConditionGroups(folded);
  const condition: InterpretedCondition | undefined =
    conditionMatches.length === 0
      ? undefined
      : {
          groups: conditionMatches.map((match) => match.value),
          origin: 'deterministic_rule',
          sourcePhrase: boundedPhrase(conditionMatches.map((match) => match.phrase).join(', ')),
        };
  for (const match of conditionMatches) consumed.push(match.phrase);

  const channel = readChannelLeanings(folded);
  if (channel.officialChannelOnly !== undefined) consumed.push(channel.officialChannelOnly.phrase);
  if (channel.nativeOnly !== undefined) consumed.push(channel.nativeOnly.phrase);
  if (channel.nearby !== undefined) {
    consumed.push(channel.nearby.phrase);
    // #93 supplies no pickup publication or collectable-inventory state, so
    // #70's request contract has no proximity parameter at all. Reported, and
    // deliberately not accepted-and-ignored, which would read as a filter.
    unresolved.push({
      kind: 'unsupported_by_retrieval',
      phrase: boundedPhrase(channel.nearby.phrase),
      explanation:
        'We understood that you want something nearby, and search cannot filter by distance yet, so this did not narrow your results.',
    });
  }
  if (channel.availability !== undefined) consumed.push(channel.availability.phrase);

  const useTagMatches = readUseTags(folded).slice(0, MAX_USE_TAGS);
  const colloquial = readCategoryColloquialism(folded);

  return {
    searchText: composeSearchText(query, consumed),
    ...(colloquial === undefined
      ? {}
      : { categorySlug: { slug: colloquial.value, sourcePhrase: boundedPhrase(colloquial.phrase) } }),
    requirements,
    ...(budget === undefined ? {} : { budget }),
    ...(condition === undefined ? {} : { condition }),
    ...(channel.availability === undefined
      ? {}
      : { availability: [channel.availability.value] as readonly OfferAvailability[] }),
    ...(channel.officialChannelOnly === undefined ? {} : { officialChannelOnly: true }),
    ...(channel.nativeOnly === undefined ? {} : { nativeOnly: true }),
    ...(channel.nearby === undefined ? {} : { nearby: true }),
    useTags: useTagMatches.map((match) => match.value),
    // A deterministic pass claims NO entity mentions: resolving `apple` as a
    // brand rather than as a fruit needs the catalogue, and #70's own merchant
    // and brand stages already answer a query naming one. Guessing here would
    // add a hard merchant filter nobody asked for.
    entityMentions: [],
    unresolved: unresolved.slice(0, MAX_UNRESOLVED_PHRASES),
    ambiguities,
    attributeAmbiguities,
    identifiers,
  };
}

/**
 * The query with the phrases that BECAME structured facts removed.
 *
 * Removed rather than kept, because a condition word left in the search text is
 * matched lexically against product names — and "used" appears in plenty of
 * them, so a query for a used phone would rank "used-look case" above the
 * phones. Everything the interpreter did NOT understand stays exactly as the
 * shopper typed it, which is rule 4 and is what makes the fallback a real
 * search rather than a stripped one.
 */
function composeSearchText(query: string, consumed: readonly string[]): string {
  let text = query;
  for (const phrase of consumed) {
    if (phrase.length === 0) continue;
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    text = text.replace(new RegExp(escaped, 'giu'), ' ');
  }
  const cleaned = text.replace(/\s+/gu, ' ').trim();
  // A query that was ENTIRELY structured facts still has to search for
  // something: "under 900 € used" means "anything, used, under 900" and the
  // empty string would return nothing at all rather than everything.
  return cleaned.length === 0 ? '' : cleaned;
}

/** One line describing a bound, composed from the definition's own label. */
function describeBound(label: string, operator: 'gte' | 'lte' | 'eq', phrase: string): string {
  if (operator === 'gte') return `${label} of at least ${phrase}`;
  if (operator === 'lte') return `${label} of at most ${phrase}`;
  return `${label} around ${phrase}`;
}
