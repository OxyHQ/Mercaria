/**
 * The analytics domain's DATABASE properties, against a REAL Postgres server
 * (#77).
 *
 * Everything here is something a mocked repository cannot see. A mocked
 * `insert` accepts any statement, including one the server rejects outright —
 * so a CHECK, a partial unique, an append-only trigger and a lease claim have no
 * mocked counterpart, and the identity rules that rest on them would be
 * comments.
 *
 * The four groups, and why each needs a server:
 *
 *  - **The identity CHECKs.** "A pseudonymous session is not an Oxy user" and
 *    "consent-denied events carry no account id" are constraints. The service
 *    also enforces them, deliberately — the CHECK is what stops a future writer
 *    bypassing the service, and the service is what stops a legitimate caller
 *    getting a 500 for a rule they could not have known.
 *  - **The RESTRICTED commerce correlation.** Envelope field 5 is a CHECK
 *    rendered from a shared-types tuple, and the thing worth proving is that a
 *    pre-checkout event carrying a checkout group is REFUSED by the database.
 *  - **Append-only.** The trigger is the whole of identity rule 5 surviving a
 *    future `update` somebody adds to the repository.
 *  - **Idempotency.** The rollup and query-aggregate upserts must CONVERGE on a
 *    replay rather than doubling, which is a property of `ON CONFLICT DO UPDATE`
 *    against a real unique index.
 *
 * Every fixture pair spans the distinction its check exists to make — AGENTS.md
 * rule (E). A suite where every row sits on the same side of a constraint cannot
 * tell the constraint from its absence.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, getDb, type Database } from '../../postgres.js';
import {
  analyticsEvents,
  analyticsExperiments,
  analyticsPseudonymSalts,
  analyticsQueryAggregates,
  analyticsRollups,
  analyticsSearchQueries,
} from '../../schema/analytics.js';
import { insertAnalyticsEvents, type AnalyticsEventInsert } from '../eventRepository.js';
import {
  insertSearchQueries,
  redactExpiredQueryText,
  readTopQueries,
  upsertQueryAggregates,
} from '../searchQueryRepository.js';
import { upsertRollups, claimRollupRun, completeRollupRun } from '../rollupRepository.js';
import { readCurrentSalt, rotateSalt } from '../pseudonymSaltRepository.js';

let db: Database;

/** A per-run marker so parallel test files never collide on shared rows. */
const RUN = uuidv7().slice(-12);

const eventIds: string[] = [];
const queryEventIds: string[] = [];
const rollupKeys: string[] = [];
const aggregateQueries: string[] = [];
const experimentKeys: string[] = [];

beforeAll(async () => {
  await connectPostgres();
  db = getDb();
});

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  if (eventIds.length > 0) {
    await db.delete(analyticsEvents).where(inArray(analyticsEvents.id, eventIds));
    eventIds.length = 0;
  }
  if (queryEventIds.length > 0) {
    await db
      .delete(analyticsSearchQueries)
      .where(inArray(analyticsSearchQueries.queryEventId, queryEventIds));
    queryEventIds.length = 0;
  }
  if (rollupKeys.length > 0) {
    await db.delete(analyticsRollups).where(inArray(analyticsRollups.storeId, rollupKeys));
    rollupKeys.length = 0;
  }
  if (aggregateQueries.length > 0) {
    await db
      .delete(analyticsQueryAggregates)
      .where(inArray(analyticsQueryAggregates.normalizedQuery, aggregateQueries));
    aggregateQueries.length = 0;
  }
  if (experimentKeys.length > 0) {
    // Drafts only — a version that ever ran is protected by the immutability
    // trigger, so the fixtures that activate one are stopped and left behind
    // deliberately. Their keys carry the run marker, so they collide with
    // nothing.
    await db
      .delete(analyticsExperiments)
      .where(
        sql`${analyticsExperiments.experimentKey} in ${experimentKeys} and ${analyticsExperiments.status} = 'draft'`,
      );
    experimentKeys.length = 0;
  }
});

