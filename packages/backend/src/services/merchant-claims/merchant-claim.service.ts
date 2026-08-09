/**
 * Merchant claiming — the state machine (#83, epic #40).
 *
 * `merchants.claim_state` is ADR 0002 D9's ONE stored verdict and this module
 * is the only thing that moves it. Everything else here exists to make that
 * move defensible: a proof with a named subject, a scope that says exactly
 * what the proof reached, an audit row per attempt and per decision, and a
 * database constraint standing behind each rule rather than a convention.
 *
 * ## The five properties that are held by the database, not by this file
 *
 *  1. **One verified operator claim per merchant** —
 *     `merchant_claims_merchant_verified_key`. Reaching `verified` on a
 *     merchant somebody already holds is refused by the index, and this module
 *     turns that refusal into a DISPUTE instead of replacing the incumbent
 *     (issue scope rule 6, acceptance 4). The incumbent check is ALSO made
 *     before the write, so the ordinary case is a clean 409 rather than a
 *     rolled-back transaction — but the index is what makes it true under a
 *     race, and the catch below is what makes the racer land in the same place
 *     as the polite caller.
 *  2. **One live claim per (merchant, claimant)** —
 *     `merchant_claims_merchant_claimant_active_key`.
 *  3. **Single-use challenges** — the partial unique on the open challenge plus
 *     a compare-and-swap on `closed_at`, so two concurrent successes produce
 *     one verification (issue acceptance 3).
 *  4. **One verified holder per domain** —
 *     `merchant_domains_domain_verified_key`, #54's collision gate, which this
 *     module deliberately does not pre-check: a read-then-write would be a
 *     second, racier answer to a question the constraint already settles.
 *  5. **A verified/revoked/rejected claim carries its evidence of being one** —
 *     the CHECKs on `merchant_claims`.
 *
 * ## What a verification does, and what it very deliberately does not
 *
 * It moves the claim, the merchant's verdict, the proven domain and the proven
 * storefronts, in ONE transaction. It writes no relationship of any kind: an
 * `Official store` or `Authorized reseller` badge is an evidence-gated
 * `commerce_relationships` row owned by #55 (ADR 0002 D10/D17), so claiming
 * "Apple Store" creates no Apple relationship — there is no code here that
 * could (issue acceptance 6, pinned by `relationship-isolation.test.ts`).
 *
 * It also grants nothing OPERATIONAL. Store members, permissions, inventory
 * and payouts live on the native `stores` row, which meets the graph only
 * through `native_store_links` (ADR 0002 D4) — #84's flow, which reads a
 * verified claim and is not implemented here.
 *
 * ## Revocation preserves everything public (issue acceptance 5)
 *
 * Revoking returns `merchants.claim_state` to `unclaimed` and clears the
 * claimant, which is what removes management access — native-checkout
 * eligibility is DERIVED from that verdict (#54), so it turns false the moment
 * the verdict does. Nothing else is touched: the merchant row, its
 * storefronts, its aliases, its verified domains and its rating/offer rollups
 * all survive byte-for-byte, because public history is not the marketplace's
 * to delete when an operator loses their claim.
 */

import { isUniqueViolation } from '@oxyhq/db';
import type {
  MerchantClaim,
  MerchantClaimChallengeInstructions,
  MerchantClaimEligibility,
  MerchantClaimEvent,
  MerchantClaimEvidence,
  MerchantClaimIneligibilityReason,
  MerchantClaimMethod,
  MerchantClaimOperatorView,
  MerchantClaimRevokeReason,
  MerchantClaimScope,
  MerchantClaimState,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findMerchantById,
  observeMerchantDomain,
  setMerchantClaimVerdict,
  verifyMerchantDomain,
  type MerchantRow,
} from '../../db/commerce-graph/merchantRepository.js';
import {
  findStorefrontsByIds,
  markStorefrontVerified,
  type StorefrontRow,
} from '../../db/commerce-graph/storefrontRepository.js';
import { findStoreById } from '../../db/stores/storeRepository.js';
import {
  consumeChallenge,
  countChallengesForClaimantSince,
  countChallengesForMerchantSince,
  countChallengesForSubjectSince,
  expireClaimIfDue,
  findActiveClaimsForMerchant,
  findClaimById,
  findClaimsByClaimant,
  findClaimsByState,
  findEventsForClaim,
  findOpenChallenge,
  findOpenChallengeDigest,
  findPrivateEvidenceForClaim,
  findScopesForClaim,
  findVerifiedClaimForMerchant,
  insertChallenge,
  insertClaimEvent,
  insertEvidence,
  insertMerchantClaim,
  insertRequestedScopes,
  recordChallengeAttempt,
  setScopeState,
  transitionClaimState,
  type MerchantClaimRow,
  type MerchantClaimScopeRow,
} from '../../db/merchant-claims/merchantClaimRepository.js';
import { config } from '../../config/index.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import { normalizeDomain } from '../commerce-graph/merchant.service.js';
import {
  availableMethodOptions,
  isMethodAvailable,
  methodAssurance,
  methodAutoVerifies,
  methodSpec,
} from './claim-methods.js';
import {
  challengeTokenMatches,
  hasChallengeTokenShape,
  mintChallengeToken,
  CLAIM_META_TAG_NAME,
  CLAIM_WELL_KNOWN_PATH,
} from './challenge-token.js';
import {
  resolveProvenScope,
  type ClaimProofSubject,
  type RequestedScopeEntry,
} from './claim-scope.js';
import {
  claimDnsRecordName,
  claimDnsRecordValue,
  claimSiteRootUrl,
  claimWellKnownUrl,
  verifyDnsTxtChallenge,
  verifyMetaTagChallenge,
  verifyWellKnownFileChallenge,
  type SiteVerificationOutcome,
} from './site-verification.js';
import {
  connectionProofSubject,
  resolveChannelKeyConnection,
  resolveClaimantConnection,
} from './platform-verification.js';
import { notifyOperatorOfContest, notifyOperatorOfRevocation } from './claim-notifications.js';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How many of a claimant's claims one page returns. */
const CLAIMANT_CLAIM_PAGE_SIZE = 50;

/** How many claims one operator queue page returns. */
const OPERATOR_QUEUE_PAGE_SIZE = 100;

// ── Projections ─────────────────────────────────────────────────────────────

/** Map a scope row onto its DTO. */
function toScopeDTO(row: MerchantClaimScopeRow): MerchantClaimScope {
  return {
    kind: row.scopeKind,
    ref: row.scopeRef,
    state: row.state,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
  };
}

/**
 * Map a claim onto the claimant-facing DTO.
 *
 * Every field is named explicitly, and three things are named by their
 * ABSENCE: no evidence, no reviewer identity, and the conflicting claim
 * reduced to a boolean. A claimant in dispute already knows they are; handing
 * them a handle on the incumbent's record tells them about a person instead.
 */
