/**
 * The INBOUND half, end to end: a decision arrives and something really happens.
 *
 * ## Why this file exists
 *
 * `enforcement-plan.test.ts` tests the pure plan — decision in, actions out —
 * and it is thorough. But `planEnforcement` is the easy half. Everything that can
 * actually lose or duplicate moderation work lives in the EXECUTOR:
 * the claim-before-acting, the mode gate, the reversal that reads what was
 * displaced. None of it had a test, in either direction.
 *
 * That is the same shape as the webhook tests before the acceptance sibling: the
 * plan was proven, the effect was not.
 *
 * ## It now spans BOTH databases, and that is the migration, not the fixture
 *
 * The moderation ledger — `AbuseReport`, `ModerationEnforcement` — is still
 * Mongo, and the unique `decisionId+revision+action` index that makes enforcement
 * idempotent only exists on a real server. The LISTING it acts on is not: the
 * catalogue is Postgres, and `enforcement.service` restricts and restores through
 * `findListingById` / `updateListingColumns` / `setListingStatusIfIn`. So the
 * subject is seeded with `insertListing` against the throwaway Postgres database
 * the suite migrates, and read back the same way.
 *
 * That is also why the first test below is stronger than it was: `insertListing`
 * generates a **uuid v7**, which `mongoose.isValidObjectId` REJECTS. Under the
 * pre-port guard, enforcement against every listing created after the cutover
 * would have refused with a tidy "not a valid id" and changed nothing. It passes
 * here because the service swapped that check for `isLiveEntityId`, which accepts
 * both id shapes — and the malformed-id test below proves the guard still exists.
 *
 * ## The fixture is built from the schema's errors, not from what it looks like
 *
 * `applyDecisionEvent` runs `DecisionSchema.safeParse` and throws a
 * non-retryable `UnusableDecisionEventError` when it fails. So a fixture that
 * merely LOOKS like a decision sends every test in this file down the
 * parse-failure branch while the assertions still pass for the wrong reason —
 * which is exactly what happened to the first webhook fixture (missing
 * `confidence`, `jury`, `publishedAt` and two `policyVersions` fields, returning
 * `200 { handled: false }` and enforcing nothing).
 *
 * `parses against the contract` below is therefore the FIRST test: a floor that
 * fails loudly if the fixture drifts, so nothing after it can pass vacuously.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { inArray } from 'drizzle-orm';
import { isLiveEntityId } from '@oxyhq/db';
import { DecisionSchema } from '@oxyhq/crowdsource-contracts';
import { ALL_LISTING_STATUSES, type ListingStatus } from '@mercaria/shared-types';
import type { Database } from '../../db/postgres.js';
import { listings } from '../../db/schema/catalog.js';

const uri = process.env.MERCARIA_TEST_MONGODB_URI;

// `automatic`, because every assertion here is about an EFFECT and `observe`
// would make them all vacuous. Config freezes at module load, so the production
// default is verified in its own file (`moderation-observe.realdb.test.ts`)
// rather than by toggling an env var this process has already read.
process.env.CROWDSOURCE_ENFORCEMENT_MODE = 'automatic';

/**
 * Everything reaching `config` is imported DYNAMICALLY, after the line above.
 *
 * ESM evaluates every static import before any of this module's own statements,
 * so a plain `import … from '../../db/postgres.js'` — which pulls `config` —
 * would freeze the enforcement mode at its production default of `observe`
 * BEFORE the assignment ran. Every effect assertion in this file would then be
 * asserting against a mode that deliberately changes nothing, and the failure
 * reads as "enforcement is broken" rather than "the import order is wrong".
 * The schema table is safe to import statically: `src/db/schema/*` reads no
 * config.
 */
let pg: Database;
let connectPostgres: typeof import('../../db/postgres.js').connectPostgres;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let insertListing: typeof import('../../db/catalog/listingRepository.js').insertListing;
let findListingById: typeof import('../../db/catalog/listingRepository.js').findListingById;

/**
 * Postgres listing ids this file seeded, dropped between tests.
 *
 * The Postgres database is shared with every other realdb file in the suite, so
 * this file cleans up after ITSELF rather than truncating the table. The seeded
 * listings are user-owned, so they hold no `store_id` and nothing else has to be
 * torn down in order.
 */
const seededListingIds: string[] = [];

let AbuseReport: typeof import('../../models/abuse-report.js').AbuseReport;
let ModerationEnforcement: typeof import('../../models/moderation-enforcement.js').ModerationEnforcement;
let applyDecisionEvent: typeof import('../moderation/decision.worker.js').applyDecisionEvent;

