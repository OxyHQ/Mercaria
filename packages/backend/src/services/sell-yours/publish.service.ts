/**
 * Turning a draft into a published P2P listing (#91 listing creation 1–9).
 *
 * ## Exactly-once rests on THREE mechanisms and none substitutes for another
 *
 * 1. `UNIQUE(oxy_user_id, client_draft_key)` — a retried "start selling" tap
 *    resumes the same draft rather than starting a second flow.
 * 2. A row lock on the draft for the whole publication — two concurrent submits
 *    serialise, and the loser reads the winner's stamp instead of racing it.
 * 3. The CAS in `stampPublication`, plus the trigger refusing value→value — even
 *    a caller that ignored the lock cannot overwrite a stamped listing id.
 *
 * The listing, its gallery, its condition evidence, its variant, its canonical
 * attachment and the stamp all commit in ONE transaction. That is what closes
 * the window the obvious implementation leaves open: create the listing, then
 * stamp the draft, crash in between, and the retry creates a second listing
 * because the draft still says nothing was published (#91 acceptance 3).
 *
 * ## The attachment is written HERE and only if #58's gate allows it
 *
 * `evaluateSellerDeclaredMatch` runs against the variant this transaction just
 * created, so the deterministic facts it reads — the listing's own identifiers,
 * its brand, its pack count — are the ones a buyer will see. A refusal writes NO
 * link, records the blockers, and lets the listing publish unmatched, which #91
 * listing creation 7 requires to be a fully valid state anyway.
 *
 * ## What happens after the commit, and why it is after
 *
 * `syncListingFacets` recomputes the denormalized facets and enqueues both the
 * native-offer convergence (#57) and the per-variant match request (#58). Both
 * are durable outbox rows whose whole point is surviving independently of the
 * write that asked for them, so enqueuing them inside would tie a publication's
 * success to a projection's.
 */

import type { CreateP2PListingInput, SellerMatchGateOutcome } from '@mercaria/shared-types';
import { insertP2PListingWithin, syncListingFacets } from '../catalog-write.service.js';
import { findCategoryById } from '../../db/catalog/categoryRepository.js';
import { findVariantsByListing } from '../../db/catalog/variantRepository.js';
import { insertNativeListingLink } from '../../db/offers/nativeListingLinkRepository.js';
import { requestNativeOfferSync } from '../offers/native-offer.service.js';
import { getDb } from '../../db/postgres.js';
import {
  findSellerDraftWithChildren,
  lockSellerDraftForPublication,
  stampPublication,
} from '../../db/sellYours/draftRepository.js';
import {
  findLatestGateRefusal,
  recordSellerMatchAssertion,
} from '../../db/sellYours/matchAssertionRepository.js';
import { findApplicablePolicies } from '../../db/condition/conditionPolicyRepository.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { getOrCreate as getOrCreateSellerProfile } from '../seller-profile.service.js';
import { evaluateSellerDeclaredMatch } from './match-gate.js';
import { deriveSellerDraftReadiness } from './readiness.js';

/** What one publication did. */
export interface SellerDraftPublication {
  readonly listingId: string;
  /** True when this call created the listing; false when it converged on a retry. */
  readonly created: boolean;
  readonly match: SellerMatchGateOutcome;
}

/**
 * Publish a draft, idempotently.
 *
 * A second call with the same draft returns the SAME listing id and reports
 * `created: false` — which is what a native client that lost its response needs,
 * and what a double tap produces.
 */
