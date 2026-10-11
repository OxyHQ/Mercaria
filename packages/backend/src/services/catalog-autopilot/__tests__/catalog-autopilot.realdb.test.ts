/**
 * ADR 0015: the catalogue autopilot converges the declared sources and the
 * baseline matching policy against a real server.
 *
 * Every source and merchant here carries this file's run id, so the shared
 * database's other sources are never read or written. The baseline policy is
 * the global one-active row, so the file holds the active-policy slot.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { withTriggerToggleLock } from '../../../db/__tests__/trigger-toggle-lock.js';
import { findActiveMatchPolicyVersion } from '../../../db/matching/matchPolicyRepository.js';
import { catalogSourceConfigs, catalogSourcePolicies } from '../../../db/schema/ingestion.js';
import { matchPolicyVersions } from '../../../db/schema/matching.js';
import { merchants } from '../../../db/schema/merchants.js';
import { catalogSources } from '../../../db/schema/provenance.js';
import {
  changeIngestionSourceStatus,
  publishIngestionSourcePolicy,
} from '../../ingestion/source.service.js';
import {
  acquireActivePolicySlot,
  type ActivePolicySlot,
} from '../../ingestion/__tests__/active-policy-slot.js';
import {
  DECLARED_OPEN_DATA_SOURCES,
  type DeclaredOpenDataSource,
} from '../../open-data/sources.js';
import { CATALOG_AUTOPILOT_ACTOR } from '../actor.js';
import { BASELINE_MATCH_POLICY_KEY, ensureActiveMatchPolicy } from '../match-policy.js';
import { reconcileDeclaredSources } from '../sources.js';

/** The active-policy slot can wait behind a sibling file; see `active-policy-slot.ts`. */
const POLICY_CASE_TIMEOUT_MS = 90_000;

const RUN = uuidv7().slice(-12);

let db: Database;
let policySlot: ActivePolicySlot | undefined;

/** One real catalogue declaration and one real chain, renamed into this file's namespace. */
function declarations(): DeclaredOpenDataSource[] {
  const catalogue = DECLARED_OPEN_DATA_SOURCES.find(
    (source) => source.provider === 'open_food_facts',
  );
  const chain = DECLARED_OPEN_DATA_SOURCES.find((source) => source.accountRef === 'mercadona');
  if (catalogue === undefined || chain === undefined || chain.merchant === null) {
    throw new Error('the declarations this test copies are missing');
  }
  return [
    { ...catalogue, name: `${catalogue.name} ${RUN}` },
    {
      ...chain,
      name: `${chain.name} ${RUN}`,
      merchant: { slug: `${chain.merchant.slug}-${RUN}`, name: `${chain.merchant.name} ${RUN}` },
    },
  ];
}

async function sourceIdsOfRun(): Promise<string[]> {
  const rows = await db
    .select({ id: catalogSources.id })
    .from(catalogSources)
    .where(sql`${catalogSources.name} like ${`% ${RUN}`}`);
  return rows.map((row) => row.id);
}

async function policiesOf(sourceId: string) {
  return db
    .select()
    .from(catalogSourcePolicies)
    .where(eq(catalogSourcePolicies.sourceId, sourceId));
}

async function configOf(sourceId: string) {
  const [config] = await db
    .select()
    .from(catalogSourceConfigs)
    .where(eq(catalogSourceConfigs.sourceId, sourceId));
  return config;
}

async function deleteBaselinePolicy(): Promise<void> {
  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(
      sql`alter table match_policy_versions disable trigger match_policy_versions_immutable`,
    );
    await tx
      .delete(matchPolicyVersions)
      .where(eq(matchPolicyVersions.versionKey, BASELINE_MATCH_POLICY_KEY));
    await tx.execute(
      sql`alter table match_policy_versions enable trigger match_policy_versions_immutable`,
    );
  });
}

beforeAll(async () => {
  db = await connectPostgres();
  policySlot = await acquireActivePolicySlot(db);
  // A baseline row left behind by an interrupted run of this file.
  await deleteBaselinePolicy();
}, POLICY_CASE_TIMEOUT_MS);