export function toMerchantClaimDTO(
  row: MerchantClaimRow,
  scopes: readonly MerchantClaimScopeRow[],
  now: Date = new Date(),
): MerchantClaim {
  const dtos = scopes.map(toScopeDTO);
  return {
    id: row.id,
    merchantId: row.merchantId,
    claimantOxyUserId: row.claimantOxyUserId,
    method: row.method,
    assurance: methodAssurance(row.method),
    state: row.state,
    nativeStoreId: row.nativeStoreId,
    requestedScope: dtos,
    verifiedScope: dtos.filter((scope) => scope.state === 'verified'),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revalidateAfter: row.revalidateAfter?.toISOString() ?? null,
    revalidationDue: row.revalidateAfter !== null && row.revalidateAfter <= now,
    decisionReason: row.decisionReason,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokeReason: row.revokeReason,
    hasConflictingClaim: row.conflictingClaimId !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Eligibility ─────────────────────────────────────────────────────────────

/**
 * Whether to show `Claim this merchant`, and which proofs this deployment can
 * take (issue API rule 1).
 *
 * Public and evidence-free by construction: it returns a verdict, a coded
 * reason and the method list, and names no claimant, no reviewer and no
 * pending claim's id. `claim_in_progress` says only that somebody is midway —
 * which the button's absence would imply anyway — and never who.
 */
export async function getClaimEligibility(
  merchantId: string,
): Promise<MerchantClaimEligibility> {
  const db = getDb();
  const merchant = await findMerchantById(db, merchantId);
  if (!merchant || merchant.status === 'suppressed') {
    throw notFound('Merchant not found');
  }

  const options = availableMethodOptions();
  const reason = ineligibilityReason(merchant, options.length);
  const active = await findActiveClaimsForMerchant(db, merchant.id);
  return {
    merchantId: merchant.id,
    claimable: reason === null,
    reason,
    // A signal, never a refusal — and a boolean rather than a count, because
    // "three people are claiming this" is information about those people.
    claimInProgress: active.length > 0,
    claimState: merchant.claimState,
    availableMethods: options,
  };
}

/**
 * The single place "can this merchant be claimed" is decided — and the one
 * thing it deliberately does NOT consider is whether somebody else is already
 * claiming.
 *
 * A squatter who opens a claim first must not be able to lock the real
 * operator out, so several claims may be in flight and exactly one of them can
 * reach `verified` (the partial unique index decides which). The eligibility
 * read surfaces that as `claimInProgress`, and `openClaim` reads this function,
 * so the API and the button can never disagree about what is allowed.
 */
function ineligibilityReason(
  merchant: MerchantRow,
  availableMethodCount: number,
): MerchantClaimIneligibilityReason | null {
  if (availableMethodCount === 0) return 'claiming_disabled';
  // A merged tombstone or a retired row is not a thing to become the operator
  // of — the winner is (ADR 0002 D12), and the claimant reaches it through the
  // merchant page's own redirect.
  if (merchant.status !== 'active') return 'merchant_not_active';
  if (merchant.claimState === 'claimed') return 'already_claimed';
  return null;
}

// ── Opening a claim ─────────────────────────────────────────────────────────

export interface OpenClaimParams {
  merchantId: string;
  claimantOxyUserId: string;
  method: MerchantClaimMethod;
  /** Required for every domain-subject method; refused for the others. */
  domain?: string;
  /** Required for every connection-subject method; refused for the others. */
  connectionId?: string;
  /** Storefronts the claimant wants this proof to cover. May be empty. */
  storefrontIds?: readonly string[];
  /** The native store this claim intends to link to once verified (#84). */
  nativeStoreId?: string;
}

/**
 * Open a claim, recording its subject and its REQUESTED scope.
 *
 * The subject is resolved here rather than at challenge time, because it is
 * the claim's identity: re-issuing an expired challenge must not be a way to
 * change what is being proved after the scope was recorded.
 *
 * The claim does NOT enter `challenge_pending` yet — a `draft` is a claim
 * whose scope is agreed and whose proof has not started, and separating the
 * two is what makes the issuance budget a budget on CHALLENGES rather than on
 * intentions.
 */
export async function openClaim(params: OpenClaimParams): Promise<MerchantClaimRow> {
  const db = getDb();

  if (!isMethodAvailable(params.method)) {
    throw validationError(
      `The ${params.method} verification method is not available on this deployment.`,
    );
  }

  const merchant = await findMerchantById(db, params.merchantId);
  if (!merchant || merchant.status === 'suppressed') {
    throw notFound('Merchant not found');
  }
  const ineligible = ineligibilityReason(merchant, availableMethodOptions().length);
  if (ineligible !== null) {
    throw conflict(claimRefusalMessage(ineligible));
  }

  const subject = await resolveSubject(params);
  const requested = await buildRequestedScope({
    merchantId: merchant.id,
    storefrontIds: params.storefrontIds ?? [],
    subject,
  });

  if (params.nativeStoreId !== undefined) {
    await assertClaimantMayNameStore(params.nativeStoreId, params.claimantOxyUserId);
  }

  const now = new Date();
  return db.transaction(async (tx) => {
    const claim = await insertMerchantClaim(tx, {
      merchantId: merchant.id,
      claimantOxyUserId: params.claimantOxyUserId,
      method: params.method,
      ...(subject !== null ? { subject } : {}),
      ...(params.nativeStoreId !== undefined ? { nativeStoreId: params.nativeStoreId } : {}),
      expiresAt: new Date(now.getTime() + config.merchantClaims.attemptTtlHours * HOUR_MS),
    });
    if (!claim) {
      throw conflict('You already have a claim in progress for this merchant.');
    }
    await insertRequestedScopes(tx, claim.id, requested);
    await insertClaimEvent(tx, {
      claimId: claim.id,
      action: 'created',
      actorKind: 'claimant',
      actorOxyUserId: params.claimantOxyUserId,
      toState: claim.state,
      at: now,
    });
    return claim;
  });
}

/** The message for each coded refusal. Says nothing about who holds a claim. */
function claimRefusalMessage(reason: MerchantClaimIneligibilityReason): string {
  switch (reason) {
    case 'already_claimed':
      return 'This merchant already has a verified operator. Contest the existing claim instead.';
    case 'merchant_not_active':
      return 'This merchant cannot be claimed.';
    case 'claiming_disabled':
      return 'Merchant claiming is not available on this deployment.';
  }
}

/**
 * Resolve the claim's proof subject from what the claimant supplied, refusing
 * anything the method does not take.
 *
 * The `.strict()` request schema already stops unknown fields; this stops
 * KNOWN fields arriving for the wrong method, which is the shape that would
 * otherwise let a `business_document` claim carry a domain nothing ever checks.
 */
async function resolveSubject(
  params: OpenClaimParams,
): Promise<{ kind: 'domain' | 'connection'; ref: string } | null> {
  const spec = methodSpec(params.method);

  if (spec.subjectKind === null) {
    if (params.domain !== undefined || params.connectionId !== undefined) {
      throw validationError('A business-document claim takes no domain or connection.');
    }
    return null;
  }

  if (spec.subjectKind === 'domain') {
    if (params.connectionId !== undefined) {
      throw validationError('A domain proof takes no connection.');
    }
    if (params.domain === undefined) {
      throw validationError('This verification method needs a domain.');
    }
    return { kind: 'domain', ref: normalizeDomain(params.domain) };
  }

  if (spec.subjectKind === 'connection') {
    if (params.domain !== undefined) {
      throw validationError('A platform proof takes no domain.');
    }
    if (params.connectionId === undefined) {
      throw validationError('This verification method needs a platform connection.');
    }
    // Authorization is checked NOW, at open, not only at verify: a claimant who
    // cannot manage the connection has nothing to prove with, and finding that
    // out after publishing instructions wastes their time and our budget.
    const connection = await resolveClaimantConnection({
      connectionId: params.connectionId,
      claimantOxyUserId: params.claimantOxyUserId,
    });
    return { kind: 'connection', ref: connection.id };
  }

  // `email` — the only remaining subject kind, and every method carrying it is
  // unavailable, so `openClaim`'s availability gate has already refused.
  throw validationError('This verification method is not available on this deployment.');
}

/**
 * The requested scope: always the merchant, the subject domain when there is
 * one, and every storefront the claimant named.
 *
 * A named storefront belonging to a DIFFERENT merchant is refused outright
 * rather than recorded as `out_of_scope`: it is not a proof that fell short,
 * it is a request that does not make sense, and accepting it would put another
 * merchant's channel id into this claim's record.
 */
async function buildRequestedScope(params: {
  merchantId: string;
  storefrontIds: readonly string[];
  subject: { kind: 'domain' | 'connection'; ref: string } | null;
}): Promise<RequestedScopeEntry[] > {
  const entries: RequestedScopeEntry[] = [{ kind: 'merchant', ref: params.merchantId }];
  if (params.subject !== null && params.subject.kind === 'domain') {
    entries.push({ kind: 'domain', ref: params.subject.ref });
  }
  if (params.storefrontIds.length === 0) return entries;

  const rows = await findStorefrontsByIds(getDb(), params.storefrontIds);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of params.storefrontIds) {
    const row = byId.get(id);
    if (!row || row.merchantId !== params.merchantId) {
      throw validationError(`Storefront ${id} does not belong to this merchant.`);
    }
    entries.push({ kind: 'storefront', ref: id });
  }
  return entries;
}

/**
 * A claimant may only name a native store they are actually a member of.
 *
 * The claim records an INTENT to link (#84 performs the link), and an intent
 * naming somebody else's store is a request to put their store id on a
 * stranger's record — refused with the same 404 an unknown id gets, so the
 * endpoint cannot be used to test whether a store id exists.
 */
async function assertClaimantMayNameStore(
  storeId: string,
  claimantOxyUserId: string,
): Promise<void> {
  const store = await findStoreById(storeId);
  if (!store || !store.members.some((m) => m.oxyUserId === claimantOxyUserId)) {
    throw notFound('Store not found');
  }
}

// ── Challenges ──────────────────────────────────────────────────────────────

/**
 * Issue a challenge and return the instructions, INCLUDING the one-time token.
 *
 * The token exists in a response body exactly once, here, and the server keeps
 * only its SHA-256 (`challenge-token.ts`). Issuing a new challenge closes the
 * previous one in the SAME transaction — the partial unique permits one open
 * challenge per claim, and doing it in two statements outside a transaction
 * would leave a claim with none at all if the second failed.
 */
export async function issueChallenge(params: {
  claimId: string;
  claimantOxyUserId: string;
}): Promise<MerchantClaimChallengeInstructions> {
  const db = getDb();
  const claim = await loadClaimForClaimant(params.claimId, params.claimantOxyUserId);

  if (claim.subjectKind === null || claim.subjectRef === null) {
    throw validationError(
      'This claim is decided by document review; there is no challenge to issue.',
    );
  }
  if (claim.state !== 'draft' && claim.state !== 'challenge_pending') {
    throw conflict(`A claim in state ${claim.state} cannot be given a new challenge.`);
  }

  await assertIssuanceBudget(db, claim);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.merchantClaims.challengeTtlMinutes * MINUTE_MS);
  const minted = mintChallengeToken();

  const challenge = await db.transaction(async (tx) => {
    const open = await findOpenChallenge(tx, claim.id);
    if (open) {
      // The previous attempt is SUPERSEDED, not abandoned: the distinction is
      // the difference between "the claimant asked for a new one" and "this
      // one ran out", and an operator reading the trail needs both.
      await consumeChallenge(tx, { challengeId: open.id, reason: 'superseded', at: now });
    }
    const inserted = await insertChallenge(tx, {
      claimId: claim.id,
      tokenHash: minted.tokenHash,
      expiresAt,
    });
    if (!inserted) {
      // The partial unique refused it, which after the close above can only
      // mean a concurrent issuance won. A retry is the honest answer.
      throw conflict('A challenge was issued concurrently; fetch the claim and try again.');
    }
    if (claim.state === 'draft') {
      await transitionClaimState(tx, {
        claimId: claim.id,
        expected: ['draft'],
        next: 'challenge_pending',
      });
    }
    await insertClaimEvent(tx, {
      claimId: claim.id,
      action: 'challenge_issued',
      actorKind: 'claimant',
      actorOxyUserId: params.claimantOxyUserId,
      fromState: claim.state,
      toState: 'challenge_pending',
      at: now,
    });
    return inserted;
  });

  return buildInstructions(claim, challenge.id, minted.token, expiresAt);
}

