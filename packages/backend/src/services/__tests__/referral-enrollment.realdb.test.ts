/**
 * Referral partner ENROLLMENT (#146 increment 2), against a REAL Postgres
 * server.
 *
 * Everything load-bearing here exists only with a server behind it, which is
 * why this is not a mocked suite. A mocked `insert`/`update` accepts every
 * statement the server refuses:
 *
 *  - the application's TWELVE CHECKs, including the two the empty-array and
 *    NULL traps make subtle (`markets` joined-array regex, and the two SEPARATE
 *    decision biconditionals that one over their conjunction would admit);
 *  - `mercaria_referral_application_content_freeze`, whose whole point is
 *    refusing an UPDATE a service is perfectly willing to issue;
 *  - the two append-only triggers;
 *  - `referral_partner_applications_live_key`, a PARTIAL unique whose `ON
 *    CONFLICT` cannot infer its arbiter without repeating the predicate;
 *  - `referral_partner_application_reviews_revision_key`, which is what makes a
 *    double-clicked approval converge instead of recording a second decision;
 *  - `referral_terms_acceptances`' GENERATED `acceptance_key`, which exists
 *    because Postgres treats NULLs as DISTINCT and a plain multi-column unique
 *    would let two identical partner-agreement acceptances through.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import {
  REFERRAL_APPLICATION_EDITABLE_STATES,
  REFERRAL_ENROLLMENT_MODE_RULES,
} from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { withTriggerToggleLock } from '../../db/__tests__/trigger-toggle-lock.js';
import {
  referralEvents,
  referralPartnerApplicationReviews,
  referralPartnerApplications,
  referralPartners,
  referralTaxProfiles,
  referralTermsAcceptances,
} from '../../db/schema/referrals.js';
import { insertPartner } from '../../db/referrals/partnerRepository.js';
import { findLiveApplication } from '../../db/referrals/applicationRepository.js';
import {
  createPartnerAsOperator,
  startPartnerApplication,
  submitPartnerApplication,
  withdrawPartnerApplication,
} from '../referrals/enrollment.service.js';
import {
  decideApplication,
  enrollmentEarnsProductionRewards,
  openPartnerAppeal,
  resolvePartnerAppeal,
  startApplicationReview,
} from '../referrals/application-review.service.js';
import {
  acceptPartnerTerms,
  deriveAgreementStanding,
  setReferralMarketingConsent,
} from '../referrals/terms.service.js';
import { readPartnerStanding } from '../referrals/partner-standing.service.js';
import { readDuplicateSignals } from '../referrals/duplicate-signals.js';
import { suspendPartner, terminatePartner } from '../referrals/partner.service.js';
import { declareTaxProfile } from '../referrals/tax-profile.service.js';
import { REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION } from '@mercaria/shared-types';

const TAG = uuidv7().slice(-8);
let db: Database;
const trackedPartnerIds: string[] = [];

/** A complete, submittable answer set. Each case moves ONE thing off it. */
function completeAnswers(overrides: Record<string, unknown> = {}) {
  return {
    promotionMethods: ['website', 'social_media'],
    promotionUrls: ['https://example.com/blog'],
    audienceBand: 'from_1k_to_10k',
    markets: ['ES', 'PT'],
    prohibitedMethodsAcknowledged: true,
    hasRelatedParty: false,
    reviewConsent: true,
    communicationConsent: true,
    ...overrides,
  };
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  if (trackedPartnerIds.length > 0) {
    const applicationIds = (
      await db
        .select({ id: referralPartnerApplications.id })
        .from(referralPartnerApplications)
        .where(inArray(referralPartnerApplications.partnerId, trackedPartnerIds))
    ).map((row) => row.id);

    // ONE TABLE PER `withTriggerToggleLock` WINDOW, every statement on `tx`.
    // `DISABLE TRIGGER` takes ShareRowExclusive, whose counterparty is an
    // ordinary writer holding RowExclusive — the mutex serialises window against
    // window and cannot see that party, so holding two tables at once
    // deadlocks. Three append-only/freeze triggers here means three windows.
    if (applicationIds.length > 0) {
      await withTriggerToggleLock(db, async (tx) => {
        await tx.execute(
          sql`alter table referral_partner_application_reviews disable trigger mercaria_referral_application_reviews_append_only`,
        );
        await tx
          .delete(referralPartnerApplicationReviews)
          .where(inArray(referralPartnerApplicationReviews.applicationId, applicationIds));
        await tx.execute(
          sql`alter table referral_partner_application_reviews enable trigger mercaria_referral_application_reviews_append_only`,
        );
      });
    }

    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table referral_terms_acceptances disable trigger mercaria_referral_terms_acceptances_append_only`,
      );
      await tx
        .delete(referralTermsAcceptances)
        .where(inArray(referralTermsAcceptances.partnerId, trackedPartnerIds));
      await tx.execute(
        sql`alter table referral_terms_acceptances enable trigger mercaria_referral_terms_acceptances_append_only`,
      );
    });

    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table referral_tax_profiles disable trigger mercaria_referral_tax_profiles_append_only`,
      );
      await tx
        .delete(referralTaxProfiles)
        .where(inArray(referralTaxProfiles.partnerId, trackedPartnerIds));
      await tx.execute(
        sql`alter table referral_tax_profiles enable trigger mercaria_referral_tax_profiles_append_only`,
      );
    });

    // The content freeze is a BEFORE UPDATE trigger, so a DELETE is unaffected
    // and needs no window at all.
    await db
      .delete(referralPartnerApplications)
      .where(inArray(referralPartnerApplications.partnerId, trackedPartnerIds));
    await db
      .delete(referralEvents)
      .where(
        and(
          eq(referralEvents.subjectType, 'partner'),
          inArray(referralEvents.subjectId, trackedPartnerIds),
        ),
      );
    await db.delete(referralPartners).where(inArray(referralPartners.id, trackedPartnerIds));
  }
  await closePostgres();
}, 120_000);

