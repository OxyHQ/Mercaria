/**
 * The feed importer's SCHEMA properties, against a real Postgres server (#63).
 *
 * Seven of the things this domain claims are a CHECK, a partial unique or a
 * trigger, and none of those exists under a mock: a mocked `insert` accepts a
 * statement the server rejects outright, so every case here would pass green and
 * ship broken. `moderation-writes.realdb.test.ts` states the rule and this file
 * follows it.
 *
 * The properties, in the order they appear:
 *
 * 1. `identity_key_fields` is FROZEN — re-keying a feed retires its catalogue.
 * 2. A mapping version is frozen once it leaves `draft`, and ONE is active.
 * 3. A mapping names exactly one of a column or a constant.
 * 4. A report's counters must ADD UP (`scanned = valid + invalid`).
 * 5. A report ENTRY may carry a value only for the three permitted issue codes,
 *    and only within the bounded alphabet.
 * 6. A report entry cannot be EDITED, and can be DELETED (retention).
 * 7. An upload filename is a label, not a location.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { catalogSources } from '../../db/schema/provenance.js';
import { catalogSourceConfigs } from '../../db/schema/ingestion.js';
import { createFeedConfiguration } from '../feed-import/configuration.service.js';
import { listFeedConfigurationsForOwner } from '../../db/feedImport/feedConfigurationRepository.js';
import {
  createFeedConfigurationSchema,
  createOperatorFeedConfigurationSchema,
} from '../../middleware/feed-import-schemas.js';
import {
  feedConfigurationVersions,
  feedConfigurations,
  feedFieldMappings,
  feedImportReportEntries,
  feedImportReports,
  feedUploads,
} from '../../db/schema/feedImport.js';

describe('feed importer schema properties (real server)', () => {
  let db: Database;
  const RUN = uuidv7().slice(-12);
  const createdSourceIds: string[] = [];
  const createdConfigurationIds: string[] = [];

  function safe(ids: readonly string[]): string[] {
    return ids.length === 0 ? ['__none__'] : [...ids];
  }

  /**
   * Assert a statement is REFUSED, naming the constraint or trigger that
   * refused it.
   *
   * drizzle's own `Error.message` is `Failed query: …` and the server's message
   * — the constraint name, the trigger's `RAISE` text — is on `cause`. Matching
   * only the outer message would pass for ANY failure, including a typo in the
   * statement, which is a check that cannot tell success from failure
   * (`~/Oxy/AGENTS.md` (C)).
   */
  async function expectRefusal(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
    let raised: unknown;
    try {
      await operation;
    } catch (error: unknown) {
      raised = error;
    }
    expect(raised, 'the statement was accepted').toBeDefined();
    const cause = (raised as { cause?: unknown }).cause;
    const text = [
      raised instanceof Error ? raised.message : String(raised),
      cause instanceof Error ? cause.message : String(cause ?? ''),
    ].join(' | ');
    expect(text).toMatch(pattern);
  }

  beforeAll(async () => {
    db = await connectPostgres();
  }, 120_000);

  afterAll(async () => {
    // A version cites its validating REPORT and a report names its VERSION, so
    // the two foreign keys are a cycle — deliberately, because each direction is
    // load-bearing (an activation must carry its justification, and a report
    // must say which mapping produced it). Nothing in production deletes either,
    // so the cycle costs nothing there; a teardown has to break it by hand, and
    // the order below is the only one that works: drop the citation, then the
    // reports, then the versions.
    //
    // All three triggers over these tables — `feed_configuration_versions_immutable`,
    // `feed_import_report_entries_append_only` and
    // `feed_configurations_identity_frozen` — are declared BEFORE UPDATE, so no
    // DELETE below ever reaches one and this teardown needs no window. The one
    // statement that DOES reach a trigger is the UPDATE, and it moves only the
    // lifecycle columns the freeze deliberately excludes (`status`,
    // `validated_report_id`, `activated_at`, `activated_by_oxy_user_id`,
    // `superseded_at`), so the comparison runs and finds nothing frozen changed.
    //
    // It used to open three windows, and `alter table … disable trigger` is
    // DATABASE-WIDE: on the pool the DDL autocommits, so a throw before a
    // re-enable left the trigger off for the rest of the run and every later
    // file asserting it refuses a write passed vacuously. Measured before
    // removing them, since a statement matching no rows is green whatever the
    // trigger does — 7 versions updated, of which one was `active` and one
    // `superseded`, so the trigger's `OLD.status = 'draft'` early return is not
    // what cleared them; then 5 reports deleted, cascading into 1 report entry;
    // 7 versions and 10 configurations deleted. Nothing raised.

    // Back to `draft` in the same statement: the activation CHECK refuses a
    // non-draft version with no validating report, which is the constraint
    // working — an activation whose justification vanished is exactly what it
    // exists to prevent.
    await db
      .update(feedConfigurationVersions)
      .set({
        status: 'draft',
        validatedReportId: null,
        activatedAt: null,
        activatedByOxyUserId: null,
        supersededAt: null,
      })
      .where(inArray(feedConfigurationVersions.configurationId, safe(createdConfigurationIds)));
    await db
      .delete(feedImportReports)
      .where(inArray(feedImportReports.configurationId, safe(createdConfigurationIds)));
    await db
      .delete(feedConfigurationVersions)
      .where(inArray(feedConfigurationVersions.configurationId, safe(createdConfigurationIds)));
    await db
      .delete(feedConfigurations)
      .where(inArray(feedConfigurations.id, safe(createdConfigurationIds)));
    // The platform cases go through `configureIngestionSource`, which writes a
    // `catalog_source_configs` row beside the registry row — the fixtures above
    // insert into `catalog_sources` directly and have none. The FK is
    // `restrict`, so the registry delete below fails with 23503 rather than
    // cascading, and it fails in TEARDOWN, where a green test run hides it.
    await db
      .delete(catalogSourceConfigs)
      .where(inArray(catalogSourceConfigs.sourceId, safe(createdSourceIds)));
    await db.delete(catalogSources).where(inArray(catalogSources.id, safe(createdSourceIds)));
    await closePostgres();
  });

  /**
   * The PLATFORM owner, which had no writer before #986.
   *
   * `createFeedConfiguration` has always written `operator` when `storeId` is
   * null; its only caller supplied a store, so the branch was unreachable from
   * any route. These drive the service directly, which is what the branch has
   * to be correct for before a route can offer it.
   */
  describe('a feed the platform owns rather than a store', () => {
    it('writes owner_kind `operator` and carries the source kind it was asked for', async () => {
      const configuration = await createFeedConfiguration({
        storeId: null,
        sourceKind: 'affiliate_network',
        sourceName: `platform affiliate ${RUN}`,
        label: 'A directly-signed shop',
        identityKeyFields: ['id'],
        actorOxyUserId: `operator-${RUN}`,
      });
      createdConfigurationIds.push(configuration.id);
      createdSourceIds.push(configuration.sourceId);

      expect(configuration.ownerKind).toBe('operator');
      expect(configuration.storeId).toBeNull();

      // The whole reason `sourceKind` exists. `offerKindFor` grants the
      // `affiliate` offer kind only on `affiliate_network`, and
      // `commercial-presentation` derives `affiliateDisclosureRequired` from
      // that offer kind — so a feed that earns a commission under a `feed`
      // source would show a shopper no affiliate disclosure at all.
      const [source] = await db
        .select({ kind: catalogSources.kind })
        .from(catalogSources)
        .where(eq(catalogSources.id, configuration.sourceId));
      expect(source?.kind).toBe('affiliate_network');
    });

    it('defaults the source kind to `feed`, so an ordinary operator feed is ordinary', async () => {
      const configuration = await createFeedConfiguration({
        storeId: null,
        sourceName: `platform plain ${RUN}`,
        label: 'A plain operator feed',
        identityKeyFields: ['id'],
        actorOxyUserId: `operator-${RUN}`,
      });
      createdConfigurationIds.push(configuration.id);
      createdSourceIds.push(configuration.sourceId);

      const [source] = await db
        .select({ kind: catalogSources.kind })
        .from(catalogSources)
        .where(eq(catalogSources.id, configuration.sourceId));
      expect(source?.kind).toBe('feed');
    });

    it('is listed for the platform and NOT for a store', async () => {
      // The `isNull` fix, which is invisible any other way: `eq(column, null)`
      // renders `= NULL`, which is never true, so the platform list came back
      // EMPTY — an operator would be told they had no feeds immediately after
      // creating one, and nothing would have raised.
      const configuration = await createFeedConfiguration({
        storeId: null,
        sourceName: `platform listed ${RUN}`,
        label: 'A listed operator feed',
        identityKeyFields: ['id'],
        actorOxyUserId: `operator-${RUN}`,
      });
      createdConfigurationIds.push(configuration.id);
      createdSourceIds.push(configuration.sourceId);

      // A FLOOR, never an equality: this database is shared and a sibling file
      // may own platform feeds of its own.
      const platformFeeds = await listFeedConfigurationsForOwner(db, null);
      expect(platformFeeds.map((row) => row.id)).toContain(configuration.id);
      for (const row of platformFeeds) expect(row.storeId).toBeNull();

      // The other direction, against a store id that owns nothing: a platform
      // feed must not leak into any store's list. Without it the case above
      // would also pass on a query that ignored the owner entirely.
      const strangerFeeds = await listFeedConfigurationsForOwner(db, `store-${RUN}`);
      expect(strangerFeeds.map((row) => row.id)).not.toContain(configuration.id);
    });
  });

  describe('which surface may declare a source an affiliate network', () => {
    const base = {
      sourceName: 'A shop',
      label: 'A shop feed',
      identityKeyFields: ['id'],
    };

    it('refuses `sourceKind` on the MERCHANT body', () => {
      // `affiliate_network` says Mercaria links out to somebody else's shop and
      // earns a commission on the click. A store must not be able to say that
      // about its own catalogue: it would put an affiliate disclosure on an
      // offer with no affiliate relationship behind it.
      const parsed = createFeedConfigurationSchema.safeParse({
        ...base,
        sourceKind: 'affiliate_network',
      });
      expect(parsed.success).toBe(false);
    });

    it('accepts it on the OPERATOR body, and defaults it to `feed`', () => {
      const declared = createOperatorFeedConfigurationSchema.safeParse({
        ...base,
        sourceKind: 'affiliate_network',
      });
      expect(declared.success).toBe(true);
      if (declared.success) expect(declared.data.sourceKind).toBe('affiliate_network');

      const omitted = createOperatorFeedConfigurationSchema.safeParse(base);
      expect(omitted.success).toBe(true);
      if (omitted.success) expect(omitted.data.sourceKind).toBe('feed');
    });

    it('still refuses a kind neither surface knows', () => {
      // The floor under both cases: an enum that accepted anything would make
      // the merchant refusal above a fact about the field being unknown rather
      // than about the value being forbidden.
      const parsed = createOperatorFeedConfigurationSchema.safeParse({
        ...base,
        sourceKind: 'connector',
      });
      expect(parsed.success).toBe(false);
    });
  });

  /** A registry row plus its feed configuration. */
  async function mintConfiguration(
    label: string,
    identityKeyFields: readonly string[] = ['id'],
  ): Promise<{ configurationId: string; sourceId: string }> {
    const [source] = await db
      .insert(catalogSources)
      .values({
        kind: 'feed',
        name: `feed-import realdb ${label} ${RUN}`,
        mayDisplay: false,
        mayStore: false,
        attributionRequired: true,
      })
      .returning({ id: catalogSources.id });
    if (!source) throw new Error('catalog_sources insert returned no row');
    createdSourceIds.push(source.id);

    const [configuration] = await db
      .insert(feedConfigurations)
      .values({
        sourceId: source.id,
        ownerKind: 'operator',
        storeId: null,
        label: `Feed ${label} ${RUN}`,
        identityKeyFields: [...identityKeyFields],
        createdByOxyUserId: `operator-${RUN}`,
      })
      .returning({ id: feedConfigurations.id });
    if (!configuration) throw new Error('feed_configurations insert returned no row');
    createdConfigurationIds.push(configuration.id);
    return { configurationId: configuration.id, sourceId: source.id };
  }

  async function mintVersion(configurationId: string, version = 1): Promise<string> {
    const [row] = await db
      .insert(feedConfigurationVersions)
      .values({
        configurationId,
        version,
        status: 'draft',
        fetchMode: 'url',
        feedUrl: `https://feeds.example.com/${RUN}-${version}.csv`,
        format: 'csv',
        delimiter: ',',
        quoteChar: '"',
        hasHeaderRow: true,
        deliveryMode: 'delta',
        createdByOxyUserId: `operator-${RUN}`,
      })
      .returning({ id: feedConfigurationVersions.id });
    if (!row) throw new Error('feed_configuration_versions insert returned no row');
    return row.id;
  }

  async function mintReport(
    configurationId: string,
    versionId: string,
    counters: { scanned: number; valid: number; invalid: number },
  ): Promise<string> {
    const [row] = await db
      .insert(feedImportReports)
      .values({
        configurationId,
        versionId,
        mode: 'validation',
        ...counters,
        requestedByOxyUserId: `operator-${RUN}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: feedImportReports.id });
    if (!row) throw new Error('feed_import_reports insert returned no row');
    return row.id;
  }

  it('FREEZES identity_key_fields — re-keying a feed retires its catalogue', async () => {
    const { configurationId } = await mintConfiguration('frozen', ['sku']);
    await expectRefusal(
      db
        .update(feedConfigurations)
        .set({ identityKeyFields: ['sku', 'shop'] })
        .where(eq(feedConfigurations.id, configurationId)),
      /frozen/u,
    );

    // …and an update that leaves it alone is fine, so the trigger is not simply
    // refusing every write.
    await db
      .update(feedConfigurations)
      .set({ label: `Renamed ${RUN}` })
      .where(eq(feedConfigurations.id, configurationId));
    const [after] = await db
      .select()
      .from(feedConfigurations)
      .where(eq(feedConfigurations.id, configurationId));
    expect(after?.label).toBe(`Renamed ${RUN}`);
  });

  it('freezes a mapping version once it leaves draft, and keeps ONE active', async () => {
    const { configurationId } = await mintConfiguration('versions');
    const first = await mintVersion(configurationId, 1);
    const second = await mintVersion(configurationId, 2);
    const reportId = await mintReport(configurationId, first, {
      scanned: 10,
      valid: 10,
      invalid: 0,
    });

    // A DRAFT is editable — the freeze must not make a mapping unbuildable.
    await db
      .update(feedConfigurationVersions)
      .set({ recordPath: null, listSeparator: ';' })
      .where(eq(feedConfigurationVersions.id, first));

    await db
      .update(feedConfigurationVersions)
      .set({
        status: 'active',
        activatedAt: new Date(),
        activatedByOxyUserId: `operator-${RUN}`,
        validatedReportId: reportId,
      })
      .where(eq(feedConfigurationVersions.id, first));

    // Now frozen: a mapping change is refused…
    await expectRefusal(
      db
        .update(feedConfigurationVersions)
        .set({ listSeparator: '|' })
        .where(eq(feedConfigurationVersions.id, first)),
      /frozen/u,
    );

    // …while the LIFECYCLE columns still move, or nothing could ever supersede.
    await db
      .update(feedConfigurationVersions)
      .set({ status: 'superseded', supersededAt: new Date() })
      .where(eq(feedConfigurationVersions.id, first));

    // One ACTIVE per configuration: the partial unique, not a service check.
    const secondReport = await mintReport(configurationId, second, {
      scanned: 5,
      valid: 5,
      invalid: 0,
    });
    await db
      .update(feedConfigurationVersions)
      .set({
        status: 'active',
        activatedAt: new Date(),
        activatedByOxyUserId: `operator-${RUN}`,
        validatedReportId: secondReport,
      })
      .where(eq(feedConfigurationVersions.id, second));

    await expectRefusal(
      db.insert(feedConfigurationVersions).values({
        configurationId,
        version: 3,
        status: 'active',
        fetchMode: 'url',
        feedUrl: `https://feeds.example.com/${RUN}-3.csv`,
        format: 'csv',
        delimiter: ',',
        quoteChar: '"',
        hasHeaderRow: true,
        deliveryMode: 'delta',
        activatedAt: new Date(),
        activatedByOxyUserId: `operator-${RUN}`,
        validatedReportId: secondReport,
        createdByOxyUserId: `operator-${RUN}`,
      }),
      /feed_configuration_versions_active_key/u,
    );
  });

  it('refuses an ACTIVE version that cites no validation report', async () => {
    const { configurationId } = await mintConfiguration('activation');
    const versionId = await mintVersion(configurationId);
    await expectRefusal(
      db
        .update(feedConfigurationVersions)
        .set({ status: 'active', activatedAt: new Date(), activatedByOxyUserId: `op-${RUN}` })
        .where(eq(feedConfigurationVersions.id, versionId)),
      /activation_check/u,
    );
  });

  it('refuses a mapping that names both a column and a constant, or neither', async () => {
    const { configurationId } = await mintConfiguration('mappings');
    const versionId = await mintVersion(configurationId);

    await expectRefusal(
      db.insert(feedFieldMappings).values({
        versionId,
        role: 'title',
        sourceField: 'name',
        constantValue: 'Fixed',
      }),
      /source_shape_check/u,
    );

    await expectRefusal(
      db.insert(feedFieldMappings).values({ versionId, role: 'title' }),
      /source_shape_check/u,
    );

    // One of each is fine, and a role is unique per version.
    await db.insert(feedFieldMappings).values({ versionId, role: 'title', sourceField: 'name' });
    await expectRefusal(
      db.insert(feedFieldMappings).values({ versionId, role: 'title', constantValue: 'Other' }),
      /feed_field_mappings_role_key/u,
    );
  });

  it('refuses a report whose counters do NOT add up — the vacuity floor', async () => {
    const { configurationId } = await mintConfiguration('counters');
    const versionId = await mintVersion(configurationId);

    await expectRefusal(
      mintReport(configurationId, versionId, { scanned: 10, valid: 4, invalid: 4 }),
      /intake_total_check/u,
    );

    // Equality, never `<=`: the run that read ten thousand records and
    // classified none of them is exactly what this refuses.
    await expectRefusal(
      mintReport(configurationId, versionId, { scanned: 10_000, valid: 0, invalid: 0 }),
      /intake_total_check/u,
    );

    const ok = await mintReport(configurationId, versionId, {
      scanned: 10,
      valid: 9,
      invalid: 1,
    });
    expect(ok).toBeTruthy();
  });

  it('permits an observed token ONLY for the three closed-vocabulary issue codes', async () => {
    const { configurationId } = await mintConfiguration('entries');
    const versionId = await mintVersion(configurationId);
    const reportId = await mintReport(configurationId, versionId, {
      scanned: 3,
      valid: 1,
      invalid: 2,
    });
    const expiresAt = new Date(Date.now() + 86_400_000);

    // Permitted: the value comes from a closed external vocabulary.
    await db.insert(feedImportReportEntries).values({
      reportId,
      recordIndex: 1,
      issueCode: 'unsupported_currency',
      severity: 'warning',
      observedToken: 'XYZ',
      expiresAt,
    });

    // Refused: the code is not in the permitted three, so the value could be
    // anything the merchant's file contained.
    await expectRefusal(
      db.insert(feedImportReportEntries).values({
        reportId,
        recordIndex: 2,
        issueCode: 'unparseable_number',
        severity: 'warning',
        observedToken: 'sk_live_secret',
        expiresAt,
      }),
      /token_shape_check/u,
    );

    // Refused: past the alphabet a credential could not survive anyway. The
    // bound is what makes the exception safe rather than merely narrow.
    await expectRefusal(
      db.insert(feedImportReportEntries).values({
        reportId,
        recordIndex: 3,
        issueCode: 'unknown_availability',
        severity: 'warning',
        observedToken: 'a'.repeat(32),
        expiresAt,
      }),
      /token_shape_check/u,
    );
  });

  it('makes a report entry append-only against UPDATE and deletable for retention', async () => {
    const { configurationId } = await mintConfiguration('append-only');
    const versionId = await mintVersion(configurationId);
    const reportId = await mintReport(configurationId, versionId, {
      scanned: 1,
      valid: 0,
      invalid: 1,
    });
    const [entry] = await db
      .insert(feedImportReportEntries)
      .values({
        reportId,
        recordIndex: 0,
        issueCode: 'missing_required_field',
        severity: 'error',
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: feedImportReportEntries.id });
    if (!entry) throw new Error('feed_import_report_entries insert returned no row');

    await expectRefusal(
      db
        .update(feedImportReportEntries)
        .set({ severity: 'warning' })
        .where(eq(feedImportReportEntries.id, entry.id)),
      /append-only/u,
    );

    // DELETE is deliberately PERMITTED: retention sweeps these on a deadline,
    // and a trigger refusing it would make retention fail silently.
    await db.delete(feedImportReportEntries).where(eq(feedImportReportEntries.id, entry.id));
  });

  it('refuses an upload filename that is a location rather than a label', async () => {
    const { configurationId } = await mintConfiguration('uploads');
    const base = {
      configurationId,
      byteSize: 10,
      contentDigest: 'a'.repeat(64),
      storageKey: 'AAAAAAAAAAAAAAAA',
      compression: 'none' as const,
      uploadedByOxyUserId: `operator-${RUN}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    };

    for (const filename of ['../escape.csv', 'a/b.csv', '.hidden', 'has..dots.csv']) {
      await expectRefusal(
        db.insert(feedUploads).values({ ...base, filename }),
        /filename_shape_check/u,
      );
    }
    const [ok] = await db
      .insert(feedUploads)
      .values({ ...base, filename: 'products.csv' })
      .returning({ id: feedUploads.id });
    expect(ok?.id).toBeTruthy();
    await db.delete(feedUploads).where(eq(feedUploads.configurationId, configurationId));
  });

  it('refuses a cleartext feed URL and a record path on a flat format', async () => {
    const { configurationId } = await mintConfiguration('shapes');
    await expectRefusal(
      db.insert(feedConfigurationVersions).values({
        configurationId,
        version: 10,
        fetchMode: 'url',
        feedUrl: 'http://feeds.example.com/insecure.csv',
        format: 'csv',
        delimiter: ',',
        quoteChar: '"',
        deliveryMode: 'delta',
        createdByOxyUserId: `operator-${RUN}`,
      }),
      /url_shape_check/u,
    );

    await expectRefusal(
      db.insert(feedConfigurationVersions).values({
        configurationId,
        version: 11,
        fetchMode: 'url',
        feedUrl: `https://feeds.example.com/${RUN}.csv`,
        format: 'csv',
        delimiter: ',',
        quoteChar: '"',
        recordPath: 'items',
        deliveryMode: 'delta',
        createdByOxyUserId: `operator-${RUN}`,
      }),
      /record_path_check/u,
    );

    // …and an XML feed WITHOUT one is refused too, in the other direction.
    await expectRefusal(
      db.insert(feedConfigurationVersions).values({
        configurationId,
        version: 12,
        fetchMode: 'url',
        feedUrl: `https://feeds.example.com/${RUN}.xml`,
        format: 'xml',
        deliveryMode: 'snapshot',
        createdByOxyUserId: `operator-${RUN}`,
      }),
      /record_path_check/u,
    );
  });

  it('refuses an auth kind with no credential, and a credential with no kind', async () => {
    const { configurationId } = await mintConfiguration('auth');
    await expectRefusal(
      db.insert(feedConfigurationVersions).values({
        configurationId,
        version: 20,
        fetchMode: 'url',
        feedUrl: `https://feeds.example.com/${RUN}-auth.csv`,
        format: 'csv',
        delimiter: ',',
        quoteChar: '"',
        deliveryMode: 'delta',
        authKind: 'bearer',
        createdByOxyUserId: `operator-${RUN}`,
      }),
      /auth_shape_check/u,
    );

    await expectRefusal(
      db.insert(feedConfigurationVersions).values({
        configurationId,
        version: 21,
        fetchMode: 'url',
        feedUrl: `https://feeds.example.com/${RUN}-auth2.csv`,
        format: 'csv',
        delimiter: ',',
        quoteChar: '"',
        deliveryMode: 'delta',
        authKind: 'none',
        authCiphertext: 'v1:aa:bb:cc',
        createdByOxyUserId: `operator-${RUN}`,
      }),
      /auth_shape_check/u,
    );
  });
});
