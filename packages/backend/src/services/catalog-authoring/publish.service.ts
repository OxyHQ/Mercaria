/**
 * Publication (#367 step 5, ADR 0007 D10) — ONE transaction.
 *
 * ```
 * listing + native variants + inventory + explicit canonical links
 *         + the offer-convergence outbox row + the draft's own stamp
 * ```
 *
 * A failed sub-write rolls the whole publish back. That is not a preference: the
 * two-statement version has a window in which a listing exists and the draft
 * that produced it does not know, and the retry a merchant then makes creates a
 * SECOND listing under the same handle — visible to nobody until they look at
 * their own catalogue.
 *
 * ## The listing is created by the SAME body the ordinary create uses
 *
 * `createStoreProductWithin` is `createStoreProduct`'s own resolution and insert,
 * with the transaction owned here. There is deliberately no second
 * product-creation path: a fourth writer of `listings` would have to re-derive
 * `published_at`, the condition columns, the facet defaults and the
 * handle-collision message, which is the divergence
 * `listing-publication-chokepoint.test.ts` exists to refuse.
 *
 * ## A directly selected canonical entity is LINKED and never re-matched
 *
 * ADR 0007 D10, and it is the reason `merchant_declared` is its own
 * `NativeListingLinkMethod`. The link is written HERE, in the same transaction,
 * with NULL confidence — a person chose, and a number beside that could only be
 * read as doubt about a fact nobody scored.
 *
 * `syncListingFacets` still requests a match for EVERY variant after the commit,
 * including the resolved ones, and that is deliberate: the evaluation writes a
 * `match_decisions` row, so "the matcher would have chosen something else" stays
 * readable — the same posture #91 chose for `seller_declared`. What must never
 * happen is the ATTACHMENT moving, and `MATCHER_MAY_DISPLACE` in
 * `services/matching/match.service.ts` is what stops it.
 *
 * That protection is named here because this header used to claim a different
 * one. It said `native_listing_links_active_variant_key` meant "an automatic
 * attachment can never displace a declared one", and the partial unique does not
 * say that: it forbids two SIMULTANEOUS active links, while `attachIfAutomatic`
 * supersedes the incumbent and inserts afterwards, so the index never sees a
 * conflict. Until `MATCHER_MAY_DISPLACE` landed, a merchant's explicit selection
 * WAS overruled by a confidence score — which is the failure D10 names, arrived
 * at through a comment that read like a proof.
 */

import { eq } from 'drizzle-orm';
import type {
  AuthoringDraft,
  AuthoringPublicationResult,
  AuthoringValidationResult,
  CreateStoreProductInput,
  CreateStoreProductVariantInput,
  ItemConditionKey,
  ListingOption,
} from '@mercaria/shared-types';
import { AUTHORING_DEFAULT_MERCHANT_CONDITION } from '../../db/schema/catalogAuthoring.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import type { Database, DatabaseOrTransaction } from '../../db/postgres.js';
import { nativeListingLinks } from '../../db/schema/offers.js';
import { productVariants } from '../../db/schema/catalog.js';
import {
  findDraft,
  findDraftByPublishIdempotencyKey,
  listDraftValues,
  listDraftVariants,
  lockDraftForPublish,
  markDraftPublished,
  type CatalogAuthoringDraftRow,
  type CatalogAuthoringDraftValueRow,
} from '../../db/catalogAuthoring/draftRepository.js';
import { findCategoryRow } from '../../db/catalogAuthoring/schemaSourceRepository.js';
import {
  canonicalVariantBelongsToProduct,
  resolveCanonicalProductSelection,
  resolveCanonicalVariantSelection,
} from '../../db/catalogAuthoring/canonicalSearchRepository.js';
import {
  createStoreProductWithin,
  finishStoreProductCreation,
} from '../catalog-write.service.js';
import { enqueueOfferConvergence } from '../../db/offers/offerOutboxRepository.js';
import {
  findVariantAttributeClaim,
  recordListingAttributeClaim,
  recordVariantAttributeClaim,
} from '../../db/variantAxes/attributeClaimRepository.js';
import {
  declareListingVariantAxes,
  writeVariantAxisValues,
  type VariantAxisValueInput,
} from '../variant-axes/variant-axes.service.js';
import { normalizeAxisValue } from '../variant-axes/signature.js';
import { hydrateDraft, validateDraftRow } from './draft.service.js';
import { recordPublicationAttempt } from './publication-observation.js';
import { composePublicationResult } from './publication-result.js';
import { composeAuthoringSchemaForDefinitionId } from './schema.service.js';
import type { AuthoringPermissionContext } from '@mercaria/shared-types';