export async function publishSellerDraft(
  oxyUserId: string,
  draftId: string,
): Promise<SellerDraftPublication> {
  // Outside the transaction: it is an upsert on another table, it is safe to
  // repeat, and holding the draft lock across it would extend the lock for no
  // benefit.
  await getOrCreateSellerProfile(oxyUserId);

  const outcome = await getDb().transaction(async (tx) => {
    const locked = await lockSellerDraftForPublication(draftId, oxyUserId, tx);
    if (!locked) throw notFound('Draft not found');
    if (locked.publishedListingId !== null) {
      // Converged: somebody else — or this client's earlier attempt — already
      // published this draft. Returning their listing is the whole of what
      // "prevent duplicate publication from repeated submit" means.
      return {
        listingId: locked.publishedListingId,
        created: false,
        match: { state: 'unmatched' } as SellerMatchGateOutcome,
      };
    }
    if (locked.status === 'discarded') throw conflict('This draft was discarded');

    const loaded = await findSellerDraftWithChildren(draftId, oxyUserId, tx);
    if (!loaded) throw notFound('Draft not found');
    const { draft, details, images } = loaded;

    const [policies, refusal, category] = await Promise.all([
      draft.categoryId ? findApplicablePolicies(tx, draft.categoryId, []) : Promise.resolve([]),
      findLatestGateRefusal(draft.id, tx),
      draft.categoryId ? findCategoryById(draft.categoryId, tx) : Promise.resolve(null),
    ]);

    const readiness = deriveSellerDraftReadiness({
      draft,
      details,
      images,
      forbiddenConditionKeys: policies.map((policy) => policy.conditionKey),
      matchRefused: refusal !== null && refusal.canonicalProductId === draft.canonicalProductId,
    });
    if (!readiness.publishable) {
      /**
       * The refusal names the reason CODES and nothing else.
       *
       * A sentence composed here would be one a client cannot translate, cannot
       * test against and cannot render beside the field it is about — which is
       * why `SELLER_DRAFT_BLOCK_REASONS` is a closed set in the first place.
       */
      throw validationError(
        `This draft cannot be published yet: ${readiness.blockReasons.join(', ')}`,
      );
    }

    // Every one of these is guaranteed by the readiness gate above; the
    // narrowing is what lets the compiler agree.
    if (
      !draft.title ||
      !draft.description ||
      !category ||
      !draft.conditionKey ||
      draft.priceAmount === null ||
      draft.priceCurrency === null
    ) {
      throw validationError('This draft cannot be published yet');
    }

    const listingInput: CreateP2PListingInput = {
      title: draft.title,
      description: draft.description,
      category: category.slug,
      price: { amount: draft.priceAmount, currency: draft.priceCurrency },
      quantity: draft.quantity,
      imageFileIds: images.map((image) => image.fileId),
      tags: draft.tags,
      itemCondition: {
        key: draft.conditionKey,
        details: details.map((detail) => ({
          kind: detail.kind,
          ...(detail.severity ? { severity: detail.severity } : {}),
          ...(detail.note ? { note: detail.note } : {}),
        })),
        photoAnnotations: images
          .filter((image) => image.showsDefect || image.conditionDetailId !== null)
          .map((image) => {
            const index = details.findIndex((detail) => detail.id === image.conditionDetailId);
            return {
              fileId: image.fileId,
              showsDefect: image.showsDefect,
              ...(index >= 0 ? { detailIndex: index } : {}),
            };
          }),
        // The seller's own affirmative act, carried across verbatim. `null` is
        // not consent, and the readiness gate already refused publication
        // without it wherever #90's policy requires one.
        defectsAcknowledged: draft.defectsAcknowledgedAt !== null,
      },
    };

    const listingId = await insertP2PListingWithin(
      tx,
      oxyUserId,
      listingInput,
      draft.locationOptIn && draft.locationLongitude !== null && draft.locationLatitude !== null
        ? { longitude: draft.locationLongitude, latitude: draft.locationLatitude }
        : null,
      new Date(),
    );

    const match = await attachDeclaredMatch(tx, {
      draftId: draft.id,
      oxyUserId,
      listingId,
      canonicalProductId: draft.canonicalProductId,
      canonicalVariantId: draft.canonicalVariantId,
    });

    const stamped = await stampPublication(draft.id, listingId, new Date(), tx);
    if (!stamped) {
      // Unreachable while the lock above is held; if it ever is reached, the
      // transaction rolls back rather than leaving a listing no draft names.
      throw conflict('This draft was published concurrently');
    }

    return { listingId, created: true, match };
  });

  if (outcome.created) {
    // AFTER the commit: both requests are durable outbox rows, and a
    // publication must not fail because a projection could not be QUEUED.
    await syncListingFacets(outcome.listingId);
  }

  return outcome;
}

/**
 * Run the gate and write the attachment, in the publication's transaction.
 *
 * The assertion row is appended on BOTH paths, which is the point: "the gate
 * refused, and here are the blockers" is the evidence a `wrong_product_match`
 * report is investigated against, and it is the only record that a listing which
 * looks unmatched was ever declared to be anything.
 */
async function attachDeclaredMatch(
  tx: Parameters<typeof insertNativeListingLink>[0],
  input: {
    readonly draftId: string;
    readonly oxyUserId: string;
    readonly listingId: string;
    readonly canonicalProductId: string | null;
    readonly canonicalVariantId: string | null;
  },
): Promise<SellerMatchGateOutcome> {
  if (input.canonicalProductId === null || input.canonicalVariantId === null) {
    return { state: 'unmatched' };
  }

  const [variant] = await findVariantsByListing(input.listingId, tx);
  if (!variant) return { state: 'unmatched' };

  const outcome = await evaluateSellerDeclaredMatch({
    productVariantId: variant.id,
    declaredCanonicalProductId: input.canonicalProductId,
    declaredCanonicalVariantId: input.canonicalVariantId,
    db: tx,
  });

  if (outcome.state === 'refused') {
    await recordSellerMatchAssertion(
      {
        draftId: input.draftId,
        outcome: 'gate_refused',
        actor: 'seller',
        actorOxyUserId: input.oxyUserId,
        canonicalProductId: input.canonicalProductId,
        canonicalVariantId: input.canonicalVariantId,
        confidence: null,
        blockers: outcome.blockers as Parameters<
          typeof recordSellerMatchAssertion
        >[0]['blockers'],
        reasonCodes: outcome.reasonCodes,
      },
      tx,
    );
    return outcome;
  }
  if (outcome.state === 'unmatched') return outcome;

  await insertNativeListingLink(tx, {
    productVariantId: variant.id,
    listingId: input.listingId,
    canonicalVariantId: outcome.canonicalVariantId,
    method: 'seller_declared',
    /**
     * The rule id #59 reads. It names the FLOW rather than a policy version,
     * because a seller's declaration was not produced by a policy — and quoting
     * one would suggest a reviewer could re-run something to reproduce it.
     */
    matchRule: 'sell_yours:seller_declared',
    // NULL like every non-`matcher` method: a person saying "this is what I am
    // selling" has no score, and a number could only be read as doubt.
    confidence: null,
    sourceRecordId: null,
  });

  await recordSellerMatchAssertion(
    {
      draftId: input.draftId,
      outcome: 'attached',
      actor: 'seller',
      actorOxyUserId: input.oxyUserId,
      canonicalProductId: outcome.canonicalProductId,
      canonicalVariantId: outcome.canonicalVariantId,
      confidence: null,
      blockers: [],
      reasonCodes: ['seller_declared_match_attached'],
    },
    tx,
  );

  // The offer seam, in this transaction, so a rolled-back attachment leaves no
  // request to materialize an offer for a link that does not exist (#58's own
  // rule, and the reason `applyMatchOutcome` does the same).
  await requestNativeOfferSync(input.listingId, tx);

  return outcome;
}
