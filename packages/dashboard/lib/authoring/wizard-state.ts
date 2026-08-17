/**
 * The wizard's local form state: how a draft becomes one, how it becomes a
 * patch, and how "have I finished this step" is decided.
 *
 * ## The form is the authority WHILE the wizard is open
 *
 * A draft is one author's private work in progress, so the local state is what
 * the screen renders and the server copy is what it converges on. The direction
 * matters for autosave: a save sends the local state and takes back the
 * server's `version`, and nothing else about the response is applied — applying
 * the server's echo would move the cursor of anybody typing while a save is in
 * flight.
 *
 * ## Completeness is DERIVED, never stored
 *
 * `stepCompleteness` reads the schema, the effective requirements and the
 * entries; there is no `completedSteps` set anybody has to keep in step with
 * the answers. A stored one goes stale in exactly the case that matters — a
 * conditional field appearing after an earlier answer changes.
 *
 * ## What is deliberately not here
 *
 * `imageFileIds` is never SENT. A patch leaves a field it does not name
 * untouched, and this app has no way to obtain an Oxy file id — no upload path
 * exists anywhere in this repository — so naming the property would replace a
 * draft's media with an empty list every time somebody typed a title. What that
 * costs is stated in `docs/dashboard-authoring.md` rather than hidden behind a
 * picker that does nothing.
 */

import type {
  AuthoringDraft,
  AuthoringField,
  AuthoringSchema,
  CurrencyCode,
  ProductTypeFieldRequirement,
} from "@mercaria/shared-types";
import type { DraftFieldPayload, PatchDraftPayload } from "./api";
import {
  composeFieldPayload,
  hasAnswer,
  hydrateEntries,
  initialEntries,
  ruleValuesFor,
  type DraftFieldEntries,
} from "./answers";
import { effectiveRequirement } from "./visibility";
import {
  axisDedupeKey,
  controlledValueStrings,
  duplicateRowKeys,
  enabledVariantPayloads,
  nextRowKey,
  singleVariantRow,
  variantCapableFields,
  type MatrixAxis,
  type VariantRow,
} from "./matrix";
import { toMajorString, toMinorUnits } from "../money";
import type { WizardStepId } from "./findings";

/** Everything the author has entered, for one open draft. */
export interface WizardFormState {
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly selectedCanonicalProductId: string | null;
  readonly productEntries: DraftFieldEntries;
  readonly axes: readonly MatrixAxis[];
  readonly rows: readonly VariantRow[];
}

/** The default presentment currency a fresh row prices in. */
export const DEFAULT_DRAFT_CURRENCY: CurrencyCode = "FAIR";

/** Every field of the schema, by its stable machine key. */
export function fieldsByKey(schema: AuthoringSchema): ReadonlyMap<string, AuthoringField> {
  return new Map(schema.fields.map((field) => [field.key, field]));
}

/** The product-scope fields a form asks for: `identity` and `product`. */
export function productScopeFields(schema: AuthoringSchema): readonly AuthoringField[] {
  return schema.fields.filter(
    (field) => field.scope === "identity" || field.scope === "product",
  );
}

/**
 * The requirement each product-scope field actually has, given the answers so
 * far. Recomputed on every render because a conditional field appears the
 * moment the answer it depends on lands.
 */
export function effectiveRequirements(
  schema: AuthoringSchema,
  entries: DraftFieldEntries,
): ReadonlyMap<string, ProductTypeFieldRequirement> {
  const values = ruleValuesFor(entries);
  const out = new Map<string, ProductTypeFieldRequirement>();
  for (const field of schema.fields) {
    out.set(field.key, effectiveRequirement(field.requirement, field.visibilityRule, values));
  }
  return out;
}

/** Whether a field is one this flow shows at all. */
export function isVisible(requirement: ProductTypeFieldRequirement): boolean {
  return requirement !== "hidden" && requirement !== "forbidden";
}