/** The rule id every `merchant_declared` attachment records. */
export const MERCHANT_DECLARED_MATCH_RULE = 'authoring.merchant_declared';

export interface PublishDraftInput {
  readonly storeId: string;
  readonly draftId: string;
  readonly actorOxyUserId: string;
  readonly permissions: AuthoringPermissionContext;
  /** The caller's `Idempotency-Key` header, when it sent one. */
  readonly idempotencyKey: string | null;
}

/**
 * The outcome.
 *
 * A STRING discriminant, and the refused branch carries the findings rather than
 * a sentence: a client renders the same list it renders for `validate`, so a
 * refusal at publish and a refusal at validate look identical to an author
 * instead of being two different experiences of one rule.
 *
 * **`published` and `converged` are ONE branch, and that is the point of #577.**
 * A convergence is a retry whose first response was lost, and it must answer
 * with everything the original did or the safe client behaviour becomes the one
 * that loses information. Two branches carrying different fields would let that
 * happen quietly; one branch makes it a type error. What separates them is the
 * `outcome` string and the status code, not the shape.
 */
export type DraftPublication =
  | {
      readonly outcome: 'published' | 'converged';
      readonly listingId: string;
      readonly draft: AuthoringDraft;
      /** #367 step 5: created ids and any pending review/matching state. */
      readonly publication: AuthoringPublicationResult;
    }
  | { readonly outcome: 'refused'; readonly validation: AuthoringValidationResult };

/**
 * What `settlePublication` decided, before the response is composed.
 *
 * The draft ROW rather than the hydrated draft, because the publication result
 * and the hydration are both derived from it and neither should re-read it.
 */
type SettledPublication =
  | { readonly refused: AuthoringValidationResult }
  | {
      readonly outcome: 'published' | 'converged';
      readonly listingId: string;
      readonly draft: CatalogAuthoringDraftRow;
    };

/**
 * Publish a draft.
 *
 * ## Idempotency, in the order the checks have to run
 *
 * 1. A draft ALREADY published converges on its own listing, whatever key the
 *    caller sent. That is the case a retrying client actually hits, and
 *    answering it with a 409 would make the safe client behaviour — retry a
 *    request whose response was lost — the one that breaks.
 * 2. A key that already published a DIFFERENT draft converges on that one. The
 *    partial unique `catalog_authoring_drafts_idempotency_key` is what makes it
 *    true rather than likely; this read is what lets the answer be the listing
 *    instead of a 23505.
 * 3. Otherwise the row is LOCKED for the duration, so a second publish arriving
 *    mid-way waits rather than composing a schema against a state that has since
 *    changed.
 */
export async function publishDraft(
  db: Database,
  input: PublishDraftInput,
): Promise<DraftPublication> {
  const settled = await settlePublication(db, input);
  if ('refused' in settled) return { outcome: 'refused', validation: settled.refused };

  if (settled.outcome === 'published') {
    // Every recompute the ordinary create runs, in the same order, AFTER the
    // commit. Each is idempotent and each opens its own connection or enqueues
    // work, so running one inside would have the transaction wait on a writer
    // waiting on it (#59's merge-runner deadlock, one domain over).
    await finishStoreProductCreation(input.storeId, settled.listingId);
    log.general.info(
      { draftId: input.draftId, listingId: settled.listingId, storeId: input.storeId },
      'Published a catalog authoring draft',
    );
  }

  // The ONE composition site, which is what makes a convergence answer
  // identically to a publication rather than by anybody remembering to. A fourth
  // way of settling can only reach a caller through here.
  const [draft, publication] = await Promise.all([
    hydrateDraft(db, settled.draft),
    composePublicationResult(db, {
      draft: settled.draft,
      listingId: settled.listingId,
      outcome: settled.outcome,
    }),
  ]);
  return { outcome: settled.outcome, listingId: settled.listingId, draft, publication };
}

