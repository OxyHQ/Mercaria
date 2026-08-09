/**
 * Merchant → native `Store` linkage — the workflow (#84, ADR 0002 D4/D9).
 *
 * #83 ends with a verified claim: somebody proved they operate a canonical
 * merchant. It deliberately stops there — "the claim records a `native_store_id`
 * INTENT and writes no link". This module is what happens next, and its whole
 * output is ONE `native_store_links` row (#54's table, D4's cardinality) plus a
 * small, named set of side effects.
 *
 * ## What linkage may touch, exhaustively
 *
 * A new `stores` row through the EXISTING `createStore` service, or none at all;
 * the merchant ↔ store join row; and — only when the owner selects them, field
 * by field — the store's `name` and `description`. That is the complete list.
 *
 * Everything else is untouched because there is no line here that could touch
 * it: no membership write, no permission change, no policy, collection,
 * inventory, customer, order or report write, no handle change, no follow-target
 * call, and no `offers` write of any kind. `store-linkage-isolation.test.ts`
 * scans for each, so issue existing-store rule 4 and revocation rule 3 are
 * properties of the code rather than promises about it.
 *
 * ## The row IS the job, and the job is resumable
 *
 * Applying a request is five ordered, individually idempotent steps under a
 * lease (the payment/moderation outbox contract). A task that dies half way
 * leaves the request `applying` with its furthest step recorded and its lease
 * expiring, so the next attempt CONTINUES rather than starting over — which is
 * issue revocation rule 2's resumable job, given to every mode rather than only
 * to corrections so there is one mechanism to reason about instead of two.
 *
 * There is deliberately no background dispatcher. Every mode is driven by a
 * person — a claimant linking their shop, an operator correcting a mistake — and
 * a loop that retried on a clock would re-run identity changes nobody was
 * watching. Resumption is the same endpoint called again, or the operator's
 * explicit `run`.
 *
 * ## Nothing here grants a badge (issue acceptance 7)
 *
 * Linking a merchant to a store says who OPERATES it. It says nothing about
 * whether they are a brand's official store or an authorized reseller — those
 * are evidence-gated `commerce_relationships` rows owned by #55 (ADR 0002
 * D10/D17), and this domain imports no relationship vocabulary at all.
 */

import {
  STORE_LINKAGE_AUTO_LINK_SOURCES,
  type StoreLinkageBlockReason,
  type StoreLinkageCandidate,
  type StoreLinkageMatchState,
  type StoreLinkageMode,
  type StoreLinkageOfferOverlap,
  type StoreLinkageProfileAdoption,
  type StoreLinkageProfileField,
  type StoreLinkageRequest,
} from '@mercaria/shared-types';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { findClaimById, findScopesForClaim } from '../../db/merchant-claims/merchantClaimRepository.js';
import {
  findMerchantById,
  listMerchantDomains,
} from '../../db/commerce-graph/merchantRepository.js';
import { findStorefrontsByMerchant } from '../../db/commerce-graph/storefrontRepository.js';
import {
  findActiveLinkByMerchant,
  findActiveLinkByStore,
} from '../../db/commerce-graph/nativeStoreLinkRepository.js';
import { findConnectionsByStore } from '../../db/connectors/connectionRepository.js';
import { findListingIdsByStore } from '../../db/catalog/listingRepository.js';
import {
  findStoreById,
  findStoresForMember,
  updateStoreColumns,
} from '../../db/stores/storeRepository.js';
import { findVariantsByListing } from '../../db/catalog/variantRepository.js';
import {
  advanceRequestStep,
  claimRequestForApplication,
  completeRequest,
  countLinkageImpact,
  findAppliedRequestForStore,
  findMerchantOfferOverlapInput,
  findStoreLinkageRequestById,
  listCandidates,
  listOfferOverlaps,
  listProfileAdoptions,
  listRequestsForClaimant,
  listRequestsInStates,
  openStoreLinkageRequest,
  recordOfferOverlap,
  recordProfileAdoption,
  releaseRequestWithError,
  resolveStoreForRequest,
  selectCandidate,
  setRequestState,
  updateRequestImpact,
  upsertCandidate,
  type StoreLinkageCandidateRow,
  type StoreLinkageOfferOverlapRow,
  type StoreLinkageProfileAdoptionRow,
  type StoreLinkageRequestRow,
} from '../../db/store-linkage/storeLinkageRepository.js';
import { createStore } from '../store.service.js';
import { linkNativeStore, revokeLink } from '../commerce-graph/native-store-link.service.js';
import { requestNativeOfferSync } from '../offers/native-offer.service.js';
import { effectivePermissions } from '../../middleware/store-authz.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import {
  discoverLinkageCandidates,
  selectAutomaticCandidate,
  type CandidateStoreFacts,
} from './linkage-candidates.js';
import { buildLinkageDiff, planProfileAdoption } from './linkage-diff.js';
import { reconcileMerchantOfferOverlaps } from './offer-overlap.js';
import { requestCanonicalMatching, type CanonicalMatchTarget } from './canonical-matcher.port.js';

/** How long one application attempt may hold the request before it is reclaimable. */
const APPLICATION_LEASE_MS = 2 * 60 * 1_000;

/** The permission linking an EXISTING store demands — #83's, for #83's reason. */
const LINKAGE_PERMISSION = 'store:manage' as const;

/** How many requests one claimant or operator page returns. */
const REQUEST_PAGE_SIZE = 50;

