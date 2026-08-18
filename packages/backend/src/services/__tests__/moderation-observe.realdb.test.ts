/**
 * `observe` — the mode Mercaria actually ships in — really changes nothing.
 *
 * ## Why this is a separate file
 *
 * `config` is frozen at module load, so a process that has already read
 * `CROWDSOURCE_ENFORCEMENT_MODE` cannot be talked out of it. An earlier version of
 * this test lived beside the `automatic` ones and toggled the env var; it silently
 * took a "config already froze, skip" branch and asserted nothing about observe at
 * all. Vitest isolates the module registry per FILE, so the mode is settable here
 * and only here.
 *
 * That is the same failure this whole suite keeps finding: a test that runs, goes
 * green, and answers a narrower question than the one it is named after.
 *
 * ## What observe has to prove
 *
 * That it is an AUDIT rather than a comment. The plan, the claim and the recorded
 * row must be identical to production, and only the effect withheld — otherwise
 * switching the mode off is a leap rather than a confirmation of something already
 * watched.
 *
 * A realdb file because the CLAIM is the thing under test, and the claim is a
 * unique index. A mocked ledger accepts the second claim and the idempotency
 * assertion below becomes a statement about the mock.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { DecisionSchema } from '@oxyhq/crowdsource-contracts';
import type { Database } from '../../db/postgres.js';
import { listings } from '../../db/schema/catalog.js';
import { moderationEnforcements } from '../../db/schema/moderation.js';

// Before any import that reads config. This is the production default; setting it
// explicitly documents what is under test rather than relying on the fallback.
process.env.CROWDSOURCE_ENFORCEMENT_MODE = 'observe';

let pg: Database;
let connectPostgres: typeof import('../../db/postgres.js').connectPostgres;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let insertListing: typeof import('../../db/catalog/listingRepository.js').insertListing;
let findListingById: typeof import('../../db/catalog/listingRepository.js').findListingById;
let enforceDecision: typeof import('../moderation/enforcement.service.js').enforceDecision;
let config: typeof import('../../config/index.js').config;

/** Unique to this run: the Postgres database is shared with every parallel file. */
const RUN = uuidv7();
const DECISION_ID = `dec-observe-${RUN}`;

const seededListingIds: string[] = [];

beforeAll(async () => {
  ({ connectPostgres, closePostgres } = await import('../../db/postgres.js'));
  ({ insertListing, findListingById } = await import('../../db/catalog/listingRepository.js'));
  ({ enforceDecision } = await import('../moderation/enforcement.service.js'));
  ({ config } = await import('../../config/index.js'));

  pg = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await dropSeeded();
  await closePostgres();
});

beforeEach(async () => {
  await dropSeeded();
});

async function dropSeeded(): Promise<void> {
  await pg
    .delete(moderationEnforcements)
    .where(eq(moderationEnforcements.decisionId, DECISION_ID));
  const listingIds = seededListingIds.splice(0);
  if (listingIds.length > 0) {
    await pg.delete(listings).where(inArray(listings.id, listingIds));
  }
}

function violation(): Record<string, unknown> {
  return {
    id: DECISION_ID,
    caseId: `case-observe-${RUN}`,
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
  const row = await insertListing(
    {
      ownerType: 'user',
      oxyUserId: `seller-${RUN}`,
      storeId: null,
      productTypeDefinitionId: null,
      title: 'A reported item',
      description: 'Body text',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      conditionSourceLabel: null,
      conditionAcknowledgedAt: null,
      status: 'active',
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

describe('observe mode', () => {
  it('is the mode this process actually froze at (floor)', () => {
    /**
     * Without this the whole file could run under `automatic` and every assertion
     * below would be about a different mode than its name claims — which is
     * precisely what the earlier co-located version did.
     */
    expect(config.crowdSource.enforcementMode).toBe('observe');
  });

  it('records the plan and leaves the listing untouched', async () => {
    const listingId = await seedActiveListing();
    const parsed = DecisionSchema.safeParse(violation());
    if (!parsed.success) throw new Error(`fixture drifted: ${parsed.error.message}`);

    const outcomes = await enforceDecision(parsed.data, { type: 'listing', id: listingId });

    // The effect did NOT happen.
    expect((await findListingById(listingId))?.status).toBe('active');

    // The audit trail is real: same plan, same claim, recorded as not applied.
    const [row] = await pg
      .select()
      .from(moderationEnforcements)
      .where(eq(moderationEnforcements.decisionId, DECISION_ID));
    expect(row).toBeDefined();
    expect(row?.action).toBe('restrict');
    expect(row?.applied).toBe(false);
    // And it says WHY, so a row nobody applied is distinguishable from one that
    // found nothing to do.
    expect(row?.reason).toMatch(/enforcement mode is observe/i);
    // Nothing was displaced, so there is nothing to put back — an observe row that
    // recorded a previous state would invite a restore to act on a change that
    // never happened.
    expect(row?.previousStateListingStatus).toBeNull();

    expect(outcomes.map((entry) => entry.result)).toEqual(['recorded']);
  });

  it('still claims idempotently, so switching modes cannot double-enforce', async () => {
    /**
     * The claim is taken in observe too. If it were skipped, a decision watched in
     * observe and then re-delivered after the switch to `automatic` would be
     * enforced as though it had never been seen.
     */
    const listingId = await seedActiveListing();
    const parsed = DecisionSchema.safeParse(violation());
    if (!parsed.success) throw new Error('fixture drifted');

    await enforceDecision(parsed.data, { type: 'listing', id: listingId });
    const second = await enforceDecision(parsed.data, { type: 'listing', id: listingId });

    expect(second.map((entry) => entry.result)).toEqual(['duplicate']);

    const rows = await pg
      .select({ id: moderationEnforcements.id })
      .from(moderationEnforcements)
      .where(eq(moderationEnforcements.decisionId, DECISION_ID));
    expect(rows).toHaveLength(1);
  });
});