/** Publish, converge or refuse — everything up to the response being composed. */
async function settlePublication(
  db: Database,
  input: PublishDraftInput,
): Promise<SettledPublication> {
  const existing = await findDraft(db, input.storeId, input.draftId);
  if (existing === null) throw notFound('No such draft.');
  if (existing.status === 'published' && existing.publishedListingId !== null) {
    return { outcome: 'converged', listingId: existing.publishedListingId, draft: existing };
  }
  if (existing.status !== 'open') {
    throw conflict('This draft has been discarded and can no longer be published.');
  }
  if (input.idempotencyKey !== null) {
    const prior = await findDraftByPublishIdempotencyKey(db, input.storeId, input.idempotencyKey);
    if (prior !== null && prior.publishedListingId !== null) {
      return { outcome: 'converged', listingId: prior.publishedListingId, draft: prior };
    }
  }

  const result = await db.transaction(async (tx) => {
    const draft = await lockDraftForPublish(tx, input.storeId, input.draftId);
    if (draft === null) throw notFound('No such draft.');
    if (draft.status === 'published' && draft.publishedListingId !== null) {
      // Somebody else published it between the read above and the lock. The
      // empty-ish answer IS the convergence, and it costs one round trip rather
      // than a duplicate listing.
      return { converged: draft.publishedListingId, draft };
    }
    if (draft.status !== 'open') {
      throw conflict('This draft has been discarded and can no longer be published.');
    }

    const composition = await composeAuthoringSchemaForDefinitionId(
      tx,
      draft.productTypeDefinitionId,
      {
        categoryId: draft.categoryId,
        flow: draft.flow,
        requestedLocale: draft.locale,
        market: draft.market,
        permissions: input.permissions,
      },
    );
    if (composition.outcome !== 'composed') {
      // A composition refusal at publish time means the category or the version
      // moved under an open draft. It is reported as a VALIDATION result rather
      // than as an exception, so the author sees it in the same list as every
      // other finding — and `validateDraftRow` produces exactly those codes.
      throw validationError(composition.detail);
    }

    const validation = await validateDraftRow(tx, draft, composition.schema);
    // The ONE site a publication is decided at, which is why the counter is
    // here and not in `validateDraftRow`: `draft.service.ts` calls that too, for
    // the standalone validate a form runs on every keystroke, and counting
    // those would make the refusal rate a measure of typing (#367 W17 line 768).
    recordPublicationAttempt(validation);
    if (!validation.publishable) return { refused: validation };

    const category = await findCategoryRow(tx, draft.categoryId);
    if (category === null) throw notFound('The category this draft pins no longer exists.');

    const [variants, values] = await Promise.all([
      listDraftVariants(tx, draft.id),
      listDraftValues(tx, draft.id),
    ]);

    const listing = await createStoreProductWithin(
      tx,
      draft.storeId,
      buildStoreProductInput(draft, category.slug, composition.schema, variants, values),
      {
        actorOxyUserId: input.actorOxyUserId,
        status: 'active',
        // ADR 0007 D5/D10/D13's pin for the PUBLISHED write, and the reason it is
        // taken from the DRAFT rather than from the composition: the draft's
        // `product_type_definition_id` is the version its stored answers were
        // given under and is frozen by
        // `mercaria_catalog_authoring_draft_pins_frozen`, while a composition is
        // re-derived per request and could resolve a newer version between the
        // last save and this publish. Pinning what was composed would record a
        // schema the author never answered.
        productTypeDefinitionId: draft.productTypeDefinitionId,
      },
    );

    // The canonical links the AUTHOR declared, in the same transaction as the
    // variants they attach to. `insertVariants` returns rows in input order and
    // `createStoreProductWithin` preserves it, so position N of the draft is
    // position N of the listing — which is what makes the pairing below a fact
    // rather than a lookup by a title two variants could share.
    const now = new Date();
    const created = await tx
      .select({ id: productVariants.id, position: productVariants.position })
      .from(productVariants)
      .where(eq(productVariants.listingId, listing.id));
    const createdByPosition = new Map(created.map((row) => [row.position, row.id]));

    const resolvedProductId =
      draft.selectedCanonicalProductId === null
        ? null
        : (await resolveCanonicalProductSelection(tx, draft.selectedCanonicalProductId))?.id ?? null;

    for (const variant of variants) {
      if (variant.selectedCanonicalVariantId === null) continue;
      const productVariantId = createdByPosition.get(variant.position);
      if (productVariantId === undefined) {
        throw new Error(
          `publishDraft: draft variant at position ${variant.position} produced no product variant`,
        );
      }
      const resolved = await resolveCanonicalVariantSelection(
        tx,
        variant.selectedCanonicalVariantId,
      );
      if (resolved === null) {
        // The selected configuration was merged into a tombstone with no
        // successor, or suppressed. REFUSED rather than silently unlinked: the
        // author chose it, and publishing without the link would quietly hand
        // the variant to the matcher — which is exactly the overruling D10
        // forbids, arrived at by omission.
        throw validationError(
          `The catalogue configuration selected for variant ${variant.position + 1} is no longer available. Re-select it and publish again.`,
        );
      }
      if (
        resolvedProductId !== null &&
        !(await canonicalVariantBelongsToProduct(tx, resolved.id, resolvedProductId))
      ) {
        throw validationError(
          `The configuration selected for variant ${variant.position + 1} belongs to a different catalogue product than the one this draft names.`,
        );
      }
      await tx.insert(nativeListingLinks).values({
        productVariantId,
        listingId: listing.id,
        canonicalVariantId: resolved.id,
        method: 'merchant_declared',
        matchRule: MERCHANT_DECLARED_MATCH_RULE,
        // NULL, and `native_listing_links_confidence_check` restricts a number to
        // `matcher` rows anyway: a person saying "this is the product I am
        // selling" has no score, and one beside it could only read as doubt.
        confidence: null,
        status: 'active',
        decidedByOxyUserId: input.actorOxyUserId,
      });
    }

    await writeTypedAxesAndClaims(tx, {
      listing,
      draft,
      schema: composition.schema,
      variants,
      values,
      createdByPosition,
      actorOxyUserId: input.actorOxyUserId,
      now,
    });

    // The offer-convergence outbox row, INSIDE the transaction (ADR 0007 D10's
    // "…+ the outbox rows"). `syncListingFacets` enqueues the same row after the
    // commit and the enqueue is a convergence upsert, so the two agree by
    // construction — what this buys is that a listing can never be committed
    // with no convergence requested.
    //
    // The REPOSITORY, deliberately, and not `requestNativeOfferSync`. That
    // wrapper catches and logs, which is right for its own callers — none of
    // them is in a transaction — and wrong here in the way that hides the
    // failure: in PostgreSQL one failed statement aborts the WHOLE transaction
    // (`25P02`), so a swallowed enqueue error leaves every later statement
    // failing on a poisoned transaction and the publish reports whatever
    // `markDraftPublished` raises instead of what actually went wrong. #78's
    // snapshot write records the same ruling for the same reason.
    await enqueueOfferConvergence(listing.id, tx);

    const stamped = await markDraftPublished(tx, input.storeId, input.draftId, {
      listingId: listing.id,
      idempotencyKey: input.idempotencyKey,
      now,
    });
    if (stamped === null) {
      // Unreachable while the row is locked, and it must NOT be a silent
      // success: the whole point of one transaction is that a listing without
      // its draft stamp never exists.
      throw new Error('publishDraft: the draft was not open when it was stamped');
    }
    return { listingId: listing.id, draft: stamped };
  });

  if ('refused' in result) return { refused: result.refused };
  if ('converged' in result) {
    return { outcome: 'converged', listingId: result.converged, draft: result.draft };
  }
  return { outcome: 'published', listingId: result.listingId, draft: result.draft };
}

