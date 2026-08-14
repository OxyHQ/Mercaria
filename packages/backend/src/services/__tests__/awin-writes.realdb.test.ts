/**
 * The Awin source's CONSTRAINTS and its two acceptance criteria, against a real
 * PostgreSQL server (#66).
 *
 * `awin-feed-contract.test.ts` drives #62's thirteen cases through the adapter.
 * This file goes at the layer underneath — the CHECKs, the triggers and the
 * uniques that hold when the service is wrong, when a replay arrives and when
 * somebody writes SQL by hand during an incident — and then above it, at the two
 * things the issue asks be demonstrated end to end:
 *
 * - **acceptance 1**: at least TWO approved advertisers ingest through the
 *   shared pipeline, as distinct merchants and distinct storefronts;
 * - **acceptance 2**: a product an Awin advertiser shares with ANOTHER source
 *   converges on the same canonical entities where the evidence supports it.
 *
 * Criterion 2 deliberately does not wait for #65. Convergence is a property of
 * #58's identifier stage, so it is exercised with one Awin advertiser feed and a
 * second, non-Awin source publishing the same GTIN — which is what "where
 * evidence supports it" means and is testable today. Waiting for the eBay
 * adapter would have made the criterion untested for however long that takes.
 *
 * None of this exists under a mock: a mocked `insert` accepts a statement the
 * server rejects outright, so every constraint below would look green and ship
 * broken.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { AWIN_FEED_COLUMNS, AWIN_MAPPING_VERSION } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { acquireActivePolicySlot, type ActivePolicySlot } from '../ingestion/__tests__/active-policy-slot.js';
import { insertMatchPolicyVersion } from '../../db/matching/matchPolicyRepository.js';
import { matchDecisions, matchPolicyVersions } from '../../db/schema/matching.js';
import {
  canonicalProducts,
  canonicalProductSourceLinks,
  canonicalVariants,
  canonicalVariantSourceLinks,
  productIdentifiers,
} from '../../db/schema/canonicalCatalog.js';
import { merchants, storefronts } from '../../db/schema/merchants.js';
import { offers } from '../../db/schema/offers.js';
import { catalogSources, sourceRecords } from '../../db/schema/provenance.js';
import {
  catalogSourceConfigs,
  catalogSourceObjects,
  catalogSourcePolicies,
  catalogSourceRejections,
  catalogSourceRuns,
} from '../../db/schema/ingestion.js';
import {
  catalogSourceDistributions,
  catalogSourceRunQuarantines,
} from '../../db/schema/offerFreshness.js';
import {
  awinAccounts,
  awinAdvertiserQuality,
  awinAdvertisers,
  awinFeeds,
  awinLinkSamples,
  awinNetworkLeases,
} from '../../db/schema/awin.js';
import { openSourceRun } from '../../db/ingestion/catalogSourceRunRepository.js';
import { runIngestionPage } from '../ingestion/ingest.service.js';
import {
  registerCatalogSourceAdapter,
  unregisterCatalogSourceAdapter,
} from '../ingestion/registry.js';
import {
  changeIngestionSourceStatus,
  publishIngestionSourcePolicy,
} from '../ingestion/source.service.js';
import type { AdapterFetchPage, CatalogSourceAdapter } from '../ingestion/adapter.js';
import { AWIN_FEED_PROVIDER, createAwinFeedAdapter, stageAwinFeed } from '../ingestion/adapters/awin-feed.js';
import { buildAwinMapping } from '../awin/mapping.js';
import { awinMappingFor, resolveAwinFeed } from '../awin/resolve.js';
import { upsertAwinAccount } from '../../db/awin/awinAccountRepository.js';
import {
  changeAwinActivation,
  discoverAwinAdvertiser,
} from '../../db/awin/awinAdvertiserRepository.js';
import { discoverAwinFeed } from '../../db/awin/awinFeedRepository.js';
import { recordAwinLinkSample } from '../../db/awin/awinLinkSampleRepository.js';
import { recordAwinQuality } from '../../db/awin/awinQualityRepository.js';
import {
  claimAwinNetworkLease,
  releaseAwinNetworkLease,
} from '../../db/awin/awinNetworkLeaseRepository.js';
import { registerAwinAdvertiserSource } from '../awin/source-binding.service.js';
import { changeAwinAdvertiserActivation, recordAwinSample } from '../awin/activation.service.js';
import { deleteTestCanonicalRows } from '../../db/__tests__/canonical-teardown.js';

let db: Database;
let policySlot: ActivePolicySlot | undefined;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);
const OPERATOR = `awin-operator-${RUN}`;

const createdAccountIds: string[] = [];
const createdAdvertiserIds: string[] = [];
const createdSourceIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdStorefrontIds: string[] = [];
const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];
const createdPolicyIds: string[] = [];
const registeredProviders: string[] = [];

function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

/** A GS1 check digit, so a fixture GTIN really validates. */
function gs1CheckDigit(payload: string): number {
  let sum = 0;
  for (let index = 0; index < payload.length; index += 1) {
    const digit = Number(payload[payload.length - 1 - index]);
    sum += index % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * A run-scoped EAN-13.
 *
 * A canonical identifier has exactly ONE active owner, so a hard-coded fixture
 * GTIN becomes a shared resource the moment a second realdb file exists — the
 * lesson `adapter-contract-suite.ts` records after #63 became the third
 * claimant of the global policy slot.
 */
function ean13(seed: string): string {
  let hash = 0;
  for (const character of `${RUN}${seed}`) hash = (hash * 31 + character.charCodeAt(0)) % 1_000_000;
  const twelve = `62${String(hash).padStart(10, '0')}`.slice(0, 12);
  return `${twelve}${String(gs1CheckDigit(twelve))}`;
}

beforeAll(async () => {
  db = await connectPostgres();
  // Held for the WHOLE file: one active matching policy exists in the entire
  // database, so the files that need one take turns rather than racing.
  policySlot = await acquireActivePolicySlot(db);
}, 120_000);

afterAll(async () => {
  /**
   * The whole teardown, inside the region that closes the pool (#272).
   *
   * The release was already nested. What was NOT protected was everything
   * above it: a `23503` anywhere in the deletes below — a measured failure
   * mode in this suite (#270) — aborts the hook before the release and before
   * `closePostgres()`, which is the only thing that ends a session-level
   * advisory lock. The slot then stays held on a socket vitest reuses for the
   * next file in the worker, and every other claimant blocks its full
   * `beforeAll` budget on a file that did nothing wrong.
   *
   * `slot-teardown-census.test.ts` requires this `try` to be the hook's FIRST
   * statement, so the protected region cannot silently shrink again.
   */
  try {
    for (const provider of registeredProviders) unregisterCatalogSourceAdapter(provider);

    // Children first, and #66's tables before the sources they point at: every
    // intra-graph key is RESTRICT and the rights trigger is DEFERRED, so a
    // half-torn-down source raises at commit.
    await db.execute(
      sql`alter table awin_advertiser_quality disable trigger awin_advertiser_quality_append_only`,
    );
    await db.execute(sql`alter table awin_link_samples disable trigger awin_link_samples_append_only`);
    await db.execute(sql`alter table awin_advertisers disable trigger awin_advertisers_identity_frozen`);
    await db
      .delete(awinAdvertiserQuality)
      .where(inArray(awinAdvertiserQuality.advertiserRowId, safeIds(createdAdvertiserIds)));
    // The advertiser's pointer at its sample goes first: it has no foreign key
    // (see `ID_COLUMNS_WITHOUT_FOREIGN_KEY`) but the CHECK still demands one
    // whenever the activation is `active`, so the activation is stood down first.
    await db
      .update(awinAdvertisers)
      .set({ activation: 'candidate', activatingSampleId: null })
      .where(inArray(awinAdvertisers.id, safeIds(createdAdvertiserIds)));
    await db
      .delete(awinLinkSamples)
      .where(inArray(awinLinkSamples.advertiserRowId, safeIds(createdAdvertiserIds)));
    await db
      .delete(awinFeeds)
      .where(inArray(awinFeeds.advertiserRowId, safeIds(createdAdvertiserIds)));
    await db.execute(
      sql`alter table awin_advertiser_quality enable trigger awin_advertiser_quality_append_only`,
    );
    await db.execute(sql`alter table awin_link_samples enable trigger awin_link_samples_append_only`);

    await db
      .delete(catalogSourceObjects)
      .where(inArray(catalogSourceObjects.sourceId, safeIds(createdSourceIds)));
    await db.delete(offers).where(inArray(offers.canonicalVariantId, safeIds(createdVariantIds)));
    await db
      .delete(catalogSourceRejections)
      .where(inArray(catalogSourceRejections.sourceId, safeIds(createdSourceIds)));
    await db
      .delete(catalogSourceRuns)
      .where(inArray(catalogSourceRuns.sourceId, safeIds(createdSourceIds)));
    await db
      .delete(canonicalVariantSourceLinks)
      .where(inArray(canonicalVariantSourceLinks.variantId, safeIds(createdVariantIds)));
    await db
      .delete(canonicalProductSourceLinks)
      .where(inArray(canonicalProductSourceLinks.productId, safeIds(createdProductIds)));
    await db
      .delete(catalogSourceRunQuarantines)
      .where(inArray(catalogSourceRunQuarantines.sourceId, safeIds(createdSourceIds)));
    await db
      .delete(catalogSourceDistributions)
      .where(inArray(catalogSourceDistributions.sourceId, safeIds(createdSourceIds)));

    const ownRecordIds = (
      await db
        .select({ id: sourceRecords.id })
        .from(sourceRecords)
        .where(inArray(sourceRecords.sourceId, safeIds(createdSourceIds)))
    ).map((row) => row.id);
    await db
      .delete(matchDecisions)
      .where(inArray(matchDecisions.sourceRecordId, safeIds(ownRecordIds)));
    await db
      .delete(sourceRecords)
      .where(inArray(sourceRecords.sourceId, safeIds(createdSourceIds)));

    await db
      .delete(awinAdvertisers)
      .where(inArray(awinAdvertisers.id, safeIds(createdAdvertiserIds)));
    await db.execute(sql`alter table awin_advertisers enable trigger awin_advertisers_identity_frozen`);
    await db
      .delete(awinNetworkLeases)
      .where(inArray(awinNetworkLeases.accountId, safeIds(createdAccountIds)));
    await db.delete(awinAccounts).where(inArray(awinAccounts.id, safeIds(createdAccountIds)));

    await db
      .delete(catalogSourceConfigs)
      .where(inArray(catalogSourceConfigs.sourceId, safeIds(createdSourceIds)));
    // The disable/delete/enable window is taken under a SESSION ADVISORY LOCK:
    // `alter table … disable trigger` is DATABASE-WIDE and every realdb file
    // shares one server, so two files inside this window at once leave one of them
    // deleting against a trigger the other has just re-enabled.
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
    await db
      .delete(productIdentifiers)
      .where(inArray(productIdentifiers.variantId, safeIds(createdVariantIds)));
    await deleteTestCanonicalRows(db, {
      variantIds: createdVariantIds,
      productIds: createdProductIds,
    });
    await db.delete(storefronts).where(inArray(storefronts.id, safeIds(createdStorefrontIds)));
    await db.delete(merchants).where(inArray(merchants.id, safeIds(createdMerchantIds)));

    const stillCited = (
      await db
        .select({ id: matchDecisions.id })
        .from(matchDecisions)
        .where(inArray(matchDecisions.policyVersionId, safeIds(createdPolicyIds)))
        .limit(1)
    ).length;
    if (stillCited === 0) {
      await db.execute(
        sql`alter table match_policy_versions disable trigger match_policy_versions_immutable`,
      );
      await db
        .delete(matchPolicyVersions)
        .where(inArray(matchPolicyVersions.id, safeIds(createdPolicyIds)));
      await db.execute(
        sql`alter table match_policy_versions enable trigger match_policy_versions_immutable`,
      );
    }
    /**
     * NESTED, because `release()` can throw and `closePostgres` is what actually
     * ends the hold — see `active-policy-slot.ts` and #272. A check-in returns
     * the connection to the pool without ending the session, so an unlock that
     * threw here would strand the slot on a socket vitest reuses for the next
     * file in the worker.
     */
  } finally {
    try {
      await policySlot?.release();
    } finally {
      await closePostgres();
    }
  }
}, 120_000);


/**
 * Assert a write is refused, and report WHY.
 *
 * The whole cause chain, not just the top message: drizzle's own error says
 * "Failed query: …" and the constraint name lives on the `PostgresError` it
 * wraps. A test matching only the outer message would pass against ANY
 * refusal — including a typo in a column name — which is precisely the check
 * that cannot tell a CHECK from a mistake. `ingestion-writes.realdb.test.ts`
 * states the same rule for the same reason.
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

/** A publisher account, its advertiser and one feed — the discovery output. */
async function bringUpAdvertiser(label: string): Promise<{
  accountId: string;
  advertiserRowId: string;
  feedRowId: string;
}> {
  const account = await upsertAwinAccount({
    publisherId: `${Math.abs(hashOf(`${RUN}${label}`)) % 1_000_000_000}`,
    label: `Awin publisher ${label} ${RUN}`,
    feedCredentialRef: 'env:AWIN_TEST_KEY',
  });
  if (!createdAccountIds.includes(account.id)) createdAccountIds.push(account.id);

  const advertiser = await discoverAwinAdvertiser({
    accountId: account.id,
    advertiserId: `${Math.abs(hashOf(`${RUN}${label}adv`)) % 1_000_000}`,
    displayName: `Advertiser ${label} ${RUN}`,
    membershipStatus: 'joined',
    primaryRegion: 'ES',
    declaredHost: 'retailer.example',
  });
  createdAdvertiserIds.push(advertiser.id);

  const feed = await discoverAwinFeed({
    advertiserRowId: advertiser.id,
    feedId: `${Math.abs(hashOf(`${RUN}${label}feed`)) % 1_000_000}`,
    feedName: `Feed ${label}`,
    language: 'es',
    currency: 'EUR',
    listedLastImportedAt: new Date('2026-08-09T08:00:00.000Z'),
  });

  return { accountId: account.id, advertiserRowId: advertiser.id, feedRowId: feed.id };
}

function hashOf(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return hash;
}

/** A merchant and a storefront for one advertiser. */
async function mintMerchantAndStorefront(label: string): Promise<{
  merchantId: string;
  storefrontId: string;
}> {
  const [merchant] = await db
    .insert(merchants)
    .values({ name: `Awin merchant ${label} ${RUN}`, slug: `awin-merchant-${label}-${RUN}` })
    .returning({ id: merchants.id });
  if (!merchant) throw new Error('merchant insert returned no row');
  createdMerchantIds.push(merchant.id);

  const [storefront] = await db
    .insert(storefronts)
    .values({
      merchantId: merchant.id,
      name: `Awin storefront ${label} ${RUN}`,
      slug: `awin-storefront-${label}-${RUN}`,
      channelKind: 'web',
    })
    .returning({ id: storefronts.id });
  if (!storefront) throw new Error('storefront insert returned no row');
  createdStorefrontIds.push(storefront.id);

  return { merchantId: merchant.id, storefrontId: storefront.id };
}

const FULL_RIGHTS = {
  mayDisplay: true,
  mayStore: true,
  mayCache: true,
  cacheTtlSeconds: 3_600,
  mayDisplayPrice: true,
  mayDisplayMedia: true,
  mayLinkOut: true,
  mayAppendAffiliateParams: true,
  mayIndex: true,
  mayRefreshAutomatically: true,
  extractionMode: 'disallowed' as const,
  attributionRequired: true,
};

/** The ACTIVE matching policy the pipeline needs to decide anything. */
async function ensureMatchPolicy(): Promise<string> {
  const existing = createdPolicyIds[0];
  if (existing !== undefined) return existing;
  const row = await insertMatchPolicyVersion(db, {
    versionKey: `awin-${RUN}`,
    status: 'active',
    description: 'awin realdb fixture',
    autoMinConfidence: 0.5,
    reviewMinConfidence: 0.2,
    minCandidateSeparation: 0.01,
    maxCandidates: 25,
    minTitleSimilarity: 0.1,
    weightIdentifier: 6,
    weightBrand: 3,
    weightModel: 2,
    weightAttribute: 4,
    weightTitle: 1,
    weightCategory: 2,
    weightSemantic: 0,
    semanticEnabled: false,
    minBenchmarkPrecision: 0.98,
    minBenchmarkSamples: 20,
    createdByOxyUserId: OPERATOR,
    activatedAt: new Date(),
  });
  createdPolicyIds.push(row.id);
  return row.id;
}

describe('the CHECKs and triggers, against a real server', () => {
  it('refuses an ACTIVE advertiser with no sample that authorised it', async () => {
    const { advertiserRowId } = await bringUpAdvertiser('nosample');
    // Issue quality control 4, held by the database rather than by a habit:
    // activation is what puts a tracked link in front of a buyer.
    expect(
      await rejectionMessage(async () =>
        db
          .update(awinAdvertisers)
          .set({
            activation: 'active',
            activationChangedAt: new Date(),
            activationChangedByOxyUserId: OPERATOR,
          })
          .where(eq(awinAdvertisers.id, advertiserRowId)),
      ),
    ).toMatch(/activation_sample_check/u);
  });

  it('refuses a moved activation with no actor', async () => {
    const { advertiserRowId } = await bringUpAdvertiser('noactor');
    expect(
      await rejectionMessage(async () =>
        db
          .update(awinAdvertisers)
          .set({ activation: 'sampling' })
          .where(eq(awinAdvertisers.id, advertiserRowId)),
      ),
    ).toMatch(/activation_attribution_check/u);
  });

  it('freezes an advertiser’s NETWORK identity', async () => {
    const { advertiserRowId } = await bringUpAdvertiser('frozen');
    expect(
      await rejectionMessage(async () =>
        db
          .update(awinAdvertisers)
          .set({ advertiserId: '999999' })
          .where(eq(awinAdvertisers.id, advertiserRowId)),
      ),
    ).toMatch(/frozen/u);
  });

  it('refuses a quality snapshot whose counters do not ADD UP', async () => {
    const { advertiserRowId, feedRowId } = await bringUpAdvertiser('counters');
    // #60's vacuity floor: a page that swallowed a record cannot write the
    // snapshot at all, so "zero rejected over zero scanned" stops being
    // indistinguishable from "zero rejected over fifty thousand".
    expect(
      await rejectionMessage(async () =>
        db.insert(awinAdvertiserQuality).values({
          advertiserRowId,
          feedRowId,
          runId: null,
          measuredAt: new Date(),
          mappingVersion: AWIN_MAPPING_VERSION,
          scanned: 10,
          mapped: 4,
          rejected: 4,
        }),
      ),
    ).toMatch(/totals_check/u);
  });

  it('refuses a coverage count larger than what was mapped', async () => {
    const { advertiserRowId, feedRowId } = await bringUpAdvertiser('coverage');
    expect(
      await rejectionMessage(async () =>
        db.insert(awinAdvertiserQuality).values({
          advertiserRowId,
          feedRowId,
          runId: null,
          measuredAt: new Date(),
          mappingVersion: AWIN_MAPPING_VERSION,
          scanned: 5,
          mapped: 5,
          rejected: 0,
          withGtin: 6,
        }),
      ),
    ).toMatch(/coverage_check/u);
  });

  it('makes a quality snapshot APPEND-ONLY', async () => {
    const { advertiserRowId, feedRowId } = await bringUpAdvertiser('appendquality');
    const row = await recordAwinQuality({
      advertiserRowId,
      feedRowId,
      runId: null,
      mappingVersion: AWIN_MAPPING_VERSION,
      counts: {
        scanned: 3,
        mapped: 3,
        rejected: 0,
        withGtin: 2,
        withMpn: 0,
        withBrand: 1,
        withImage: 3,
        withPrice: 3,
        duplicateExternalIds: 0,
        duplicateGtins: 0,
        rejectedCurrency: 0,
        rejectedPrice: 0,
        contradictoryAvailability: 0,
        trackingApproved: 3,
        trackingRejected: 0,
      },
    });
    expect(
      await rejectionMessage(async () =>
        db
          .update(awinAdvertiserQuality)
          .set({ withGtin: 3 })
          .where(eq(awinAdvertiserQuality.id, row.id)),
      ),
    ).toMatch(/append-only/u);
    expect(
      await rejectionMessage(async () =>
        db.delete(awinAdvertiserQuality).where(eq(awinAdvertiserQuality.id, row.id)),
      ),
    ).toMatch(/append-only/u);
  });

  it('makes a sample APPEND-ONLY, and refuses a passed one carrying findings', async () => {
    const { advertiserRowId, feedRowId } = await bringUpAdvertiser('appendsample');
    const sample = await recordAwinLinkSample({
      advertiserRowId,
      feedRowId,
      verdict: 'passed',
      sampled: 25,
      passedRows: 25,
      findings: [],
      takenByOxyUserId: OPERATOR,
    });
    expect(
      await rejectionMessage(async () =>
        db.update(awinLinkSamples).set({ verdict: 'failed' }).where(eq(awinLinkSamples.id, sample.id)),
      ),
    ).toMatch(/append-only/u);

    expect(
      await rejectionMessage(async () =>
        recordAwinLinkSample({
          advertiserRowId,
          feedRowId,
          verdict: 'passed',
          sampled: 25,
          passedRows: 25,
          findings: ['tracking_missing'],
          takenByOxyUserId: OPERATOR,
        }),
      ),
    ).toMatch(/verdict_shape_check/u);

    // …and a FAILED verdict with no findings, which is the half
    // `coalesce(array_length(col, 1), 0)` exists for: on an EMPTY array
    // `array_length` is NULL and a CHECK reads NULL as SATISFIED, so the
    // obvious spelling admits exactly the row it refuses.
    expect(
      await rejectionMessage(async () =>
        recordAwinLinkSample({
          advertiserRowId,
          feedRowId,
          verdict: 'failed',
          sampled: 25,
          passedRows: 0,
          findings: [],
          takenByOxyUserId: OPERATOR,
        }),
      ),
    ).toMatch(/verdict_shape_check/u);
  });

  it('refuses a pasted key where a LOCATOR belongs', async () => {
    expect(
      await rejectionMessage(async () =>
        db.insert(awinAccounts).values({
          publisherId: '1234',
          label: `Pasted ${RUN}`,
          // A real Awin key, not a reference to one. The CHECK is what stops it
          // reaching a row and therefore a log.
          feedCredentialRef: 'a1b2c3d4e5f6a1b2c3d4e5f6!!',
        }),
      ),
    ).toMatch(/feed_credential_shape_check/u);
  });

  it('refuses a non-active account state with no reason', async () => {
    const { accountId } = await bringUpAdvertiser('statereason');
    expect(
      await rejectionMessage(async () =>
        db.update(awinAccounts).set({ state: 'deauthorized' }).where(eq(awinAccounts.id, accountId)),
      ),
    ).toMatch(/state_shape_check/u);
  });
});

describe('the activation service refuses what a CHECK cannot express', () => {
  it('will not activate an advertiser whose newest sample FAILED', async () => {
    const { advertiserRowId, feedRowId } = await bringUpAdvertiser('failedsample');
    await changeAwinAdvertiserActivation({
      advertiserRowId,
      activation: 'sampling',
      actorOxyUserId: OPERATOR,
    });
    await recordAwinSample({
      advertiserRowId,
      feedRowId,
      verdict: 'passed',
      sampled: 25,
      passedRows: 25,
      findings: [],
      takenByOxyUserId: OPERATOR,
    });
    // A NEWER failing sample. Reading "any passed sample" rather than the newest
    // would let a regression through on evidence about a feed that no longer
    // exists.
    await recordAwinSample({
      advertiserRowId,
      feedRowId,
      verdict: 'failed',
      sampled: 25,
      passedRows: 3,
      findings: ['tracking_host_not_approved'],
      takenByOxyUserId: OPERATOR,
    });
    expect(
      await rejectionMessage(async () =>
        changeAwinAdvertiserActivation({
          advertiserRowId,
          activation: 'active',
          actorOxyUserId: OPERATOR,
        }),
      ),
    ).toMatch(/PASSED destination-and-tracking sample/u);
  });

  it('resumes a paused advertiser into SAMPLING, never straight into active', async () => {
    const { advertiserRowId, feedRowId } = await bringUpAdvertiser('resume');
    await changeAwinAdvertiserActivation({
      advertiserRowId,
      activation: 'sampling',
      actorOxyUserId: OPERATOR,
    });
    await recordAwinSample({
      advertiserRowId,
      feedRowId,
      verdict: 'passed',
      sampled: 25,
      passedRows: 25,
      findings: [],
      takenByOxyUserId: OPERATOR,
    });
    await changeAwinAdvertiserActivation({
      advertiserRowId,
      activation: 'active',
      actorOxyUserId: OPERATOR,
    });
    await changeAwinAdvertiserActivation({
      advertiserRowId,
      activation: 'paused',
      actorOxyUserId: OPERATOR,
      note: 'kill switch',
    });
    // Whatever caused the pause may have been a deep-link regression, and the
    // sample is what tells that apart from an unrelated incident.
    expect(
      await rejectionMessage(async () =>
        changeAwinAdvertiserActivation({
          advertiserRowId,
          activation: 'active',
          actorOxyUserId: OPERATOR,
        }),
      ),
    ).toMatch(/cannot move from paused to active/u);
  });
});

describe('the network lease binds the FLEET, keyed on the ACCOUNT', () => {
  it('admits exactly the account’s per-minute allowance and then refuses', async () => {
    const { accountId } = await bringUpAdvertiser('lease');
    const budget = { accountId, maxConcurrency: 2, maxCallsPerMinute: 4 };
    const now = new Date('2026-08-09T10:00:00.000Z');

    const held: string[] = [];
    for (let call = 0; call < 4; call += 1) {
      const claim = await claimAwinNetworkLease({
        budget,
        leaseOwner: `owner-${call}`,
        leaseMs: 60_000,
        now,
      });
      expect(claim.outcome, `call ${call} was refused`).toBe('granted');
      if (claim.outcome !== 'granted') throw new Error('unreachable');
      held.push(claim.leaseId);
      // Released immediately, so the CONCURRENCY bound is not what runs out —
      // the counter is, which is the property under test. The counter is
      // deliberately not decremented on release: it measures calls STARTED
      // inside the window, which is what a provider's own limiter counts.
      await releaseAwinNetworkLease({ leaseId: claim.leaseId, leaseOwner: `owner-${call}`, now });
    }

    const refused = await claimAwinNetworkLease({
      budget,
      leaseOwner: 'owner-over',
      leaseMs: 60_000,
      now,
    });
    expect(refused).toEqual({ outcome: 'refused', reason: 'rate_limited' });

    // …and the window rolls.
    const later = new Date(now.getTime() + 61_000);
    const afterRoll = await claimAwinNetworkLease({
      budget,
      leaseOwner: 'owner-next',
      leaseMs: 60_000,
      now: later,
    });
    expect(afterRoll.outcome).toBe('granted');
    expect(held).toHaveLength(4);
  });
});

describe('acceptance 1 — TWO advertisers ingest end to end, as distinct merchants', () => {
  /** One advertiser's feed, gzipped, in Awin's own column names. */
  function awinFeedBytes(rows: readonly { id: string; title: string; gtin: string; price: string }[]): Buffer {
    const header = 'aw_product_id,product_name,ean,search_price,currency,merchant_deep_link,aw_deep_link';
    const body = rows.map(
      (row) =>
        `"${row.id}","${row.title}","${row.gtin}","${row.price}","EUR",` +
        `"https://retailer.example/p/${row.id}",` +
        `"https://www.awin1.com/cread.php?awinmid=1&awinaffid=2&p=${row.id}"`,
    );
    return gzipSync(Buffer.from(`${[header, ...body].join('\n')}\n`, 'utf8'));
  }

  /** Register the adapter for one advertiser's own source, and drive one run. */
  async function ingestAdvertiser(input: {
    label: string;
    gtin: string;
    title: string;
  }): Promise<{ sourceId: string; merchantId: string; storefrontId: string; advertiserRowId: string }> {
    const { advertiserRowId } = await bringUpAdvertiser(input.label);
    const { merchantId, storefrontId } = await mintMerchantAndStorefront(input.label);

    const advertiser = await registerAwinAdvertiserSource({
      advertiserRowId,
      merchantId,
      storefrontId,
      freshnessTtlSeconds: 3_600,
      pageSize: 50,
    });
    const sourceId = advertiser.catalogSourceId;
    if (sourceId === null) throw new Error('the advertiser was not bound to a source');
    createdSourceIds.push(sourceId);

    await publishIngestionSourcePolicy({
      sourceId,
      reviewedByOxyUserId: OPERATOR,
      ...FULL_RIGHTS,
    });
    await changeIngestionSourceStatus({
      sourceId,
      status: 'active',
      actorOxyUserId: OPERATOR,
      reason: 'awin realdb suite',
    });
    await changeAwinActivation({
      advertiserRowId,
      activation: 'sampling',
      actorOxyUserId: OPERATOR,
    });

    const bytes = awinFeedBytes([
      { id: `awp-${input.label}-1`, title: input.title, gtin: input.gtin, price: '99.00' },
    ]);
    // A UNIQUE provider slug per advertiser, so the two runs in this describe
    // cannot collide in the registry. The real adapter declares one production
    // slug; `provider` is an identity the registry keys on, not behaviour.
    const provider = `${AWIN_FEED_PROVIDER}-${input.label}-${RUN}`.toLowerCase().slice(0, 64);
    await db
      .update(catalogSourceConfigs)
      .set({ provider })
      .where(eq(catalogSourceConfigs.sourceId, sourceId));

    const base = createAwinFeedAdapter({
      resolveFeed: async (ref) => resolveAwinFeed(ref),
      stageFeed: async (resolved) =>
        stageAwinFeed({
          resolved,
          mapping: awinMappingFor(resolved),
          openBytes: async () =>
            Promise.resolve({
              async *[Symbol.asyncIterator]() {
                yield bytes;
              },
            }),
          validators: { etag: null, lastModified: null },
        }),
      recordImport: async () => undefined,
    });
    registerCatalogSourceAdapter({ ...base, provider });
    registeredProviders.push(provider);

    await driveRun(sourceId);
    return { sourceId, merchantId, storefrontId, advertiserRowId };
  }

  async function driveRun(sourceId: string): Promise<void> {
    const now = new Date('2026-08-09T12:00:00.000Z');
    const run = await openSourceRun(db, {
      sourceId,
      kind: 'manual',
      refreshMode: 'full_snapshot',
      since: null,
      requestedByOxyUserId: OPERATOR,
      now,
    });
    const leaseOwner = `awin-${RUN}`;
    for (let page = 0; page < 10; page += 1) {
      await db
        .update(catalogSourceRuns)
        .set({
          status: 'running',
          leaseOwner,
          leaseUntil: new Date(now.getTime() + 120_000),
          startedAt: sql`coalesce(${catalogSourceRuns.startedAt}, ${now.toISOString()}::timestamptz)`,
        })
        .where(and(eq(catalogSourceRuns.id, run.id), inArray(catalogSourceRuns.status, ['pending', 'running'])));
      const result = await runIngestionPage({ runId: run.id, leaseOwner, now });
      if (result.outcome !== null || result.skipped !== null) break;
    }
  }

  it('ingests two advertisers into two merchants and two storefronts', async () => {
    await ensureMatchPolicy();
    const first = await ingestAdvertiser({
      label: 'alpha',
      gtin: ean13('alpha'),
      title: `Awin alpha widget ${RUN}`,
    });
    const second = await ingestAdvertiser({
      label: 'beta',
      gtin: ean13('beta'),
      title: `Awin beta widget ${RUN}`,
    });

    // Each retailer is a DISTINCT merchant and a DISTINCT storefront
    // (acceptance 3), which falls out of one advertiser being one source.
    expect(first.merchantId).not.toBe(second.merchantId);
    expect(first.storefrontId).not.toBe(second.storefrontId);
    expect(first.sourceId).not.toBe(second.sourceId);

    for (const advertiser of [first, second]) {
      const objects = await db
        .select()
        .from(catalogSourceObjects)
        .where(eq(catalogSourceObjects.sourceId, advertiser.sourceId));
      expect(objects, `${advertiser.sourceId} observed nothing`).toHaveLength(1);

      const observations = await db
        .select()
        .from(sourceRecords)
        .where(eq(sourceRecords.sourceId, advertiser.sourceId));
      expect(observations).toHaveLength(1);
      // The provenance every offer must be able to answer, and the ALLOW-LISTED
      // payload in the matcher's own vocabulary.
      expect(observations[0]?.payload).toMatchObject({ price: 9_900, currency: 'EUR' });
      // The deep link survived validation and is stored SEPARATELY from the
      // destination, which stays the retailer's own page.
      expect(observations[0]?.payload).toMatchObject({
        url: expect.stringContaining('retailer.example'),
        affiliateUrl: expect.stringContaining('www.awin1.com'),
      });

      // A run that read the whole feed and enumerated it completely.
      const runs = await db
        .select()
        .from(catalogSourceRuns)
        .where(eq(catalogSourceRuns.sourceId, advertiser.sourceId));
      expect(runs[0]?.outcome).toBe('full_feed_success');
      expect(runs[0]?.enumerationComplete).toBe(true);
    }
  }, 60_000);
});

describe('acceptance 2 — a shared product converges on ONE canonical entity', () => {
  it('attaches an Awin observation and another source’s to the same variant', async () => {
    await ensureMatchPolicy();
    const gtin = ean13('shared');

    // The canonical variant both sources should land on, carrying the GTIN that
    // is the deterministic evidence #58 matches by.
    const [product] = await db
      .insert(canonicalProducts)
      .values({
        name: `Shared product ${RUN}`,
        normalizedName: `shared product ${RUN}`,
        slug: `shared-product-${RUN}`,
      })
      .returning({ id: canonicalProducts.id });
    if (!product) throw new Error('canonical product insert returned no row');
    createdProductIds.push(product.id);

    const [variant] = await db
      .insert(canonicalVariants)
      .values({
        productId: product.id,
        name: 'Default',
        signature: createHash('sha256').update(`shared-${RUN}`).digest('hex'),
      })
      .returning({ id: canonicalVariants.id });
    if (!variant) throw new Error('canonical variant insert returned no row');
    createdVariantIds.push(variant.id);

    await db.insert(productIdentifiers).values({
      variantId: variant.id,
      scheme: 'ean',
      rawValue: gtin,
      normalizedValue: gtin,
      canonicalScheme: 'gtin',
      canonicalValue: gtin.padStart(14, '0'),
      status: 'active',
    });

    // 1. The Awin advertiser.
    const awin = await ingestSharedProduct({
      label: 'sharedawin',
      gtin,
      title: `Shared product ${RUN}`,
      adapterKind: 'awin',
    });
    // 2. A second, NON-Awin source publishing the same GTIN. Convergence is a
    //    property of #58's identifier stage rather than of any one adapter, so
    //    this is the criterion's real content and it does not wait for #65.
    const marketplace = await ingestSharedProduct({
      label: 'sharedmkt',
      gtin,
      title: `Shared product ${RUN}`,
      adapterKind: 'marketplace',
    });

    const links = await db
      .select()
      .from(canonicalVariantSourceLinks)
      .where(eq(canonicalVariantSourceLinks.variantId, variant.id));
    // BOTH attached, to ONE variant.
    expect(links.length).toBeGreaterThanOrEqual(2);

    const activeOffers = await db
      .select()
      .from(offers)
      .where(and(eq(offers.canonicalVariantId, variant.id), eq(offers.status, 'active')));
    // Two offers on one canonical variant — which is what a comparison surface
    // reads, and what "converge on the same canonical entities" buys.
    expect(activeOffers).toHaveLength(2);
    expect(new Set(activeOffers.map((offer) => offer.merchantId))).toEqual(
      new Set([awin.merchantId, marketplace.merchantId]),
    );
    // The Awin one is an AFFILIATE offer carrying routing metadata; the other is
    // a plain external one. #62's own `offerKindFor` decides that from the
    // rights and the source KIND — #66 adds no second authority for it.
    const awinOffer = activeOffers.find((offer) => offer.merchantId === awin.merchantId);
    expect(awinOffer?.kind).toBe('affiliate');
    expect(awinOffer?.destinationUrl).toContain('retailer.example');
    // ISSUE WRITE BOUNDARY 7: an external offer carries no native variant, so
    // there is no id a cart line could hold.
    expect(awinOffer?.productVariantId).toBeNull();
  }, 60_000);

  /** Ingest one product through either an Awin feed or a plain fixture source. */
  async function ingestSharedProduct(input: {
    label: string;
    gtin: string;
    title: string;
    adapterKind: 'awin' | 'marketplace';
  }): Promise<{ sourceId: string; merchantId: string }> {
    const { merchantId, storefrontId } = await mintMerchantAndStorefront(input.label);
    const provider = `${input.adapterKind}-${input.label}-${RUN}`.toLowerCase().slice(0, 64);

    let sourceId: string;
    let adapter: CatalogSourceAdapter;

    if (input.adapterKind === 'awin') {
      const { advertiserRowId } = await bringUpAdvertiser(input.label);
      const advertiser = await registerAwinAdvertiserSource({
        advertiserRowId,
        merchantId,
        storefrontId,
        freshnessTtlSeconds: 3_600,
        pageSize: 50,
      });
      if (advertiser.catalogSourceId === null) throw new Error('no bound source');
      sourceId = advertiser.catalogSourceId;
      createdSourceIds.push(sourceId);
      await db
        .update(catalogSourceConfigs)
        .set({ provider })
        .where(eq(catalogSourceConfigs.sourceId, sourceId));

      const bytes = gzipSync(
        Buffer.from(
          'aw_product_id,product_name,ean,search_price,currency,merchant_deep_link,aw_deep_link\n' +
            `"awp-${input.label}","${input.title}","${input.gtin}","49.50","EUR",` +
            `"https://retailer.example/p/${input.label}",` +
            `"https://www.awin1.com/cread.php?awinmid=1&awinaffid=2&p=${input.label}"\n`,
          'utf8',
        ),
      );
      const base = createAwinFeedAdapter({
        resolveFeed: async (ref) => resolveAwinFeed(ref),
        stageFeed: async (resolved) =>
          stageAwinFeed({
            resolved,
            mapping: buildAwinMapping({
              declared: AWIN_FEED_COLUMNS,
              defaultCurrency: 'EUR',
              defaultCountry: 'ES',
              defaultLanguage: 'es',
            }),
            openBytes: async () =>
              Promise.resolve({
                async *[Symbol.asyncIterator]() {
                  yield bytes;
                },
              }),
            validators: { etag: null, lastModified: null },
          }),
        recordImport: async () => undefined,
      });
      adapter = { ...base, provider };
    } else {
      const { configureIngestionSource } = await import('../ingestion/source.service.js');
      const resolved = await configureIngestionSource({
        name: `Marketplace source ${input.label} ${RUN}`,
        kind: 'marketplace_api',
        provider,
        merchantId,
        storefrontId,
        freshnessTtlSeconds: 3_600,
        pageSize: 50,
      });
      sourceId = resolved.source.config.sourceId;
      createdSourceIds.push(sourceId);

      const observedAt = new Date('2026-08-09T11:30:00.000Z');
      adapter = {
        provider,
        kind: 'marketplace_api',
        extraction: false,
        refreshModes: ['full_snapshot', 'targeted'],
        async fetchPage(): Promise<AdapterFetchPage> {
          return Promise.resolve({
            records: [
              {
                externalType: 'offer',
                externalId: `mkt-${input.label}`,
                observedAt,
                raw: { id: `mkt-${input.label}` },
                normalized: {
                  title: input.title,
                  identifiers: [{ scheme: 'ean', value: input.gtin }],
                  options: [],
                  media: [],
                  price: { amount: 5_100, currency: 'EUR' },
                  sourceUrl: `https://marketplace.example/i/${input.label}`,
                },
              },
            ],
            nextCursor: null,
            complete: true,
          });
        },
      };
    }

    registerCatalogSourceAdapter(adapter);
    registeredProviders.push(provider);

    await publishIngestionSourcePolicy({
      sourceId,
      reviewedByOxyUserId: OPERATOR,
      ...FULL_RIGHTS,
    });
    await changeIngestionSourceStatus({
      sourceId,
      status: 'active',
      actorOxyUserId: OPERATOR,
      reason: 'awin realdb suite',
    });

    const now = new Date('2026-08-09T12:00:00.000Z');
    const run = await openSourceRun(db, {
      sourceId,
      kind: 'manual',
      refreshMode: 'full_snapshot',
      since: null,
      requestedByOxyUserId: OPERATOR,
      now,
    });
    const leaseOwner = `awin-shared-${RUN}`;
    for (let page = 0; page < 10; page += 1) {
      await db
        .update(catalogSourceRuns)
        .set({
          status: 'running',
          leaseOwner,
          leaseUntil: new Date(now.getTime() + 120_000),
          startedAt: sql`coalesce(${catalogSourceRuns.startedAt}, ${now.toISOString()}::timestamptz)`,
        })
        .where(and(eq(catalogSourceRuns.id, run.id), inArray(catalogSourceRuns.status, ['pending', 'running'])));
      const result = await runIngestionPage({ runId: run.id, leaseOwner, now });
      if (result.outcome !== null || result.skipped !== null) break;
    }

    return { sourceId, merchantId };
  }
});