beforeAll(async () => {
  if (!uri) throw new Error('MERCARIA_TEST_MONGODB_URI missing — is vitest.globalSetup.ts wired?');
  await mongoose.connect(uri, { dbName: 'mercaria-decision-test' });

  ({ AbuseReport } = await import('../../models/abuse-report.js'));
  ({ ModerationEnforcement } = await import('../../models/moderation-enforcement.js'));
  ({ applyDecisionEvent } = await import('../moderation/decision.worker.js'));
  ({ connectPostgres, closePostgres } = await import('../../db/postgres.js'));
  ({ insertListing, findListingById } = await import('../../db/catalog/listingRepository.js'));

  await ModerationEnforcement.syncIndexes();

  pg = await connectPostgres();
}, 120_000);

afterAll(async () => {
  // The last test's rows have no `beforeEach` after them to take them out, and
  // the Postgres database outlives this file.
  await dropSeededListings();
  await mongoose.disconnect();
  await closePostgres();
});

beforeEach(async () => {
  await dropSeededListings();
  await Promise.all([AbuseReport.deleteMany({}), ModerationEnforcement.deleteMany({})]);
});

/** Remove every listing this file has seeded so far. */
async function dropSeededListings(): Promise<void> {
  const ids = seededListingIds.splice(0);
  if (ids.length === 0) return;
  await pg.delete(listings).where(inArray(listings.id, ids));
}

/** Every field `DecisionSchema` requires — see the module comment. */
function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: 'dec_real_1',
    caseId: 'case_real_1',
    revision: 1,
    status: 'final',
    outcome: 'violation',
    contextSufficiency: 'sufficient',
    /**
     * A `violation` REQUIRES at least one finding — a cross-field invariant, not
     * a missing-field one, so it is invisible to "does this look like a
     * decision?". `enforcement-plan.ts` even documents that the contract refuses
     * it, and the first version of this fixture did it anyway.
     */
    findings: [
      {
        code: 'commerce.counterfeit',
        severity: 'high',
        scope: 'application_local',
        resourceIds: ['res_subject'],
      },
    ],
    recommendedActions: [{ action: 'remove' }],
    confidence: 0.9,
    jury: {
      size: 5,
      decisiveVotes: 5,
      winningVotes: 4,
      agreement: 0.8,
      specialistPresent: false,
    },
    policyVersions: { taxonomy: '2026.1', application: 'mercaria.1', oxyConduct: 'oxy.1' },
    publishedAt: now,
    ...overrides,
  };
}

function decidedEvent(payload: Record<string, unknown>): {
  _id: string;
  kind: 'decision.apply';
  payload: { event: Record<string, unknown> };
  attempts: number;
  availableAt: Date;
  expiresAt: Date;
  createdAt: Date;
} {
  return {
    _id: `moderation:decision.apply:${String(payload.id)}`,
    kind: 'decision.apply',
    payload: {
      event: {
        id: `evt_${String(payload.id)}`,
        type: 'case.decided',
        createdAt: new Date().toISOString(),
        organizationId: 'org_test',
        applicationId: 'app_test',
        data: { caseId: payload.caseId, decision: payload },
      },
    },
    attempts: 1,
    availableAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
  };
}

/**
 * One user-owned listing in Postgres, at `status`, registered for teardown.
 *
 * Every nullable column is written explicitly rather than left off: `NewListing`
 * is the row minus its generated columns, so an omission is a compile error here
 * and a silently different fixture nowhere.
 */
async function seedListing(status: ListingStatus): Promise<string> {
  const row = await insertListing(
    {
      ownerType: 'user',
      oxyUserId: 'seller-1',
      storeId: null,
      title: 'A reported item',
      description: 'Body text',
      condition: 'new',
      status,
      categoryId: null,
      categorySlugs: [],
      tags: [],
      priceRangeMinAmount: 1000,
      priceRangeMinCurrency: 'FAIR',
      priceRangeMaxAmount: 1000,
      priceRangeMaxCurrency: 'FAIR',
      hasInventory: true,
      variantCount: 1,
      longitude: null,
      latitude: null,
      vendor: null,
      productType: null,
      handle: null,
      seoTitle: null,
      seoDescription: null,
      sourceConnectionId: null,
      sourceProvider: null,
      sourceExternalId: null,
      sourceExternalUpdatedAt: null,
      overriddenFields: [],
      rating: 0,
      reviewCount: 0,
      favoriteCount: 0,
      publishedAt: new Date(),
    },
    [],
    [],
  );
  seededListingIds.push(row.id);
  return row.id;
}