/**
 * Turn a validated draft into the input the ordinary store-product create takes.
 *
 * ## The legacy `{name, value}` option pairs, and why they are still written
 *
 * ADR 0007 D6 replaces `listing_options.name` and
 * `product_variant_option_values.name`/`.value` with typed axis rows referencing
 * the registry, and #367 merge-order step 4 owns that table. It is not on this
 * branch's base, so a publication today writes the legacy pairs — which is what
 * every cart line, checkout line and connector push reads.
 *
 * They are written from the SCHEMA rather than from free text: the option name
 * is the attribute's base-locale label and the value is the controlled value's
 * own canonical string, which is exactly what
 * `attribute_value_aliases` resolves. And the authoritative typed record is not
 * lost — `catalog_authoring_draft_values` holds every answer with its attribute
 * definition id and version, so step 4's backfill of an authoring-published
 * listing reads a decided fact rather than re-normalizing a label.
 */
function buildStoreProductInput(
  draft: CatalogAuthoringDraftRow,
  categorySlug: string,
  schema: Parameters<typeof validateDraftRow>[2],
  variants: Awaited<ReturnType<typeof listDraftVariants>>,
  values: readonly CatalogAuthoringDraftValueRow[],
): CreateStoreProductInput {
  const fieldsById = new Map(schema.fields.map((field) => [field.id, field]));
  const valueLabelById = new Map<string, string>();
  for (const field of schema.fields) {
    for (const controlled of field.controlledValues) {
      valueLabelById.set(controlled.id, controlled.value);
    }
  }
  const fieldLabel = (fieldId: string): string => {
    const field = fieldsById.get(fieldId);
    if (field === undefined) return fieldId;
    return schema.text.fields[field.id]?.label?.value ?? field.key;
  };

  const axisValuesByVariant = new Map<string, CatalogAuthoringDraftValueRow[]>();
  for (const value of values) {
    if (value.draftVariantId === null) continue;
    const bucket = axisValuesByVariant.get(value.draftVariantId) ?? [];
    bucket.push(value);
    axisValuesByVariant.set(value.draftVariantId, bucket);
  }

  // The listing's option list is the union of the axes any variant answered,
  // in the schema's own field order — so two products of one type declare their
  // options in the same order whatever order their authors filled the form in.
  const optionOrder: string[] = [];
  const optionValues = new Map<string, Set<string>>();
  for (const variant of variants) {
    for (const value of axisValuesByVariant.get(variant.id) ?? []) {
      const label = fieldLabel(value.fieldId);
      if (!optionValues.has(label)) {
        optionValues.set(label, new Set());
        optionOrder.push(label);
      }
      optionValues.get(label)?.add(renderOptionValue(value, valueLabelById));
    }
  }
  const options: ListingOption[] = optionOrder.map((name) => ({
    name,
    values: [...(optionValues.get(name) ?? [])],
  }));

  const storeVariants: CreateStoreProductVariantInput[] = variants.map((variant) => {
    const axes = (axisValuesByVariant.get(variant.id) ?? []).map((value) => ({
      name: fieldLabel(value.fieldId),
      value: renderOptionValue(value, valueLabelById),
    }));
    if (variant.priceAmount === null || variant.priceCurrency === null) {
      // Unreachable: `price_missing` and `price_currency_missing` are errors and
      // a publish only runs on a publishable draft. Stating it keeps the
      // narrowing honest under `strict: false`, where a `number | null` assigns
      // to a `number` in silence.
      throw validationError('A variant reached publication without a price.');
    }
    return {
      optionValues: axes,
      price: { amount: variant.priceAmount, currency: variant.priceCurrency },
      ...(variant.compareAtPriceAmount === null || variant.compareAtPriceCurrency === null
        ? {}
        : {
            compareAtPrice: {
              amount: variant.compareAtPriceAmount,
              currency: variant.compareAtPriceCurrency,
            },
          }),
      ...(variant.sku === null ? {} : { sku: variant.sku }),
      ...(variant.barcode === null ? {} : { barcode: variant.barcode }),
      inventory: { tracked: variant.inventoryTracked, available: variant.inventoryAvailable },
    };
  });

  return {
    title: draft.title ?? '',
    description: draft.description ?? '',
    category: categorySlug,
    // #572. STATED, always — never left to `createStoreProductWithin`'s
    // `resolveConditionInput(input) ?? { key: 'new', … }`, which is where this
    // decision used to live unnamed and where it was silently asserting
    // "factory new, declared by the seller" about every authored item.
    //
    // A `p2p` draft cannot reach the default: `condition_missing` refuses
    // publication first, and a publish only runs on a publishable draft.
    itemCondition: { key: conditionKeyFor(draft) },
    imageFileIds: [...draft.imageFileIds],
    tags: [...draft.tags],
    options,
    variants: storeVariants,
  };
}

