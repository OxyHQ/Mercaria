/**
 * The seller-facing draft: create, resume, patch, preview, discard (#91 entry
 * paths 1–6, UX rules 1–8).
 *
 * ## Everything a client sends is the SELLER's own statement
 *
 * There is no endpoint through which a canonical value enters a draft's columns.
 * A client may set the canonical PRODUCT and VARIANT — which is a pointer, not a
 * fact about the item — and everything else it sets is what the person typed.
 * That is what makes #91's "a prefilled value the seller did not confirm must
 * not be presented as their assertion" checkable: the assertion is exactly the
 * set of columns on the draft, and the prefill is composed fresh on every read.
 *
 * ## Changing or removing a match is an ordinary edit and leaves a trail
 *
 * `PATCH` with a different product, or with `null`, is accepted at any point
 * before publication (#91 entry paths, last line; acceptance 4). Nothing about
 * the canonical product changes — this domain writes to `canonical_*` never —
 * and the previous declaration survives as an append-only assertion row, which
 * is the only shape under which "an incorrect match can be changed" leaves any
 * evidence that it was.
 *
 * ## An acknowledgement covers what was disclosed WHEN it was given
 *
 * Adding a defect after acknowledging clears the acknowledgement. #90 stores an
 * instant rather than a boolean precisely so that "they agreed, to this" is
 * answerable, and letting a later disclosure inherit an earlier consent would
 * make the instant meaningless.
 */

