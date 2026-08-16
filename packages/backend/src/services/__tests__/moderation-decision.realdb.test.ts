/**
 * The INBOUND half, end to end: a decision arrives and something really happens.
 *
 * ## Why this file exists
 *
 * `enforcement-plan.test.ts` tests the pure plan — decision in, actions out — and
 * it is thorough. But `planEnforcement` is the easy half. Everything that can
 * actually lose or duplicate moderation work lives in the EXECUTOR: the
 * claim-before-acting, the mode gate, the reversal that reads what was displaced.
 * None of it had a test, in either direction.
 *
 * ## It is now ENTIRELY Postgres, and the unique index is why it stays a realdb file
 *
 * The moderation ledger and the catalogue both live in Postgres now, so this runs
 * against the one throwaway database the suite migrates. It stays a `realdb` file
 * for the same reason it always was one:
 * `moderation_enforcements_decision_revision_action_key` is what makes enforcement
 * exactly-once, and a unique index only exists on a real server. A mocked claim
 * accepts every duplicate and every test below would pass against a double
 * takedown.
 *
 * `insertListing` generates a **uuid v7**, which `mongoose.isValidObjectId`
 * REJECTS. Under the pre-port guard, enforcement against every listing created
 * after the cutover would have refused with a tidy "not a valid id" and changed
 * nothing. It passes here because the service uses `isLiveEntityId`, which accepts
 * both id shapes — and the malformed-id test below proves the guard still exists.
 *
 * ## The fixture is built from the schema's errors, not from what it looks like
 *
 * `applyDecisionEvent` runs `DecisionSchema.safeParse` and throws a non-retryable
 * `UnusableDecisionEventError` when it fails. So a fixture that merely LOOKS like
 * a decision sends every test in this file down the parse-failure branch while the
 * assertions still pass for the wrong reason — which is exactly what happened to
 * the first webhook fixture (missing `confidence`, `jury`, `publishedAt` and two
 * `policyVersions` fields, returning `200 { handled: false }` and enforcing
 * nothing).
 *
 * `parses against the contract` below is therefore the FIRST test: a floor that
 * fails loudly if the fixture drifts, so nothing after it can pass vacuously.
 *
 * ## Every id carries a per-run suffix
 *
 * One Postgres database serves the whole suite and vitest runs files in parallel
 * workers. A fixed `dec_real_1` would collide with the sibling observe file on the
 * enforcement unique index, and a blanket `delete from moderation_enforcements`
 * would empty another file's rows mid-run.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { isLiveEntityId, uuidv7 } from '@oxyhq/db';
import { DecisionSchema } from '@oxyhq/crowdsource-contracts';
import { ALL_LISTING_STATUSES, type ListingStatus } from '@mercaria/shared-types';
import type { Database } from '../../db/postgres.js';
import { listings } from '../../db/schema/catalog.js';
import { abuseReports, moderationEnforcements } from '../../db/schema/moderation.js';
import type { ModerationOutboxEvent } from '../../db/moderation/moderationOutboxRepository.js';

// `automatic`, because every assertion here is about an EFFECT and `observe` would
// make them all vacuous. Config freezes at module load, so the production default
// is verified in its own file (`moderation-observe.realdb.test.ts`) rather than by
// toggling an env var this process has already read.
process.env.CROWDSOURCE_ENFORCEMENT_MODE = 'automatic';

/**
 * Everything reaching `config` is imported DYNAMICALLY, after the line above.
 *
 * ESM evaluates every static import before any of this module's own statements, so
 * a plain `import … from '../../db/postgres.js'` — which pulls `config` — would
 * freeze the enforcement mode at its production default of `observe` BEFORE the
 * assignment ran. Every effect assertion in this file would then be asserting
 * against a mode that deliberately changes nothing, and the failure reads as
 * "enforcement is broken" rather than "the import order is wrong". The schema
 * tables are safe to import statically: `src/db/schema/*` reads no config.
 */
let pg: Database;
let connectPostgres: typeof import('../../db/postgres.js').connectPostgres;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let insertListing: typeof import('../../db/catalog/listingRepository.js').insertListing;
let findListingById: typeof import('../../db/catalog/listingRepository.js').findListingById;
let setListingStatusIfIn: typeof import('../../db/catalog/listingRepository.js').setListingStatusIfIn;
let archiveListing: typeof import('../catalog-write.service.js').archiveListing;
let updateListing: typeof import('../catalog-write.service.js').updateListing;
let insertAbuseReport: typeof import('../../db/moderation/abuseReportRepository.js').insertAbuseReport;
let markAbuseReportDelivered: typeof import('../../db/moderation/abuseReportRepository.js').markAbuseReportDelivered;
let findAbuseReportById: typeof import('../../db/moderation/abuseReportRepository.js').findAbuseReportById;
let claimModerationEnforcement: typeof import('../../db/moderation/moderationEnforcementRepository.js').claimModerationEnforcement;
let markModerationEnforcementApplied: typeof import('../../db/moderation/moderationEnforcementRepository.js').markModerationEnforcementApplied;
let applyDecisionEvent: typeof import('../moderation/decision.worker.js').applyDecisionEvent;

