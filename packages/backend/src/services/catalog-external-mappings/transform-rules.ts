/**
 * The transformation rules Mercaria SHIPS, keyed by name and version
 * (#367 Workstream 11).
 *
 * A mapping row cites a rule; it does not carry one. That is the difference this
 * module exists to make structural, and the reason is #63's, verbatim: **a
 * source-supplied pattern is a small language and a DoS primitive.** So the
 * registry below is a `Map` built at module load from literal function
 * references, and:
 *
 * - **No rule takes a parameter a row could supply.** The signature is
 *   `(value: string) => CatalogExternalTransformOutcome`. There is nowhere to
 *   pass a pattern, a template, a delimiter or a lookup table, so the ten shapes
 *   in `CATALOG_EXTERNAL_FORBIDDEN_TRANSFORMS` are unrepresentable rather than
 *   refused.
 * - **Every regular expression here is a literal in this file.** A `new RegExp`
 *   built from anything is what `external-mapping-isolation.test.ts` scans for,
 *   because that is the one line that would turn a data column into an
 *   executable one.
 * - **A rule REFUSES rather than guessing.** Six refusal reasons, all of which
 *   block. A transformation that quietly did nothing is how a magnitude in grams
 *   gets stored as kilograms, so an unregistered `(key, version)` pair is
 *   `rule_not_registered` and never silently `identity`.
 *
 * ## Versions
 *
 * `(key, version)` is the identity. A rule's behaviour is FROZEN once shipped: a
 * change is a new version, and mappings cite the version they were reviewed
 * under, so re-normalizing under a newer rule is a deliberate reprocessing run
 * rather than something that happens to a deployment on a Tuesday.
 * {@link CATALOG_EXTERNAL_TRANSFORM_RULE_VERSIONS} is the census a test reads so
 * a key cannot be added without a version behind it. Every rule is at version 1
 * except `strip_diacritics`, which is at 2 — #838, and the reasoning is on the
 * census constant.
 *
 * Two rules read another module, and both read a pure code registry with no
 * database and no row-supplied input: `unit_magnitude_to_base` reads the
 * canonical unit table (`services/canonical/units.ts`), and `strip_diacritics`
 * reads `foldAccents` from `@mercaria/shared-types`, which is the repository's
 * one accent fold.
 */

import {
  CATALOG_EXTERNAL_TOKEN_MAX_LENGTH,
  CATALOG_EXTERNAL_TRANSFORM_RULES,
  foldAccents,
  type CatalogExternalTransformOutcome,
  type CatalogExternalTransformRule,
} from '@mercaria/shared-types';
import { resolveUnit, toBaseUnit, unitFamilyOf } from '../canonical/units.js';

/** A shipped rule. Pure, total, and with no parameter a row could supply. */
type TransformRuleFn = (value: string) => CatalogExternalTransformOutcome;

/** The literal regular expressions. Every one of them is in this file, by design. */
const WHITESPACE_RUN = /\s+/g;
const PATH_SEPARATOR = /\s*(?:>|\/|»|›|\|)\s*/;
const MAGNITUDE_AND_UNIT = /^([+-]?\d+(?:[.,]\d+)?)\s*([A-Za-z][A-Za-z0-9_/%]*)$/;
/**
 * A number written with grouping separators.
 *
 * The two non-ASCII spaces are written as ESCAPES rather than as literals: a
 * U+00A0 or U+202F typed into a regex is invisible in a diff, is what several
 * European feeds use as a thousands separator, and is exactly the character a
 * later editor deletes without noticing.
 */
const GROUPED_NUMBER = /^[+-]?[\d.,\u00A0\u202F ]+$/;

function normalized(value: string): CatalogExternalTransformOutcome {
  if (value === '') return { outcome: 'refused', reason: 'empty_result' };
  if (value.length > CATALOG_EXTERNAL_TOKEN_MAX_LENGTH) {
    return { outcome: 'refused', reason: 'too_long' };
  }
  return { outcome: 'normalized', value };
}

/**
 * Read a number written with either decimal convention.
 *
 * The rule REFUSES the genuinely ambiguous shapes rather than picking one — #95
 * reached the same place for `1,299`, and for the same reason: a wrong guess
 * here is off by three orders of magnitude and looks entirely plausible in the
 * output. Both separators present resolves (the LAST one is the decimal point);
 * one separator with exactly three trailing digits is a thousands group and is
 * refused as ambiguous, because `1,234` is both a thousand and a fraction.
 */
