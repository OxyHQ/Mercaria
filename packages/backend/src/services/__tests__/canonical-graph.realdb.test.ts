/**
 * The canonical organization/brand graph, against a REAL PostgreSQL database.
 *
 * The properties pinned here are exactly the ones a mock cannot see (#53
 * acceptance 6): slug uniqueness is a real unique index refusing a real
 * insert; the alias collision gate is the GENERATED `normalized_alias` column
 * plus its compound unique; observation convergence is `ON CONFLICT DO
 * NOTHING` against the content-hash identity; and the trigram candidate search
 * only runs if `pg_trgm` really reached `REQUIRED_EXTENSIONS`.
 *
 * Acceptance criteria mapped to tests:
 *  1. "Apple and similarly named brands cannot merge from normalization
 *     alone" — two brands whose normalized names COLLIDE coexist untouched
 *     while candidate search surfaces both.
 *  2. "Every imported field traces to a source record" — the applied field,
 *     its link and its record are read back from one transaction's output.
 *  3. "Alias lookup resolves to one id or an explicit ambiguity" — the same
 *     alias on two brands answers `ambiguous`, never a silent first match.
 *  4. "Merge redirects preserve references" is NOT covered here any more. It
 *     was #56's direct `mergeBrands`/`mergeOrganizations`, retired by #36
 *     completion criterion 4; the merge JOB that replaced them is driven by
 *     `services/curation/__tests__/curation-writes.realdb.test.ts`, which
 *     covers the same property plus the conflict gate, replay and split-back.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway database serves the whole suite and vitest runs files in
 * parallel workers, so every name, slug, alias and vendor this file writes
 * carries the per-run suffix and teardown deletes exactly what it created.
 * The vendor-extraction assertions are scoped to THIS file's vendor strings —
 * sibling files legitimately create listings concurrently, so global counts
 * are never asserted.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, count, eq, inArray, isNotNull } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { listings } from '../../db/schema/catalog.js';
import { brandAliases, brands, organizations } from '../../db/schema/organizations.js';
import { catalogSources, sourceRecords } from '../../db/schema/provenance.js';
import {
  ensureCatalogSource,
  type CatalogSourceRow,
} from '../../db/canonical/provenanceRepository.js';
import { insertBrandAlias, listBrandAliases, listBrandSourceLinks } from '../../db/canonical/brandRepository.js';
import {
  applyBrandSourceObservation,
  createBrand,
  getPublicBrand,
  resolveBrandAlias,
  searchBrandCandidates,
  findBrandIdsBySourceObject,
  updateBrand,
} from '../canonical/brand.service.js';
import {
  addVerifiedOrganizationDomain,
  applyOrganizationSourceObservation,
  createOrganization,
  findOrganizationIdsByVerifiedDomain,
} from '../canonical/organization.service.js';
import {
  extractVendorBrandCandidates,
  VENDOR_BACKFILL_SOURCE,
} from '../canonical/vendor-brand-candidate.service.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const createdBrandIds: string[] = [];
const createdOrganizationIds: string[] = [];
const createdSourceIds: string[] = [];
const createdSourceRecordIds: string[] = [];
const createdListingIds: string[] = [];
const createdVendorExternalIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  const brandIds = createdBrandIds.splice(0);
  const organizationIds = createdOrganizationIds.splice(0);
  const sourceIds = createdSourceIds.splice(0);
  const recordIds = createdSourceRecordIds.splice(0);
  const listingIds = createdListingIds.splice(0);
  const vendorExternalIds = createdVendorExternalIds.splice(0);

  // Aliases and links CASCADE from their entity; tombstones reference their
  // winner RESTRICT, so they go first.
  if (brandIds.length > 0) {
    await db.delete(brands).where(and(inArray(brands.id, brandIds), isNotNull(brands.mergedIntoId)));
    await db.delete(brands).where(inArray(brands.id, brandIds));
  }
  if (organizationIds.length > 0) {
    await db
      .delete(organizations)
      .where(and(inArray(organizations.id, organizationIds), isNotNull(organizations.mergedIntoId)));
    await db.delete(organizations).where(inArray(organizations.id, organizationIds));
  }
  if (vendorExternalIds.length > 0) {
    // The backfill registry row is shared by name; only THIS file's records
    // under it are ours to delete.
    const backfill = await db
      .select({ id: catalogSources.id })
      .from(catalogSources)
      .where(eq(catalogSources.name, VENDOR_BACKFILL_SOURCE.name))
      .limit(1);
    const backfillId = backfill[0]?.id;
    if (backfillId !== undefined) {
      await db
        .delete(sourceRecords)
        .where(
          and(
            eq(sourceRecords.sourceId, backfillId),
            inArray(sourceRecords.externalId, vendorExternalIds),
          ),
        );
    }
  }
  if (recordIds.length > 0) {
    await db.delete(sourceRecords).where(inArray(sourceRecords.id, recordIds));
  }
  if (sourceIds.length > 0) {
    await db.delete(sourceRecords).where(inArray(sourceRecords.sourceId, sourceIds));
    await db.delete(catalogSources).where(inArray(catalogSources.id, sourceIds));
  }
  if (listingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, listingIds));
  }
});

/**
 * Assert a write was refused by ONE NAMED constraint. Drizzle wraps the server
 * error ("Failed query: …") with the PostgresError as its `cause`, so the
 * constraint name has to be dug out of the cause chain — a bare
 * `rejects.toThrow(/name/)` matches nothing and would force the assertion down
 * to "something threw", which passes for the wrong refusal too.
 */
