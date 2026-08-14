/**
 * THE REUSABLE ADAPTER CONTRACT SUITE — issue #62 §"Tests", all thirteen cases.
 *
 * #63 (affiliate networks), #65 (merchant feeds) and #66 (marketplace APIs) each
 * call {@link describeCatalogSourceAdapterContract} with a harness that
 * materialises a SCENARIO in their own transport, and get every case below for
 * free. That is what "the framework supports #63, #65 and #66 without schema
 * forks" (issue acceptance 7) means operationally: the same thirteen assertions,
 * against the same tables, for every provider Mercaria ever adds.
 *
 * ## The scenario is stated in FRAMEWORK terms, not transport terms
 *
 * A harness is handed "two pages, the second failing with a rate limit" and
 * decides how its own provider expresses that — an in-memory list for the
 * fixture, a stubbed HTTP server for a real network. If the scenario were HTTP
 * fixtures, the suite would only ever fit adapters that speak HTTP.
 *
 * ## This file is NOT named `*.test.ts`, deliberately
 *
 * vitest collects `src/**\/*.test.ts`, and a suite that ran itself with no
 * adapter would be a file full of cases nobody could interpret.
 * `adapter-contract.test.ts` is the one that runs it, against the fixture
 * adapter; a provider package adds its own one-line runner.
 *
 * ## It runs against a REAL Postgres server
 *
 * Seven of the thirteen cases are properties of a constraint, a partial unique,
 * a trigger or an upsert predicate, and none of those exists under a mock — a
 * mocked `insert` accepts a statement the server rejects outright. Cases 3, 4,
 * 7, 9, 10, 11 and 12 would every one of them pass green and ship broken.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { withTriggerToggleLock } from '../../../db/__tests__/trigger-toggle-lock.js';
import { acquireActivePolicySlot, type ActivePolicySlot } from './active-policy-slot.js';
import { insertMatchPolicyVersion } from '../../../db/matching/matchPolicyRepository.js';
import { matchDecisions, matchPolicyVersions, matchQueue } from '../../../db/schema/matching.js';
import {
  canonicalProducts,
  canonicalProductSourceLinks,
  canonicalVariants,
  canonicalVariantSourceLinks,
  productIdentifiers,
} from '../../../db/schema/canonicalCatalog.js';
import { merchants } from '../../../db/schema/merchants.js';
import { offers } from '../../../db/schema/offers.js';
import { catalogSources, sourceRecords } from '../../../db/schema/provenance.js';
import {
  catalogSourceConfigs,
  catalogSourceObjects,
  catalogSourcePolicies,
  catalogSourceRejections,
  catalogSourceRuns,
} from '../../../db/schema/ingestion.js';
import {
  catalogSourceDistributions,
  catalogSourceRunQuarantines,
} from '../../../db/schema/offerFreshness.js';
import { openSourceRun } from '../../../db/ingestion/catalogSourceRunRepository.js';
import { runIngestionPage } from '../ingest.service.js';
import {
  registerCatalogSourceAdapter,
  unregisterCatalogSourceAdapter,
} from '../registry.js';
import {
  changeIngestionSourceStatus,
  configureIngestionSource,
  publishIngestionSourcePolicy,
} from '../source.service.js';
import type { AdapterRecord, CatalogSourceAdapter, CatalogSourceFetchError } from '../adapter.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';

/** One page of a scenario, in framework terms. */
export interface ContractPage {
  readonly records: readonly AdapterRecord[];
  /** Fail this page instead of answering it. */
  readonly failWith?: CatalogSourceFetchError;
  readonly rateLimitHits?: number;
}

/**
 * A page, or just its records.
 *
 * Most cases care about records and nothing else, and a suite that made every
 * one of them write `{ records: [...] }` would bury the two cases that actually
 * exercise a failure. {@link normalizeContractPages} is what a harness calls to
 * get the uniform shape.
 */
export type ContractPageInput = ContractPage | readonly AdapterRecord[];

/** What the adapter under test should be made to do. */
export interface ContractScenario {
  readonly pages: readonly ContractPageInput[];
  /** Whether the last page reports a COMPLETE enumeration. Default true. */
  readonly completeOnLastPage?: boolean;
  /** Whether the adapter fetches by crawling. Default false. */
  readonly extraction?: boolean;
}

/** Read every page in its uniform shape — what a harness calls first. */
export function normalizeContractPages(scenario: ContractScenario): readonly ContractPage[] {
  return scenario.pages.map((page) => (Array.isArray(page) ? { records: page } : (page as ContractPage)));
}

