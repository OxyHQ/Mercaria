/**
 * The ingestion framework's CONSTRAINTS, against a real PostgreSQL server (#62).
 *
 * `adapter-contract.test.ts` drives the pipeline end to end. This file goes at
 * the layer underneath it: the CHECKs, the triggers and the partial uniques that
 * hold when the service is wrong, when a replay arrives, and when somebody
 * writes SQL by hand during an incident. None of them exists under a mock — a
 * mocked `insert` accepts a statement the server rejects outright — so every
 * one of these would look green and ship broken.
 *
 * The four that carry the issue's hardest rules:
 *
 *  1. `catalog_source_runs_intake_total_check` — the vacuity floor. A page that
 *     swallowed a record cannot write a run row at all.
 *  2. `catalog_source_runs_retirement_check` — only a COMPLETE enumeration may
 *     retire anything. This is "do not mass-expire healthy offers because one
 *     refresh failed", held against `psql`.
 *  3. `mercaria_catalog_source_rights_agree` — the DEFERRED trigger. The
 *     registry's coarse rights are a projection of `resolveSourceRights`, and no
 *     statement order inside a transaction can leave them disagreeing at commit.
 *  4. `mercaria_catalog_source_policy_immutable` — a rights version is frozen
 *     once active, so withdrawing a right cannot delete the record of having
 *     granted it (issue acceptance 6).
 *
 * ## The rights matrix is driven through BOTH spellings
 *
 * `resolveSourceRights` is TypeScript and the trigger is plpgsql, and two
 * spellings of one rule can disagree — the `order-buyer-claim.realdb.test.ts`
 * situation, one domain over. So the matrix below runs every (status × policy)
 * combination through the TypeScript projection AND commits it, and a
 * disagreement surfaces as a refused commit rather than as a wrong answer
 * months later.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { CATALOG_SOURCE_STATUSES, type CatalogSourceStatus } from '@mercaria/shared-types';
import { catalogSources, sourceRecords } from '../../db/schema/provenance.js';
import {
  catalogSourceConfigs,
  catalogSourceObjects,
  catalogSourcePolicies,
  catalogSourceRuns,
} from '../../db/schema/ingestion.js';
import { ensureCatalogSource } from '../../db/canonical/provenanceRepository.js';
import { upsertSourceObject } from '../../db/ingestion/catalogSourceObjectRepository.js';
import {
  changeIngestionSourceStatus,
  configureIngestionSource,
  publishIngestionSourcePolicy,
  resolveIngestionSource,
} from '../ingestion/source.service.js';
import { projectedSourceRights, resolveSourceRights } from '../ingestion/rights.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);
const OPERATOR = `ingest-writes-${RUN}`;

const createdSourceIds: string[] = [];

function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await db
    .delete(catalogSourceObjects)
    .where(inArray(catalogSourceObjects.sourceId, safeIds(createdSourceIds)));
  await db
    .delete(catalogSourceRuns)
    .where(inArray(catalogSourceRuns.sourceId, safeIds(createdSourceIds)));
  await db.delete(sourceRecords).where(inArray(sourceRecords.sourceId, safeIds(createdSourceIds)));
  // The config leaves FIRST: with no config the rights trigger returns early,
  // so a source whose policies are about to go is no longer a contradiction.
  await db
    .delete(catalogSourceConfigs)
    .where(inArray(catalogSourceConfigs.sourceId, safeIds(createdSourceIds)));
  /**
   * The disable/delete/enable window is taken under a SESSION ADVISORY
   * LOCK (#68).
   *
   * `alter table … disable trigger` is DATABASE-WIDE and every realdb file
   * shares one server, so two files inside this window at once leave one of
   * them deleting against a trigger the other has just re-enabled —
   * measured, as a teardown failure naming a trigger the test had disabled
   * two statements earlier. The key's VALUE means nothing; its SAMENESS
   * across every file that does this is the whole mechanism.
   */
  await db.execute(sql`select pg_advisory_lock(6820068)`);
  try {
    await db.execute(
      sql`alter table catalog_source_policies disable trigger catalog_source_policies_immutable`,
    );
    await db
      .delete(catalogSourcePolicies)
      .where(inArray(catalogSourcePolicies.sourceId, safeIds(createdSourceIds)));
    await db.execute(
      sql`alter table catalog_source_policies enable trigger catalog_source_policies_immutable`,
    );
  } finally {
    await db.execute(sql`select pg_advisory_unlock(6820068)`);
  }
  await db.delete(catalogSources).where(inArray(catalogSources.id, safeIds(createdSourceIds)));
  await closePostgres();
});