async function expectConstraintViolation(
  promise: Promise<unknown>,
  constraint: string,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught, `expected a violation of ${constraint}, but the write succeeded`).toBeDefined();

  const seen = new Set<unknown>();
  let matched = false;
  let current: unknown = caught;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const named = current as Error & { constraint_name?: string };
    if (named.constraint_name === constraint || current.message.includes(constraint)) {
      matched = true;
      break;
    }
    current = current.cause;
  }
  expect(matched, `expected a violation of ${constraint}, got: ${String(caught)}`).toBe(true);
}

function trackBrand<T extends { id: string }>(brand: T): T {
  createdBrandIds.push(brand.id);
  return brand;
}

function trackOrganization<T extends { id: string }>(organization: T): T {
  createdOrganizationIds.push(organization.id);
  return organization;
}

async function makeTestSource(name: string): Promise<CatalogSourceRow> {
  const source = await ensureCatalogSource(db, {
    kind: 'feed',
    name: `${name}-${RUN}`,
    mayDisplay: true,
    mayStore: true,
    attributionRequired: false,
  });
  createdSourceIds.push(source.id);
  return source;
}

describe('uniqueness (real unique indexes)', () => {
  it('refuses a duplicate brand slug and a duplicate organization slug', async () => {
    trackBrand(await createBrand({ name: `Zephyr ${RUN}`, slug: `zephyr-${RUN}` }));
    await expect(createBrand({ name: `Zephyr Two ${RUN}`, slug: `zephyr-${RUN}` })).rejects.toThrow(
      /already exists/,
    );

    trackOrganization(
      await createOrganization({ name: `Zephyr Org ${RUN}`, slug: `zephyr-org-${RUN}` }),
    );
    await expect(
      createOrganization({ name: `Zephyr Org Two ${RUN}`, slug: `zephyr-org-${RUN}` }),
    ).rejects.toThrow(/already exists/);
  });
});

