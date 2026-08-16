/**
 * The referral domain (#142) against a REAL PostgreSQL database.
 *
 * Issue #142's acceptance criterion 8 names this file's job: real-database
 * coverage of uniqueness, conflict, expiry, correction, merge and retirement.
 * The properties pinned here are exactly the ones a mocked repository cannot
 * see — the winner-cardinality partial unique index refusing a concurrent
 * second winner, the case-insensitive code namespace, the conversion
 * idempotency key converging a replay, and the CHECKs that hold state and
 * evidence together.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files
 * in parallel workers, so every identifier this file writes carries a per-run
 * suffix and teardown deletes exactly what it created — the
 * `moderation-writes.realdb` discipline. Codes matter most: their namespace is
 * GLOBAL and case-insensitive, so every requested code embeds the run tag.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, getDb, type Database } from '../../db/postgres.js';
import {
  referralAttributions,
  referralCodes,
  referralConversions,
  referralEvents,
  referralLinks,
  referralPartners,
  referralPrograms,
  referralSubjectRedirects,
  referralTouches,
} from '../../db/schema/referrals.js';
import { insertAttribution } from '../../db/referrals/attributionRepository.js';
import {
  createNextProgramVersion,
  createProgramDraft,
  editProgramDraft,
  publishProgram,
  retireProgram,
  type CreateProgramDraftInput,
} from '../referrals/program.service.js';
import {
  applyAsPartner,
  approvePartner,
  suspendPartner,
} from '../referrals/partner.service.js';
import { issueCode, issueLink } from '../referrals/instrument.service.js';
import {
  registerCodeTouch,
  resolveLinkAndRegisterTouch,
  type TouchContext,
} from '../referrals/touch.service.js';
import {
  attributeTouch,
  correctAttribution,
  recordSubjectMerge,
} from '../referrals/attribution.service.js';
import {
  recordConversionFromSourceEvent,
  verifyConversion,
} from '../referrals/conversion.service.js';
import { partnerAttributionsView } from '../referrals/read.service.js';
import { runReferralConsistencyChecks } from '../referrals/consistency.service.js';
import { verifyReferralLinkToken } from '../referrals/link-token.js';
import {
  admitPartnerToReferralPilot,
  deleteReferralPilotFixtures,
} from '../referral-pilot/__tests__/pilot-fixture.js';

// Hoisted above the imports, so `config/index.ts` reads it at load — link
// issuance mints signed tokens and needs the secret.
vi.hoisted(() => {
  process.env.REFERRAL_LINK_TOKEN_SECRET = 'realdb-referral-link-secret';
});

let db: Database;

/** Unique to this run; lower-case hex so it can live inside a code spelling. */
const TAG = uuidv7().replace(/-/g, '').slice(-10);

const OPERATOR = `operator-${TAG}`;

const trackedProgramIds: string[] = [];

/**
 * The programme the NEXT partner is admitted to the pilot for (#149).
 *
 * `attributeTouch` refuses a new attribution for a programme with no active
 * pilot cohort, so a fixture that wants one has to publish bounds — exactly as
 * a deployment does. Every test here creates its programme before its partners,
 * so `makeActiveProgram` records it and `makeApprovedPartner` admits to it; a
 * test that ever reversed that order would admit to the wrong programme and see
 * `refused`, which is loud rather than silent.
 */
