import { formatMoney } from '@mercaria/ui';
import type {
  AttributeDefinition,
  AttributeVerificationState,
  PublicAttributeValue,
} from '@mercaria/shared-types';
import { languageOf, type SpecificationLabelSource } from './locale';

/**
 * A product page's specification table, composed from the SAME registry the
 * authoring wizard composes its form from (#367 workstream 9).
 *
 * Pure. Everything it needs arrives as arguments: the category's attribute
 * DEFINITIONS (what the attributes mean and what they are called in this
 * locale) and the entity's selected VALUES (which of them this thing has).
 * There is no category-specific or product-type-specific list anywhere in it,
 * and no parameter it could be handed one through.
 *
 * ## What decides a row is the SERVER, twice over
 *
 * Which rows exist is `PublicAttributeValue[]` — the registry's own selected
 * values, already filtered by its `displayPolicy`, already excluding the
 * conflicting and unparsed ones Mercaria is unwilling to state. Their ORDER is
 * `position`, which is the registry's own display order. Nothing here sorts by
 * label, because sorting by label reorders the table when the locale changes.
 *
 * ## Two groups, and both are FACTS rather than an arrangement
 *
 * `product` and `variant` are the two entity kinds the value surface has, so
 * the split is "true of the model" versus "true of this exact configuration" —
 * which is also what makes a variant-specific fact comparable at the exact
 * variant rather than at the product. A group is EMITTED only when it has rows.
 *
 * The product type's own authoring GROUPS (`AuthoringGroup`, and the ordered
 * field groups #367 workstream 3 defines) are a **named seam**: they are served
 * only by `GET /catalog-authoring/schemas/:productTypeKey`, which is behind
 * `authenticateToken` and a false-by-default flag, and `ProductTypeVersionView`
 * is defined and served by no route at all. {@link SpecificationGrouping}
 * therefore has one member today, it is reported on the table, and closing the
 * seam is a second grouping member plus the read that supplies it — not a list
 * invented here.
 *
 * ## Values are FORMATTED, never converted
 *
 * `displayValue` is composed by the server in the display unit under the
 * registry's own recorded conversion rules. This module never divides, scales
 * or re-unitises it. What it does add is CLDR presentation for the three value
 * types where a raw projection is not a locale's spelling of the number — a
 * date, a money amount and a bare numeric magnitude — which is #367 workstream
 * 2's "use `Intl`/CLDR-compatible formatting … keep canonical numeric/unit
 * storage independent from localized formatting". Money goes through
 * `@mercaria/ui`'s `formatMoney` chokepoint, never through arithmetic here.
 */

export type SpecificationScope = 'product' | 'variant';

/**
 * Where the grouping came from.
 *
 * ONE member. See the header: the product type's ordered field groups have no
 * anonymous read, and a grouping composed here would be the per-product-type
 * spec list this workstream exists to delete.
 */
export type SpecificationGrouping = 'entity_scope';

export interface SpecificationEntry {
  /** The registry's stable machine key. Identity; never rendered as the label. */
  readonly attributeKey: string;
  readonly label: string;
  readonly labelSource: SpecificationLabelSource;
  /** The value as a shopper reads it, in this locale's spelling. */
  readonly displayValue: string;
  /** The definition version the meaning came from, when a definition answered. */
  readonly definitionVersion?: number;
  /** The base unit a numeric magnitude is expressed in, when there is one. */
  readonly unit?: string;
  readonly verificationState: AttributeVerificationState;
  /** Whether #94 permits this attribute to appear in a comparison at all. */
  readonly comparable: boolean;
  readonly scope: SpecificationScope;
  readonly position: number;
}

export interface SpecificationGroup {
  readonly scope: SpecificationScope;
  readonly entries: readonly SpecificationEntry[];
}

export interface SpecificationTable {
  readonly grouping: SpecificationGrouping;
  readonly groups: readonly SpecificationGroup[];
  /** True when at least one row's label came from a locale nobody translated. */
  readonly hasUntranslatedLabels: boolean;
}

export interface SpecificationInput {
  readonly locale: string;
  readonly definitions: readonly AttributeDefinition[];
  readonly productValues: readonly PublicAttributeValue[];
  readonly variantValues: readonly PublicAttributeValue[];
}

/**
 * ADR 0007 D4's fallback chain, applied to a definition's own label rows:
 * exact locale, then the language, then the definition's default-locale label.
 *
 * The step that answered is RETURNED rather than swallowed, because "we have no
 * Spanish word for this" and "here is the Spanish word" are different facts and
 * a table that renders them identically cannot report its own coverage.
 */
