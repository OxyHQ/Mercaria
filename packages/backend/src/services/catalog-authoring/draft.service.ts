/**
 * Drafts (#367 step 5, ADR 0007 D10) — create, resume, autosave, validate and
 * preview an upgrade.
 *
 * ## Everything a draft pins is written ONCE, at creation
 *
 * The category, the exact product-type version, the locale, the market and — on
 * every answer — the exact attribute definition version. A patch may move
 * answers and never a pin: `updateDraftIfVersion` has no column for one, and
 * re-pinning is {@link previewDraftUpgrade}'s explicit, separate act. That is
 * ADR 0007 D5's "a newer version never silently reinterprets an older record"
 * expressed as a function signature rather than as care taken by a caller.
 *
 * ## Autosave is a PATCH of what was sent, not of what was omitted
 *
 * `fields` names the fields whose answers are being replaced. A field that is
 * not named is untouched; a field named with an empty list is CLEARED. Those are
 * different requests and the distinction is load-bearing: a wizard saving one
 * section must not clear the four the author has not opened yet, and an author
 * emptying a box must not be told it saved when it did not.
 *
 * ## What this module cannot do
 *
 * It cannot publish (that is `publish.service.ts`, one transaction), it cannot
 * match (a directly selected canonical entity is never re-matched, D10) and it
 * cannot reach a money domain — `catalog-authoring-isolation.test.ts` fails the
 * build on any of the three.
 */

import {
  type AttributeComponentAxis,
  type AuthoringCanonicalRefKind,
  type AuthoringDraft,
  type AuthoringDraftStatus,
  type AuthoringDraftValue,
  type AuthoringDraftVariant,
  type AuthoringSchema,
  type AuthoringPermissionContext,
  type AuthoringUpgradePreview,
  type AuthoringValidationResult,
  type CurrencyCode,
  type ProductTypeAuthoringFlow,
} from '@mercaria/shared-types';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import type { Database, DatabaseOrTransaction } from '../../db/postgres.js';
import {
  discardDraft,
  findDraft,
  insertDraft,
  insertVariantScopeValues,
  listDraftValues,
  listDraftVariants,
  listDrafts,
  replaceDraftVariants,
  replaceProductScopeValues,
  repinDraftIfVersion,
  updateDraftIfVersion,
  type CatalogAuthoringDraftRow,
  type CatalogAuthoringDraftValueRow,
  type CatalogAuthoringDraftVariantRow,
  type NewDraftValue,
  type NewDraftVariant,
} from '../../db/catalogAuthoring/draftRepository.js';
import {
  findCategoryRow,
  findPublishedVersionForKey,
  productTypeIsScopedToCategory,
} from '../../db/catalogAuthoring/schemaSourceRepository.js';
import { listProductTypeFields } from '../../db/productTypes/productTypeFieldRepository.js';
import { findProductTypeDefinitionById } from '../../db/productTypes/productTypeRepository.js';
import {
  defaultTypedVariantSignature,
  normalizeAxisValue,
  typedVariantSignature,
} from '../variant-axes/signature.js';
import {
  composeAuthoringSchema,
  composeAuthoringSchemaForDefinitionId,
  type AuthoringSchemaComposition,
} from './schema.service.js';
import { validateDraft, type DraftValueForValidation } from './validation.js';
import { identifierCollisionFindings } from './identifier-collision.js';
import { compareProductTypeVersionFields } from './version-upgrade.js';
// #367 step 6 (ADR 0007 D9). The ONE edge from authoring INTO the proposal
// domain, and it points this way deliberately: a proposal is a request ABOUT a
// draft, so the proposal domain reads authoring and never the reverse.
import { listOpenProposalsBlockingDraft } from '../../db/catalogProposals/proposalRepository.js';
import {
  decidePendingProposalPublication,
  pendingProposalFindings,
  withProposalFindings,
} from '../catalog-proposals/publication-gate.js';

/** One answer a client sends. Exactly one value member is populated. */
export interface DraftAnswerInput {
  readonly ordinal?: number;
  readonly componentAxis?: AttributeComponentAxis;
  readonly text?: string;
  readonly number?: number;
  readonly boolean?: boolean;
  readonly enumValueId?: string;
  readonly canonicalRef?: { readonly kind: AuthoringCanonicalRefKind; readonly id: string };
  readonly unit?: string;
}

