/**
 * Merchant claiming against a REAL PostgreSQL database — issue #83's
 * acceptance criteria, every one of which is held by a partial unique index, a
 * CHECK or a compare-and-swap that does not exist under a mocked repository.
 *
 * What is checked here and could not be checked anywhere else:
 *
 *  - two conflicting claimants cannot both become the sole verified operator
 *    (acceptance 4) — a partial unique index on `(merchant_id) WHERE state =
 *    'verified'`, exercised both as the polite path and as a direct write;
 *  - a challenge is single-use and an expired one verifies nothing
 *    (acceptance 3) — a CAS on `closed_at`, and a token that resolves only to
 *    its OWN claim;
 *  - revocation removes management access and preserves public history
 *    (acceptance 5) — compared field by field against a snapshot;
 *  - a `low`-assurance method cannot reach `verified` without a human
 *    (acceptance 2) — the operator decision is the only path;
 *  - the claim state machine's CHECKs refuse a verification with no time, a
 *    revocation with no actor, a rejection with no reviewer, and a dispute
 *    with nothing to dispute.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every name, slug, domain and actor id this file
 * writes carries a per-run suffix, and teardown deletes exactly what it
 * created — children first, and disputes neutralized before deletion because
 * `conflicting_claim_id` is RESTRICT.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, isNotNull } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { merchantDomains, merchants, storefronts } from '../schema/merchants.js';
import {
  merchantClaimChallenges,
  merchantClaimEvents,
  merchantClaimEvidence,
  merchantClaimScopes,
  merchantClaims,
} from '../schema/merchantClaims.js';
import {
  consumeChallenge,
  findEventsForClaim,
  findOpenChallenge,
  findOpenChallengeDigest,
  findPrivateEvidenceForClaim,
  findScopesForClaim,
  insertChallenge,
  insertEvidence,
} from '../merchant-claims/merchantClaimRepository.js';
import { createMerchant, getMerchantPublic } from '../../services/commerce-graph/merchant.service.js';
import { createStorefront } from '../../services/commerce-graph/storefront.service.js';
import {
  contestClaim,
  decideClaim,
  getClaimEligibility,
  getClaimForClaimant,
  getClaimForOperator,
  issueChallenge,
  listClaimsForReview,
  openClaim,
  revokeClaim,
  submitForReview,
  verifyClaim,
} from '../../services/merchant-claims/merchant-claim.service.js';
import { challengeTokenMatches, mintChallengeToken } from '../../services/merchant-claims/challenge-token.js';
import { isMercariaError } from '../../lib/errors/error-codes.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const createdMerchantIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  if (createdMerchantIds.length > 0) {
    const claimIds = (
      await db
        .select({ id: merchantClaims.id })
        .from(merchantClaims)
        .where(inArray(merchantClaims.merchantId, createdMerchantIds))
    ).map((row) => row.id);
    if (claimIds.length > 0) {
      // Neutralize the RESTRICT self-reference before deleting, the same shape
      // `merged_into_id` needs in the commerce-graph teardown.
      await db
        .update(merchantClaims)
        .set({ state: 'draft', conflictingClaimId: null })
        .where(inArray(merchantClaims.id, claimIds));
      // Children first; the cascades would handle these, but doing it
      // explicitly makes a wrong order loud rather than silent.
      await db.delete(merchantClaimEvents).where(inArray(merchantClaimEvents.claimId, claimIds));
      await db
        .delete(merchantClaimEvidence)
        .where(inArray(merchantClaimEvidence.claimId, claimIds));
      await db
        .delete(merchantClaimChallenges)
        .where(inArray(merchantClaimChallenges.claimId, claimIds));
      await db.delete(merchantClaimScopes).where(inArray(merchantClaimScopes.claimId, claimIds));
      await db.delete(merchantClaims).where(inArray(merchantClaims.id, claimIds));
    }
    await db.delete(storefronts).where(inArray(storefronts.merchantId, createdMerchantIds));
    await db.delete(merchants).where(inArray(merchants.id, createdMerchantIds));
  }
  await closePostgres();
});

/** Create a merchant through the real service and register it for teardown. */
async function mintMerchant(label: string): Promise<string> {
  const merchant = await createMerchant({ name: `${label} ${RUN}` });
  createdMerchantIds.push(merchant.id);
  return merchant.id;
}

/** A distinct Oxy account id per case — Oxy owns identity, so any string is one. */
function actor(label: string): string {
  return `claimant-${label}-${RUN}`;
}