/**
 * Assert a write is refused by a SPECIFIC named constraint.
 *
 * `rejects.toThrow()` alone would also pass when the wrong constraint fired,
 * which on a table carrying eleven CHECKs is most of the value of the
 * assertion. drizzle wraps the driver error, so the constraint name lives on
 * the CAUSE — walking the chain is what makes the name reachable at all.
 */
async function expectRefusedBy(write: () => Promise<unknown>, constraint: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await write();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the write SUCCEEDED; the constraint did not fire').toBeDefined();
  expect(constraintNameOf(caught), `expected ${String(constraint)}; got: ${String(caught)}`).toMatch(
    constraint,
  );
}

/** The `constraint_name` a driver error carries, through drizzle's wrapper. */
function constraintNameOf(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const named = current as { constraint_name?: unknown; cause?: unknown };
    if (typeof named.constraint_name === 'string') return named.constraint_name;
    current = named.cause;
  }
  // A trigger RAISEs rather than violating a named constraint, so its message
  // IS the identifier. Falling back to it keeps both refusal shapes assertable
  // through one helper.
  return error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
}

/** A complete, insertable event. Overridable field by field. */
function anEvent(overrides: Partial<AnalyticsEventInsert> = {}): AnalyticsEventInsert {
  const now = new Date();
  return {
    envelopeVersion: '2026-08-09.1',
    eventType: 'product_page_view',
    eventClass: 'discovery',
    occurredAt: now,
    receivedAt: now,
    actorKind: 'anonymous',
    oxyUserId: null,
    pseudonymousSessionId: null,
    pseudonymEpoch: null,
    checkoutGroupId: null,
    orderId: null,
    clientSurface: 'storefront_web',
    appVersion: null,
    market: null,
    queryEventId: null,
    listingId: null,
    productVariantId: null,
    canonicalProductId: null,
    canonicalVariantId: null,
    offerId: null,
    merchantId: null,
    storefrontId: null,
    categoryId: null,
    storeId: null,
    searchPolicyVersion: null,
    rankingPolicyVersion: null,
    experimentKey: null,
    experimentVersion: null,
    experimentVariant: null,
    trafficClass: 'human',
    consentState: 'granted',
    collectionMode: 'full',
    buyerOrigin: null,
    paymentMethodCategory: null,
    reasonCode: null,
    position: null,
    resultCount: null,
    latencyMs: null,
    quantity: null,
    itemCount: null,
    expiresAt: new Date(now.getTime() + 86_400_000),
    ...overrides,
  };
}

/** Insert an event and remember its id for cleanup. */
async function insertOne(overrides: Partial<AnalyticsEventInsert> = {}): Promise<string> {
  await insertAnalyticsEvents([anEvent(overrides)]);
  const rows = await db
    .select({ id: analyticsEvents.id })
    .from(analyticsEvents)
    .orderBy(sql`${analyticsEvents.createdAt} desc`)
    .limit(1);
  const id = rows[0]?.id ?? '';
  eventIds.push(id);
  return id;
}