import type {
  ConditionDetailSeverity,
  ConditionPhotoProvenance,
  CurrencyCode,
  ItemConditionKey,
  SellerDraftDTO,
  SellerDraftEntryPath,
  SellerDraftPlacement,
  SellerDraftPreview,
  SellerDraftStep,
  SellerPickupAvailability,
} from '@mercaria/shared-types';
import {
  CONDITION_DETAIL_KINDS,
  SELLER_PROOF_FIELD_KINDS,
  assertSafeMoneyAmount,
  coarsenSellerCoordinate,
  conditionGroupFor,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { findApplicablePolicies } from '../../db/condition/conditionPolicyRepository.js';
import { findCategoryById, findCategoryBySlug } from '../../db/catalog/categoryRepository.js';
import { getDb } from '../../db/postgres.js';
import {
  ensureSellerDraft,
  findReusedImageFileIds,
  findSellerDraft,
  findSellerDraftWithChildren,
  linkSellerDraftImageDetails,
  listSellerDrafts,
  replaceSellerDraftDetails,
  replaceSellerDraftImages,
  updateSellerDraft,
  type SellerDraftPatch,
  type SellerDraftRecord,
  type SellerDraftWithChildren,
} from '../../db/sellYours/draftRepository.js';
import {
  findLatestGateRefusal,
  recordSellerMatchAssertion,
} from '../../db/sellYours/matchAssertionRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { buildSellerPriceGuidance } from './price-guidance.service.js';
import { buildCanonicalPrefill } from './prefill.service.js';
import { deriveSellerDraftReadiness, hasDisclosedDefects } from './readiness.js';

/** What a client may send when it starts a flow. */
export interface StartSellerDraftInput {
  readonly clientDraftKey: string;
  readonly entryPath: SellerDraftEntryPath;
  readonly canonicalProductId?: string;
  readonly canonicalVariantId?: string;
}

/** What a client may send on any step. */
export interface PatchSellerDraftInput {
  currentStep?: SellerDraftStep;
  completedSteps?: SellerDraftStep[];
  /** `null` REMOVES the match — #91's "change or remove an incorrect product match". */
  canonicalProductId?: string | null;
  canonicalVariantId?: string | null;
  /** The seller affirmatively confirming a proposal, or rejecting it. */
  matchConfirmed?: boolean;
  title?: string;
  description?: string;
  category?: string;
  tags?: string[];
  conditionKey?: ItemConditionKey;
  conditionDetails?: { kind: string; severity?: ConditionDetailSeverity; note?: string }[];
  defectsAcknowledged?: boolean;
  includedAccessories?: string[];
  images?: {
    fileId: string;
    alt?: string;
    provenance: ConditionPhotoProvenance;
    showsDefect?: boolean;
    detailIndex?: number;
  }[];
  quantity?: number;
  price?: { amount: number; currency: CurrencyCode };
  pickup?: SellerPickupAvailability;
  location?: { longitude: number; latitude: number } | null;
}

/** Start or resume the flow for this (owner, client key). */
export async function startSellerDraft(
  oxyUserId: string,
  input: StartSellerDraftInput,
): Promise<SellerDraftRecord> {
  const declaredProduct = input.canonicalProductId ?? null;
  const declaredVariant = input.canonicalVariantId ?? null;
  if (declaredVariant !== null && declaredProduct === null) {
    throw validationError('A canonical variant must name the product it belongs to');
  }
  if (input.entryPath === 'unmatched' && declaredProduct !== null) {
    throw validationError('An unmatched draft cannot name a canonical product');
  }

  const draft = await ensureSellerDraft({
    oxyUserId,
    clientDraftKey: input.clientDraftKey,
    entryPath: input.entryPath,
    canonicalProductId: declaredProduct,
    canonicalVariantId: declaredVariant,
    // A product arriving with the draft is PROPOSED, never confirmed: the seller
    // tapped "Sell yours" on a page, which says what they were looking at and
    // not yet that they checked it is the same object.
    matchState: declaredProduct === null ? 'unmatched' : 'proposed',
    matchActor: declaredProduct === null ? null : 'seller',
  });

  if (declaredProduct !== null && draft.canonicalProductId === declaredProduct) {
    await recordSellerMatchAssertion({
      draftId: draft.id,
      outcome: 'declared',
      actor: 'seller',
      actorOxyUserId: oxyUserId,
      canonicalProductId: declaredProduct,
      canonicalVariantId: declaredVariant,
      confidence: null,
      blockers: [],
      reasonCodes: [`entry_path:${input.entryPath}`],
    });
  }

  return draft;
}

/** The seller's own unfinished flows. */
export async function listOwnSellerDrafts(oxyUserId: string): Promise<SellerDraftRecord[]> {
  return listSellerDrafts(oxyUserId, 'in_progress', config.sellYours.draftListLimit);
}

/**
 * Apply one step's worth of edits.
 *
 * The children are replaced inside ONE transaction with the column patch, so a
 * draft is never briefly holding a condition whose disclosures have been deleted
 * and not yet re-inserted — which the readiness derivation would read as a
 * missing acknowledgement and a client would render as a step going backwards.
 */
export async function patchSellerDraft(
  oxyUserId: string,
  draftId: string,
  input: PatchSellerDraftInput,
): Promise<SellerDraftWithChildren> {
  const existing = await findSellerDraft(draftId, oxyUserId);
  if (!existing) throw notFound('Draft not found');
  if (existing.status !== 'in_progress') {
    throw conflict('This draft has already been published or discarded');
  }

  const patch: SellerDraftPatch = {};
  if (input.currentStep !== undefined) patch.currentStep = input.currentStep;
  if (input.completedSteps !== undefined) patch.completedSteps = [...input.completedSteps];
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.tags !== undefined) patch.tags = [...input.tags];
  if (input.includedAccessories !== undefined) {
    patch.includedAccessories = [...input.includedAccessories];
  }
  if (input.quantity !== undefined) patch.quantity = input.quantity;
  if (input.pickup !== undefined) patch.pickup = input.pickup;
  if (input.conditionKey !== undefined) patch.conditionKey = input.conditionKey;

  if (input.category !== undefined) {
    const category = await findCategoryBySlug(input.category);
    if (!category) throw notFound(`Category not found: ${input.category}`);
    patch.categoryId = category.id;
  }

  if (input.price !== undefined) {
    // The ceiling is what makes the check real — `z.number().int()` accepts
    // `1e300`, and a draft is where a seller's typo first reaches a money column.
    assertSafeMoneyAmount(input.price.amount, 'draft price');
    if (input.price.amount < 0) throw validationError('A price cannot be negative');
    patch.priceAmount = input.price.amount;
    patch.priceCurrency = input.price.currency;
  }

  if (input.location !== undefined) {
    if (input.location === null) {
      patch.locationOptIn = false;
      patch.locationLongitude = null;
      patch.locationLatitude = null;
    } else {
      /**
       * Coarsened HERE, at the write boundary.
       *
       * Rounding on the way out instead would leave the precise coordinate in
       * the table, in every backup and in every operator query — a privacy
       * property that depends on each reader remembering is not one.
       */
      patch.locationOptIn = true;
      patch.locationLongitude = coarsenSellerCoordinate(input.location.longitude);
      patch.locationLatitude = coarsenSellerCoordinate(input.location.latitude);
    }
  }

  const matchChange = resolveMatchChange(existing, input);
  Object.assign(patch, matchChange.patch);

  const reusedFileIds =
    input.images === undefined
      ? []
      : await findReusedImageFileIds(
          oxyUserId,
          input.images.map((image) => image.fileId),
        );
  if (reusedFileIds.length > 0) {
    /**
     * #91 trust rule 2, answered as a FIELD-LEVEL refusal rather than a 500.
     *
     * The database trigger refuses the write regardless — that is the authority,
     * and it holds against a writer that never came through here. This exists so
     * the seller is told which picture is the catalogue's and asked for one of
     * their own, which is the only remedy that gets a real listing published.
     */
    throw validationError(
      `These photographs already belong to the catalogue or to another seller's listing, so ` +
        `they cannot be evidence about your item: ${reusedFileIds.join(', ')}`,
    );
  }

  const result = await getDb().transaction(async (tx) => {
    if (input.conditionDetails !== undefined) {
      const details = input.conditionDetails.map((detail) => {
        if (!CONDITION_DETAIL_KINDS.includes(detail.kind as (typeof CONDITION_DETAIL_KINDS)[number])) {
          throw validationError(`Unknown condition detail kind: ${detail.kind}`);
        }
        return {
          kind: detail.kind as (typeof CONDITION_DETAIL_KINDS)[number],
          ...(detail.severity === undefined ? {} : { severity: detail.severity }),
          ...(detail.note === undefined ? {} : { note: detail.note }),
        };
      });
      const written = await replaceSellerDraftDetails(tx, draftId, details);

      /**
       * A new disclosure clears an earlier acknowledgement.
       *
       * #90 stores an INSTANT rather than a boolean so that "they agreed, to
       * what was disclosed then" is answerable; letting a defect added
       * afterwards inherit that consent is exactly what would make the instant
       * meaningless.
       */
      if (
        input.defectsAcknowledged !== true &&
        existing.defectsAcknowledgedAt !== null &&
        hasDisclosedDefects(written)
      ) {
        patch.defectsAcknowledgedAt = null;
      }
    }

    if (input.defectsAcknowledged !== undefined) {
      // Literally `true` only. A missing or falsy field is not consent.
      patch.defectsAcknowledgedAt = input.defectsAcknowledged === true ? new Date() : null;
    }

    if (input.images !== undefined) {
      const images = await replaceSellerDraftImages(
        tx,
        draftId,
        input.images.map((image) => ({
          fileId: image.fileId,
          ...(image.alt === undefined ? {} : { alt: image.alt }),
          provenance: image.provenance,
          ...(image.showsDefect === undefined ? {} : { showsDefect: image.showsDefect }),
        })),
      );

      /**
       * A photograph cites a disclosure by POSITION in the same request, never by
       * an id the client supplies.
       *
       * The rows it could name are the ones this transaction may have just
       * replaced, so an id from the client is either stale or belongs to
       * somebody else's draft. Resolving by position after both writes land is
       * the only reading that can be correct for a list the seller is still
       * editing.
       */
      const { details } = await findSellerDraftWithChildren(draftId, oxyUserId, tx) ?? {
        details: [],
      };
      const links = new Map<string, string>();
      input.images.forEach((image, index) => {
        if (image.detailIndex === undefined) return;
        const detail = details[image.detailIndex];
        const row = images[index];
        if (detail && row) links.set(row.id, detail.id);
      });
      if (links.size > 0) await linkSellerDraftImageDetails(tx, draftId, links);
    }

    await updateSellerDraft(draftId, oxyUserId, patch, tx);

    for (const assertion of matchChange.assertions) {
      await recordSellerMatchAssertion({ ...assertion, draftId }, tx);
    }

    const updated = await findSellerDraftWithChildren(draftId, oxyUserId, tx);
    if (!updated) throw notFound('Draft not found');
    return updated;
  });

  return result;
}

