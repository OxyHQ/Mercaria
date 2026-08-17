/**
 * Turning a legacy free-text option into a typed axis — or refusing to, by name
 * (#367 step 4, ADR 0007 D6).
 *
 * This is the module the epic warns about. `listing_options.name` and
 * `product_variant_option_values.name` / `.value` are display text, so two
 * stores selling one shoe produce `Color`, `Colour`, `color ` and `Tono`, and
 * the tempting fix is a similarity score. ADR 0007 D6 names the outcome of that
 * fix precisely: "Inventing a normalization for `Tono` because it looks like
 * `Color` is exactly the false merge #58 is shaped around."
 *
 * So every function here is PURE, deterministic, and refuses rather than
 * guesses. There is no similarity metric, no stemming, no translation, no
 * singularisation and no "closest match" anywhere in it, and
 * `variant-axis-isolation.test.ts` fails the build if one appears.
 *
 * ## The two halves resolve independently, and only one of them may infer
 *
 * - **The NAME resolves by EXACT KEY and by nothing else.** ADR 0007 D1 makes a
 *   key identity and a label presentation, so matching a legacy option name
 *   against `attribute_labels` would be a name match — the basis D1 forbids and
 *   #55's `verification_method` has no member for. What {@link legacyOptionNameToKey}
 *   does is a mechanical KEY-SHAPE fold (case, whitespace and hyphens), stated
 *   exhaustively below, and a name that does not land on a real key is
 *   `unmapped`. `Tono` therefore stays text, and so does `Colour`.
 * - **The VALUE resolves through `attribute_value_aliases`**, which is a human
 *   statement that this spelling means that controlled value — evidence, not a
 *   resemblance. It resolves only WITHIN the definition the name already
 *   settled, so the value can never decide which attribute the option was.
 *   That ordering is the whole safety property: reversing it is what turns
 *   `Marco: Negro` (a black FRAME) into a colour.
 *
 * ## Where each refusal is reachable from, stated rather than implied
 *
 * A closed refusal vocabulary is only worth having if a reader can tell which
 * members the backfill can actually produce. From
 * {@link resolveLegacyOptionName}: `unmapped` (no such key), `forbidden_as_axis`
 * (a price, a stock level, a vehicle fitment), `not_variant_defining` (the
 * registry says this attribute does not define variants) and `ambiguous` (two
 * option names on ONE listing folding to one key — `Shoe Size` and `Shoe-Size`,
 * which the caller detects and passes in). `operator_refused` is reachable only
 * from a person, and `variant-axis-legacy-resolution.test.ts` says so rather
 * than leaving a member nothing produces looking like coverage.
 */

import {
  PRODUCT_TYPE_ATTRIBUTE_KEY_PATTERN,
  PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS,
  type VariantAxisAttributeRefusal,
  type VariantAxisValueRefusal,
} from '@mercaria/shared-types';
import type { ResolvedAttributeDefinition } from '../attributes/definition-registry.service.js';
import { normalizeAttributeObservation } from '../attributes/normalization.service.js';
import { normalizeAxisValue } from './signature.js';

/**
 * The complete list of transformations {@link legacyOptionNameToKey} performs.
 *
 * Exhaustive on purpose, and asserted against the function by a test: a reader
 * deciding whether this module guesses needs the list to be checkable, and a
 * sixth transformation added later has to be argued for here first.
 */
export const LEGACY_OPTION_NAME_FOLDS: readonly string[] = [
  'trim leading and trailing whitespace',
  'lowercase',
  'collapse internal whitespace runs to a single underscore',
  'convert hyphens to underscores',
  'collapse repeated underscores to one',
];

/**
 * Transformations this module may never perform, stated as VALUES and asserted
 * DISJOINT from {@link LEGACY_OPTION_NAME_FOLDS} by a test.
 *
 * The negative list beside the positive one is what fails the build when
 * somebody adds a plausible-looking step later — the
 * `FEED_FORBIDDEN_TRANSFORM_KINDS` device. Every one of them turns "I do not
 * know what this option is" into a confident wrong answer, and every one of them
 * looks like diligence in a diff.
 */