let currentPilotProgram: { programId: string; versionId: string } | null = null;
const trackedPartnerIds: string[] = [];
const trackedRedirectFroms: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  // Derive every dependent id from the tracked roots, then delete in
  // FK-safe order. Self-references (alias→canonical, old→successor) need the
  // referencING rows gone first.
  const versionIds =
    trackedProgramIds.length > 0
      ? (
          await db
            .select({ id: referralPrograms.id })
            .from(referralPrograms)
            .where(inArray(referralPrograms.programId, trackedProgramIds))
        ).map((row) => row.id)
      : [];
  const codeIds =
    versionIds.length > 0
      ? (
          await db
            .select({ id: referralCodes.id })
            .from(referralCodes)
            .where(inArray(referralCodes.programVersionId, versionIds))
        ).map((row) => row.id)
      : [];
  const linkIds =
    codeIds.length > 0
      ? (
          await db
            .select({ id: referralLinks.id })
            .from(referralLinks)
            .where(inArray(referralLinks.codeId, codeIds))
        ).map((row) => row.id)
      : [];
  const attributionIds =
    trackedProgramIds.length > 0
      ? (
          await db
            .select({ id: referralAttributions.id })
            .from(referralAttributions)
            .where(inArray(referralAttributions.programId, trackedProgramIds))
        ).map((row) => row.id)
      : [];
  const conversionIds =
    attributionIds.length > 0
      ? (
          await db
            .select({ id: referralConversions.id })
            .from(referralConversions)
            .where(inArray(referralConversions.attributionId, attributionIds))
        ).map((row) => row.id)
      : [];
  const redirectIds =
    trackedRedirectFroms.length > 0
      ? (
          await db
            .select({ id: referralSubjectRedirects.id })
            .from(referralSubjectRedirects)
            .where(inArray(referralSubjectRedirects.fromRef, trackedRedirectFroms))
        ).map((row) => row.id)
      : [];

  const eventSubjectIds = [
    ...versionIds,
    ...codeIds,
    ...linkIds,
    ...attributionIds,
    ...conversionIds,
    ...redirectIds,
    ...trackedPartnerIds,
  ];
  if (eventSubjectIds.length > 0) {
    await db.delete(referralEvents).where(inArray(referralEvents.subjectId, eventSubjectIds));
  }
  if (conversionIds.length > 0) {
    await db.delete(referralConversions).where(inArray(referralConversions.id, conversionIds));
  }
  // Old rows point at their successors, so delete referencING rows until none
  // remain — bounded, because every pass removes at least the chain heads.
  let remaining = attributionIds;
  for (let pass = 0; pass < 6 && remaining.length > 0; pass += 1) {
    const deleted = await db
      .delete(referralAttributions)
      .where(
        and(
          inArray(referralAttributions.id, remaining),
          sql`not exists (select 1 from "referral_attributions" blocker
               where blocker."supersedes_attribution_id" = "referral_attributions"."id")`,
        ),
      )
      .returning({ id: referralAttributions.id });
    const gone = new Set(deleted.map((row) => row.id));
    remaining = remaining.filter((id) => !gone.has(id));
  }
  if (codeIds.length > 0) {
    await db.delete(referralTouches).where(inArray(referralTouches.codeId, codeIds));
  }
  if (linkIds.length > 0) {
    await db.delete(referralLinks).where(inArray(referralLinks.id, linkIds));
  }
  if (codeIds.length > 0) {
    // Aliases reference their canonical rows; delete them first.
    await db
      .delete(referralCodes)
      .where(and(inArray(referralCodes.id, codeIds), isNotNull(referralCodes.aliasOfCodeId)));
    await db.delete(referralCodes).where(inArray(referralCodes.id, codeIds));
  }
  if (redirectIds.length > 0) {
    await db
      .delete(referralSubjectRedirects)
      .where(inArray(referralSubjectRedirects.id, redirectIds));
  }
  // #149's cohorts reference the programme version and the partners with
  // `restrict`, deliberately — a live pilot must not have either removed
  // underneath it — so they go before both.
  await deleteReferralPilotFixtures(trackedProgramIds, db);
  if (trackedPartnerIds.length > 0) {
    await db.delete(referralPartners).where(inArray(referralPartners.id, trackedPartnerIds));
  }
  if (trackedProgramIds.length > 0) {
    await db
      .delete(referralPrograms)
      .where(inArray(referralPrograms.programId, trackedProgramIds));
  }
  await closePostgres();
});

/** A published (ACTIVE) buyer-referral program with 30-day windows. */
async function makeActiveProgram(
  overrides?: Partial<CreateProgramDraftInput>,
): Promise<{ programId: string; versionId: string }> {
  const draft = await createProgramDraft({
    name: `Program ${TAG}`,
    description: 'Bring a buyer',
    publicTermsSummary: 'Share your code; earn on the first qualifying order.',
    family: 'buyer_referral',
    eligiblePartnerTypes: ['user', 'store'],
    eligibleSubjectKinds: ['oxy_user', 'guest_checkout'],
    markets: [],
    currencies: [],
    channels: [],
    commercialModes: [],
    attributionPolicy: 'last_touch',
    attributionWindowDays: 30,
    qualifyingEventPolicy: 'first_qualifying_paid_order',
    commissionRuleRef: `rule-${TAG}-v1`,
    holdDays: 60,
    payoutPolicyRef: 'stripe-monthly',
    termsVersion: 't1',
    disclosureVersion: 'd1',
    createdByOxyUserId: OPERATOR,
    cohortKeys: [],
    ...overrides,
  });
  trackedProgramIds.push(draft.programId);
  const published = await publishProgram({ id: draft.id, approvedByOxyUserId: OPERATOR });
  expect(published.status).toBe('active');
  currentPilotProgram = { programId: draft.programId, versionId: published.id };
  return { programId: draft.programId, versionId: published.id };
}

/** An APPROVED user partner. */
async function makeApprovedPartner(name: string): Promise<{ id: string; ownerId: string }> {
  const ownerId = `owner-${name}-${TAG}`;
  const { partner } = await applyAsPartner({
    ownerType: 'user',
    ownerId,
    displayName: `Partner ${name}`,
    termsVersion: 't1',
    promotionMethods: ['website'],
  });
  trackedPartnerIds.push(partner.id);
  const approved = await approvePartner({
    partnerId: partner.id,
    actorOxyUserId: OPERATOR,
    reason: 'test approval',
  });
  expect(approved.state).toBe('approved');
  if (currentPilotProgram !== null) {
    await admitPartnerToReferralPilot({
      programId: currentPilotProgram.programId,
      programVersionId: currentPilotProgram.versionId,
      partnerId: partner.id,
      operatorOxyUserId: OPERATOR,
    });
  }
  return { id: partner.id, ownerId };
}

/** A touch context for one actor. */
function contextFor(actor: TouchContext['actor'], at?: Date): TouchContext {
  return { actor, clientSurface: 'web', consentMode: 'granted', at };
}