/**
 * What a match edit does to the columns, and what it leaves in the trail.
 *
 * A pure function over the existing row and the request, so the three shapes a
 * client can send — remove the match, replace it, confirm the one it already has
 * — are all visible in one place rather than spread through the patch builder.
 */
function resolveMatchChange(
  existing: SellerDraftRecord,
  input: PatchSellerDraftInput,
): {
  patch: SellerDraftPatch;
  assertions: Omit<Parameters<typeof recordSellerMatchAssertion>[0], 'draftId'>[];
} {
  const assertions: Omit<Parameters<typeof recordSellerMatchAssertion>[0], 'draftId'>[] = [];

  if (input.canonicalProductId === null) {
    return {
      patch: {
        canonicalProductId: null,
        canonicalVariantId: null,
        matchState: 'seller_rejected',
        matchActor: null,
        matchConfidence: null,
      },
      assertions: [
        {
          outcome: 'rejected',
          actor: 'seller',
          actorOxyUserId: existing.oxyUserId,
          canonicalProductId: existing.canonicalProductId,
          canonicalVariantId: existing.canonicalVariantId,
          confidence: null,
          blockers: [],
          reasonCodes: ['seller_removed_match'],
        },
      ],
    };
  }

  if (input.canonicalProductId !== undefined) {
    const variant = input.canonicalVariantId ?? null;
    return {
      patch: {
        canonicalProductId: input.canonicalProductId,
        canonicalVariantId: variant,
        matchState: input.matchConfirmed === true ? 'seller_confirmed' : 'proposed',
        matchActor: 'seller',
        matchConfidence: null,
      },
      assertions: [
        {
          outcome: input.matchConfirmed === true ? 'confirmed' : 'declared',
          actor: 'seller',
          actorOxyUserId: existing.oxyUserId,
          canonicalProductId: input.canonicalProductId,
          canonicalVariantId: variant,
          confidence: null,
          blockers: [],
          reasonCodes: ['seller_selected_product'],
        },
      ],
    };
  }

  // A variant chosen for a product the draft already names.
  if (input.canonicalVariantId !== undefined && existing.canonicalProductId !== null) {
    return {
      patch: {
        canonicalVariantId: input.canonicalVariantId,
        matchState: input.matchConfirmed === true ? 'seller_confirmed' : existing.matchState,
      },
      assertions: [
        {
          outcome: input.matchConfirmed === true ? 'confirmed' : 'declared',
          actor: 'seller',
          actorOxyUserId: existing.oxyUserId,
          canonicalProductId: existing.canonicalProductId,
          canonicalVariantId: input.canonicalVariantId,
          confidence: null,
          blockers: [],
          reasonCodes: ['seller_selected_variant'],
        },
      ],
    };
  }

  if (input.matchConfirmed === true && existing.canonicalProductId !== null) {
    return {
      patch: { matchState: 'seller_confirmed' },
      assertions: [
        {
          outcome: 'confirmed',
          actor: 'seller',
          actorOxyUserId: existing.oxyUserId,
          canonicalProductId: existing.canonicalProductId,
          canonicalVariantId: existing.canonicalVariantId,
          confidence: null,
          blockers: [],
          reasonCodes: ['seller_confirmed_existing_match'],
        },
      ],
    };
  }

  return { patch: {}, assertions };
}