export const LEGACY_OPTION_FORBIDDEN_FOLDS: readonly string[] = [
  'edit_distance',
  'fuzzy_match',
  'trigram_similarity',
  'phonetic_match',
  'stemming',
  'singularisation',
  'translation',
  'synonym_expansion',
  'label_match',
  'prefix_match',
];

/**
 * Fold a legacy option NAME into the key space, or answer `null`.
 *
 * `Shoe Size` becomes `shoe_size`, `Colour` becomes `colour` (which is not a key
 * anybody defined and therefore resolves to nothing), and `Talla / Tamaño`
 * becomes `null` because the result carries characters no key may contain. The
 * function performs exactly {@link LEGACY_OPTION_NAME_FOLDS} and nothing else —
 * it is a spelling convention, not a lookup, and it can never produce a key that
 * was not already in the merchant's own text.
 */
export function legacyOptionNameToKey(rawName: string): string | null {
  const folded = rawName
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, '_')
    .replace(/_+/gu, '_');
  if (folded.length === 0) return null;
  return PRODUCT_TYPE_ATTRIBUTE_KEY_PATTERN.test(folded) ? folded : null;
}

/**
 * What the caller has to establish before the name can be settled.
 *
 * `definition` is the ACTIVE registry version whose key equals the folded name,
 * looked up by the caller through `resolveActiveDefinition` — this module opens
 * no database. `collidesWithSiblingOption` is the one ambiguity the backfill can
 * genuinely produce: two of ONE listing's option names folding to one key, which
 * must not be resolved by taking whichever row came first.
 *
 * **And `collidesWithSiblingOption` is the ONLY thing that stops that coin
 * toss.** An earlier version of this comment said
 * `native_listing_variant_axes_listing_attribute_key` "would refuse" the
 * collision. It does not: `insertListingVariantAxis` writes
 * `.onConflictDoNothing({ target: [listingId, attributeKey] })` on exactly that
 * pair, so the second of two colliding names is absorbed as "already declared"
 * and returns `{ created: false }` — which is precisely "whichever came first",
 * arrived at silently and with no error anywhere. The unique index makes the
 * duplicate ROW impossible; it does nothing about the AMBIGUITY, and only a
 * caller that computes this flag before writing does.
 */
export interface LegacyOptionNameInput {
  readonly rawName: string;
  readonly definition: ResolvedAttributeDefinition | null;
  readonly collidesWithSiblingOption: boolean;
}

/** The name half's verdict. A STRING discriminant, and no definition on refusal. */
export type LegacyOptionNameResolution =
  | {
      readonly outcome: 'resolved';
      readonly attributeDefinitionId: string;
      readonly attributeKey: string;
      readonly attributeDefinitionVersion: number;
    }
  | { readonly outcome: 'refused'; readonly refusal: VariantAxisAttributeRefusal };

/**
 * Which attribute does this legacy option name mean?
 *
 * The order of the four refusals is load-bearing. `forbidden_as_axis` is
 * answered from the FOLDED KEY before the registry is consulted at all, so an
 * option literally named `Price` or `Vehicle Make` is refused whether or not
 * anybody ever defined it — real catalogues contain both, and the answer for
 * them is no rather than "not yet". The collision check comes next because an
 * ambiguous name has no single definition to ask anything else about.
 */
