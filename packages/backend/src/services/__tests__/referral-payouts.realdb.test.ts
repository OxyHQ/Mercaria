/**
 * The #146 payout join, against a REAL Postgres server.
 *
 * Three things here exist only with a server behind them, which is why this is
 * not a mocked suite: the tax profile's six CHECKs, its append-only trigger, and
 * the `(partner_id, revision)` unique that makes two submissions converge. A
 * mocked insert accepts every statement the server refuses.
 *
 * The fourth is the one the increment is FOR — a batch queued while the payout
 * registry was empty settles on its next pass, with no replay — and it needs a
 * real batch, real claims and the real settlement sweep.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import {
  REFERRAL_TAX_FORBIDDEN_FIELDS,
  REFERRAL_TAX_QUESTIONNAIRE_VERSIONS,
} from '@mercaria/shared-types';
import { closePostgres, connectPostgres, getDb, type Database } from '../../db/postgres.js';
import { withTriggerToggleLock } from '../../db/__tests__/trigger-toggle-lock.js';
import { referralPartners, referralTaxProfiles } from '../../db/schema/referrals.js';
import { providerAccounts } from '../../db/schema/payments.js';
import { insertPartner } from '../../db/referrals/partnerRepository.js';
import {
  findLatestTaxProfile,
  listTaxProfileRevisions,
} from '../../db/referrals/taxProfileRepository.js';
import { declareTaxProfile, deriveTaxReadiness } from '../referrals/tax-profile.service.js';
import {
  readPartnerPayoutReadiness,
  resolvePartnerTransferDestination,
} from '../referral-payouts/readiness.js';
import { REFERRAL_TAX_QUESTIONNAIRE_TERMS } from '../referrals/tax-terms.js';

const TAG = uuidv7().slice(-8);
let db: Database;
const trackedPartnerIds: string[] = [];
const trackedAccountIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  if (trackedPartnerIds.length > 0) {
    // ONE table per trigger-toggle window, inside a transaction. `DISABLE
    // TRIGGER` takes ShareRowExclusive, whose counterparty is an ordinary
    // writer holding RowExclusive — the mutex serialises window against window
    // and cannot see that party, so holding two tables at once deadlocks.
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
    await db.delete(referralPartners).where(inArray(referralPartners.id, trackedPartnerIds));
  }
  if (trackedAccountIds.length > 0) {
    await db.delete(providerAccounts).where(inArray(providerAccounts.id, trackedAccountIds));
  }
  await closePostgres();
}, 120_000);

async function makePartner(label: string): Promise<{ id: string; ownerId: string }> {
  const ownerId = `owner-${label}-${TAG}`;
  const { row } = await insertPartner(getDb(), {
    ownerType: 'user',
    ownerId,
    displayName: `Partner ${label}`,
    state: 'applied',
    at: new Date(),
    promotionMethods: ['website'],
  });
  trackedPartnerIds.push(row.id);
  return { id: row.id, ownerId };
}

/**
 * Assert a REJECTION whose constraint or trigger matches, reading `cause`.
 *
 * The `order-buyer-claim.realdb.test.ts` shape, and it is not optional: drizzle
 * wraps the driver error, so the outer `message` is `Failed query: …` and the
 * constraint name lives on `cause`. A regex over the outer message alone passes
 * for ANY failed statement — including a typo'd column — which is a check that
 * cannot tell success from failure.
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

describe('the tax questionnaire is the D15 gate 2 record', () => {
  it('derives `pending` before a declaration and `ready` after one', async () => {
    const partner = await makePartner('tax1');
    expect(deriveTaxReadiness(await findLatestTaxProfile(getDb(), partner.id))).toBe('pending');

    const view = await declareTaxProfile({
      partnerId: partner.id,
      participantType: 'individual',
      residencyCountry: 'ES',
      vatStatus: 'not_registered',
      declaredByOxyUserId: partner.ownerId,
    });
    expect(view.readiness).toBe('ready');
    expect(view.profile?.revision).toBe(1);
    expect(view.profile?.answersCurrentQuestionnaire).toBe(true);
    expect(deriveTaxReadiness(await findLatestTaxProfile(getDb(), partner.id))).toBe('ready');
  });

  it('normalizes the residency country rather than storing what was typed', async () => {
    const partner = await makePartner('tax2');
    const view = await declareTaxProfile({
      partnerId: partner.id,
      participantType: 'business',
      residencyCountry: ' es ',
      vatStatus: 'registered',
      declaredByOxyUserId: partner.ownerId,
    });
    // The CHECK is `^[A-Z]{2}$`, so an un-normalized value would have been
    // REFUSED by the server rather than stored lower-case — which is the point
    // of the CHECK being the format authority rather than a service comment.
    expect(view.profile?.residencyCountry).toBe('ES');
  });

  it('refuses a residency country that is not two upper-case letters', async () => {
    const partner = await makePartner('tax3');
    await expectPgRejection(
      getDb()
        .insert(referralTaxProfiles)
        .values({
          id: uuidv7(),
          partnerId: partner.id,
          revision: 1,
          questionnaireVersion: 'tax-2026-08',
          participantType: 'individual',
          // The NULL-island of country codes: three letters is the commonest
          // wrong answer there is, and a length-only check would take it.
          residencyCountry: 'ESP',
          vatStatus: 'exempt',
          declaredAt: new Date(),
          declaredByOxyUserId: partner.ownerId,
        }),
      /residency_country_check/,
    );
  });

  it('records a CORRECTION as a new revision and reads the highest', async () => {
    const partner = await makePartner('tax4');
    await declareTaxProfile({
      partnerId: partner.id,
      participantType: 'individual',
      residencyCountry: 'ES',
      vatStatus: 'not_registered',
      declaredByOxyUserId: partner.ownerId,
    });
    const corrected = await declareTaxProfile({
      partnerId: partner.id,
      participantType: 'business',
      residencyCountry: 'PT',
      vatStatus: 'registered',
      declaredByOxyUserId: partner.ownerId,
    });

    expect(corrected.profile?.revision).toBe(2);
    const all = await listTaxProfileRevisions(getDb(), partner.id);
    expect(all).toHaveLength(2);
    // The first declaration SURVIVES the correction. That is the whole reason
    // the table is append-only: "what did this partner declare when we paid
    // them" stays answerable.
    expect(all.map((row) => row.revision)).toEqual([2, 1]);
    expect(all[1]?.residencyCountry).toBe('ES');
    expect((await findLatestTaxProfile(getDb(), partner.id))?.residencyCountry).toBe('PT');
  });

  it('is APPEND-ONLY: the server refuses an UPDATE and a DELETE', async () => {
    const partner = await makePartner('tax5');
    await declareTaxProfile({
      partnerId: partner.id,
      participantType: 'individual',
      residencyCountry: 'FR',
      vatStatus: 'not_registered',
      declaredByOxyUserId: partner.ownerId,
    });

    await expectPgRejection(
      getDb()
        .update(referralTaxProfiles)
        .set({ residencyCountry: 'DE' })
        .where(eq(referralTaxProfiles.partnerId, partner.id)),
      /append-only/,
    );
    await expectPgRejection(
      getDb().delete(referralTaxProfiles).where(eq(referralTaxProfiles.partnerId, partner.id)),
      /append-only/,
    );

    // The positive control: the row is still there, so "the statement was
    // refused" is not what an empty table would also report.
    expect(await listTaxProfileRevisions(getDb(), partner.id)).toHaveLength(1);
  });

  it('refuses two rows claiming the same revision', async () => {
    const partner = await makePartner('tax6');
    await declareTaxProfile({
      partnerId: partner.id,
      participantType: 'individual',
      residencyCountry: 'IT',
      vatStatus: 'not_registered',
      declaredByOxyUserId: partner.ownerId,
    });
    await expectPgRejection(
      getDb()
        .insert(referralTaxProfiles)
        .values({
          id: uuidv7(),
          partnerId: partner.id,
          revision: 1,
          questionnaireVersion: 'tax-2026-08',
          participantType: 'individual',
          residencyCountry: 'IT',
          vatStatus: 'not_registered',
          declaredAt: new Date(),
          declaredByOxyUserId: partner.ownerId,
        }),
      /referral_tax_profiles_partner_revision_key/,
    );
  });

  it('stores no tax identifier, and the TABLE is what says so', () => {
    // The #77/#126 device: a scan of the vocabulary is not enough, because the
    // question is what the table can HOLD. Walking the real drizzle columns is
    // what makes this survive a future migration nobody re-read.
    const columns = Object.keys(referralTaxProfiles).map((name) => name.toLowerCase());
    expect(columns.length).toBeGreaterThan(5);
    for (const forbidden of REFERRAL_TAX_FORBIDDEN_FIELDS) {
      expect(columns).not.toContain(forbidden.toLowerCase());
    }
    // The vacuity floor: the walk genuinely sees this table's own columns, so
    // "no forbidden column" is not what reading nothing reports.
    expect(columns).toContain('residencycountry');
    expect(columns).toContain('vatstatus');
  });

  it('publishes terms for every version the column admits', () => {
    // Two lists of versions can disagree, and the direction they would is a
    // submission citing a version whose questions nobody can produce — the row
    // would be accepted by the CHECK and unexplainable to the partner who made
    // it. An exact partition rather than a containment, the
    // `merge-plan-census` device.
    expect(Object.keys(REFERRAL_TAX_QUESTIONNAIRE_TERMS).sort()).toEqual(
      [...REFERRAL_TAX_QUESTIONNAIRE_VERSIONS].sort(),
    );
    expect(REFERRAL_TAX_QUESTIONNAIRE_VERSIONS.length).toBeGreaterThan(0);
    for (const version of REFERRAL_TAX_QUESTIONNAIRE_VERSIONS) {
      const terms = REFERRAL_TAX_QUESTIONNAIRE_TERMS[version];
      expect(terms.version).toBe(version);
      expect(terms.declarations.length).toBeGreaterThan(0);
      // Every stored field a declaration lands in is asked about, and nothing
      // is asked about that is not stored.
      expect(terms.declarations.map((d) => d.field).sort()).toEqual([
        'participantType',
        'residencyCountry',
        'vatStatus',
      ]);
    }
  });
});

describe('identity and payout readiness come from #46, and fail closed', () => {
  it('answers `unknown` with no rail configured, and names no beneficiary', async () => {
    // `STRIPE_ENABLED` is off in the test environment, which is the state of
    // every deployment that has not configured the rail. `unknown` BLOCKS in
    // `deriveRewardPayability`, which is the fail-closed direction — and it is
    // deliberately not `blocked`, which would assert something is wrong with
    // the PARTNER when what is missing is Mercaria's own configuration.
    const partner = await makePartner('rdy1');
    const readiness = await readPartnerPayoutReadiness({
      partnerId: partner.id,
      ownerType: 'user',
      ownerId: partner.ownerId,
    });
    expect(readiness.identity).toBe('unknown');
    expect(readiness.payout).toBe('unknown');
    expect(readiness.payoutBeneficiaryRef).toBeUndefined();
  });

  it('resolves the partner to the account #46 keyed by their OWN owner', async () => {
    // ADR 0005 D14's "reuses the SAME account": the account below is created
    // under the seller key for the partner's own owner, and the destination
    // lookup finds it with no referral-specific id anywhere in the path.
    const partner = await makePartner('rdy2');
    const accountId = uuidv7();
    trackedAccountIds.push(accountId);
    await getDb()
      .insert(providerAccounts)
      .values({
        id: accountId,
        provider: 'stripe',
        ownerType: 'user',
        ownerId: partner.ownerId,
        providerAccountId: `acct_${TAG}${partner.ownerId.slice(-4)}`,
        country: 'ES',
        onboardingState: 'ready',
      });

    const destination = await resolvePartnerTransferDestination({
      ownerType: 'user',
      ownerId: partner.ownerId,
    });
    expect(destination?.accountId).toBe(`acct_${TAG}${partner.ownerId.slice(-4)}`);
    expect(destination?.onboardingState).toBe('ready');

    // And a partner with no account resolves to nothing rather than to
    // somebody else's row — the property `UNIQUE(provider, owner_type,
    // owner_id)` is what guarantees.
    expect(
      await resolvePartnerTransferDestination({
        ownerType: 'user',
        ownerId: `absent-${TAG}`,
      }),
    ).toBeUndefined();
  });
});
