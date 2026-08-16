/**
 * The PURE halves of enrollment (#146 increment 2): normalizing what an
 * applicant typed, deciding whether an accepted agreement still counts, and
 * collecting what a partner still owes.
 *
 * Each of these has a database CHECK behind it saying the same thing, and the
 * split is deliberate: the CHECK is what holds against `psql`, a replay and a
 * service bug, and these functions are what can tell an applicant WHICH of
 * their five links was the problem. A test of one is not a test of the other,
 * which is why both exist.
 */

import { describe, expect, it } from 'vitest';
import {
  REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION,
  REFERRAL_PARTNER_AGREEMENT_VERSIONS,
} from '@mercaria/shared-types';
import {
  MAX_PROMOTION_URLS,
  missingSubmissionRequirements,
  normalizeApplicationAnswers,
  normalizePromotionUrl,
  promotionUrlHost,
} from '../application-answers.js';
import {
  acceptanceSatisfiesPartnerAgreement,
  activeReferralPartnerAgreement,
  publishedReferralPartnerAgreements,
  REFERRAL_PARTNER_AGREEMENT_TERMS,
} from '../partner-agreement.js';
import {
  deriveEarningStarted,
  deriveOutstandingItems,
  type PartnerStandingFacts,
} from '../partner-standing.service.js';
import {
  normalizeDisplayNameForComparison,
  promotionHostsOf,
} from '../duplicate-signals.js';

/**
 * Safely in the PAST, per `fixture-date-census.test.ts`.
 *
 * The value is inert — it is the instant a consent is stamped with, and nothing
 * here compares it against a clock — but a fixture the real clock is still
 * travelling toward passes today, keeps passing, and breaks CI for whoever
 * pushes on the day it arrives, in a file they did not touch (#253).
 */
const AT = new Date('2026-01-15T10:00:00.000Z');

describe('promotion URLs', () => {
  it('normalizes case and a trailing slash to ONE stored form', () => {
    // Two applicants writing the same site must not read as two sites to the
    // duplicate detector, which is the whole reason the stored value is what
    // `URL` produced rather than what was typed.
    expect(normalizePromotionUrl('https://Example.com', 0)).toBe('https://example.com/');
    expect(normalizePromotionUrl('https://example.com/', 0)).toBe('https://example.com/');
  });

  it('refuses every scheme but https, by name', () => {
    for (const raw of ['http://example.com', 'javascript:alert(1)', 'data:text/html,x']) {
      expect(() => normalizePromotionUrl(raw, 0)).toThrow(/must start with https/);
    }
  });

  it('refuses credentials in the URL', () => {
    // `https://user:pass@example.com` carries a secret into a column a reviewer
    // reads, and the reviewer is not who it was meant for.
    expect(() => normalizePromotionUrl('https://user:pass@example.com', 0)).toThrow(
      /must not carry credentials/,
    );
  });

  it('refuses a single-label host', () => {
    expect(() => normalizePromotionUrl('https://localhost', 0)).toThrow(/names no public host/);
    expect(() => normalizePromotionUrl('https://intranet', 0)).toThrow(/names no public host/);
  });

  it('names WHICH link failed', () => {
    // The half a CHECK cannot do: the database refuses the joined array and can
    // say nothing about which element was wrong.
    expect(() => normalizePromotionUrl('http://a.example', 2)).toThrow(/Promotion link 3/);
  });

  it('bounds the count', () => {
    const many = Array.from({ length: MAX_PROMOTION_URLS + 1 }, (_, i) => `https://x${String(i)}.example`);
    expect(() => normalizeApplicationAnswers({ promotionUrls: many }, AT)).toThrow(/At most 10/);
  });

  it('reads a host back, and answers undefined rather than throwing on rubbish', () => {
    expect(promotionUrlHost('https://blog.example.com/x')).toBe('blog.example.com');
    // Runs over rows already stored: a detector that threw on one bad row would
    // stop reporting the good ones.
    expect(promotionUrlHost('not a url')).toBeUndefined();
  });
});