describe('the identity CHECKs', () => {
  it('accepts an Oxy actor with an account id and a pseudonymous actor with a hash', async () => {
    // The POSITIVE half. Without it, a CHECK that refused everything would pass
    // every negative case below — AGENTS.md rule (E).
    await expect(insertOne({ actorKind: 'oxy', oxyUserId: `oxy-${RUN}` })).resolves.toBeTruthy();
    await expect(
      insertOne({ actorKind: 'guest', pseudonymousSessionId: `p${RUN}`, pseudonymEpoch: 1 }),
    ).resolves.toBeTruthy();
  });

  it('REFUSES a row carrying both an Oxy id and a pseudonym', async () => {
    // Identity rule 1: the join this domain exists to refuse.
    await expectRefusedBy(
      () =>
        insertAnalyticsEvents([
          anEvent({
            actorKind: 'oxy',
            oxyUserId: `oxy-${RUN}`,
            pseudonymousSessionId: `p${RUN}`,
            pseudonymEpoch: 1,
          }),
        ]),
      /identity_exclusivity/,
    );
  });

  it('REFUSES an Oxy id on a guest actor', async () => {
    await expectRefusedBy(
      () => insertAnalyticsEvents([anEvent({ actorKind: 'guest', oxyUserId: `oxy-${RUN}` })]),
      /identity_exclusivity/,
    );
  });

  it('REFUSES a pseudonym on an Oxy actor', async () => {
    await expectRefusedBy(
      () =>
        insertAnalyticsEvents([
          anEvent({ actorKind: 'oxy', pseudonymousSessionId: `p${RUN}`, pseudonymEpoch: 1 }),
        ]),
      /identity_exclusivity/,
    );
  });

  it('REFUSES a pseudonym with no epoch', async () => {
    // A hash whose salt epoch is unknown could never be told apart from a hash
    // under a salt that still exists.
    await expectRefusedBy(
      () =>
        insertAnalyticsEvents([
          anEvent({ actorKind: 'guest', pseudonymousSessionId: `p${RUN}`, pseudonymEpoch: null }),
        ]),
      /pseudonym_epoch/,
    );
  });

  it('REFUSES an account id on a consent-DENIED event', async () => {
    // Envelope field 3's "and permitted", as a constraint.
    await expectRefusedBy(
      () =>
        insertAnalyticsEvents([
          anEvent({ actorKind: 'oxy', oxyUserId: `oxy-${RUN}`, consentState: 'denied' }),
        ]),
      /consent_identity/,
    );
  });

  it('ACCEPTS a consent-denied event with no account id', async () => {
    // The other side of the same distinction: the event is still counted, and
    // refusing it would make a consent-denying cohort invisible in exactly the
    // denominators that need to know how big it is.
    await expect(
      insertOne({ actorKind: 'oxy', oxyUserId: null, consentState: 'denied' }),
    ).resolves.toBeTruthy();
  });

  it('REFUSES a row claiming collection mode `off`', async () => {
    await expectRefusedBy(
      () => insertAnalyticsEvents([anEvent({ collectionMode: 'off' })]),
      /collection_mode_stored/,
    );
  });
});

describe('envelope field 5 — the RESTRICTED commerce correlation', () => {
  it('ACCEPTS a checkout group on a checkout event', async () => {
    await expect(
      insertOne({ eventType: 'checkout_started', checkoutGroupId: `grp-${RUN}` }),
    ).resolves.toBeTruthy();
  });

  it('REFUSES a checkout group on a pre-checkout discovery event', async () => {
    // "Only for documented commerce metrics AFTER checkout begins" — the pair
    // with the case above is what tells the CHECK from its absence.
    await expectRefusedBy(
      () =>
        insertAnalyticsEvents([
          anEvent({ eventType: 'product_page_view', checkoutGroupId: `grp-${RUN}` }),
        ]),
      /commerce_correlation/,
    );
  });

  it('REFUSES an order id on a search event', async () => {
    await expectRefusedBy(
      () =>
        insertAnalyticsEvents([anEvent({ eventType: 'search_submitted', orderId: `ord-${RUN}` })]),
      /commerce_correlation/,
    );
  });
});

describe('envelope field 12 — the buyer-origin dimension', () => {
  it('ACCEPTS a buyer origin on a funnel event', async () => {
    await expect(
      insertOne({ eventType: 'checkout_started', buyerOrigin: 'guest' }),
    ).resolves.toBeTruthy();
  });

  it('REFUSES a buyer origin on a discovery event', async () => {
    // Identity rule 7 from the reporting side: a merchant-facing query report
    // must not be sliceable by whether the searcher was a guest.
    await expectRefusedBy(
      () =>
        insertAnalyticsEvents([anEvent({ eventType: 'search_submitted', buyerOrigin: 'guest' })]),
      /buyer_origin_scope/,
    );
  });
});