/** The listing's current status, read back from Postgres. */
async function statusOf(listingId: string): Promise<string | undefined> {
  return (await findListingById(listingId))?.status;
}

async function seedReport(listingId: string, caseId: string): Promise<void> {
  await AbuseReport.create({
    reportedType: 'listing',
    reportedId: listingId,
    reporterOxyUserId: 'reporter-1',
    categories: ['counterfeit'],
    localStatus: 'delivered',
    crowdSourceCaseId: caseId,
  });
}

describe('the fixture itself', () => {
  it('parses against the contract (vacuity floor for every test below)', () => {
    /**
     * Deliberately first. If this fails, every other test in this file is
     * exercising the parse-failure branch and proving nothing about enforcement
     * — and their assertions would not necessarily say so.
     */
    const parsed = DecisionSchema.safeParse(decision());
    expect(parsed.success).toBe(true);
  });
});

describe('a violation is enforced end to end', () => {
  it('restricts the reported listing and records an applied row', async () => {
    const listingId = await seedListing('active');
    await seedReport(listingId, 'case_real_1');

    // The second half of this file's vacuity floor: the subject really is a
    // post-cutover id, so the run below exercises the shape `isValidObjectId`
    // would have thrown out.
    expect(isLiveEntityId(listingId)).toBe(true);
    expect(mongoose.isValidObjectId(listingId)).toBe(false);

    await applyDecisionEvent(decidedEvent(decision()));

    expect(await statusOf(listingId)).toBe('restricted');

    const row = await ModerationEnforcement.findOne({ decisionId: 'dec_real_1' }).lean();
    expect(row?.applied).toBe(true);
    expect(row?.action).toBe('restrict');
    // What it displaced, so the reversal has something true to put back.
    expect(row?.previousState?.listingStatus).toBe('active');

    // Every report about the object learns the outcome, not just the first.
    const report = await AbuseReport.findOne({ reportedId: listingId }).lean();
    expect(report?.localStatus).toBe('decided');
  });

  it('is idempotent — a redelivery enforces exactly once', async () => {
    const listingId = await seedListing('active');
    await seedReport(listingId, 'case_real_1');

    await applyDecisionEvent(decidedEvent(decision()));
    await applyDecisionEvent(decidedEvent(decision()));

    /**
     * The unique index on `decisionId+revision+action` is what makes this hold,
     * and it only exists on a real server — which is why this test lives here
     * rather than beside the mocked ones.
     */
    expect(
      await ModerationEnforcement.countDocuments({ decisionId: 'dec_real_1' }),
    ).toBe(1);
  });

  it('records — and changes nothing — when the reported id is malformed', async () => {
    /**
     * The guard `restrictListing` opens with, kept honest.
     *
     * It used to be `mongoose.isValidObjectId`, and after the cutover that
     * predicate answers "invalid" for every listing the catalogue creates — so
     * the branch would have swallowed real enforcement while looking like a
     * careful input check. `isLiveEntityId` accepts both live id shapes, which
     * means a fixture exercising this branch has to be something NEITHER shape
     * admits: not 24 hex characters, not a uuid v7.
     */
    const malformed = 'listing-42';
    expect(isLiveEntityId(malformed)).toBe(false);
    await seedReport(malformed, 'case_real_1');

    await applyDecisionEvent(decidedEvent(decision()));

    const row = await ModerationEnforcement.findOne({ decisionId: 'dec_real_1' }).lean();
    // Claimed and recorded, never applied — the audit trail says we looked.
    expect(row?.applied).toBe(false);
    expect(row?.reason).toMatch(/not a valid id/i);
  });
});

describe('a correction restores what was actually displaced', () => {
  it('returns a DRAFT listing to draft, not to active', async () => {
    /**
     * The failure this pins is the one the plan file argues hardest about, and it
     * had no end-to-end test until now: a correction arrives as `no_violation`
     * with `no_action` — "take no NEW action", not "leave the delisting in place"
     * — and the restore must return the listing to the status it really had.
     *
     * Restoring to a hardcoded `active` would PUBLISH an item its seller had
     * never listed. Restoring to nothing at all leaves an accepted appeal with
     * the listing still down, the case saying it was fine, and no error anywhere.
     */
    const listingId = await seedListing('draft');
    await seedReport(listingId, 'case_real_1');

    await applyDecisionEvent(decidedEvent(decision()));
    expect(await statusOf(listingId)).toBe('restricted');

    await applyDecisionEvent(
      decidedEvent(
        decision({
          id: 'dec_real_2',
          revision: 2,
          status: 'corrected',
          outcome: 'no_violation',
          findings: [],
          recommendedActions: [{ action: 'no_action' }],
          // A revision after the first must name what it supersedes — another
          // cross-field invariant the fixture only learned from the parser.
          supersedesDecisionId: 'dec_real_1',
        }),
      ),
    );

    expect(await statusOf(listingId)).toBe('draft');
  });
});