/** What a provider package supplies to get all thirteen cases. */
export interface AdapterContractHarness {
  /** Names the suite in test output — "the fixture feed", "the Awin adapter". */
  readonly name: string;
  /** A slug prefix; the suite appends a per-run suffix so registrations cannot collide. */
  readonly providerPrefix: string;
  /** Build an adapter that behaves as the scenario describes. */
  createAdapter(provider: string, scenario: ContractScenario): CatalogSourceAdapter;
  /**
   * The directory holding the provider's own modules, for case 13.
   *
   * Absolute. The scan reads every `.ts` in it and asserts none reaches a
   * repository, a canonical write service, the offer domain or a database
   * handle — which is the strongest form of "no direct canonical writes from
   * adapter code", because it holds for modules nobody has written yet.
   */
  readonly adapterSourceDir: string;
  /**
   * The page size the source under test is configured with. Default 50.
   *
   * An API's transport paginates by page TOKEN, so a scenario's pages are the
   * provider's pages and this value never matters. A FILE has no page tokens:
   * #63's importer reads the whole feed once and pages a local stage by record
   * count, so the only way its harness can materialise "three pages" is to
   * configure a page size of one. Stating it here rather than hard-coding 50 is
   * what keeps the scenario in FRAMEWORK terms — "three pages" — instead of
   * silently meaning "three provider requests".
   */
  readonly pageSize?: number;
  /**
   * Whether the adapter isolates an invalid record BEFORE handing it over.
   *
   * An API adapter passes on what the provider sent and the framework decides —
   * so the bad record becomes a `catalog_source_rejections` row, which is what
   * case 5 asserts. A FILE importer (#63) validates before normalization
   * (issue #63 processing 2), because it is the only layer that knows which
   * COLUMN a value came from and can say "column `titulo` is empty" rather than
   * "a record had no title". Its refusal is recorded in its own report, so the
   * framework legitimately sees nothing.
   *
   * Case 5's PROPERTY is the same either way and is asserted either way: one bad
   * record does not take the page with it. What differs is WHERE the refusal is
   * written, and a harness that sets this must say where — which #63's runner
   * does, naming `feed_import_report_entries`.
   */
  readonly isolatesInvalidRecordsUpstream?: boolean;
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

function ean13(payload: string): string {
  const twelve = payload.padStart(12, '0');
  return `${twelve}${String(gs1CheckDigit(twelve))}`;
}

/** Anything a provider module may not reach. Case 13's detectors. */
const FORBIDDEN_IN_ADAPTER = [
  { name: 'a repository', pattern: /db\/[a-zA-Z-]+\/[a-zA-Z]+Repository/ },
  { name: 'a database handle', pattern: /db\/postgres|getDb\(|drizzle-orm/ },
  {
    name: 'a canonical write service',
    pattern: /canonical-product\.service|canonical-variant\.service|brand\.service|organization\.service|product-identifier\.service/,
  },
  { name: 'the offer domain', pattern: /offers\/offer\.service|offerRepository|recordExternalOffer/ },
  { name: 'the matching pipeline', pattern: /matching\/match\.service|runMatch/ },
] as const;

/**
 * Run every contract case against one adapter implementation.
 *
 * @param harness How to build the adapter under test, and where its modules live.
 */
/**
 * How long a case that needs the GLOBAL active-policy slot may take.
 *
 * `withActivePolicySlot`'s own budget is thirty seconds; vitest's default
 * per-test timeout is ten, so without this the timeout fires first and the wait
 * can never succeed. Comfortably longer than the budget, so a failure here means
 * a leaked slot rather than an ordinary queue.
 */
const POLICY_CASE_TIMEOUT_MS = 60_000;

export function describeCatalogSourceAdapterContract(harness: AdapterContractHarness): void {
  describe(`the CatalogSource adapter contract — ${harness.name}`, () => {
    let db: Database;
    /** Unique to this run, so parallel files cannot collide on a shared database. */
    const RUN = uuidv7().slice(-12);

    const registeredProviders: string[] = [];
    const createdSourceIds: string[] = [];
    const createdMerchantIds: string[] = [];
    const createdProductIds: string[] = [];
    const createdVariantIds: string[] = [];
    const createdPolicyIds: string[] = [];
    let policySlot: ActivePolicySlot | undefined;

    const OPERATOR = `contract-operator-${RUN}`;

    function safeIds(ids: readonly string[]): string[] {
      return ids.length === 0 ? ['__none__'] : [...ids];
    }

    /**
     * A twelve-digit GTIN payload unique to this RUN.
     *
     * The case's own payload keeps its low digits so a failure is still
     * traceable to the case that wrote it; the RUN contributes the high ones.
     */
    function runScopedGtinPayload(payload: string): string {
      const suffix = payload.slice(-6).padStart(6, '0');
      let hash = 0;
      for (const character of RUN) hash = (hash * 31 + character.charCodeAt(0)) % 1_000_000;
      return `${String(hash).padStart(6, '0')}${suffix}`;
    }

    beforeAll(async () => {
      db = await connectPostgres();
      // Held for the WHOLE file. See `active-policy-slot.ts` — one active
      // matching policy exists in the entire database, so the files that need
      // one take turns rather than racing.
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

        // Children first: every intra-graph key here is RESTRICT, and the rights
        // trigger is DEFERRED so a half-torn-down source would raise at commit.
        // The OBJECTS go before the offers they point at: `offer_id` is a
        // RESTRICT foreign key, which is the whole reason an offer is retired and
        // never deleted in production.
        await db
          .delete(catalogSourceObjects)
          .where(inArray(catalogSourceObjects.sourceId, safeIds(createdSourceIds)));
        await db
          .delete(offers)
          .where(inArray(offers.canonicalVariantId, safeIds(createdVariantIds)));
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
        // #68's baseline and quarantine rows go FIRST: a clean run adopts its
        // distribution as the source's baseline, and both tables reference the
        // registry row the teardown is about to remove.
        await db
          .delete(catalogSourceRunQuarantines)
          .where(inArray(catalogSourceRunQuarantines.sourceId, safeIds(createdSourceIds)));
        await db
          .delete(catalogSourceDistributions)
          .where(inArray(catalogSourceDistributions.sourceId, safeIds(createdSourceIds)));
        // Scoped to THIS file's own observations rather than to a policy version.
        //
        // Since #63 added a second contract runner, two files share one active
        // policy (see `ensureMatchPolicy`), so "every decision under this policy"
        // reaches into a run in progress — and it fails loudly, because that run's
        // `catalog_source_objects` still cite the decisions it would delete. The
        // source records ARE file-scoped, so they are the right handle.
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
        // The policies must go before the configs, and the configs before the
        // registry rows — but the rights trigger compares them, so the config is
        // removed FIRST: with no config the trigger returns early and a source
        // with orphaned rights is no longer a contradiction.
        await db
          .delete(catalogSourceConfigs)
          .where(inArray(catalogSourceConfigs.sourceId, safeIds(createdSourceIds)));
        /**
         * The disable/delete/enable window is taken under the shared
         * trigger-toggle lock (#68), transaction-scoped since #275.
         *
         * `alter table … disable trigger` is DATABASE-WIDE and every realdb file
         * shares one server, so two files inside this window at once leave one of
         * them deleting against a trigger the other has just re-enabled —
         * measured, as a teardown failure naming a trigger the test had disabled
         * two statements earlier. The key's VALUE means nothing; its SAMENESS
         * across every file that does this is the whole mechanism, which is why
         * it now lives in exactly one module. The session-level pair this
         * replaces was issued through the POOL, so its unlock could be served by
         * another backend, return false and leak the lock.
         */
        await withTriggerToggleLock(db, async (tx) => {
          await tx.execute(
            sql`alter table catalog_source_policies disable trigger catalog_source_policies_immutable`,
          );
          await tx
            .delete(catalogSourcePolicies)
            .where(inArray(catalogSourcePolicies.sourceId, safeIds(createdSourceIds)));
          await tx.execute(
            sql`alter table catalog_source_policies enable trigger catalog_source_policies_immutable`,
          );
        });
        await db.delete(catalogSources).where(inArray(catalogSources.id, safeIds(createdSourceIds)));
        await db
          .delete(productIdentifiers)
          .where(inArray(productIdentifiers.variantId, safeIds(createdVariantIds)));
        await deleteTestCanonicalRows(db, {
          variantIds: createdVariantIds,
          productIds: createdProductIds,
        });
        await db.delete(merchants).where(inArray(merchants.id, safeIds(createdMerchantIds)));
        // The policy version goes LAST, and only if nothing still cites it.
        //
        // Another contract file may have BORROWED it (see `ensureMatchPolicy`),
        // and its decisions are not this file's to delete — so a policy with
        // surviving references is left alone rather than removed out from under a
        // run in progress. The database is a throwaway per suite run, so the cost
        // of leaving it is nothing; the cost of removing it is the other file's
        // teardown failing on a foreign key.
        const stillCited = (
          await db
            .select({ id: matchDecisions.id })
            .from(matchDecisions)
            .where(inArray(matchDecisions.policyVersionId, safeIds(createdPolicyIds)))
            .limit(1)
        ).length;
        if (stillCited === 0) {
          // Under the SAME lock as the `catalog_source_policies` window above,
          // and for the same reason: `alter table … disable trigger` is
          // DATABASE-WIDE, so this window and that one are two windows and not
          // one file. The unit the census counts is the STATEMENT — this one sat
          // beside a locked sibling and was the proof of it.
          await withTriggerToggleLock(db, async (tx) => {
            await tx.execute(
              sql`alter table match_policy_versions disable trigger match_policy_versions_immutable`,
            );
            await tx
              .delete(matchPolicyVersions)
              .where(inArray(matchPolicyVersions.id, safeIds(createdPolicyIds)));
            await tx.execute(
              sql`alter table match_policy_versions enable trigger match_policy_versions_immutable`,
            );
          });
        }
        /**
         * NESTED, because `release()` can throw and `closePostgres` is what
         * actually ends the hold — see `active-policy-slot.ts` and #272. A
         * check-in returns the connection to the pool without ending the session,
         * so an unlock that threw here would strand the slot for every other
         * claimant, on a socket vitest reuses for the next file in the worker.
         * Three contract files run this suite, so the stranding would be theirs.
         */
      } finally {
        try {
          await policySlot?.release();
        } finally {
          await closePostgres();
        }
      }
    });

    /** A merchant this source's offers belong to. */
    async function mintMerchant(label: string): Promise<string> {
      const [row] = await db
        .insert(merchants)
        .values({
          name: `Contract merchant ${label} ${RUN}`,
          slug: `contract-merchant-${label}-${RUN}`,
        })
        .returning({ id: merchants.id });
      if (!row) throw new Error('merchant insert returned no row');
      createdMerchantIds.push(row.id);
      return row.id;
    }

    /** A canonical product plus one variant, optionally carrying a GTIN. */
    async function mintCanonicalVariant(
      label: string,
      gtinPayload?: string,
    ): Promise<{ productId: string; variantId: string; gtin: string | null }> {
      const [product] = await db
        .insert(canonicalProducts)
        .values({
          name: `Contract product ${label} ${RUN}`,
          normalizedName: `contract product ${label} ${RUN}`,
          slug: `contract-product-${label}-${RUN}`,
        })
        .returning({ id: canonicalProducts.id });
      if (!product) throw new Error('canonical product insert returned no row');
      createdProductIds.push(product.id);

      const [variant] = await db
        .insert(canonicalVariants)
        .values({
          productId: product.id,
          name: 'Default',
          // `canonical_variants_signature_shape_check` demands a sha-256 hex:
          // the signature is a CONTENT key, not a label.
          signature: createHash('sha256').update(`contract-${label}-${RUN}`).digest('hex'),
        })
        .returning({ id: canonicalVariants.id });
      if (!variant) throw new Error('canonical variant insert returned no row');
      createdVariantIds.push(variant.id);

      let gtin: string | null = null;
      if (gtinPayload !== undefined) {
        // Scoped to this RUN, so two contract files on one throwaway database
        // cannot collide on `product_identifiers_canonical_active_key` — a
        // canonical identifier has exactly ONE active owner, which is correct
        // for production and makes a hard-coded fixture GTIN a shared resource
        // the moment a second runner exists.
        gtin = ean13(runScopedGtinPayload(gtinPayload));
        await db.insert(productIdentifiers).values({
          variantId: variant.id,
          scheme: 'ean',
          rawValue: gtin,
          normalizedValue: gtin,
          canonicalScheme: 'gtin',
          canonicalValue: gtin.padStart(14, '0'),
          status: 'active',
        });
      }
      return { productId: product.id, variantId: variant.id, gtin };
    }

    /**
     * The ACTIVE matching policy the pipeline needs to decide anything.
     *
     * `match_policy_versions_active_key` is a partial unique with NO scoping
     * column — ONE active policy in the whole database — so it is a shared
     * resource between the parallel realdb files that run on one throwaway
     * database, and #63 made this the THIRD file that wants it
     * (`matching-writes.realdb.test.ts` and the two contract runners).
     *
     * Each file creates its OWN, waiting for the slot. Reusing whichever policy
     * happens to be active was tried and is WRONG: the borrower's decisions then
     * reference a row the owner deletes at its own teardown, so a file that
     * finishes first breaks one that has not — which is a worse failure than the
     * contention, because it lands on a file that did nothing.
     *
     * The wait is what needs room: `withActivePolicySlot`'s budget is thirty
     * seconds and vitest's default per-test timeout is ten, so the timeout fires
     * first and both files fail on a resource neither is misusing. Every case
     * that calls this therefore declares {@link POLICY_CASE_TIMEOUT_MS}.
     */
    async function ensureMatchPolicy(): Promise<string> {
      const existing = createdPolicyIds[0];
      if (existing !== undefined) return existing;
      const row = await insertMatchPolicyVersion(db, {
        versionKey: `contract-${RUN}`,
        status: 'active',
        description: 'adapter contract fixture',
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

    /** Rights granting everything, which is what most cases want out of the way. */
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

    interface SourceUnderTest {
      readonly sourceId: string;
      readonly provider: string;
      readonly merchantId: string;
      readonly adapter: CatalogSourceAdapter;
    }

    /**
     * Configure a source, publish its rights, activate it and register the
     * adapter — the whole bring-up a real operator performs, so every case runs
     * against a source that got here the supported way.
     */
    async function bringUpSource(
      label: string,
      scenario: ContractScenario,
      rights: Partial<typeof FULL_RIGHTS> = {},
    ): Promise<SourceUnderTest> {
      const provider = `${harness.providerPrefix}-${label}-${RUN}`.toLowerCase().slice(0, 64);
      const adapter = harness.createAdapter(provider, scenario);
      registerCatalogSourceAdapter(adapter);
      registeredProviders.push(provider);

      const merchantId = await mintMerchant(label);
      const resolved = await configureIngestionSource({
        name: `Contract source ${label} ${RUN}`,
        kind: adapter.kind,
        provider,
        merchantId,
        freshnessTtlSeconds: 3_600,
        pageSize: harness.pageSize ?? 50,
      });
      const sourceId = resolved.source.config.sourceId;
      createdSourceIds.push(sourceId);

      await publishIngestionSourcePolicy({
        sourceId,
        reviewedByOxyUserId: OPERATOR,
        ...FULL_RIGHTS,
        ...rights,
      });
      await changeIngestionSourceStatus({
        sourceId,
        status: 'active',
        actorOxyUserId: OPERATOR,
        reason: 'contract suite',
      });

      return { sourceId, provider, merchantId, adapter };
    }

    /** Drive a whole run to completion, one page at a time. */
    async function ingestToCompletion(
      sourceId: string,
      options: { since?: Date; now?: Date } = {},
    ): Promise<{ runId: string; outcome: string | null }> {
      const run = await openSourceRun(db, {
        sourceId,
        kind: 'manual',
        // #68: a pass states its MODE. A run with no watermark asks for a full
        // enumeration — #62's own reading of `since` — and only that mode may
        // set `enumeration_complete`, which is what authorises retirement.
        refreshMode: options.since === undefined ? 'full_snapshot' : 'incremental',
        since: options.since ?? null,
        requestedByOxyUserId: OPERATOR,
        now: options.now ?? new Date(),
      });
      const leaseOwner = `contract-${RUN}`;
      const clock = options.now ?? new Date();
      let outcome: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        // The dispatcher claims before driving; the contract exercises the same
        // page function it does, so a claim is taken the same way.
        //
        // The lease is anchored to the CLOCK THE PAGE WILL RUN AT, not to the
        // wall clock. A case that moves `now` forward to exercise a later
        // refresh would otherwise hand itself an already-expired lease, and
        // every terminal write would report `lease_lost` — which reads exactly
        // like a reclaimed run and is entirely an artefact of the harness.
        await db
          .update(catalogSourceRuns)
          .set({
            status: 'running',
            leaseOwner,
            leaseUntil: new Date(clock.getTime() + 120_000),
            // `started_at` comes from the DRIVING clock, not `now()`.
            //
            // The retirement sweep reads `seen_since = run.started_at` and
            // compares it against each object's `last_seen_at`, which the page
            // stamps from the clock it was given. A case that moves the clock to
            // exercise a later refresh would otherwise stamp `last_seen_at`
            // BEFORE a wall-clock `started_at`, so every re-published object
            // would read as unseen and be retired — a failure that depends on
            // the time of day the suite happens to run, and that passed for
            // hours before it did not.
            //
            // An ISO string with an explicit cast, never a bare `Date`:
            // postgres.js infers a parameter's wire type from ordinary
            // positional binding and cannot for one inside a function call, so
            // a `Date` here throws in the DRIVER with a message that never
            // mentions the column (`~/Oxy/AGENTS.md`, the `sql`-template traps).
            startedAt: sql`coalesce(${catalogSourceRuns.startedAt}, ${clock.toISOString()}::timestamptz)`,
          })
          .where(and(eq(catalogSourceRuns.id, run.id), inArray(catalogSourceRuns.status, ['pending', 'running'])));
        const result = await runIngestionPage({
          runId: run.id,
          leaseOwner,
          ...(options.now === undefined ? {} : { now: options.now }),
        });
        if (result.outcome !== null) {
          outcome = result.outcome;
          break;
        }
        if (result.skipped !== null) break;
      }
      return { runId: run.id, outcome };
    }

    /** A well-formed record with everything the offer path needs. */
    function record(input: {
      externalId: string;
      title: string;
      gtin?: string;
      price?: number;
      observedAt?: Date;
      sourceUpdatedAt?: Date;
      url?: string;
    }): AdapterRecord {
      return {
        externalType: 'offer',
        externalId: input.externalId,
        observedAt: input.observedAt ?? new Date('2026-08-09T10:00:00.000Z'),
        ...(input.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: input.sourceUpdatedAt }),
        raw: { id: input.externalId, name: input.title, price: input.price },
        normalized: {
          title: input.title,
          identifiers: input.gtin === undefined ? [] : [{ scheme: 'ean', value: input.gtin }],
          options: [],
          media: [],
          ...(input.price === undefined ? {} : { price: { amount: input.price, currency: 'EUR' } }),
          ...(input.url === undefined ? {} : { sourceUrl: input.url }),
        },
      };
    }

    // ── 1. Stable external ids ────────────────────────────────────────────────
    it('converges on the SAME source object across deliveries (stable external ids)', async () => {
      const source = await bringUpSource('stable', {
        pages: [[record({ externalId: 'sku-1', title: 'Stable widget' })]],
      });
      await ingestToCompletion(source.sourceId);
      await ingestToCompletion(source.sourceId);

      const objects = await db
        .select()
        .from(catalogSourceObjects)
        .where(eq(catalogSourceObjects.sourceId, source.sourceId));
      expect(objects).toHaveLength(1);
      // The second delivery MENTIONED it, which is what the retirement sweep
      // reads — an identical re-delivery that left the count at 1 would retire
      // every stable feed's whole catalogue.
      expect(objects[0]?.observationCount).toBeGreaterThanOrEqual(2);
    });

    // ── 2. Pagination / cursor behaviour ─────────────────────────────────────
    it('follows the cursor across pages and stores every record exactly once', async () => {
      const source = await bringUpSource('paging', {
        pages: [
          [record({ externalId: 'p1-a', title: 'Page one A' })],
          [record({ externalId: 'p2-a', title: 'Page two A' })],
          [record({ externalId: 'p3-a', title: 'Page three A' })],
        ],
      });
      await ingestToCompletion(source.sourceId);

      const objects = await db
        .select({ externalId: catalogSourceObjects.externalId })
        .from(catalogSourceObjects)
        .where(eq(catalogSourceObjects.sourceId, source.sourceId));
      expect(objects.map((row) => row.externalId).sort()).toEqual(['p1-a', 'p2-a', 'p3-a']);

      const runs = await db
        .select()
        .from(catalogSourceRuns)
        .where(eq(catalogSourceRuns.sourceId, source.sourceId));
      const run = runs[0];
      expect(run?.fetchCount).toBe(3);
      expect(run?.fetched).toBe(3);
      // The vacuity floor, observed rather than assumed: the intake partition
      // must ADD UP, and the CHECK would have refused the row otherwise.
      expect((run?.stored ?? 0) + (run?.unchanged ?? 0) + (run?.rejected ?? 0) + (run?.quarantined ?? 0)).toBe(3);
    });

    // ── 3. Duplicate observation ─────────────────────────────────────────────
    it('treats an identical re-delivery as UNCHANGED and mints no second observation', async () => {
      const source = await bringUpSource('duplicate', {
        pages: [[record({ externalId: 'dup-1', title: 'Duplicate widget', price: 1_000 })]],
      });
      await ingestToCompletion(source.sourceId);
      const first = await db
        .select()
        .from(sourceRecords)
        .where(eq(sourceRecords.sourceId, source.sourceId));
      expect(first).toHaveLength(1);

      await ingestToCompletion(source.sourceId);
      const second = await db
        .select()
        .from(sourceRecords)
        .where(eq(sourceRecords.sourceId, source.sourceId));
      // The content-hash unique is what makes this a genuine no-op; a service
      // that re-inserted would produce two rows with one hash.
      expect(second).toHaveLength(1);

      const runs = await db
        .select()
        .from(catalogSourceRuns)
        .where(eq(catalogSourceRuns.sourceId, source.sourceId))
        .orderBy(catalogSourceRuns.createdAt);
      expect(runs[1]?.unchanged).toBe(1);
      expect(runs[1]?.stored).toBe(0);
    });

    // ── 4. Reordered updates ─────────────────────────────────────────────────
    it('refuses an OLDER observation and keeps the newer current fact', async () => {
      const newer = new Date('2026-08-09T12:00:00.000Z');
      const older = new Date('2026-08-09T08:00:00.000Z');

      const source = await bringUpSource('reorder', {
        pages: [
          [
            record({
              externalId: 'ro-1',
              title: 'Newer title',
              price: 2_000,
              observedAt: newer,
              sourceUpdatedAt: newer,
            }),
          ],
        ],
      });
      await ingestToCompletion(source.sourceId, { now: newer });

      // A redelivery of the SAME object carrying an earlier source timestamp —
      // a retry of yesterday's page, a webhook delivered late, a second mirror.
      const stale = harness.createAdapter(source.provider, {
        pages: [
          [
            record({
              externalId: 'ro-1',
              title: 'Older title',
              price: 500,
              observedAt: older,
              sourceUpdatedAt: older,
            }),
          ],
        ],
      });
      unregisterCatalogSourceAdapter(source.provider);
      registerCatalogSourceAdapter(stale);
      await ingestToCompletion(source.sourceId, { now: new Date('2026-08-09T13:00:00.000Z') });

      const [object] = await db
        .select()
        .from(catalogSourceObjects)
        .where(
          and(
            eq(catalogSourceObjects.sourceId, source.sourceId),
            eq(catalogSourceObjects.externalId, 'ro-1'),
          ),
        );
      expect(object?.currentSourceUpdatedAt?.toISOString()).toBe(newer.toISOString());
      expect(object?.lastPriceAmount).toBe(2_000);

      // And it is RECORDED rather than dropped: a source publishing out of order
      // is a fact somebody needs to see.
      const rejections = await db
        .select()
        .from(catalogSourceRejections)
        .where(
          and(
            eq(catalogSourceRejections.sourceId, source.sourceId),
            eq(catalogSourceRejections.reasonCode, 'stale_observation'),
          ),
        );
      expect(rejections.length).toBeGreaterThanOrEqual(1);
    });

    // ── 5. Partial failure ───────────────────────────────────────────────────
    it('isolates one bad record and keeps the rest of the page', async () => {
      const source = await bringUpSource('partial', {
        pages: [
          [
            record({ externalId: 'ok-1', title: 'Fine widget' }),
            // No title: the one field with no absent form.
            { ...record({ externalId: 'bad-1', title: 'x' }), normalized: { title: '   ', identifiers: [], options: [], media: [] } },
            record({ externalId: 'ok-2', title: 'Also fine' }),
          ],
        ],
      });
      await ingestToCompletion(source.sourceId);

      const objects = await db
        .select({ externalId: catalogSourceObjects.externalId })
        .from(catalogSourceObjects)
        .where(eq(catalogSourceObjects.sourceId, source.sourceId));
      expect(objects.map((row) => row.externalId).sort()).toEqual(['ok-1', 'ok-2']);

      const rejections = await db
        .select()
        .from(catalogSourceRejections)
        .where(eq(catalogSourceRejections.sourceId, source.sourceId));

      if (harness.isolatesInvalidRecordsUpstream === true) {
        // The adapter never handed the bad record over, so the FRAMEWORK has
        // nothing to reject — and asserting a rejection here would force a file
        // importer to smuggle an invalid record through its own validation just
        // to be refused a second time. Where the refusal IS recorded is the
        // harness's own test to make; see the field's docblock.
        expect(rejections).toHaveLength(0);
        return;
      }

      const [rejection] = rejections;
      expect(rejection?.reasonCode).toBe('missing_title');
      expect(rejection?.externalId).toBe('bad-1');
    });

    // ── 6. Auth / rate-limit behaviour ───────────────────────────────────────
    it('fails an auth error CLOSED and retries a rate limit without retiring anything', async () => {
      const { CatalogSourceFetchError } = await import('../adapter.js');

      const authSource = await bringUpSource('auth', {
        pages: [
          {
            records: [],
            failWith: new CatalogSourceFetchError('auth_failure', 'bad credential'),
          },
        ],
      });
      const authRun = await ingestToCompletion(authSource.sourceId);
      expect(authRun.outcome).toBe('auth_failure');

      const [authRunRow] = await db
        .select()
        .from(catalogSourceRuns)
        .where(eq(catalogSourceRuns.id, authRun.runId));
      // The retirement CHECK is what makes this structural rather than polite:
      // a non-zero count on a non-retiring outcome cannot be stored at all.
      expect(authRunRow?.offersRetired).toBe(0);
      expect(authRunRow?.status).toBe('failed');

      const [authConfig] = await db
        .select()
        .from(catalogSourceConfigs)
        .where(eq(catalogSourceConfigs.sourceId, authSource.sourceId));
      expect(authConfig?.healthState).toBe('auth_failure');
      expect(authConfig?.status).toBe('failed');
      expect(authConfig?.consecutiveFailures).toBe(1);

      const limitSource = await bringUpSource('ratelimit', {
        pages: [
          {
            records: [],
            failWith: new CatalogSourceFetchError('rate_limit', 'slow down', {
              retryAfterMs: 90_000,
            }),
          },
        ],
      });
      const limitRun = await ingestToCompletion(limitSource.sourceId);
      // A rate limit is RETRYABLE, so the run is released rather than finished
      // — the cursor stays put and the page re-runs from where it started.
      expect(limitRun.outcome).toBeNull();
      const [limitRunRow] = await db
        .select()
        .from(catalogSourceRuns)
        .where(eq(catalogSourceRuns.id, limitRun.runId));
      expect(limitRunRow?.status).toBe('pending');
      expect(limitRunRow?.offersRetired).toBe(0);
    });

    // ── 7. Source record provenance ──────────────────────────────────────────
    it('records the provenance every offer must be able to answer', async () => {
      const source = await bringUpSource('provenance', {
        pages: [[record({ externalId: 'prov-1', title: 'Provenance widget', price: 4_200 })]],
      });
      await ingestToCompletion(source.sourceId);

      const [observation] = await db
        .select()
        .from(sourceRecords)
        .where(eq(sourceRecords.sourceId, source.sourceId));
      expect(observation?.normalizationVersion).toBeGreaterThanOrEqual(1);
      expect(observation?.policyVersion).toBe(1);
      expect(observation?.rawPayloadDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(observation?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(observation?.staleAt).not.toBeNull();
      // The RAW payload is digested and discarded; what is stored is the
      // allow-listed projection, in the matcher's own vocabulary.
      expect(observation?.payload).toMatchObject({ title: 'Provenance widget', price: 4_200 });

      const [object] = await db
        .select()
        .from(catalogSourceObjects)
        .where(eq(catalogSourceObjects.sourceId, source.sourceId));
      expect(object?.currentSourceRecordId).toBe(observation?.id);
      expect(object?.lastSuccessfulSourceRecordId).toBe(observation?.id);
    });

    // ── 8. Match ambiguity ───────────────────────────────────────────────────
    it('routes an unresolvable record to review and writes NO canonical link', async () => {
      await ensureMatchPolicy();
      const source = await bringUpSource('ambiguity', {
        pages: [[record({ externalId: 'amb-1', title: 'Nothing resembles this at all' })]],
      });
      await ingestToCompletion(source.sourceId);

      const [object] = await db
        .select()
        .from(catalogSourceObjects)
        .where(eq(catalogSourceObjects.sourceId, source.sourceId));
      // Whatever the matcher decided, it was not an automatic match — so the
      // object is out of the offer path and cites the decision #59 reads.
      expect(['review_required', 'unmatched']).toContain(object?.state);
      expect(object?.offerId).toBeNull();
      expect(object?.lastMatchDecisionId).not.toBeNull();

      const links = await db
        .select()
        .from(canonicalVariantSourceLinks)
        .where(
          inArray(
            canonicalVariantSourceLinks.sourceRecordId,
            safeIds([object?.currentSourceRecordId ?? '__none__']),
          ),
        );
      expect(links).toHaveLength(0);
    }, POLICY_CASE_TIMEOUT_MS);

    // ── 9. Offer upsert ──────────────────────────────────────────────────────
    it('materializes an external offer after a canonical match, and re-upserts it', async () => {
      await ensureMatchPolicy();
      const canonical = await mintCanonicalVariant('offer', '620000000091');
      const gtin = canonical.gtin;
      expect(gtin).not.toBeNull();

      const source = await bringUpSource('offerupsert', {
        pages: [
          [
            record({
              externalId: 'offer-1',
              title: `Contract product offer ${RUN}`,
              gtin: gtin ?? undefined,
              price: 9_900,
              url: 'https://retailer.example/p/offer-1',
            }),
          ],
        ],
      });
      await ingestToCompletion(source.sourceId);

      const [object] = await db
        .select()
        .from(catalogSourceObjects)
        .where(eq(catalogSourceObjects.sourceId, source.sourceId));
      expect(object?.state).toBe('offer_current');
      expect(object?.offerId).not.toBeNull();

      const [offer] = await db
        .select()
        .from(offers)
        .where(eq(offers.id, object?.offerId ?? '__none__'));
      expect(offer?.canonicalVariantId).toBe(canonical.variantId);
      expect(offer?.merchantId).toBe(source.merchantId);
      expect(offer?.priceAmount).toBe(9_900);
      // ISSUE WRITE BOUNDARY 7: an external offer carries no native variant, so
      // there is no id a cart line could hold, whatever the pipeline did.
      expect(offer?.productVariantId).toBeNull();
      expect(offer?.kind).not.toBe('native');

      // And the canonical ATTACHMENT was written — #58's other open seam.
      const links = await db
        .select()
        .from(canonicalVariantSourceLinks)
        .where(eq(canonicalVariantSourceLinks.variantId, canonical.variantId));
      expect(links.length).toBeGreaterThanOrEqual(1);

      // A second pass with a changed price re-upserts the SAME offer rather
      // than minting a second active one — the active source key is unique.
      unregisterCatalogSourceAdapter(source.provider);
      registerCatalogSourceAdapter(
        harness.createAdapter(source.provider, {
          pages: [
            [
              record({
                externalId: 'offer-1',
                title: `Contract product offer ${RUN}`,
                gtin: gtin ?? undefined,
                price: 8_400,
                url: 'https://retailer.example/p/offer-1',
                observedAt: new Date('2026-08-09T14:00:00.000Z'),
              }),
            ],
          ],
        }),
      );
      await ingestToCompletion(source.sourceId, { now: new Date('2026-08-09T14:05:00.000Z') });

      const active = await db
        .select()
        .from(offers)
        .where(
          and(eq(offers.canonicalVariantId, canonical.variantId), eq(offers.status, 'active')),
        );
      expect(active).toHaveLength(1);
      expect(active[0]?.priceAmount).toBe(8_400);
    }, POLICY_CASE_TIMEOUT_MS);

    // ── 10. Stale / expiry handoff ───────────────────────────────────────────
    it('retires what a COMPLETE enumeration stopped publishing, and nothing else', async () => {
      await ensureMatchPolicy();
      const canonical = await mintCanonicalVariant('expiry', '620000000107');
      const gtin = canonical.gtin ?? undefined;

      const source = await bringUpSource('expiry', {
        pages: [
          [
            record({
              externalId: 'exp-1',
              title: `Contract product expiry ${RUN}`,
              gtin,
              price: 5_000,
              url: 'https://retailer.example/p/exp-1',
            }),
          ],
        ],
      });
      // Both passes are PINNED, deliberately — the first call used to take the
      // real wall clock while the second was a literal, so the ordering
      // between them was an accident of the day the suite happened to run.
      // Once real time passed the literal the 'before' pass fell AFTER the
      // 'later' one and this case failed with nothing wrong. Never restore a
      // bare `ingestToCompletion(source.sourceId)` above a pinned second call.
      await ingestToCompletion(source.sourceId, { now: new Date('2026-08-09T09:00:00.000Z') });

      const [before] = await db
        .select()
        .from(catalogSourceObjects)
        .where(eq(catalogSourceObjects.sourceId, source.sourceId));
      expect(before?.state).toBe('offer_current');

      // The next COMPLETE enumeration does not mention it.
      unregisterCatalogSourceAdapter(source.provider);
      registerCatalogSourceAdapter(harness.createAdapter(source.provider, { pages: [[]] }));
      // Derived from the row's OWN observed clock, not a second literal.
      // `persistOneRecord` clamps the stamped clock to
      // `max(record.observedAt, now)`, and some adapters under this shared
      // suite (Awin, the product-feed importer) stamp the REAL wall clock
      // when they read a staged record — so `before.lastSeenAt` is whatever
      // instant the suite actually ran at for those cases, not the pinned
      // `now` above. A literal `later` would need to out-run that real clock
      // forever, which no fixed date can do; an offset from what was really
      // stamped keeps the ordering a property of the test rather than of the
      // day — or the millisecond — it happens to run.
      const later = new Date((before?.lastSeenAt ?? new Date()).getTime() + 60 * 60 * 1000);
      const run = await ingestToCompletion(source.sourceId, { now: later });
      expect(run.outcome).toBe('full_feed_success');

      const [after] = await db
        .select()
        .from(catalogSourceObjects)
        .where(eq(catalogSourceObjects.sourceId, source.sourceId));
      expect(after?.state).toBe('retired');
      expect(after?.retiredAt).not.toBeNull();

      // The offer is RETIRED and never deleted: the row, its source record and
      // the observation chain behind it all survive.
      const [offer] = await db
        .select()
        .from(offers)
        .where(eq(offers.id, before?.offerId ?? '__none__'));
      expect(offer?.status).toBe('retired');
      expect(offer?.retirementReason).toBe('source_disappeared');
      expect(offer?.sourceRecordId).not.toBeNull();
    }, POLICY_CASE_TIMEOUT_MS);

    it('retires NOTHING when the enumeration was incomplete', async () => {
      await ensureMatchPolicy();
      const canonical = await mintCanonicalVariant('incomplete', '620000000114');
      const gtin = canonical.gtin ?? undefined;

      const source = await bringUpSource('incomplete', {
        pages: [
          [
            record({
              externalId: 'inc-1',
              title: `Contract product incomplete ${RUN}`,
              gtin,
              price: 5_000,
              url: 'https://retailer.example/p/inc-1',
            }),
          ],
        ],
      });
      // Pinned for the same reason as the retirement case above: a bare
      // wall-clock first pass would eventually run AFTER this literal.
      await ingestToCompletion(source.sourceId, { now: new Date('2026-08-09T10:00:00.000Z') });

      // A pass that read the feed but never claimed to have finished it.
      unregisterCatalogSourceAdapter(source.provider);
      registerCatalogSourceAdapter(
        harness.createAdapter(source.provider, { pages: [[]], completeOnLastPage: false }),
      );
      const run = await ingestToCompletion(source.sourceId, {
        now: new Date('2026-08-09T11:00:00.000Z'),
      });
      expect(run.outcome).toBe('partial_feed');

      const [after] = await db
        .select()
        .from(catalogSourceObjects)
        .where(eq(catalogSourceObjects.sourceId, source.sourceId));
      // "The half I read did not mention it" is not evidence about the half I
      // did not read. THIS is the case that stops one failed refresh
      // mass-expiring a healthy catalogue.
      expect(after?.state).toBe('offer_current');
      const [offer] = await db
        .select()
        .from(offers)
        .where(eq(offers.id, after?.offerId ?? '__none__'));
      expect(offer?.status).toBe('active');
    }, POLICY_CASE_TIMEOUT_MS);

    // ── 11. Rights-disabled source ───────────────────────────────────────────
    it('refuses to refresh a source whose rights were withdrawn, keeping the audit', async () => {
      const source = await bringUpSource('rights', {
        pages: [[record({ externalId: 'rights-1', title: 'Rights widget' })]],
      });
      // Pinned for the same reason as the two cases above.
      await ingestToCompletion(source.sourceId, { now: new Date('2026-08-09T11:00:00.000Z') });

      // A suspension is a NEW policy version granting nothing.
      await publishIngestionSourcePolicy({
        sourceId: source.sourceId,
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
        reviewNote: 'suspended by the contract suite',
      });

      const run = await ingestToCompletion(source.sourceId, {
        now: new Date('2026-08-09T12:00:00.000Z'),
      });
      expect(run.outcome).toBe('rights_suspended');

      const [runRow] = await db
        .select()
        .from(catalogSourceRuns)
        .where(eq(catalogSourceRuns.id, run.runId));
      // A suspension must never expire a catalogue either.
      expect(runRow?.offersRetired).toBe(0);
      expect(runRow?.fetched).toBe(0);

      // The audit survives: BOTH versions are there, the first with its rights
      // and its reviewer intact.
      const policies = await db
        .select()
        .from(catalogSourcePolicies)
        .where(eq(catalogSourcePolicies.sourceId, source.sourceId));
      expect(policies).toHaveLength(2);
      const first = policies.find((row) => row.version === 1);
      expect(first?.status).toBe('superseded');
      expect(first?.mayRefreshAutomatically).toBe(true);
      expect(first?.reviewedByOxyUserId).toBe(OPERATOR);

      // And the registry's coarse rights followed, which the deferred trigger
      // would have refused the commit for otherwise.
      const [registry] = await db
        .select()
        .from(catalogSources)
        .where(eq(catalogSources.id, source.sourceId));
      expect(registry?.mayDisplay).toBe(false);
      expect(registry?.mayStore).toBe(false);

      // The observations taken while the rights held are untouched.
      const observations = await db
        .select()
        .from(sourceRecords)
        .where(eq(sourceRecords.sourceId, source.sourceId));
      expect(observations.length).toBeGreaterThanOrEqual(1);
    });

    // ── 12. PostgreSQL transactional / idempotent behaviour ──────────────────
    it('converges two CONCURRENT deliveries of one version onto one object', async () => {
      const source = await bringUpSource('concurrent', {
        pages: [[record({ externalId: 'conc-1', title: 'Concurrent widget', price: 700 })]],
      });

      // Two runs of the same page at once. The identity unique is what makes
      // this converge; without it the second insert would mint a second object
      // for one external id.
      await Promise.all([
        ingestToCompletion(source.sourceId),
        ingestToCompletion(source.sourceId),
      ]);

      const objects = await db
        .select()
        .from(catalogSourceObjects)
        .where(eq(catalogSourceObjects.sourceId, source.sourceId));
      expect(objects).toHaveLength(1);

      // And only ONE run was ever open: the open-run partial unique refuses a
      // competing pass rather than letting two enumerate the same feed.
      const runs = await db
        .select()
        .from(catalogSourceRuns)
        .where(eq(catalogSourceRuns.sourceId, source.sourceId));
      expect(runs).toHaveLength(1);
    });

    it('leaves no orphaned queue or decision rows behind a converged object', async () => {
      await ensureMatchPolicy();
      const source = await bringUpSource('idempotent', {
        pages: [[record({ externalId: 'idem-1', title: 'Idempotent widget' })]],
      });
      await ingestToCompletion(source.sourceId);
      await ingestToCompletion(source.sourceId);
      await ingestToCompletion(source.sourceId);

      const objects = await db
        .select()
        .from(catalogSourceObjects)
        .where(eq(catalogSourceObjects.sourceId, source.sourceId));
      expect(objects).toHaveLength(1);

      const observations = await db
        .select()
        .from(sourceRecords)
        .where(eq(sourceRecords.sourceId, source.sourceId));
      // Three passes over unchanged content: ONE observation. The convergence
      // key did its job at every layer.
      expect(observations).toHaveLength(1);

      const queued = await db
        .select()
        .from(matchQueue)
        .where(inArray(matchQueue.sourceRecordId, safeIds([observations[0]?.id ?? '__none__'])));
      // The ingestion path evaluates inline rather than queuing, so nothing is
      // left owed. A row here would mean two mechanisms were matching the same
      // subject.
      expect(queued).toHaveLength(0);
    }, POLICY_CASE_TIMEOUT_MS);

    // ── 13. No direct canonical writes from adapter code ─────────────────────
    it('reaches no repository, database handle, canonical write or offer from adapter code', () => {
      const files = readdirSync(harness.adapterSourceDir)
        .filter((entry) => entry.endsWith('.ts'))
        .filter((entry) => statSync(join(harness.adapterSourceDir, entry)).isFile());

      // The vacuity floor: an empty directory would pass every assertion below.
      expect(files.length, `no adapter modules found in ${harness.adapterSourceDir}`).toBeGreaterThan(0);

      for (const file of files) {
        const source = readFileSync(join(harness.adapterSourceDir, file), 'utf8');
        expect(source.length, `${file} looks empty — did it move?`).toBeGreaterThan(100);
        for (const { name, pattern } of FORBIDDEN_IN_ADAPTER) {
          expect(pattern.test(source), `${file} reaches ${name}`).toBe(false);
        }
      }
    });

    it('the case-13 detectors actually detect — the mutation self-test', () => {
      const positives = [
        "import { upsertSourceObject } from '../../db/ingestion/catalogSourceObjectRepository.js';",
        "import { getDb } from '../../db/postgres.js';",
        "import { applyCanonicalProduct } from '../canonical/canonical-product.service.js';",
        "import { recordExternalOffer } from '../offers/offer.service.js';",
        "import { runMatch } from '../matching/match.service.js';",
      ];
      positives.forEach((line, index) => {
        const detector = FORBIDDEN_IN_ADAPTER[index];
        expect(detector, `no detector at index ${index}`).toBeDefined();
        expect(detector?.pattern.test(line), `detector ${index} missed its own positive`).toBe(true);
      });
      // And an ordinary adapter line trips none of them.
      const ordinary = "const response = await fetch(`${base}/products?page=${cursor}`);";
      for (const { name, pattern } of FORBIDDEN_IN_ADAPTER) {
        expect(pattern.test(ordinary), `${name} detector fires on an ordinary fetch`).toBe(false);
      }
    });
  });
}