/** Unique to this run — see the module header. */
const RUN = uuidv7();

const seededListingIds: string[] = [];
const seededReportIds: string[] = [];
const seededDecisionIds: string[] = [];

beforeAll(async () => {
  ({ connectPostgres, closePostgres } = await import('../../db/postgres.js'));
  ({ insertListing, findListingById, setListingStatusIfIn } = await import(
    '../../db/catalog/listingRepository.js'
  ));
  ({ archiveListing, updateListing } = await import('../catalog-write.service.js'));
  ({ insertAbuseReport, markAbuseReportDelivered, findAbuseReportById } = await import(
    '../../db/moderation/abuseReportRepository.js'
  ));
  ({ claimModerationEnforcement, markModerationEnforcementApplied } = await import(
    '../../db/moderation/moderationEnforcementRepository.js'
  ));
  ({ applyDecisionEvent } = await import('../moderation/decision.worker.js'));

  pg = await connectPostgres();
}, 120_000);

afterAll(async () => {
  // The last test's rows have no `beforeEach` after them to take them out, and
  // the Postgres database outlives this file.
  await dropSeeded();
  await closePostgres();
});

beforeEach(async () => {
  await dropSeeded();
});

/** Remove everything this file has seeded so far — and nothing else. */
async function dropSeeded(): Promise<void> {
  const listingIds = seededListingIds.splice(0);
  const reportIds = seededReportIds.splice(0);
  const decisionIds = seededDecisionIds.splice(0);
  if (reportIds.length > 0) {
    await pg.delete(abuseReports).where(inArray(abuseReports.id, reportIds));
  }
  if (decisionIds.length > 0) {
    await pg
      .delete(moderationEnforcements)
      .where(inArray(moderationEnforcements.decisionId, decisionIds));
  }
  if (listingIds.length > 0) {
    await pg.delete(listings).where(inArray(listings.id, listingIds));
  }
}

/** A decision id scoped to this run, registered for teardown. */
function scopedDecisionId(name: string): string {
  const id = `${name}-${RUN}`;
  seededDecisionIds.push(id);
  return id;
}

const CASE_ID = `case-${RUN}`;

/** Every field `DecisionSchema` requires — see the module comment. */
function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: scopedDecisionId('dec-real-1'),
    caseId: CASE_ID,
    revision: 1,
    status: 'final',
    outcome: 'violation',
    contextSufficiency: 'sufficient',
    /**
     * A `violation` REQUIRES at least one finding — a cross-field invariant, not a
     * missing-field one, so it is invisible to "does this look like a decision?".
     * `enforcement-plan.ts` even documents that the contract refuses it, and the
     * first version of this fixture did it anyway.
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

function decidedEvent(payload: Record<string, unknown>): ModerationOutboxEvent {
  return {
    id: `moderation:decision.apply:${String(payload.id)}`,
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
      oxyUserId: `seller-${RUN}`,
      storeId: null,
      title: 'A reported item',
      description: 'Body text',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      conditionSourceLabel: null,
      conditionAcknowledgedAt: null,
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

/**
 * A DELIVERED report about `listingId`, carrying the case id.
 *
 * Written through the repository rather than by raw insert, so the seed exercises
 * the same delivery bookkeeping the worker performs — a case id that only a test
 * knows how to set would not prove the join works in production.
 */
async function seedReport(listingId: string, caseId: string): Promise<string> {
  const report = await insertAbuseReport({
    reportedType: 'listing',
    reportedId: listingId,
    reporterOxyUserId: `reporter-${uuidv7()}`,
    categories: ['counterfeit'],
    localStatus: 'queued',
  });
  seededReportIds.push(report.id);
  await markAbuseReportDelivered(report.id, {
    crowdSourceReportId: `csr-${uuidv7()}`,
    crowdSourceCaseId: caseId,
    snapshotHash: 'a'.repeat(64),
    deliveredAt: new Date(),
  });
  return report.id;
}

