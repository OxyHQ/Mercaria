/**
 * Why `shared_payout_beneficiary` has NO producer, proved against a real server
 * (#344, #148).
 *
 * #344 lists `sharedPayoutBeneficiaryPartnerCount` as one of three facts a
 * payment-domain join would supply, and `ReferralRiskSignalFacts` states its
 * contract: *"Another approved partner resolves to the same `provider_accounts`
 * row."* **No two partners can, and two unique indexes are why.** A producer
 * would therefore return zero for every partner forever — a signal that cannot
 * fire, reporting a clean bill on somebody nobody examined, which is the exact
 * "green and inert" failure this codebase refuses everywhere else.
 *
 * The resolution partner → owner → account row is INJECTIVE at every hop:
 *
 *  1. `referral_partners_owner_key` is unique on `(owner_type, owner_id)`, so
 *     one owner pair is one partner.
 *  2. `referralPayoutAccountOwner` is the IDENTITY translation — it returns the
 *     partner's own owner pair and consults nothing — so one partner is one
 *     account owner.
 *  3. `provider_accounts_provider_account_id_key` is unique on
 *     `(provider, provider_account_id)`, so one Stripe account is one row.
 *
 * Two partners sharing a beneficiary would have to break one of the three, and
 * this file asserts all three so the finding is a GATE rather than a paragraph
 * somebody has to find. It goes red the day one of them changes, which is the
 * day the fact becomes measurable and the producer becomes worth writing.
 *
 * ## What would reopen it, precisely
 *
 * #146 increment 3's deferred **beneficiary change** — letting a partner
 * nominate a payout destination that is NOT their own owner. That breaks hop 2
 * by design: `referralPayoutAccountOwner` stops being the identity, two partners
 * can name one account, and the signal starts meaning something. Nothing else in
 * the roadmap does.
 *
 * Discovered by writing the producer and watching the fixture fail `23505` on
 * `provider_accounts_provider_account_id_key` — the constraint refusing the very
 * shape the signal exists to detect. The producer was reverted rather than
 * shipped returning zero.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, getDb, type Database } from '../../db/postgres.js';
import { providerAccounts } from '../../db/schema/payments.js';
import { referralPartners } from '../../db/schema/referrals.js';
import { insertPartner } from '../../db/referrals/partnerRepository.js';
import { referralPayoutAccountOwner } from '../referral-payouts/beneficiary.js';

const TAG = uuidv7().slice(-8);
let db: Database;
const trackedPartnerIds: string[] = [];
const trackedAccountIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  if (trackedAccountIds.length > 0) {
    await db.delete(providerAccounts).where(inArray(providerAccounts.id, trackedAccountIds));
  }
  if (trackedPartnerIds.length > 0) {
    await db.delete(referralPartners).where(inArray(referralPartners.id, trackedPartnerIds));
  }
  await closePostgres();
}, 120_000);

async function makePartner(label: string): Promise<{ id: string; ownerId: string }> {
  const ownerId = `owner-rpf-${label}-${TAG}`;
  const { row } = await insertPartner(getDb(), {
    ownerType: 'user',
    ownerId,
    displayName: `Partner ${label}`,
    // `applied` rather than `approved`: `insertPartner` only mints the three
    // pre-decision states (#146 owns the transition), and the state is
    // irrelevant here — the finding rests on the two UNIQUES, which do not read
    // it. A count over approved partners is what a producer would filter on,
    // and there is nothing for it to count either way.
    state: 'applied',
    at: new Date(),
    promotionMethods: ['website'],
  });
  trackedPartnerIds.push(row.id);
  return { id: row.id, ownerId };
}

/** Assert a REJECTION whose constraint matches, reading `cause`. */
async function expectPgRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  // Drizzle wraps the driver error, so the outer message is `Failed query: …`
  // and the constraint name lives on `cause`. Matching the outer message alone
  // passes for ANY failed statement, including a typo'd column.
  expect(failure, 'the statement was expected to be REFUSED and was not').toBeDefined();
  const cause = (failure as { cause?: { constraint_name?: string } }).cause;
  expect(cause?.constraint_name ?? '').toMatch(pattern);
}

describe('a shared payout beneficiary is UNREPRESENTABLE, so the signal has no producer', () => {
  it('hop 3: one Stripe account cannot be named by two `provider_accounts` rows', async () => {
    // The measured refusal that ended the producer. Two owners, one connected
    // account — the fraud shape the signal describes — is refused by the
    // database, so a count over `provider_account_id` is a count that is always
    // zero.
    const first = await makePartner('acct-a');
    const second = await makePartner('acct-b');
    const shared = `acct_shared_${TAG}`;

    const firstId = uuidv7();
    trackedAccountIds.push(firstId);
    await getDb().insert(providerAccounts).values({
      id: firstId,
      provider: 'stripe',
      ownerType: 'user',
      ownerId: first.ownerId,
      providerAccountId: shared,
      country: 'ES',
      onboardingState: 'ready',
    });

    await expectPgRejection(
      getDb().insert(providerAccounts).values({
        id: uuidv7(),
        provider: 'stripe',
        ownerType: 'user',
        ownerId: second.ownerId,
        providerAccountId: shared,
        country: 'ES',
        onboardingState: 'ready',
      }),
      /provider_accounts_provider_account_id_key/,
    );
  });

  it('hop 1: one owner pair is one partner, and the repository CONVERGES', async () => {
    // Not a refusal: `insertPartner` is `onConflictDoNothing` on exactly
    // `(owner_type, owner_id)` followed by a read-back, so a second enrolment
    // for one owner hands back the FIRST partner rather than raising. That is
    // the stronger evidence — the production path itself treats one owner pair
    // as one partner, so "two partners sharing an owner" is not a state a
    // caller can reach even by trying.
    const partner = await makePartner('dup');
    const again = await insertPartner(getDb(), {
      ownerType: 'user',
      ownerId: partner.ownerId,
      displayName: 'Rival',
      state: 'applied',
      at: new Date(),
      promotionMethods: ['website'],
    });

    expect(again.created).toBe(false);
    expect(again.row.id).toBe(partner.id);
    // And the name the second caller supplied did NOT overwrite the first,
    // which is what makes this a convergence rather than a quiet update.
    expect(again.row.displayName).toBe('Partner dup');
  });

  it('hop 2: the owner translation is the IDENTITY and consults nothing', () => {
    // A pure assertion rather than a database one, because this is the hop
    // #146's deferred beneficiary change would break — and when it does, the
    // whole finding expires and the producer becomes worth writing.
    const owner = referralPayoutAccountOwner({ ownerType: 'user', ownerId: `o-${TAG}` });
    expect(owner).toEqual({ ownerType: 'user', ownerId: `o-${TAG}` });
  });

  it('both indexes EXIST, which is what makes the three assertions above non-vacuous', async () => {
    // A refusal test passes just as happily when the statement fails for an
    // unrelated reason, and a `toMatch` over a missing constraint name would
    // report the empty string. Reading `pg_indexes` is the positive control:
    // it names what must be present for the finding to hold, so dropping either
    // turns THIS red rather than silently making the refusals untestable.
    const rows = await db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
      where indexname in ('provider_accounts_provider_account_id_key', 'referral_partners_owner_key')
    `);
    const found = [...rows].map((r) => r.indexname).sort();
    expect(found).toEqual(['provider_accounts_provider_account_id_key', 'referral_partners_owner_key']);
  });
});
