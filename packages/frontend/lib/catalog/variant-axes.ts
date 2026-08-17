import type {
  AttributeDefinition,
  CanonicalProduct,
  ProductPageVariant,
} from '@mercaria/shared-types';
import { languageOf, type SpecificationLabelSource } from './locale';

/**
 * The variant selector, built from the product's ACTUAL axes (#367 workstream 9,
 * workstream 3 §"Variant semantics").
 *
 * > Make the product's declared variant axes authoritative for that product.
 *
 * So `CanonicalProduct.variantDefiningAttributeKeys` is the authority when the
 * product declares any, in the order it declares them, and the fallback is the
 * option keys the CONFIGURATIONS themselves carry — never a list of axis names
 * this package knows. There is no per-category axis map here and no parameter
 * one could arrive through: everything is derived from the product and its
 * configurations.
 *
 * ## Four availability states, and only two of them are selectable
 *
 * | State | What it means | Selectable |
 * | --- | --- | --- |
 * | `available` | a configuration carries it and this page shows offers for it | yes |
 * | `unavailable` | a configuration carries it and it has no offer on this page | no |
 * | `impossible` | NO configuration carries it beside the other choices | no |
 * | `unknown` | configurations carry it and none reports an offer count | **yes** |
 *
 * `impossible` is the sparse matrix (#367 workstream 3: "support sparse matrices
 * where not every cross-product combination exists"). It is a different fact
 * from `unavailable` and the two are kept apart, because "we do not make that
 * one" and "that one is out of stock" lead a shopper to opposite next actions.
 *
 * **`unknown` stays selectable and that is the load-bearing case.**
 * `ProductPageVariant.offerCount` is ABSENT when the offers half was withheld —
 * a canonical read lever is off, or the comparison is withdrawn. Reading absence
 * as "no offers" would disable every control on the page and present a withheld
 * comparison as a discontinued product. Unknown is never a soft no.
 *
 * ## A value's availability ignores its OWN axis's current selection
 *
 * Each value is evaluated against the selection with its own axis removed, so
 * every value on an axis stays reachable while the other choices hold. Evaluating
 * against the full selection would make each axis show exactly one enabled
 * value — its own — which is a selector nobody can move.
 */

export type VariantAxisSource = 'product_declared' | 'observed_from_configurations';

export type VariantValueAvailability = 'available' | 'unavailable' | 'impossible' | 'unknown';

export interface VariantAxisValue {
  /** The value the canonical signature is computed over. Identity. */
  readonly normalizedValue: string;
  /** What a shopper reads. Never sent anywhere as identity. */
  readonly displayValue: string;
  readonly availability: VariantValueAvailability;
  readonly selectable: boolean;
  readonly selected: boolean;
}

export interface VariantAxis {
  /** The registry attribute key. Identity. */
  readonly key: string;
  readonly label: string;
  readonly labelSource: SpecificationLabelSource;
  readonly values: readonly VariantAxisValue[];
}

/** `axisKey → normalizedValue`. Stable keys only; never a display value. */
export type VariantSelection = Readonly<Record<string, string>>;

export interface VariantMatrix {
  readonly axes: readonly VariantAxis[];
  readonly axisSource: VariantAxisSource;
  readonly selection: VariantSelection;
  /** The one configuration the selection resolves to, when it resolves to one. */
  readonly selectedVariantId?: string;
  /**
   * Whether any configuration reported an offer count at all. False means the
   * offers half was withheld and every value is `unknown` — a surface says so
   * rather than rendering an availability it does not have.
   */
  readonly availabilityKnown: boolean;
}

/** `optionKey → normalizedValue` for one configuration. */
function optionsOf(variant: ProductPageVariant): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const option of variant.options) {
    map.set(option.key, option.normalizedValue);
  }
  return map;
}

function matchesSelection(
  variant: ProductPageVariant,
  selection: VariantSelection,
  ignoreAxisKey?: string,
): boolean {
  const options = optionsOf(variant);
  for (const [axisKey, wanted] of Object.entries(selection)) {
    if (axisKey === ignoreAxisKey) continue;
    if (options.get(axisKey) !== wanted) return false;
  }
  return true;
}

function availabilityOf(candidates: readonly ProductPageVariant[]): VariantValueAvailability {
  if (candidates.length === 0) return 'impossible';
  let sawCount = false;
  for (const candidate of candidates) {
    if (candidate.offerCount === undefined) continue;
    sawCount = true;
    if (candidate.offerCount > 0) return 'available';
  }
  return sawCount ? 'unavailable' : 'unknown';
}