/** The answers for one field. An empty `values` CLEARS the field. */
export interface DraftFieldInput {
  readonly attributeKey: string;
  readonly values: readonly DraftAnswerInput[];
}

/** One variant a client sends, with its axis answers inline. */
export interface DraftVariantInput {
  readonly title?: string;
  readonly sku?: string;
  readonly barcode?: string;
  readonly price?: { readonly amount: number; readonly currency: CurrencyCode };
  readonly compareAtPrice?: { readonly amount: number; readonly currency: CurrencyCode };
  readonly inventoryTracked?: boolean;
  readonly inventoryAvailable: number;
  readonly axes: readonly DraftFieldInput[];
  /** The canonical configuration the author chose for this variant (D10). */
  readonly selectedCanonicalVariantId?: string | null;
}

export interface CreateDraftInput {
  readonly storeId: string;
  readonly actorOxyUserId: string;
  readonly categoryId: string;
  readonly productTypeKey: string;
  readonly version?: number;
  readonly flow: ProductTypeAuthoringFlow;
  readonly locale: string;
  readonly market: string;
  readonly permissions: AuthoringPermissionContext;
  readonly ttlSeconds: number;
  readonly title?: string;
  readonly description?: string;
}

export interface PatchDraftInput {
  readonly storeId: string;
  readonly draftId: string;
  readonly expectedVersion: number;
  readonly permissions: AuthoringPermissionContext;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly imageFileIds?: readonly string[];
  readonly tags?: readonly string[];
  readonly selectedCanonicalProductId?: string | null;
  readonly fields?: readonly DraftFieldInput[];
  readonly variants?: readonly DraftVariantInput[];
}

/**
 * Turn a composition refusal into the HTTP-shaped error the surface answers.
 *
 * One place, so a refusal cannot acquire two spellings. `category_not_found` and
 * `product_type_not_found` are 404s; the three that mean "this combination is
 * not permitted" are 400s, because the caller supplied a pair that is real and
 * ineligible rather than one that does not exist.
 */
function throwComposition(composition: AuthoringSchemaComposition): never {
  if (composition.outcome === 'composed') {
    throw new Error('throwComposition called on a successful composition');
  }
  if (
    composition.refusal === 'category_not_found' ||
    composition.refusal === 'product_type_not_found'
  ) {
    throw notFound(composition.detail);
  }
  throw validationError(composition.detail);
}

function requireComposed(composition: AuthoringSchemaComposition): AuthoringSchema {
  if (composition.outcome !== 'composed') throwComposition(composition);
  return composition.schema;
}

/**
 * Start a draft.
 *
 * The schema is composed FIRST and refused before a row is written, so a draft
 * whose category is not selectable, whose product type is not scoped to it, or
 * whose flow declares no field never exists — rather than existing and failing
 * every subsequent validation with an author's answers already in it.
 *
 * A new draft may only start on a PUBLISHED version. A draft or in-review
 * schema is still being argued about, and its fields can change under an author
 * who has already answered them; pinning one would create exactly the record ADR
 * 0007 D5's freeze exists to make impossible.
 *
 * `composeAuthoringSchema` now refuses an EDITABLE version to every caller —
 * `RETRIEVABLE_AUTHORING_LIFECYCLES` — so the check below is reachable only for
 * a `deprecated` version, which composes (records pin it) and may not be started
 * on. It is kept rather than narrowed to `deprecated`, because a check that
 * states the whole rule cannot be walked around by a later change to what the
 * composition serves.
 */
