/**
 * Draft validation (#367 step 5, ADR 0007 D10) — PURE.
 *
 * No database, no configuration, no clock. Everything here is a function of a
 * composed {@link AuthoringSchema} and the rows a caller already read, which is
 * what makes the whole rule set testable without a server and what makes it
 * impossible for a verdict to depend on which deployment is asking.
 *
 * ## Stable codes and stable paths, and nothing else
 *
 * ADR 0007 D10: "Validation returns stable machine codes and field paths; the
 * message is localized at the boundary. A client never matches on message text."
 * So a finding here carries an {@link AuthoringValidationCode}, a path and the
 * ids it is about — and NO sentence. There is no `message` property to fill in,
 * which is the version of that rule a reviewer can check.
 *
 * ## `error` and `warning` are different facts
 *
 * `error` blocks publication and `warning` does not, and the distinction is what
 * makes `recommended` a real requirement level rather than a synonym for
 * `optional`. A recommended field left empty is REPORTED — visibly, in the same
 * list, with the same path — and still publishes. Collapsing the two either
 * makes a recommendation mandatory or makes it invisible, and both have been
 * tried in enough marketplaces to know how they end.
 *
 * ## `unknown` is never a quiet yes
 *
 * A conditional field whose precondition the draft has not answered is `hidden`
 * — `effectiveFieldRequirement`'s single policy decision, quoted rather than
 * re-implemented. This module calls it and does not restate it: two places
 * deciding what an unresolved condition means is exactly the divergence the
 * interpreter's own doc comment warns about.
 */

import {
  type AttributeComponentAxis,
  type AuthoringField,
  type AuthoringSchema,
  type AuthoringValidationCode,
  type AuthoringValidationFinding,
  type AuthoringValidationResult,
  type AuthoringValidationSeverity,
  type ItemConditionKey,
  type ProductTypeAuthoringFlow,
  type ProductTypeRuleFieldValue,
  type ProductTypeRuleValues,
} from '@mercaria/shared-types';
import {
  effectiveFieldRequirement,
  evaluateVisibilityRule,
} from '../product-types/visibility-rule.js';
import { resolveUnit, unitFamilyOf } from '../canonical/units.js';
import { classifyBarcode, identifierIsGloballyUnique } from './identifier.js';
import {
  CONDITION_REQUIRED_AUTHORING_FLOWS,
  MEDIA_EXPECTED_AUTHORING_FLOWS,
} from '../../db/schema/catalogAuthoring.js';

/** One answer, as validation sees it. Deliberately the storage shape. */
export interface DraftValueForValidation {
  readonly fieldId: string;
  readonly attributeKey: string;
  readonly draftVariantId: string | null;
  readonly ordinal: number;
  readonly componentAxis: AttributeComponentAxis | null;
  readonly kind: 'text' | 'number' | 'boolean' | 'controlled_value' | 'canonical_reference';
  readonly valueText: string | null;
  readonly valueNumber: number | null;
  readonly valueBoolean: boolean | null;
  readonly valueEnumValueId: string | null;
  readonly canonicalRefId: string | null;
  readonly unit: string | null;
}

/** One variant, as validation sees it. */
export interface DraftVariantForValidation {
  readonly id: string;
  readonly position: number;
  readonly priceAmount: number | null;
  readonly priceCurrency: string | null;
  readonly inventoryAvailable: number;
  readonly axisSignature: string | null;
  /** The merchant's own code. Reported on a DUPLICATE, never refused — see the code. */
  readonly sku: string | null;
  /**
   * The trade-item identifier, exactly as the author typed it.
   *
   * RAW rather than pre-normalized, because normalizing on the way in would put
   * a second spelling of `digitsOnly` in the caller — and the caller is a
   * repository mapper, which is where a normalization nobody can see would be
   * hardest to find. `classifyBarcode` is the one place it happens.
   */
  readonly barcode: string | null;
}