describe('a restore reads only rows whose effect really happened', () => {
  it('picks the APPLIED row, not a more recent recorded-only one', async () => {
    /**
     * `restoreSubject` filters on `applied: true`. This pins WHY, and it took two
     * attempts to write a test that can actually tell.
     *
     * The obvious version — record an unapplied restrict in observe mode, send a
     * correction, assert nothing moved — passes with the filter AND without it,
     * because the update is separately guarded by `setListingStatusIfIn(…,
     * ['restricted','draft'])` and an untouched listing is `active`. It looked
     * like a guard and proved nothing.
     *
     * What discriminates is two rows disagreeing about what was displaced. The
     * older APPLIED row says the listing was a `draft`; a newer recorded-only row
     * (an observe-mode plan, or an action that found nothing to do) says `active`.
     * With the filter the correction restores `draft` — the truth. Without it the
     * newest row wins and the correction PUBLISHES an item its seller had never
     * listed, which is the same class of harm as restoring to a constant.
     *
     * This is realistic rather than contrived: it is any deployment that enforced
     * something, later ran in a different mode, and then had the case corrected.
     */
    const listingId = await seedListing('restricted');

    // The row that really did the work — the listing was a draft when restricted.
    await ModerationEnforcement.create({
      decisionId: 'dec_applied',
      revision: 1,
      action: 'restrict',
      caseId: 'case_real_1',
      subjectType: 'listing',
      subjectId: listingId,
      applied: true,
      reason: 'carried out',
      previousState: { listingStatus: 'draft' },
    });

    // A LATER row that was recorded but never carried out, disagreeing about the
    // prior status. Written second so it wins any unfiltered `createdAt` sort.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ModerationEnforcement.create({
      decisionId: 'dec_recorded_only',
      revision: 1,
      action: 'restrict',
      caseId: 'case_real_1',
      subjectType: 'listing',
      subjectId: listingId,
      applied: false,
      reason: 'not applied: enforcement mode is observe',
      previousState: { listingStatus: 'active' },
    });

    await seedReport(listingId, 'case_real_1');
    await applyDecisionEvent(
      decidedEvent(
        decision({
          id: 'dec_correction',
          revision: 2,
          status: 'corrected',
          outcome: 'no_violation',
          findings: [],
          recommendedActions: [{ action: 'no_action' }],
          supersedesDecisionId: 'dec_applied',
        }),
      ),
    );

    expect(await statusOf(listingId)).toBe('draft');
  });
});

describe('the database accepts every status the TYPE admits', () => {
  it.each(ALL_LISTING_STATUSES)('a listing can really be saved as %s', async (status) => {
    /**
     * The drift this catches shipped once already, and the port changed WHERE it
     * would hide rather than removing it.
     *
     * Under Mongo the model declared its own `const STATUSES: readonly
     * ListingStatus[] = [...]`, and a hand-written SUBSET satisfies that type — so
     * adding `restricted` to the union produced no compile error and the schema
     * enum never learned it. It then hid a second time behind the difference
     * between two Mongo APIs: enforcement used `updateOne`, which does not run
     * validators, so restricting a listing worked and every moderation test
     * passed, while a seller editing the TITLE of a restricted listing hit a
     * validation error about a status they never touched.
     *
     * In Postgres the enum is `listings_status_check`, and it applies to EVERY
     * writer including `updateListingColumns` — so the second hiding place is
     * gone. The first is not: the CHECK the throwaway database actually carries
     * comes from a FROZEN migration file (`drizzle/0000_*.sql` spells the five
     * statuses out literally), not from `ALL_LISTING_STATUSES` at run time. A
     * status added to the union without a generated migration therefore fails
     * here — a `23514` on the INSERT — and nowhere else until production.
     *
     * Iterating the type's own runtime list means a status added later is covered
     * without anyone remembering to come back here.
     */
    const listingId = await seedListing(status);
    expect(await statusOf(listingId)).toBe(status);
  });
});
