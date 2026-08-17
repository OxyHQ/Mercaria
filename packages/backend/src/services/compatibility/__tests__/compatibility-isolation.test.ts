/**
 * The walls around the compatibility and automotive-fitment domain, as SCANS
 * rather than conventions (#367 step 8, ADR 0007 D8).
 *
 * ## The one that matters
 *
 * D8: **a year range, a make or a model may never be stored as a variant
 * option.** One brake-pad SKU fits a thousand vehicles and stays ONE variant;
 * expressed as options it is a thousand variants, a thousand rows of stock
 * nobody counts and a canonical variant signature that describes a car rather
 * than a part. Two independent walls hold it, in opposite directions:
 *
 * - **No module of this domain can write an option row.** Not by policy — by
 *   the import graph: nothing under `services/compatibility/` or
 *   `db/compatibility/` may name `listing_options`,
 *   `product_variant_option_values`, their drizzle constants, or the two
 *   repositories that write them.
 * - **No option-writing module can reach this domain**, so a vehicle fact
 *   cannot arrive at those tables through the front door either.
 *
 * A third wall is a schema census: the real drizzle columns of both option
 * tables are walked and none may be named for one of
 * `COMPATIBILITY_FORBIDDEN_VARIANT_AXIS_FACTS`. It is deliberately stated as a
 * COLUMN census and nothing more, because the option tables store their axis in
 * a free-text `name`, and no static gate can see a VALUE. The value-level
 * guarantee is the first wall — the domain has no writer — and this one catches
 * the other shape of the same mistake: somebody adding
 * `listing_options.vehicle_generation_id` because it seemed like the tidy place
 * for it.
 *
 * Every detector carries the two defences `~/Oxy/AGENTS.md` requires of a gate:
 * a VACUITY FLOOR (the scanned set must exist and be non-trivial, so a moved or
 * emptied file fails the gate instead of passing it by having nothing to match)
 * and a MUTATION SELF-TEST (each pattern is run against a seeded positive and a
 * seeded negative, so a regex that rotted cannot pass by matching nothing).
 *
 * Reachability detectors scan COMMENT-STRIPPED source — `checkout-contact-isolation.test.ts`'s
 * rule — because these modules document at length what they refuse to do, in
 * exactly the vocabulary the detectors look for.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import {
  COMPATIBILITY_APPLICABILITIES,
  COMPATIBILITY_FORBIDDEN_SUBJECT_FACTS,
  COMPATIBILITY_FORBIDDEN_VARIANT_AXIS_FACTS,
  COMPATIBILITY_FORBIDDEN_VERIFICATION_METHODS,
  COMPATIBILITY_FORBIDDEN_VIEW_FIELDS,
  COMPATIBILITY_VERIFICATION_METHODS,
  FITMENT_TARGET_SCOPES,
} from '@mercaria/shared-types';
import { listingOptions, productVariantOptionValues } from '../../../db/schema/catalog.js';
import {
  automotiveFitments,
  compatibilityClaims,
  genericCompatibilityRelations,
  vehicleConfigurations,
  vehicleGenerations,
  vehicleMakes,
  vehicleModels,
} from '../../../db/schema/compatibility.js';
import { projectAutomotiveFitment, projectCompatibilityRelation } from '../projection.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every file of the domain, enumerated from the real directories. */
function enumerateDomain(): string[] {
  // RECURSIVE. The previous walk did `if (statSync(full).isDirectory()) continue;`
  // — it explicitly SKIPPED subdirectories, which is the shape #472 found hiding
  // `services/ingestion/adapters/`, five provider modules behind no wall at all.
  // Both roots are flat today; the point is that a subdirectory added tomorrow is
  // covered without anybody remembering to come here.
  const walk = (absolute: string): string[] => {
    const found: string[] = [];
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) found.push(...walk(child));
      else if (entry.name.endsWith('.ts')) found.push(child);
    }
    return found;
  };
  const files = [
    ...walk(join(SRC_ROOT, 'services', 'compatibility')),
    ...walk(join(SRC_ROOT, 'db', 'compatibility')),
  ];
  // The schema module, derived by the filename convention rather than named, so
  // a second compatibility schema file is covered too. This domain has no HTTP
  // surface — checked against the tree, not assumed: nothing in `controllers/`,
  // `routes/` or `middleware/` is named for it.
  for (const entry of readdirSync(join(SRC_ROOT, 'db', 'schema'), { withFileTypes: true })) {
    if (entry.isFile() && /^compatibility.*\.ts$/.test(entry.name)) {
      files.push(join(SRC_ROOT, 'db', 'schema', entry.name));
    }
  }
  return files;
}