/** The enforcement rows written for one decision id. */
async function enforcementsFor(id: string) {
  return pg
    .select()
    .from(moderationEnforcements)
    .where(eq(moderationEnforcements.decisionId, id));
}

describe('the fixture itself', () => {
  it('parses against the contract (vacuity floor for every test below)', () => {
    /**
     * Deliberately first. If this fails, every other test in this file is
     * exercising the parse-failure branch and proving nothing about enforcement —
     * and their assertions would not necessarily say so.
     */
    const parsed = DecisionSchema.safeParse(decision());
    expect(parsed.success).toBe(true);
  });
});

describe('a violation is enforced end to end', () => {
  it('restricts the reported listing and records an applied row', async () => {
    const listingId = await seedListing('active');
    await seedReport(listingId, CASE_ID);

    // The second half of this file's vacuity floor: the subject really is a
    // post-cutover id, so the run below exercises the shape an ObjectId check
    // would have thrown out.
    expect(isLiveEntityId(listingId)).toBe(true);
    expect(/^[0-9a-f]{24}$/.test(listingId)).toBe(false);

    const fixture = decision();
    await applyDecisionEvent(decidedEvent(fixture));

    expect(await statusOf(listingId)).toBe('restricted');

    const [row] = await enforcementsFor(String(fixture.id));
    expect(row?.applied).toBe(true);
    expect(row?.action).toBe('restrict');
    // What it displaced, so the reversal has something true to put back.
    expect(row?.previousStateListingStatus).toBe('active');

    // Every report about the object learns the outcome, not just the first.
    const reportId = seededReportIds[seededReportIds.length - 1];
    expect((await findAbuseReportById(reportId))?.localStatus).toBe('decided');
  });

  it('is idempotent — a redelivery enforces exactly once', async () => {
    const listingId = await seedListing('active');
    await seedReport(listingId, CASE_ID);

    const fixture = decision();
    await applyDecisionEvent(decidedEvent(fixture));
    await applyDecisionEvent(decidedEvent(fixture));

    /**
     * `moderation_enforcements_decision_revision_action_key` is what makes this
     * hold, and it only exists on a real server — which is why this test lives
     * here rather than beside the mocked ones.
     */
    expect(await enforcementsFor(String(fixture.id))).toHaveLength(1);
  });

  it('records — and changes nothing — when the reported id is malformed', async () => {
    /**
     * The guard `restrictListing` opens with, kept honest.
     *
     * It used to be `mongoose.isValidObjectId`, and after the cutover that
     * predicate answers "invalid" for every listing the catalogue creates — so the
     * branch would have swallowed real enforcement while looking like a careful
     * input check. `isLiveEntityId` accepts both live id shapes, which means a
     * fixture exercising this branch has to be something NEITHER shape admits: not
     * 24 hex characters, not a uuid v7.
     */
    const malformed = 'listing-42';
    expect(isLiveEntityId(malformed)).toBe(false);
    await seedReport(malformed, CASE_ID);

    const fixture = decision();
    await applyDecisionEvent(decidedEvent(fixture));

    const [row] = await enforcementsFor(String(fixture.id));
    // Claimed and recorded, never applied — the audit trail says we looked.
    expect(row?.applied).toBe(false);
    expect(row?.reason).toMatch(/not a valid id/i);
  });
});