/** Abandon a draft. The assertions it produced survive it. */
export async function discardSellerDraft(oxyUserId: string, draftId: string): Promise<void> {
  const updated = await updateSellerDraft(draftId, oxyUserId, { status: 'discarded' });
  if (!updated) throw notFound('Draft not found');
}

/**
 * Everything a review step renders — the draft, whether it may be published, and
 * where it will appear.
 */
export async function previewSellerDraft(
  oxyUserId: string,
  draftId: string,
  options: { readonly currency?: CurrencyCode; readonly market?: string } = {},
): Promise<SellerDraftPreview> {
  const loaded = await findSellerDraftWithChildren(draftId, oxyUserId);
  if (!loaded) throw notFound('Draft not found');
  const { draft, details, images } = loaded;

  const [prefill, refusal, policies, category] = await Promise.all([
    buildCanonicalPrefill({
      canonicalProductId: draft.canonicalProductId,
      canonicalVariantId: draft.canonicalVariantId,
    }),
    findLatestGateRefusal(draft.id),
    draft.categoryId
      ? findApplicablePolicies(getDb(), draft.categoryId, [])
      : Promise.resolve([]),
    draft.categoryId ? findCategoryById(draft.categoryId) : Promise.resolve(null),
  ]);

  const guidance =
    draft.conditionKey === null
      ? undefined
      : await buildSellerPriceGuidance({
          canonicalProductId: draft.canonicalProductId,
          canonicalVariantId: draft.canonicalVariantId,
          conditionGroup: conditionGroupFor(draft.conditionKey),
          currency: options.currency ?? draft.priceCurrency ?? 'FAIR',
          ...(options.market ? { market: options.market } : {}),
        });

  const readiness = deriveSellerDraftReadiness({
    draft,
    details,
    images,
    forbiddenConditionKeys: policies.map((policy) => policy.conditionKey),
    // A refusal only stands while the draft still names the product it was
    // about. Changing the match is the documented remedy, so a stale refusal
    // must not keep blocking a declaration nobody has judged.
    matchRefused:
      refusal !== null && refusal.canonicalProductId === draft.canonicalProductId,
    ...(guidance ? { guidance } : {}),
  });

  const placement: SellerDraftPlacement = {
    // A listing reaches a product page only through an ATTACHMENT, and an
    // attachment only exists if the gate allows one. Promising the page for a
    // draft whose match was refused would be the promise #91 acceptance 4 is
    // about.
    onCanonicalProduct:
      draft.canonicalProductId !== null &&
      draft.canonicalVariantId !== null &&
      !readiness.blockReasons.includes('match_review_required'),
    onSellerProfile: true,
    inLocalResults: draft.locationOptIn,
  };

  return {
    draft: toSellerDraftDTO(loaded, prefill, category?.slug),
    readiness,
    placement,
    ...(guidance ? { guidance } : {}),
  };
}