/**
 * The three DURABLE issuance budgets (issue security control 1).
 *
 * Counted in Postgres rather than a per-instance bucket because two of the
 * three questions — "how often has this MERCHANT been challenged" and "how
 * often has this DOMAIN been challenged" — are about everybody's activity
 * across every ECS task, which an in-memory limiter cannot see at all. The
 * fourth axis, the network, is the `rl:merchant-claims:` HTTP limiter.
 */
async function assertIssuanceBudget(
  db: DatabaseOrTransaction,
  claim: MerchantClaimRow,
): Promise<void> {
  const since = new Date(Date.now() - HOUR_MS);
  const [byUser, byMerchant, bySubject] = await Promise.all([
    countChallengesForClaimantSince(db, claim.claimantOxyUserId, since),
    countChallengesForMerchantSince(db, claim.merchantId, since),
    claim.subjectKind !== null && claim.subjectRef !== null
      ? countChallengesForSubjectSince(db, { kind: claim.subjectKind, ref: claim.subjectRef }, since)
      : Promise.resolve(0),
  ]);

  const limits = config.merchantClaims;
  if (
    byUser >= limits.maxChallengesPerUserPerHour ||
    byMerchant >= limits.maxChallengesPerMerchantPerHour ||
    bySubject >= limits.maxChallengesPerDomainPerHour
  ) {
    // ONE message for all three, deliberately: telling a caller WHICH budget
    // they hit tells them how much of somebody else's activity is on the same
    // merchant or the same domain.
    log.general.warn(
      { claimId: claim.id, byUser, byMerchant, bySubject },
      '[MerchantClaim] challenge issuance budget exhausted',
    );
    throw conflict('Too many verification challenges have been issued recently. Try again later.');
  }
}