/**
 * The condition a publication states, and the one place the default is applied.
 *
 * `resolveConditionInput` stamps `seller_declared` on every `itemCondition` it
 * reads, so the draft's own assertion column has nowhere to go through this
 * path. Rather than let a different assertion be silently downgraded, a draft
 * carrying one is REFUSED: no writer in this domain can produce it today, and a
 * future one that could must fail visibly rather than have its statement
 * rewritten on the way to the listing.
 */
function conditionKeyFor(draft: CatalogAuthoringDraftRow): ItemConditionKey {
  if (draft.itemConditionKey === null) return AUTHORING_DEFAULT_MERCHANT_CONDITION.key;
  if (draft.itemConditionAssertion !== AUTHORING_DEFAULT_MERCHANT_CONDITION.assertion) {
    throw new Error(
      `publishDraft: draft ${draft.id} states condition assertion ` +
        `"${draft.itemConditionAssertion}", which this path would rewrite to ` +
        `"${AUTHORING_DEFAULT_MERCHANT_CONDITION.assertion}"`,
    );
  }
  return draft.itemConditionKey;
}

/**
 * The legacy option VALUE one typed answer renders as.
 *
 * A controlled value renders as its CANONICAL string and not its label, so
 * step 4's backfill resolves it through `attribute_value_aliases` deterministically
 * — a label is per-locale presentation and would make the backfill's answer
 * depend on which language the merchant authored in.
 */