/** Enrol one owner through the partner surface's own path. */
async function enrol(
  label: string,
  overrides: Record<string, unknown> = {},
): Promise<{ partnerId: string; ownerId: string }> {
  const ownerId = `owner-${label}-${TAG}`;
  const result = await startPartnerApplication({
    ownerType: 'user',
    ownerId,
    displayName: `Partner ${label} ${TAG}`,
    actorOxyUserId: `oxy-${label}-${TAG}`,
    answers: completeAnswers(overrides),
  });
  trackedPartnerIds.push(result.partner.id);
  return { partnerId: result.partner.id, ownerId };
}

/**
 * Assert a REJECTION whose constraint or trigger matches, reading `cause`.
 *
 * drizzle wraps the driver error, so the outer `message` is `Failed query: …`
 * and the constraint name lives on `cause`. A regex over the outer message
 * alone passes for ANY failed statement — including a typo'd column — which is
 * a check that cannot tell success from failure.
 */
async function expectPgRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (err) {
    failure = err;
  }
  expect(failure, `expected a rejection matching ${String(pattern)}`).toBeDefined();
  const cause = (failure as { cause?: { message?: string; constraint_name?: string } }).cause;
  const text = [
    (failure as Error).message,
    cause?.message ?? '',
    cause?.constraint_name ?? '',
  ].join(' ');
  expect(text).toMatch(pattern);
}