/**
 * Assert a write is refused, and report WHY.
 *
 * The whole cause chain, not just the top message: drizzle's own error says
 * "Failed query: …" and the constraint name lives on the `PostgresError` it
 * wraps. A test matching only the outer message would pass against ANY refusal,
 * which is precisely the check that cannot tell a CHECK from a typo.
 */
async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
  throw new Error('expected the statement to be refused, and it was accepted');
}

const FULL_RIGHTS = {
  mayDisplay: true,
  mayStore: true,
  mayCache: true,
  cacheTtlSeconds: 600,
  mayDisplayPrice: true,
  mayDisplayMedia: true,
  mayLinkOut: true,
  mayAppendAffiliateParams: true,
  mayIndex: true,
  mayRefreshAutomatically: true,
  extractionMode: 'disallowed' as const,
  attributionRequired: true,
};

/** A configured source with a published policy, brought up the supported way. */
async function bringUpSource(label: string): Promise<string> {
  const resolved = await configureIngestionSource({
    name: `Writes source ${label} ${RUN}`,
    kind: 'feed',
    provider: `writes-${label}-${RUN}`.toLowerCase().slice(0, 64),
    freshnessTtlSeconds: 3_600,
  });
  const sourceId = resolved.source.config.sourceId;
  createdSourceIds.push(sourceId);
  await publishIngestionSourcePolicy({
    sourceId,
    reviewedByOxyUserId: OPERATOR,
    ...FULL_RIGHTS,
  });
  return sourceId;
}

/** Open a `running` run so counter writes have something to land on. */
async function openRunningRun(sourceId: string): Promise<string> {
  const [row] = await db
    .insert(catalogSourceRuns)
    .values({
      sourceId,
      kind: 'manual',
      refreshMode: 'full_snapshot',
      status: 'running',
      startedAt: new Date(),
      availableAt: new Date(),
      leaseOwner: `writes-${RUN}`,
      leaseUntil: new Date(Date.now() + 120_000),
      requestedByOxyUserId: OPERATOR,
    })
    .returning({ id: catalogSourceRuns.id });
  if (!row) throw new Error('run insert returned no row');
  return row.id;
}