describe('acceptance 1: a partner receives a signed link and code for one published version', () => {
  it('issues a code pinned to the active version, and a link whose token verifies', async () => {
    const { programId, versionId } = await makeActiveProgram();
    const partner = await makeApprovedPartner('a1');

    const code = await issueCode({
      partnerId: partner.id,
      programId,
      requestedCode: `join-${TAG}`,
    });
    expect(code.code).toBe(`join-${TAG}`);
    expect(code.programVersionId).toBe(versionId);
    expect(code.status).toBe('active');

    const link = await issueLink({
      codeId: code.id,
      context: { destinationType: 'listing', destinationRef: 'abc123' },
    });
    const claims = verifyReferralLinkToken(link.token);
    expect(claims).toEqual({ linkId: link.id, codeId: code.id });

    // The full round trip: resolve the token, land on the allow-listed path,
    // record the touch.
    const resolution = await resolveLinkAndRegisterTouch(
      link.token,
      contextFor({ kind: 'guest_session', ref: `guest-a1-${TAG}` }),
    );
    expect(resolution.destinationPath).toBe('/listings/abc123');
    expect(resolution.touch.touchKind).toBe('link_click');
    expect(resolution.touch.linkId).toBe(link.id);
    expect(resolution.touch.guestSessionRef).toBe(`guest-a1-${TAG}`);
    // Raw retention outlives eligibility — the separable-touch-data contract.
    expect(resolution.touch.expiresAt.getTime()).toBeGreaterThan(
      resolution.touch.attributionWindowExpiresAt.getTime(),
    );
  });

  it('enforces the click ceiling in one statement, and dies with revocation', async () => {
    const { programId } = await makeActiveProgram();
    const partner = await makeApprovedPartner('a2');
    const code = await issueCode({ partnerId: partner.id, programId });
    const link = await issueLink({ codeId: code.id, maxClicks: 1 });

    await resolveLinkAndRegisterTouch(
      link.token,
      contextFor({ kind: 'guest_session', ref: `guest-a2-${TAG}` }),
    );
    await expect(
      resolveLinkAndRegisterTouch(
        link.token,
        contextFor({ kind: 'guest_session', ref: `guest-a2b-${TAG}` }),
      ),
    ).rejects.toThrow(/click limit/i);
  });

  it('refuses a tampered token before touching lifecycle state', async () => {
    await expect(
      resolveLinkAndRegisterTouch(
        'forged.token',
        contextFor({ kind: 'guest_session', ref: `guest-a3-${TAG}` }),
      ),
    ).rejects.toThrow(/signature|malformed/i);
  });
});

describe('rule 8: a partner cannot issue instruments for a program it is not approved for', () => {
  it('refuses an un-approved partner and an ineligible owner type', async () => {
    const { programId } = await makeActiveProgram();

    // Applied but never approved.
    const { partner: applied } = await applyAsPartner({
      ownerType: 'user',
      ownerId: `owner-unapproved-${TAG}`,
      displayName: 'Unapproved',
      termsVersion: 't1',
      promotionMethods: [],
    });
    trackedPartnerIds.push(applied.id);
    await expect(issueCode({ partnerId: applied.id, programId })).rejects.toThrow(
      /cannot issue/i,
    );

    // Approved, but the program only admits stores.
    const storeOnly = await makeActiveProgram({ eligiblePartnerTypes: ['store'] });
    const userPartner = await makeApprovedPartner('r8');
    await expect(
      issueCode({ partnerId: userPartner.id, programId: storeOnly.programId }),
    ).rejects.toThrow(/does not admit user partners/i);
  });
});

describe('the code namespace is globally unique, case-insensitively', () => {
  it('normalizes on write and refuses every other spelling of a taken code', async () => {
    const { programId } = await makeActiveProgram();
    const partner = await makeApprovedPartner('ns');

    const first = await issueCode({
      partnerId: partner.id,
      programId,
      requestedCode: `Mixed-Case-${TAG}`,
    });
    expect(first.code).toBe(`mixed-case-${TAG}`);

    await expect(
      issueCode({ partnerId: partner.id, programId, requestedCode: `MIXED-CASE-${TAG}` }),
    ).rejects.toThrow(/already reserved/i);
  });

  it('the DATABASE refuses an un-normalized spelling — the CHECK, not the service', async () => {
    const { programId } = await makeActiveProgram();
    const partner = await makeApprovedPartner('nc');
    const code = await issueCode({ partnerId: partner.id, programId });

    // Drizzle wraps the server error, so the constraint NAME is asserted on
    // the cause — matching the wrapper's message would pass on any failure.
    await expect(
      db.insert(referralCodes).values({
        partnerId: partner.id,
        programVersionId: code.programVersionId,
        code: `NotLower-${TAG}`,
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ constraint_name: 'referral_codes_code_check' }),
    });
  });
});