describe('markets and consents', () => {
  it('upper-cases and de-duplicates markets', () => {
    const answers = normalizeApplicationAnswers({ markets: ['es', 'ES', 'pt'] }, AT);
    expect(answers.markets).toEqual(['ES', 'PT']);
  });

  it('refuses anything that is not an alpha-2 code', () => {
    expect(() => normalizeApplicationAnswers({ markets: ['ESP'] }, AT)).toThrow(/alpha-2/);
    expect(() => normalizeApplicationAnswers({ markets: ['E5'] }, AT)).toThrow(/alpha-2/);
  });

  it('records a consent as an INSTANT and its absence as null', () => {
    const given = normalizeApplicationAnswers({ reviewConsent: true }, AT);
    expect(given.reviewConsentAt).toEqual(AT);
    // Never a falsy instant: `null` says nobody consented, and there is no value
    // that could say "consented at the zero epoch" and be read as consent by
    // something scanning for a non-null column.
    const withheld = normalizeApplicationAnswers({ reviewConsent: false }, AT);
    expect(withheld.reviewConsentAt).toBeNull();
    expect(normalizeApplicationAnswers({}, AT).communicationConsentAt).toBeNull();
  });

  it('ties a related-party disclosure to its declaration, both ways', () => {
    expect(() => normalizeApplicationAnswers({ hasRelatedParty: true }, AT)).toThrow(
      /needs a disclosure/,
    );
    expect(() =>
      normalizeApplicationAnswers({ hasRelatedParty: false, relatedPartyDisclosure: 'x' }, AT),
    ).toThrow(/without declaring a related party/);
  });

  it('collects EVERY missing submission requirement, not the first', () => {
    const answers = normalizeApplicationAnswers({}, AT);
    const missing = missingSubmissionRequirements(answers);
    expect(missing.length).toBeGreaterThanOrEqual(4);
    expect(missing.join(' ')).toMatch(/prohibited-method/);
    expect(missing.join(' ')).toMatch(/consent to review/);
    expect(missing.join(' ')).toMatch(/contacted/);
    expect(missing.join(' ')).toMatch(/promotion method/);
  });

  it('reports nothing missing on a complete set', () => {
    // The positive control: without it, a `missingSubmissionRequirements` that
    // returned everything unconditionally would satisfy the assertion above.
    const answers = normalizeApplicationAnswers(
      {
        promotionMethods: ['website'],
        prohibitedMethodsAcknowledged: true,
        reviewConsent: true,
        communicationConsent: true,
      },
      AT,
    );
    expect(missingSubmissionRequirements(answers)).toEqual([]);
  });
});

describe('the partner agreement', () => {
  it('publishes every version in the shared-types tuple, and no other', () => {
    expect(Object.keys(REFERRAL_PARTNER_AGREEMENT_TERMS).sort()).toEqual(
      [...REFERRAL_PARTNER_AGREEMENT_VERSIONS].sort(),
    );
    expect(publishedReferralPartnerAgreements().map((t) => t.version)).toEqual([
      ...REFERRAL_PARTNER_AGREEMENT_VERSIONS,
    ]);
  });

  it('says out loud what it does not grant', () => {
    // #146 review rule 7 is a promise Mercaria makes to a partner as well as a
    // property of the code, and a partner who reads the agreement should find
    // it there.
    const clauses = activeReferralPartnerAgreement().clauses;
    const noPermissions = clauses.find((clause) => clause.key === 'no_permissions');
    expect(noPermissions?.body).toMatch(/no access to any shop/i);
  });

  it('states the withholding ruling, because it is what a partner needs to know', () => {
    const tax = activeReferralPartnerAgreement().clauses.find((clause) => clause.key === 'tax');
    expect(tax?.body).toMatch(/withholds no tax/i);
    expect(tax?.body).toMatch(/responsible for your own income tax/i);
  });

  it('accepts the active version and refuses one nobody published', () => {
    expect(acceptanceSatisfiesPartnerAgreement(REFERRAL_ACTIVE_PARTNER_AGREEMENT_VERSION)).toBe(true);
    expect(acceptanceSatisfiesPartnerAgreement('partner-1999-01')).toBe(false);
    expect(acceptanceSatisfiesPartnerAgreement('')).toBe(false);
  });
});