describe('aliases (generated column + compound unique)', () => {
  it('normalizes through the GENERATED column and converges alias collisions per entity', async () => {
    const brand = trackBrand(await createBrand({ name: `Lumen ${RUN}` }));

    const alias = await insertBrandAlias(db, {
      brandId: brand.id,
      alias: `  LUMEN-X-${RUN}  `,
      kind: 'name_variant',
    });
    // lower(btrim(...)) applied by the DATABASE, not by the caller.
    expect(alias?.normalizedAlias).toBe(`lumen-x-${RUN}`);

    // A different spelling of the same normalization converges — no second row.
    const repeat = await insertBrandAlias(db, {
      brandId: brand.id,
      alias: `lumen-x-${RUN}`,
      kind: 'misspelling',
    });
    expect(repeat).toBeUndefined();
    const rows = await db
      .select({ n: count() })
      .from(brandAliases)
      .where(and(eq(brandAliases.brandId, brand.id), eq(brandAliases.normalizedAlias, `lumen-x-${RUN}`)));
    expect(rows[0]?.n).toBe(1);
  });

  it('resolves an alias to ONE id, and a cross-brand collision to an EXPLICIT ambiguity', async () => {
    const one = trackBrand(await createBrand({ name: `Meridian ${RUN}` }));
    const two = trackBrand(await createBrand({ name: `Meridian Two ${RUN}` }));

    await insertBrandAlias(db, { brandId: one.id, alias: `unique-mark-${RUN}`, kind: 'name_variant' });
    expect(await resolveBrandAlias(`Unique-Mark-${RUN}`)).toEqual({
      kind: 'resolved',
      id: one.id,
    });

    // The SAME alias on a second brand: per-entity uniqueness permits it, and
    // resolution must now say so out loud rather than picking a winner.
    await insertBrandAlias(db, { brandId: two.id, alias: `unique-mark-${RUN}`, kind: 'name_variant' });
    expect(await resolveBrandAlias(`unique-mark-${RUN}`)).toEqual({
      kind: 'ambiguous',
      candidateIds: [one.id, two.id].sort(),
    });

    expect(await resolveBrandAlias(`nothing-here-${RUN}`)).toEqual({ kind: 'none' });
  });
});

describe('normalization generates candidates, never merges (acceptance 1)', () => {
  it('keeps two brands with colliding normalized names as two rows and surfaces both as candidates', async () => {
    const plain = trackBrand(await createBrand({ name: `Apfel ${RUN}` }));
    const suffixed = trackBrand(await createBrand({ name: `Apfel ${RUN} Inc.`, slug: `apfel-${RUN}-inc` }));

    // The collapse happened (both normalize identically)…
    expect(plain.normalizedName).toBe(suffixed.normalizedName);

    // …and produced CANDIDATES, not a merge: both rows live, both surfaced.
    const candidates = await searchBrandCandidates(`Apfel ${RUN}`);
    const ids = candidates.map((entry) => entry.brandId);
    expect(ids).toContain(plain.id);
    expect(ids).toContain(suffixed.id);

    const rows = await db.select().from(brands).where(inArray(brands.id, [plain.id, suffixed.id]));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'active')).toBe(true);
  });

  it('finds typo candidates through the pg_trgm index', async () => {
    const brand = trackBrand(await createBrand({ name: `Bergamot ${RUN}` }));

    // Would fail with "operator does not exist: text % text" if pg_trgm had
    // not reached REQUIRED_EXTENSIONS — this is the extension-wiring pin.
    const candidates = await searchBrandCandidates(`Bergamt ${RUN}`);
    const match = candidates.find((entry) => entry.brandId === brand.id);
    expect(match?.matchedVia).toBe('name_similarity');
    expect(match && match.score > 0 && match.score < 1).toBe(true);
  });
});