describe('the run row cannot lie about what it did', () => {
  it('refuses counters that do not ADD UP to what was fetched', async () => {
    const sourceId = await bringUpSource('vacuity');
    const message = await rejectionMessage(() =>
      db.insert(catalogSourceRuns).values({
        sourceId,
        kind: 'manual',
        refreshMode: 'full_snapshot',
        status: 'running',
        startedAt: new Date(),
        availableAt: new Date(),
        requestedByOxyUserId: OPERATOR,
        // Ten thousand records fetched and none of them classified: the exact
        // shape of a broken traversal reporting success.
        fetched: 10_000,
      }),
    );
    expect(message).toMatch(/intake_total_check/u);
  });

  it('accepts counters that add up, including a run that fetched nothing', async () => {
    const sourceId = await bringUpSource('vacuity-ok');
    const [row] = await db
      .insert(catalogSourceRuns)
      .values({
        sourceId,
        kind: 'manual',
        refreshMode: 'full_snapshot',
        status: 'running',
        startedAt: new Date(),
        availableAt: new Date(),
        requestedByOxyUserId: OPERATOR,
        fetched: 3,
        stored: 1,
        unchanged: 1,
        rejected: 1,
      })
      .returning({ id: catalogSourceRuns.id });
    expect(row?.id).toBeDefined();
  });

  it('refuses a retirement on any outcome but a COMPLETE success', async () => {
    const sourceId = await bringUpSource('retirement');
    // The rule that costs money: a refresh that failed authentication must not
    // be able to store a retirement count at all.
    for (const outcome of ['auth_failure', 'partial_feed', 'rate_limit'] as const) {
      const message = await rejectionMessage(() =>
        db.insert(catalogSourceRuns).values({
          sourceId,
          kind: 'manual',
          refreshMode: 'full_snapshot',
          status: 'completed',
          outcome,
          enumerationComplete: true,
          startedAt: new Date(),
          finishedAt: new Date(),
          availableAt: new Date(),
          requestedByOxyUserId: OPERATOR,
          offersRetired: 5,
        }),
      );
      expect(message, `'${outcome}' was allowed to retire`).toMatch(/retirement_check/u);
    }

    // And an INCOMPLETE enumeration is refused even on the retiring outcome —
    // both conjuncts are load-bearing, which a single-axis fixture could not
    // tell apart.
    expect(
      await rejectionMessage(() =>
        db.insert(catalogSourceRuns).values({
          sourceId,
          kind: 'manual',
          refreshMode: 'full_snapshot',
          status: 'completed',
          outcome: 'full_feed_success',
          enumerationComplete: false,
          startedAt: new Date(),
          finishedAt: new Date(),
          availableAt: new Date(),
          requestedByOxyUserId: OPERATOR,
          offersRetired: 5,
        }),
      ),
    ).toMatch(/retirement_check/u);
  });

  it('refuses a counter that goes DOWN', async () => {
    const sourceId = await bringUpSource('monotonic');
    const runId = await openRunningRun(sourceId);
    await db
      .update(catalogSourceRuns)
      .set({ fetched: 10, stored: 10 })
      .where(eq(catalogSourceRuns.id, runId));

    // A pass is many pages adding to one row, so a lowered total is a re-write
    // hiding a page that failed.
    expect(
      await rejectionMessage(() =>
        db
          .update(catalogSourceRuns)
          .set({ fetched: 4, stored: 4 })
          .where(eq(catalogSourceRuns.id, runId)),
      ),
    ).toMatch(/cannot lower a counter/u);
  });

  it('lets a released run return to `pending` with its start time intact', async () => {
    // The retry path: the cursor and `started_at` survive so the next claim
    // resumes from the page that failed. A biconditional started-shape CHECK
    // would refuse exactly this.
    const sourceId = await bringUpSource('release');
    const runId = await openRunningRun(sourceId);
    const released = await db
      .update(catalogSourceRuns)
      .set({ status: 'pending', leaseOwner: null, leaseUntil: null, lastError: 'rate limited' })
      .where(eq(catalogSourceRuns.id, runId))
      .returning({ startedAt: catalogSourceRuns.startedAt });
    expect(released[0]?.startedAt).not.toBeNull();
  });

  it('allows only ONE open run per source', async () => {
    const sourceId = await bringUpSource('openrun');
    await openRunningRun(sourceId);
    const message = await rejectionMessage(() => openRunningRun(sourceId));
    expect(message).toMatch(/catalog_source_runs_open_key/u);
  });
});