describe('acceptance 2: two competing touches resolve by last-touch and retain losing evidence', () => {
  it('a later touch supersedes; the losing row keeps its evidence and names its successor', async () => {
    const { programId } = await makeActiveProgram();
    const partnerA = await makeApprovedPartner('lt-a');
    const partnerB = await makeApprovedPartner('lt-b');
    const codeA = await issueCode({ partnerId: partnerA.id, programId });
    const codeB = await issueCode({ partnerId: partnerB.id, programId });

    const buyer = { kind: 'oxy_user' as const, ref: `buyer-lt-${TAG}` };
    const earlier = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    const later = new Date(Date.now() - 1 * 60 * 60 * 1_000);

    const touchA = await registerCodeTouch({
      code: codeA.code,
      touchKind: 'code_entry_in_app',
      context: contextFor(buyer, earlier),
    });
    const first = await attributeTouch(touchA.touch.id);
    expect(first.outcome).toBe('created');
    if (first.outcome !== 'created') return;

    const touchB = await registerCodeTouch({
      code: codeB.code,
      touchKind: 'code_entry_at_checkout',
      context: contextFor(buyer, later),
    });
    const second = await attributeTouch(touchB.touch.id);
    expect(second.outcome).toBe('superseded_previous');
    if (second.outcome !== 'superseded_previous') return;

    expect(second.superseded.id).toBe(first.attribution.id);
    expect(second.superseded.state).toBe('superseded');
    expect(second.superseded.conflictReason).toBe('competing_touch');
    // Losing evidence RETAINED, byte for byte.
    expect(second.superseded.winningCodeId).toBe(codeA.id);
    expect(second.superseded.winningTouchId).toBe(touchA.touch.id);
    // The new winner names its predecessor and carries its own evidence.
    expect(second.attribution.supersedesAttributionId).toBe(first.attribution.id);
    expect(second.attribution.winningCodeId).toBe(codeB.id);
    expect(second.attribution.partnerId).toBe(partnerB.id);

    // Exactly ONE active row for the scope.
    const active = await db
      .select({ id: referralAttributions.id })
      .from(referralAttributions)
      .where(
        and(
          inArray(referralAttributions.programId, [programId]),
          inArray(referralAttributions.state, ['active']),
        ),
      );
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(second.attribution.id);
  });

  it('an EARLIER touch arriving late loses — the standing winner is retained', async () => {
    const { programId } = await makeActiveProgram();
    const partnerA = await makeApprovedPartner('rl-a');
    const partnerB = await makeApprovedPartner('rl-b');
    const codeA = await issueCode({ partnerId: partnerA.id, programId });
    const codeB = await issueCode({ partnerId: partnerB.id, programId });

    const buyer = { kind: 'oxy_user' as const, ref: `buyer-rl-${TAG}` };
    const earlier = new Date(Date.now() - 3 * 60 * 60 * 1_000);
    const later = new Date(Date.now() - 1 * 60 * 60 * 1_000);

    const touchLater = await registerCodeTouch({
      code: codeB.code,
      touchKind: 'code_entry_in_app',
      context: contextFor(buyer, later),
    });
    const standing = await attributeTouch(touchLater.touch.id);
    expect(standing.outcome).toBe('created');

    const touchEarlier = await registerCodeTouch({
      code: codeA.code,
      touchKind: 'code_entry_in_app',
      context: contextFor(buyer, earlier),
    });
    const outcome = await attributeTouch(touchEarlier.touch.id);
    expect(outcome.outcome).toBe('retained_existing');
    if (outcome.outcome !== 'retained_existing') return;
    expect(outcome.attribution.winningCodeId).toBe(codeB.id);
  });
});

describe('winner cardinality: the partial unique index under concurrency', () => {
  it('two CONCURRENT inserts of one (program, subject) scope yield exactly one active row', async () => {
    const { programId, versionId } = await makeActiveProgram();
    const partner = await makeApprovedPartner('race');
    const code = await issueCode({ partnerId: partner.id, programId });

    const scope = {
      programId,
      subjectKind: 'oxy_user' as const,
      subjectRef: `buyer-race-${TAG}`,
    };
    const evidence = {
      programVersionId: versionId,
      partnerId: partner.id,
      winningCodeId: code.id,
      evidenceTouchKind: 'code_entry_in_app' as const,
      evidenceOccurredAt: new Date(),
      attributionPolicy: 'last_touch' as const,
      ruleVersionRef: `rule-${TAG}-v1`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      originalActorKind: 'oxy_user' as const,
    };

    // Genuinely concurrent: two statements in flight on two pool connections.
    const [a, b] = await Promise.all([
      insertAttribution(getDb(), { ...scope, ...evidence }),
      insertAttribution(getDb(), { ...scope, ...evidence }),
    ]);
    const winners = [a, b].filter((row) => row !== null);
    expect(winners).toHaveLength(1);

    // And a sequential third attempt is refused by the same index.
    expect(await insertAttribution(getDb(), { ...scope, ...evidence })).toBeNull();
  });
});

