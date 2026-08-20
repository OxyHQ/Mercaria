/**
 * Validation findings: where one points, and what to call it.
 *
 * ## Codes, never messages
 *
 * `AuthoringValidationFinding` deliberately has no `message` property — the
 * server composes the sentence at its HTTP boundary and a client never matches
 * on text (ADR 0007 D10). So the dashboard renders a finding by translating its
 * CODE, and {@link findingMessageKey} is the whole of that mapping: a total
 * `Record` over the closed code set, which fails `tsc` the moment a code is
 * added upstream rather than silently rendering nothing.
 *
 * The values are translation KEYS. A sentence in this module would be an
 * English string in module scope, which is exactly what `validate:i18n-strings`
 * exists to refuse.
 *
 * ## Paths, parsed once
 *
 * ADR 0007 D10 fixes one spelling for every path a finding can carry, and
 * {@link parseFindingPath} is the only place this app reads one. A discriminated
 * union comes back rather than a bag of optional fields, so a caller that wants
 * a variant position has to be looking at a variant target.
 */

import type {
  AuthoringValidationCode,
  AuthoringValidationFinding,
  AuthoringValidationSeverity,
} from "@mercaria/shared-types";

/**
 * Where a finding points, in the wizard's own terms.
 *
 * `step` is what the error summary jumps to; the rest identifies the control.
 * The `unknown` branch exists because a path is a string crossing a network:
 * one this app cannot parse is still shown, attached to no control, rather than
 * being dropped — a finding nobody can see is a publish that fails for a reason
 * nobody is told.
 */
export type FindingTarget =
  | { readonly kind: "classification" }
  | { readonly kind: "listing"; readonly field: "title" | "description" | "imageFileIds" }
  | { readonly kind: "product_field"; readonly attributeKey: string; readonly ordinal: number | null }
  | { readonly kind: "variants" }
  | { readonly kind: "variant"; readonly position: number; readonly part: VariantPart }
  | { readonly kind: "variant_field"; readonly position: number; readonly attributeKey: string }
  | { readonly kind: "draft" }
  | { readonly kind: "unknown" };

export type VariantPart = "row" | "price" | "inventory";

/**
 * The wizard step a finding belongs to — what the summary link jumps to.
 *
 * The server's `AuthoringStepKind` is the ordered list of DOMAINS a surface
 * walks; these are the SCREENS this one presents. They are not the same list
 * and pretending they were would put price and stock on their own screens, each
 * rendering the same variant rows with two of their columns — the wizard shows
 * the rows once and asks for money and stock together, which is why `offer` and
 * `inventory` land on one `pricing` step here.
 */
export type WizardStepId =
  | "classification"
  | "details"
  | "variants"
  | "pricing"
  | "listing"
  | "review";

/** In the order the wizard presents them. */
export const WIZARD_STEPS: readonly WizardStepId[] = [
  "classification",
  "details",
  "variants",
  "pricing",
  "listing",
  "review",
];

const VARIANT_PATH = /^variants\[(\d+)\](?:\.(.+))?$/u;
const PRODUCT_FIELD_PATH = /^fields\.([a-z][a-z0-9_]*)(?:\[(\d+)\])?$/u;
const VARIANT_FIELD_PATH = /^fields\.([a-z][a-z0-9_]*)$/u;