export async function createDraft(db: Database, input: CreateDraftInput): Promise<AuthoringDraft> {
  const composition = await composeAuthoringSchema(db, {
    productTypeKey: input.productTypeKey,
    ...(input.version === undefined ? {} : { version: input.version }),
    categoryId: input.categoryId,
    flow: input.flow,
    requestedLocale: input.locale,
    market: input.market,
    permissions: input.permissions,
  });
  const schema = requireComposed(composition);
  if (schema.productType.lifecycle !== 'published') {
    throw validationError(
      `${schema.productType.key} v${schema.productType.version} is ${schema.productType.lifecycle}; a draft may only start on a published version.`,
    );
  }

  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1_000);
  const row = await db.transaction(async (tx) =>
    insertDraft(tx, {
      storeId: input.storeId,
      createdByOxyUserId: input.actorOxyUserId,
      categoryId: input.categoryId,
      productTypeDefinitionId: schema.productType.definitionId,
      flow: input.flow,
      locale: schema.locale.requestedLocale,
      market: input.market,
      schemaHash: schema.etag,
      schemaSnapshot: schema,
      expiresAt,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
    }),
  );
  return hydrateDraft(db, row);
}

/** One draft, whole. 404 rather than 403 for another store's — see the header. */
export async function readDraft(
  db: DatabaseOrTransaction,
  storeId: string,
  draftId: string,
): Promise<AuthoringDraft> {
  const row = await findDraft(db, storeId, draftId);
  if (row === null) throw notFound('No such draft.');
  return hydrateDraft(db, row);
}

/** A store's drafts. */
export async function listStoreDrafts(
  db: DatabaseOrTransaction,
  storeId: string,
  options: { status?: AuthoringDraftStatus; limit: number; offset: number },
): Promise<AuthoringDraft[]> {
  const rows = await listDrafts(db, storeId, options);
  const drafts: AuthoringDraft[] = [];
  for (const row of rows) drafts.push(await hydrateDraft(db, row));
  return drafts;
}

/**
 * Apply a patch.
 *
 * ONE transaction covering the header CAS, the values and the variants — because
 * a variant matrix and the axis answers that identify its rows are one fact, and
 * committing half of it leaves a draft whose variants have no axes and whose
 * signature index no longer describes anything.
 *
 * The header CAS runs FIRST and its failure aborts before anything else is
 * written, so a stale caller's answers never land.
 */
export async function patchDraft(db: Database, input: PatchDraftInput): Promise<AuthoringDraft> {
  const existing = await findDraft(db, input.storeId, input.draftId);
  if (existing === null) throw notFound('No such draft.');
  if (existing.status !== 'open') {
    throw conflict('This draft has already been published or discarded and can no longer be edited.');
  }

  const schema = requireComposed(
    await composeAuthoringSchemaForDefinitionId(db, existing.productTypeDefinitionId, {
      categoryId: existing.categoryId,
      flow: existing.flow,
      requestedLocale: existing.locale,
      market: existing.market,
      permissions: input.permissions,
    }),
  );

  const updated = await db.transaction(async (tx) => {
    const header = await updateDraftIfVersion(
      tx,
      input.storeId,
      input.draftId,
      input.expectedVersion,
      {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.imageFileIds === undefined ? {} : { imageFileIds: input.imageFileIds }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(input.selectedCanonicalProductId === undefined
          ? {}
          : { selectedCanonicalProductId: input.selectedCanonicalProductId }),
      },
    );
    if (header === null) {
      // The empty result set IS the answer. `updateDraftIfVersion`'s predicate
      // carries the id, the store, the status and the version, so this covers a
      // stale token and a draft that closed underneath the caller alike — and
      // the message names the remedy for both.
      throw conflict(
        `This draft changed while you were editing it. Re-read it and re-apply your changes (you sent version ${input.expectedVersion}).`,
      );
    }

    if (input.fields !== undefined) {
      const { fieldIds, values } = mapProductScopeValues(schema, input.fields);
      await replaceProductScopeValues(tx, input.draftId, fieldIds, values);
    }

    if (input.variants !== undefined) {
      const prepared = prepareVariants(schema, input.variants);
      const inserted = await replaceDraftVariants(tx, input.draftId, prepared.variants);
      const variantValues: NewDraftValue[] = [];
      inserted.forEach((row, index) => {
        for (const value of prepared.axesByPosition[index] ?? []) {
          variantValues.push({ ...value, draftVariantId: row.id });
        }
      });
      await insertVariantScopeValues(tx, input.draftId, variantValues);
    }

    return header;
  });

  return hydrateDraft(db, updated);
}