describe('what a partner still owes', () => {
  const READY: PartnerStandingFacts = {
    partnerState: 'approved',
    enrollmentMode: 'open_application',
    applicationState: 'approved',
    agreementStanding: 'accepted',
    identityReadiness: 'ready',
    taxReadiness: 'ready',
    payoutReadiness: 'ready',
  };

  it('owes nothing when everything is done', () => {
    expect(deriveOutstandingItems(READY)).toEqual([]);
    expect(deriveEarningStarted(READY)).toBe(true);
  });

  it('collects every reason rather than the first', () => {
    const items = deriveOutstandingItems({
      ...READY,
      partnerState: 'suspended',
      applicationState: 'changes_requested',
      agreementStanding: 'superseded',
      identityReadiness: 'pending',
      taxReadiness: 'unknown',
      payoutReadiness: 'blocked',
      enrollmentMode: 'staff_test',
    });
    // SEVEN independent things are wrong and the answer names all seven — the
    // argument `deriveRewardPayability` makes one layer down. An exact length
    // rather than a floor, so a derivation that started collapsing two reasons
    // into one fails here rather than quietly telling somebody less.
    expect(items).toHaveLength(7);
    expect(items).toContain('partner_suspended');
    expect(items).toContain('application_changes_requested');
    expect(items).toContain('partner_agreement_superseded');
    expect(items).toContain('enrollment_is_test_only');
  });

  it('separates EARNING from withdrawal', () => {
    // ADR 0005 D15: a participant may accrue before payout onboarding is
    // complete, so an approved partner is earning even with all three gates
    // outstanding. Collapsing the two is what makes somebody think their
    // balance is at risk because a form is unfinished.
    const accruing: PartnerStandingFacts = {
      ...READY,
      identityReadiness: 'pending',
      taxReadiness: 'pending',
      payoutReadiness: 'pending',
    };
    expect(deriveEarningStarted(accruing)).toBe(true);
    expect(deriveOutstandingItems(accruing)).toHaveLength(3);

    expect(deriveEarningStarted({ ...READY, partnerState: 'under_review' })).toBe(false);
    expect(deriveEarningStarted({ ...READY, partnerState: 'suspended' })).toBe(false);
  });

  it('distinguishes a MISSING agreement from a superseded one', () => {
    // Different copy and a different next action: one has accepted nothing, the
    // other needs to read a change.
    expect(deriveOutstandingItems({ ...READY, agreementStanding: 'missing' })).toEqual([
      'partner_agreement_not_accepted',
    ]);
    expect(deriveOutstandingItems({ ...READY, agreementStanding: 'superseded' })).toEqual([
      'partner_agreement_superseded',
    ]);
  });
});

describe('duplicate-signal normalization', () => {
  it('folds case, quotes, a trailing stop and doubled spaces', () => {
    expect(normalizeDisplayNameForComparison('  The  Gadget "Shop".  ')).toBe('the gadget shop');
  });

  it('does NOT fold genuinely different names', () => {
    // The positive control on the other side: a normalizer aggressive enough to
    // catch every lookalike folds real names together and fires constantly,
    // which is how a hint becomes noise nobody reads.
    expect(normalizeDisplayNameForComparison('Gadget Shop')).not.toBe(
      normalizeDisplayNameForComparison('Gadget Shops'),
    );
  });

  it('de-duplicates hosts and drops what it cannot parse', () => {
    expect(
      promotionHostsOf(['https://a.example/1', 'https://A.example/2', 'nonsense']),
    ).toEqual(['a.example']);
  });
});