/* -------------------------------------------------------------------------- */
/* Hydration                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Turn a saved draft into form state.
 *
 * Product-scope entries come from the draft; a field with no stored answer gets
 * its empty entries so the control renders with a box rather than with nothing.
 * The AXES are derived from the rows rather than stored: which attributes this
 * product varies along is exactly which ones its variants carry answers for
 * (ADR 0007 D6 — the product's own declared axis list is authoritative), and a
 * second stored list would be a second answer to that.
 */
export function hydrateForm(draft: AuthoringDraft, schema: AuthoringSchema): WizardFormState {
  const stored = hydrateEntries(draft.values, null);
  const productEntries: Record<string, DraftFieldEntries[string]> = { ...stored };
  for (const field of productScopeFields(schema)) {
    if (productEntries[field.key] === undefined) productEntries[field.key] = initialEntries(field);
  }

  const rows: VariantRow[] = draft.variants
    .slice()
    .sort((left, right) => left.position - right.position)
    .map((variant) => ({
      key: nextRowKey(),
      axes: hydrateEntries(draft.values, variant.id),
      enabled: true,
      sku: variant.sku ?? "",
      barcode: variant.barcode ?? "",
      priceMajor:
        variant.priceAmount === null || variant.priceCurrency === null
          ? ""
          : toMajorString(variant.priceAmount, variant.priceCurrency),
      compareAtMajor:
        variant.compareAtPriceAmount === null || variant.compareAtPriceCurrency === null
          ? ""
          : toMajorString(variant.compareAtPriceAmount, variant.compareAtPriceCurrency),
      currency: variant.priceCurrency ?? DEFAULT_DRAFT_CURRENCY,
      inventoryTracked: variant.inventoryTracked,
      inventoryAvailable: String(variant.inventoryAvailable),
      selectedCanonicalVariantId: variant.selectedCanonicalVariantId,
    }));

  const axisKeys = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row.axes)) axisKeys.add(key);
  }
  const axes: MatrixAxis[] = [];
  for (const field of variantCapableFields(schema)) {
    if (!axisKeys.has(field.key)) continue;
    const values = [];
    const seen = new Set<string>();
    for (const row of rows) {
      for (const entry of row.axes[field.key] ?? []) {
        const marker = JSON.stringify(entry);
        if (seen.has(marker)) continue;
        seen.add(marker);
        values.push(entry);
      }
    }
    axes.push({ attributeKey: field.key, values });
  }

  return {
    title: draft.title ?? "",
    description: draft.description ?? "",
    tags: draft.tags,
    selectedCanonicalProductId: draft.selectedCanonicalProductId,
    productEntries,
    axes,
    rows: rows.length > 0 ? rows : [singleVariantRow(DEFAULT_DRAFT_CURRENCY)],
  };
}

/* -------------------------------------------------------------------------- */
/* The patch                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The body one save sends.
 *
 * Every product-scope field the schema declares is named, including the ones
 * with no answer — that is what makes CLEARING a field expressible, since an
 * unnamed field is untouched and a named one with an empty list is emptied. A
 * variant-scope field is never sent at the product level; the server refuses it
 * outright and the axes travel inside the rows.
 */
export function composePatch(
  form: WizardFormState,
  schema: AuthoringSchema,
  version: number,
): PatchDraftPayload {
  const fields: DraftFieldPayload[] = [];
  for (const field of productScopeFields(schema)) {
    fields.push(composeFieldPayload(field, form.productEntries[field.key] ?? []));
  }
  return {
    version,
    title: form.title.trim().length === 0 ? null : form.title.trim(),
    description: form.description.trim().length === 0 ? null : form.description.trim(),
    tags: form.tags,
    selectedCanonicalProductId: form.selectedCanonicalProductId,
    fields,
    variants: enabledVariantPayloads(form.rows, fieldsByKey(schema)),
  };
}