describe('acceptance 3: a guest purchase and a later Oxy claim produce ONE attribution and ONE conversion', () => {
  it('the claim replays the source event and creates nothing new', async () => {
    const { programId } = await makeActiveProgram();
    const partner = await makeApprovedPartner('guest');
    const code = await issueCode({ partnerId: partner.id, programId });

    const guest = { kind: 'guest_session' as const, ref: `guest-scope-${TAG}` };
    const touch = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_at_checkout',
      context: contextFor(guest),
    });
    const attributed = await attributeTouch(touch.touch.id);
    expect(attributed.outcome).toBe('created');
    if (attributed.outcome !== 'created') return;
    expect(attributed.attribution.subjectKind).toBe('guest_checkout');
    expect(attributed.attribution.originalActorKind).toBe('guest_session');

    const source = {
      sourceKind: 'order' as const,
      sourceRef: `order-guest-${TAG}`,
      sourceEventId: `evt-guest-${TAG}`,
    };
    const first = await recordConversionFromSourceEvent({
      attributionId: attributed.attribution.id,
      conversionType: 'first_qualifying_paid_order',
      occurredAt: new Date(),
      ...source,
    });
    expect(first.created).toBe(true);
    expect(first.conversion.state).toBe('pending');

    // The #109 claim moves the ORDER; the referral consequence is at most a
    // replay of the same durable source event — which converges.
    const replayed = await recordConversionFromSourceEvent({
      attributionId: attributed.attribution.id,
      conversionType: 'first_qualifying_paid_order',
      occurredAt: new Date(),
      ...source,
    });
    expect(replayed.created).toBe(false);
    expect(replayed.conversion.id).toBe(first.conversion.id);

    // One attribution for the program, and NONE for the claiming Oxy account.
    const attributions = await db
      .select({
        id: referralAttributions.id,
        subjectKind: referralAttributions.subjectKind,
      })
      .from(referralAttributions)
      .where(inArray(referralAttributions.programId, [programId]));
    expect(attributions).toHaveLength(1);
    expect(attributions[0].subjectKind).toBe('guest_checkout');

    const conversions = await db
      .select({ id: referralConversions.id })
      .from(referralConversions)
      .where(inArray(referralConversions.attributionId, [attributed.attribution.id]));
    expect(conversions).toHaveLength(1);
  });
});

describe('acceptance 4: replaying source events creates no duplicate conversion', () => {
  it('two CONCURRENT derivations of one source event converge on one row', async () => {
    const { programId } = await makeActiveProgram();
    const partner = await makeApprovedPartner('replay');
    const code = await issueCode({ partnerId: partner.id, programId });
    const touch = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_in_app',
      context: contextFor({ kind: 'oxy_user', ref: `buyer-replay-${TAG}` }),
    });
    const attributed = await attributeTouch(touch.touch.id);
    expect(attributed.outcome).toBe('created');
    if (attributed.outcome !== 'created') return;

    const record = () =>
      recordConversionFromSourceEvent({
        attributionId: attributed.attribution.id,
        conversionType: 'first_qualifying_paid_order',
        sourceKind: 'order',
        sourceRef: `order-replay-${TAG}`,
        sourceEventId: `evt-replay-${TAG}`,
        occurredAt: new Date(),
      });
    const [a, b] = await Promise.all([record(), record()]);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(a.conversion.id).toBe(b.conversion.id);
  });

  it('one source event cannot pay a SECOND partner — divergent derivations surface as a conflict', async () => {
    const { programId } = await makeActiveProgram();
    const partner = await makeApprovedPartner('split');
    const code = await issueCode({ partnerId: partner.id, programId });

    const touchOne = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_in_app',
      context: contextFor({ kind: 'oxy_user', ref: `buyer-split-1-${TAG}` }),
    });
    const touchTwo = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_in_app',
      context: contextFor({ kind: 'oxy_user', ref: `buyer-split-2-${TAG}` }),
    });
    const first = await attributeTouch(touchOne.touch.id);
    const second = await attributeTouch(touchTwo.touch.id);
    expect(first.outcome).toBe('created');
    expect(second.outcome).toBe('created');
    if (first.outcome !== 'created' || second.outcome !== 'created') return;

    const source = {
      sourceKind: 'order' as const,
      sourceRef: `order-split-${TAG}`,
      sourceEventId: `evt-split-${TAG}`,
    };
    await recordConversionFromSourceEvent({
      attributionId: first.attribution.id,
      conversionType: 'first_qualifying_paid_order',
      occurredAt: new Date(),
      ...source,
    });
    await expect(
      recordConversionFromSourceEvent({
        attributionId: second.attribution.id,
        conversionType: 'first_qualifying_paid_order',
        occurredAt: new Date(),
        ...source,
      }),
    ).rejects.toThrow(/already converted/i);
  });
});