/** Discard an open draft. */
export async function discardStoreDraft(
  db: Database,
  storeId: string,
  draftId: string,
  expectedVersion: number,
): Promise<AuthoringDraft> {
  const row = await discardDraft(db, storeId, draftId, expectedVersion);
  if (row === null) {
    throw conflict('This draft is not open, or it changed while you were reading it.');
  }
  return hydrateDraft(db, row);
}

/** Validate a draft against the schema it is pinned to. */
export async function validateStoreDraft(
  db: DatabaseOrTransaction,
  input: {
    storeId: string;
    draftId: string;
    permissions: AuthoringPermissionContext;
  },
): Promise<AuthoringValidationResult> {
  const row = await findDraft(db, input.storeId, input.draftId);
  if (row === null) throw notFound('No such draft.');
  const schema = requireComposed(
    await composeAuthoringSchemaForDefinitionId(db, row.productTypeDefinitionId, {
      categoryId: row.categoryId,
      flow: row.flow,
      requestedLocale: row.locale,
      market: row.market,
      permissions: input.permissions,
    }),
  );
  return validateDraftRow(db, row, schema);
}

/**
 * The validation both the `validate` route and the publish path run.
 *
 * ONE function, called from both, so "what does validate say" and "what does
 * publish enforce" cannot answer differently — the two-spellings-of-one-rule
 * failure `order-buyer-claim` names one domain over. The category checks are
 * re-read here rather than taken from the composition, because a composition
 * REFUSES an ineligible pair while a validation must REPORT one: a draft whose
 * category was made non-selectable after it started still has to be readable and
 * fixable.
 */
export async function validateDraftRow(
  db: DatabaseOrTransaction,
  row: CatalogAuthoringDraftRow,
  schema: AuthoringSchema,
): Promise<AuthoringValidationResult> {
  const [category, inScope, variants, values, blocking] = await Promise.all([
    findCategoryRow(db, row.categoryId),
    productTypeIsScopedToCategory(db, row.productTypeDefinitionId, row.categoryId),
    listDraftVariants(db, row.id),
    listDraftValues(db, row.id),
    listOpenProposalsBlockingDraft(db, row.id),
  ]);

  // Sequential after the batch above rather than inside it, because it reads the
  // barcodes the variants carry. It issues NO statement at all for a draft that
  // named no canonical product or stated no well-formed barcode, which is the
  // ordinary case — see `identifierCollisionFindings`.
  const collisions = await identifierCollisionFindings(db, {
    selectedCanonicalProductId: row.selectedCanonicalProductId,
    variants: variants.map((variant) => ({
      position: variant.position,
      barcode: variant.barcode,
    })),
  });

  const result = validateDraft({
    schema,
    draftSchemaHash: row.schemaHash,
    status: row.status,
    title: row.title,
    description: row.description,
    // The DRAFT's flow, not `schema.flow`: a composition takes a flow as an
    // argument, so reading it off the composition would make "must this state a
    // condition" a property of how somebody asked (#572).
    flow: row.flow,
    itemConditionKey: row.itemConditionKey,
    imageFileIds: row.imageFileIds,
    categorySelectable: category?.selectable ?? false,
    categoryInScope: inScope,
    variants: variants.map((variant) => ({
      id: variant.id,
      position: variant.position,
      priceAmount: variant.priceAmount,
      priceCurrency: variant.priceCurrency,
      inventoryAvailable: variant.inventoryAvailable,
      axisSignature: variant.axisSignature,
      sku: variant.sku,
      barcode: variant.barcode,
    })),
    values: values.map(toValidationValue),
  });

  // ADR 0007 D9's pending-proposal rule (#367 step 6), merged in HERE rather
  // than inside `validateDraft` — which is PURE and takes no database, while
  // "is a proposal still open" is a read. The decision itself is made by
  // `decidePendingProposalPublication` from the product type VERSION's own
  // `pendingProposalPolicy`, so it stays versioned and reviewable rather than a
  // per-request choice, and `withProposalFindings` owns the one recomputation of
  // `publishable` so no call site re-derives it.
  //
  // This is the producer the note at the foot of `validation.ts` names: both
  // codes were in the closed set and produced by nothing, because until
  // `catalog_proposals` existed a value that is "still a proposal" had no
  // representation.
  //
  // The identifier COLLISION is merged through the same call and for the same
  // reason: "is this barcode already somebody else's" is a read, so it cannot
  // live in `validateDraft`. `withProposalFindings` is reused rather than
  // duplicated — its body is a generic merge plus the ONE recomputation of
  // `publishable`, and a second function doing that would be two answers to
  // whether a draft may publish. Its NAME is the proposal caller's historic
  // one and now under-describes what it merges; renaming it belongs in a diff
  // that owns `services/catalog-proposals/`, not this one (its call sites
  // include a `vi.mock` keyed on the string, where a half-done rename stops
  // mocking silently).
  return withProposalFindings(result, [
    ...pendingProposalFindings(
      decidePendingProposalPublication({
        pendingProposalPolicy: schema.productType.pendingProposalPolicy,
        openProposalIds: blocking.map((entry) => entry.proposalId),
      }),
    ),
    ...collisions,
  ]);
}