function renderOptionValue(
  value: CatalogAuthoringDraftValueRow,
  valueLabelById: ReadonlyMap<string, string>,
): string {
  switch (value.kind) {
    case 'controlled_value':
      return value.valueEnumValueId === null
        ? ''
        : (valueLabelById.get(value.valueEnumValueId) ?? value.valueEnumValueId);
    case 'text':
      return value.valueText ?? '';
    case 'number':
      return value.valueNumber === null
        ? ''
        : value.unit === null
          ? String(value.valueNumber)
          : `${value.valueNumber} ${value.unit}`;
    case 'boolean':
      return value.valueBoolean === true ? 'yes' : 'no';
    case 'canonical_reference':
      return value.canonicalRefId ?? '';
    default:
      return '';
  }
}

/**
 * The typed half of a publication (#367 step 4's tables, ADR 0007 D6/D7).
 *
 * Three writes, in this order and all inside the caller's transaction:
 *
 *  1. **Declare the listing's axes.** ADR 0007 D6: "the product's own declared
 *     axis list is authoritative for that product", and `writeVariantAxisValues`
 *     REFUSES a value naming an undeclared axis — so the declaration cannot be
 *     inferred from whatever a variant happened to carry.
 *  2. **Write each variant's axis values**, which recomputes
 *     `native_variant_signatures` through step 4's own `typedVariantSignature`.
 *     The draft already stored that same digest, computed by that same function,
 *     so a draft's deduplication and a published variant's identity cannot
 *     disagree.
 *  3. **Record the claims** — variant-grain for every axis answer and
 *     listing-grain for every product-scope one, with provenance
 *     `merchant_declared`.
 *
 * ## Why these claims are written ALREADY RESOLVED
 *
 * `ClaimResolutionInput` defaults both halves to `unresolved`, and that default
 * is right for a connector import or the legacy backfill: they assert a name and
 * a value having said nothing about which registry entry it is. The authoring
 * path is the one writer that KNOWS — the merchant picked from a form composed
 * out of the registry, so the definition, its exact version and the enum value
 * id are all in hand at write time. Recording them `unresolved` would put a
 * settled fact into #59's review queue and make the queue depth a measure of how
 * many products were authored correctly.
 *
 * ## And why the legacy `{name, value}` rows are still written
 *
 * `createStoreProductWithin` writes them, and they stay, because they are the
 * DISPLAY path every cart line, checkout line, order line and catalogue DTO
 * reads (`catalog-hydration`, `checkout.service`, `order-hydration`). What makes
 * that compatible with D6 rather than a violation of it is that they are
 * DERIVED from the typed answers — the option name is the attribute's label and
 * the value is the enum value's canonical string, both taken from the composed
 * schema — rather than free text a client sent. The typed rows are the fact, the
 * claim is what the merchant asserted, and the legacy pair is a projection of
 * both. Nothing here manufactures a legacy claim nobody made.
 */