describe('acceptance 5: program changes never alter prior attributions or their pinned rules', () => {
  it('an active version cannot be edited, and publishing v2 leaves v1 attributions pinned to v1 terms', async () => {
    const { programId, versionId } = await makeActiveProgram();
    const partner = await makeApprovedPartner('pin');
    const code = await issueCode({ partnerId: partner.id, programId });
    const touch = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_in_app',
      context: contextFor({ kind: 'oxy_user', ref: `buyer-pin-${TAG}` }),
    });
    const attributed = await attributeTouch(touch.touch.id);
    expect(attributed.outcome).toBe('created');
    if (attributed.outcome !== 'created') return;
    expect(attributed.attribution.ruleVersionRef).toBe(`rule-${TAG}-v1`);
    expect(attributed.attribution.programVersionId).toBe(versionId);

    // The immutability rule, verbatim from the issue.
    await expect(editProgramDraft(versionId, { name: 'renamed' })).rejects.toThrow(
      /publish a new version/i,
    );

    // Publish v2 with a different rule reference.
    const draft2 = await createNextProgramVersion({ programId, createdByOxyUserId: OPERATOR });
    await editProgramDraft(draft2.id, { commissionRuleRef: `rule-${TAG}-v2` });
    const v2 = await publishProgram({ id: draft2.id, approvedByOxyUserId: OPERATOR });
    expect(v2.status).toBe('active');
    expect(v2.version).toBe(2);

    // v1 ended; exactly one active version.
    const versions = await db
      .select({ id: referralPrograms.id, status: referralPrograms.status })
      .from(referralPrograms)
      .where(inArray(referralPrograms.programId, [programId]));
    expect(versions.filter((row) => row.status === 'active')).toHaveLength(1);
    expect(versions.find((row) => row.id === versionId)?.status).toBe('ended');

    // The PRIOR attribution is byte-identical on its pins.
    const [after] = await db
      .select({
        ruleVersionRef: referralAttributions.ruleVersionRef,
        programVersionId: referralAttributions.programVersionId,
        state: referralAttributions.state,
      })
      .from(referralAttributions)
      .where(inArray(referralAttributions.id, [attributed.attribution.id]));
    expect(after).toEqual({
      ruleVersionRef: `rule-${TAG}-v1`,
      programVersionId: versionId,
      state: 'active',
    });

    // And a NEW attribution pins v2's terms.
    const touch2 = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_in_app',
      context: contextFor({ kind: 'oxy_user', ref: `buyer-pin2-${TAG}` }),
    });
    const attributed2 = await attributeTouch(touch2.touch.id);
    expect(attributed2.outcome).toBe('created');
    if (attributed2.outcome !== 'created') return;
    expect(attributed2.attribution.ruleVersionRef).toBe(`rule-${TAG}-v2`);
    expect(attributed2.attribution.programVersionId).toBe(v2.id);
  });
});

describe('suspension: a suspended partner loses NEW attribution while historical commissions continue', () => {
  it('refuses new attribution with the bounded reason, and still verifies the earlier conversion', async () => {
    const { programId } = await makeActiveProgram();
    const partner = await makeApprovedPartner('susp');
    const code = await issueCode({ partnerId: partner.id, programId });

    // History first: an attribution and a pending conversion.
    const touchBefore = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_in_app',
      context: contextFor({ kind: 'oxy_user', ref: `buyer-susp-1-${TAG}` }),
    });
    const attributed = await attributeTouch(touchBefore.touch.id);
    expect(attributed.outcome).toBe('created');
    if (attributed.outcome !== 'created') return;
    const { conversion } = await recordConversionFromSourceEvent({
      attributionId: attributed.attribution.id,
      conversionType: 'first_qualifying_paid_order',
      sourceKind: 'order',
      sourceRef: `order-susp-${TAG}`,
      sourceEventId: `evt-susp-${TAG}`,
      occurredAt: new Date(),
    });

    await suspendPartner({
      partnerId: partner.id,
      actorOxyUserId: OPERATOR,
      reason: 'velocity review',
    });

    // NEW attribution refused — recorded, not thrown.
    const touchAfter = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_in_app',
      context: contextFor({ kind: 'oxy_user', ref: `buyer-susp-2-${TAG}` }),
    });
    const refused = await attributeTouch(touchAfter.touch.id);
    expect(refused).toEqual({ outcome: 'refused', reason: 'partner_suspended' });

    // The refusal left an audit row that COMMITTED.
    const events = await db
      .select({ action: referralEvents.action })
      .from(referralEvents)
      .where(inArray(referralEvents.subjectId, [partner.id]));
    expect(events.map((row) => row.action)).toContain('attribution_refused');

    // Historical commissions continue per policy: the earlier conversion still
    // verifies, untouched by the suspension.
    const verified = await verifyConversion({ conversionId: conversion.id });
    expect(verified.state).toBe('eligible');
    // The prior attribution was not rewritten.
    const [prior] = await db
      .select({ state: referralAttributions.state })
      .from(referralAttributions)
      .where(inArray(referralAttributions.id, [attributed.attribution.id]));
    expect(prior.state).toBe('active');
  });
});

describe('retirement blocks new attribution but not historical settlement', () => {
  it('refuses new touches and attributions; the earlier conversion still transitions', async () => {
    const { programId, versionId } = await makeActiveProgram();
    const partner = await makeApprovedPartner('ret');
    const code = await issueCode({ partnerId: partner.id, programId });

    const touchBefore = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_in_app',
      context: contextFor({ kind: 'oxy_user', ref: `buyer-ret-1-${TAG}` }),
    });
    const attributed = await attributeTouch(touchBefore.touch.id);
    expect(attributed.outcome).toBe('created');
    if (attributed.outcome !== 'created') return;
    const { conversion } = await recordConversionFromSourceEvent({
      attributionId: attributed.attribution.id,
      conversionType: 'first_qualifying_paid_order',
      sourceKind: 'order',
      sourceRef: `order-ret-${TAG}`,
      sourceEventId: `evt-ret-${TAG}`,
      occurredAt: new Date(),
    });

    // A touch registered BEFORE retirement, attributed after — the refusal path.
    const touchStraddling = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_in_app',
      context: contextFor({ kind: 'oxy_user', ref: `buyer-ret-2-${TAG}` }),
    });

    const retired = await retireProgram({
      id: versionId,
      actorOxyUserId: OPERATOR,
      reason: 'program wound down',
    });
    expect(retired.status).toBe('retired');

    // New touches refuse (prospective gate)…
    await expect(
      registerCodeTouch({
        code: code.code,
        touchKind: 'code_entry_in_app',
        context: contextFor({ kind: 'oxy_user', ref: `buyer-ret-3-${TAG}` }),
      }),
    ).rejects.toThrow(/not currently active/i);

    // …and so does attributing the straddling touch, with the bounded reason.
    const refused = await attributeTouch(touchStraddling.touch.id);
    expect(refused).toEqual({ outcome: 'refused', reason: 'program_retired' });

    // Historical settlement continues: the earlier conversion still verifies.
    const verified = await verifyConversion({ conversionId: conversion.id });
    expect(verified.state).toBe('eligible');
  });
});

