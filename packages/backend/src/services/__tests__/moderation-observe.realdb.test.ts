/**
 * `observe` — the mode Mercaria actually ships in — really changes nothing.
 *
 * ## Why this is a separate file
 *
 * `config` is frozen at module load, so a process that has already read
 * `CROWDSOURCE_ENFORCEMENT_MODE` cannot be talked out of it. An earlier version
 * of this test lived beside the `automatic` ones and toggled the env var; it
 * silently took a "config already froze, skip" branch and asserted nothing about
 * observe at all. Vitest isolates the module registry per FILE, so the mode is
 * settable here and only here.
 *
 * That is the same failure this whole suite keeps finding: a test that runs, goes
 * green, and answers a narrower question than the one it is named after.
 *
 * ## What observe has to prove
 *
 * That it is an AUDIT rather than a comment. The plan, the claim and the recorded
 * row must be identical to production, and only the effect withheld — otherwise
 * switching the mode off is a leap rather than a confirmation of something
 * already watched.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { DecisionSchema } from '@oxyhq/crowdsource-contracts';

const uri = process.env.MERCARIA_TEST_MONGODB_URI;

// Before any import that reads config. This is the production default; setting it
// explicitly documents what is under test rather than relying on the fallback.
process.env.CROWDSOURCE_ENFORCEMENT_MODE = 'observe';

let ModerationEnforcement: typeof import('../../models/moderation-enforcement.js').ModerationEnforcement;
let Listing: typeof import('../../models/listing.js').Listing;
let enforceDecision: typeof import('../moderation/enforcement.service.js').enforceDecision;
let config: typeof import('../../config/index.js').config;

beforeAll(async () => {
  if (!uri) throw new Error('MERCARIA_TEST_MONGODB_URI missing — is vitest.globalSetup.ts wired?');
  await mongoose.connect(uri, { dbName: 'mercaria-observe-test' });

  ({ ModerationEnforcement } = await import('../../models/moderation-enforcement.js'));
  ({ Listing } = await import('../../models/listing.js'));
  ({ enforceDecision } = await import('../moderation/enforcement.service.js'));
  ({ config } = await import('../../config/index.js'));

  await ModerationEnforcement.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
});

beforeEach(async () => {
  await Promise.all([ModerationEnforcement.deleteMany({}), Listing.deleteMany({})]);
});

function violation(): Record<string, unknown> {
  return {
    id: 'dec_observe_1',
    caseId: 'case_observe_1',
    revision: 1,
    status: 'final',
    outcome: 'violation',
    contextSufficiency: 'sufficient',
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
    jury: { size: 5, decisiveVotes: 5, winningVotes: 4, agreement: 0.8, specialistPresent: false },
    policyVersions: { taxonomy: '2026.1', application: 'mercaria.1', oxyConduct: 'oxy.1' },
    publishedAt: new Date().toISOString(),
  };
}

async function seedActiveListing(): Promise<string> {
  const created = await Listing.create({
    ownerType: 'user',
    oxyUserId: 'seller-1',
    title: 'A reported item',
    description: 'Body text',
    condition: 'new',
    status: 'active',
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

describe('observe mode', () => {
  it('is the mode this process actually froze at (floor)', () => {
    /**
     * Without this the whole file could run under `automatic` and every
     * assertion below would be about a different mode than its name claims —
     * which is precisely what the earlier co-located version did.
     */
    expect(config.crowdSource.enforcementMode).toBe('observe');
  });

  it('records the plan and leaves the listing untouched', async () => {
    const listingId = await seedActiveListing();
    const parsed = DecisionSchema.safeParse(violation());
    if (!parsed.success) throw new Error(`fixture drifted: ${parsed.error.message}`);

    const outcomes = await enforceDecision(parsed.data, { type: 'listing', id: listingId });

    // The effect did NOT happen.
    const listing = await Listing.findById(listingId).lean<{ status?: string } | null>();
    expect(listing?.status).toBe('active');

    // The audit trail is real: same plan, same claim, recorded as not applied.
    const row = await ModerationEnforcement.findOne({ decisionId: 'dec_observe_1' }).lean();
    expect(row).not.toBeNull();
    expect(row?.action).toBe('restrict');
    expect(row?.applied).toBe(false);
    // And it says WHY, so a row nobody applied is distinguishable from one that
    // found nothing to do.
    expect(row?.reason).toMatch(/enforcement mode is observe/i);

    expect(outcomes.map((entry) => entry.result)).toEqual(['recorded']);
  });

  it('still claims idempotently, so switching modes cannot double-enforce', async () => {
    /**
     * The claim is taken in observe too. If it were skipped, a decision watched
     * in observe and then re-delivered after the switch to `automatic` would be
     * enforced as though it had never been seen.
     */
    const listingId = await seedActiveListing();
    const parsed = DecisionSchema.safeParse(violation());
    if (!parsed.success) throw new Error('fixture drifted');

    await enforceDecision(parsed.data, { type: 'listing', id: listingId });
    const second = await enforceDecision(parsed.data, { type: 'listing', id: listingId });

    expect(second.map((entry) => entry.result)).toEqual(['duplicate']);
    expect(
      await ModerationEnforcement.countDocuments({ decisionId: 'dec_observe_1' }),
    ).toBe(1);
  });
});