describe('bounded dimensions', () => {
  it('REFUSES a market that is not a two-letter code', async () => {
    await expectRefusedBy(() => insertAnalyticsEvents([anEvent({ market: 'Spain' })]), /market_check/);
  });

  it('REFUSES prose in the app version', async () => {
    await expectRefusedBy(
      () => insertAnalyticsEvents([anEvent({ appVersion: 'the version with the bug in it' })]),
      /app_version/,
    );
  });

  it('REFUSES a negative measure', async () => {
    await expectRefusedBy(() => insertAnalyticsEvents([anEvent({ position: -1 })]), /measures/);
  });

  it('REFUSES a partial experiment triple', async () => {
    await expectRefusedBy(
      () => insertAnalyticsEvents([anEvent({ experimentKey: 'x', experimentVariant: 'control' })]),
      /experiment_check/,
    );
  });
});

describe('events are APPEND-ONLY — identity rule 5', () => {
  it('refuses an UPDATE from any caller', async () => {
    // The service layer has no update path, and "there is no function for it" is
    // a property of today's code. This trigger is what makes it survive whoever
    // adds one — a completed claim cannot rewrite a stored event's actor, its
    // buyer origin or its correlation, from a service, a migration or psql.
    const id = await insertOne({
      actorKind: 'guest',
      pseudonymousSessionId: `p${RUN}`,
      pseudonymEpoch: 1,
    });
    await expectRefusedBy(
      () =>
        db.update(analyticsEvents).set({ oxyUserId: `oxy-${RUN}` }).where(eq(analyticsEvents.id, id)),
      /append-only/,
    );
  });

  it('PERMITS a DELETE, because retention must never be blocked', async () => {
    // The deliberate exception. Erasure on schedule is the policy, and a trigger
    // that refused it would make the retention sweep fail silently forever.
    const id = await insertOne();
    await expect(
      db.delete(analyticsEvents).where(eq(analyticsEvents.id, id)),
    ).resolves.toBeDefined();
    eventIds.pop();
  });
});