/** Compose the per-method instructions a claimant acts on. */
function buildInstructions(
  claim: MerchantClaimRow,
  challengeId: string,
  token: string,
  expiresAt: Date,
): MerchantClaimChallengeInstructions {
  const subjectKind = claim.subjectKind;
  const subjectRef = claim.subjectRef;
  if (subjectKind === null || subjectRef === null) {
    throw validationError('This claim has no challenge subject.');
  }
  const base: MerchantClaimChallengeInstructions = {
    challengeId,
    method: claim.method,
    subjectKind,
    subject: subjectRef,
    expiresAt: expiresAt.toISOString(),
  };
  // The token travels only for the methods whose proof IS the token; a
  // platform proof is made with a credential the claimant already holds, and
  // sending them a token they cannot use invites them to paste it somewhere.
  if (!methodSpec(claim.method).tokenIsCarriedByClaimant) {
    return base;
  }
  base.token = token;
  switch (claim.method) {
    case 'dns_txt':
      base.dnsRecordName = claimDnsRecordName(subjectRef);
      base.dnsRecordValue = claimDnsRecordValue(token);
      return base;
    case 'well_known_file':
      base.filePath = CLAIM_WELL_KNOWN_PATH;
      base.fileContents = token;
      return base;
    case 'meta_tag':
      base.metaTagName = CLAIM_META_TAG_NAME;
      base.metaTagContent = token;
      return base;
    default:
      return base;
  }
}

// ── Verification ────────────────────────────────────────────────────────────

export interface VerifyClaimParams {
  claimId: string;
  claimantOxyUserId: string;
  /** The one-time token, for every method whose proof IS the token. */
  token?: string;
  /** The channel key, for `channel_key`. */
  channelKey?: string;
}

/**
 * Attempt to complete a claim's challenge.
 *
 * The order is deliberate and each step refuses on its own terms: the claim
 * must be the caller's and in `challenge_pending`; the challenge must be open
 * and unexpired; the attempt is COUNTED before the proof is sought, so a
 * failing poll costs budget; the proof is made; and only then is the challenge
 * consumed and the claim moved, in one transaction.
 */
export async function verifyClaim(params: VerifyClaimParams): Promise<MerchantClaimRow> {
  const db = getDb();
  const claim = await loadClaimForClaimant(params.claimId, params.claimantOxyUserId);
  if (claim.state !== 'challenge_pending') {
    throw conflict(`A claim in state ${claim.state} has no challenge to verify.`);
  }

  const digest = await findOpenChallengeDigest(db, claim.id);
  if (!digest) {
    throw conflict('This claim has no open challenge. Request a new one.');
  }
  const now = new Date();
  if (digest.expiresAt <= now) {
    // Expiry is recorded, not silently retried: an expired challenge that
    // stays open would be indistinguishable from one nobody tried.
    await db.transaction(async (tx) => {
      await consumeChallenge(tx, { challengeId: digest.id, reason: 'expired', at: now });
      await insertClaimEvent(tx, {
        claimId: claim.id,
        action: 'challenge_failed',
        actorKind: 'system',
        reason: 'expired',
        at: now,
      });
    });
    throw conflict('This challenge has expired. Request a new one.');
  }

  const attempts = await recordAttempt(db, claim, digest.id, params.claimantOxyUserId, now);
  if (attempts > config.merchantClaims.maxAttemptsPerChallenge) {
    throw conflict('Too many verification attempts on this challenge. Request a new one.');
  }

  const proof = await makeProof({ claim, digest, params });

  return completeVerification({ claim, challengeId: digest.id, proof, at: new Date() });
}

/** Count the attempt and leave a trace of it, whatever the outcome turns out to be. */
async function recordAttempt(
  db: DatabaseOrTransaction,
  claim: MerchantClaimRow,
  challengeId: string,
  actorOxyUserId: string,
  at: Date,
): Promise<number> {
  return db.transaction(async (tx) => {
    const attempts = await recordChallengeAttempt(tx, challengeId, at);
    await insertClaimEvent(tx, {
      claimId: claim.id,
      action: 'challenge_attempted',
      actorKind: 'claimant',
      actorOxyUserId,
      at,
    });
    return attempts;
  });
}

/**
 * Make the method's proof, returning what it established.
 *
 * Every branch ends in a SUBJECT — the thing scope resolution then measures
 * requested entries against — and no branch returns "true": a proof that
 * cannot say what it proved is exactly how a Shopify account becomes evidence
 * about every brand the shop sells (issue scope rule 2).
 */
async function makeProof(args: {
  claim: MerchantClaimRow;
  digest: { id: string; tokenHash: string };
  params: VerifyClaimParams;
}): Promise<ClaimProofSubject> {
  const { claim, digest, params } = args;
  const spec = methodSpec(claim.method);

  if (spec.tokenIsCarriedByClaimant) {
    const presented = params.token ?? '';
    // The shape gate first, so obvious garbage costs no comparison; the accept
    // decision is then a constant-time compare against the stored digest —
    // never `!==`, and never a database equality.
    if (!hasChallengeTokenShape(presented) || !challengeTokenMatches(presented, digest.tokenHash)) {
      throw validationError('That verification token does not match this claim.');
    }
  }

  if (claim.subjectRef === null) {
    throw validationError('This claim has no challenge subject.');
  }

  switch (claim.method) {
    case 'dns_txt': {
      assertSiteProof(
        await verifyDnsTxtChallenge({
          domain: claim.subjectRef,
          expectedValue: claimDnsRecordValue(params.token ?? ''),
        }),
        claimDnsRecordName(claim.subjectRef),
      );
      return { kind: 'domain', domain: claim.subjectRef };
    }
    case 'well_known_file': {
      assertSiteProof(
        await verifyWellKnownFileChallenge({
          domain: claim.subjectRef,
          expectedToken: params.token ?? '',
        }),
        claimWellKnownUrl(claim.subjectRef),
      );
      return { kind: 'domain', domain: claim.subjectRef };
    }
    case 'meta_tag': {
      assertSiteProof(
        await verifyMetaTagChallenge({
          domain: claim.subjectRef,
          expectedToken: params.token ?? '',
        }),
        claimSiteRootUrl(claim.subjectRef),
      );
      return { kind: 'domain', domain: claim.subjectRef };
    }
    case 'platform_oauth': {
      const connection = await resolveClaimantConnection({
        connectionId: claim.subjectRef,
        claimantOxyUserId: claim.claimantOxyUserId,
      });
      return connectionProofSubject(connection);
    }
    case 'channel_key': {
      const connection = await resolveChannelKeyConnection({
        channelKey: params.channelKey ?? '',
        claimantOxyUserId: claim.claimantOxyUserId,
      });
      // The key must be bound to the connection this CLAIM named. A key for
      // another of the store's sites proves control of that other site, which
      // is exactly the scope confusion issue method 4 says to avoid.
      if (connection.id !== claim.subjectRef) {
        throw validationError('That channel key belongs to a different connection.');
      }
      return connectionProofSubject(connection);
    }
    case 'role_email':
    case 'business_document':
      // Neither reaches here: `business_document` has no challenge, and
      // `role_email` is refused at open by the availability gate. Refusing
      // rather than falling through keeps the switch exhaustive without a
      // default that would silently absorb a future method.
      throw validationError('This verification method has no automatic proof.');
  }
}