function toValidationValue(row: CatalogAuthoringDraftValueRow): DraftValueForValidation {
  return {
    fieldId: row.fieldId,
    attributeKey: row.attributeKey,
    draftVariantId: row.draftVariantId,
    ordinal: row.ordinal,
    componentAxis: row.componentAxis,
    kind: row.kind,
    valueText: row.valueText,
    valueNumber: row.valueNumber,
    valueBoolean: row.valueBoolean,
    valueEnumValueId: row.valueEnumValueId,
    canonicalRefId: row.canonicalRefId,
    unit: row.unit,
  };
}

/* -------------------------------------------------------------------------- */
/* The upgrade preview                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What moving this draft to the current published version would do.
 *
 * A DESCRIPTION and nothing else — ADR 0007 D10 is explicit that a newer schema
 * version produces a preview, never a silent rewrite. Applying it is
 * {@link applyDraftUpgrade}, a separate request that re-pins the draft and
 * bumps its version, so an autosave can never carry one.
 *
 * The comparison is per (flow, attribute key), which is the grain a
 * `product_type_fields` row actually has. Comparing by field ID would report
 * every field as removed and re-added, because a new version's rows are new
 * rows — the comparison would be true and useless.
 */
export async function previewDraftUpgrade(
  db: DatabaseOrTransaction,
  storeId: string,
  draftId: string,
): Promise<AuthoringUpgradePreview> {
  const row = await findDraft(db, storeId, draftId);
  if (row === null) throw notFound('No such draft.');

  const current = await findProductTypeDefinitionById(db, row.productTypeDefinitionId);
  if (current === null) throw notFound('The product type version this draft pins no longer exists.');

  const published = await findPublishedVersionForKey(db, current.key);
  if (published === null || published.id === current.id) {
    return { outcome: 'up_to_date', currentVersion: current.version };
  }

  const [currentFields, targetFields, values] = await Promise.all([
    listProductTypeFields(db, current.id, row.flow),
    listProductTypeFields(db, published.id, row.flow),
    listDraftValues(db, row.id),
  ]);

  // The SAME comparison a published LISTING runs (#587). Extracted rather than
  // copied: a draft and a listing ask one question of one pair of field sets,
  // and two statements of that rule drift in the flattering direction — a
  // preview that under-reports reads as a safe upgrade.
  const { changes, losesAnswers } = compareProductTypeVersionFields(
    currentFields,
    targetFields,
    new Set(values.map((value) => value.attributeKey)),
  );

  return {
    outcome: 'upgrade_available',
    currentVersion: current.version,
    targetVersion: published.version,
    targetDefinitionId: published.id,
    changes,
    losesAnswers,
  };
}

/**
 * Re-pin a draft to the current published version, after the author saw the
 * preview.
 *
 * The answers are NOT rewritten and NOT dropped. Every value keeps the attribute
 * version it was given under, so an answer whose field the new version removed
 * survives as an `unknown_field` finding the author can see and clear — which is
 * the honest state. Deleting them here would be the silent rewrite D10 forbids,
 * wearing a tidy-up's clothes.
 */