function localizedLabel(
  definition: AttributeDefinition,
  locale: string,
): { label: string; source: SpecificationLabelSource } {
  const wanted = locale.trim().toLowerCase();
  const language = languageOf(locale);

  for (const entry of definition.labels) {
    if (entry.locale.trim().toLowerCase() === wanted) {
      return { label: entry.label, source: 'definition_locale' };
    }
  }
  for (const entry of definition.labels) {
    if (languageOf(entry.locale) === language) {
      return { label: entry.label, source: 'definition_language' };
    }
  }
  return { label: definition.label, source: 'definition_base' };
}

/**
 * Present a value in this locale's spelling, without changing what it says.
 *
 * Three value types get CLDR treatment and the rest are passed through exactly
 * as the server composed them:
 *
 * - `money` — through the `@mercaria/ui` chokepoint, which owns precision, the
 *   symbol and bidi isolation. A `Money` amount is integer MINOR units and
 *   dividing it here would be a second answer to what a currency's precision is.
 * - `date` — an ISO instant is not a date anybody reads.
 * - a bare numeric magnitude with no unit — grouping and decimal separators are
 *   a locale's, and `1234.5` is `1.234,5` to half of Mercaria's shoppers.
 *
 * A MEASUREMENT keeps its server-composed form untouched: the number and its
 * unit token were composed together under a recorded conversion, and re-rendering
 * only the number would leave the two spelled by different authorities.
 */
function presentValue(value: PublicAttributeValue, locale: string): string {
  if (
    value.normalizedAmountMinor !== undefined &&
    value.normalizedCurrency !== undefined
  ) {
    return formatMoney(
      {
        amount: value.normalizedAmountMinor,
        currency: value.normalizedCurrency,
      },
      locale,
    );
  }

  if (value.normalizedDate !== undefined) {
    const parsed = new Date(value.normalizedDate);
    if (!Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(parsed);
    }
    return value.displayValue;
  }

  if (
    value.normalizedNumber !== undefined &&
    value.normalizedNumberMax === undefined &&
    value.normalizedUnit === undefined
  ) {
    return new Intl.NumberFormat(locale).format(value.normalizedNumber);
  }

  return value.displayValue;
}

function toEntry(
  value: PublicAttributeValue,
  scope: SpecificationScope,
  byKey: ReadonlyMap<string, AttributeDefinition>,
  locale: string,
): SpecificationEntry {
  const definition = byKey.get(value.key);
  const label =
    definition === undefined
      ? { label: value.label, source: 'value_projection' as const }
      : localizedLabel(definition, locale);

  return {
    attributeKey: value.key,
    label: label.label,
    labelSource: label.source,
    displayValue: presentValue(value, locale),
    ...(definition === undefined ? {} : { definitionVersion: definition.version }),
    ...(value.normalizedUnit === undefined ? {} : { unit: value.normalizedUnit }),
    verificationState: value.verificationState,
    // A definition nobody could resolve is NOT assumed comparable. Unknown is
    // not a soft yes: putting such a row into a comparison would be asserting a
    // capability #94 never granted.
    comparable: definition?.comparable ?? false,
    scope,
    position: value.position,
  };
}

function group(
  values: readonly PublicAttributeValue[],
  scope: SpecificationScope,
  byKey: ReadonlyMap<string, AttributeDefinition>,
  locale: string,
): SpecificationGroup | undefined {
  if (values.length === 0) return undefined;
  const entries = values
    .map((value) => toEntry(value, scope, byKey, locale))
    .sort((left, right) => left.position - right.position);
  return { scope, entries };
}

/** Compose the table. */
export function composeSpecificationTable(input: SpecificationInput): SpecificationTable {
  const byKey = new Map<string, AttributeDefinition>();
  for (const definition of input.definitions) {
    byKey.set(definition.key, definition);
  }

  const groups: SpecificationGroup[] = [];
  const productGroup = group(input.productValues, 'product', byKey, input.locale);
  if (productGroup !== undefined) groups.push(productGroup);
  const variantGroup = group(input.variantValues, 'variant', byKey, input.locale);
  if (variantGroup !== undefined) groups.push(variantGroup);

  const hasUntranslatedLabels = groups.some((entry) =>
    entry.entries.some(
      (row) => row.labelSource !== 'definition_locale' && row.labelSource !== 'definition_language',
    ),
  );

  return { grouping: 'entity_scope', groups, hasUntranslatedLabels };
}