describe('an older observation can never overwrite a newer current fact', () => {
  it('refuses a backwards UPDATE at the row, not merely in the upsert', async () => {
    const sourceId = await bringUpSource('monotone-object');
    const newer = new Date('2026-08-09T12:00:00.000Z');
    const older = new Date('2026-08-09T06:00:00.000Z');

    const [record] = await db
      .insert(sourceRecords)
      .values({
        sourceId,
        externalType: 'offer',
        externalId: `mono-${RUN}`,
        observedAt: newer,
        contentHash: 'a'.repeat(64),
      })
      .returning({ id: sourceRecords.id });
    if (!record) throw new Error('source record insert returned no row');

    const upserted = await upsertSourceObject(db, {
      sourceId,
      externalType: 'offer',
      externalId: `mono-${RUN}`,
      sourceRecordId: record.id,
      contentHash: 'a'.repeat(64),
      observedAt: newer,
      sourceUpdatedAt: newer,
      staleAt: new Date(newer.getTime() + 3_600_000),
      price: null,
      now: newer,
    });
    expect(upserted.outcome).toBe('inserted');

    // The trigger, reached by a hand-written UPDATE the upsert never issues —
    // which is the path a three-in-the-morning repair takes.
    expect(
      await rejectionMessage(() =>
        db
          .update(catalogSourceObjects)
          .set({ currentObservedAt: older })
          .where(eq(catalogSourceObjects.id, upserted.row?.id ?? '__none__')),
      ),
    ).toMatch(/backwards/u);

    // And `first_observed_at` cannot move at all.
    expect(
      await rejectionMessage(() =>
        db
          .update(catalogSourceObjects)
          .set({ firstObservedAt: older })
          .where(eq(catalogSourceObjects.id, upserted.row?.id ?? '__none__')),
      ),
    ).toMatch(/first_observed_at/u);
  });

  it('converges an out-of-order delivery to a no-op through the upsert', async () => {
    const sourceId = await bringUpSource('converge-object');
    const newer = new Date('2026-08-09T12:00:00.000Z');
    const older = new Date('2026-08-09T06:00:00.000Z');
    const externalId = `conv-${RUN}`;

    const insertObservation = async (hash: string, at: Date): Promise<string> => {
      const [row] = await db
        .insert(sourceRecords)
        .values({
          sourceId,
          externalType: 'offer',
          externalId,
          observedAt: at,
          contentHash: hash,
        })
        .returning({ id: sourceRecords.id });
      if (!row) throw new Error('source record insert returned no row');
      return row.id;
    };

    const newRecord = await insertObservation('b'.repeat(64), newer);
    await upsertSourceObject(db, {
      sourceId,
      externalType: 'offer',
      externalId,
      sourceRecordId: newRecord,
      contentHash: 'b'.repeat(64),
      observedAt: newer,
      sourceUpdatedAt: newer,
      staleAt: new Date(newer.getTime() + 3_600_000),
      price: { amount: 2_000, currency: 'EUR' },
      now: newer,
    });

    const oldRecord = await insertObservation('c'.repeat(64), older);
    const stale = await upsertSourceObject(db, {
      sourceId,
      externalType: 'offer',
      externalId,
      sourceRecordId: oldRecord,
      contentHash: 'c'.repeat(64),
      observedAt: older,
      sourceUpdatedAt: older,
      staleAt: new Date(older.getTime() + 3_600_000),
      price: { amount: 100, currency: 'EUR' },
      now: older,
    });
    // A legitimate replay is QUIET: the empty RETURNING set IS the answer, and
    // there is no read-then-write window for a concurrent delivery to land in.
    expect(stale.outcome).toBe('stale');

    const [row] = await db
      .select()
      .from(catalogSourceObjects)
      .where(eq(catalogSourceObjects.sourceId, sourceId));
    expect(row?.lastPriceAmount).toBe(2_000);
    expect(row?.currentSourceRecordId).toBe(newRecord);
  });
});