/** Turn a site-check failure into an answer the claimant can act on. */
function assertSiteProof(outcome: SiteVerificationOutcome, where: string): void {
  if (outcome === null) return;
  if (outcome === 'blocked_address') {
    // Named distinctly because it is not a "publish it and try again" problem:
    // the host resolves somewhere Mercaria will never fetch from.
    throw validationError(`${where} does not resolve to a public address.`);
  }
  throw validationError(`The verification value was not found at ${where}.`);
}

// ── Completing a verification ───────────────────────────────────────────────

/**
 * Consume the challenge, resolve scope and move everything the proof earned —
 * in ONE transaction, so a claim can never be verified with its merchant left
 * unclaimed or its scope unrecorded.
 *
 * A lower-assurance method stops at `review_pending`: `methodAutoVerifies` is
 * the ONLY thing consulted, there is no per-claim override, and this is where
 * issue acceptance 2 ("a matching email domain alone cannot complete a claim")
 * is enforced.
 */
async function completeVerification(args: {
  claim: MerchantClaimRow;
  challengeId: string;
  proof: ClaimProofSubject;
  at: Date;
}): Promise<MerchantClaimRow> {
  const { claim, challengeId, proof, at } = args;
  const db = getDb();
  const autoVerifies = methodAutoVerifies(claim.method);

  // The incumbent is read BEFORE the write so the ordinary conflict is a clean
  // dispute rather than a rolled-back transaction. The unique index below is
  // what makes it true under a race; this is what makes it cheap.
  if (autoVerifies) {
    const incumbent = await findVerifiedClaimForMerchant(db, claim.merchantId);
    if (incumbent && incumbent.id !== claim.id) {
      return raiseDispute({ claim, incumbent, challengeId, at });
    }
  }

  try {
    return await db.transaction(async (tx) => {
      const consumed = await consumeChallenge(tx, {
        challengeId,
        reason: 'verified',
        at,
        requireUnexpiredAt: at,
      });
      if (!consumed) {
        // Somebody else consumed it, or it expired between the read and here.
        // Either way this attempt has nothing left to verify.
        throw conflict('This challenge is no longer open. Request a new one.');
      }

      await applyProvenScope(tx, claim, proof, at);

      const next: MerchantClaimState = autoVerifies ? 'verified' : 'review_pending';
      const moved = await transitionClaimState(tx, {
        claimId: claim.id,
        expected: ['challenge_pending'],
        next,
        patch: autoVerifies
          ? {
              verifiedAt: at,
              expiresAt: null,
              revalidateAfter: new Date(
                at.getTime() + config.merchantClaims.revalidateAfterDays * DAY_MS,
              ),
            }
          : {},
      });
      if (!moved) {
        throw conflict('This claim changed while it was being verified. Fetch it and try again.');
      }

      if (autoVerifies) {
        await applyVerificationEffects(tx, claim, proof, at);
      }

      await insertClaimEvent(tx, {
        claimId: claim.id,
        action: 'challenge_verified',
        actorKind: 'system',
        fromState: 'challenge_pending',
        toState: next,
        at,
      });
      if (!autoVerifies) {
        await insertClaimEvent(tx, {
          claimId: claim.id,
          action: 'submitted_for_review',
          actorKind: 'system',
          reason: `assurance=${methodAssurance(claim.method)}`,
          at,
        });
      }
      return moved;
    });
  } catch (error) {
    // The RACER's landing place. `isUniqueViolation` walks the cause chain —
    // drizzle wraps the driver's error, so a bare `error.code` read sees
    // nothing.
    if (isUniqueViolation(error, 'merchant_claims_merchant_verified_key')) {
      const incumbent = await findVerifiedClaimForMerchant(db, claim.merchantId);
      if (incumbent && incumbent.id !== claim.id) {
        return raiseDispute({ claim, incumbent, challengeId, at });
      }
    }
    if (isUniqueViolation(error, 'merchant_domains_domain_verified_key')) {
      // #54's collision gate. Deliberately not pre-checked — a read-then-write
      // would be a second, racier answer to a question the constraint settles.
      throw conflict(
        'That domain is already verified for another merchant. Contest that claim instead.',
      );
    }
    throw error;
  }
}

/**
 * Write the scope verdicts: what the proof reached, and what it did not.
 *
 * Both directions are recorded. A storefront the proof missed becomes
 * `out_of_scope` rather than being left as `requested`, so a claimant can see
 * WHICH channel their Shopify proof did not cover — which is issue scope rule
 * 4 in practice: one claim covering one storefront while the others stay
 * unclaimed is a visible outcome, not a silence.
 */
async function applyProvenScope(
  tx: DatabaseOrTransaction,
  claim: MerchantClaimRow,
  proof: ClaimProofSubject,
  at: Date,
): Promise<void> {
  const requested = await findScopesForClaim(tx, claim.id);
  const storefrontIds = requested
    .filter((row) => row.scopeKind === 'storefront')
    .map((row) => row.scopeRef);
  const storefronts = await findStorefrontsByIds(tx, storefrontIds);

  const resolved = resolveProvenScope({
    merchantId: claim.merchantId,
    requested: requested.map((row) => ({ kind: row.scopeKind, ref: row.scopeRef })),
    proof,
    storefronts: storefronts.map((row: StorefrontRow) => ({
      id: row.id,
      merchantId: row.merchantId,
      provider: row.provider,
      externalShopId: row.externalShopId,
      domain: row.domain,
    })),
  });

  for (const entry of resolved) {
    await setScopeState(tx, {
      claimId: claim.id,
      kind: entry.kind,
      ref: entry.ref,
      state: entry.state,
      verifiedAt: entry.state === 'verified' ? at : null,
    });
  }
}