/**
 * Drive a `business_document` claim all the way to `verified` through the
 * paths a real claimant and a real operator use.
 *
 * The document method is the one whose whole flow runs without a network: DNS
 * and HTTP proofs need a zone and a web server, which a test cannot conjure —
 * their scope arithmetic is pinned in `claim-scope.test.ts` and their SSRF
 * behaviour in `site-verification.test.ts`, against the real guard.
 */
async function verifiedDocumentClaim(params: {
  merchantId: string;
  claimant: string;
  operator: string;
}): Promise<string> {
  const claim = await openClaim({
    merchantId: params.merchantId,
    claimantOxyUserId: params.claimant,
    method: 'business_document',
  });
  await submitForReview({
    claimId: claim.id,
    claimantOxyUserId: params.claimant,
    evidence: [{ note: 'Companies House extract' }],
  });
  await decideClaim({
    claimId: claim.id,
    decision: 'verify',
    reason: 'Register extract matches the merchant name and address.',
    operatorOxyUserId: params.operator,
  });
  return claim.id;
}

describe('acceptance 4 — two conflicting claimants cannot both be the sole verified operator', () => {
  it('refuses a SECOND verified claim on one merchant at the database', async () => {
    const merchantId = await mintMerchant('Double Verify');
    const first = await verifiedDocumentClaim({
      merchantId,
      claimant: actor('dv-a'),
      operator: 'operator-1',
    });
    expect(first).toBeTruthy();

    // The direct write, bypassing every service check: the index alone must
    // refuse it, because that is what holds under a race.
    await expect(
      db.insert(merchantClaims).values({
        merchantId,
        claimantOxyUserId: actor('dv-b'),
        method: 'business_document',
        state: 'verified',
        verifiedAt: new Date(),
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isUniqueViolation(error, 'merchant_claims_merchant_verified_key'),
      'expected merchant_claims_merchant_verified_key to refuse the second verified claim',
    );

    const verified = await db
      .select()
      .from(merchantClaims)
      .where(eq(merchantClaims.merchantId, merchantId));
    expect(verified.filter((row) => row.state === 'verified')).toHaveLength(1);
  });

  it('sends a contest to DISPUTE and leaves the incumbent verified (scope rule 6)', async () => {
    const merchantId = await mintMerchant('Contested');
    const incumbent = actor('con-a');
    const challenger = actor('con-b');
    const incumbentClaimId = await verifiedDocumentClaim({
      merchantId,
      claimant: incumbent,
      operator: 'operator-1',
    });

    const contest = await contestClaim({
      merchantId,
      claimantOxyUserId: challenger,
      reason: 'We are the real operator; the current claim was made by a former reseller.',
    });

    expect(contest.state).toBe('disputed');
    expect(contest.conflictingClaimId).toBe(incumbentClaimId);
    // The incumbent is NOT replaced, and keeps management access.
    const [incumbentRow] = await db
      .select()
      .from(merchantClaims)
      .where(eq(merchantClaims.id, incumbentClaimId));
    expect(incumbentRow?.state).toBe('verified');
    const [merchant] = await db.select().from(merchants).where(eq(merchants.id, merchantId));
    expect(merchant?.claimState).toBe('claimed');
    expect(merchant?.claimedByOxyUserId).toBe(incumbent);
  });

  it('refuses to verify a disputant while the incumbent still holds the claim', async () => {
    const merchantId = await mintMerchant('Dispute Order');
    const incumbentClaimId = await verifiedDocumentClaim({
      merchantId,
      claimant: actor('do-a'),
      operator: 'operator-1',
    });
    const contest = await contestClaim({
      merchantId,
      claimantOxyUserId: actor('do-b'),
      reason: 'The incumbent lost control of the business in a sale last year.',
    });

    // An operator cannot resolve a dispute by verifying the challenger: that
    // would leave two verified claims, so revoking is a separate, audited act.
    await expect(
      decideClaim({
        claimId: contest.id,
        decision: 'verify',
        reason: 'Challenger produced a sale agreement.',
        operatorOxyUserId: 'operator-1',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isMercariaError(error) && error.httpStatus === 409,
      'expected a 409 while the incumbent is still verified',
    );

    await revokeClaim({
      claimId: incumbentClaimId,
      reason: 'operator_correction',
      note: 'Business was sold; the incumbent is no longer the operator.',
      operatorOxyUserId: 'operator-1',
    });
    const resolved = await decideClaim({
      claimId: contest.id,
      decision: 'verify',
      reason: 'Challenger produced a sale agreement.',
      operatorOxyUserId: 'operator-1',
    });
    expect(resolved.state).toBe('verified');

    const rows = await db
      .select()
      .from(merchantClaims)
      .where(eq(merchantClaims.merchantId, merchantId));
    expect(rows.filter((row) => row.state === 'verified')).toHaveLength(1);
    // The revoked claim survives as history rather than being deleted.
    expect(rows.filter((row) => row.state === 'revoked')).toHaveLength(1);
  });

  it('refuses a second LIVE claim by the same claimant on one merchant', async () => {
    const merchantId = await mintMerchant('One Live Claim');
    const claimant = actor('olc');
    await openClaim({ merchantId, claimantOxyUserId: claimant, method: 'business_document' });
    await expect(
      openClaim({ merchantId, claimantOxyUserId: claimant, method: 'business_document' }),
    ).rejects.toSatisfy(
      (error: unknown) => isMercariaError(error) && error.httpStatus === 409,
      'expected a 409 from merchant_claims_merchant_claimant_active_key',
    );
  });
});

describe('acceptance 3 — a replayed, stolen or expired challenge verifies nothing', () => {
  it('is single-use: consuming twice succeeds exactly once', async () => {
    const merchantId = await mintMerchant('Single Use');
    const claimant = actor('su');
    const claim = await openClaim({
      merchantId,
      claimantOxyUserId: claimant,
      method: 'dns_txt',
      domain: `single-use-${RUN}.example.com`,
    });
    await issueChallenge({ claimId: claim.id, claimantOxyUserId: claimant });

    const open = await findOpenChallenge(db, claim.id);
    expect(open).toBeDefined();
    const at = new Date();
    const first = await consumeChallenge(db, {
      challengeId: open?.id ?? '',
      reason: 'verified',
      at,
    });
    const second = await consumeChallenge(db, {
      challengeId: open?.id ?? '',
      reason: 'verified',
      at,
    });
    expect(first).toBeDefined();
    // The compare-and-swap on `closed_at IS NULL` — not a flag somebody
    // remembered to check.
    expect(second).toBeUndefined();
  });

  it('refuses to consume an EXPIRED challenge', async () => {
    const merchantId = await mintMerchant('Expired Challenge');
    const claim = await openClaim({
      merchantId,
      claimantOxyUserId: actor('ec'),
      method: 'dns_txt',
      domain: `expired-${RUN}.example.com`,
    });
    const past = new Date(Date.now() - 60_000);
    const challenge = await insertChallenge(db, {
      claimId: claim.id,
      tokenHash: mintChallengeToken().tokenHash,
      expiresAt: past,
    });
    expect(challenge).toBeDefined();

    const consumed = await consumeChallenge(db, {
      challengeId: challenge?.id ?? '',
      reason: 'verified',
      at: new Date(),
      requireUnexpiredAt: new Date(),
    });
    expect(consumed).toBeUndefined();
  });

  it("cannot use one claim's token against ANOTHER claim", async () => {
    const merchantA = await mintMerchant('Token Owner');
    const merchantB = await mintMerchant('Token Thief');
    const claimantA = actor('to-a');
    const claimantB = actor('to-b');

    const claimA = await openClaim({
      merchantId: merchantA,
      claimantOxyUserId: claimantA,
      method: 'dns_txt',
      domain: `owner-${RUN}.example.com`,
    });
    const claimB = await openClaim({
      merchantId: merchantB,
      claimantOxyUserId: claimantB,
      method: 'dns_txt',
      domain: `thief-${RUN}.example.com`,
    });

    const instructionsA = await issueChallenge({
      claimId: claimA.id,
      claimantOxyUserId: claimantA,
    });
    await issueChallenge({ claimId: claimB.id, claimantOxyUserId: claimantB });

    const digestB = await findOpenChallengeDigest(db, claimB.id);
    expect(digestB).toBeDefined();
    expect(instructionsA.token).toBeDefined();
    // The token published in A's DNS record is public. It still resolves only
    // to A's challenge, so presenting it against B's claim fails the digest
    // comparison outright — before any DNS lookup is attempted.
    expect(challengeTokenMatches(instructionsA.token ?? '', digestB?.tokenHash ?? '')).toBe(false);

    await expect(
      verifyClaim({ claimId: claimB.id, claimantOxyUserId: claimantB, token: instructionsA.token }),
    ).rejects.toSatisfy(
      (error: unknown) => isMercariaError(error) && error.httpStatus === 400,
      "expected a 400 for another claim's token",
    );
  });

  it("refuses a stranger's claim id outright, without saying it exists", async () => {
    const merchantId = await mintMerchant('Not Yours');
    const claim = await openClaim({
      merchantId,
      claimantOxyUserId: actor('ny-owner'),
      method: 'business_document',
    });
    await expect(getClaimForClaimant(claim.id, actor('ny-stranger'))).rejects.toSatisfy(
      (error: unknown) => isMercariaError(error) && error.httpStatus === 404,
      'expected a 404 rather than a 403, which would confirm the id',
    );
  });

  it('keeps at most ONE open challenge per claim, superseding the previous one', async () => {
    const merchantId = await mintMerchant('Supersede');
    const claimant = actor('sup');
    const claim = await openClaim({
      merchantId,
      claimantOxyUserId: claimant,
      method: 'meta_tag',
      domain: `supersede-${RUN}.example.com`,
    });
    const first = await issueChallenge({ claimId: claim.id, claimantOxyUserId: claimant });
    const second = await issueChallenge({ claimId: claim.id, claimantOxyUserId: claimant });
    expect(second.challengeId).not.toBe(first.challengeId);

    const rows = await db
      .select()
      .from(merchantClaimChallenges)
      .where(eq(merchantClaimChallenges.claimId, claim.id));
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.closedAt === null)).toHaveLength(1);
    expect(rows.find((row) => row.id === first.challengeId)?.closedReason).toBe('superseded');
  });
});

describe('acceptance 2 — a low-assurance proof cannot complete a claim on its own', () => {
  it('refuses to open a claim with the email method at all', async () => {
    const merchantId = await mintMerchant('Email Method');
    await expect(
      openClaim({
        merchantId,
        claimantOxyUserId: actor('em'),
        method: 'role_email',
        domain: `email-${RUN}.example.com`,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isMercariaError(error) && error.httpStatus === 400,
      'expected a 400: Mercaria has no email transport, so the method is not offered',
    );
  });

  it('never offers the email method in the eligibility read', async () => {
    const merchantId = await mintMerchant('Eligibility Methods');
    const eligibility = await getClaimEligibility(merchantId);
    expect(eligibility.claimable).toBe(true);
    expect(eligibility.availableMethods.map((option) => option.method)).not.toContain('role_email');
    // Nothing offered may auto-verify on low assurance.
    for (const option of eligibility.availableMethods) {
      if (option.assurance === 'low') expect(option.autoVerifies).toBe(false);
    }
  });

  it('sends a document claim to a human, and only a human verifies it', async () => {
    const merchantId = await mintMerchant('Document Review');
    const claimant = actor('dr');
    const claim = await openClaim({
      merchantId,
      claimantOxyUserId: claimant,
      method: 'business_document',
    });
    expect(claim.state).toBe('draft');
    expect(claim.subjectKind).toBeNull();

    const submitted = await submitForReview({
      claimId: claim.id,
      claimantOxyUserId: claimant,
      evidence: [{ note: 'VAT registration certificate', sha256: 'a'.repeat(64) }],
    });
    expect(submitted.state).toBe('review_pending');

    // The merchant is NOT claimed by a submission — only by a decision.
    const [beforeDecision] = await db
      .select()
      .from(merchants)
      .where(eq(merchants.id, merchantId));
    expect(beforeDecision?.claimState).toBe('unclaimed');

    const queue = await listClaimsForReview(['review_pending']);
    expect(queue.some((entry) => entry.id === claim.id)).toBe(true);

    const decided = await decideClaim({
      claimId: claim.id,
      decision: 'verify',
      reason: 'Certificate matches the merchant’s registered name.',
      operatorOxyUserId: 'operator-2',
    });
    expect(decided.state).toBe('verified');
    const [afterDecision] = await db.select().from(merchants).where(eq(merchants.id, merchantId));
    expect(afterDecision?.claimState).toBe('claimed');
    expect(afterDecision?.claimedByOxyUserId).toBe(claimant);
  });

  it('records a rejection with its reviewer and reason, and refuses one without', async () => {
    const merchantId = await mintMerchant('Rejection');
    const claimant = actor('rej');
    const claim = await openClaim({
      merchantId,
      claimantOxyUserId: claimant,
      method: 'business_document',
    });
    await submitForReview({
      claimId: claim.id,
      claimantOxyUserId: claimant,
      evidence: [{ note: 'a screenshot' }],
    });
    const rejected = await decideClaim({
      claimId: claim.id,
      decision: 'reject',
      reason: 'A screenshot is not a business document.',
      operatorOxyUserId: 'operator-2',
    });
    expect(rejected.state).toBe('rejected');
    expect(rejected.reviewedByOxyUserId).toBe('operator-2');

    // A rejection is ALWAYS a human decision; the CHECK makes an anonymous one
    // unrepresentable rather than merely discouraged.
    await expect(
      db.insert(merchantClaims).values({
        merchantId,
        claimantOxyUserId: actor('rej-2'),
        method: 'business_document',
        state: 'rejected',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isCheckViolation(error, 'merchant_claims_rejected_state_check'),
      'expected merchant_claims_rejected_state_check to refuse an anonymous rejection',
    );
  });
});

describe('acceptance 5 — revocation removes management access and preserves public history', () => {
  it('returns the merchant to unclaimed while leaving every public field untouched', async () => {
    const merchantId = await mintMerchant('Revoked Operator');
    const claimant = actor('rev');
    await createStorefront({
      merchantId,
      name: `Revoked Operator Shop ${RUN}`,
      channelKind: 'web',
      domain: `revoked-${RUN}.example.com`,
    });
    const claimId = await verifiedDocumentClaim({
      merchantId,
      claimant,
      operator: 'operator-3',
    });

    const before = await getMerchantPublic(merchantId);
    const revoked = await revokeClaim({
      claimId,
      reason: 'domain_loss',
      note: 'The proving domain now resolves to a different business.',
      operatorOxyUserId: 'operator-3',
    });
    expect(revoked.state).toBe('revoked');
    expect(revoked.revokeReason).toBe('domain_loss');

    const [merchant] = await db.select().from(merchants).where(eq(merchants.id, merchantId));
    // Management access is gone — native-checkout eligibility is DERIVED from
    // this verdict (#54), so it turns false with it.
    expect(merchant?.claimState).toBe('unclaimed');
    expect(merchant?.claimedByOxyUserId).toBeNull();
    expect(merchant?.claimedAt).toBeNull();

    const after = await getMerchantPublic(merchantId);
    // Public history survives, field by field. Only the claim verdict moved.
    expect(after.merchant.id).toBe(before.merchant.id);
    expect(after.merchant.name).toBe(before.merchant.name);
    expect(after.merchant.slug).toBe(before.merchant.slug);
    expect(after.merchant.rating).toBe(before.merchant.rating);
    expect(after.merchant.ratingCount).toBe(before.merchant.ratingCount);
    expect(after.merchant.offerCount).toBe(before.merchant.offerCount);
    expect(after.merchant.status).toBe(before.merchant.status);
    expect(after.storefronts.map((s) => s.id)).toEqual(before.storefronts.map((s) => s.id));
    expect(after.verifiedDomains).toEqual(before.verifiedDomains);
    expect(before.merchant.claimState).toBe('claimed');
    expect(after.merchant.claimState).toBe('unclaimed');

    // And the revoked claim itself is history, not a deletion.
    const rows = await db
      .select()
      .from(merchantClaims)
      .where(eq(merchantClaims.merchantId, merchantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedByOxyUserId).toBe('operator-3');
  });

  it('refuses a revocation that cannot say who did it or why', async () => {
    const merchantId = await mintMerchant('Anonymous Revoke');
    await expect(
      db.insert(merchantClaims).values({
        merchantId,
        claimantOxyUserId: actor('ar'),
        method: 'business_document',
        state: 'revoked',
        revokedAt: new Date(),
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isCheckViolation(error, 'merchant_claims_revoked_state_check'),
      'expected merchant_claims_revoked_state_check to refuse an unattributable revocation',
    );
  });
});

describe('the claim state machine and its CHECKs', () => {
  it('refuses a verification nobody can date', async () => {
    const merchantId = await mintMerchant('Undated Verify');
    await expect(
      db.insert(merchantClaims).values({
        merchantId,
        claimantOxyUserId: actor('uv'),
        method: 'business_document',
        state: 'verified',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isCheckViolation(error, 'merchant_claims_verified_state_check'),
      'expected merchant_claims_verified_state_check',
    );
  });

  it('refuses a dispute with nothing to dispute', async () => {
    const merchantId = await mintMerchant('Empty Dispute');
    await expect(
      db.insert(merchantClaims).values({
        merchantId,
        claimantOxyUserId: actor('ed'),
        method: 'business_document',
        state: 'disputed',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isCheckViolation(error, 'merchant_claims_disputed_state_check'),
      'expected merchant_claims_disputed_state_check',
    );
  });

  it('refuses a challenge-bearing method with no subject, and a document claim with one', async () => {
    const merchantId = await mintMerchant('Subject Check');
    await expect(
      db.insert(merchantClaims).values({
        merchantId,
        claimantOxyUserId: actor('sc-1'),
        method: 'dns_txt',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isCheckViolation(error, 'merchant_claims_document_subject_check'),
      'expected a subjectless dns_txt claim to be refused',
    );
    await expect(
      db.insert(merchantClaims).values({
        merchantId,
        claimantOxyUserId: actor('sc-2'),
        method: 'business_document',
        subjectKind: 'domain',
        subjectRef: `subject-${RUN}.example.com`,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isCheckViolation(error, 'merchant_claims_document_subject_check'),
      'expected a business_document claim carrying a subject to be refused',
    );
  });

  it('refuses a domain subject that is not normalized', async () => {
    const merchantId = await mintMerchant('Denormalized');
    await expect(
      db.insert(merchantClaims).values({
        merchantId,
        claimantOxyUserId: actor('dn'),
        method: 'dns_txt',
        subjectKind: 'domain',
        subjectRef: `MiXeD-${RUN}.Example.COM`,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isCheckViolation(error, 'merchant_claims_subject_domain_normalized_check'),
      'expected the normalization CHECK to refuse a case-variant subject',
    );
  });

  it('normalizes a URL-shaped domain on the way in, so the CHECK is never hit in practice', async () => {
    const merchantId = await mintMerchant('Normalizing');
    const claim = await openClaim({
      merchantId,
      claimantOxyUserId: actor('nrm'),
      method: 'dns_txt',
      domain: `HTTPS://Normal-${RUN}.Example.COM/some/path`,
    });
    expect(claim.subjectRef).toBe(`normal-${RUN}.example.com`);
  });

  it('expires a stale attempt lazily, on the next read', async () => {
    const merchantId = await mintMerchant('Lazy Expiry');
    const claimant = actor('le');
    const claim = await openClaim({
      merchantId,
      claimantOxyUserId: claimant,
      method: 'business_document',
    });
    // Move the deadline into the past without touching the state — exactly the
    // situation a stored `expired` flag would have to be swept into agreement
    // with, and which the resolver answers instead.
    await db
      .update(merchantClaims)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(merchantClaims.id, claim.id));

    const read = await getClaimForClaimant(claim.id, claimant);
    expect(read.state).toBe('expired');
    expect(read.expiresAt).toBeNull();

    // And the expiry is audited, once.
    const events = await findEventsForClaim(db, claim.id);
    expect(events.filter((event) => event.action === 'expired')).toHaveLength(1);

    // A second read does not re-expire it or write a second event.
    await getClaimForClaimant(claim.id, claimant);
    const again = await findEventsForClaim(db, claim.id);
    expect(again.filter((event) => event.action === 'expired')).toHaveLength(1);
  });

  it('records the requested scope at open, with the merchant and the subject domain', async () => {
    const merchantId = await mintMerchant('Scope Recording');
    const domain = `scope-${RUN}.example.com`;
    const claim = await openClaim({
      merchantId,
      claimantOxyUserId: actor('sr'),
      method: 'dns_txt',
      domain,
    });
    const scopes = await findScopesForClaim(db, claim.id);
    expect(scopes.map((row) => `${row.scopeKind}:${row.scopeRef}`).sort()).toEqual(
      [`domain:${domain}`, `merchant:${merchantId}`].sort(),
    );
    expect(scopes.every((row) => row.state === 'requested')).toBe(true);
  });

  it('refuses a storefront belonging to another merchant at open', async () => {
    const merchantId = await mintMerchant('Scope Owner');
    const otherId = await mintMerchant('Scope Outsider');
    const foreign = await createStorefront({
      merchantId: otherId,
      name: `Outsider Shop ${RUN}`,
      channelKind: 'web',
    });
    await expect(
      openClaim({
        merchantId,
        claimantOxyUserId: actor('so'),
        method: 'dns_txt',
        domain: `scope-owner-${RUN}.example.com`,
        storefrontIds: [foreign.id],
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isMercariaError(error) && error.httpStatus === 400,
      "expected a 400 for another merchant's storefront",
    );
  });
});

describe('eligibility says whether to show `Claim this merchant`, and nothing about who', () => {
  it('is claimable when unclaimed and free of live claims', async () => {
    const merchantId = await mintMerchant('Fresh');
    const eligibility = await getClaimEligibility(merchantId);
    expect(eligibility.claimable).toBe(true);
    expect(eligibility.reason).toBeNull();
    expect(eligibility.claimInProgress).toBe(false);
    expect(eligibility.claimState).toBe('unclaimed');
  });

  it('reports a live claim as a signal, never as a refusal', async () => {
    // A squatter opening first must not lock the real operator out, so a claim
    // in progress leaves the merchant claimable and shows up as a boolean —
    // never a name, never a count.
    const merchantId = await mintMerchant('In Progress');
    await openClaim({
      merchantId,
      claimantOxyUserId: actor('ip'),
      method: 'business_document',
    });
    const eligibility = await getClaimEligibility(merchantId);
    expect(eligibility.claimable).toBe(true);
    expect(eligibility.reason).toBeNull();
    expect(eligibility.claimInProgress).toBe(true);
    expect(JSON.stringify(eligibility)).not.toContain(actor('ip'));

    // …and a SECOND claimant may still open one, which is the property the
    // signal exists to keep honest.
    const second = await openClaim({
      merchantId,
      claimantOxyUserId: actor('ip-2'),
      method: 'business_document',
    });
    expect(second.state).toBe('draft');
  });

  it('reports an already-claimed merchant without naming its operator', async () => {
    const merchantId = await mintMerchant('Taken');
    await verifiedDocumentClaim({
      merchantId,
      claimant: actor('tk'),
      operator: 'operator-4',
    });
    const eligibility = await getClaimEligibility(merchantId);
    expect(eligibility.claimable).toBe(false);
    expect(eligibility.reason).toBe('already_claimed');
    expect(JSON.stringify(eligibility)).not.toContain(actor('tk'));
  });
});

describe('evidence is private, and looking at it is audited', () => {
  it('withholds evidence from the claimant-facing read and audits an operator access', async () => {
    const merchantId = await mintMerchant('Private Evidence');
    const claimant = actor('pe');
    const claim = await openClaim({
      merchantId,
      claimantOxyUserId: claimant,
      method: 'business_document',
    });
    await submitForReview({
      claimId: claim.id,
      claimantOxyUserId: claimant,
      evidence: [{ note: 'PRIVATE-NOTE-MARKER', oxyFileId: `file-${RUN}` }],
    });

    // The claimant's own read carries no evidence of any kind — the DTO has no
    // field for it, so this is a serialization check, not a filter check.
    const mine = await getClaimForClaimant(claim.id, claimant);
    expect(JSON.stringify(mine)).not.toContain('PRIVATE-NOTE-MARKER');
    expect(JSON.stringify(mine)).not.toContain(`file-${RUN}`);

    const view = await getClaimForOperator(claim.id, 'operator-5');
    expect(view.evidence.some((item) => item.note === 'PRIVATE-NOTE-MARKER')).toBe(true);
    // The ACCESS itself is on the timeline, with the reviewer named.
    const accesses = view.events.filter((event) => event.action === 'evidence_accessed');
    expect(accesses.length).toBeGreaterThan(0);
    expect(accesses.every((event) => event.actorOxyUserId === 'operator-5')).toBe(true);
  });

  it('protects the token digest from a whole-row read', async () => {
    const merchantId = await mintMerchant('Protected Digest');
    const claimant = actor('pd');
    const claim = await openClaim({
      merchantId,
      claimantOxyUserId: claimant,
      method: 'well_known_file',
      domain: `digest-${RUN}.example.com`,
    });
    await issueChallenge({ claimId: claim.id, claimantOxyUserId: claimant });
    const open = await findOpenChallenge(db, claim.id);
    expect(open).toBeDefined();
    // `token_hash` is a PROTECTED column, so the repository's ordinary read
    // does not carry it at all — the row type has no such property.
    expect(JSON.stringify(open)).not.toContain('tokenHash');
    // The greppable opt-in still reaches it, which is what the verifier needs.
    const digest = await findOpenChallengeDigest(db, claim.id);
    expect(digest?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses evidence that references nothing at all', async () => {
    const merchantId = await mintMerchant('Empty Evidence');
    const claim = await openClaim({
      merchantId,
      claimantOxyUserId: actor('ee'),
      method: 'business_document',
    });
    await expect(
      insertEvidence(db, {
        claimId: claim.id,
        kind: 'business_document',
        collectedAt: new Date(),
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isCheckViolation(error, 'merchant_claim_evidence_reference_check'),
      'expected merchant_claim_evidence_reference_check',
    );
    // …and the private read is still the only way to see what IS there.
    const rows = await findPrivateEvidenceForClaim(db, claim.id);
    expect(rows).toHaveLength(0);
  });
});

describe('the audit timeline is append-only and complete', () => {
  it('records every transition with its actor and its states', async () => {
    const merchantId = await mintMerchant('Timeline');
    const claimant = actor('tl');
    const claimId = await verifiedDocumentClaim({
      merchantId,
      claimant,
      operator: 'operator-6',
    });
    const events = await findEventsForClaim(db, claimId);
    const actions = events.map((event) => event.action);
    expect(actions).toContain('created');
    expect(actions).toContain('evidence_added');
    expect(actions).toContain('submitted_for_review');
    expect(actions).toContain('verified');

    const verified = events.find((event) => event.action === 'verified');
    expect(verified?.actorKind).toBe('operator');
    expect(verified?.actorOxyUserId).toBe('operator-6');
    expect(verified?.fromState).toBe('review_pending');
    expect(verified?.toState).toBe('verified');
  });

  it('refuses an operator event with no operator, and a system event with one', async () => {
    const merchantId = await mintMerchant('Actor Check');
    const claim = await openClaim({
      merchantId,
      claimantOxyUserId: actor('ac'),
      method: 'business_document',
    });
    await expect(
      db.insert(merchantClaimEvents).values({
        claimId: claim.id,
        action: 'verified',
        actorKind: 'operator',
        at: new Date(),
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isCheckViolation(error, 'merchant_claim_events_actor_presence_check'),
      'expected an unattributed operator event to be refused',
    );
    await expect(
      db.insert(merchantClaimEvents).values({
        claimId: claim.id,
        action: 'expired',
        actorKind: 'system',
        actorOxyUserId: 'somebody',
        at: new Date(),
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isCheckViolation(error, 'merchant_claim_events_actor_presence_check'),
      'expected a system event naming a person to be refused',
    );
  });

  it('has no updated_at on the audit tables — the append-only contract', async () => {
    // A column that does not exist cannot be moved by a later write. Asserted
    // against the real catalogue rather than the schema file, because the
    // migration is what production runs.
    const columns = await db.execute(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public'
         and table_name in ('merchant_claim_events', 'merchant_claim_evidence')
         and column_name = 'updated_at'`,
    );
    expect([...columns]).toHaveLength(0);
  });
});

describe('the merchant claim never touches anything it must not (acceptance 6)', () => {
  it('leaves every other merchant, storefront and domain row untouched', async () => {
    // "Claiming Apple Store creates no Apple relationship" has a structural
    // gate of its own (`relationship-isolation.test.ts`). This is the
    // behavioural half: a verified claim writes exactly three kinds of fact —
    // the claim, the merchant's verdict, and the scopes it proved — and
    // nothing else in the graph moves.
    const appleId = await mintMerchant('Apple');
    const lookalikeId = await mintMerchant('Apple Store Madrid');
    await createStorefront({
      merchantId: appleId,
      name: `Apple Store ES ${RUN}`,
      channelKind: 'web',
      domain: `apple-es-${RUN}.example.com`,
    });

    const beforeApple = await getMerchantPublic(appleId);
    await verifiedDocumentClaim({
      merchantId: lookalikeId,
      claimant: actor('asm'),
      operator: 'operator-7',
    });

    const afterApple = await getMerchantPublic(appleId);
    expect(afterApple).toEqual(beforeApple);
    // Nothing gave the lookalike a domain, a storefront, or a verified domain
    // belonging to the merchant whose NAME it resembles.
    const lookalikeProfile = await getMerchantPublic(lookalikeId);
    expect(lookalikeProfile.storefronts).toHaveLength(0);
    expect(lookalikeProfile.verifiedDomains).toHaveLength(0);
    const domainRows = await db
      .select()
      .from(merchantDomains)
      .where(eq(merchantDomains.merchantId, lookalikeId));
    expect(domainRows).toHaveLength(0);
  });

  it('leaves storefront verification alone when the operator verifies a document claim', async () => {
    // An operator reading a business document has NOT verified control of a
    // website, and marking the merchant's channels verified would launder one
    // kind of evidence into another.
    const merchantId = await mintMerchant('No Laundering');
    const shop = await createStorefront({
      merchantId,
      name: `No Laundering Shop ${RUN}`,
      channelKind: 'web',
      domain: `laundering-${RUN}.example.com`,
    });
    await verifiedDocumentClaim({
      merchantId,
      claimant: actor('nl'),
      operator: 'operator-8',
    });
    const [row] = await db.select().from(storefronts).where(eq(storefronts.id, shop.id));
    expect(row?.verificationState).toBe('unverified');
    expect(row?.verifiedAt).toBeNull();
    const verifiedDomains = await db
      .select()
      .from(merchantDomains)
      .where(isNotNull(merchantDomains.verifiedAt));
    expect(verifiedDomains.every((domain) => domain.merchantId !== merchantId)).toBe(true);
  });
});