async function writeTypedAxesAndClaims(
  tx: DatabaseOrTransaction,
  input: {
    listing: { id: string };
    draft: CatalogAuthoringDraftRow;
    schema: Parameters<typeof validateDraftRow>[2];
    variants: Awaited<ReturnType<typeof listDraftVariants>>;
    values: readonly CatalogAuthoringDraftValueRow[];
    createdByPosition: ReadonlyMap<number, string>;
    actorOxyUserId: string;
    now: Date;
  },
): Promise<void> {
  const fieldsById = new Map(input.schema.fields.map((field) => [field.id, field]));
  const valueStringById = new Map<string, string>();
  for (const field of input.schema.fields) {
    for (const controlled of field.controlledValues) {
      valueStringById.set(controlled.id, controlled.value);
    }
  }

  const axisValues = input.values.filter((value) => value.draftVariantId !== null);
  const productValues = input.values.filter((value) => value.draftVariantId === null);

  // The axes this draft actually answered, deduplicated by field. A schema field
  // that is `variant_capable` and that nobody answered is NOT declared: an axis
  // with no assignment on any variant is a dimension the product does not vary
  // along, and declaring it would make the authoritative list a description of
  // the schema rather than of the product.
  const axesByFieldId = new Map<string, CatalogAuthoringDraftValueRow>();
  for (const value of axisValues) {
    if (!axesByFieldId.has(value.fieldId)) axesByFieldId.set(value.fieldId, value);
  }

  if (axesByFieldId.size > 0) {
    await declareListingVariantAxes(
      tx,
      [...axesByFieldId.values()].map((value) => {
        const field = fieldsById.get(value.fieldId);
        return {
          listingId: input.listing.id,
          attributeDefinitionId: value.attributeDefinitionId,
          attributeKey: value.attributeKey,
          attributeDefinitionVersion: value.attributeDefinitionVersion,
          // The product type VERSION the axis was declared under. `listings`
          // carries no such column yet — step 4's doc names that as this
          // workstream's to add — so the axis is where the citation lives, and
          // it is the citation step 4's trigger clause will one day compare
          // against the listing's own.
          productTypeDefinitionId: input.draft.productTypeDefinitionId,
          position: field?.position ?? 0,
        };
      }),
    );
  }

  for (const variant of input.variants) {
    const productVariantId = input.createdByPosition.get(variant.position);
    if (productVariantId === undefined) continue;
    const mine = axisValues.filter((value) => value.draftVariantId === variant.id);

    /**
     * The CLAIM first, then the assignment that CITES it.
     *
     * `native_variant_axis_assignments.source_claim_id` is ADR 0007 D7's audit
     * edge — "which assertion became this value" — and this path is the one
     * writer that knows the answer, because it writes both halves in one
     * transaction. It used to write NULL: legal (the column is nullable for a
     * value authored typed from the start), and a fact thrown away, since a
     * merchant's answer IS an assertion and it was recorded one statement later.
     *
     * The order is therefore reversed from the obvious one. The claim has to
     * exist before the assignment can name it, and
     * `mercaria_native_variant_axis_assignment_scope` (migration 0104) refuses a
     * citation of a claim that did not RESOLVE — so an unresolved read-back is
     * cited as NULL rather than being forced through.
     */
    const claimIdByDraftValueId = new Map<string, string>();
    for (const value of mine) {
      const rawValue = displayValueOf(value, valueStringById);
      const claim = await recordVariantAttributeClaim(tx, {
        variantId: productVariantId,
        rawName: value.attributeKey,
        rawValue,
        provenance: 'merchant_declared',
        assertedByOxyUserId: input.actorOxyUserId,
        assertedAt: input.now,
        attributeResolution: 'resolved',
        valueResolution: 'resolved',
        attributeDefinitionId: value.attributeDefinitionId,
        attributeDefinitionVersion: value.attributeDefinitionVersion,
        enumValueId: value.valueEnumValueId,
        normalizedValue: normalizedValueOf(value, valueStringById),
        resolvedByOxyUserId: input.actorOxyUserId,
        resolvedAt: input.now,
      });
      // `ON CONFLICT DO NOTHING` returns nothing when the assertion was already
      // there. On a variant created moments ago in this same transaction that
      // needs two draft answers folding to one (name, value) pair — rare, and
      // not unreachable, so it is read back rather than assumed away.
      const settled =
        claim ??
        (await findVariantAttributeClaim(tx, {
          variantId: productVariantId,
          provenance: 'merchant_declared',
          rawName: value.attributeKey,
          rawValue,
        }));
      // The trigger's own rule, applied before the write instead of being
      // answered by a 500: a claim that resolved to nothing cannot support a
      // typed value, so the assignment cites nobody rather than citing it.
      if (settled !== null && settled.valueResolution === 'resolved') {
        claimIdByDraftValueId.set(value.id, settled.id);
      }
    }

    const values: VariantAxisValueInput[] = mine.map((value) => ({
      attributeKey: value.attributeKey,
      displayValue: displayValueOf(value, valueStringById),
      normalizedValue: normalizedValueOf(value, valueStringById),
      enumValueId: value.valueEnumValueId,
      normalizedNumber: value.valueNumber,
      normalizedUnit: value.unit,
      sourceClaimId: claimIdByDraftValueId.get(value.id) ?? null,
    }));
    await writeVariantAxisValues(tx, {
      listingId: input.listing.id,
      variantId: productVariantId,
      values,
    });
  }

  // Product-scope assertions, which step 4's own seam note names as this
  // service's to write: `native_listing_attribute_claims` with
  // `kind = 'attribute_value'` had no writer until now.
  for (const value of productValues) {
    await recordListingAttributeClaim(tx, {
      listingId: input.listing.id,
      kind: 'attribute_value',
      rawName: value.attributeKey,
      rawValue: displayValueOf(value, valueStringById),
      provenance: 'merchant_declared',
      assertedByOxyUserId: input.actorOxyUserId,
      assertedAt: input.now,
      attributeResolution: 'resolved',
      valueResolution: 'resolved',
      attributeDefinitionId: value.attributeDefinitionId,
      attributeDefinitionVersion: value.attributeDefinitionVersion,
      enumValueId: value.valueEnumValueId,
      normalizedValue: normalizedValueOf(value, valueStringById),
      resolvedByOxyUserId: input.actorOxyUserId,
      resolvedAt: input.now,
    });
  }
}

/** What the merchant SAW when they chose — the enum value's own canonical text. */
function displayValueOf(
  value: CatalogAuthoringDraftValueRow,
  valueStringById: ReadonlyMap<string, string>,
): string {
  if (value.valueEnumValueId !== null) {
    return valueStringById.get(value.valueEnumValueId) ?? value.valueEnumValueId;
  }
  if (value.valueText !== null) return value.valueText;
  if (value.valueNumber !== null) {
    return value.unit === null ? String(value.valueNumber) : `${value.valueNumber} ${value.unit}`;
  }
  if (value.valueBoolean !== null) return value.valueBoolean ? 'yes' : 'no';
  return value.canonicalRefId ?? '';
}

/**
 * The folded form, through step 4's own `normalizeAxisValue`.
 *
 * `writeVariantAxisValues` ASSERTS that the value it is handed is already
 * normalized and refuses it otherwise, so calling their folder here — rather
 * than a local `toLowerCase()` — is what keeps the stored value and the hashed
 * value the same string.
 */
function normalizedValueOf(
  value: CatalogAuthoringDraftValueRow,
  valueStringById: ReadonlyMap<string, string>,
): string {
  return normalizeAxisValue(displayValueOf(value, valueStringById));
}