/** Everything a validation reads. */
export interface DraftValidationInput {
  readonly schema: AuthoringSchema;
  /** The ETag the draft's answers were given under. */
  readonly draftSchemaHash: string;
  readonly status: 'open' | 'published' | 'discarded';
  readonly title: string | null;
  readonly description: string | null;
  /**
   * The DRAFT's own flow, which is what decides whether a condition is demanded.
   *
   * Read from the draft rather than from `schema.flow` even though the two agree
   * today: the schema is COMPOSED per request and a composition takes a flow as
   * an argument, so reading the answer to "must this draft state a condition"
   * off the composition would make it a property of how somebody asked rather
   * than of what they are selling.
   */
  readonly flow: ProductTypeAuthoringFlow;
  /** #90's key, or `null` when the author has not said (#572). */
  readonly itemConditionKey: ItemConditionKey | null;
  /**
   * The LISTING's own Oxy media file ids, in gallery order.
   *
   * Bare ids and nothing else — Mercaria stores no width, no digest, no MIME
   * type and no owner, and holds no Oxy service credential to read them (the
   * `AssetRef` gap `services/moderation/` records for the same reason). So what
   * is checkable here is COUNT, DUPLICATION and REQUIRED-NESS; whether the file
   * exists, what is in it and whose it is are not, and are deliberately not
   * pretended at.
   */
  readonly imageFileIds: readonly string[];
  readonly variants: readonly DraftVariantForValidation[];
  readonly values: readonly DraftValueForValidation[];
  /** Whether the pinned category is still selectable and in the version's scope. */
  readonly categorySelectable: boolean;
  readonly categoryInScope: boolean;
  /**
   * Enum value ids that EXIST but whose attribute version is not `active` (#568).
   *
   * Read by `validateDraftRow`, because "which version is this value in" is a
   * database question and this module takes none. It changes no verdict — such an
   * id is outside the composed schema's controlled set either way, so publication
   * was already blocked and still is — it changes which CAUSE is reported.
   *
   * REQUIRED rather than optional. An omitted set would silently mean "none are
   * awaiting publication", which is indistinguishable from "nobody looked", and
   * the surface that would omit it is the one reporting an approval.
   */
  readonly valuesAwaitingPublication: ReadonlySet<string>;
}

function finding(
  code: AuthoringValidationCode,
  severity: AuthoringValidationSeverity,
  path: string,
  about?: { fieldId?: string; attributeKey?: string },
): AuthoringValidationFinding {
  return {
    code,
    severity,
    path,
    ...(about?.fieldId === undefined ? {} : { fieldId: about.fieldId }),
    ...(about?.attributeKey === undefined ? {} : { attributeKey: about.attributeKey }),
  };
}

/** The ONE spelling of a path into a draft. See `AuthoringFieldPath`. */
function productFieldPath(attributeKey: string, ordinal: number): string {
  return ordinal === 0 ? `fields.${attributeKey}` : `fields.${attributeKey}[${ordinal}]`;
}

function variantFieldPath(position: number, attributeKey: string): string {
  return `variants[${position}].fields.${attributeKey}`;
}

/**
 * The answers a visibility rule is evaluated against, keyed by attribute key.
 *
 * A rule reads the attribute KEY (`ProductTypeComparisonRule.field`), so this
 * maps by key and not by field id — and it maps the SCALAR a rule can compare,
 * never a row. A multi-valued answer becomes an array, which is what
 * `includes_any` reads; anything the interpreter cannot compare is left absent,
 * which it reads as `unknown` rather than as a failed comparison.
 */
function ruleValues(values: readonly DraftValueForValidation[]): ProductTypeRuleValues {
  const byKey = new Map<string, ProductTypeRuleFieldValue>();
  const multi = new Map<string, (string | number | boolean)[]>();
  for (const value of values) {
    if (value.draftVariantId !== null) continue;
    const scalar = scalarOf(value);
    if (scalar === null) continue;
    if (value.ordinal === 0 && !multi.has(value.attributeKey)) {
      byKey.set(value.attributeKey, scalar);
      multi.set(value.attributeKey, [scalar]);
      continue;
    }
    const bucket = multi.get(value.attributeKey) ?? [];
    bucket.push(scalar);
    multi.set(value.attributeKey, bucket);
    byKey.set(value.attributeKey, bucket);
  }
  const out: Record<string, ProductTypeRuleFieldValue> = {};
  for (const [key, value] of byKey) out[key] = value;
  return out;
}

/** The comparable scalar of one answer, or `null` where there is not one. */
function scalarOf(value: DraftValueForValidation): string | number | boolean | null {
  switch (value.kind) {
    case 'text':
      return value.valueText;
    case 'number':
      return value.valueNumber;
    case 'boolean':
      return value.valueBoolean;
    case 'controlled_value':
      return value.valueEnumValueId;
    case 'canonical_reference':
      return value.canonicalRefId;
    default:
      // Unreachable for a row the schema's CHECKs admitted, and the only honest
      // answer for one that somehow was not: a value this function cannot read
      // must never be compared as though it had been.
      return null;
  }
}