/**
 * What a VERIFIED claim changes in the canonical graph: the merchant's stored
 * verdict, the proven domain, and the proven storefronts.
 *
 * The list is short on purpose. Everything a claim does NOT do — relationships,
 * badges, store membership, native links, offers, ratings — is absent because
 * there is no line here that could do it, which is what makes issue acceptance
 * 6 a property of the code rather than a promise about it.
 */
async function applyVerificationEffects(
  tx: DatabaseOrTransaction,
  claim: MerchantClaimRow,
  proof: ClaimProofSubject,
  at: Date,
): Promise<void> {
  await setMerchantClaimVerdict(tx, {
    merchantId: claim.merchantId,
    claimState: 'claimed',
    claimedByOxyUserId: claim.claimantOxyUserId,
    claimedAt: at,
  });

  // A domain proof verifies the domain in #54's own table, so the graph's
  // collision gate — one verified holder per domain — governs it. The
  // observation is recorded first because verification confirms a recorded
  // fact and never invents one (`verifyMerchantDomain` returns nothing for a
  // domain this merchant was never observed at).
  const provenDomain = proof.kind === 'domain' ? proof.domain : proof.shopDomain;
  if (provenDomain !== null) {
    await observeMerchantDomain(tx, {
      merchantId: claim.merchantId,
      domain: provenDomain,
      observedAt: at,
      note: `merchant claim ${claim.id}`,
    });
    await verifyMerchantDomain(tx, {
      merchantId: claim.merchantId,
      domain: provenDomain,
      verifiedAt: at,
      verifiedByOxyUserId: claim.claimantOxyUserId,
    });
  }

  const scopes = await findScopesForClaim(tx, claim.id);
  for (const scope of scopes) {
    if (scope.scopeKind !== 'storefront' || scope.state !== 'verified') continue;
    await markStorefrontVerified(tx, {
      storefrontId: scope.scopeRef,
      merchantId: claim.merchantId,
      verifiedAt: at,
    });
  }
}

/**
 * Two claimants, one merchant: the second one DISPUTES rather than replaces.
 *
 * Issue scope rule 6 and acceptance 4, and the shape matters. The incumbent
 * stays `verified` and keeps management access; the challenger's claim becomes
 * `disputed` and names what it disputes; the challenge is consumed, so the
 * proof is spent and not replayable; and the incumbent is NOTIFIED, because a
 * contest they never hear about is one they cannot answer.
 */
async function raiseDispute(args: {
  claim: MerchantClaimRow;
  incumbent: MerchantClaimRow;
  challengeId: string;
  at: Date;
}): Promise<MerchantClaimRow> {
  const { claim, incumbent, challengeId, at } = args;
  const db = getDb();
  const disputed = await db.transaction(async (tx) => {
    await consumeChallenge(tx, { challengeId, reason: 'verified', at });
    const moved = await transitionClaimState(tx, {
      claimId: claim.id,
      expected: ['challenge_pending'],
      next: 'disputed',
      patch: { conflictingClaimId: incumbent.id, expiresAt: null },
    });
    if (!moved) {
      throw conflict('This claim changed while it was being verified. Fetch it and try again.');
    }
    await insertClaimEvent(tx, {
      claimId: claim.id,
      action: 'disputed',
      actorKind: 'system',
      fromState: claim.state,
      toState: 'disputed',
      reason: 'a verified operator claim already exists for this merchant',
      at,
    });
    return moved;
  });

  await notifyOperatorOfContest({
    incumbentOxyUserId: incumbent.claimantOxyUserId,
    merchantId: claim.merchantId,
  });
  log.general.warn(
    { claimId: claim.id, incumbentClaimId: incumbent.id, merchantId: claim.merchantId },
    '[MerchantClaim] a proven claim conflicts with the current verified operator',
  );
  return disputed;
}

// ── Document review and contesting ──────────────────────────────────────────

/**
 * Submit a `business_document` claim for review, with its evidence.
 *
 * The evidence is references — an Oxy file id, a digest, a note — never a
 * document: files belong to Oxy, and a `mercaria.co` URL a reviewer's browser
 * resolved would tell this host when its content was under review (the
 * moderation-evidence decision, applied here for the same reason).
 */
export async function submitForReview(params: {
  claimId: string;
  claimantOxyUserId: string;
  evidence: readonly { oxyFileId?: string; sha256?: string; note?: string; url?: string }[];
}): Promise<MerchantClaimRow> {
  const claim = await loadClaimForClaimant(params.claimId, params.claimantOxyUserId);
  if (claim.method !== 'business_document') {
    throw validationError('Only a business-document claim is submitted for review directly.');
  }
  if (claim.state !== 'draft') {
    throw conflict(`A claim in state ${claim.state} cannot be submitted for review.`);
  }
  if (params.evidence.length === 0) {
    throw validationError('A document review needs at least one piece of evidence.');
  }

  const at = new Date();
  return getDb().transaction(async (tx) => {
    for (const item of params.evidence) {
      await insertEvidence(tx, {
        claimId: claim.id,
        kind: 'business_document',
        ...(item.oxyFileId !== undefined ? { oxyFileId: item.oxyFileId } : {}),
        ...(item.sha256 !== undefined ? { sha256: item.sha256 } : {}),
        ...(item.note !== undefined ? { note: item.note } : {}),
        ...(item.url !== undefined ? { url: item.url } : {}),
        collectedByOxyUserId: params.claimantOxyUserId,
        collectedAt: at,
      });
    }
    const moved = await transitionClaimState(tx, {
      claimId: claim.id,
      expected: ['draft'],
      next: 'review_pending',
    });
    if (!moved) {
      throw conflict('This claim changed while it was being submitted. Fetch it and try again.');
    }
    await insertClaimEvent(tx, {
      claimId: claim.id,
      action: 'evidence_added',
      actorKind: 'claimant',
      actorOxyUserId: params.claimantOxyUserId,
      at,
    });
    await insertClaimEvent(tx, {
      claimId: claim.id,
      action: 'submitted_for_review',
      actorKind: 'claimant',
      actorOxyUserId: params.claimantOxyUserId,
      fromState: 'draft',
      toState: 'review_pending',
      at,
    });
    return moved;
  });
}

/**
 * Contest an incorrect existing claim (issue API rule 7).
 *
 * A contest is a claim that starts in `disputed`: it names the incumbent, it
 * carries the contestant's statement as evidence, and it is decided by a human
 * — there is no automatic path from here to `verified`, because "somebody else
 * says the current operator is wrong" is precisely the case a machine cannot
 * settle. The incumbent is notified, because a contest they never hear about
 * is one they cannot answer.
 */