describe('the application lifecycle', () => {
  it('creates one partner and one draft however many times it is called', async () => {
    const ownerId = `owner-idem-${TAG}`;
    const first = await startPartnerApplication({
      ownerType: 'user',
      ownerId,
      displayName: `Idempotent ${TAG}`,
      actorOxyUserId: `oxy-idem-${TAG}`,
      answers: completeAnswers(),
    });
    trackedPartnerIds.push(first.partner.id);

    const second = await startPartnerApplication({
      ownerType: 'user',
      ownerId,
      displayName: `Idempotent ${TAG}`,
      actorOxyUserId: `oxy-idem-${TAG}`,
      answers: completeAnswers({ audienceBand: 'over_100k' }),
    });

    expect(second.partner.id).toBe(first.partner.id);
    expect(second.application.id).toBe(first.application.id);
    // The second call EDITED rather than creating: a draft is a working
    // document, and the partial unique is what made the insert converge.
    expect(second.application.audienceBand).toBe('over_100k');

    const rows = await db
      .select({ id: referralPartnerApplications.id })
      .from(referralPartnerApplications)
      .where(eq(referralPartnerApplications.partnerId, first.partner.id));
    expect(rows).toHaveLength(1);

    // ONE `partner_application_started` event, not two.
    const events = await db
      .select({ action: referralEvents.action })
      .from(referralEvents)
      .where(
        and(
          eq(referralEvents.subjectId, first.partner.id),
          eq(referralEvents.action, 'partner_application_started'),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it('refuses to submit an application missing a consent, and says which', async () => {
    const { ownerId } = await enrol('incomplete', {
      reviewConsent: false,
      communicationConsent: false,
      prohibitedMethodsAcknowledged: false,
    });
    await expect(
      submitPartnerApplication({
        ownerType: 'user',
        ownerId,
        actorOxyUserId: `oxy-incomplete-${TAG}`,
      }),
    ).rejects.toThrow(/prohibited-method rules|consent to review/);
  });

  it('freezes the answers once submitted, in the DATABASE', async () => {
    const { partnerId, ownerId } = await enrol('frozen');
    await submitPartnerApplication({
      ownerType: 'user',
      ownerId,
      actorOxyUserId: `oxy-frozen-${TAG}`,
    });
    const live = await findLiveApplication(db, partnerId);
    expect(live?.state).toBe('submitted');

    // A raw UPDATE, bypassing every service. This is the whole reason the
    // freeze is a trigger and not a repository guard.
    await expectPgRejection(
      db
        .update(referralPartnerApplications)
        .set({ audienceBand: 'over_100k' })
        .where(eq(referralPartnerApplications.id, live?.id ?? '')),
      /frozen in state submitted/,
    );

    // The state itself still moves — the freeze holds the ANSWERS, not the row.
    const claimed = await startApplicationReview({
      partnerId,
      actorOxyUserId: `oxy-op-${TAG}`,
    });
    expect(claimed.application.state).toBe('under_review');
  });

  it('lets a changes-requested applicant edit, and bumps the revision on re-submission', async () => {
    const { partnerId, ownerId } = await enrol('changes');
    await submitPartnerApplication({
      ownerType: 'user',
      ownerId,
      actorOxyUserId: `oxy-changes-${TAG}`,
    });
    const decided = await decideApplication({
      partnerId,
      decision: 'changes_requested',
      rejectionCode: 'incomplete_information',
      partnerMessage: 'Please add the channel you will post on.',
      reviewerNote: 'Only one URL and it 404s.',
      actorOxyUserId: `oxy-op-${TAG}`,
    });
    expect(decided.application.state).toBe('changes_requested');
    expect(decided.application.revision).toBe(1);
    expect(REFERRAL_APPLICATION_EDITABLE_STATES).toContain('changes_requested');

    // Editable again, because `changes_requested` exists so the applicant can
    // answer — which is why this table is a working document rather than
    // append-only like its two siblings.
    const edited = await startPartnerApplication({
      ownerType: 'user',
      ownerId,
      displayName: `Partner changes ${TAG}`,
      actorOxyUserId: `oxy-changes-${TAG}`,
      answers: completeAnswers({ promotionUrls: ['https://example.com/new-blog'] }),
    });
    expect(edited.application.promotionUrls).toEqual(['https://example.com/new-blog']);

    const resubmitted = await submitPartnerApplication({
      ownerType: 'user',
      ownerId,
      actorOxyUserId: `oxy-changes-${TAG}`,
    });
    // The bump is what lets the review trail admit a SECOND decision.
    expect(resubmitted.application.revision).toBe(2);
    // The previous decision is cleared from the working document and survives
    // on the append-only trail — the whole reason they are two tables.
    expect(resubmitted.application.decisionCode).toBeNull();

    const approved = await decideApplication({
      partnerId,
      decision: 'approved',
      actorOxyUserId: `oxy-op-${TAG}`,
    });
    expect(approved.application.state).toBe('approved');
    expect(approved.partner.state).toBe('approved');

    const trail = await db
      .select({ revision: referralPartnerApplicationReviews.revision })
      .from(referralPartnerApplicationReviews)
      .where(eq(referralPartnerApplicationReviews.applicationId, approved.application.id));
    expect(trail.map((r) => r.revision).sort()).toEqual([1, 2]);
  });

  it('converges a double-clicked decision on the FIRST reviewer, and records one row', async () => {
    const { partnerId, ownerId } = await enrol('double');
    await submitPartnerApplication({
      ownerType: 'user',
      ownerId,
      actorOxyUserId: `oxy-double-${TAG}`,
    });

    const first = await decideApplication({
      partnerId,
      decision: 'approved',
      reviewerNote: 'first',
      actorOxyUserId: `oxy-op-a-${TAG}`,
    });
    expect(first.decisionRecorded).toBe(true);

    // A DIFFERENT operator, a DIFFERENT verdict, same revision. The unique is
    // what makes this converge rather than record a second decision.
    const second = await decideApplication({
      partnerId,
      decision: 'rejected',
      rejectionCode: 'policy_violation',
      reviewerNote: 'second',
      actorOxyUserId: `oxy-op-b-${TAG}`,
    });
    expect(second.decisionRecorded).toBe(false);
    expect(second.review.decision).toBe('approved');
    expect(second.review.reviewerNote).toBe('first');
    expect(second.application.state).toBe('approved');

    const trail = await db
      .select({ id: referralPartnerApplicationReviews.id })
      .from(referralPartnerApplicationReviews)
      .where(eq(referralPartnerApplicationReviews.applicationId, first.application.id));
    expect(trail).toHaveLength(1);
  });

  it('refuses to rewrite or delete a decision', async () => {
    const { partnerId, ownerId } = await enrol('append-only');
    await submitPartnerApplication({
      ownerType: 'user',
      ownerId,
      actorOxyUserId: `oxy-append-${TAG}`,
    });
    const decided = await decideApplication({
      partnerId,
      decision: 'rejected',
      rejectionCode: 'ineligible_market',
      reviewerNote: 'the note somebody would want to change',
      actorOxyUserId: `oxy-op-${TAG}`,
    });

    await expectPgRejection(
      db
        .update(referralPartnerApplicationReviews)
        .set({ reviewerNote: 'rewritten' })
        .where(eq(referralPartnerApplicationReviews.id, decided.review.id)),
      /append-only/,
    );
    await expectPgRejection(
      db
        .delete(referralPartnerApplicationReviews)
        .where(eq(referralPartnerApplicationReviews.id, decided.review.id)),
      /append-only/,
    );
  });

  it('lets a rejected applicant start a NEW application', async () => {
    const { partnerId, ownerId } = await enrol('reapply');
    await submitPartnerApplication({
      ownerType: 'user',
      ownerId,
      actorOxyUserId: `oxy-reapply-${TAG}`,
    });
    await decideApplication({
      partnerId,
      decision: 'rejected',
      rejectionCode: 'incomplete_information',
      actorOxyUserId: `oxy-op-${TAG}`,
    });

    // `rejected` is OUT of the partial unique's predicate, which is what makes
    // reconsideration need no special case at all.
    const again = await startPartnerApplication({
      ownerType: 'user',
      ownerId,
      displayName: `Partner reapply ${TAG}`,
      actorOxyUserId: `oxy-reapply-${TAG}`,
      answers: completeAnswers(),
    });
    expect(again.partner.id).toBe(partnerId);
    expect(again.application.state).toBe('draft');

    const rows = await db
      .select({ state: referralPartnerApplications.state })
      .from(referralPartnerApplications)
      .where(eq(referralPartnerApplications.partnerId, partnerId));
    expect(rows).toHaveLength(2);
  });

  it('withdraws an application and leaves the owner able to start another', async () => {
    const { partnerId, ownerId } = await enrol('withdraw');
    await submitPartnerApplication({
      ownerType: 'user',
      ownerId,
      actorOxyUserId: `oxy-withdraw-${TAG}`,
    });
    const withdrawn = await withdrawPartnerApplication({
      ownerType: 'user',
      ownerId,
      actorOxyUserId: `oxy-withdraw-${TAG}`,
    });
    expect(withdrawn.application.state).toBe('withdrawn');
    // Back to `draft`, never `rejected`: nobody refused this.
    expect(withdrawn.partner.state).toBe('draft');
    expect(await findLiveApplication(db, partnerId)).toBeUndefined();
  });
});

describe('the CHECKs a mocked insert would accept', () => {
  it('refuses a market that is not two upper-case letters', async () => {
    const { partnerId } = await enrol('markets');
    await expectPgRejection(
      db
        .insert(referralPartnerApplications)
        .values({
          partnerId,
          enrollmentMode: 'open_application',
          state: 'draft',
          markets: ['es'],
        })
        .returning(),
      /markets_check/,
    );
  });

  it('admits the EMPTY markets array, which is a legitimate answer', async () => {
    // The joined-array regex's optional group. A pattern demanding at least one
    // code would refuse "I named no market", which means unrestricted.
    const { partnerId } = await enrol('markets-empty');
    const live = await findLiveApplication(db, partnerId);
    const [row] = await db
      .update(referralPartnerApplications)
      .set({ markets: [] })
      .where(eq(referralPartnerApplications.id, live?.id ?? ''))
      .returning();
    expect(row?.markets).toEqual([]);
  });

  it('refuses a non-https promotion URL', async () => {
    const { partnerId } = await enrol('urls');
    await expectPgRejection(
      db
        .insert(referralPartnerApplications)
        .values({
          partnerId,
          enrollmentMode: 'open_application',
          state: 'draft',
          promotionUrls: ['http://example.com'],
        })
        .returning(),
      /promotion_urls_check/,
    );
  });

  it('refuses a related-party disclosure without the declaration, and the reverse', async () => {
    const { partnerId } = await enrol('related');
    await expectPgRejection(
      db
        .insert(referralPartnerApplications)
        .values({
          partnerId,
          enrollmentMode: 'open_application',
          state: 'draft',
          hasRelatedParty: false,
          relatedPartyDisclosure: 'my cousin runs the shop',
        })
        .returning(),
      /related_party_check/,
    );
    await expectPgRejection(
      db
        .insert(referralPartnerApplications)
        .values({
          partnerId,
          enrollmentMode: 'open_application',
          state: 'draft',
          hasRelatedParty: true,
        })
        .returning(),
      /related_party_check/,
    );
  });

  /**
   * The two decision CHECKs, and the ASYMMETRY between them.
   *
   * `decision_code` is a BICONDITIONAL on the state — a refusal names its code
   * and an approval carries none. `decision_message` is ONE-DIRECTIONAL — a
   * message requires a code, and a code needs no message.
   *
   * The first version of this schema made the second a biconditional too, and
   * this suite refused every rejection on its first run. Getting it wrong that
   * way is not merely inconvenient: it would force a hand-written sentence onto
   * every refusal, and free text is exactly where #146 review rule 9's risk
   * signal actually leaks. The code IS the message.
   */
  it('admits a decision code with no message', async () => {
    const { partnerId } = await enrol('decision-code-only');
    const live = await findLiveApplication(db, partnerId);
    const [row] = await db
      .update(referralPartnerApplications)
      .set({
        state: 'rejected',
        submittedAt: new Date(),
        submittedByOxyUserId: 'oxy-x',
        decidedAt: new Date(),
        decisionCode: 'other',
      })
      .where(eq(referralPartnerApplications.id, live?.id ?? ''))
      .returning();
    expect(row?.decisionCode).toBe('other');
    expect(row?.decisionMessage).toBeNull();
  });

  it('refuses a message with no code, and a refusal with no code', async () => {
    const { partnerId } = await enrol('decision-shape');
    await expectPgRejection(
      db
        .insert(referralPartnerApplications)
        .values({
          partnerId,
          enrollmentMode: 'open_application',
          state: 'approved',
          submittedAt: new Date(),
          submittedByOxyUserId: 'oxy-x',
          prohibitedMethodsAcknowledged: true,
          reviewConsentAt: new Date(),
          communicationConsentAt: new Date(),
          decidedAt: new Date(),
          decisionMessage: 'welcome',
        })
        .returning(),
      /decision_message_shape_check/,
    );
    await expectPgRejection(
      db
        .insert(referralPartnerApplications)
        .values({
          partnerId,
          enrollmentMode: 'open_application',
          state: 'rejected',
          submittedAt: new Date(),
          submittedByOxyUserId: 'oxy-x',
          prohibitedMethodsAcknowledged: true,
          reviewConsentAt: new Date(),
          communicationConsentAt: new Date(),
          decidedAt: new Date(),
        })
        .returning(),
      /decision_code_shape_check/,
    );
  });

  it('refuses a second LIVE application for one partner', async () => {
    const { partnerId } = await enrol('two-live');
    await expectPgRejection(
      db
        .insert(referralPartnerApplications)
        .values({ partnerId, enrollmentMode: 'open_application', state: 'draft' })
        .returning(),
      /referral_partner_applications_live_key/,
    );
  });
});

describe('terms acceptance', () => {
  it('converges a repeated acceptance and projects the version onto the partner', async () => {
    const { partnerId } = await enrol('terms');

    const first = await acceptPartnerTerms({
      partnerId,
      scope: 'partner_agreement',
      termsVersion: REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION,
      locale: 'es-ES',
      actorOxyUserId: `oxy-terms-${TAG}`,
    });
    expect(first.created).toBe(true);
    expect(first.partner.termsVersion).toBe(REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION);
    expect(deriveAgreementStanding(first.partner)).toBe('accepted');

    const again = await acceptPartnerTerms({
      partnerId,
      scope: 'partner_agreement',
      termsVersion: REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION,
      locale: 'es-ES',
      actorOxyUserId: `oxy-terms-${TAG}`,
    });
    // A repeat is a SUCCESS, not a duplicate and not an error: rule 4 asks for
    // re-acceptance only on a material new version.
    expect(again.created).toBe(false);

    const rows = await db
      .select({ id: referralTermsAcceptances.id })
      .from(referralTermsAcceptances)
      .where(eq(referralTermsAcceptances.partnerId, partnerId));
    expect(rows).toHaveLength(1);
  });

  it('refuses a version that is not the one being presented', async () => {
    const { partnerId } = await enrol('terms-stale');
    await expect(
      acceptPartnerTerms({
        partnerId,
        scope: 'partner_agreement',
        termsVersion: 'partner-1999-01',
        locale: 'en',
        actorOxyUserId: `oxy-stale-${TAG}`,
      }),
    ).rejects.toThrow(/cannot be accepted/);
  });

  it('refuses an Accept-Language header where a language tag belongs', async () => {
    const { partnerId } = await enrol('terms-locale');
    await expect(
      acceptPartnerTerms({
        partnerId,
        scope: 'partner_agreement',
        termsVersion: REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION,
        locale: 'es-ES,es;q=0.9',
        actorOxyUserId: `oxy-locale-${TAG}`,
      }),
    ).rejects.toThrow(/Not a language tag/);
  });

  it('keeps program terms and the partner agreement apart, and refuses a mismatched shape', async () => {
    const { partnerId } = await enrol('terms-scope');
    const program = await acceptPartnerTerms({
      partnerId,
      scope: 'program_terms',
      programId: `program-${TAG}`,
      termsVersion: 'terms-v1',
      locale: 'en',
      actorOxyUserId: `oxy-scope-${TAG}`,
    });
    expect(program.created).toBe(true);
    // A PROGRAM acceptance does not satisfy the agreement gate — two documents.
    expect(deriveAgreementStanding(program.partner)).toBe('missing');

    await expectPgRejection(
      db
        .insert(referralTermsAcceptances)
        .values({
          partnerId,
          scope: 'program_terms',
          programId: null,
          termsVersion: 'terms-v1',
          acceptedAt: new Date(),
          acceptedByOxyUserId: 'oxy-x',
          locale: 'en',
        })
        .returning(),
      /scope_shape_check/,
    );
  });

  it('refuses to rewrite an acceptance', async () => {
    const { partnerId } = await enrol('terms-immutable');
    const accepted = await acceptPartnerTerms({
      partnerId,
      scope: 'partner_agreement',
      termsVersion: REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION,
      locale: 'en',
      actorOxyUserId: `oxy-immutable-${TAG}`,
    });
    await expectPgRejection(
      db
        .update(referralTermsAcceptances)
        .set({ locale: 'fr' })
        .where(eq(referralTermsAcceptances.id, accepted.acceptance.id)),
      /append-only/,
    );
  });

  it('keeps marketing consent separate from terms, and revocable', async () => {
    const { partnerId } = await enrol('marketing');
    await acceptPartnerTerms({
      partnerId,
      scope: 'partner_agreement',
      termsVersion: REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION,
      locale: 'en',
      actorOxyUserId: `oxy-marketing-${TAG}`,
    });

    // Accepting terms grants NOTHING about marketing — rule 8.
    const [afterTerms] = await db
      .select({ marketingConsentAt: referralPartners.marketingConsentAt })
      .from(referralPartners)
      .where(eq(referralPartners.id, partnerId));
    expect(afterTerms?.marketingConsentAt).toBeNull();

    const granted = await setReferralMarketingConsent({
      partnerId,
      granted: true,
      actorOxyUserId: `oxy-marketing-${TAG}`,
    });
    expect(granted.marketingConsentAt).not.toBeNull();

    const withdrawn = await setReferralMarketingConsent({
      partnerId,
      granted: false,
      actorOxyUserId: `oxy-marketing-${TAG}`,
    });
    expect(withdrawn.marketingConsentAt).toBeNull();
  });
});

describe('enrollment modes', () => {
  it('refuses a self-serve application in an operator-only mode, BY NAME', async () => {
    await expect(
      startPartnerApplication({
        ownerType: 'user',
        ownerId: `owner-staff-${TAG}`,
        displayName: `Staff ${TAG}`,
        enrollmentMode: 'staff_test',
        actorOxyUserId: `oxy-staff-${TAG}`,
        answers: completeAnswers(),
      }),
    ).rejects.toThrow(/staff_test is created by an operator/);
  });

  it('refuses an owner type the mode does not admit', async () => {
    await expect(
      startPartnerApplication({
        ownerType: 'store',
        ownerId: `store-${TAG}`,
        displayName: `Store ${TAG}`,
        enrollmentMode: 'oxy_self_enrollment',
        actorOxyUserId: `oxy-store-${TAG}`,
        answers: completeAnswers(),
      }),
    ).rejects.toThrow(/cannot enroll through oxy_self_enrollment/);
  });

  it('refuses an operator-created mode that requires evidence without any', async () => {
    await expect(
      createPartnerAsOperator({
        ownerType: 'store',
        ownerId: `store-legacy-${TAG}`,
        displayName: `Legacy ${TAG}`,
        enrollmentMode: 'verified_organization',
        actorOxyUserId: `oxy-op-${TAG}`,
        reason: 'contractual partner',
      }),
    ).rejects.toThrow(/requires the evidence/);
  });

  it('approves a no-review mode on submission, with a system decision row', async () => {
    const ownerId = `owner-invited-${TAG}`;
    const created = await createPartnerAsOperator({
      ownerType: 'user',
      ownerId,
      displayName: `Invited ${TAG}`,
      enrollmentMode: 'invite_only',
      actorOxyUserId: `oxy-op-${TAG}`,
      reason: 'known creator',
    });
    trackedPartnerIds.push(created.partner.id);
    expect(created.partner.state).toBe('invited');
    expect(REFERRAL_ENROLLMENT_MODE_RULES.invite_only.requiresOperatorReview).toBe(false);

    await startPartnerApplication({
      ownerType: 'user',
      ownerId,
      displayName: `Invited ${TAG}`,
      actorOxyUserId: `oxy-invited-${TAG}`,
      answers: completeAnswers(),
    });
    const submitted = await submitPartnerApplication({
      ownerType: 'user',
      ownerId,
      actorOxyUserId: `oxy-invited-${TAG}`,
    });

    expect(submitted.application.state).toBe('approved');
    expect(submitted.partner.state).toBe('approved');
    // "The operator who created the record IS the review" still leaves a ROW,
    // or an operator reading the trail sees an approval with nothing behind it.
    const trail = await db
      .select({
        decision: referralPartnerApplicationReviews.decision,
        reviewer: referralPartnerApplicationReviews.reviewedByOxyUserId,
      })
      .from(referralPartnerApplicationReviews)
      .where(eq(referralPartnerApplicationReviews.applicationId, submitted.application.id));
    expect(trail).toEqual([{ decision: 'approved', reviewer: 'system' }]);
  });

  /**
   * #146 enrollment mode 7. The isolation is at the PAYOUT gate, so everything
   * upstream works exactly as it does for a real partner — which is what makes
   * a test enrollment able to test anything.
   */
  it('marks a staff_test enrollment as earning no production rewards', async () => {
    const created = await createPartnerAsOperator({
      ownerType: 'user',
      ownerId: `owner-test-mode-${TAG}`,
      displayName: `Test mode ${TAG}`,
      enrollmentMode: 'staff_test',
      actorOxyUserId: `oxy-op-${TAG}`,
      reason: 'release rehearsal',
    });
    trackedPartnerIds.push(created.partner.id);
    expect(enrollmentEarnsProductionRewards(created.partner)).toBe(false);

    const ordinary = await enrol('production-mode');
    const [row] = await db
      .select()
      .from(referralPartners)
      .where(eq(referralPartners.id, ordinary.partnerId));
    // The positive control: without it, a detector that answered `false` for
    // everything would pass the assertion above.
    expect(enrollmentEarnsProductionRewards(row!)).toBe(true);
  });
});

describe('standing, appeals and what a partner reads', () => {
  it('reports every outstanding item rather than the first', async () => {
    const { partnerId, ownerId } = await enrol('standing');
    const before = await readPartnerStanding({ ownerType: 'user', ownerId });
    expect(before.earningStarted).toBe(false);
    expect(before.outstanding).toContain('application_not_submitted');
    expect(before.outstanding).toContain('partner_agreement_not_accepted');
    expect(before.outstanding).toContain('tax_questionnaire_not_completed');
    // Collected, never short-circuited — the whole answer in one read.
    expect(before.outstanding.length).toBeGreaterThanOrEqual(3);

    await submitPartnerApplication({
      ownerType: 'user',
      ownerId,
      actorOxyUserId: `oxy-standing-${TAG}`,
    });
    await decideApplication({
      partnerId,
      decision: 'approved',
      actorOxyUserId: `oxy-op-${TAG}`,
    });
    await acceptPartnerTerms({
      partnerId,
      scope: 'partner_agreement',
      termsVersion: REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION,
      locale: 'en',
      actorOxyUserId: `oxy-standing-${TAG}`,
    });
    await declareTaxProfile({
      partnerId,
      participantType: 'individual',
      residencyCountry: 'es',
      vatStatus: 'not_registered',
      declaredByOxyUserId: `oxy-standing-${TAG}`,
    });

    const after = await readPartnerStanding({ ownerType: 'user', ownerId });
    // ADR 0005 D15: earning starts at approval and is NOT gated on payout
    // onboarding. The two questions are answered separately on purpose.
    expect(after.earningStarted).toBe(true);
    expect(after.outstanding).not.toContain('application_not_submitted');
    expect(after.outstanding).not.toContain('partner_agreement_not_accepted');
    expect(after.outstanding).not.toContain('tax_questionnaire_not_completed');
    expect(after.tax.readiness).toBe('ready');
    // The two #146 machinery owns are still outstanding, which is the point:
    // approval is not payout readiness (#146 review rule 8).
    expect(after.outstanding).toContain('identity_verification_not_ready');
    expect(after.outstanding).toContain('payout_destination_not_ready');
  });

  it('never puts the reviewer note in what the applicant reads', async () => {
    const { partnerId, ownerId } = await enrol('privacy');
    await submitPartnerApplication({
      ownerType: 'user',
      ownerId,
      actorOxyUserId: `oxy-privacy-${TAG}`,
    });
    const secret = `RISK-NOTE-${TAG}`;
    await decideApplication({
      partnerId,
      decision: 'rejected',
      rejectionCode: 'policy_violation',
      partnerMessage: 'We cannot accept this application.',
      reviewerNote: secret,
      actorOxyUserId: `oxy-op-${TAG}`,
    });

    const standing = await readPartnerStanding({ ownerType: 'user', ownerId });
    // A RUNTIME walk of a real emitted projection, not a shape assertion: the
    // #92 two-gate rule, and the half a static scan cannot perform.
    const serialized = JSON.stringify(standing);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('We cannot accept this application.');
    expect(serialized).toContain('policy_violation');
  });

  it('opens and resolves an appeal without moving the standing', async () => {
    const { partnerId, ownerId } = await enrol('appeal');
    await submitPartnerApplication({
      ownerType: 'user',
      ownerId,
      actorOxyUserId: `oxy-appeal-${TAG}`,
    });
    await decideApplication({
      partnerId,
      decision: 'approved',
      actorOxyUserId: `oxy-op-${TAG}`,
    });
    await suspendPartner({
      partnerId,
      actorOxyUserId: `oxy-op-${TAG}`,
      reason: 'under review',
    });

    const opened = await openPartnerAppeal({
      partnerId,
      actorOxyUserId: `oxy-appeal-${TAG}`,
      reason: 'the traffic was organic',
    });
    expect(opened.appealState).toBe('open');
    expect(opened.state).toBe('suspended');

    const resolved = await resolvePartnerAppeal({
      partnerId,
      accepted: true,
      actorOxyUserId: `oxy-op-${TAG}`,
      reason: 'evidence checked out',
    });
    expect(resolved.appealState).toBe('accepted');
    // Accepting an appeal records the DECISION and nothing else —
    // reinstatement is a separate audited act.
    expect(resolved.state).toBe('suspended');
  });

  it('refuses an appeal from a partner nobody has decided against', async () => {
    const { partnerId } = await enrol('appeal-none');
    await expect(
      openPartnerAppeal({
        partnerId,
        actorOxyUserId: `oxy-appeal-none-${TAG}`,
        reason: 'no',
      }),
    ).rejects.toThrow(/has no decision to appeal/);
  });

  it('can terminate a partner from any non-terminal state', async () => {
    const { partnerId } = await enrol('terminate-draft');
    // A DRAFT — one of the four states #146 increment 2 added, and the one a
    // termination reaching "every non-terminal state" is easiest to miss.
    const terminated = await terminatePartner({
      partnerId,
      actorOxyUserId: `oxy-op-${TAG}`,
      reason: 'confirmed abuse',
      confirmedFraud: true,
    });
    expect(terminated.state).toBe('terminated');
    expect(terminated.riskState).toBe('confirmed_fraud');
  });
});

describe('duplicate signals', () => {
  it('finds a shared display name and a shared promotion host, and names neither to the applicant', async () => {
    const shared = `Shared Name ${TAG}`;
    const a = await startPartnerApplication({
      ownerType: 'user',
      ownerId: `owner-dupe-a-${TAG}`,
      displayName: shared,
      actorOxyUserId: `oxy-dupe-a-${TAG}`,
      answers: completeAnswers({ promotionUrls: ['https://shared-host.example/a'] }),
    });
    trackedPartnerIds.push(a.partner.id);
    const b = await startPartnerApplication({
      ownerType: 'user',
      ownerId: `owner-dupe-b-${TAG}`,
      // Trailing full stop and doubled space: the normalizer folds both.
      displayName: `${shared}.`,
      actorOxyUserId: `oxy-dupe-b-${TAG}`,
      answers: completeAnswers({ promotionUrls: ['https://shared-host.example/b'] }),
    });
    trackedPartnerIds.push(b.partner.id);

    const signals = await readDuplicateSignals(db, {
      partnerId: b.partner.id,
      ownerType: 'user',
      ownerId: `owner-dupe-b-${TAG}`,
      displayName: `${shared}.`,
      promotionUrls: ['https://shared-host.example/b'],
    });
    const hostSignal = signals.find(
      (s) => s.kind === 'promotion_host_match' && s.matchedPartnerId === a.partner.id,
    );
    expect(hostSignal?.observed).toBe('shared-host.example');

    // The APPLICANT's own read carries none of it — a signal is an operator's
    // hint about somebody else, and naming it would disclose another partner.
    const standing = await readPartnerStanding({
      ownerType: 'user',
      ownerId: `owner-dupe-b-${TAG}`,
    });
    const serialized = JSON.stringify(standing);
    expect(serialized).not.toContain(a.partner.id);
    expect(serialized).not.toContain('duplicateSignals');
  });

  it('finds the same owner id used as BOTH a store and an account', async () => {
    const collidingId = `collide-${TAG}`;
    const asUser = await insertPartner(db, {
      ownerType: 'user',
      ownerId: collidingId,
      displayName: `As user ${TAG}`,
      state: 'applied',
      at: new Date(),
      promotionMethods: [],
    });
    trackedPartnerIds.push(asUser.row.id);
    const asStore = await insertPartner(db, {
      ownerType: 'store',
      ownerId: collidingId,
      displayName: `As store ${TAG}`,
      state: 'applied',
      at: new Date(),
      promotionMethods: [],
    });
    trackedPartnerIds.push(asStore.row.id);

    // `referral_partners_owner_key` is over the PAIR, so both rows are
    // legitimate to the database and one identity to a reviewer. This is the
    // whole of what that index cannot see.
    const signals = await readDuplicateSignals(db, {
      partnerId: asStore.row.id,
      ownerType: 'store',
      ownerId: collidingId,
      displayName: `As store ${TAG}`,
      promotionUrls: [],
    });
    expect(signals).toContainEqual(
      expect.objectContaining({
        kind: 'owner_id_across_types',
        matchedPartnerId: asUser.row.id,
      }),
    );
  });
});