/**
 * The wire shape of a draft.
 *
 * `categorySlug` is passed in rather than read here: a client speaks in slugs
 * and the column holds an id, and a DTO builder that resolved it would issue a
 * query per draft in a list.
 */
export function toSellerDraftDTO(
  loaded: SellerDraftWithChildren,
  prefill?: Awaited<ReturnType<typeof buildCanonicalPrefill>>,
  categorySlug?: string,
): SellerDraftDTO {
  const { draft, details, images } = loaded;
  return {
    id: draft.id,
    entryPath: draft.entryPath,
    status: draft.status,
    currentStep: draft.currentStep,
    completedSteps: draft.completedSteps as SellerDraftStep[],
    matchState: draft.matchState,
    ...(draft.canonicalProductId ? { canonicalProductId: draft.canonicalProductId } : {}),
    ...(draft.canonicalVariantId ? { canonicalVariantId: draft.canonicalVariantId } : {}),
    ...(prefill ? { prefill } : {}),
    ...(draft.title ? { title: draft.title } : {}),
    // DERIVED, never stored: a flag beside a title is a second representation of
    // one fact, and the one that goes stale is the flag (#91 listing creation 5).
    titleOverridesCanonical:
      prefill !== undefined && draft.title !== null && draft.title !== prefill.title.value,
    ...(draft.description ? { description: draft.description } : {}),
    ...(categorySlug ? { categorySlug } : {}),
    tags: draft.tags,
    ...(draft.conditionKey ? { conditionKey: draft.conditionKey } : {}),
    ...(draft.conditionKey ? { conditionGroup: conditionGroupFor(draft.conditionKey) } : {}),
    conditionDetails: details.map((detail) => ({
      id: detail.id,
      kind: detail.kind,
      ...(detail.severity ? { severity: detail.severity } : {}),
      ...(detail.note ? { note: detail.note } : {}),
    })),
    ...(draft.defectsAcknowledgedAt
      ? { defectsAcknowledgedAt: draft.defectsAcknowledgedAt.toISOString() }
      : {}),
    includedAccessories: draft.includedAccessories,
    images: images.map((image) => ({
      id: image.id,
      fileId: image.fileId,
      ...(image.alt ? { alt: image.alt } : {}),
      position: image.position,
      provenance: image.provenance,
      showsDefect: image.showsDefect,
      ...(image.conditionDetailId ? { conditionDetailId: image.conditionDetailId } : {}),
    })),
    quantity: draft.quantity,
    ...(draft.priceAmount !== null && draft.priceCurrency !== null
      ? { price: { amount: draft.priceAmount, currency: draft.priceCurrency } }
      : {}),
    pickup: draft.pickup,
    locationOptIn: draft.locationOptIn,
    ...(draft.publishedListingId ? { publishedListingId: draft.publishedListingId } : {}),
    ...(draft.publishedAt ? { publishedAt: draft.publishedAt.toISOString() } : {}),
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

/**
 * The proof-field refusal (#91 seller-owned field 10).
 *
 * Mounted BEFORE the `.strict()` schema, so a seller who sends a serial number
 * is told what Mercaria does not accept and why, instead of "unrecognized key" —
 * the `forbidden-evidence.ts` device from #121. See
 * `SELLER_PROOF_FIELD_KINDS` for why nothing here stores one.
 */
export function assertNoProofFields(body: Record<string, unknown>): void {
  const offending = SELLER_PROOF_FIELD_KINDS.filter((kind) =>
    Object.keys(body).some((key) => key.toLowerCase().replace(/[^a-z]/g, '') === kind.replace(/_/g, '')),
  );
  if (offending.length > 0) {
    throw validationError(
      `Mercaria does not accept ${offending.join(', ')} on a listing draft. Identity and ` +
        'ownership evidence needs a reviewed, non-public workflow that does not exist yet ' +
        '(#91 seller-owned field 10), and a protected store with no reviewer would carry every ' +
        'risk of holding your serial number and none of the benefit.',
    );
  }
}