describe('rights are versioned, frozen, and can never disagree with the registry', () => {
  it('freezes an ACTIVE policy version and refuses to delete it', async () => {
    const sourceId = await bringUpSource('frozen');
    const [policy] = await db
      .select()
      .from(catalogSourcePolicies)
      .where(eq(catalogSourcePolicies.sourceId, sourceId));
    expect(policy?.status).toBe('active');

    expect(
      await rejectionMessage(() =>
        db
          .update(catalogSourcePolicies)
          .set({ mayDisplayPrice: false })
          .where(eq(catalogSourcePolicies.id, policy?.id ?? '__none__')),
      ),
    ).toMatch(/frozen/u);

    expect(
      await rejectionMessage(() =>
        db.delete(catalogSourcePolicies).where(eq(catalogSourcePolicies.id, policy?.id ?? '__none__')),
      ),
    ).toMatch(/cannot be deleted/u);
  });

  it('keeps the SUPERSEDED version whole when a right is withdrawn', async () => {
    const sourceId = await bringUpSource('withdraw');
    await publishIngestionSourcePolicy({
      sourceId,
      reviewedByOxyUserId: OPERATOR,
      mayDisplay: false,
      mayStore: false,
      mayCache: false,
      mayDisplayPrice: false,
      mayDisplayMedia: false,
      mayLinkOut: false,
      mayAppendAffiliateParams: false,
      mayIndex: false,
      mayRefreshAutomatically: false,
      extractionMode: 'disallowed',
      attributionRequired: true,
      reviewNote: 'withdrawn',
    });

    const policies = await db
      .select()
      .from(catalogSourcePolicies)
      .where(eq(catalogSourcePolicies.sourceId, sourceId));
    expect(policies).toHaveLength(2);
    const v1 = policies.find((row) => row.version === 1);
    const v2 = policies.find((row) => row.version === 2);
    // Issue acceptance 6: display and refresh are off, and NOTHING that
    // recorded them being granted was deleted.
    expect(v1?.status).toBe('superseded');
    expect(v1?.mayDisplayPrice).toBe(true);
    expect(v1?.reviewedByOxyUserId).toBe(OPERATOR);
    expect(v2?.status).toBe('active');
    expect(v2?.supersedesVersion).toBe(1);
  });

  it('drives every (status × policy) combination through BOTH spellings of the rule', async () => {
    const sourceId = await bringUpSource('matrix');

    for (const status of CATALOG_SOURCE_STATUSES) {
      if (status === 'draft') {
        // `changeIngestionSourceStatus` has no path back to draft — configuring
        // and activating are different acts and nothing un-activates. The
        // initial state already covered it.
        continue;
      }
      await changeIngestionSourceStatus({
        sourceId,
        status: status as CatalogSourceStatus,
        actorOxyUserId: OPERATOR,
        reason: `matrix ${status}`,
      });

      const resolved = await resolveIngestionSource(sourceId);
      expect(resolved, `source vanished at status ${status}`).toBeDefined();
      const policy =
        resolved?.policy === undefined
          ? null
          : {
              mayDisplay: resolved.policy.mayDisplay,
              mayStore: resolved.policy.mayStore,
              mayCache: resolved.policy.mayCache,
              cacheTtlSeconds: resolved.policy.cacheTtlSeconds,
              mayDisplayPrice: resolved.policy.mayDisplayPrice,
              mayDisplayMedia: resolved.policy.mayDisplayMedia,
              mayLinkOut: resolved.policy.mayLinkOut,
              mayAppendAffiliateParams: resolved.policy.mayAppendAffiliateParams,
              mayIndex: resolved.policy.mayIndex,
              mayRefreshAutomatically: resolved.policy.mayRefreshAutomatically,
              extractionMode: resolved.policy.extractionMode,
              attributionRequired: resolved.policy.attributionRequired,
            };

      const expected = projectedSourceRights(status as CatalogSourceStatus, policy);
      const [registry] = await db
        .select()
        .from(catalogSources)
        .where(eq(catalogSources.id, sourceId));

      // The commit already had to satisfy the trigger; this asserts the two
      // spellings agree on the VALUE as well as on the fact of agreeing.
      expect(
        {
          mayDisplay: registry?.mayDisplay,
          mayStore: registry?.mayStore,
          attributionRequired: registry?.attributionRequired,
        },
        `the registry disagrees with the derivation at status ${status}`,
      ).toEqual(expected);

      // And the fine-grained verdict is a function of the same two inputs.
      expect(resolveSourceRights(status as CatalogSourceStatus, policy)).toEqual(resolved?.rights);
    }
  });

  it('refuses a COMMIT that leaves the registry advertising rights the policy withdrew', async () => {
    const sourceId = await bringUpSource('disagree');
    // ACTIVE first: a `draft` source projects all-false already, so writing
    // `may_display = false` onto one would AGREE and prove nothing. The fixture
    // has to sit on the side of the distinction the trigger exists to make.
    await changeIngestionSourceStatus({
      sourceId,
      status: 'active',
      actorOxyUserId: OPERATOR,
      reason: 'matrix',
    });
    // The trigger is DEFERRED, so this is refused at COMMIT rather than at the
    // statement — which is exactly what lets the service reorder its writes
    // freely and still be held to the outcome.
    const message = await rejectionMessage(() =>
      db.transaction(async (tx) => {
        await tx
          .update(catalogSources)
          .set({ mayDisplay: false })
          .where(eq(catalogSources.id, sourceId));
      }),
    );
    expect(message).toMatch(/disagree with its policy/u);
  });

  it('leaves a provenance-only source (operator, backfill) entirely alone', async () => {
    // A registry row with no ingestion config states its own coarse rights and
    // nothing derives them — which is what keeps #60's backfill source and the
    // operator source working unchanged.
    const source = await ensureCatalogSource(db, {
      kind: 'operator',
      name: `Operator source ${RUN}`,
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
    });
    createdSourceIds.push(source.id);
    expect(source.mayDisplay).toBe(true);

    const updated = await db
      .update(catalogSources)
      .set({ mayDisplay: false, attributionRequired: true })
      .where(eq(catalogSources.id, source.id))
      .returning({ mayDisplay: catalogSources.mayDisplay });
    expect(updated[0]?.mayDisplay).toBe(false);
  });

  it('refuses to activate a source before anybody has reviewed its terms', async () => {
    const resolved = await configureIngestionSource({
      name: `Unreviewed source ${RUN}`,
      kind: 'feed',
      provider: `unreviewed-${RUN}`.toLowerCase().slice(0, 64),
    });
    createdSourceIds.push(resolved.source.config.sourceId);

    // "Controlled extraction must have an explicit policy/terms review before
    // activation", generalised: a right nobody reviewed is a right nobody
    // granted.
    const message = await rejectionMessage(() =>
      changeIngestionSourceStatus({
        sourceId: resolved.source.config.sourceId,
        status: 'active',
        actorOxyUserId: OPERATOR,
        reason: 'too soon',
      }),
    );
    expect(message).toMatch(/policy version is published/u);
  });
});