describe('the search-query record', () => {
  it('converges on a repeat rather than writing a second row', async () => {
    const queryEventId = `q-${RUN}`;
    queryEventIds.push(queryEventId);
    const record = {
      queryEventId,
      redactedText: 'red shoes',
      redactionKinds: [],
      normalizedTokens: ['red', 'shoes'],
      resultCount: 3,
      duplicateResultCount: 0,
      latencyMs: 10,
      market: 'ES',
      categoryId: null,
      searchPolicyVersion: null,
      rankingPolicyVersion: null,
      trafficClass: 'human' as const,
      textExpiresAt: new Date(Date.now() + 86_400_000),
      expiresAt: new Date(Date.now() + 172_800_000),
    };
    expect(await insertSearchQueries([record])).toBe(1);
    // A flush that straddled a crash may deliver a batch twice; two records of
    // one search is not two facts.
    expect(await insertSearchQueries([record])).toBe(0);
  });

  it('REFUSES a duplicate count above the result count', async () => {
    await expectRefusedBy(
      () =>
        insertSearchQueries([
          {
            queryEventId: `q-bad-${RUN}`,
            redactedText: null,
            redactionKinds: [],
            normalizedTokens: [],
            resultCount: 2,
            duplicateResultCount: 5,
            latencyMs: 1,
            market: null,
            categoryId: null,
            searchPolicyVersion: null,
            rankingPolicyVersion: null,
            trafficClass: 'human',
            textExpiresAt: new Date(),
            expiresAt: new Date(Date.now() + 1_000),
          },
        ]),
      /counts_check/,
    );
  });

  it('REFUSES a text deadline that outlives the row', async () => {
    // Otherwise the nulling sweep would have a window in which it can never run.
    await expectRefusedBy(
      () =>
        insertSearchQueries([
          {
            queryEventId: `q-order-${RUN}`,
            redactedText: 'x',
            redactionKinds: [],
            normalizedTokens: [],
            resultCount: 0,
            duplicateResultCount: 0,
            latencyMs: 1,
            market: null,
            categoryId: null,
            searchPolicyVersion: null,
            rankingPolicyVersion: null,
            trafficClass: 'human',
            textExpiresAt: new Date(Date.now() + 172_800_000),
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        ]),
      /retention_order/,
    );
  });

  it('nulls the text at its deadline and leaves the tokens standing', async () => {
    const queryEventId = `q-redact-${RUN}`;
    queryEventIds.push(queryEventId);
    await insertSearchQueries([
      {
        queryEventId,
        redactedText: 'red shoes',
        redactionKinds: [],
        normalizedTokens: ['red', 'shoes'],
        resultCount: 3,
        duplicateResultCount: 0,
        latencyMs: 10,
        market: null,
        categoryId: null,
        searchPolicyVersion: null,
        rankingPolicyVersion: null,
        trafficClass: 'human',
        // Already past its text deadline; the row itself is not.
        textExpiresAt: new Date(Date.now() - 1_000),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);

    const redacted = await redactExpiredQueryText(new Date(), 100);
    expect(redacted).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select({
        redactedText: analyticsSearchQueries.redactedText,
        normalizedTokens: analyticsSearchQueries.normalizedTokens,
      })
      .from(analyticsSearchQueries)
      .where(eq(analyticsSearchQueries.queryEventId, queryEventId));
    // The whole of "raw query text is never retained": the string is gone and
    // the aggregate unit survives.
    expect(rows[0]?.redactedText).toBeNull();
    expect(rows[0]?.normalizedTokens).toEqual(['red', 'shoes']);
  });
});

describe('the query reporting floor — privacy rules 4 and 5', () => {
  it('suppresses a query below the minimum and serves one above it', async () => {
    const rare = `rare ${RUN}`;
    const popular = `popular ${RUN}`;
    aggregateQueries.push(rare, popular);
    const bucketDate = new Date().toISOString().slice(0, 10);
    await upsertQueryAggregates([
      {
        bucketDate,
        market: 'ES',
        normalizedQuery: rare,
        occurrences: 3,
        zeroResultOccurrences: 0,
        clickOccurrences: 0,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        bucketDate,
        market: 'ES',
        normalizedQuery: popular,
        occurrences: 500,
        zeroResultOccurrences: 10,
        clickOccurrences: 200,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);

    const report = await readTopQueries({
      from: bucketDate,
      to: bucketDate,
      market: 'ES',
      limit: 50,
    });
    const served = report.map((row) => row.normalizedQuery);
    // The pair is the point: a reader that returned everything and one that
    // returned nothing would each pass half of this.
    expect(served).toContain(popular);
    expect(served).not.toContain(rare);
  });

  it('recomputing a bucket OVERWRITES it rather than adding to it', async () => {
    const query = `converge ${RUN}`;
    aggregateQueries.push(query);
    const bucketDate = new Date().toISOString().slice(0, 10);
    const bucket = {
      bucketDate,
      market: 'FR',
      normalizedQuery: query,
      occurrences: 100,
      zeroResultOccurrences: 0,
      clickOccurrences: 0,
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    await upsertQueryAggregates([bucket]);
    await upsertQueryAggregates([bucket]);

    const rows = await db
      .select({ occurrences: analyticsQueryAggregates.occurrences })
      .from(analyticsQueryAggregates)
      .where(eq(analyticsQueryAggregates.normalizedQuery, query));
    expect(rows).toHaveLength(1);
    // An increment would read 200 here, and a resumed sweep replaying a page
    // would double every number on a chart nobody would think to doubt.
    expect(rows[0]?.occurrences).toBe(100);
  });
});

describe('rollup buckets', () => {
  it('recomputing a bucket OVERWRITES it', async () => {
    const storeId = `store-${RUN}`;
    rollupKeys.push(storeId);
    const bucket = {
      metricKey: 'zero_result_rate',
      bucketDate: new Date().toISOString().slice(0, 10),
      market: 'ES',
      clientSurface: 'storefront_web',
      actorKind: 'anonymous',
      buyerOrigin: '',
      storeId,
      merchantId: '',
      numerator: 5,
      denominator: 100,
      source: 'analytics_events' as const,
      computedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    await upsertRollups([bucket]);
    await upsertRollups([{ ...bucket, numerator: 7, denominator: 120 }]);

    const rows = await db
      .select({
        numerator: analyticsRollups.numerator,
        denominator: analyticsRollups.denominator,
      })
      .from(analyticsRollups)
      .where(eq(analyticsRollups.storeId, storeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ numerator: 7, denominator: 120 });
  });

  it('REFUSES a metric key no definition explains', async () => {
    // Acceptance 6 from the storage side: a dashboard cannot find a number whose
    // definition is absent, because the number could not be stored.
    await expectRefusedBy(
      () =>
        upsertRollups([
          {
            metricKey: 'invented_metric',
            bucketDate: new Date().toISOString().slice(0, 10),
            market: '',
            clientSurface: '',
            actorKind: '',
            buyerOrigin: '',
            storeId: `store-bad-${RUN}`,
            merchantId: '',
            numerator: 1,
            denominator: 1,
            source: 'analytics_events',
            computedAt: new Date(),
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        ]),
      /metric_key/,
    );
  });
});

describe('the rollup lease', () => {
  it('admits ONE claimant and reclaims an expired lease', async () => {
    const job = `test-rollup-${RUN}`;
    const now = new Date();
    expect(await claimRollupRun({ job, leaseOwner: 'a', leaseMs: 60_000, now })).toBeDefined();
    // A second task finds the lease held and does nothing — the empty vs one-row
    // RETURNING set IS the answer, so a real failure still propagates.
    expect(await claimRollupRun({ job, leaseOwner: 'b', leaseMs: 60_000, now })).toBeUndefined();

    // A stale idea of the cursor cannot rewind the task that took over: the
    // owner check refuses the write.
    expect(await completeRollupRun({ job, leaseOwner: 'b', completedDate: '2020-01-01', now })).toBe(
      false,
    );
    expect(await completeRollupRun({ job, leaseOwner: 'a', completedDate: '2026-01-01', now })).toBe(
      true,
    );
    // Released — the next tick can claim it.
    expect(await claimRollupRun({ job, leaseOwner: 'c', leaseMs: 60_000, now })).toBeDefined();
    await db.execute(sql`delete from analytics_rollup_cursors where id = ${job}`);
  });
});

describe('the pseudonym salt', () => {
  it('keeps exactly one CURRENT epoch across a rotation', async () => {
    // A second current epoch would silently split one session across two
    // pseudonyms; none at all would leave the derivation with nothing to hash.
    const before = await readCurrentSalt();
    const rotated = await rotateSalt({
      salt: 'f'.repeat(64),
      now: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(rotated.epoch).toBe((before?.epoch ?? 0) + 1);

    const current = await db
      .select({ epoch: analyticsPseudonymSalts.epoch })
      .from(analyticsPseudonymSalts)
      .where(sql`${analyticsPseudonymSalts.activeUntil} is null`);
    expect(current).toHaveLength(1);
    expect(current[0]?.epoch).toBe(rotated.epoch);
  });
});

describe('an experiment version is immutable once it runs', () => {
  it('permits every edit while draft and refuses them once active', async () => {
    const experimentKey = `exp-${RUN}`;
    experimentKeys.push(experimentKey);
    await db.insert(analyticsExperiments).values({
      experimentKey,
      version: 1,
      status: 'draft',
      treatmentKind: 'copy_variant',
      hypothesis: 'a shorter title lifts click-through',
      primaryMetricKey: 'search_to_product_click_rate',
      guardrailMetricKeys: ['zero_result_rate'],
      stopConditions: ['error_rate_regression'],
      assignmentUnit: 'pseudonymous_session',
      assignmentSalt: 'salt',
      variants: ['control', 'treatment'],
      trafficAllocationBps: 5_000,
    });

    // Draft: editable. The positive half — without it, a trigger that refused
    // every UPDATE would pass the negative case below.
    await expect(
      db
        .update(analyticsExperiments)
        .set({ trafficAllocationBps: 8_000 })
        .where(eq(analyticsExperiments.experimentKey, experimentKey)),
    ).resolves.toBeDefined();

    await db
      .update(analyticsExperiments)
      .set({ status: 'active', activatedAt: new Date() })
      .where(eq(analyticsExperiments.experimentKey, experimentKey));

    // Active: the salt is frozen. Editing it silently re-buckets every unit
    // mid-flight, so the same person is control on Monday and treatment on
    // Tuesday, and nothing in the data says so.
    await expectRefusedBy(
      () =>
        db
          .update(analyticsExperiments)
          .set({ assignmentSalt: 'a different salt' })
          .where(eq(analyticsExperiments.experimentKey, experimentKey)),
      /immutable/,
    );

    // …and so is the allocation.
    await expectRefusedBy(
      () =>
        db
          .update(analyticsExperiments)
          .set({ trafficAllocationBps: 10_000 })
          .where(eq(analyticsExperiments.experimentKey, experimentKey)),
      /immutable/,
    );

    // Stopping it IS permitted — that is a decision, not an edit.
    await expect(
      db
        .update(analyticsExperiments)
        .set({ status: 'stopped', stoppedAt: new Date(), stopReason: 'operator_stopped' })
        .where(eq(analyticsExperiments.experimentKey, experimentKey)),
    ).resolves.toBeDefined();
  });

  it('admits only ONE active version per experiment key', async () => {
    const experimentKey = `exp-active-${RUN}`;
    experimentKeys.push(experimentKey);
    const base = {
      experimentKey,
      status: 'active' as const,
      treatmentKind: 'copy_variant' as const,
      hypothesis: 'a shorter title lifts click-through',
      primaryMetricKey: 'search_to_product_click_rate',
      guardrailMetricKeys: ['zero_result_rate'],
      stopConditions: ['error_rate_regression'],
      assignmentUnit: 'pseudonymous_session' as const,
      assignmentSalt: 'salt',
      variants: ['control', 'treatment'],
      trafficAllocationBps: 5_000,
      activatedAt: new Date(),
    };
    await db.insert(analyticsExperiments).values({ ...base, version: 1 });
    // Two versions splitting the same traffic is refused by the DATABASE, not by
    // a read-then-write two racers would walk past.
    await expectRefusedBy(
      () => db.insert(analyticsExperiments).values({ ...base, version: 2 }),
      /analytics_experiments_active_key/,
    );

    await db.execute(
      sql`update analytics_experiments set status = 'stopped', stopped_at = now(), stop_reason = 'operator_stopped' where experiment_key = ${experimentKey}`,
    );
  });

  it('REFUSES a one-armed experiment and one with no guardrail', async () => {
    const experimentKey = `exp-shape-${RUN}`;
    experimentKeys.push(experimentKey);
    const base = {
      experimentKey,
      version: 1,
      status: 'draft' as const,
      treatmentKind: 'copy_variant' as const,
      hypothesis: 'a shorter title lifts click-through',
      primaryMetricKey: 'search_to_product_click_rate',
      guardrailMetricKeys: ['zero_result_rate'],
      stopConditions: ['error_rate_regression'],
      assignmentUnit: 'pseudonymous_session' as const,
      assignmentSalt: 'salt',
      variants: ['control', 'treatment'],
      trafficAllocationBps: 5_000,
    };
    // One arm is a rollout wearing an experiment's clothes.
    await expectRefusedBy(
      () => db.insert(analyticsExperiments).values({ ...base, variants: ['only'] }),
      /shape_check/,
    );
    // No guardrail is an experiment with no stop condition anybody is watching.
    await expectRefusedBy(
      () => db.insert(analyticsExperiments).values({ ...base, guardrailMetricKeys: [] }),
      /shape_check/,
    );
  });
});