export function resolveLegacyOptionName(
  input: LegacyOptionNameInput,
): LegacyOptionNameResolution {
  const key = legacyOptionNameToKey(input.rawName);
  if (key === null) return { outcome: 'refused', refusal: 'unmapped' };

  if (PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS.includes(key)) {
    return { outcome: 'refused', refusal: 'forbidden_as_axis' };
  }
  if (input.collidesWithSiblingOption) {
    return { outcome: 'refused', refusal: 'ambiguous' };
  }
  if (input.definition === null) return { outcome: 'refused', refusal: 'unmapped' };

  const row = input.definition.row;
  // The registry's own answer to "may this attribute define variants at all".
  // `mercaria_native_variant_axis_citation` refuses the row for the same reason;
  // this is the earlier failure that can say which attribute and why.
  if (!row.variantDefining) {
    return { outcome: 'refused', refusal: 'not_variant_defining' };
  }
  // A definition the caller looked up by a DIFFERENT key would type the axis as
  // something the merchant did not write. Cheap to check, and the alternative is
  // a silent mis-typing that no constraint can see.
  if (row.key !== key) return { outcome: 'refused', refusal: 'unmapped' };

  return {
    outcome: 'resolved',
    attributeDefinitionId: row.id,
    attributeKey: row.key,
    attributeDefinitionVersion: row.version,
  };
}

/** The value half's verdict. Only the resolved branch carries a typed value. */
export type LegacyOptionValueResolution =
  | {
      readonly outcome: 'resolved';
      readonly normalizedValue: string;
      readonly enumValueId: string | null;
      readonly normalizedNumber: number | null;
      readonly normalizedUnit: string | null;
    }
  | { readonly outcome: 'refused'; readonly refusal: VariantAxisValueRefusal };

/**
 * Which value of that attribute does this legacy option value mean?
 *
 * Two paths, and neither infers:
 *
 * - An attribute WITH controlled values resolves through the registry's own
 *   alias map, which already folds `attribute_enum_values.value` and
 *   `attribute_value_aliases` into ONE lookup (a canonical value is its own
 *   alias there). Matching nothing is `unmapped`, which recording an alias would
 *   fix. Note what this does NOT do: it does not re-decide a canonical value
 *   against an alias that points elsewhere. #94's hydration already resolves
 *   that in the canonical's favour, and a second opinion here would be a second
 *   authority over the registry's own — so `ambiguous` is NOT reachable from the
 *   controlled-value path, and the case below is where it comes from instead.
 * - An attribute WITHOUT controlled values goes through #94's own
 *   `normalizeAttributeObservation`, so a `256 GB` storage axis lands as a
 *   base-unit magnitude that a `0.25 TB` sibling collides with. A value that
 *   module refuses is refused here too — it returns a first-class refusal rather
 *   than a coerced number, which is exactly the property this domain needs.
 *
 * `not_controlled` is deliberately NOT one of the outcomes of the second path.
 * It is reserved for an attribute whose type admits no normalization at all, so
 * that "record an alias" is never suggested where no alias could exist.
 */