function normalizeDecimal(raw: string): CatalogExternalTransformOutcome {
  const trimmed = raw.trim().replace(/[\u00A0\u202F ]/g, '');
  if (trimmed === '') return { outcome: 'refused', reason: 'empty_result' };
  if (!GROUPED_NUMBER.test(trimmed)) return { outcome: 'refused', reason: 'unparsed' };

  const lastComma = trimmed.lastIndexOf(',');
  const lastDot = trimmed.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: the rightmost is the decimal separator and the other groups.
    const decimalAt = Math.max(lastComma, lastDot);
    const groupChar = decimalAt === lastComma ? '.' : ',';
    const cleaned = `${trimmed.slice(0, decimalAt).split(groupChar).join('')}.${trimmed.slice(decimalAt + 1)}`;
    return Number.isFinite(Number(cleaned))
      ? normalized(cleaned)
      : { outcome: 'refused', reason: 'unparsed' };
  }

  const separatorAt = Math.max(lastComma, lastDot);
  if (separatorAt < 0) {
    return Number.isFinite(Number(trimmed))
      ? normalized(trimmed)
      : { outcome: 'refused', reason: 'unparsed' };
  }

  const tail = trimmed.slice(separatorAt + 1);
  if (tail.length === 3 && !trimmed.slice(0, separatorAt).includes(trimmed[separatorAt] ?? '')) {
    // Exactly three trailing digits and one separator: `1,234` is a thousand in
    // one convention and 1.234 in the other, and nothing in the token says which.
    return { outcome: 'refused', reason: 'ambiguous_number' };
  }

  const cleaned = `${trimmed.slice(0, separatorAt)}.${tail}`;
  return Number.isFinite(Number(cleaned))
    ? normalized(cleaned)
    : { outcome: 'refused', reason: 'unparsed' };
}

/**
 * `155 mm` → `155`, expressed in the family's base unit.
 *
 * The unit comes from the source's OWN token and nowhere else — never from the
 * attribute's base unit, never from a sibling value, never from the magnitude's
 * size. That is #94 normalization rule 1 and this rule has no parameter through
 * which any other origin could reach it.
 */
function unitMagnitudeToBase(raw: string): CatalogExternalTransformOutcome {
  const match = MAGNITUDE_AND_UNIT.exec(raw.trim());
  if (match === null) return { outcome: 'refused', reason: 'unparsed' };

  const [, magnitudeText, unitToken] = match;
  if (magnitudeText === undefined || unitToken === undefined) {
    return { outcome: 'refused', reason: 'unparsed' };
  }

  const magnitudeOutcome = normalizeDecimal(magnitudeText);
  if (magnitudeOutcome.outcome === 'refused') return magnitudeOutcome;

  const unit = resolveUnit(unitToken);
  if (unit === null) return { outcome: 'refused', reason: 'unknown_unit' };
  if (unitFamilyOf(unit) === null) return { outcome: 'refused', reason: 'unknown_unit' };

  const base = toBaseUnit(Number(magnitudeOutcome.value), unit);
  if (base === null || !Number.isFinite(base)) {
    return { outcome: 'refused', reason: 'unknown_unit' };
  }
  return normalized(String(base));
}

/**
 * The registry. Keyed `<rule>:<version>` so a version is part of the lookup
 * rather than a field somebody remembers to compare.
 */
const RULES = new Map<string, TransformRuleFn>([
  ['identity:1', (value) => normalized(value)],
  ['trim:1', (value) => normalized(value.trim())],
  ['case_fold:1', (value) => normalized(value.trim().toLowerCase())],
  ['collapse_whitespace:1', (value) => normalized(value.trim().replace(WHITESPACE_RUN, ' '))],
  // Version 2, and version 1 is deliberately NOT registered. See
  // {@link CATALOG_EXTERNAL_TRANSFORM_RULE_VERSIONS}.
  ['strip_diacritics:2', (value) => normalized(foldAccents(value.trim().toLowerCase()))],
  [
    'path_leaf:1',
    (value) => {
      const segments = value.split(PATH_SEPARATOR).filter((segment) => segment.trim() !== '');
      const leaf = segments[segments.length - 1];
      return normalized(leaf === undefined ? '' : leaf.trim());
    },
  ],
  ['unit_magnitude_to_base:1', unitMagnitudeToBase],
  ['decimal_separator_normalize:1', normalizeDecimal],
]);