describe('a correction restores what was actually displaced', () => {
  it('returns a DRAFT listing to draft, not to active', async () => {
    /**
     * The failure this pins is the one the plan file argues hardest about: a
     * correction arrives as `no_violation` with `no_action` — "take no NEW
     * action", not "leave the delisting in place" — and the restore must return
     * the listing to the status it really had.
     *
     * Restoring to a hardcoded `active` would PUBLISH an item its seller had never
     * listed. Restoring to nothing at all leaves an accepted appeal with the
     * listing still down, the case saying it was fine, and no error anywhere.
     */
    const listingId = await seedListing('draft');
    await seedReport(listingId, CASE_ID);

    await applyDecisionEvent(decidedEvent(decision()));
    expect(await statusOf(listingId)).toBe('restricted');

    await applyDecisionEvent(
      decidedEvent(
        decision({
          id: scopedDecisionId('dec-real-2'),
          revision: 2,
          status: 'corrected',
          outcome: 'no_violation',
          findings: [],
          recommendedActions: [{ action: 'no_action' }],
          // A revision after the first must name what it supersedes — another
          // cross-field invariant the fixture only learned from the parser.
          supersedesDecisionId: 'dec-real-1',
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
     * ['restricted','draft'])` and an untouched listing is `active`. It looked like
     * a guard and proved nothing.
     *
     * What discriminates is two rows disagreeing about what was displaced. The
     * older APPLIED row says the listing was a `draft`; a newer recorded-only row
     * (an observe-mode plan, or an action that found nothing to do) says `active`.
     * With the filter the correction restores `draft` — the truth. Without it the
     * newest row wins and the correction PUBLISHES an item its seller had never
     * listed, which is the same class of harm as restoring to a constant.
     */
    const listingId = await seedListing('restricted');

    // The row that really did the work — the listing was a draft when restricted.
    const applied = await claimModerationEnforcement({
      decisionId: scopedDecisionId('dec-applied'),
      revision: 1,
      action: 'restrict',
      caseId: CASE_ID,
      subjectType: 'listing',
      subjectId: listingId,
      reason: 'carried out',
    });
    if (applied === null) throw new Error('seed claim was refused');
    await markModerationEnforcementApplied(applied.id, { listingStatus: 'draft' });

    // A LATER row that was recorded but never carried out, disagreeing about the
    // prior status. Written second so it wins any unfiltered `created_at` sort.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const recordedOnly = await claimModerationEnforcement({
      decisionId: scopedDecisionId('dec-recorded-only'),
      revision: 1,
      action: 'restrict',
      caseId: CASE_ID,
      subjectType: 'listing',
      subjectId: listingId,
      reason: 'not applied: enforcement mode is observe',
    });
    if (recordedOnly === null) throw new Error('seed claim was refused');
    // `applied` stays false, and the previous state it CLAIMS disagrees — which is
    // exactly what makes the filter observable.
    await pg
      .update(moderationEnforcements)
      .set({ previousStateListingStatus: 'active' })
      .where(eq(moderationEnforcements.id, recordedOnly.id));

    await seedReport(listingId, CASE_ID);
    await applyDecisionEvent(
      decidedEvent(
        decision({
          id: scopedDecisionId('dec-correction'),
          revision: 2,
          status: 'corrected',
          outcome: 'no_violation',
          findings: [],
          recommendedActions: [{ action: 'no_action' }],
          supersedesDecisionId: 'dec-applied',
        }),
      ),
    );

    expect(await statusOf(listingId)).toBe('draft');
  });
});

/**
 * #402 — archiving was a one-way door against a restriction, in both directions.
 *
 * Every case here drives the REAL decision pipeline to impose the restriction and
 * the REAL production archive path, because the defect is entirely in how those
 * two meet. A test that restricts and then restores directly passes identically
 * against the unfixed code and measures nothing.
 */
describe('a restriction survives archiving, and an appeal can still reach it', () => {
  /** Restrict `listingId` through a real decision, and assert it took. */
  async function restrictViaDecision(listingId: string): Promise<void> {
    await seedReport(listingId, CASE_ID);
    await applyDecisionEvent(decidedEvent(decision()));
    expect(await statusOf(listingId), 'the fixture must really be restricted').toBe('restricted');
  }

  /** An accepted appeal for `supersedes`, applied. */
  async function acceptAppeal(supersedes: string): Promise<void> {
    await applyDecisionEvent(
      decidedEvent(
        decision({
          id: scopedDecisionId('dec-appeal'),
          revision: 2,
          status: 'corrected',
          outcome: 'no_violation',
          findings: [],
          recommendedActions: [{ action: 'no_action' }],
          supersedesDecisionId: supersedes,
        }),
      ),
    );
  }

  it('refuses the seller DELETE that used to bury it', async () => {
    /**
     * `DELETE /seller/listings/:id` reaches `archiveListing` through
     * `loadOwnedListing`, which checks ownership and NOT status — so the accused
     * seller's own delete was the shortest route to the dead end, needing no
     * connector, no platform and no webhook.
     *
     * Before #402 `archiveListing` wrote through `updateListingColumns`, an
     * unconditional `UPDATE … WHERE id = ?`, and this call SUCCEEDED.
     */
    const listingId = await seedListing('active');
    await restrictViaDecision(listingId);

    await expect(archiveListing(listingId)).rejects.toThrow(/restricted/i);
    expect(await statusOf(listingId)).toBe('restricted');
  });

  it('closes the archive-then-republish path that laundered the decision', async () => {
    /**
     * The half that is worse than the dead end, and the reason option 2 alone was
     * not enough.
     *
     * `updateListing`'s guard reads the listing's CURRENT status, so it only
     * refuses while the column still says `restricted`. Archiving cleared that,
     * and `SELLER_SETTABLE_LISTING_STATUSES` contains `active` — so before #402
     * the two calls below both succeeded and put a jury-restricted listing back on
     * sale.
     *
     * BOTH calls are attempted and the assertion is on the END STATE, not on the
     * first rejection. A test that stopped at the refusal would never observe the
     * laundering it exists to prevent: against the unfixed code both calls SUCCEED
     * and this ends `active`, which is the harm stated in the one place a reader
     * will look at when it goes red.
     */
    const listingId = await seedListing('active');
    await restrictViaDecision(listingId);

    const refusals: string[] = [];
    const record = (err: unknown): void => {
      refusals.push(err instanceof Error ? err.message : String(err));
    };

    await archiveListing(listingId).catch(record);
    await updateListing(
      listingId,
      { status: 'active' },
      { kind: 'seller', oxyUserId: `seller-${RUN}` },
    ).catch(record);

    expect(await statusOf(listingId), 'a jury-restricted listing was put back on sale').toBe(
      'restricted',
    );

    // …and each step was REFUSED rather than silently doing nothing. Without this
    // the case would also pass against a build that had quietly stopped archiving
    // for some unrelated reason.
    expect(refusals, 'both calls must be refused, not silently no-op’d').toHaveLength(2);
    for (const message of refusals) {
      expect(message).toMatch(/restricted/i);
    }
  });

  it('relists a listing archived while restricted, at the status it really had', async () => {
    /**
     * The repair, and the case that keeps the connector's deliberate carve-out
     * safe.
     *
     * `archiveSourcedListing`'s `product_delete` caller passes no
     * `sparePendingModeration` and still archives from ANY status, because a
     * product genuinely deleted upstream is gone whatever Mercaria decided (#387
     * left that path unchanged on purpose). The statement below is exactly the one
     * it issues; driving the webhook itself would need a store, a location, a
     * category, a connection and an installed provider to measure a property that
     * belongs to `restoreSubject`.
     *
     * It also repairs whatever the seller-DELETE escape already buried, which is
     * the only route back for those rows.
     *
     * The listing was `active` before the restriction, so it must come back
     * `active` — read off the enforcement row, never assumed.
     */
    const listingId = await seedListing('active');
    await restrictViaDecision(listingId);

    const archived = await setListingStatusIfIn(listingId, 'archived', ALL_LISTING_STATUSES);
    expect(archived, 'the connector path must really have archived it').toBe(true);

    await acceptAppeal('dec-real-1');

    expect(await statusOf(listingId)).toBe('active');
  });

  it('does NOT resurrect a listing the seller archived after request_changes', async () => {
    /**
     * The scoping, and the reason `archived` is added for `restrict` ALONE.
     *
     * `request_changes` leaves the listing a `draft`, which its seller fully
     * controls — so archiving from there is an ordinary delete of their own
     * listing, made with nothing stopping them. Republishing it on a correction
     * would put an item back on sale its seller had deleted, which is the same
     * harm as restoring to a hardcoded `active`.
     *
     * Widening `restorableFrom` to `archived` for every reversible action turns
     * this case red, which is what makes the narrowing observable rather than
     * merely stated.
     */
    const listingId = await seedListing('active');
    await seedReport(listingId, CASE_ID);
    await applyDecisionEvent(
      decidedEvent(
        decision({
          findings: [
            {
              // A REAL taxonomy code. The first version of this fixture invented
              // one and every assertion below it went down the parse-failure
              // branch — the exact vacuity this file's header warns about.
              code: 'commerce.misleading_listing',
              severity: 'medium',
              scope: 'application_local',
              resourceIds: ['res_subject'],
            },
          ],
          recommendedActions: [{ action: 'request_changes' }],
        }),
      ),
    );
    expect(await statusOf(listingId), 'the fixture must really be a draft').toBe('draft');

    // The seller deletes their own draft — permitted, and unchanged by #402.
    await archiveListing(listingId);
    expect(await statusOf(listingId)).toBe('archived');

    await acceptAppeal('dec-real-1');

    expect(await statusOf(listingId)).toBe('archived');
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
     * writer — so the second hiding place is gone. The first is not: the CHECK the
     * throwaway database actually carries comes from a FROZEN migration file, not
     * from `ALL_LISTING_STATUSES` at run time. A status added to the union without
     * a generated migration therefore fails here — a `23514` on the INSERT — and
     * nowhere else until production.
     *
     * Iterating the type's own runtime list means a status added later is covered
     * without anyone remembering to come back here.
     */
    const listingId = await seedListing(status);
    expect(await statusOf(listingId)).toBe(status);
  });
});