describe('provenance (acceptance 2) and the source-upsert rules', () => {
  it('applies fields with their record and link in one transaction, and converges on repeat', async () => {
    const source = await makeTestSource('feed-alpha');
    const brand = trackBrand(await createBrand({ name: `Quartz ${RUN}` }));

    const observedAt = new Date('2026-08-01T12:00:00.000Z');
    const first = await applyBrandSourceObservation({
      brandId: brand.id,
      sourceId: source.id,
      externalId: `quartz-${RUN}`,
      observedAt,
      method: 'connector_declared',
      matchRule: 'connector:declared-brand',
      fields: {
        description: 'A quartz brand.',
        websiteUrl: `https://quartz-${RUN}.example`,
        domains: [`https://www.quartz-${RUN}.example/shop`],
      },
    });

    expect(first.newObservation).toBe(true);
    expect(first.applied.sort()).toEqual(['description', 'observedDomains', 'websiteUrl']);
    expect(first.conflicts).toEqual([]);
    expect(first.brand.description).toBe('A quartz brand.');
    expect(first.brand.observedDomains).toEqual([`quartz-${RUN}.example`]);
    expect(first.brand.lastSeenAt?.toISOString()).toBe(observedAt.toISOString());

    // Every imported field traces to a record: the link names the record, the
    // record carries the asserted payload, and both were committed with the
    // field application.
    const links = await listBrandSourceLinks(db, brand.id, 'active');
    expect(links).toHaveLength(1);
    expect(links[0]?.sourceRecordId).toBe(first.sourceRecordId);
    expect(links[0]?.matchRule).toBe('connector:declared-brand');
    const record = await db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.id, first.sourceRecordId));
    expect(record[0]?.payload).toMatchObject({ description: 'A quartz brand.' });

    // Identical content re-applied is a genuine no-op: same record, no new row.
    const repeat = await applyBrandSourceObservation({
      brandId: brand.id,
      sourceId: source.id,
      externalId: `quartz-${RUN}`,
      observedAt,
      method: 'connector_declared',
      matchRule: 'connector:declared-brand',
      fields: {
        description: 'A quartz brand.',
        websiteUrl: `https://quartz-${RUN}.example`,
        domains: [`https://www.quartz-${RUN}.example/shop`],
      },
    });
    expect(repeat.newObservation).toBe(false);
    expect(repeat.sourceRecordId).toBe(first.sourceRecordId);
    const recordCount = await db
      .select({ n: count() })
      .from(sourceRecords)
      .where(eq(sourceRecords.sourceId, source.id));
    expect(recordCount[0]?.n).toBe(1);
  });

  it('never overwrites with a lower-confidence source, and routes conflicts to review', async () => {
    const source = await makeTestSource('feed-beta');
    const brand = trackBrand(await createBrand({ name: `Basalt ${RUN}` }));

    await applyBrandSourceObservation({
      brandId: brand.id,
      sourceId: source.id,
      externalId: `basalt-${RUN}`,
      observedAt: new Date('2026-08-01T00:00:00.000Z'),
      method: 'connector_declared',
      matchRule: 'connector:declared-brand',
      fields: { description: 'The strong description.' },
    });

    // Weaker source, different value: recorded, linked, NOT applied.
    const weaker = await applyBrandSourceObservation({
      brandId: brand.id,
      sourceId: source.id,
      externalId: `basalt-weak-${RUN}`,
      observedAt: new Date('2026-08-02T00:00:00.000Z'),
      method: 'heuristic',
      matchRule: 'heuristic:name-similarity',
      confidence: 0.4,
      fields: { description: 'A weaker opinion.' },
    });
    expect(weaker.applied).toEqual([]);
    expect(weaker.conflicts).toEqual([
      { field: 'description', reason: 'lower_confidence', sourceValue: 'A weaker opinion.' },
    ]);
    expect(weaker.brand.description).toBe('The strong description.');
    // The refused observation still left its evidence for review.
    expect(await listBrandSourceLinks(db, brand.id, 'active')).toHaveLength(2);
  });

  it('respects operator pins, and keeps a differing source name as an alias instead of a rename', async () => {
    const source = await makeTestSource('feed-gamma');
    const brand = trackBrand(await createBrand({ name: `Cobalt ${RUN}` }));

    await updateBrand(brand.id, { description: 'Operator wrote this.', actorOxyUserId: 'oxy-op-1' });

    const applied = await applyBrandSourceObservation({
      brandId: brand.id,
      sourceId: source.id,
      externalId: `cobalt-${RUN}`,
      observedAt: new Date('2026-08-03T00:00:00.000Z'),
      method: 'connector_declared',
      matchRule: 'connector:declared-brand',
      fields: { description: 'Source wants this instead.', name: `Cobalt Prime ${RUN}` },
    });

    expect(applied.conflicts).toEqual(
      expect.arrayContaining([
        { field: 'description', reason: 'pinned', sourceValue: 'Source wants this instead.' },
        { field: 'name', reason: 'conflicting_name', sourceValue: `Cobalt Prime ${RUN}` },
      ]),
    );
    expect(applied.brand.description).toBe('Operator wrote this.');
    expect(applied.brand.name).toBe(`Cobalt ${RUN}`);

    // Rule 4: the source's name survives as an alias citing its record.
    const aliases = await listBrandAliases(db, brand.id);
    const minted = aliases.find((alias) => alias.alias === `Cobalt Prime ${RUN}`);
    expect(minted?.kind).toBe('name_variant');
    expect(minted?.sourceRecordId).toBe(applied.sourceRecordId);
  });

  it('reverse-looks-up an entity from a source object id', async () => {
    const source = await makeTestSource('feed-delta');
    const brand = trackBrand(await createBrand({ name: `Garnet ${RUN}` }));
    await applyBrandSourceObservation({
      brandId: brand.id,
      sourceId: source.id,
      externalId: `garnet-${RUN}`,
      observedAt: new Date('2026-08-04T00:00:00.000Z'),
      method: 'connector_declared',
      matchRule: 'connector:declared-brand',
      fields: { description: 'Found by source id.' },
    });

    expect(await findBrandIdsBySourceObject(source.id, `garnet-${RUN}`)).toEqual([brand.id]);
  });
});