export async function applyDraftUpgrade(
  db: Database,
  input: {
    storeId: string;
    draftId: string;
    expectedVersion: number;
    targetDefinitionId: string;
    permissions: AuthoringPermissionContext;
  },
): Promise<AuthoringDraft> {
  const row = await findDraft(db, input.storeId, input.draftId);
  if (row === null) throw notFound('No such draft.');

  const schema = requireComposed(
    await composeAuthoringSchemaForDefinitionId(db, input.targetDefinitionId, {
      categoryId: row.categoryId,
      flow: row.flow,
      requestedLocale: row.locale,
      market: row.market,
      permissions: input.permissions,
    }),
  );

  const updated = await repinDraftIfVersion(db, input.storeId, input.draftId, input.expectedVersion, {
    productTypeDefinitionId: schema.productType.definitionId,
    schemaHash: schema.etag,
    schemaSnapshot: schema,
  });
  if (updated === null) {
    throw conflict('This draft is not open, or it changed while you were reading it.');
  }
  return hydrateDraft(db, updated);
}

/* -------------------------------------------------------------------------- */
/* Mapping a client's answers onto typed rows                                  */
/* -------------------------------------------------------------------------- */

/**
 * The value kind one answer carries, derived from the answer ITSELF.
 *
 * Derived rather than declared by the client, and that is the point: a client
 * that could name a kind could name one the field's type does not admit, and the
 * mismatch would be stored and only refused at validation. Here an answer whose
 * shape does not match the field is refused at the WRITE, with the attribute
 * named.
 */
function kindOf(answer: DraftAnswerInput, attributeKey: string): NewDraftValue['kind'] {
  const populated = [
    answer.text === undefined ? null : 'text',
    answer.number === undefined ? null : 'number',
    answer.boolean === undefined ? null : 'boolean',
    answer.enumValueId === undefined ? null : 'controlled_value',
    answer.canonicalRef === undefined ? null : 'canonical_reference',
  ].filter((entry): entry is NewDraftValue['kind'] => entry !== null);
  if (populated.length !== 1) {
    throw validationError(
      `Each answer for "${attributeKey}" carries exactly one value; this one carries ${populated.length}.`,
    );
  }
  const [kind] = populated;
  if (kind === undefined) {
    throw validationError(`Each answer for "${attributeKey}" carries exactly one value.`);
  }
  return kind;
}

/**
 * The string an axis signature is computed over — #367 step 4's spelling, not a
 * second one.
 *
 * For a controlled value this is the enum value's CANONICAL VALUE STRING, which
 * is what `native_variant_axis_assignments.normalized_value` stores; the
 * `enumValueId` travels beside it in its own column. Hashing the id instead
 * would give a draft and the variant it publishes into two different digests for
 * one set of axes, which is exactly the two-representations failure the shared
 * signature exists to remove — and it is why `typedVariantSignature` asserts
 * rather than folds: a caller that stored the raw value and hashed the folded
 * one produces a row nothing can recompute.
 *
 * `attribute_enum_values.value` is already `lower(btrim(...))` by CHECK, so
 * folding it again is a no-op that keeps the assertion honest for the scalar
 * branches, which are not.
 */
function normalizedAxisValue(
  answer: DraftAnswerInput,
  valueStringById: ReadonlyMap<string, string>,
): string {
  if (answer.enumValueId !== undefined) {
    return normalizeAxisValue(valueStringById.get(answer.enumValueId) ?? answer.enumValueId);
  }
  if (answer.canonicalRef !== undefined) return normalizeAxisValue(answer.canonicalRef.id);
  if (answer.text !== undefined) return normalizeAxisValue(answer.text);
  if (answer.number !== undefined) return normalizeAxisValue(String(answer.number));
  if (answer.boolean !== undefined) return answer.boolean ? 'true' : 'false';
  return '';
}

function toDraftValue(
  field: AuthoringSchema['fields'][number],
  answer: DraftAnswerInput,
  index: number,
): NewDraftValue {
  const kind = kindOf(answer, field.key);
  return {
    draftVariantId: null,
    fieldId: field.id,
    attributeDefinitionId: field.attributeDefinitionId,
    attributeKey: field.key,
    attributeDefinitionVersion: field.attributeVersion,
    scope: field.scope,
    ordinal: answer.ordinal ?? index,
    componentAxis: answer.componentAxis ?? null,
    kind,
    valueText: answer.text ?? null,
    valueNumber: answer.number ?? null,
    valueBoolean: answer.boolean ?? null,
    valueEnumValueId: answer.enumValueId ?? null,
    canonicalRefKind: answer.canonicalRef?.kind ?? null,
    canonicalRefId: answer.canonicalRef?.id ?? null,
    unit: answer.unit ?? null,
  };
}

