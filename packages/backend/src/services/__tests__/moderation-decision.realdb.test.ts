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
import { DecisionSchema } from '@oxyhq/crowdsource-contracts';
import type { ListingStatus } from '@mercaria/shared-types';

const uri = process.env.MERCARIA_TEST_MONGODB_URI;

// `automatic`, because every assertion here is about an EFFECT and `observe`
// would make them all vacuous. Config freezes at module load, so the production
// default is verified in its own file (`moderation-observe.realdb.test.ts`)
// rather than by toggling an env var this process has already read.
process.env.CROWDSOURCE_ENFORCEMENT_MODE = 'automatic';

let AbuseReport: typeof import('../../models/abuse-report.js').AbuseReport;
let ModerationEnforcement: typeof import('../../models/moderation-enforcement.js').ModerationEnforcement;
let Listing: typeof import('../../models/listing.js').Listing;
let applyDecisionEvent: typeof import('../moderation/decision.worker.js').applyDecisionEvent;

beforeAll(async () => {
  if (!uri) throw new Error('MERCARIA_TEST_MONGODB_URI missing — is vitest.globalSetup.ts wired?');
  await mongoose.connect(uri, { dbName: 'mercaria-decision-test' });

  ({ AbuseReport } = await import('../../models/abuse-report.js'));
  ({ ModerationEnforcement } = await import('../../models/moderation-enforcement.js'));
  ({ Listing } = await import('../../models/listing.js'));
  ({ applyDecisionEvent } = await import('../moderation/decision.worker.js'));

  await ModerationEnforcement.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
});

beforeEach(async () => {
  await Promise.all([
    AbuseReport.deleteMany({}),
    ModerationEnforcement.deleteMany({}),
    Listing.deleteMany({}),
  ]);
});

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

async function seedListing(status: ListingStatus): Promise<string> {
  const created = await Listing.create({
    ownerType: 'user',
    oxyUserId: 'seller-1',
    title: 'A reported item',
    description: 'Body text',
    condition: 'new',
    status,
    categorySlugs: [],
    images: [],
    tags: [],
    options: [],
    priceRange: {
      min: { amount: 1000, currency: 'FAIR' },
      max: { amount: 1000, currency: 'FAIR' },
    },
    hasInventory: true,
    variantCount: 1,
    collectionIds: [],
    externalRefs: [],
    overriddenFields: [],
  });
  if (!created) throw new Error('seed listing was not created');
  return created._id.toHexString();
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

    await applyDecisionEvent(decidedEvent(decision()));

    const listing = await Listing.findById(listingId).lean<{ status?: string } | null>();
    expect(listing?.status).toBe('restricted');

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
    expect(
      (await Listing.findById(listingId).lean<{ status?: string } | null>())?.status,
    ).toBe('restricted');

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

    const restored = await Listing.findById(listingId).lean<{ status?: string } | null>();
    expect(restored?.status).toBe('draft');
  });
});