/** Parse one path into the control it names. */
export function parseFindingPath(path: string): FindingTarget {
  if (path === "classification.categoryId" || path === "classification.productType") {
    return { kind: "classification" };
  }
  if (path === "listing.title") return { kind: "listing", field: "title" };
  if (path === "listing.description") return { kind: "listing", field: "description" };
  // `listing.imageFileIds`, and `listing.imageFileIds[2]` for a duplicate at one
  // gallery position. Both land on the LISTING step, which is where the
  // `products.wizard.listing.mediaUnavailable` notice renders — so a media
  // finding appears on the screen that talks about media rather than falling
  // through to `unknown` and being shown on `review`.
  //
  // The position is deliberately DISCARDED rather than carried: there is no
  // media control in this wizard to anchor to, so a slot index would be a
  // number pointing at nothing. When a picker lands, the index is what a jump
  // target would use and this is the line that carries it.
  if (path === "listing.imageFileIds" || path.startsWith("listing.imageFileIds[")) {
    return { kind: "listing", field: "imageFileIds" };
  }
  if (path === "variants") return { kind: "variants" };
  if (path.startsWith("draft.")) return { kind: "draft" };

  const variant = VARIANT_PATH.exec(path);
  if (variant !== null) {
    const position = Number.parseInt(variant[1] ?? "", 10);
    if (!Number.isFinite(position)) return { kind: "unknown" };
    const rest = variant[2];
    if (rest === undefined) return { kind: "variant", position, part: "row" };
    if (rest === "price") return { kind: "variant", position, part: "price" };
    if (rest === "inventory") return { kind: "variant", position, part: "inventory" };
    const nested = VARIANT_FIELD_PATH.exec(rest);
    if (nested !== null) {
      const attributeKey = nested[1];
      if (attributeKey !== undefined) return { kind: "variant_field", position, attributeKey };
    }
    return { kind: "variant", position, part: "row" };
  }

  const product = PRODUCT_FIELD_PATH.exec(path);
  if (product !== null) {
    const attributeKey = product[1];
    if (attributeKey === undefined) return { kind: "unknown" };
    const raw = product[2];
    const ordinal = raw === undefined ? null : Number.parseInt(raw, 10);
    return {
      kind: "product_field",
      attributeKey,
      ordinal: ordinal === null || !Number.isFinite(ordinal) ? null : ordinal,
    };
  }
  return { kind: "unknown" };
}

/** The step a target belongs to. */
export function stepForTarget(target: FindingTarget): WizardStepId {
  switch (target.kind) {
    case "classification":
      return "classification";
    case "product_field":
      return "details";
    case "listing":
      return "listing";
    case "variant":
      // A money or a stock complaint belongs on the screen that asks for money
      // and stock. A complaint about the ROW itself — a duplicate combination —
      // belongs where the combinations are built.
      return target.part === "row" ? "variants" : "pricing";
    case "variants":
    case "variant_field":
      return "variants";
    case "draft":
    case "unknown":
    default:
      return "review";
  }
}

/**
 * The translation key for one code.
 *
 * A total `Record` and not a template built from the code, because a template
 * would silently produce a key nothing translates — and `i18n-js` runs with
 * `missingBehavior: 'guess'`, which renders a humanised spelling of the missing
 * key that reads, in review, like a translation somebody wrote.
 */