function mapProductScopeValues(
  schema: AuthoringSchema,
  fields: readonly DraftFieldInput[],
): { fieldIds: string[]; values: NewDraftValue[] } {
  const byKey = new Map(schema.fields.map((field) => [field.key, field]));
  const fieldIds: string[] = [];
  const values: NewDraftValue[] = [];
  for (const input of fields) {
    const field = byKey.get(input.attributeKey);
    if (field === undefined) {
      throw validationError(
        `"${input.attributeKey}" is not a field of ${schema.productType.key} v${schema.productType.version} in the "${schema.flow}" flow.`,
      );
    }
    if (field.scope === 'variant') {
      throw validationError(
        `"${input.attributeKey}" is a variant-scope field; send it inside a variant rather than at the product level.`,
      );
    }
    fieldIds.push(field.id);
    input.values.forEach((answer, index) => values.push(toDraftValue(field, answer, index)));
  }
  return { fieldIds, values };
}

/**
 * Turn a client's variant list into rows plus their axis answers.
 *
 * The signature is computed HERE, from the axes as sent, so the partial unique
 * on `(draft_id, axis_signature)` is what refuses a duplicate rather than a
 * comparison a service could get wrong. Two variants whose axes were entered in
 * different orders produce the same digest by construction (ADR 0007 D6).
 */
function prepareVariants(
  schema: AuthoringSchema,
  variants: readonly DraftVariantInput[],
): { variants: NewDraftVariant[]; axesByPosition: NewDraftValue[][] } {
  const byKey = new Map(schema.fields.map((field) => [field.key, field]));
  // Every controlled value's canonical STRING, which is what the shared
  // signature hashes. Built once for the whole matrix rather than per axis.
  const valueStringById = new Map<string, string>();
  for (const field of schema.fields) {
    for (const controlled of field.controlledValues) {
      valueStringById.set(controlled.id, controlled.value);
    }
  }
  const rows: NewDraftVariant[] = [];
  const axesByPosition: NewDraftValue[][] = [];

  variants.forEach((variant, position) => {
    const axisValues: NewDraftValue[] = [];
    const signaturePairs: { attributeDefinitionId: string; normalizedValue: string }[] = [];

    for (const axis of variant.axes) {
      const field = byKey.get(axis.attributeKey);
      if (field === undefined) {
        throw validationError(
          `"${axis.attributeKey}" is not a field of ${schema.productType.key} v${schema.productType.version} in the "${schema.flow}" flow.`,
        );
      }
      if (!field.variantCapable) {
        // Refused at the WRITE and not only at validation, because the axis
        // signature this variant is deduplicated on would otherwise be computed
        // over an axis the product type never granted (ADR 0007 D6).
        throw validationError(
          `"${axis.attributeKey}" may not define variants of ${schema.productType.key} v${schema.productType.version}.`,
        );
      }
      axis.values.forEach((answer, index) => {
        axisValues.push({ ...toDraftValue(field, answer, index), draftVariantId: null });
        signaturePairs.push({
          attributeDefinitionId: field.attributeDefinitionId,
          normalizedValue: normalizedAxisValue(answer, valueStringById),
        });
      });
    }

    rows.push({
      position,
      title: variant.title ?? null,
      sku: nullIfEmpty(variant.sku),
      barcode: nullIfEmpty(variant.barcode),
      priceAmount: variant.price?.amount ?? null,
      priceCurrency: variant.price?.currency ?? null,
      compareAtPriceAmount: variant.compareAtPrice?.amount ?? null,
      compareAtPriceCurrency: variant.compareAtPrice?.currency ?? null,
      inventoryTracked: variant.inventoryTracked ?? true,
      inventoryAvailable: variant.inventoryAvailable,
      axisSignature: signatureFor(signaturePairs, position),
      selectedCanonicalVariantId: variant.selectedCanonicalVariantId ?? null,
    });
    axesByPosition.push(axisValues);
  });

  return { variants: rows, axesByPosition };
}