/**
 * The `merge (acceptance 4, ADR 0002 D12/D16)` block was DELETED with
 * `mergeBrands`/`mergeOrganizations`, the routeless direct merges #36
 * completion criterion 4 retired. A brand or organization merge is now
 * `POST /internal/commerce-graph/merge-jobs`, whose runner
 * `services/curation/__tests__/curation-writes.realdb.test.ts` drives end to
 * end and whose per-entity column coverage `merge-plan-census.test.ts` walks
 * out of the schema rather than out of a hand-written case list.
 */

describe('organization domains: verified is a decision, never an observation', () => {
  it('routes observed domains to review and only the explicit writer verifies', async () => {
    const source = await makeTestSource('feed-org');
    const organization = trackOrganization(await createOrganization({ name: `Vantage ${RUN}` }));

    const applied = await applyOrganizationSourceObservation({
      organizationId: organization.id,
      sourceId: source.id,
      externalId: `vantage-${RUN}`,
      observedAt: new Date('2026-08-06T00:00:00.000Z'),
      method: 'connector_declared',
      matchRule: 'connector:declared-merchant',
      fields: { domains: [`vantage-${RUN}.example`] },
    });

    expect(applied.conflicts).toEqual([
      {
        field: 'domains',
        reason: 'domain_requires_verification',
        sourceValue: `vantage-${RUN}.example`,
      },
    ]);
    expect(applied.organization.verifiedDomains).toEqual([]);
    expect(await findOrganizationIdsByVerifiedDomain(`vantage-${RUN}.example`)).toEqual([]);

    await addVerifiedOrganizationDomain({
      organizationId: organization.id,
      domain: `https://www.vantage-${RUN}.example/about`,
      actorOxyUserId: 'oxy-op-1',
    });
    expect(await findOrganizationIdsByVerifiedDomain(`vantage-${RUN}.example`)).toEqual([
      organization.id,
    ]);
  });
});

describe('public DTOs expose verified facts and safe freshness only', () => {
  it('carries no internal review or matching state', async () => {
    const source = await makeTestSource('feed-public');
    const brand = trackBrand(await createBrand({ name: `Onyx ${RUN}` }));
    await applyBrandSourceObservation({
      brandId: brand.id,
      sourceId: source.id,
      externalId: `onyx-${RUN}`,
      observedAt: new Date('2026-08-07T00:00:00.000Z'),
      method: 'connector_declared',
      matchRule: 'connector:declared-brand',
      confidence: 0.9,
      fields: { description: 'Public-facing.' },
    });

    const dto = await getPublicBrand(brand.id);
    expect(dto).toBeDefined();
    if (!dto) return;
    expect(dto.freshness).toEqual({
      sourceKind: 'feed',
      observedAt: '2026-08-07T00:00:00.000Z',
    });
    const keys = Object.keys(dto);
    for (const internal of ['pinnedFields', 'normalizedName', 'confidence', 'matchRule']) {
      expect(keys).not.toContain(internal);
    }
  });
});