export async function contestClaim(params: {
  merchantId: string;
  claimantOxyUserId: string;
  reason: string;
  evidence?: readonly { oxyFileId?: string; sha256?: string; note?: string; url?: string }[];
}): Promise<MerchantClaimRow> {
  const db = getDb();
  const merchant = await findMerchantById(db, params.merchantId);
  if (!merchant || merchant.status === 'suppressed') {
    throw notFound('Merchant not found');
  }
  const incumbent = await findVerifiedClaimForMerchant(db, merchant.id);
  if (!incumbent) {
    throw conflict('This merchant has no verified claim to contest. Open a claim instead.');
  }
  if (incumbent.claimantOxyUserId === params.claimantOxyUserId) {
    throw conflict('You already hold the verified claim on this merchant.');
  }

  const at = new Date();
  const contest = await db.transaction(async (tx) => {
    const claim = await insertMerchantClaim(tx, {
      merchantId: merchant.id,
      claimantOxyUserId: params.claimantOxyUserId,
      // A contest is decided by a human reading what the contestant supplied,
      // which is exactly `business_document`'s shape — and it carries no
      // subject, so no automatic proof path exists for it at all.
      method: 'business_document',
      state: 'disputed',
      conflictingClaimId: incumbent.id,
      // A disputed claim carries no deadline: it is waiting on a person, and
      // expiring it would resolve the dispute in the incumbent's favour by
      // timeout rather than by decision.
      expiresAt: null,
    });
    if (!claim) {
      throw conflict('You already have a claim in progress for this merchant.');
    }
    await insertRequestedScopes(tx, claim.id, [{ kind: 'merchant', ref: merchant.id }]);
    await insertEvidence(tx, {
      claimId: claim.id,
      kind: 'contest_statement',
      note: params.reason,
      collectedByOxyUserId: params.claimantOxyUserId,
      collectedAt: at,
    });
    for (const item of params.evidence ?? []) {
      await insertEvidence(tx, {
        claimId: claim.id,
        kind: 'business_document',
        ...(item.oxyFileId !== undefined ? { oxyFileId: item.oxyFileId } : {}),
        ...(item.sha256 !== undefined ? { sha256: item.sha256 } : {}),
        ...(item.note !== undefined ? { note: item.note } : {}),
        ...(item.url !== undefined ? { url: item.url } : {}),
        collectedByOxyUserId: params.claimantOxyUserId,
        collectedAt: at,
      });
    }
    await insertClaimEvent(tx, {
      claimId: claim.id,
      action: 'disputed',
      actorKind: 'claimant',
      actorOxyUserId: params.claimantOxyUserId,
      toState: 'disputed',
      reason: params.reason,
      at,
    });
    return claim;
  });

  await notifyOperatorOfContest({
    incumbentOxyUserId: incumbent.claimantOxyUserId,
    merchantId: merchant.id,
  });
  return contest;
}

// ── Claimant reads ──────────────────────────────────────────────────────────

/**
 * Load a claim the caller owns, expiring it lazily if its deadline passed.
 *
 * The lazy expiry is `guest_sessions`' idle-expiry rule: the deadline is
 * enforced where it is observed, so a stored state and a stored deadline
 * cannot disagree. A claim that belongs to somebody else answers 404 and not
 * 403 — a 403 would confirm the id names a real claim.
 */
async function loadClaimForClaimant(
  claimId: string,
  claimantOxyUserId: string,
): Promise<MerchantClaimRow> {
  const db = getDb();
  const row = await findClaimById(db, claimId);
  if (!row || row.claimantOxyUserId !== claimantOxyUserId) {
    throw notFound('Claim not found');
  }
  return expireIfDue(db, row);
}

/** The lazy expiry itself, shared by every read path. */
async function expireIfDue(
  db: DatabaseOrTransaction,
  row: MerchantClaimRow,
): Promise<MerchantClaimRow> {
  const now = new Date();
  if (row.expiresAt === null || row.expiresAt > now) return row;
  const expired = await expireClaimIfDue(db, row.id, now);
  if (!expired) return row;
  await insertClaimEvent(db, {
    claimId: row.id,
    action: 'expired',
    actorKind: 'system',
    fromState: row.state,
    toState: 'expired',
    at: now,
  });
  return expired;
}

/** State polling (issue API rule 5) — no evidence, no reviewer, no incumbent id. */
export async function getClaimForClaimant(
  claimId: string,
  claimantOxyUserId: string,
): Promise<MerchantClaim> {
  const claim = await loadClaimForClaimant(claimId, claimantOxyUserId);
  const scopes = await findScopesForClaim(getDb(), claim.id);
  return toMerchantClaimDTO(claim, scopes);
}

/** Every claim a caller has opened, newest first. */
export async function listClaimsForClaimant(
  claimantOxyUserId: string,
): Promise<MerchantClaim[]> {
  const db = getDb();
  const rows = await findClaimsByClaimant(db, claimantOxyUserId, CLAIMANT_CLAIM_PAGE_SIZE);
  const out: MerchantClaim[] = [];
  for (const row of rows) {
    const claim = await expireIfDue(db, row);
    out.push(toMerchantClaimDTO(claim, await findScopesForClaim(db, claim.id)));
  }
  return out;
}

// ── Operator surface ────────────────────────────────────────────────────────

/** The review queue, oldest first — the order a queue is worked in. */
export async function listClaimsForReview(
  states: readonly MerchantClaimState[],
): Promise<MerchantClaim[]> {
  const db = getDb();
  const rows = await findClaimsByState(db, states, OPERATOR_QUEUE_PAGE_SIZE);
  const out: MerchantClaim[] = [];
  for (const row of rows) {
    out.push(toMerchantClaimDTO(row, await findScopesForClaim(db, row.id)));
  }
  return out;
}

/**
 * The full operator view — and the ACCESS is audited before the evidence is
 * returned (issue security control 6).
 *
 * The audit row is written first, in the same call, so a read that fails
 * afterwards still leaves the trace: "who looked" must not depend on the
 * request finishing.
 */
export async function getClaimForOperator(
  claimId: string,
  operatorOxyUserId: string,
): Promise<MerchantClaimOperatorView> {
  const db = getDb();
  const claim = await findClaimById(db, claimId);
  if (!claim) {
    throw notFound('Claim not found');
  }

  await insertClaimEvent(db, {
    claimId: claim.id,
    action: 'evidence_accessed',
    actorKind: 'operator',
    actorOxyUserId: operatorOxyUserId,
    at: new Date(),
  });

  const [scopes, events, evidence] = await Promise.all([
    findScopesForClaim(db, claim.id),
    findEventsForClaim(db, claim.id),
    findPrivateEvidenceForClaim(db, claim.id),
  ]);

  return {
    claim: toMerchantClaimDTO(claim, scopes),
    conflictingClaimId: claim.conflictingClaimId,
    reviewedByOxyUserId: claim.reviewedByOxyUserId,
    reviewedAt: claim.reviewedAt?.toISOString() ?? null,
    events: events.map(
      (row): MerchantClaimEvent => ({
        id: row.id,
        action: row.action,
        actorKind: row.actorKind,
        actorOxyUserId: row.actorOxyUserId,
        fromState: row.fromState,
        toState: row.toState,
        reason: row.reason,
        at: row.at.toISOString(),
      }),
    ),
    evidence: evidence.map(
      (row): MerchantClaimEvidence => ({
        id: row.id,
        kind: row.kind,
        oxyFileId: row.oxyFileId,
        sha256: row.sha256,
        note: row.note,
        collectedByOxyUserId: row.collectedByOxyUserId,
        collectedAt: row.collectedAt.toISOString(),
      }),
    ),
  };
}