/* -------------------------------------------------------------------------- */
/* Completeness                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How far through one step the author is.
 *
 * `blocked` counts the things that would stop a publish; `total` is what the
 * step asks for at all. Both are reported so a step can say "3 of 7" rather
 * than only "incomplete" — a bare boolean tells somebody they are not finished
 * and not how far off they are.
 */
export interface StepCompleteness {
  readonly answered: number;
  readonly total: number;
  readonly blocked: number;
}

const EMPTY: StepCompleteness = { answered: 0, total: 0, blocked: 0 };

/** Whether a step has nothing outstanding. */
export function isStepComplete(completeness: StepCompleteness): boolean {
  return completeness.blocked === 0;
}

export function stepCompleteness(
  step: WizardStepId,
  form: WizardFormState,
  schema: AuthoringSchema,
): StepCompleteness {
  switch (step) {
    case "classification":
      // The category and the product type are PINNED on the draft, so this step
      // is complete the moment the draft exists. It stays a step because it is
      // what the author reads back to check they picked the right regional
      // model, and because the canonical selection lives beside it.
      return { answered: 1, total: 1, blocked: 0 };
    case "details":
      return detailsCompleteness(form, schema);
    case "variants":
      return variantsCompleteness(form, schema);
    case "pricing":
      return pricingCompleteness(form);
    case "listing": {
      const answered =
        (form.title.trim().length > 0 ? 1 : 0) + (form.description.trim().length > 0 ? 1 : 0);
      return { answered, total: 2, blocked: 2 - answered };
    }
    case "review":
    default:
      return EMPTY;
  }
}

function detailsCompleteness(form: WizardFormState, schema: AuthoringSchema): StepCompleteness {
  const requirements = effectiveRequirements(schema, form.productEntries);
  let answered = 0;
  let total = 0;
  let blocked = 0;
  for (const field of productScopeFields(schema)) {
    const requirement = requirements.get(field.key) ?? field.requirement;
    if (!isVisible(requirement)) continue;
    total += 1;
    const filled = hasAnswer(form.productEntries[field.key]);
    if (filled) answered += 1;
    else if (requirement === "required") blocked += 1;
  }
  return { answered, total, blocked };
}

function variantsCompleteness(form: WizardFormState, schema: AuthoringSchema): StepCompleteness {
  const byKey = fieldsByKey(schema);
  const valueStrings = controlledValueStrings(schema);
  const enabled = form.rows.filter((row) => row.enabled);
  const duplicates = duplicateRowKeys(form.rows, byKey, valueStrings);
  const required = variantCapableFields(schema).filter(
    (field) => field.requirement === "required",
  );

  let blocked = duplicates.size;
  if (enabled.length === 0) blocked += 1;
  let answered = 0;
  for (const row of enabled) {
    const missing = required.filter((field) => !hasAnswer(row.axes[field.key]));
    if (missing.length === 0) answered += 1;
    else blocked += 1;
  }
  return { answered, total: enabled.length, blocked };
}

function pricingCompleteness(form: WizardFormState): StepCompleteness {
  const enabled = form.rows.filter((row) => row.enabled);
  let answered = 0;
  for (const row of enabled) {
    if (toMinorUnits(row.priceMajor, row.currency) !== null) answered += 1;
  }
  return { answered, total: enabled.length, blocked: enabled.length - answered };
}

/**
 * A signature of the whole form, for change detection.
 *
 * The PATCH is what is compared, not the form: two states that produce the same
 * body are the same save, and an author who typed a space and deleted it should
 * not cost a request. The dedupe key of each row goes in too, because an axis
 * reorder changes the payload's order without changing what it says.
 */
export function formSignature(
  form: WizardFormState,
  schema: AuthoringSchema,
  version: number,
): string {
  const patch = composePatch(form, schema, version);
  const rowKeys = form.rows
    .filter((row) => row.enabled)
    .map((row) => axisDedupeKey(row.axes, fieldsByKey(schema), controlledValueStrings(schema)));
  return JSON.stringify({ ...patch, version: 0, rowKeys });
}