/**
 * The enumeration FLOOR, read off the real directories rather than hard-coded as
 * a list of names.
 *
 * A file that moves out of the domain shrinks the scanned set silently, and a
 * shrinking scan looks exactly like a clean one — so the count is asserted, and
 * raising it when the domain grows is the point rather than an annoyance.
 */
const MINIMUM_DOMAIN_FILES = 9;

/** Strip comments, so a module that DESCRIBES what it refuses is not read as doing it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * A variant OPTION, in any of the four spellings that reach one.
 *
 * Both SQL table names, both drizzle constants, and the two repositories that
 * own the writes. The repository paths are in the pattern because importing
 * `insertVariants` reaches the option write without ever naming the table.
 */
const OPTION_WRITE_REFERENCE =
  /listing_options|product_variant_option_values|listingOptions|productVariantOptionValues|catalog\/listingRepository|catalog\/variantRepository|catalog-write\.service/;

/** The compatibility domain, from the other direction. */
const COMPATIBILITY_REFERENCE =
  /compatibility\/|generic_compatibility_relations|automotive_fitments|compatibility_claims|vehicle_makes|vehicle_models|vehicle_generations|vehicle_configurations|genericCompatibilityRelations|automotiveFitments|resolveFitment/;

/** Ranking — #74's, behind its versioned policy (ADR 0007 non-goals). */
const RANKING_REFERENCE =
  /services\/ranking\/|rankingPolicy|ranking_policy_versions|rankOffers|scoreListing|boostScore|(^|[/'"])(feed|search)\.service/;

/** A price, an offer or a payment rail — a fit is not a sale. */
const COMMERCE_REFERENCE =
  /(^|[/'"])payments\/|checkout\/|checkout-payment|checkout\.service|PaymentIntent|ledger_entries|priceAmount|offer_price_snapshots|listOffersForComparison/;

/** The brand-relationship layer — #55's, and a different kind of claim. */
const RELATIONSHIP_REFERENCE =
  /commerce_relationships|relationship_evidence|relationship_reviews|commerceRelationships|SUFFICIENT_EVIDENCE_KINDS/;

/** The modules that legitimately DO write an option row. Scanned in reverse. */
const OPTION_WRITER_PATHS = [
  'db/catalog/listingRepository.ts',
  'db/catalog/variantRepository.ts',
  'services/backfill/stages/provisional-products.ts',
];

describe('the compatibility domain cannot reach what it must not', () => {
  const files = enumerateDomain();

  it('scans a domain that has not silently shrunk', () => {
    // Vacuity floors PER SHAPE rather than one on the total: the three sources
    // break independently, and a single total on 9 would let the service walk
    // collapse to zero while the repositories carried the number.
    const from = (segment: string) => files.filter((file) => file.includes(segment)).length;
    expect(from('/services/compatibility/'), 'the service walk found nothing').toBeGreaterThanOrEqual(4);
    expect(from('/db/compatibility/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(4);
    expect(from('/db/schema/compatibility'), 'the schema derivation found nothing').toBeGreaterThanOrEqual(1);
    expect(files.length).toBeGreaterThanOrEqual(MINIMUM_DOMAIN_FILES);
    // No test file may enter the scanned set: a gate that scans its own probes
    // reports violations it wrote itself.
    expect(files.filter((file) => file.includes('__tests__'))).toEqual([]);
    for (const file of files) {
      // The vacuity floor: an empty or moved file must fail here, not pass the
      // scans below by having nothing to match.
      expect(
        readFileSync(file, 'utf8').length,
        `${file} looks empty — did it move?`,
      ).toBeGreaterThan(200);
    }
  });

  it('has no writer for a variant option — ADR 0007 D8, the acceptance scenario', () => {
    for (const file of files) {
      expect(
        OPTION_WRITE_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches the variant-option path; a brake pad that fits a thousand vehicles ` +
          'is ONE variant, and a year range, a make or a model may never be stored as an option',
      ).toBe(false);
    }
  });

  it('is not reachable FROM an option writer either', () => {
    let scanned = 0;
    for (const relative of OPTION_WRITER_PATHS) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        COMPATIBILITY_REFERENCE.test(stripComments(source)),
        `${relative} writes option rows and references the compatibility domain; ` +
          'that is the front door for the fact D8 forbids',
      ).toBe(false);
      scanned += 1;
    }
    // EXACT, not `scanned === length`: that comparison is circular (the loop
    // increments once per entry, so it holds for ANY list including an empty
    // one). This list names modules in OTHER domains that legitimately write an
    // option row, so it stays a hand list — a walk of `db/catalog/` would pull in
    // every unrelated repository — but an unbounded one is a predicate rather
    // than an identity (#448).
    expect(OPTION_WRITER_PATHS.length, 'the option-writer list changed size').toBe(3);
    expect(scanned).toBe(OPTION_WRITER_PATHS.length);
  });

  it('reads no ranking module — that is #74', () => {
    for (const file of files) {
      expect(
        RANKING_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches ranking; "fits your vehicle" is an eligibility fact, not a weight`,
      ).toBe(false);
    }
  });

  it('reads no price, offer or payment rail — a fit is not a sale', () => {
    for (const file of files) {
      expect(
        COMMERCE_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches commerce; a fitment says a part goes on a car and says nothing ` +
          'about whether anybody is selling it today',
      ).toBe(false);
    }
  });

  it('does not reuse the brand-relationship layer — a fit is not a badge', () => {
    for (const file of files) {
      expect(
        RELATIONSHIP_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches #55's relationship layer; sharing that vocabulary would make ` +
          '`verified` mean two things — a badge on one side and a fit on the other',
      ).toBe(false);
    }
  });
});

describe('no vehicle fact can become a variant axis — the schema census', () => {
  /**
   * The two option tables' REAL drizzle columns.
   *
   * `sqlColumnName`, never `column.name` — the latter is the TypeScript property
   * (`listingId`) and an `endsWith('_id')` or a name comparison against it
   * silently matches nothing, which is a check that passes vacuously.
   */
  const optionColumns = [listingOptions, productVariantOptionValues].flatMap((table) =>
    getTableConfig(table).columns.map((column) => ({
      table: getTableConfig(table).name,
      column: sqlColumnName(column),
    })),
  );

  it('walks a non-empty column set', () => {
    // The vacuity floor. Both tables have six columns today; a census over an
    // empty set is a gate that can never fail.
    expect(optionColumns.length).toBeGreaterThanOrEqual(10);
  });

  it('names no vehicle, year or fitment fact in either option table', () => {
    for (const { table, column } of optionColumns) {
      for (const forbidden of COMPATIBILITY_FORBIDDEN_VARIANT_AXIS_FACTS) {
        expect(
          column.includes(forbidden),
          `${table}.${column} names \`${forbidden}\`; ADR 0007 D8 forbids a vehicle fact ` +
            'as a variant option, and a column is the tidy-looking way it arrives',
        ).toBe(false);
      }
    }
  });

  it('the prohibition list is non-empty and disjoint from what this domain does store', () => {
    // A vacuity floor on the LIST itself: an empty prohibition passes every
    // check above while forbidding nothing.
    expect(COMPATIBILITY_FORBIDDEN_VARIANT_AXIS_FACTS.length).toBeGreaterThanOrEqual(10);
    // And a positive control: these ARE the columns this domain stores, so the
    // census above would fire if the option tables ever grew one.
    const compatibilityColumns = getTableConfig(automotiveFitments).columns.map((column) =>
      sqlColumnName(column),
    );
    expect(compatibilityColumns).toContain('vehicle_generation_id');
    expect(compatibilityColumns).toContain('vehicle_configuration_id');
  });
});

describe('no compatibility table can hold a person or a physical car', () => {
  const domainTables = [
    genericCompatibilityRelations,
    compatibilityClaims,
    automotiveFitments,
    vehicleMakes,
    vehicleModels,
    vehicleGenerations,
    vehicleConfigurations,
  ];

  it('walks all seven tables', () => {
    expect(domainTables.length).toBe(7);
    for (const table of domainTables) {
      expect(getTableConfig(table).columns.length).toBeGreaterThan(4);
    }
  });

  /**
   * The ATTRIBUTION columns, exempt from the person census below — and the
   * exemption carries its own exact-count assertion, per the house rule that a
   * list of exemptions needs one.
   *
   * The distinction the census is actually making is between what a fit is
   * KEYED ON and who RECORDED it. An Oxy account id naming the operator who
   * verified a claim is the audit trail; an Oxy account id naming the person the
   * claim is about would make "does this fit" answerable differently for two
   * shoppers, which is what the prohibition exists to prevent. Three columns,
   * named, and nothing else.
   */
  const ATTRIBUTION_COLUMNS: readonly string[] = [
    'verified_by_oxy_user_id',
    'revoked_by_oxy_user_id',
    'reviewed_by_oxy_user_id',
  ];

  it('the attribution exemption is exactly three columns, and each really exists', () => {
    expect(ATTRIBUTION_COLUMNS.length).toBe(3);
    // A vacuity floor on the EXEMPTION itself: one naming a column that does not
    // exist excuses nothing while hiding that a real column went unexcused.
    const everyColumn = new Set(
      domainTables.flatMap((table) =>
        getTableConfig(table).columns.map((column) => sqlColumnName(column)),
      ),
    );
    for (const exempt of ATTRIBUTION_COLUMNS) {
      expect(everyColumn.has(exempt), `\`${exempt}\` is exempted and does not exist`).toBe(true);
    }
  });

  it('declares no VIN, plate, buyer, order or price column', () => {
    for (const table of domainTables) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        const name = sqlColumnName(column);
        if (ATTRIBUTION_COLUMNS.includes(name)) continue;
        for (const forbidden of COMPATIBILITY_FORBIDDEN_SUBJECT_FACTS) {
          expect(
            name === forbidden || name.endsWith(`_${forbidden}`),
            `${config.name}.${name} names \`${forbidden}\`; a VIN identifies one physical car ` +
              'with an owner attached, and a fit is not keyed on a person, an order or a price',
          ).toBe(false);
        }
      }
    }
    expect(COMPATIBILITY_FORBIDDEN_SUBJECT_FACTS.length).toBeGreaterThanOrEqual(6);
  });

  it('the person detector would fire on a subject column — the mutation self-test', () => {
    // Without this, the exemption above could grow until the census matched
    // nothing and still reported clean. Driven through the same comparison the
    // loop uses, on names the loop never receives.
    const fires = (name: string): boolean =>
      !ATTRIBUTION_COLUMNS.includes(name) &&
      COMPATIBILITY_FORBIDDEN_SUBJECT_FACTS.some(
        (forbidden) => name === forbidden || name.endsWith(`_${forbidden}`),
      );
    expect(fires('vin')).toBe(true);
    expect(fires('vehicle_vin')).toBe(true);
    expect(fires('subject_oxy_user_id')).toBe(true);
    expect(fires('order_id')).toBe(true);
    expect(fires('verified_by_oxy_user_id')).toBe(false);
    expect(fires('vehicle_generation_id')).toBe(false);
  });
});

describe('the vocabularies are disjoint where they claim to be', () => {
  it('no forbidden verification method is also a real one', () => {
    expect(COMPATIBILITY_FORBIDDEN_VERIFICATION_METHODS.length).toBeGreaterThanOrEqual(7);
    expect(COMPATIBILITY_VERIFICATION_METHODS.length).toBeGreaterThanOrEqual(6);
    for (const forbidden of COMPATIBILITY_FORBIDDEN_VERIFICATION_METHODS) {
      expect(
        (COMPATIBILITY_VERIFICATION_METHODS as readonly string[]).includes(forbidden),
        `\`${forbidden}\` is offered as a verification method; two names looking alike ` +
          'is exactly how a 2016 part gets published as fitting a 2017 car',
      ).toBe(false);
    }
  });

  it('applicability has four members and `unknown` is not `does_not_apply`', () => {
    // The distinction is the domain's central one, so it gets its own assertion
    // rather than relying on a tuple nobody re-reads.
    expect(COMPATIBILITY_APPLICABILITIES).toEqual([
      'applies',
      'partially_applies',
      'does_not_apply',
      'unknown',
    ]);
  });

  it('the fitment scope ladder is ordered broadest-first', () => {
    // Reverse this tuple and every exclusion in the database silently stops
    // applying, while every query still returns rows and every page renders.
    expect(FITMENT_TARGET_SCOPES).toEqual([
      'vehicle_make',
      'vehicle_model',
      'vehicle_generation',
      'vehicle_configuration',
    ]);
  });
});

describe('no compatibility DTO can carry provenance — the two-gate rule', () => {
  it('the shared-types module declares none of the forbidden fields', () => {
    const source = readFileSync(
      join(SRC_ROOT, '..', '..', 'shared-types', 'src', 'compatibility.ts'),
      'utf8',
    );
    expect(source.length).toBeGreaterThan(5_000);
    for (const field of COMPATIBILITY_FORBIDDEN_VIEW_FIELDS) {
      // The list itself is the one legitimate mention, so the check is on the
      // FIELD DECLARATION shape rather than on the bare name — otherwise the
      // prohibition would trip over stating itself.
      const declaration = new RegExp(`readonly\\s+${field}\\s*[?:]`);
      expect(declaration.test(source), `compatibility.ts declares \`${field}\``).toBe(false);
    }
    expect(COMPATIBILITY_FORBIDDEN_VIEW_FIELDS.length).toBeGreaterThanOrEqual(6);
  });

  /**
   * The RUNTIME half (#92's rule): a static scan proves the module does not
   * DECLARE a field, and only a walk of a real emitted object proves the
   * serializer does not ADD one. `projectCompatibilityRelation` is a spread away
   * from shipping every provenance column, so this is the gate that would catch
   * that edit.
   */
  it('a real emitted relation view carries no forbidden field', () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const view = projectCompatibilityRelation({
      id: 'rel_1',
      kind: 'accessory_for',
      direction: 'subject_to_target',
      subjectProductId: 'prod_case',
      subjectVariantId: null,
      targetKind: 'canonical_product',
      targetFamilyId: null,
      targetProductId: 'prod_phone',
      targetVariantId: null,
      targetType: null,
      targetKey: null,
      applicability: 'applies',
      conditionKinds: [],
      conditionNote: null,
      markets: ['ES'],
      validFrom: now,
      validTo: null,
      verification: 'verified',
      verificationMethod: 'manufacturer_publication',
      assertedByKind: 'manufacturer',
      assertedBySourceId: null,
      confidence: 0.99,
      verifiedAt: now,
      verifiedByOxyUserId: 'oxy_1',
      lastCheckedAt: null,
      revokedAt: null,
      revokedByOxyUserId: null,
      revokeReason: null,
      supersededById: null,
      note: null,
      createdAt: now,
      updatedAt: now,
      relationKey: 'prod_case||||prod_phone|||',
    });
    for (const field of COMPATIBILITY_FORBIDDEN_VIEW_FIELDS) {
      expect(Object.keys(view), `the emitted relation view carries \`${field}\``).not.toContain(
        field,
      );
    }
    // The positive control: the walk is over a real object with real keys, so an
    // empty projection cannot pass this block by carrying nothing.
    expect(Object.keys(view).length).toBeGreaterThanOrEqual(12);
    expect(view.target).toEqual({ kind: 'canonical_product', productId: 'prod_phone' });
  });

  it('a real emitted fitment view carries no forbidden field', () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const vehicleRow = {
      id: 'make_1',
      key: 'volkswagen',
      name: 'Volkswagen',
      countryCode: 'DE',
      status: 'active' as const,
      mergedIntoId: null,
      createdAt: now,
      updatedAt: now,
    };
    const view = projectAutomotiveFitment(
      {
        id: 'fit_1',
        subjectProductId: 'prod_pad',
        subjectVariantId: null,
        scope: 'vehicle_make',
        vehicleMakeId: 'make_1',
        vehicleModelId: null,
        vehicleGenerationId: null,
        vehicleConfigurationId: null,
        applicability: 'applies',
        position: 'front',
        qualifiers: [],
        conditionKinds: [],
        conditionNote: null,
        yearFrom: null,
        yearTo: null,
        quantityPerVehicle: 2,
        verification: 'verified',
        verificationMethod: 'manufacturer_publication',
        assertedByKind: 'manufacturer',
        assertedBySourceId: null,
        manufacturerReference: 'TD-99',
        manufacturerPublicationUrl: 'https://example.invalid/f',
        contentSha256: 'a'.repeat(64),
        sourceRecordId: null,
        confidence: null,
        observedAt: now,
        verifiedAt: now,
        verifiedByOxyUserId: 'oxy_1',
        lastCheckedAt: null,
        validFrom: now,
        validTo: null,
        revokedAt: null,
        revokedByOxyUserId: null,
        revokeReason: null,
        supersededById: null,
        note: null,
        createdAt: now,
        updatedAt: now,
        fitmentKey: 'prod_pad||make_1||||front',
      },
      { make: vehicleRow },
    );
    for (const field of COMPATIBILITY_FORBIDDEN_VIEW_FIELDS) {
      expect(Object.keys(view), `the emitted fitment view carries \`${field}\``).not.toContain(field);
    }
    expect(Object.keys(view).length).toBeGreaterThanOrEqual(15);
    expect(view.make).toEqual({ id: 'make_1', key: 'volkswagen', name: 'Volkswagen' });
  });
});

describe('the detectors actually detect — the mutation self-tests', () => {
  it('the option detector sees a table, a constant and a repository import', () => {
    expect(OPTION_WRITE_REFERENCE.test('await tx.insert(listingOptions).values(rows);')).toBe(true);
    expect(
      OPTION_WRITE_REFERENCE.test("import { insertVariants } from '../../db/catalog/variantRepository.js';"),
    ).toBe(true);
    expect(OPTION_WRITE_REFERENCE.test('delete from product_variant_option_values')).toBe(true);
    expect(
      OPTION_WRITE_REFERENCE.test("import { canonicalVariants } from '../schema/canonicalCatalog.js';"),
    ).toBe(false);
  });

  it('the reverse detector sees a compatibility import and not an innocent word', () => {
    expect(
      COMPATIBILITY_REFERENCE.test("import { resolveFitment } from '@mercaria/shared-types';"),
    ).toBe(true);
    expect(COMPATIBILITY_REFERENCE.test('select * from automotive_fitments')).toBe(true);
    expect(COMPATIBILITY_REFERENCE.test('const compatible = true;')).toBe(false);
  });

  it('the ranking detector sees a policy and a feed import', () => {
    expect(RANKING_REFERENCE.test("import { rankOffers } from '../ranking/rank.js';")).toBe(true);
    expect(RANKING_REFERENCE.test('const rankingPolicy = 1;')).toBe(true);
    expect(RANKING_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
  });

  it('the commerce detector sees a rail and not the word part', () => {
    expect(COMMERCE_REFERENCE.test("import { x } from '../payments/checkout-payment.service.js';")).toBe(
      true,
    );
    expect(COMMERCE_REFERENCE.test('const intent = new PaymentIntent();')).toBe(true);
    expect(COMMERCE_REFERENCE.test('const partNumber = "BP-1234";')).toBe(false);
  });

  it('the relationship detector sees #55 and not the word relation', () => {
    expect(
      RELATIONSHIP_REFERENCE.test("import { commerceRelationships } from '../schema/relationships.js';"),
    ).toBe(true);
    expect(RELATIONSHIP_REFERENCE.test('select * from commerce_relationships')).toBe(true);
    expect(
      RELATIONSHIP_REFERENCE.test('const relation = await findRelationById(id);'),
    ).toBe(false);
  });

  it('the comment stripper does not hide a real reference on the same line', () => {
    // The stripper is itself load-bearing: if it removed too much, every scan
    // above would pass vacuously.
    const stripped = stripComments('await tx.insert(listingOptions).values(rows); // a note');
    expect(OPTION_WRITE_REFERENCE.test(stripped)).toBe(true);
    expect(stripComments('/* listingOptions */').trim()).toBe('');
    // And it must not eat a URL's `//`, which would silently truncate a line
    // carrying a real reference after one.
    expect(stripComments("const u = 'https://x/listing_options';")).toContain('listing_options');
  });
});