/**
 * An operator's decision on a claim awaiting one.
 *
 * `verify` from `review_pending` or `disputed`; `reject` from either. A
 * verification here goes through the SAME unique index every automatic one
 * does, so an operator cannot hand a merchant a second verified operator by
 * accident — the write is refused and reported as a conflict naming the
 * incumbent.
 */
export async function decideClaim(params: {
  claimId: string;
  decision: 'verify' | 'reject';
  reason: string;
  operatorOxyUserId: string;
}): Promise<MerchantClaimRow> {
  const db = getDb();
  const claim = await findClaimById(db, params.claimId);
  if (!claim) {
    throw notFound('Claim not found');
  }
  if (claim.state !== 'review_pending' && claim.state !== 'disputed') {
    throw conflict(`A claim in state ${claim.state} is not awaiting a decision.`);
  }

  const at = new Date();
  if (params.decision === 'reject') {
    return db.transaction(async (tx) => {
      const moved = await transitionClaimState(tx, {
        claimId: claim.id,
        expected: ['review_pending', 'disputed'],
        next: 'rejected',
        patch: {
          reviewedByOxyUserId: params.operatorOxyUserId,
          reviewedAt: at,
          decisionReason: params.reason,
          expiresAt: null,
        },
      });
      if (!moved) {
        throw conflict('This claim changed while it was being decided.');
      }
      await insertClaimEvent(tx, {
        claimId: claim.id,
        action: 'rejected',
        actorKind: 'operator',
        actorOxyUserId: params.operatorOxyUserId,
        fromState: claim.state,
        toState: 'rejected',
        reason: params.reason,
        at,
      });
      return moved;
    });
  }

  const incumbent = await findVerifiedClaimForMerchant(db, claim.merchantId);
  if (incumbent && incumbent.id !== claim.id) {
    // The dispute must be RESOLVED, not overwritten: revoke the incumbent
    // first, deliberately as a separate audited act, then verify this one.
    throw conflict(
      `Merchant ${claim.merchantId} already has a verified claim (${incumbent.id}). ` +
        'Revoke it first, then verify this one.',
    );
  }

  try {
    return await db.transaction(async (tx) => {
      const moved = await transitionClaimState(tx, {
        claimId: claim.id,
        expected: ['review_pending', 'disputed'],
        next: 'verified',
        patch: {
          reviewedByOxyUserId: params.operatorOxyUserId,
          reviewedAt: at,
          decisionReason: params.reason,
          verifiedAt: at,
          expiresAt: null,
          revalidateAfter: new Date(
            at.getTime() + config.merchantClaims.revalidateAfterDays * DAY_MS,
          ),
        },
      });
      if (!moved) {
        throw conflict('This claim changed while it was being decided.');
      }
      await setMerchantClaimVerdict(tx, {
        merchantId: claim.merchantId,
        claimState: 'claimed',
        claimedByOxyUserId: claim.claimantOxyUserId,
        claimedAt: at,
      });
      // The merchant scope is what an operator decision proves: a human said
      // this account operates this merchant. Domain and storefront scopes are
      // NOT swept in — a reviewer verifying a business document has not
      // verified control of a website, and marking them would launder one kind
      // of evidence into another.
      await setScopeState(tx, {
        claimId: claim.id,
        kind: 'merchant',
        ref: claim.merchantId,
        state: 'verified',
        verifiedAt: at,
      });
      await insertClaimEvent(tx, {
        claimId: claim.id,
        action: claim.state === 'disputed' ? 'dispute_resolved' : 'verified',
        actorKind: 'operator',
        actorOxyUserId: params.operatorOxyUserId,
        fromState: claim.state,
        toState: 'verified',
        reason: params.reason,
        at,
      });
      return moved;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'merchant_claims_merchant_verified_key')) {
      throw conflict('Another verified claim for this merchant appeared; re-read and retry.');
    }
    throw error;
  }
}

/**
 * Withdraw a verification (issue scope rule 7).
 *
 * The claim becomes `revoked` and the merchant returns to `unclaimed` with no
 * claimant — which is what removes management access, since native-checkout
 * eligibility is DERIVED from that verdict (#54). Nothing else moves: the
 * merchant, its storefronts, its verified domains and its rollups are all left
 * exactly as they are, because a revoked operator does not make the
 * marketplace's public record of that merchant wrong (issue acceptance 5).
 *
 * The former operator is notified, because losing a claim silently is
 * indistinguishable from a bug.
 */
export async function revokeClaim(params: {
  claimId: string;
  reason: MerchantClaimRevokeReason;
  note: string;
  operatorOxyUserId: string;
}): Promise<MerchantClaimRow> {
  const db = getDb();
  const claim = await findClaimById(db, params.claimId);
  if (!claim) {
    throw notFound('Claim not found');
  }
  if (claim.state !== 'verified') {
    throw conflict(`A claim in state ${claim.state} has no verification to revoke.`);
  }

  const at = new Date();
  const revoked = await db.transaction(async (tx) => {
    const moved = await transitionClaimState(tx, {
      claimId: claim.id,
      expected: ['verified'],
      next: 'revoked',
      patch: {
        revokedAt: at,
        revokedByOxyUserId: params.operatorOxyUserId,
        revokeReason: params.reason,
        decisionReason: params.note,
        revalidateAfter: null,
      },
    });
    if (!moved) {
      throw conflict('This claim changed while it was being revoked.');
    }
    await setMerchantClaimVerdict(tx, {
      merchantId: claim.merchantId,
      claimState: 'unclaimed',
      claimedByOxyUserId: null,
      claimedAt: null,
    });
    await insertClaimEvent(tx, {
      claimId: claim.id,
      action: 'revoked',
      actorKind: 'operator',
      actorOxyUserId: params.operatorOxyUserId,
      fromState: 'verified',
      toState: 'revoked',
      reason: `${params.reason}: ${params.note}`,
      at,
    });
    return moved;
  });

  await notifyOperatorOfRevocation({
    formerOperatorOxyUserId: claim.claimantOxyUserId,
    merchantId: claim.merchantId,
    reason: params.reason,
  });
  log.general.warn(
    {
      claimId: claim.id,
      merchantId: claim.merchantId,
      reason: params.reason,
      operatorOxyUserId: params.operatorOxyUserId,
    },
    '[MerchantClaim] a verified merchant claim was revoked',
  );
  return revoked;
}