/**
 * The value kind an attribute's declared type requires.
 *
 * The mapping is total over `AttributeValueType` and is stated here rather than
 * inferred, because the interesting cases are the ones a mechanical rule gets
 * wrong: a `date` is stored as TEXT (an ISO 8601 string, so it sorts and
 * round-trips without a timezone anybody has to guess), and a `money` is stored
 * as a NUMBER of minor units with the currency coming from the attribute's own
 * `currency` column rather than from the answer.
 */
function expectedKind(
  field: AuthoringField,
): 'text' | 'number' | 'boolean' | 'controlled_value' | 'canonical_reference' {
  if (field.valuePolicy === 'canonical_reference') return 'canonical_reference';
  switch (field.validation.valueType) {
    case 'boolean':
      return 'boolean';
    case 'integer':
    case 'decimal':
    case 'money':
    case 'measurement':
    case 'structured':
      return 'number';
    case 'enum':
      return 'controlled_value';
    case 'string':
    case 'date':
      return 'text';
    default:
      return 'text';
  }
}

/** How many answers one cardinality admits. `null` means unbounded. */
function maxValuesFor(field: AuthoringField): number | null {
  switch (field.validation.cardinality) {
    case 'single':
      return 1;
    case 'range':
      // A range is exactly two magnitudes — a low and a high — and a third would
      // be a range with no meaning rather than a longer one.
      return 2;
    case 'set':
    case 'ordered_list':
      return null;
    default:
      return null;
  }
}