/** A refusal message per block reason. Never names another party's store or merchant. */
const BLOCK_MESSAGES: Record<StoreLinkageBlockReason, string> = {
  store_linked_to_other_merchant:
    'That store is already linked to a different canonical merchant. An operator must resolve the conflict before it can be linked here.',
  merchant_linked_to_other_store:
    'This merchant is already linked to a native store. Correct that link before opening another.',
  claim_not_verified: 'This claim is not verified, so it authorizes no linkage.',
  claim_scope_missing: 'This claim was never verified for this merchant.',
  multiple_candidates:
    'Several of your stores could be this merchant. A reviewer will choose, or you can name one explicitly.',
  store_permission_missing: `Linking a store requires the ${LINKAGE_PERMISSION} permission on it.`,
  no_active_link: 'There is no active link to change.',
  merchant_not_active: 'This merchant is merged or suppressed. Link the winner, or nothing.',
};

/**
 * Map a request row onto its DTO.
 *
 * Every field is named explicitly (the payments status-projection rule), and
 * three things are named by their ABSENCE: the lease owner (an internal worker
 * identity nobody outside the job needs), the claimant's Oxy id (the caller
 * either is them or is an operator who has it another way), and the id of any
 * conflicting link. A `blocked` request says WHY with a code and never names the
 * merchant or store holding the conflict — a claimant learning who else claimed
 * their name is an information leak wearing a helpful error's clothes.
 */