const MESSAGE_KEYS: Record<AuthoringValidationCode, string> = {
  category_not_selectable: "products.wizard.finding.categoryNotSelectable",
  category_not_in_product_type_scope: "products.wizard.finding.categoryNotInScope",
  product_type_not_published: "products.wizard.finding.productTypeNotPublished",
  schema_version_superseded: "products.wizard.finding.schemaSuperseded",
  required_field_missing: "products.wizard.finding.requiredFieldMissing",
  unknown_field: "products.wizard.finding.unknownField",
  field_forbidden_in_flow: "products.wizard.finding.fieldForbidden",
  value_type_mismatch: "products.wizard.finding.valueTypeMismatch",
  value_not_in_controlled_set: "products.wizard.finding.valueNotInSet",
  value_below_minimum: "products.wizard.finding.valueBelowMinimum",
  value_above_maximum: "products.wizard.finding.valueAboveMaximum",
  value_too_long: "products.wizard.finding.valueTooLong",
  too_many_decimal_places: "products.wizard.finding.tooManyDecimals",
  value_implausible: "products.wizard.finding.valueImplausible",
  cardinality_exceeded: "products.wizard.finding.cardinalityExceeded",
  range_bounds_inverted: "products.wizard.finding.rangeBoundsInverted",
  structured_component_missing: "products.wizard.finding.componentMissing",
  unknown_component_axis: "products.wizard.finding.unknownComponentAxis",
  unknown_unit: "products.wizard.finding.unknownUnit",
  unit_not_in_family: "products.wizard.finding.unitNotInFamily",
  currency_mismatch: "products.wizard.finding.currencyMismatch",
  canonical_reference_not_permitted: "products.wizard.finding.canonicalRefNotPermitted",
  canonical_reference_not_selectable: "products.wizard.finding.canonicalRefNotSelectable",
  proposal_not_permitted: "products.wizard.finding.proposalNotPermitted",
  no_variant_declared: "products.wizard.finding.noVariantDeclared",
  variant_axis_not_permitted: "products.wizard.finding.axisNotPermitted",
  variant_missing_axis_value: "products.wizard.finding.axisValueMissing",
  duplicate_variant_signature: "products.wizard.finding.duplicateVariant",
  duplicate_variant_sku: "products.wizard.finding.duplicateVariantSku",
  identifier_check_digit_invalid: "products.wizard.finding.identifierCheckDigitInvalid",
  duplicate_variant_barcode: "products.wizard.finding.duplicateVariantBarcode",
  identifier_collision: "products.wizard.finding.identifierCollision",
  price_missing: "products.wizard.finding.priceMissing",
  price_currency_missing: "products.wizard.finding.priceCurrencyMissing",
  inventory_negative: "products.wizard.finding.inventoryNegative",
  title_missing: "products.wizard.finding.titleMissing",
  description_missing: "products.wizard.finding.descriptionMissing",
  condition_missing: "products.wizard.finding.conditionMissing",
  media_missing: "products.wizard.finding.mediaMissing",
  duplicate_media_file: "products.wizard.finding.duplicateMediaFile",
  proposal_pending_blocks_publication: "products.wizard.finding.proposalPending",
  approved_value_not_published: "products.wizard.finding.approvedValueNotPublished",
  draft_not_open: "products.wizard.finding.draftNotOpen",
};

export function findingMessageKey(code: AuthoringValidationCode): string {
  return MESSAGE_KEYS[code];
}

/** One finding, resolved to the control it names. */
export interface LocatedFinding {
  readonly code: AuthoringValidationCode;
  readonly severity: AuthoringValidationSeverity;
  readonly path: string;
  readonly target: FindingTarget;
  readonly step: WizardStepId;
  readonly attributeKey: string | null;
}

export function locateFindings(
  findings: readonly AuthoringValidationFinding[],
): readonly LocatedFinding[] {
  return findings.map((finding) => {
    const target = parseFindingPath(finding.path);
    return {
      code: finding.code,
      severity: finding.severity,
      path: finding.path,
      target,
      step: stepForTarget(target),
      attributeKey: finding.attributeKey ?? null,
    };
  });
}

/**
 * The findings attached to one product-scope field.
 *
 * Matched on the PATH rather than on `attributeKey`, because a path is the one
 * spelling every producer uses and `attributeKey` is optional on the DTO — a
 * finding about a field that omitted it would otherwise attach to nothing.
 */
export function findingsForProductField(
  located: readonly LocatedFinding[],
  attributeKey: string,
): readonly LocatedFinding[] {
  return located.filter(
    (finding) => finding.target.kind === "product_field" && finding.target.attributeKey === attributeKey,
  );
}

/** The findings attached to one variant row, by its POSITION among enabled rows. */
export function findingsForVariant(
  located: readonly LocatedFinding[],
  position: number,
): readonly LocatedFinding[] {
  return located.filter(
    (finding) =>
      (finding.target.kind === "variant" || finding.target.kind === "variant_field") &&
      finding.target.position === position,
  );
}

/** Whether any finding blocks publication. */
export function hasBlockingFinding(located: readonly LocatedFinding[]): boolean {
  return located.some((finding) => finding.severity === "error");
}