/**
 * The digest, through #367 step 4's own function.
 *
 * A zero-axis variant gets `defaultTypedVariantSignature()` rather than NULL —
 * step 4's ruling, and it is right here too: two variants that vary along
 * nothing are one variant, and a NULL would let a draft hold both and only
 * discover it at publish, when `native_variant_signatures_listing_signature_key`
 * refuses the second with a 23505 nothing can attribute.
 *
 * `typedVariantSignature` THROWS on a duplicate axis or an unnormalized value.
 * Those are refusals a merchant has to be able to act on, so they are translated
 * into a `validationError` naming the variant rather than reaching an HTTP 500.
 */
function signatureFor(
  pairs: readonly { attributeDefinitionId: string; normalizedValue: string }[],
  position: number,
): string {
  if (pairs.length === 0) return defaultTypedVariantSignature();
  try {
    return typedVariantSignature(pairs);
  } catch (err) {
    throw validationError(
      `Variant ${position + 1} cannot be identified by its axes: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * `''` becomes NULL.
 *
 * The rule `insertVariants` already applies one table over, for the reason
 * `CONVENTIONS.md` states: an empty string is a VALUE, so it collides for real
 * where a NULL does not, converting a non-problem into a live bug.
 */
function nullIfEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/* -------------------------------------------------------------------------- */
/* Hydration                                                                   */
/* -------------------------------------------------------------------------- */

function toDraftVariantDto(row: CatalogAuthoringDraftVariantRow): AuthoringDraftVariant {
  return {
    id: row.id,
    position: row.position,
    title: row.title,
    sku: row.sku,
    barcode: row.barcode,
    priceAmount: row.priceAmount,
    priceCurrency: row.priceCurrency,
    compareAtPriceAmount: row.compareAtPriceAmount,
    compareAtPriceCurrency: row.compareAtPriceCurrency,
    inventoryTracked: row.inventoryTracked,
    inventoryAvailable: row.inventoryAvailable,
    axisSignature: row.axisSignature,
    selectedCanonicalVariantId: row.selectedCanonicalVariantId,
  };
}

function toDraftValueDto(row: CatalogAuthoringDraftValueRow): AuthoringDraftValue {
  return {
    fieldId: row.fieldId,
    attributeKey: row.attributeKey,
    scope: row.scope,
    draftVariantId: row.draftVariantId,
    ordinal: row.ordinal,
    componentAxis: row.componentAxis,
    kind: row.kind,
    text: row.valueText,
    number: row.valueNumber,
    boolean: row.valueBoolean,
    enumValueId: row.valueEnumValueId,
    canonicalRefKind: row.canonicalRefKind,
    canonicalRefId: row.canonicalRefId,
    unit: row.unit,
  };
}

/** The DTO, composed from the row plus its two child sets. */
export async function hydrateDraft(
  db: DatabaseOrTransaction,
  row: CatalogAuthoringDraftRow,
): Promise<AuthoringDraft> {
  const [definition, variants, values] = await Promise.all([
    findProductTypeDefinitionById(db, row.productTypeDefinitionId),
    listDraftVariants(db, row.id),
    listDraftValues(db, row.id),
  ]);
  if (definition === null) {
    throw notFound('The product type version this draft pins no longer exists.');
  }

  return {
    id: row.id,
    storeId: row.storeId,
    status: row.status,
    categoryId: row.categoryId,
    productType: {
      definitionId: definition.id,
      key: definition.key,
      version: definition.version,
      lifecycle: definition.lifecycle,
      pendingProposalPolicy: definition.pendingProposalPolicy,
    },
    flow: row.flow,
    locale: row.locale,
    market: row.market,
    schemaEtag: row.schemaHash,
    version: row.version,
    title: row.title,
    description: row.description,
    imageFileIds: row.imageFileIds,
    tags: row.tags,
    selectedCanonicalProductId: row.selectedCanonicalProductId,
    publishedListingId: row.publishedListingId,
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    variants: variants.map(toDraftVariantDto),
    values: values.map(toDraftValueDto),
  };
}