/** ADR 0007 D4's chain over a definition's own label rows. */
function axisLabel(
  key: string,
  byKey: ReadonlyMap<string, AttributeDefinition>,
  locale: string,
): { label: string; source: SpecificationLabelSource } {
  const definition = byKey.get(key);
  if (definition === undefined) {
    // The stable key, and the surface is TOLD it is one. Never a prettified
    // spelling of it: turning `storage_capacity` into "Storage capacity" is a
    // label this package invented, and #367 forbids a client authoring one.
    return { label: key, source: 'value_projection' };
  }
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
 * The axis keys, in order.
 *
 * A declared axis carried by NO configuration is dropped — it would render as a
 * control with nothing in it. A product that declares none falls back to what
 * its configurations actually differ on, ordered by the option's own `position`.
 */
function resolveAxisKeys(
  product: Pick<CanonicalProduct, 'variantDefiningAttributeKeys'>,
  variants: readonly ProductPageVariant[],
): { keys: readonly string[]; source: VariantAxisSource } {
  const present = new Set<string>();
  for (const variant of variants) {
    for (const option of variant.options) present.add(option.key);
  }

  const declared = product.variantDefiningAttributeKeys.filter((key) => present.has(key));
  if (declared.length > 0) return { keys: declared, source: 'product_declared' };

  const positions = new Map<string, number>();
  for (const variant of variants) {
    for (const option of variant.options) {
      const seen = positions.get(option.key);
      if (seen === undefined || option.position < seen) positions.set(option.key, option.position);
    }
  }
  const observed = [...positions.entries()]
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
    .map(([key]) => key);
  return { keys: observed, source: 'observed_from_configurations' };
}

export interface VariantMatrixInput {
  readonly product: Pick<CanonicalProduct, 'variantDefiningAttributeKeys'>;
  readonly variants: readonly ProductPageVariant[];
  readonly definitions: readonly AttributeDefinition[];
  readonly locale: string;
  readonly selection: VariantSelection;
}

export function composeVariantMatrix(input: VariantMatrixInput): VariantMatrix {
  const byKey = new Map<string, AttributeDefinition>();
  for (const definition of input.definitions) byKey.set(definition.key, definition);

  const { keys, source } = resolveAxisKeys(input.product, input.variants);
  const availabilityKnown = input.variants.some(
    (variant) => variant.offerCount !== undefined,
  );

  const axes: VariantAxis[] = keys.map((key) => {
    // The values this axis offers, in the order the configurations list them,
    // deduplicated on the NORMALIZED value — two configurations spelling one
    // value differently are one choice, and the first spelling wins.
    const byNormalized = new Map<string, string>();
    const positions = new Map<string, number>();
    for (const variant of input.variants) {
      for (const option of variant.options) {
        if (option.key !== key) continue;
        if (!byNormalized.has(option.normalizedValue)) {
          byNormalized.set(option.normalizedValue, option.displayValue);
          positions.set(option.normalizedValue, option.position);
        }
      }
    }

    const label = axisLabel(key, byKey, input.locale);
    const values: VariantAxisValue[] = [...byNormalized.entries()]
      .sort(
        (left, right) =>
          (positions.get(left[0]) ?? 0) - (positions.get(right[0]) ?? 0) ||
          left[1].localeCompare(right[1], input.locale),
      )
      .map(([normalizedValue, displayValue]) => {
        const candidates = input.variants.filter(
          (variant) =>
            matchesSelection(variant, input.selection, key) &&
            optionsOf(variant).get(key) === normalizedValue,
        );
        const availability = availabilityOf(candidates);
        return {
          normalizedValue,
          displayValue,
          availability,
          selectable: availability === 'available' || availability === 'unknown',
          selected: input.selection[key] === normalizedValue,
        };
      });

    return { key, label: label.label, labelSource: label.source, values };
  });

  const fullySelected = keys.every((key) => input.selection[key] !== undefined);
  const resolved = fullySelected
    ? input.variants.filter((variant) => matchesSelection(variant, input.selection))
    : [];

  return {
    axes,
    axisSource: source,
    selection: input.selection,
    // Exactly one, or none. Two configurations matching a full selection means
    // they differ on something outside the axis set, and picking either would
    // be choosing on a shopper's behalf on a fact they were never shown.
    ...(resolved.length === 1 ? { selectedVariantId: resolved[0].id } : {}),
    availabilityKnown,
  };
}

/**
 * Apply one choice, dropping every LATER axis choice it invalidates.
 *
 * Pressing a value must always take effect — a selector where a press does
 * nothing because the rest of the selection forbids it is one a shopper cannot
 * escape. So the choice is applied and any other axis whose current value is now
 * impossible beside it is CLEARED, which returns the selector to a state every
 * remaining control can move from.
 */
export function applyVariantChoice(
  matrix: VariantMatrix,
  variants: readonly ProductPageVariant[],
  axisKey: string,
  normalizedValue: string,
): VariantSelection {
  const next: Record<string, string> = { ...matrix.selection, [axisKey]: normalizedValue };
  if (matrix.selection[axisKey] === normalizedValue) {
    delete next[axisKey];
    return next;
  }

  for (const axis of matrix.axes) {
    if (axis.key === axisKey) continue;
    const chosen = next[axis.key];
    if (chosen === undefined) continue;
    const stillPossible = variants.some(
      (variant) =>
        optionsOf(variant).get(axisKey) === normalizedValue &&
        optionsOf(variant).get(axis.key) === chosen,
    );
    if (!stillPossible) delete next[axis.key];
  }
  return next;
}