/** Validate a draft against the schema it was composed under. */
export function validateDraft(input: DraftValidationInput): AuthoringValidationResult {
  const findings: AuthoringValidationFinding[] = [];

  if (input.status !== 'open') {
    findings.push(finding('draft_not_open', 'error', 'draft.status'));
  }
  if (!input.categorySelectable) {
    findings.push(finding('category_not_selectable', 'error', 'classification.categoryId'));
  }
  if (!input.categoryInScope) {
    findings.push(
      finding('category_not_in_product_type_scope', 'error', 'classification.categoryId'),
    );
  }
  if (input.schema.productType.lifecycle !== 'published') {
    // A WARNING and not an error. A draft pins the version it was started under
    // and publishing under a pinned version is legitimate — that is the whole
    // point of pinning. What is NOT legitimate is starting a new draft on an
    // unpublished version, which `createDraft` refuses outright.
    findings.push(finding('product_type_not_published', 'warning', 'classification.productType'));
  }
  if (input.draftSchemaHash !== input.schema.etag) {
    // The rules moved under this draft. ADR 0007 D10: a preview, never a silent
    // rewrite — so this is a warning and the author is shown what changed.
    findings.push(finding('schema_version_superseded', 'warning', 'draft.schemaEtag'));
  }
  if (input.title === null || input.title.trim().length === 0) {
    findings.push(finding('title_missing', 'error', 'listing.title'));
  }
  if (input.description === null || input.description.trim().length === 0) {
    findings.push(finding('description_missing', 'error', 'listing.description'));
  }
  if (
    input.itemConditionKey === null &&
    CONDITION_REQUIRED_AUTHORING_FLOWS.includes(input.flow)
  ) {
    // #572. An ERROR, and the alternative is not a blank field on a form: it is
    // `new` / `seller_declared` written onto the listing in the SELLER's own
    // name, about goods nobody described. Only the flows in the tuple raise it —
    // everywhere else an unstated condition is filled from
    // `AUTHORING_DEFAULT_MERCHANT_CONDITION`, openly, at publication.
    findings.push(finding('condition_missing', 'error', 'condition.itemCondition'));
  }

  checkMedia(findings, input);

  const fieldsById = new Map(input.schema.fields.map((field) => [field.id, field]));
  const rules = ruleValues(input.values);
  const variantByPosition = new Map(input.variants.map((variant) => [variant.id, variant.position]));

  // An answer citing a field this schema does not declare. Reported rather than
  // ignored: silently dropping it is how an author's twenty minutes disappear
  // with every surface reporting success.
  for (const value of input.values) {
    if (fieldsById.has(value.fieldId)) continue;
    findings.push(
      finding('unknown_field', 'error', productFieldPath(value.attributeKey, value.ordinal), {
        attributeKey: value.attributeKey,
      }),
    );
  }

  const valuesByField = new Map<string, DraftValueForValidation[]>();
  for (const value of input.values) {
    const scopeKey = `${value.draftVariantId ?? ''}:${value.fieldId}`;
    const bucket = valuesByField.get(scopeKey) ?? [];
    bucket.push(value);
    valuesByField.set(scopeKey, bucket);
  }

  for (const field of input.schema.fields) {
    const verdict =
      field.visibilityRule === null ? null : evaluateVisibilityRule(field.visibilityRule, rules);
    const requirement = effectiveFieldRequirement(field.requirement, verdict);

    if (field.scope === 'variant') {
      for (const variant of input.variants) {
        const answers = valuesByField.get(`${variant.id}:${field.id}`) ?? [];
        checkField(
          findings,
          field,
          requirement,
          answers,
          variantFieldPath(variant.position, field.key),
          input.valuesAwaitingPublication,
        );
        if (field.variantCapable && answers.length === 0 && requirement === 'required') {
          findings.push(
            finding(
              'variant_missing_axis_value',
              'error',
              variantFieldPath(variant.position, field.key),
              { fieldId: field.id, attributeKey: field.key },
            ),
          );
        }
      }
      continue;
    }

    const answers = valuesByField.get(`:${field.id}`) ?? [];
    checkField(
      findings,
      field,
      requirement,
      answers,
      productFieldPath(field.key, 0),
      input.valuesAwaitingPublication,
    );
  }

  // A variant-scope answer pointing at a field the schema does not mark
  // `variant_capable` is an axis the product type never granted (ADR 0007 D6).
  for (const value of input.values) {
    if (value.draftVariantId === null) continue;
    const field = fieldsById.get(value.fieldId);
    if (field === undefined) continue;
    if (field.variantCapable) continue;
    const position = variantByPosition.get(value.draftVariantId) ?? 0;
    findings.push(
      finding('variant_axis_not_permitted', 'error', variantFieldPath(position, value.attributeKey), {
        fieldId: field.id,
        attributeKey: field.key,
      }),
    );
  }

  if (input.variants.length === 0) {
    findings.push(finding('no_variant_declared', 'error', 'variants'));
  }

  const seenSignatures = new Set<string>();
  // SKU duplication is a WARNING and is folded per SKU rather than reported on
  // every occurrence: three variants sharing one code is ONE thing to fix, and
  // three findings on one path would read as three problems. The key is the
  // trimmed, case-folded code, because `SKU-1` and `sku-1 ` address the same
  // merchant code in every rail that looks one up.
  const skuPositions = new Map<string, number[]>();
  for (const variant of input.variants) {
    if (variant.sku === null) continue;
    const key = variant.sku.trim().toLowerCase();
    if (key === '') continue;
    skuPositions.set(key, [...(skuPositions.get(key) ?? []), variant.position]);
  }
  for (const positions of skuPositions.values()) {
    if (positions.length < 2) continue;
    // Named on the SECOND and every later occurrence, the
    // `duplicate_variant_signature` shape: the first one is not the mistake.
    for (const position of positions.slice(1)) {
      findings.push(finding('duplicate_variant_sku', 'warning', `variants[${position}].sku`));
    }
  }

  checkBarcodes(findings, input.variants);

  for (const variant of input.variants) {
    if (variant.priceAmount === null) {
      findings.push(finding('price_missing', 'error', `variants[${variant.position}].price`));
    } else if (variant.priceCurrency === null) {
      findings.push(
        finding('price_currency_missing', 'error', `variants[${variant.position}].price`),
      );
    }
    if (variant.inventoryAvailable < 0) {
      findings.push(finding('inventory_negative', 'error', `variants[${variant.position}].inventory`));
    }
    if (variant.axisSignature === null) continue;
    if (seenSignatures.has(variant.axisSignature)) {
      // Also a partial unique index. Reported HERE too so the author is told
      // WHICH variant duplicates rather than being handed a 23505 the surface
      // cannot attribute — the `matchIncomingVariant` ruling: a constraint can
      // only refuse the write, never say what it found.
      findings.push(
        finding('duplicate_variant_signature', 'error', `variants[${variant.position}]`),
      );
    }
    seenSignatures.add(variant.axisSignature);
  }

  return {
    publishable: !findings.some((entry) => entry.severity === 'error'),
    findings,
    schemaEtag: input.schema.etag,
  };
}