describe('expiry: an attribution outside its window records a REJECTED conversion, never a silent nothing', () => {
  it('derives `rejected` with reason attribution_expired from an expired attribution', async () => {
    const { programId, versionId } = await makeActiveProgram();
    const partner = await makeApprovedPartner('exp');
    const code = await issueCode({ partnerId: partner.id, programId });

    // An attribution whose window has already closed, written directly — the
    // service cannot create one (it refuses expired touches), which is itself
    // the property that forces this fixture shape.
    const expired = await insertAttribution(getDb(), {
      programId,
      subjectKind: 'oxy_user',
      subjectRef: `buyer-exp-${TAG}`,
      programVersionId: versionId,
      partnerId: partner.id,
      winningCodeId: code.id,
      evidenceTouchKind: 'code_entry_in_app',
      evidenceOccurredAt: new Date(Date.now() - 2 * 60 * 60 * 1_000),
      attributionPolicy: 'last_touch',
      ruleVersionRef: `rule-${TAG}-v1`,
      expiresAt: new Date(Date.now() - 60 * 60 * 1_000),
      originalActorKind: 'oxy_user',
    });
    expect(expired).not.toBeNull();
    if (expired === null) return;

    const { conversion, created } = await recordConversionFromSourceEvent({
      attributionId: expired.id,
      conversionType: 'first_qualifying_paid_order',
      sourceKind: 'order',
      sourceRef: `order-exp-${TAG}`,
      sourceEventId: `evt-exp-${TAG}`,
      occurredAt: new Date(),
    });
    expect(created).toBe(true);
    expect(conversion.state).toBe('rejected');
    expect(conversion.reasonCode).toBe('attribution_expired');
  });

  it('the resolver refuses a touch whose own window has expired', async () => {
    const { programId } = await makeActiveProgram({ attributionWindowDays: 1 });
    const partner = await makeApprovedPartner('exw');
    const code = await issueCode({ partnerId: partner.id, programId });

    const touch = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_in_app',
      context: contextFor(
        { kind: 'oxy_user', ref: `buyer-exw-${TAG}` },
        new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000),
      ),
    });
    await expect(attributeTouch(touch.touch.id)).rejects.toThrow(/outside its attribution window/i);
  });
});

describe('correction: append-only, with the successor carrying the pins verbatim', () => {
  it('moves the old row to corrected and creates the successor under the corrected partner', async () => {
    const { programId } = await makeActiveProgram();
    const wrongPartner = await makeApprovedPartner('corr-wrong');
    const rightPartner = await makeApprovedPartner('corr-right');
    const code = await issueCode({ partnerId: wrongPartner.id, programId });

    const touch = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_in_app',
      context: contextFor({ kind: 'oxy_user', ref: `buyer-corr-${TAG}` }),
    });
    const attributed = await attributeTouch(touch.touch.id);
    expect(attributed.outcome).toBe('created');
    if (attributed.outcome !== 'created') return;

    const { corrected, successor } = await correctAttribution({
      attributionId: attributed.attribution.id,
      correctedPartnerId: rightPartner.id,
      actorOxyUserId: OPERATOR,
      reason: 'operator determined the code was issued to the wrong partner record',
    });

    expect(corrected.state).toBe('corrected');
    expect(corrected.conflictReason).toBe('operator_correction');
    expect(successor.supersedesAttributionId).toBe(corrected.id);
    // The original evidence and pins are untouched on BOTH rows.
    expect(corrected.winningCodeId).toBe(code.id);
    expect(successor.winningCodeId).toBe(code.id);
    expect(successor.ruleVersionRef).toBe(attributed.attribution.ruleVersionRef);
    expect(successor.evidenceOccurredAt).toEqual(attributed.attribution.evidenceOccurredAt);
    expect(successor.partnerId).toBe(rightPartner.id);
    expect(successor.state).toBe('active');

    // A conversion now attaches to the successor.
    const { conversion } = await recordConversionFromSourceEvent({
      attributionId: successor.id,
      conversionType: 'first_qualifying_paid_order',
      sourceKind: 'order',
      sourceRef: `order-corr-${TAG}`,
      sourceEventId: `evt-corr-${TAG}`,
      occurredAt: new Date(),
    });
    expect(conversion.state).toBe('pending');
  });
});