export function toStoreLinkageRequestDTO(row: StoreLinkageRequestRow): StoreLinkageRequest {
  return {
    id: row.id,
    merchantId: row.merchantId,
    claimId: row.claimId,
    mode: row.mode,
    state: row.state,
    step: row.step,
    requestedStoreId: row.requestedStoreId,
    resolvedStoreId: row.resolvedStoreId,
    nativeStoreLinkId: row.nativeStoreLinkId,
    blockReason: row.blockReason,
    reason: row.reason,
    matchState: row.matchState,
    impact: {
      activeListings: row.impactActiveListings,
      nativeOffers: row.impactNativeOffers,
      externalOffers: row.impactExternalOffers,
      storefronts: row.impactStorefronts,
      placedOrders: row.impactPlacedOrders,
      storeMembers: row.impactStoreMembers,
    },
    attempts: row.attempts,
    lastError: row.lastError,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Map a candidate row onto its DTO, re-deriving `autoLinkable` from the tuple. */
export function toStoreLinkageCandidateDTO(row: StoreLinkageCandidateRow): StoreLinkageCandidate {
  return {
    id: row.id,
    requestId: row.requestId,
    storeId: row.storeId,
    source: row.source,
    evidenceRef: row.evidenceRef,
    disposition: row.disposition,
    // Derived from the shared tuple rather than stored, so a change to which
    // evidence may link alone cannot leave a stale `true` on an old row.
    autoLinkable: STORE_LINKAGE_AUTO_LINK_SOURCES.includes(row.source),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Map an adoption row onto its DTO. `previousValue` is the provenance. */
export function toStoreLinkageAdoptionDTO(
  row: StoreLinkageProfileAdoptionRow,
): StoreLinkageProfileAdoption {
  return {
    id: row.id,
    requestId: row.requestId,
    storeId: row.storeId,
    field: row.field,
    source: row.source,
    previousValue: row.previousValue,
    adoptedValue: row.adoptedValue,
    at: row.at.toISOString(),
  };
}

/** Map an overlap finding onto its DTO. Both offer ids survive — nothing was deleted. */
export function toStoreLinkageOverlapDTO(
  row: StoreLinkageOfferOverlapRow,
): StoreLinkageOfferOverlap {
  return {
    id: row.id,
    requestId: row.requestId,
    merchantId: row.merchantId,
    canonicalVariantId: row.canonicalVariantId,
    primaryOfferId: row.primaryOfferId,
    duplicateOfferId: row.duplicateOfferId,
    rule: row.rule,
    detectedAt: row.detectedAt.toISOString(),
  };
}

/** The claim facts linkage reads, resolved once so every branch sees one snapshot. */
interface AuthorizingClaim {
  claimId: string;
  merchantId: string;
  claimantOxyUserId: string;
  intendedStoreId: string | null;
  /** Hostnames the claim actually proved, via the merchant's VERIFIED domains. */
  verifiedDomains: string[];
}

/**
 * Resolve the claim that authorizes a request, or say exactly why it does not.
 *
 * Three separate refusals rather than one, because they mean different things to
 * a claimant: a claim that is not theirs is a 404 (the endpoint must not confirm
 * that a claim id exists), one that is not verified is a block they can clear by
 * finishing verification, and one whose scope never covered the merchant is a
 * block they clear by proving more.
 */
async function authorizingClaim(
  db: DatabaseOrTransaction,
  input: { claimId: string; claimantOxyUserId: string },
): Promise<AuthorizingClaim | StoreLinkageBlockReason> {
  const claim = await findClaimById(db, input.claimId);
  if (!claim || claim.claimantOxyUserId !== input.claimantOxyUserId) {
    throw notFound('Claim not found');
  }
  if (claim.state !== 'verified') return 'claim_not_verified';

  const scopes = await findScopesForClaim(db, claim.id);
  const merchantScoped = scopes.some(
    (scope) =>
      scope.scopeKind === 'merchant' &&
      scope.scopeRef === claim.merchantId &&
      scope.state === 'verified',
  );
  if (!merchantScoped) return 'claim_scope_missing';

  // The proven domains are the merchant's VERIFIED ones, not the claim's
  // requested scope: verification writes them into `merchant_domains` through
  // #54's collision gate, so reading them here asks the graph what was proven
  // rather than asking the claim what was asked for.
  const domains = await listMerchantDomains(db, claim.merchantId);

  return {
    claimId: claim.id,
    merchantId: claim.merchantId,
    claimantOxyUserId: claim.claimantOxyUserId,
    intendedStoreId: claim.nativeStoreId,
    verifiedDomains: domains
      .filter((domain) => domain.status === 'verified')
      .map((domain) => domain.domain),
  };
}

/**
 * The stores this claimant could possibly link, with the facts discovery reads.
 *
 * Scoped to the claimant's OWN memberships and filtered to `store:manage`
 * before anything else looks at them, so a store they cannot manage never
 * reaches the candidate function at all — not as a rejected proposal, not as a
 * count, not as a 403 that would confirm the id exists.
 */
async function manageableStoreFacts(claimantOxyUserId: string): Promise<CandidateStoreFacts[]> {
  const stores = await findStoresForMember(claimantOxyUserId);
  const facts: CandidateStoreFacts[] = [];

  for (const store of stores) {
    const membership = store.members.find((m) => m.oxyUserId === claimantOxyUserId);
    if (!membership || !effectivePermissions(membership).has(LINKAGE_PERMISSION)) continue;

    const connections = await findConnectionsByStore(store.id);
    facts.push({
      storeId: store.id,
      hasStoreManage: true,
      connectedDomains: connections
        .map((connection) => connection.shopDomain)
        .filter((domain): domain is string => domain !== null && domain !== ''),
      connectionIds: connections.map((connection) => connection.id),
    });
  }

  return facts;
}

export interface OpenLinkageRequestParams {
  claimId: string;
  claimantOxyUserId: string;
  mode: Extract<StoreLinkageMode, 'create_store' | 'link_existing'>;
  /** The store the claimant named. Required for `link_existing`, refused otherwise. */
  storeId?: string;
  reason: string;
}

/**
 * Open (or converge on) a linkage request — issue cases 1 through 5.
 *
 * The state it lands in IS the case:
 *
 *  - case 1, no native store → `create_store`, `draft`, ready to apply;
 *  - case 2, the claimant runs the store → `link_existing`, `draft`;
 *  - case 3, several candidates and none named → `awaiting_review`, blocked on
 *    a person by `multiple_candidates`;
 *  - case 4, the store belongs to another merchant → `blocked`, and no amount
 *    of retrying moves it (issue revocation rule 6: a conflicting live link
 *    blocks new activation until it is resolved);
 *  - case 5, one merchant with several storefronts → nothing special, and that
 *    is the point: storefronts already point at the merchant and D4 permits one
 *    active link per merchant, so the several-channel case is the ordinary one.
 *
 * A REPLAY converges on the row that already exists rather than opening a
 * second: the idempotency is `store_linkage_requests_open_key`, a partial unique
 * on a generated key, not a check this function performs.
 */
export async function openLinkageRequest(
  params: OpenLinkageRequestParams,
): Promise<StoreLinkageRequestRow> {
  if (params.reason.trim() === '') {
    throw validationError('Opening a linkage request requires a reason.');
  }
  if ((params.mode === 'link_existing') !== (params.storeId !== undefined)) {
    throw validationError('`storeId` is required for link_existing and refused otherwise.');
  }

  const db = getDb();
  const authorized = await authorizingClaim(db, params);
  if (typeof authorized === 'string') {
    throw conflict(BLOCK_MESSAGES[authorized]);
  }

  const merchant = await findMerchantById(db, authorized.merchantId);
  if (!merchant) throw notFound('Merchant not found');
  if (merchant.status !== 'active') {
    throw conflict(BLOCK_MESSAGES.merchant_not_active);
  }

  const impact = await countLinkageImpact(db, {
    storeId: params.storeId ?? null,
    merchantId: authorized.merchantId,
  });

  const { request } = await openStoreLinkageRequest(db, {
    merchantId: authorized.merchantId,
    claimId: authorized.claimId,
    claimantOxyUserId: params.claimantOxyUserId,
    mode: params.mode,
    requestedStoreId: params.storeId ?? null,
    // The two opening modes end no link, and the CHECK says so — an opening
    // request naming something to supersede is unrepresentable.
    supersedesLinkId: null,
    reason: params.reason,
    impact,
  });

  // A request that already applied is the converged answer to a replay; nothing
  // is re-decided for it, because re-deciding would mean re-reading conflicts
  // against a link this very request wrote.
  if (request.state === 'applied') return request;

  return classifyRequest(db, { request, claim: authorized });
}

/**
 * Decide where a live request stands: ready, waiting on a person, or blocked.
 *
 * Re-run on every open and on every operator decision, deliberately: a conflict
 * that was true an hour ago may have been resolved, and a request that was ready
 * may have been overtaken by somebody else's link. Reading it fresh is what
 * makes `blocked` a current fact rather than a historical one.
 */
async function classifyRequest(
  db: DatabaseOrTransaction,
  input: { request: StoreLinkageRequestRow; claim: AuthorizingClaim },
): Promise<StoreLinkageRequestRow> {
  const { request, claim } = input;

  const merchantLink = await findActiveLinkByMerchant(db, request.merchantId);
  if (merchantLink && merchantLink.storeId !== request.requestedStoreId) {
    return block(db, request, 'merchant_linked_to_other_store');
  }

  if (request.requestedStoreId !== null) {
    const storeLink = await findActiveLinkByStore(db, request.requestedStoreId);
    if (storeLink && storeLink.merchantId !== request.merchantId) {
      // Case 4. The store resolves to somebody else's canonical identity, and
      // an operator correction is the only thing that changes that.
      return block(db, request, 'store_linked_to_other_merchant');
    }
  }

  const facts = await manageableStoreFacts(claim.claimantOxyUserId);

  if (request.requestedStoreId !== null) {
    // Issue existing-store rule 1, the permission half. The membership scan
    // above already dropped every store the claimant cannot manage, so a named
    // store missing from it is a store they may not link.
    if (!facts.some((store) => store.storeId === request.requestedStoreId)) {
      return block(db, request, 'store_permission_missing');
    }
  }

  const candidates = discoverLinkageCandidates({
    claim: {
      verifiedDomains: claim.verifiedDomains,
      // The connector connection a `platform_oauth` claim consumed is not
      // recorded on the claim row (#83 keeps the challenge's subject on the
      // CLAIM and the connection stays the connector's), so linkage proposes on
      // membership and proven domains and leaves the platform-connection source
      // to an operator who can see the connection. Naming it here from a shop
      // NAME would be exactly the inference this issue forbids.
      provenConnectionId: null,
      intendedStoreId: claim.intendedStoreId,
      namedStoreId: request.requestedStoreId,
    },
    stores: facts,
  });

  for (const candidate of candidates) {
    await upsertCandidate(db, {
      requestId: request.id,
      storeId: candidate.storeId,
      source: candidate.source,
      evidenceRef: candidate.evidenceRef,
    });
  }

  if (request.mode === 'create_store') {
    // Creating a store is never ambiguous: it makes a NEW one, so other
    // candidates are irrelevant. The merchant-side conflict above is the only
    // thing that can stop it.
    return (await setRequestState(db, { requestId: request.id, state: 'draft' })) ?? request;
  }

  const automatic = selectAutomaticCandidate({
    candidates,
    namedStoreId: request.requestedStoreId,
  });
  if (!automatic) {
    // Case 3: several native stores may be this merchant, and choosing between
    // them is a decision, not a computation.
    return block(db, request, 'multiple_candidates');
  }

  await selectCandidate(db, { requestId: request.id, storeId: automatic.storeId });
  return (await setRequestState(db, { requestId: request.id, state: 'draft' })) ?? request;
}

/** Move a request to `blocked` with its coded reason, and log the conflict once. */
async function block(
  db: DatabaseOrTransaction,
  request: StoreLinkageRequestRow,
  reason: StoreLinkageBlockReason,
): Promise<StoreLinkageRequestRow> {
  const blocked = await setRequestState(db, {
    requestId: request.id,
    state: reason === 'multiple_candidates' ? 'awaiting_review' : 'blocked',
    ...(reason === 'multiple_candidates' ? {} : { blockReason: reason }),
  });
  log.general.warn(
    { requestId: request.id, merchantId: request.merchantId, reason },
    '[StoreLinkage] a linkage request cannot proceed',
  );
  // `awaiting_review` carries no block reason by CHECK — it is a queue position,
  // not a refusal — so the caller learns the cause from the candidate rows.
  return blocked ?? request;
}

export interface ApplyLinkageRequestParams {
  requestId: string;
  actorOxyUserId: string;
  /** Which safe public fields to adopt from the canonical merchant. May be empty. */
  adoptFields?: readonly StoreLinkageProfileField[];
}

/**
 * Apply a request — the resumable job (issue revocation rule 2, acceptance 4).
 *
 * Five steps, each idempotent, each recorded before the next begins:
 *
 *  1. `store_ready` — create the store (or resolve the named one). The CAS on
 *     `resolved_store_id` is what makes a replay reuse the store the first
 *     attempt made instead of creating a second one, which is also what makes it
 *     reuse the FOLLOW TARGET: a `mercaria.store` target's identity is derived
 *     from the store's immutable id, so one store is one target, always.
 *  2. `link_written` — the `native_store_links` row, through #54's own service.
 *     Its paired partial uniques refuse a duplicate; a repeat that finds the
 *     link already there converges on it rather than failing.
 *  3. `profile_applied` — the fields the owner chose, with what they replaced.
 *  4. `catalog_matching_requested` — #58's seam, fail-closed (see the port).
 *  5. `offers_reconciled` — #57's converger for every listing, then the overlap
 *     findings. No offer row is written here and none is deleted.
 *
 * Steps 3 to 5 run OUTSIDE a single transaction on purpose. Wrapping them would
 * mean a failure in offer reconciliation rolling back a link that is already
 * correct, and the link is the thing the merchant is waiting for; the step
 * cursor is what makes the partial state resumable instead of ambiguous.
 */
export async function applyLinkageRequest(
  params: ApplyLinkageRequestParams,
): Promise<StoreLinkageRequestRow> {
  const db = getDb();
  const now = new Date();
  const leaseOwner = uuidv7();

  const existing = await findStoreLinkageRequestById(db, params.requestId);
  if (!existing) throw notFound('Linkage request not found');
  // A replay of a finished application is the finished application. Returning it
  // rather than refusing is what makes "apply" safe for a client that retried a
  // timed-out request.
  if (existing.state === 'applied') return existing;
  if (existing.state === 'blocked') {
    throw conflict(BLOCK_MESSAGES[existing.blockReason ?? 'no_active_link']);
  }
  if (existing.state === 'rejected' || existing.state === 'abandoned') {
    throw conflict(`A ${existing.state} linkage request cannot be applied.`);
  }

  const claimed = await claimRequestForApplication(db, {
    requestId: params.requestId,
    leaseOwner,
    leaseUntil: new Date(now.getTime() + APPLICATION_LEASE_MS),
    now,
  });
  if (!claimed) {
    throw conflict('This linkage request is being applied by another attempt; retry shortly.');
  }

  try {
    return await runApplication({ request: claimed, leaseOwner, params, now });
  } catch (error) {
    await releaseRequestWithError(db, {
      requestId: params.requestId,
      leaseOwner,
      error: error instanceof Error ? error.message.slice(0, 2_000) : 'unknown error',
    });
    throw error;
  }
}

async function runApplication(args: {
  request: StoreLinkageRequestRow;
  leaseOwner: string;
  params: ApplyLinkageRequestParams;
  now: Date;
}): Promise<StoreLinkageRequestRow> {
  const db = getDb();
  const { leaseOwner, params, now } = args;
  let request = args.request;

  // ── Step 1: the store ────────────────────────────────────────────────────
  let storeId = request.resolvedStoreId;
  if (storeId === null) {
    storeId = request.requestedStoreId ?? (await createStoreForMerchant(request));
    const resolved = await resolveStoreForRequest(db, { requestId: request.id, storeId });
    // An empty result means a concurrent attempt resolved first. Its store is
    // the answer — this attempt's freshly-created one would be the duplicate the
    // CAS exists to prevent, so it is read back rather than used.
    request = resolved ?? (await requireRequest(db, request.id));
    storeId = request.resolvedStoreId ?? storeId;
  }

  // ── Step 2: the link ─────────────────────────────────────────────────────
  const linkId = await ensureNativeStoreLink({
    request,
    storeId,
    actorOxyUserId: params.actorOxyUserId,
  });
  request = (await advanceRequestStep(db, {
    requestId: request.id,
    from: request.step,
    to: 'link_written',
  })) ?? (await requireRequest(db, request.id));

  // ── Step 3: the profile fields the owner chose ───────────────────────────
  await applySelectedProfileFields({
    request,
    storeId,
    adoptFields: params.adoptFields ?? [],
    actorOxyUserId: params.actorOxyUserId,
    now,
  });
  request = (await advanceRequestStep(db, {
    requestId: request.id,
    from: request.step,
    to: 'profile_applied',
  })) ?? (await requireRequest(db, request.id));

  // ── Step 4: #58's seam, fail-closed ──────────────────────────────────────
  const matchState = await requestCatalogMatching(storeId);
  request = (await advanceRequestStep(db, {
    requestId: request.id,
    from: request.step,
    to: 'catalog_matching_requested',
  })) ?? (await requireRequest(db, request.id));

  // ── Step 5: #57's convergence, then the overlap findings ─────────────────
  await reconcileCatalogAndOffers({ request, storeId, now });
  request = (await advanceRequestStep(db, {
    requestId: request.id,
    from: request.step,
    to: 'offers_reconciled',
  })) ?? (await requireRequest(db, request.id));

  await updateRequestImpact(
    db,
    request.id,
    await countLinkageImpact(db, { storeId, merchantId: request.merchantId }),
  );

  const applied = await completeRequest(db, {
    requestId: request.id,
    leaseOwner,
    nativeStoreLinkId: linkId,
    matchState,
    appliedAt: now,
  });
  if (!applied) {
    // The lease was reclaimed mid-run. Whatever finished it is authoritative;
    // this attempt reports what is stored rather than overwriting it.
    return requireRequest(db, request.id);
  }

  log.general.info(
    {
      requestId: applied.id,
      merchantId: applied.merchantId,
      storeId,
      mode: applied.mode,
      linkId,
      matchState,
    },
    '[StoreLinkage] linkage applied',
  );
  return applied;
}

async function requireRequest(
  db: DatabaseOrTransaction,
  requestId: string,
): Promise<StoreLinkageRequestRow> {
  const row = await findStoreLinkageRequestById(db, requestId);
  if (!row) throw notFound('Linkage request not found');
  return row;
}

/**
 * Create the native store through the EXISTING service (issue store-creation
 * rules 1, 2, 3 and 5).
 *
 * `createStore` is called with the claimant as owner, so they get the ordinary
 * 17/17 owner permission set, the handle comes from the ordinary
 * `ensureUniqueSlug` path against `storeHandleExists`, and the default location
 * is created exactly as it is for any other store. Nothing about store creation
 * is special-cased for linkage, which is what rule 1 asks for.
 *
 * The store's NAME is the canonical merchant's, and that is not the silent copy
 * rule 4 forbids: the merchant name is the identity the claimant just PROVED
 * they operate, and a store must be called something at creation. Every
 * subsequent profile change is an explicit, audited adoption
 * (`store_linkage_profile_adoptions`) or the owner's own edit.
 */
async function createStoreForMerchant(request: StoreLinkageRequestRow): Promise<string> {
  const merchant = await findMerchantById(getDb(), request.merchantId);
  if (!merchant) throw notFound('Merchant not found');

  const store = await createStore(request.claimantOxyUserId, {
    name: merchant.name,
    ...(merchant.description !== null ? { description: merchant.description } : {}),
  });
  return store.id;
}

/**
 * Write (or find) the `native_store_links` row, through #54's service.
 *
 * A `correct_link` revokes the superseded link FIRST, because D4 permits one
 * active link per side and the new one cannot be written while the old one holds
 * the key. The revocation is itself audited (actor, time, reason on the row), so
 * a correction leaves two rows that together say what was wrong and what
 * replaced it — which is issue revocation rule 2's auditability.
 *
 * `owner_authentication` is the method: the claimant authenticated as the store's
 * owner under a verified claim. It is not `domain_verification` even when a
 * domain was proven, because what this link records is that the OPERATOR of the
 * store and the operator of the merchant are the same authenticated person.
 */
async function ensureNativeStoreLink(input: {
  request: StoreLinkageRequestRow;
  storeId: string;
  actorOxyUserId: string;
}): Promise<string | null> {
  const db = getDb();
  const { request, storeId } = input;

  if (request.mode === 'unlink') {
    const active = await findActiveLinkByStore(db, storeId);
    // Only the link this request was OPENED about, by id. An unlink that found
    // a different active link has been overtaken — somebody relinked the store
    // in the meantime — and revoking that one would end a linkage nobody asked
    // to end. Converging on "already done" is the honest answer.
    if (!active || active.id !== request.supersedesLinkId) return null;
    await revokeLink({
      linkId: active.id,
      actorOxyUserId: input.actorOxyUserId,
      reason: request.reason,
    });
    return null;
  }

  if (request.mode === 'correct_link' && request.supersedesLinkId !== null) {
    // Revoke the WRONG link first: D4 permits one active link per side, so the
    // corrected one cannot be written while the old one holds the key. Revoking
    // by the id recorded at open time — never by "whatever is active now" —
    // means a correction that ran twice, or that raced another operator, ends
    // exactly the link it was opened about and nothing else.
    const superseded = await findActiveLinkByStore(db, storeId);
    if (superseded && superseded.id === request.supersedesLinkId) {
      await revokeLink({
        linkId: superseded.id,
        actorOxyUserId: input.actorOxyUserId,
        reason: request.reason,
      });
    }
  }

  const existing = await findActiveLinkByStore(db, storeId);
  if (existing) {
    if (existing.merchantId !== request.merchantId) {
      throw conflict(BLOCK_MESSAGES.store_linked_to_other_merchant);
    }
    // Already linked to the right merchant — a resumed attempt, converging.
    return existing.id;
  }

  const link = await linkNativeStore({
    merchantId: request.merchantId,
    storeId,
    method: 'owner_authentication',
    note: `store linkage request ${request.id}`,
    reason: request.reason,
    actorOxyUserId: input.actorOxyUserId,
  });
  return link.id;
}

/**
 * Apply the fields the owner selected, recording what each replaced.
 *
 * The DIFF is the authority on what may be adopted — a selection naming a field
 * the diff marks un-adoptable is dropped, so a client replaying a stale
 * selection cannot clear a store's description through a door built for
 * adopting one. `updateStoreColumns` is the ordinary store update path; there is
 * no linkage-specific write.
 */
async function applySelectedProfileFields(input: {
  request: StoreLinkageRequestRow;
  storeId: string;
  adoptFields: readonly StoreLinkageProfileField[];
  actorOxyUserId: string;
  now: Date;
}): Promise<void> {
  if (input.adoptFields.length === 0) return;

  const db = getDb();
  const diff = await getLinkageDiff({ storeId: input.storeId, merchantId: input.request.merchantId });
  const plan = planProfileAdoption({ diff, selected: input.adoptFields });
  if (plan.length === 0) return;

  await updateStoreColumns(
    input.storeId,
    Object.fromEntries(plan.map((entry) => [entry.field, entry.adoptedValue])),
  );

  for (const entry of plan) {
    await recordProfileAdoption(db, {
      requestId: input.request.id,
      storeId: input.storeId,
      field: entry.field,
      previousValue: entry.previousValue,
      adoptedValue: entry.adoptedValue,
      actorOxyUserId: input.actorOxyUserId,
      at: input.now,
    });
  }
}

/**
 * Hand the store's native variants to #58, through the port.
 *
 * With no matcher registered this returns `matcher_unavailable`, attaches
 * nothing and guesses nothing — see `canonical-matcher.port.ts` for why that is
 * the designed outcome rather than a gap.
 */
async function requestCatalogMatching(storeId: string): Promise<StoreLinkageMatchState> {
  const listingIds = await findListingIdsByStore(storeId);
  const targets: CanonicalMatchTarget[] = [];
  for (const listingId of listingIds) {
    for (const variant of await findVariantsByListing(listingId)) {
      targets.push({ listingId, productVariantId: variant.id });
    }
  }
  const outcome = await requestCanonicalMatching({ storeId, targets });
  return outcome.state;
}

/**
 * Materialize the store's native offers through #57, then record the overlaps.
 *
 * `requestNativeOfferSync` is #57's OWN enqueue — this domain writes no `offers`
 * row and issues no offer DELETE, which is issue catalog rules 2, 3 and 5 held
 * by there being no code that could do otherwise. The enqueue is
 * `ON CONFLICT DO UPDATE` on one row per listing, so requesting convergence for
 * a catalogue twice costs one convergence per listing, not two.
 *
 * Overlap findings are computed from what is active NOW, which after a fresh
 * link is the merchant's external offers plus whatever native offers already
 * materialized. Convergence is asynchronous, so a first run may see none — and
 * that is why the finding is recorded by an idempotent upsert an operator can
 * re-run rather than by a one-shot write.
 */
async function reconcileCatalogAndOffers(input: {
  request: StoreLinkageRequestRow;
  storeId: string;
  now: Date;
}): Promise<void> {
  const db = getDb();

  for (const listingId of await findListingIdsByStore(input.storeId)) {
    await requestNativeOfferSync(listingId);
  }

  const findings = reconcileMerchantOfferOverlaps(
    await findMerchantOfferOverlapInput(db, input.request.merchantId),
  );
  for (const finding of findings) {
    await recordOfferOverlap(db, {
      requestId: input.request.id,
      merchantId: input.request.merchantId,
      canonicalVariantId: finding.canonicalVariantId,
      primaryOfferId: finding.primaryOfferId,
      duplicateOfferId: finding.duplicateOfferId,
      rule: finding.rule,
      detectedAt: input.now,
    });
  }
}

/**
 * The diff a store owner reads before deciding (issue existing-store rule 2).
 *
 * Read-only, and it says so by being callable without a request: a merchant
 * comparing their store against a canonical record has not committed to
 * anything, and an endpoint that opened a workflow row to answer a question
 * would make browsing an act.
 */
export async function getLinkageDiff(input: { storeId: string; merchantId: string }) {
  const db = getDb();
  const [store, merchant] = await Promise.all([
    findStoreById(input.storeId, db),
    findMerchantById(db, input.merchantId),
  ]);
  if (!store) throw notFound('Store not found');
  if (!merchant) throw notFound('Merchant not found');

  const [domains, storefronts, impact] = await Promise.all([
    listMerchantDomains(db, input.merchantId),
    findStorefrontsByMerchant(db, input.merchantId),
    countLinkageImpact(db, { storeId: input.storeId, merchantId: input.merchantId }),
  ]);

  return buildLinkageDiff({
    store: { id: store.id, name: store.name, description: store.description },
    merchant: { id: merchant.id, name: merchant.name, description: merchant.description },
    verifiedDomains: domains
      .filter((domain) => domain.status === 'verified')
      .map((domain) => domain.domain),
    storefronts: storefronts.map((storefront) => ({
      id: storefront.id,
      name: storefront.name,
      domain: storefront.domain,
    })),
    impact: {
      activeListings: impact.impactActiveListings,
      nativeOffers: impact.impactNativeOffers,
      externalOffers: impact.impactExternalOffers,
      storefronts: impact.impactStorefronts,
      placedOrders: impact.impactPlacedOrders,
      storeMembers: impact.impactStoreMembers,
    },
  });
}

// ── Operator paths: review, correction, revocation ──────────────────────────

/**
 * An operator's verdict on a request waiting for one (issue case 3).
 *
 * Approving NAMES the store — a review that only said "yes" would leave the
 * ambiguity that sent it here unresolved. Rejecting closes the request, which
 * releases its idempotency key so the claimant can open a corrected one; the
 * rejected row survives as the record that it was asked and refused.
 */
export async function decideLinkageRequest(params: {
  requestId: string;
  approve: boolean;
  storeId?: string;
  reason: string;
  operatorOxyUserId: string;
}): Promise<StoreLinkageRequestRow> {
  if (params.reason.trim() === '') {
    throw validationError('An operator decision requires a reason.');
  }
  const db = getDb();
  const request = await requireRequest(db, params.requestId);
  if (request.state !== 'awaiting_review' && request.state !== 'blocked') {
    throw conflict(`A ${request.state} request is not awaiting a decision.`);
  }

  if (!params.approve) {
    const rejected = await setRequestState(db, {
      requestId: request.id,
      state: 'rejected',
      decidedByOxyUserId: params.operatorOxyUserId,
      decisionReason: params.reason,
    });
    return rejected ?? request;
  }

  if (params.storeId === undefined) {
    throw validationError('Approving a linkage request must name the store to link.');
  }
  const candidates = await listCandidates(db, request.id);
  if (!candidates.some((candidate) => candidate.storeId === params.storeId)) {
    // Approving a store nobody proposed would let the review surface link ANY
    // store to ANY merchant, which is the power the candidate evidence exists to
    // bound. An operator who believes another store is right records it as an
    // `operator` candidate first, on the record.
    throw conflict('That store is not a candidate on this request.');
  }

  await selectCandidate(db, { requestId: request.id, storeId: params.storeId });
  const approved = await setRequestState(db, {
    requestId: request.id,
    state: 'draft',
    decidedByOxyUserId: params.operatorOxyUserId,
    decisionReason: params.reason,
  });
  log.general.info(
    {
      requestId: request.id,
      merchantId: request.merchantId,
      storeId: params.storeId,
      operatorOxyUserId: params.operatorOxyUserId,
    },
    '[StoreLinkage] an operator resolved a linkage review',
  );
  return approved ?? request;
}

/**
 * Record a store an operator believes is the right one, as `operator` evidence.
 *
 * The candidate table is the bound on what a review may approve, so widening it
 * has to be its own audited act rather than a parameter on the approval. That is
 * what stops "approve any store" existing as a capability while still letting an
 * operator fix a discovery that missed the obvious answer.
 */
export async function proposeOperatorCandidate(params: {
  requestId: string;
  storeId: string;
  reason: string;
  operatorOxyUserId: string;
}): Promise<void> {
  if (params.reason.trim() === '') {
    throw validationError('Proposing a candidate requires a reason.');
  }
  const db = getDb();
  const request = await requireRequest(db, params.requestId);
  const store = await findStoreById(params.storeId, db);
  if (!store) throw notFound('Store not found');

  await upsertCandidate(db, {
    requestId: request.id,
    storeId: params.storeId,
    source: 'operator',
    evidenceRef: null,
  });
  log.general.warn(
    {
      requestId: request.id,
      storeId: params.storeId,
      operatorOxyUserId: params.operatorOxyUserId,
      reason: params.reason,
    },
    '[StoreLinkage] an operator proposed a native store candidate',
  );
}

export interface OpenCorrectionParams {
  storeId: string;
  /** The merchant the store SHOULD resolve to. Omit to unlink without relinking. */
  intendedMerchantId?: string;
  reason: string;
  operatorOxyUserId: string;
}

/**
 * Open a correction or an unlink for a store whose link is wrong (issue case 7).
 *
 * A correction reuses the ORIGINAL request's authorizing claim rather than
 * minting a claimless one, because the claim is what makes a link legitimate and
 * a correction that could invent its own authority would be a way to link any
 * merchant to any store from the operator surface. A store whose link was never
 * opened through a request has no claim to inherit and is refused — such a link
 * is revoked directly through #54's own operator endpoint, which is where a
 * hand-made link belongs.
 *
 * The impact preview is computed and STORED with the request before anything
 * moves, which is issue revocation rule 5: the reason and the preview are both
 * on the record the action produced, not on a screen somebody looked at.
 */
export async function openLinkageCorrection(
  params: OpenCorrectionParams,
): Promise<StoreLinkageRequestRow> {
  if (params.reason.trim() === '') {
    throw validationError('A correction requires a reason.');
  }
  const db = getDb();
  const active = await findActiveLinkByStore(db, params.storeId);
  if (!active) {
    throw conflict(BLOCK_MESSAGES.no_active_link);
  }

  const origin = await findAppliedRequestForStore(db, params.storeId);
  if (!origin) {
    throw conflict(
      'This link was not opened through a linkage request, so there is no claim to correct it under. Revoke it through the native-store-link surface instead.',
    );
  }

  const merchantId = params.intendedMerchantId ?? active.merchantId;
  const merchant = await findMerchantById(db, merchantId);
  if (!merchant) throw notFound('Merchant not found');
  if (merchant.status !== 'active') throw conflict(BLOCK_MESSAGES.merchant_not_active);

  const mode: StoreLinkageMode =
    params.intendedMerchantId === undefined ? 'unlink' : 'correct_link';

  const impact = await countLinkageImpact(db, { storeId: params.storeId, merchantId });
  const { request } = await openStoreLinkageRequest(db, {
    merchantId,
    claimId: origin.claimId,
    claimantOxyUserId: origin.claimantOxyUserId,
    mode,
    requestedStoreId: params.storeId,
    // The link this request ends, named at open time and part of the
    // idempotency key — which is what makes a store correctable more than once
    // while a REPLAY of one correction still converges.
    supersedesLinkId: active.id,
    reason: params.reason,
    impact,
  });

  log.general.warn(
    {
      requestId: request.id,
      storeId: params.storeId,
      fromMerchantId: active.merchantId,
      toMerchantId: merchantId,
      mode,
      operatorOxyUserId: params.operatorOxyUserId,
      reason: params.reason,
    },
    '[StoreLinkage] an operator opened a linkage correction',
  );
  return request;
}

/**
 * Remove the management linkage a revoked claim authorized (issue revocation
 * rule 1) — the AUDITED POLICY, in one place.
 *
 * ## Why this is not called from `revokeClaim`
 *
 * #83's `relationship-isolation.test.ts` fails the build if any module in
 * `services/merchant-claims/` so much as names `native_store_links`, and that is
 * correct: a claim must not be able to grant or withdraw operational access as a
 * side effect. The composition therefore happens one layer out, in the operator
 * controller that performs both acts — two audited records, each with its own
 * actor and reason, in the order a person would do them.
 *
 * ## What it does and does not delete
 *
 * The `native_store_links` row is REVOKED, not deleted: it stays as the history
 * of who operated what and when. The native store keeps its handle, its members,
 * its listings, its orders and its follow target; the canonical merchant keeps
 * its page, its storefronts, its verified domains and its rollups. Issue
 * acceptance 5 in full — a revoked claim does not erase commerce or analytics
 * history — and the only thing that actually changes is that nobody may act as
 * this merchant, which #83's own move of `claim_state` back to `unclaimed`
 * already accomplished.
 */
export async function unlinkOnClaimRevocation(params: {
  merchantId: string;
  operatorOxyUserId: string;
  reason: string;
}): Promise<{ revokedLinkId: string | null }> {
  if (params.reason.trim() === '') {
    throw validationError('Revoking a linkage requires a reason.');
  }
  const db = getDb();
  const active = await findActiveLinkByMerchant(db, params.merchantId);
  if (!active) return { revokedLinkId: null };

  const revoked = await revokeLink({
    linkId: active.id,
    actorOxyUserId: params.operatorOxyUserId,
    reason: `claim revoked: ${params.reason}`,
  });

  log.general.warn(
    {
      linkId: revoked.id,
      merchantId: params.merchantId,
      storeId: revoked.storeId,
      operatorOxyUserId: params.operatorOxyUserId,
    },
    '[StoreLinkage] management linkage removed following a claim revocation',
  );
  return { revokedLinkId: revoked.id };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** One request, scoped to its claimant. A stranger's id answers 404, never 403. */
export async function getRequestForClaimant(
  requestId: string,
  claimantOxyUserId: string,
): Promise<StoreLinkageRequestRow> {
  const request = await requireRequest(getDb(), requestId);
  if (request.claimantOxyUserId !== claimantOxyUserId) {
    throw notFound('Linkage request not found');
  }
  return request;
}

/** Everything a claimant has opened, newest first. */
export async function listRequestsForUser(
  claimantOxyUserId: string,
): Promise<StoreLinkageRequestRow[]> {
  return listRequestsForClaimant(getDb(), claimantOxyUserId, REQUEST_PAGE_SIZE);
}

/** The operator queue: what is waiting on a person or stuck on a conflict. */
export async function listLinkageReviewQueue(): Promise<StoreLinkageRequestRow[]> {
  return listRequestsInStates(getDb(), ['awaiting_review', 'blocked'], REQUEST_PAGE_SIZE);
}

/** One request in full — candidates, adoptions and overlap findings included. */
export async function getRequestDetail(requestId: string) {
  const db = getDb();
  const request = await requireRequest(db, requestId);
  const [candidates, adoptions, overlaps] = await Promise.all([
    listCandidates(db, requestId),
    listProfileAdoptions(db, requestId),
    listOfferOverlaps(db, requestId),
  ]);
  return { request, candidates, adoptions, overlaps };
}

/**
 * The claimant's own permission on a store, for the surface that has to decide
 * whether to offer linkage at all.
 *
 * Exported because the controller needs it before opening a request and the
 * middleware cannot help: `loadStore` reads `:storeId` from the PATH, and here
 * the store arrives in a body alongside a claim.
 */
export async function claimantMayLinkStore(
  storeId: string,
  claimantOxyUserId: string,
): Promise<boolean> {
  const store = await findStoreById(storeId);
  if (!store) return false;
  const membership = store.members.find((m) => m.oxyUserId === claimantOxyUserId);
  return membership !== undefined && effectivePermissions(membership).has(LINKAGE_PERMISSION);
}