/**
 * The LISTING's media, which is not a canonical product fact.
 *
 * Two checks and a stated boundary. What is NOT checked, and cannot honestly
 * be: whether the file exists, what is in it, its dimensions, its format, or
 * whether it belongs to this seller. Mercaria stores bare Oxy `file_id`s with
 * no foreign key and never calls `configureServiceAuth`, so every one of those
 * is a question only Oxy can answer and this deployment holds no credential to
 * ask with. A check that reported "image ok" from a well-formed string would be
 * a mechanism nobody built, and the surface would read as though the file had
 * been seen.
 *
 * A COUNT ceiling is not checked either, and that absence is also deliberate:
 * `catalog-authoring-schemas.ts` bounds the array at 64 on the only route that
 * writes it, so a ceiling here could not fire — the shape a reviewer reads as
 * coverage. If a second writer ever appears, the bound belongs here and this
 * paragraph is the note saying so.
 */
function checkMedia(findings: AuthoringValidationFinding[], input: DraftValidationInput): void {
  const path = 'listing.imageFileIds';

  if (input.imageFileIds.length === 0) {
    if (MEDIA_EXPECTED_AUTHORING_FLOWS.includes(input.flow)) {
      // A WARNING, and `MEDIA_EXPECTED_AUTHORING_FLOWS` carries the reasoning:
      // no surface in this repository can obtain an Oxy file id, so an error
      // would be a gate with no reachable green. It is `recommended`'s own
      // severity, which is what that level exists for.
      findings.push(finding('media_missing', 'warning', path));
    }
    return;
  }

  // Folded per FILE, the `duplicate_variant_sku` shape: one photograph pasted
  // three times is one thing to fix. Named on the second and every later
  // occurrence — the first is not the mistake — and the path carries the
  // POSITION, because that is the gallery slot an author would remove.
  const seen = new Set<string>();
  for (let position = 0; position < input.imageFileIds.length; position += 1) {
    const fileId = input.imageFileIds[position];
    if (fileId === undefined) continue;
    // Trimmed, but NOT case-folded. A SKU is a merchant's own code that every
    // rail looks up case-insensitively; an Oxy file id is a foreign service's
    // primary key, and folding it would declare two distinct ids the same.
    const key = fileId.trim();
    if (key === '') continue;
    if (seen.has(key)) {
      findings.push(finding('duplicate_media_file', 'warning', `${path}[${position}]`));
    }
    seen.add(key);
  }
}

/**
 * Every variant's barcode: is it the identifier it claims to be, and does the
 * draft assert the same one twice.
 *
 * The arithmetic is `services/canonical/identifiers.ts`'s and the scheme choice
 * is `./identifier.ts`'s; nothing here re-implements either. The COLLISION
 * against the canonical catalogue is not here at all — it needs a read, and
 * this module takes no database. `identifierCollisionFindings` is where it
 * lives, merged in by `validateDraftRow` the way the pending-proposal findings
 * already are.
 *
 * ## Both findings are WARNINGS, and that is the decision to read
 *
 * `product_variants.sku` and `.barcode` are unique at NO grain in this schema
 * and `AGENTS.md` says in as many words that they must not be re-narrowed — two
 * merchants selling one trade item share a GTIN by definition, and GTIN
 * IDENTITY is `product_identifiers`' collision gate rather than this column.
 * An error here would re-impose in the authoring form a constraint the schema
 * deliberately does not carry, which is the objection `duplicate_variant_sku`
 * already records for the column beside it.
 *
 * The check digit is the same call for a sharper reason: this is a FREE-TEXT
 * column, and a thirteen-digit internal article number is a perfectly ordinary
 * thing to keep in it. `classifyBarcode` cannot tell one from a mistyped EAN —
 * nothing can — so an error would block a merchant whose only remedy is to
 * delete a true value. The cheapest green would be destroying data, which is
 * the shape of gate `~/Oxy/AGENTS.md` says is worse than no gate.
 *
 * What a warning still buys is the whole point: the author is TOLD, in the same
 * list and on the same path, and a barcode that is not a GTIN silently fails to
 * match anything downstream forever.
 */