export function resolveLegacyOptionValue(input: {
  readonly rawValue: string;
  readonly definition: ResolvedAttributeDefinition;
}): LegacyOptionValueResolution {
  const folded = normalizeAxisValue(input.rawValue);
  if (folded.length === 0) return { outcome: 'refused', refusal: 'unmapped' };

  const { definition } = input;
  if (definition.enumValues.length > 0) {
    // ONE lookup, and it is the registry's own.
    //
    // `ResolvedAttributeDefinition.aliases` maps a normalized alias to the
    // canonical VALUE STRING — not to an enum-value id — and #94's hydration
    // additionally makes every canonical value its own alias, precisely "so the
    // resolver has ONE lookup rather than a lookup plus a fallback that could
    // disagree with it". So a direct scan of `enumValues` beside this map would
    // be exactly the second lookup that comment exists to prevent.
    //
    // Getting this wrong is not loud: an earlier revision read the map's value
    // as an id, which refused `Negro` as `unmapped` and — because the canonical
    // self-alias made a direct hit and an alias hit "disagree" — refused `Blue`
    // as `ambiguous`. Both refusals looked entirely plausible in the report, and
    // the unit test did not catch it because it built the alias map by hand
    // from ids: a test that re-implements the code under test measures the
    // re-implementation. It was found by running the script against a real
    // registry.
    const canonicalValue = definition.aliases.get(folded);
    if (canonicalValue === undefined) return { outcome: 'refused', refusal: 'unmapped' };
    const canonical = definition.enumValues.find((value) => value.value === canonicalValue);
    // An alias resolving to a value that is not in this definition's set is a
    // registry inconsistency, not a resolution. Refusing keeps the text.
    if (canonical === undefined) return { outcome: 'refused', refusal: 'unmapped' };
    return {
      outcome: 'resolved',
      normalizedValue: canonical.value,
      enumValueId: canonical.id,
      normalizedNumber: null,
      normalizedUnit: null,
    };
  }

  // No controlled values. `string` and `enum` attributes with an empty value set
  // have nothing an alias could point at, so say so rather than sending somebody
  // to write one.
  if (definition.row.valueType === 'enum' || definition.row.valueType === 'string') {
    return { outcome: 'refused', refusal: 'not_controlled' };
  }

  const facts = normalizeAttributeObservation({ displayValue: input.rawValue, definition });
  // A legacy option value is ONE value on ONE axis. A definition whose
  // cardinality splits it into several facts is describing something a variant
  // axis cannot be, and picking the first would invent a variant the seller did
  // not list.
  if (facts.length !== 1) return { outcome: 'refused', refusal: 'ambiguous' };
  const fact = facts[0];
  if (fact === undefined || fact.normalizationState !== 'normalized') {
    return { outcome: 'refused', refusal: 'unmapped' };
  }

  // The signature input, chosen so two spellings of one quantity collide. A
  // magnitude is rendered ONCE, in its base unit; anything else falls back to the
  // folded text #94 already produced.
  const normalizedValue =
    fact.normalizedNumber === undefined
      ? normalizeAxisValue(fact.normalizedText ?? input.rawValue)
      : normalizeAxisValue(
          fact.normalizedUnit === undefined
            ? String(fact.normalizedNumber)
            : `${fact.normalizedNumber} ${fact.normalizedUnit}`,
        );
  if (normalizedValue.length === 0) return { outcome: 'refused', refusal: 'unmapped' };

  return {
    outcome: 'resolved',
    normalizedValue,
    enumValueId: null,
    normalizedNumber: fact.normalizedNumber ?? null,
    normalizedUnit: fact.normalizedUnit ?? null,
  };
}

/** Both halves of one legacy `(name, value)` pair, settled together. */
export interface LegacyOptionResolution {
  readonly name: LegacyOptionNameResolution;
  /**
   * `null` when there was no value to settle (a `listing_options` row declares
   * an axis and asserts no value). Distinct from a refusal: nobody asked.
   */
  readonly value: LegacyOptionValueResolution | null;
}

/**
 * Settle one legacy `(name, value)` pair.
 *
 * The dependency is one-directional and it is the safety property: the value is
 * only looked at once the NAME resolved, so a recorded alias can never decide
 * which attribute an option was. A value beside an unresolved name is refused
 * `attribute_unresolved`, which names the actual blocker rather than reporting
 * the value as unmappable.
 */
export function resolveLegacyOption(input: {
  readonly rawName: string;
  readonly rawValue: string | null;
  readonly definition: ResolvedAttributeDefinition | null;
  readonly collidesWithSiblingOption: boolean;
}): LegacyOptionResolution {
  const name = resolveLegacyOptionName({
    rawName: input.rawName,
    definition: input.definition,
    collidesWithSiblingOption: input.collidesWithSiblingOption,
  });
  if (input.rawValue === null) return { name, value: null };
  if (name.outcome === 'refused' || input.definition === null) {
    return { name, value: { outcome: 'refused', refusal: 'attribute_unresolved' } };
  }
  return {
    name,
    value: resolveLegacyOptionValue({ rawValue: input.rawValue, definition: input.definition }),
  };
}