describe('vendor extraction (#53 migration, D23 phase 1)', () => {
  it('records candidates as provenance, mints no brand, leaves vendor readable, and re-runs converge', async () => {
    const vendorA = `Vela ${RUN}`;
    const vendorB = `VELA ${RUN} Inc.`;
    const vendorSolo = `Sirius ${RUN}`;
    const normalizedVela = `vela ${RUN}`.toLowerCase();
    const normalizedSirius = `sirius ${RUN}`.toLowerCase();
    createdVendorExternalIds.push(normalizedVela, normalizedSirius);

    for (const vendor of [vendorA, vendorB, vendorSolo]) {
      const inserted = await db
        .insert(listings)
        .values({
          ownerType: 'user',
          oxyUserId: `oxy-user-${RUN}`,
          title: `Listing for ${vendor}`,
          description: 'A vendor-extraction fixture.',
          condition: 'used_good',
          conditionAssertion: 'seller_declared',
          vendor,
        })
        .returning({ id: listings.id });
      const id = inserted[0]?.id;
      if (id !== undefined) createdListingIds.push(id);
    }

    const result = await extractVendorBrandCandidates();

    const vela = result.candidates.find((entry) => entry.normalizedName === normalizedVela);
    expect(vela).toBeDefined();
    expect(vela?.displayForms).toEqual([vendorB, vendorA].sort());
    expect(vela?.listingCount).toBe(2);
    expect(vela?.ambiguous).toBe(true);
    expect(vela?.reviewReasons).toContain('multiple_display_forms');

    const sirius = result.candidates.find((entry) => entry.normalizedName === normalizedSirius);
    expect(sirius?.ambiguous).toBe(false);

    // No brand was minted — candidates are provenance, not entities.
    const mintedBrands = await db
      .select({ n: count() })
      .from(brands)
      .where(inArray(brands.normalizedName, [normalizedVela, normalizedSirius]));
    expect(mintedBrands[0]?.n).toBe(0);

    // The original vendor strings are untouched.
    const vendorsBack = await db
      .select({ vendor: listings.vendor })
      .from(listings)
      .where(inArray(listings.id, [...createdListingIds]));
    expect(vendorsBack.map((row) => row.vendor).sort()).toEqual([vendorA, vendorB, vendorSolo].sort());

    // The durable evidence exists under the registered backfill source…
    const backfill = await db
      .select()
      .from(catalogSources)
      .where(eq(catalogSources.name, VENDOR_BACKFILL_SOURCE.name));
    expect(backfill[0]?.kind).toBe('backfill');
    const backfillId = backfill[0]?.id;
    expect(backfillId).toBeDefined();
    if (backfillId === undefined) return;

    const evidence = await db
      .select()
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.sourceId, backfillId),
          inArray(sourceRecords.externalId, [normalizedVela, normalizedSirius]),
        ),
      );
    expect(evidence).toHaveLength(2);
    expect(evidence.find((row) => row.externalId === normalizedVela)?.payload).toMatchObject({
      candidateKind: 'listing_vendor',
      listingCount: 2,
      ambiguous: true,
    });

    // …and a re-run against the unchanged catalogue adds nothing.
    await extractVendorBrandCandidates();
    const after = await db
      .select({ n: count() })
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.sourceId, backfillId),
          inArray(sourceRecords.externalId, [normalizedVela, normalizedSirius]),
        ),
      );
    expect(after[0]?.n).toBe(2);
  });
});

describe('lifecycle guards', () => {
  it('refuses updating a tombstone', async () => {
    const winner = trackBrand(await createBrand({ name: `Iris ${RUN}` }));
    const loser = trackBrand(await createBrand({ name: `Iris Two ${RUN}` }));
    // Stamped directly rather than through a merge: the guard under test belongs
    // to `updateBrand` and is about the ROW's state, so it must hold whoever
    // wrote the tombstone — a curation merge job, a repair, or `psql`.
    await db
      .update(brands)
      .set({ status: 'merged', mergedIntoId: winner.id })
      .where(eq(brands.id, loser.id));

    await expect(
      updateBrand(loser.id, { description: 'nope', actorOxyUserId: 'oxy-op-1' }),
    ).rejects.toThrow(/merged/);
  });

  it('the database refuses a tombstone without a target and a self-redirect outright', async () => {
    const brand = trackBrand(await createBrand({ name: `Umbra ${RUN}` }));
    await expectConstraintViolation(
      db.update(brands).set({ status: 'merged' }).where(eq(brands.id, brand.id)),
      'brands_merged_state_check',
    );
    await expectConstraintViolation(
      db
        .update(brands)
        .set({ status: 'merged', mergedIntoId: brand.id })
        .where(eq(brands.id, brand.id)),
      'brands_merged_into_self_check',
    );
  });

  it('a stored sha-256 must look like one', async () => {
    const source = await makeTestSource('feed-hash');
    await expectConstraintViolation(
      db.insert(sourceRecords).values({
        sourceId: source.id,
        externalType: 'brand',
        externalId: `bad-hash-${RUN}`,
        observedAt: new Date(),
        contentHash: 'not-a-hash',
      }),
      'source_records_content_hash_shape_check',
    );
  });
});