function checkBarcodes(
  findings: AuthoringValidationFinding[],
  variants: readonly DraftVariantForValidation[],
): void {
  /** The canonical GTIN-14 of each variant that stated a readable one. */
  const canonicalPositions = new Map<string, number[]>();

  for (const variant of variants) {
    const classified = classifyBarcode(variant.barcode);
    const path = `variants[${variant.position}].barcode`;
    if (classified.kind === 'unrecognized') continue;
    if (classified.kind === 'invalid') {
      findings.push(finding('identifier_check_digit_invalid', 'warning', path));
      continue;
    }
    // Only a scheme the registry declares globally unique is worth reporting a
    // repeat of. Read off the registry rather than asserted here, so a scheme
    // whose uniqueness claim changes changes this with it — an MPN repeated
    // across two variants of one product is ordinary and says nothing.
    if (!identifierIsGloballyUnique(classified.scheme)) continue;
    // Keyed on the CANONICAL form, so a UPC-12 and the EAN-13 that pads to the
    // same fourteen digits collide — which they do, because they name one trade
    // item. Keying on the typed string would miss exactly that case.
    canonicalPositions.set(classified.canonicalValue, [
      ...(canonicalPositions.get(classified.canonicalValue) ?? []),
      variant.position,
    ]);
  }

  for (const positions of canonicalPositions.values()) {
    if (positions.length < 2) continue;
    for (const position of positions.slice(1)) {
      findings.push(
        finding('duplicate_variant_barcode', 'warning', `variants[${position}].barcode`),
      );
    }
  }
}

/** Every check that is about ONE field and its answers. */
function checkField(
  findings: AuthoringValidationFinding[],
  field: AuthoringField,
  requirement: AuthoringField['requirement'],
  answers: readonly DraftValueForValidation[],
  path: string,
  /** {@link DraftValidationInput.valuesAwaitingPublication}, threaded (#568). */
  awaitingPublication: ReadonlySet<string>,
): void {
  const about = { fieldId: field.id, attributeKey: field.key };

  if (requirement === 'forbidden' && answers.length > 0) {
    findings.push(finding('field_forbidden_in_flow', 'error', path, about));
    return;
  }
  if (answers.length === 0) {
    if (requirement === 'required') {
      findings.push(finding('required_field_missing', 'error', path, about));
    } else if (requirement === 'recommended') {
      findings.push(finding('required_field_missing', 'warning', path, about));
    }
    return;
  }
  if (requirement === 'hidden') {
    // A hidden field carrying an answer is NOT an error — `hidden` means "this
    // flow does not ask, and a value that arrived another way is kept"
    // (`ProductTypeFieldRequirement`'s own distinction from `forbidden`). So
    // nothing is reported and the value survives.
    return;
  }

  const max = maxValuesFor(field);
  // A structured value carries one answer per AXIS, so the cardinality bound is
  // per axis rather than over the whole set — counting the components of a
  // three-axis dimension as three values would refuse every `single` one.
  const countable =
    field.validation.valueType === 'structured'
      ? new Set(answers.map((answer) => answer.ordinal)).size
      : answers.length;
  if (max !== null && countable > max) {
    findings.push(finding('cardinality_exceeded', 'error', path, about));
  }

  const expected = expectedKind(field);
  const controlled = new Set(field.controlledValues.map((value) => value.id));

  for (const answer of answers) {
    if (answer.kind !== expected) {
      // A canonical REFERENCE on a field whose value policy does not admit one
      // has its own code, and it is reported HERE rather than below because
      // `expectedKind` returns `canonical_reference` only for a field whose
      // policy IS `canonical_reference` — so an answer that reached the branch
      // below had already proved the policy permits it, and the guard there was
      // provably unreachable. It read as coverage: the code was in the closed
      // set, a reviewer saw a check for it, and every real occurrence was
      // reported as a plain `value_type_mismatch` instead.
      findings.push(
        finding(
          answer.kind === 'canonical_reference'
            ? 'canonical_reference_not_permitted'
            : 'value_type_mismatch',
          'error',
          path,
          about,
        ),
      );
      continue;
    }
    if (answer.kind === 'controlled_value') {
      if (answer.valueEnumValueId === null || !controlled.has(answer.valueEnumValueId)) {
        // Same severity, different CAUSE. An approved value queued in an
        // unpublished version is not a merchant answering with something
        // invalid, and the two lead to opposite next actions — change the
        // answer, or wait for an operator to publish (#568).
        const awaiting =
          answer.valueEnumValueId !== null && awaitingPublication.has(answer.valueEnumValueId);
        findings.push(
          finding(
            awaiting ? 'approved_value_not_published' : 'value_not_in_controlled_set',
            'error',
            path,
            about,
          ),
        );
      }
      continue;
    }
    if (answer.kind === 'canonical_reference') {
      // Permitted by construction — see the branch above. Nothing further is
      // checkable HERE: whether the id names a row that exists is a READ, and
      // this module takes no database. `validateDraftRow` is where that belongs
      // and it does not do it yet (reported, not papered over).
      continue;
    }
    if (answer.kind === 'text' && answer.valueText !== null) {
      const maxLength = field.validation.maxLength;
      if (maxLength !== null && answer.valueText.length > maxLength) {
        findings.push(finding('value_too_long', 'error', path, about));
      }
      continue;
    }
    if (answer.kind === 'number' && answer.valueNumber !== null) {
      checkNumber(findings, field, answer, path, about);
    }
  }

  if (field.validation.cardinality === 'range') {
    checkRange(findings, answers, path, about);
  }

  if (field.validation.valueType === 'structured') {
    checkStructured(findings, field, answers, path, about);
  }
}