afterAll(async () => {
  try {
    const sourceIds = await sourceIdsOfRun();
    const safe = sourceIds.length === 0 ? ['00000000-0000-0000-0000-000000000000'] : sourceIds;
    await db.delete(catalogSourceConfigs).where(inArray(catalogSourceConfigs.sourceId, safe));
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table catalog_source_policies disable trigger catalog_source_policies_immutable`,
      );
      await tx.delete(catalogSourcePolicies).where(inArray(catalogSourcePolicies.sourceId, safe));
      await tx.execute(
        sql`alter table catalog_source_policies enable trigger catalog_source_policies_immutable`,
      );
    });
    await db.delete(catalogSources).where(inArray(catalogSources.id, safe));
    await db.delete(merchants).where(sql`${merchants.slug} like ${`%-${RUN}`}`);
    await deleteBaselinePolicy();
  } finally {
    try {
      await policySlot?.release();
    } finally {
      await closePostgres();
    }
  }
}, POLICY_CASE_TIMEOUT_MS);

describe('the baseline matching policy', () => {
  it('is published when no policy is active, once', async () => {
    expect(await findActiveMatchPolicyVersion(db)).toBeUndefined();
    expect(await ensureActiveMatchPolicy()).toBe(true);
    const active = await findActiveMatchPolicyVersion(db);
    expect(active?.versionKey).toBe(BASELINE_MATCH_POLICY_KEY);
    expect(active?.createdByOxyUserId).toBe(CATALOG_AUTOPILOT_ACTOR);
    expect(active?.semanticEnabled).toBe(false);
    expect(await ensureActiveMatchPolicy()).toBe(false);
    const rows = await db
      .select()
      .from(matchPolicyVersions)
      .where(eq(matchPolicyVersions.versionKey, BASELINE_MATCH_POLICY_KEY));
    expect(rows).toHaveLength(1);
  });
});

describe('reconciling the declared sources', () => {
  it('creates the merchant, configures, publishes the declared policy and activates', async () => {
    const results = await reconcileDeclaredSources(declarations());
    expect(results.map((result) => result.error)).toEqual([null, null]);
    expect(results.every((result) => result.activated && result.policyPublished)).toBe(true);

    const [catalogue, chain] = declarations();
    const [catalogueResult, chainResult] = results;
    const catalogueConfig = await configOf(catalogueResult?.sourceId ?? '');
    expect(catalogueConfig?.status).toBe('active');
    expect(catalogueConfig?.merchantId).toBeNull();
    expect(catalogueConfig?.provider).toBe('open_food_facts');

    const chainConfig = await configOf(chainResult?.sourceId ?? '');
    expect(chainConfig?.status).toBe('active');
    expect(chainConfig?.sourceAccountRef).toBe('mercadona');
    expect(chainConfig?.territories).toEqual(['ES']);
    const [merchant] = await db
      .select()
      .from(merchants)
      .where(eq(merchants.slug, chain?.merchant?.slug ?? ''));
    expect(merchant?.id).toBe(chainConfig?.merchantId);
    expect(merchant?.merchantType).toBe('retailer');

    const [cataloguePolicy] = await policiesOf(catalogueResult?.sourceId ?? '');
    expect(cataloguePolicy?.maySeedCatalog).toBe(catalogue?.rights.maySeedCatalog);
    expect(cataloguePolicy?.reviewedByOxyUserId).toBe(CATALOG_AUTOPILOT_ACTOR);
    const [chainPolicy] = await policiesOf(chainResult?.sourceId ?? '');
    expect(chainPolicy?.mayDisplayPrice).toBe(true);
    expect(chainPolicy?.mayLinkOut).toBe(false);
  });

  it('is idempotent: a second pass publishes and activates nothing', async () => {
    const results = await reconcileDeclaredSources(declarations());
    expect(
      results.map((result) => [result.error, result.policyPublished, result.activated]),
    ).toEqual([
      [null, false, false],
      [null, false, false],
    ]);
    for (const result of results) expect(await policiesOf(result.sourceId ?? '')).toHaveLength(1);
    const merchantRows = await db
      .select()
      .from(merchants)
      .where(sql`${merchants.slug} like ${`%-${RUN}`}`);
    expect(merchantRows).toHaveLength(1);
  });

  it("leaves a source an operator paused paused, and an operator's policy in force", async () => {
    const [first] = await reconcileDeclaredSources(declarations());
    const sourceId = first?.sourceId ?? '';
    await changeIngestionSourceStatus({
      sourceId,
      status: 'paused',
      actorOxyUserId: `operator-${RUN}`,
      reason: 'incident',
    });
    const declared = declarations()[0];
    if (declared === undefined) throw new Error('no declaration');
    await publishIngestionSourcePolicy({
      sourceId,
      reviewedByOxyUserId: `operator-${RUN}`,
      ...declared.rights,
      mayIndex: false,
    });

    const [again] = await reconcileDeclaredSources(declarations());
    expect(again?.activated).toBe(false);
    expect(again?.policyPublished).toBe(false);
    expect((await configOf(sourceId))?.status).toBe('paused');
    const active = (await policiesOf(sourceId)).filter((policy) => policy.status === 'active');
    expect(active.map((policy) => policy.reviewedByOxyUserId)).toEqual([`operator-${RUN}`]);
  });

  it('publishes a robots-respecting extraction policy for a Shopify store, and activates it', async () => {
    const store = DECLARED_OPEN_DATA_SOURCES.find(
      (source) => source.provider === 'shopify_storefront',
    );
    if (store === undefined || store.merchant === null) throw new Error('no Shopify declaration');
    const [result] = await reconcileDeclaredSources([
      {
        ...store,
        name: `${store.name} ${RUN}`,
        merchant: { slug: `${store.merchant.slug}-${RUN}`, name: store.merchant.name },
      },
    ]);
    expect(result?.error).toBeNull();
    const [policy] = await policiesOf(result?.sourceId ?? '');
    expect(policy?.extractionMode).toBe('robots_respecting');
    expect(policy?.extractionMaxRequestsPerDay).toBe(store.rights.extractionMaxRequestsPerDay);
    expect(policy?.maySeedCatalog).toBe(true);
    expect((await configOf(result?.sourceId ?? ''))?.status).toBe('active');
  });

  it('republishes its own policy when the declaration changes', async () => {
    const [, chain] = declarations();
    if (chain === undefined) throw new Error('no declaration');
    const changed = {
      ...chain,
      rights: { ...chain.rights, cacheTtlSeconds: chain.rights.cacheTtlSeconds + 60 },
    };
    const [result] = await reconcileDeclaredSources([changed]);
    expect(result?.policyPublished).toBe(true);
    const policies = await policiesOf(result?.sourceId ?? '');
    expect(policies).toHaveLength(2);
    const active = policies.filter((policy) => policy.status === 'active');
    expect(active.map((policy) => policy.cacheTtlSeconds)).toEqual([
      changed.rights.cacheTtlSeconds,
    ]);
    const superseded = policies.filter((policy) => policy.status !== 'active');
    expect(
      superseded.every((policy) => policy.reviewedByOxyUserId === CATALOG_AUTOPILOT_ACTOR),
    ).toBe(true);
  });
});
