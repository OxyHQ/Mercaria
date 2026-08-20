/**
 * Which control a field's value needs — decided ONCE, from the schema.
 *
 * ## Why this module exists
 *
 * `SchemaField.tsx` renders a product field's value and `VariantAxes.tsx`
 * renders an axis value. Both dispatch on {@link expectedEntryKind}, and both
 * separately decided whether a number carries a UNIT — which is exactly the
 * shape of a fact that gets answered twice and then disagrees. It did:
 * `SchemaField` rendered the unit box when `unitFamily !== null` and
 * `VariantAxes` never rendered one at all, so `storage_capacity` — a
 * `measurement` over `digital_storage`, `variantCapable: true` in the shipped
 * smartphone package — presented a merchant with a bare number box on the axis
 * whose whole point is that `256GB` and `256 GB` normalize to one value.
 *
 * Neither renderer is testable: `vitest.config.ts` is `lib/**` only, node
 * environment, no renderer — importing a component pulls `react-native`, whose
 * `index.js` is Flow source Rollup cannot parse. So a decision made inside a
 * component is a decision nothing can execute, and the two walls that DO scan
 * these files (`validate-authoring-schema-driven.mjs`) constrain identity
 * property names and say nothing about which controls exist.
 *
 * Moving the decision here is what makes it gateable at all. Both components
 * call these functions; neither re-derives.
 *
 * ## Nothing here names an attribute
 *
 * Every branch is taken on the schema's own closed vocabularies —
 * `valueType`, `valuePolicy`, `unitFamily` — which the server composes.
 */

import type { AuthoringField, AuthoringValueKind } from "@mercaria/shared-types";
import { expectedEntryKind } from "./answers";

/* -------------------------------------------------------------------------- */
/* The unit affordance                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Whether a number entry for this field carries a unit, and what to show as the
 * placeholder when it does.
 *
 * A discriminated union rather than `{ show: boolean; placeholder: string }`,
 * so the absent branch has no placeholder to read: a renderer cannot print an
 * empty unit box, and it cannot print `""` as a unit either.
 *
 * The placeholder is the attribute's BASE unit — what an unqualified magnitude
 * is read as — and it is a placeholder rather than a value because the entry's
 * own `unit` is already seeded with it by `emptyEntry`. Showing it as a value
 * would make a merchant's deliberate `MB` look like an unedited default.
 */
export type UnitAffordance =
  | { readonly present: false }
  | { readonly present: true; readonly placeholder: string };

const NO_UNIT: UnitAffordance = { present: false };

export function unitAffordance(field: AuthoringField): UnitAffordance {
  if (field.validation.unitFamily === null) return NO_UNIT;
  return { present: true, placeholder: field.validation.baseUnit ?? "" };
}

/* -------------------------------------------------------------------------- */
/* Axis control coverage                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The control an AXIS value gets.
 *
 * `unsupported` is a first-class answer and not a fallthrough: an axis whose
 * value cannot be entered has to say so, because the author has already
 * switched the axis on and the alternative is a control that silently discards
 * what they type.
 */
export type AxisValueSupport = AuthoringValueKind | "unsupported";

/**
 * The kinds an axis value control can actually render today.
 *
 * `boolean` and `canonical_reference` are NOT here, and both are deliberate
 * rather than pending:
 *
 *   - a BOOLEAN axis is a value the matrix ENUMERATES — the two rows are the
 *     axis, so a per-value control would be a switch whose only settings are
 *     the two rows that already exist;
 *   - a CANONICAL REFERENCE axis would mean one variant of a product pointing
 *     at a different canonical entity from its siblings, which is a different
 *     product rather than a different configuration.
 *
 * Neither is reachable from the shipped seed packages. Both stay REPRESENTABLE
 * and refused rather than filtered out of `variantCapableFields`, because the
 * server's `product_type_fields_variant_axis_check` admits them and a client
 * that silently dropped the axis would disagree with a schema that offers it.
 */
export const AXIS_SUPPORTED_KINDS: readonly AuthoringValueKind[] = [
  "controlled_value",
  "number",
  "text",
];

/** What control this field's axis values need. */
export function axisValueSupport(field: AuthoringField): AxisValueSupport {
  const kind = expectedEntryKind(field);
  return AXIS_SUPPORTED_KINDS.includes(kind) ? kind : "unsupported";
}