describe('the config refuses a credential where a locator belongs', () => {
  it('rejects a pasted secret and accepts the three locator schemes', async () => {
    const sourceId = await bringUpSource('credential');

    /**
     * Three shapes, and the third is the one that matters.
     *
     * A bare opaque token has no scheme at all; a long one additionally fails
     * the length bound. The `bearer:` case is the sharper fixture: it HAS a
     * `<word>:<value>` shape, so it distinguishes a CLOSED scheme set from a
     * check that merely demanded a colon — and a suite whose refusals were all
     * scheme-less could not tell those two readings apart
     * (`~/Oxy/AGENTS.md`, the fixture rule).
     *
     * The values are deliberately NOT provider-shaped. A realistic-looking key
     * in a fixture is one `git push` away from a secret-scanning block, and it
     * buys nothing: the CHECK never looks at what a secret is, only at what a
     * locator is.
     */
    for (const pasted of [
      'not-a-locator-at-all',
      `opaque-${'x'.repeat(200)}`,
      'bearer:some-opaque-value',
    ]) {
      const message = await rejectionMessage(() =>
        db
          .update(catalogSourceConfigs)
          .set({ credentialRef: pasted })
          .where(eq(catalogSourceConfigs.sourceId, sourceId)),
      );
      expect(message, `'${pasted.slice(0, 24)}…' was accepted`).toMatch(
        /credential_ref_shape_check/u,
      );
    }

    for (const locator of ['connection:abc-123', 'env:MERCARIA_FEED_TOKEN', 'ssm:/oxy/mercaria/x']) {
      const updated = await db
        .update(catalogSourceConfigs)
        .set({ credentialRef: locator })
        .where(eq(catalogSourceConfigs.sourceId, sourceId))
        .returning({ credentialRef: catalogSourceConfigs.credentialRef });
      expect(updated[0]?.credentialRef).toBe(locator);
    }
  });
});