/**
 * A `range` is a LOW bound and a HIGH bound, in ordinal order.
 *
 * `maxValuesFor` already refuses a third magnitude — "a range with no meaning
 * rather than a longer one" — and this is the other half of the same rule.
 * An inverted pair is not a narrower range: every `low <= x <= high` comparison
 * against it is false, so it matches nothing, filters nothing and reads to a
 * merchant exactly like a value nobody entered. `canonical_attribute_values`
 * states the identical rule as a CHECK
 * (`canonical_attribute_values_range_lower_check`); this is that rule where an
 * author can still fix it.
 *
 * A range with fewer than two magnitudes is NOT reported here — the requirement
 * level already decides whether an incomplete answer is a problem, and reporting
 * one from two places would put two findings on one path.
 */
function checkRange(
  findings: AuthoringValidationFinding[],
  answers: readonly DraftValueForValidation[],
  path: string,
  about: { fieldId: string; attributeKey: string },
): void {
  const low = answers.find((answer) => answer.ordinal === 0)?.valueNumber;
  const high = answers.find((answer) => answer.ordinal === 1)?.valueNumber;
  if (low === undefined || low === null || high === undefined || high === null) return;
  if (low > high) {
    findings.push(finding('range_bounds_inverted', 'error', path, about));
  }
}

/** Bounds, precision, plausibility and the unit — every numeric rule #94 states. */
function checkNumber(
  findings: AuthoringValidationFinding[],
  field: AuthoringField,
  answer: DraftValueForValidation,
  path: string,
  about: { fieldId: string; attributeKey: string },
): void {
  const value = answer.valueNumber;
  if (value === null) return;
  const validation = field.validation;

  if (validation.minValue !== null && value < validation.minValue) {
    findings.push(finding('value_below_minimum', 'error', path, about));
  }
  if (validation.maxValue !== null && value > validation.maxValue) {
    findings.push(finding('value_above_maximum', 'error', path, about));
  }
  // The scale-error detector, and it is a WARNING rather than an error on
  // purpose: `implausible_above` is #94's "this is probably a decimal-point
  // mistake", which is a different claim from "this is outside the permitted
  // range". A 40-inch phone screen is almost certainly wrong and just possibly a
  // prototype, and refusing it outright would make the catalogue unable to
  // record something true.
  if (validation.implausibleAbove !== null && value > validation.implausibleAbove) {
    findings.push(finding('value_implausible', 'warning', path, about));
  }
  if (validation.implausibleBelow !== null && value < validation.implausibleBelow) {
    findings.push(finding('value_implausible', 'warning', path, about));
  }
  if (validation.decimalPlaces !== null) {
    const decimals = decimalPlacesOf(value);
    if (decimals > validation.decimalPlaces) {
      findings.push(finding('too_many_decimal_places', 'error', path, about));
    }
  }
  if (validation.unitFamily !== null) {
    checkUnit(findings, validation.unitFamily, answer.unit, path, about);
  }
  // A rating is a magnitude on a DECLARED scale, and the scale's ceiling is a
  // bound like any other — #94 models percentages, ratios and ratings as
  // distinct unit families precisely so a 42 cannot sit on a five-point scale.
  // `value_above_maximum` rather than a code of its own: for an author it is the
  // same fact ("too big for this field") and the path already names the field,
  // while a second code would need a second branch in every client's renderer.
  if (validation.ratingScaleMax !== null && value > validation.ratingScaleMax) {
    findings.push(finding('value_above_maximum', 'error', path, about));
  }
  if (validation.valueType === 'money' && validation.currency === null) {
    findings.push(finding('currency_mismatch', 'error', path, about));
  }
}