/**
 * The versions each rule key ships at.
 *
 * A census test asserts this covers `CATALOG_EXTERNAL_TRANSFORM_RULES` EXACTLY
 * and that every listed version is registered — so a key cannot enter the tuple
 * with no implementation behind it (a mapping citing it would be storable and
 * would refuse forever), and an implementation cannot be registered under a key
 * nobody may cite.
 *
 * ## `strip_diacritics` is at 2, and 1 is RETIRED rather than corrected (#838)
 *
 * Version 1 was `NFD` + drop every `\p{M}` + `NFC`, which is only "remove
 * accents" on Latin. Measured against the real rule: `साइकिल`
 * (bicycle) and `साइकिलें` (bicycles) both
 * became `"सइकल"`; Cyrillic `красный` became
 * `красныи`, collapsing a real letter; and hiragana
 * `じてんしゃ` became `してんしゃ`, a
 * different and meaningless word. Version 2 folds through `foldAccents`, which
 * drops a mark only when it is a Latin combining diacritic on a Latin base.
 *
 * Correcting version 1 IN PLACE was refused, and by this module's own rule: a
 * version is what a reviewed mapping CITES, so redefining one silently changes
 * the meaning of every approved row — "something that happens to a deployment on
 * a Tuesday", which is what the freeze exists to prevent.
 *
 * Version 1 is then not re-registered, because the alternative is worse. Keeping
 * it would leave every mapping approved under it still eating marks, invisibly
 * and indefinitely. Retiring it makes such a mapping answer
 * `rule_not_registered`, which `resolution.service.ts` reports as
 * `transform_refused` — already a member of
 * `catalog_external_mapping_reviews_reason_check`, so the row routes to the
 * review queue that exists for exactly this. That is #834's trade in this
 * domain: an invisible precision failure for a visible recall one.
 */
export const CATALOG_EXTERNAL_TRANSFORM_RULE_VERSIONS: Readonly<
  Record<CatalogExternalTransformRule, readonly number[]>
> = Object.freeze({
  identity: [1],
  trim: [1],
  case_fold: [1],
  collapse_whitespace: [1],
  strip_diacritics: [2],
  path_leaf: [1],
  unit_magnitude_to_base: [1],
  decimal_separator_normalize: [1],
});

/** The highest shipped version of a rule — what a fresh mapping cites. */
export function latestTransformRuleVersion(rule: CatalogExternalTransformRule): number {
  const versions = CATALOG_EXTERNAL_TRANSFORM_RULE_VERSIONS[rule];
  return versions.reduce((highest, version) => (version > highest ? version : highest), 1);
}

/** Whether a `(rule, version)` pair has an implementation in this image. */
export function isTransformRuleRegistered(
  rule: CatalogExternalTransformRule,
  version: number,
): boolean {
  return RULES.has(`${rule}:${version}`);
}

/**
 * Apply a shipped rule to a source's raw value.
 *
 * An unregistered pair is `rule_not_registered` — never a silent `identity`. A
 * mapping reviewed under a rule this image does not carry is a mapping whose
 * meaning nobody here can reproduce, and applying a different transformation
 * under its name is worse than refusing.
 */
export function applyExternalTransform(
  rule: CatalogExternalTransformRule,
  version: number,
  value: string,
): CatalogExternalTransformOutcome {
  const fn = RULES.get(`${rule}:${version}`);
  if (fn === undefined) return { outcome: 'refused', reason: 'rule_not_registered' };
  return fn(value);
}

/** Every registered key, for the census test. Sorted, so the assertion is stable. */
export function registeredTransformRuleKeys(): readonly string[] {
  return [...RULES.keys()].sort();
}

/** The tuple the registry is measured against. Re-exported so the census has one import. */
export const SHIPPED_TRANSFORM_RULES = CATALOG_EXTERNAL_TRANSFORM_RULES;