describe('merge redirects preserve history (identity/uniqueness 6)', () => {
  it('new attributions resolve through the redirect; existing rows keep their reference', async () => {
    const { programId } = await makeActiveProgram();
    const partner = await makeApprovedPartner('merge');
    const code = await issueCode({ partnerId: partner.id, programId });

    const oldRef = `merge-old-${TAG}`;
    const newRef = `merge-new-${TAG}`;

    // History FIRST: an attribution under the old reference.
    const touchOld = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_in_app',
      context: contextFor({ kind: 'oxy_user', ref: oldRef }),
    });
    const historical = await attributeTouch(touchOld.touch.id);
    expect(historical.outcome).toBe('created');
    if (historical.outcome !== 'created') return;

    trackedRedirectFroms.push(oldRef);
    await recordSubjectMerge({
      subjectKind: 'oxy_user',
      fromRef: oldRef,
      toRef: newRef,
      actorOxyUserId: OPERATOR,
      reason: 'Oxy identity merge',
    });

    // The historical row is NOT rewritten.
    const [kept] = await db
      .select({ subjectRef: referralAttributions.subjectRef })
      .from(referralAttributions)
      .where(inArray(referralAttributions.id, [historical.attribution.id]));
    expect(kept.subjectRef).toBe(oldRef);

    // A NEW touch by the old identity attributes to the CANONICAL reference.
    const touchNew = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_at_checkout',
      context: contextFor({ kind: 'oxy_user', ref: oldRef }),
    });
    const resolved = await attributeTouch(touchNew.touch.id);
    expect(resolved.outcome).toBe('created');
    if (resolved.outcome !== 'created') return;
    expect(resolved.attribution.subjectRef).toBe(newRef);

    // One reference redirects to exactly one place.
    await expect(
      recordSubjectMerge({
        subjectKind: 'oxy_user',
        fromRef: oldRef,
        toRef: `merge-elsewhere-${TAG}`,
        actorOxyUserId: OPERATOR,
        reason: 'second merge attempt',
      }),
    ).rejects.toThrow(/already redirects/i);
  });
});

describe('consistency checks report, and never repair (API 10)', () => {
  it('surfaces an expired active attribution, a suspended partner’s standing rows and a retired program', async () => {
    const { programId, versionId } = await makeActiveProgram();
    const partner = await makeApprovedPartner('cons');
    const code = await issueCode({ partnerId: partner.id, programId });

    const touch = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_in_app',
      context: contextFor({ kind: 'oxy_user', ref: `buyer-cons-${TAG}` }),
    });
    const attributed = await attributeTouch(touch.touch.id);
    expect(attributed.outcome).toBe('created');
    if (attributed.outcome !== 'created') return;

    const expired = await insertAttribution(getDb(), {
      programId,
      subjectKind: 'oxy_user',
      subjectRef: `buyer-cons-exp-${TAG}`,
      programVersionId: versionId,
      partnerId: partner.id,
      winningCodeId: code.id,
      evidenceTouchKind: 'code_entry_in_app',
      evidenceOccurredAt: new Date(Date.now() - 2 * 60 * 60 * 1_000),
      attributionPolicy: 'last_touch',
      ruleVersionRef: `rule-${TAG}-v1`,
      expiresAt: new Date(Date.now() - 60 * 60 * 1_000),
      originalActorKind: 'oxy_user',
    });
    expect(expired).not.toBeNull();
    if (expired === null) return;

    await suspendPartner({ partnerId: partner.id, actorOxyUserId: OPERATOR, reason: 'review' });
    await retireProgram({ id: versionId, actorOxyUserId: OPERATOR, reason: 'wound down' });

    const findings = await runReferralConsistencyChecks();
    const mine = findings.filter((finding) =>
      [attributed.attribution.id, expired.id].includes(finding.subjectId),
    );
    expect(mine.map((finding) => finding.kind).sort()).toEqual([
      // Both rows: not-approved partner AND no-active-version program.
      'active_attribution_partner_not_approved',
      'active_attribution_partner_not_approved',
      'active_attribution_program_not_active',
      'active_attribution_program_not_active',
      // Only the direct-inserted row is past its window.
      'expired_active_attribution',
    ]);
  });
});

describe('acceptance 7: partner DTOs expose no referred-subject data', () => {
  it('the partner attribution view carries EXACTLY date, state, programId and subjectKind', async () => {
    const { programId } = await makeActiveProgram();
    const partner = await makeApprovedPartner('dto');
    const code = await issueCode({ partnerId: partner.id, programId });
    const touch = await registerCodeTouch({
      code: code.code,
      touchKind: 'code_entry_in_app',
      context: contextFor({ kind: 'oxy_user', ref: `buyer-dto-${TAG}` }),
    });
    const attributed = await attributeTouch(touch.touch.id);
    expect(attributed.outcome).toBe('created');

    const views = await partnerAttributionsView({ partnerId: partner.id });
    expect(views.length).toBeGreaterThanOrEqual(1);
    for (const view of views) {
      // Exact key set — a new field fails here and forces the A5 question.
      expect(Object.keys(view).sort()).toEqual(['date', 'programId', 'state', 'subjectKind']);
      expect(view.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain(`buyer-dto-${TAG}`);
    }
  });
});