/**
 * The unit an answer carries, against the family the attribute declares.
 *
 * Three outcomes and they are three different facts:
 *
 * - **absent** — `unknown_unit`. A magnitude with no unit is not a smaller fact,
 *   it is an ambiguous one: 6.1 of what. #94's normalization rule is that a unit
 *   comes from the source's own token or a recorded mapping and NEVER from the
 *   attribute's base unit, so imputing `baseUnit` here would be inventing what
 *   somebody meant.
 * - **unreadable** — `unknown_unit` too. `resolveUnit` matches an explicit alias
 *   table and returns `null` for anything else, which is the same "of what" for
 *   an author and the same remedy.
 * - **readable and of the wrong DIMENSION** — `unit_not_in_family`, which is a
 *   different remedy and had no representation at all before: a `kg` on a screen
 *   size validated clean, published, and became a length in millimetres nobody
 *   could reconcile.
 *
 * The registry is `services/canonical/units.ts` — the same table
 * `services/attributes/normalization.service.ts` normalizes against, so a value
 * this function admits is one the normalizer can convert. A second alias table
 * here would be the two-representations failure applied to a vocabulary.
 */
function checkUnit(
  findings: AuthoringValidationFinding[],
  unitFamily: NonNullable<AuthoringField['validation']['unitFamily']>,
  unit: string | null,
  path: string,
  about: { fieldId: string; attributeKey: string },
): void {
  if (unit === null) {
    findings.push(finding('unknown_unit', 'error', path, about));
    return;
  }
  const resolved = resolveUnit(unit);
  if (resolved === null) {
    findings.push(finding('unknown_unit', 'error', path, about));
    return;
  }
  if (unitFamilyOf(resolved) !== unitFamily) {
    findings.push(finding('unit_not_in_family', 'error', path, about));
  }
}

/**
 * Decimal places, counted from the DECIMAL rendering rather than from a binary
 * one.
 *
 * `Number.prototype.toString()` produces the shortest round-tripping decimal, so
 * `0.1 + 0.2` reports 17 places and not 1 — which is correct, because that value
 * genuinely is not one decimal place, and reporting it as one is how a precision
 * rule silently stops applying to exactly the values that need it.
 */
function decimalPlacesOf(value: number): number {
  const rendered = value.toString();
  if (rendered.includes('e') || rendered.includes('E')) {
    // An exponential rendering means a magnitude no precision rule was written
    // for. Reporting 0 would pass it; reporting a large number reports it.
    return Number.MAX_SAFE_INTEGER;
  }
  const dot = rendered.indexOf('.');
  return dot === -1 ? 0 : rendered.length - dot - 1;
}

/** Every declared axis answered, and no axis the declaration does not name. */
function checkStructured(
  findings: AuthoringValidationFinding[],
  field: AuthoringField,
  answers: readonly DraftValueForValidation[],
  path: string,
  about: { fieldId: string; attributeKey: string },
): void {
  const declared = new Set<string>(field.validation.componentAxes);
  const supplied = new Set<string>();
  for (const answer of answers) {
    if (answer.componentAxis === null) continue;
    supplied.add(answer.componentAxis);
    if (!declared.has(answer.componentAxis)) {
      findings.push(finding('unknown_component_axis', 'error', path, about));
    }
  }
  for (const axis of declared) {
    if (!supplied.has(axis)) {
      findings.push(finding('structured_component_missing', 'error', path, about));
    }
  }
}

/*
 * `proposal_pending_blocks_publication` and `proposal_not_permitted` are DEFINED
 * and produced by nothing here, and the absence is the seam rather than an
 * oversight.
 *
 * ADR 0007 D9's proposals are #367 merge-order step 6. Until `catalog_proposals`
 * exists there is no row a draft value could cite, so a value that is "still a
 * proposal" has no representation — and a check for one would be a check that
 * can never fire, which reads as coverage. The two codes stay in the closed set
 * because the product type version's `pendingProposalPolicy` already carries the
 * decision they act on, so step 6 adds a producer and changes no vocabulary.
 */
