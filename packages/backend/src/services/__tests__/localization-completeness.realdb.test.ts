/**
 * The translation desk's report, against a REAL server (#367 step 10).
 *
 * ## It gets its OWN database, and that is forced by what it measures
 *
 * The completeness report is a GLOBAL AGGREGATE: `owed` is every published
 * category in the database, not every category this file created. On the shared
 * test database every figure would be a function of whichever sibling files had
 * committed by the time it ran, so no exact assertion would be possible and the
 * approximate ones would flake in the victim rather than in the cause — the
 * `reconciliation.realdb.test.ts` failure AGENTS.md records, and #622's known
 * flake, which is the same shape.
 *
 * With a private database every number below is EXACT, which is what makes the
 * important assertions possible at all: `owed === 0` on an empty database,
 * `settledBps === 0` for a locale nobody has started, and a reconciliation
 * against `measureLocaleCompleteness` that compares totals rather than deltas.
 *
 * ## It deliberately does NOT connect the singleton
 *
 * There is no `connectPostgres()`. Every call is handed this file's own handle,
 * so anything reaching for `getDb()` throws `PostgreSQL is not connected`
 * rather than quietly reading the SHARED database — `offer-freshness-sweep`'s
 * ruling, and it matters more here than there. A report that half-read a
 * different database would find no rows, report an empty desk, and every
 * assertion about what is outstanding would pass having measured nothing.
 *
 * ## What each case is a control FOR
 *
 * These are not assertions about a fixture's own shape. The figures are
 * produced by the production repository and service, and each case moves ONE
 * input and names the figure that must move with it — so a report wired to the
 * wrong column, or one that counted rows instead of entities, fails here rather
 * than reading plausibly forever.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@oxyhq/db';
import { eq } from 'drizzle-orm';
import type postgres from 'postgres';
import * as schema from '../../db/schema/index.js';
import type { Database } from '../../db/postgres.js';
import { createMercariaTestDatabase, dropMercariaTestDatabase } from '../../db/testDatabase.js';
import { categories } from '../../db/schema/catalog.js';
import { productTypeDefinitions, productTypeFields } from '../../db/schema/productTypes.js';
import { attributeDefinitions, attributeEnumValues } from '../../db/schema/attributeRegistry.js';
import {
  attributeValueLocalizations,
  categoryLocalizations,
  productTypeLocalizations,
} from '../../db/schema/catalogLocalization.js';
import {
  readLocalizationAlerts,
  readLocalizationCompleteness,
} from '../catalog-localization/completeness.service.js';
import { reviewLocalization } from '../catalog-localization/side-by-side.service.js';
import { measureLocaleCompleteness } from '../catalog-governance/quality.service.js';
import {
  LAUNCH_LOCALES,
  LOCALIZATION_COVERAGE_DOMAINS,
  type CategoryLifecycle,
} from '@mercaria/shared-types';

const ADMIN_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_dev';

let databaseUrl: string;
let client: postgres.Sql;
let db: Database;

beforeAll(async () => {
  databaseUrl = await createMercariaTestDatabase(ADMIN_URL);
  const instance = createDatabase({
    databaseUrl,
    schema,
    client: { max: 4, onnotice: () => undefined },
  });
  client = instance.client;
  db = instance.db;
}, 300_000);

afterAll(async () => {
  await client.end({ timeout: 5 });
  await dropMercariaTestDatabase(databaseUrl);
});

/** The row for one (domain, locale) pair out of a report. */
function rowFor(
  report: Awaited<ReturnType<typeof readLocalizationCompleteness>>,
  domain: string,
  locale: string,
) {
  const found = report.rows.find((row) => row.domain === domain && row.locale === locale);
  expect(found).toBeDefined();
  return found;
}

async function addCategory(
  key: string,
  name: string,
  lifecycle: CategoryLifecycle,
): Promise<string> {
  const [row] = await db
    .insert(categories)
    .values({ key, name, slug: key.replace(/\./gu, '-'), lifecycle, isActive: lifecycle === 'published' })
    .returning();
  return row.id;
}

/* -------------------------------------------------------------------------- */

describe('an empty catalogue does not read as translated', () => {
  it('reports no_population, with no ratio to render, on every pair', async () => {
    // THE case this whole domain exists for. A fresh deployment has nothing in
    // it; a report computed over localization ROWS would divide 0 by 0 and a
    // careless renderer would print 100%. `no_population` carries no
    // `settledBps` PROPERTY at all, so there is nothing for one to print.
    const report = await readLocalizationCompleteness('launch', db);
    expect(report.rows.length).toBeGreaterThan(0);
    for (const row of report.rows) {
      expect(row.owed).toBe(0);
      expect(row.completeness.kind).toBe('no_population');
      expect('settledBps' in row.completeness).toBe(false);
    }
  });

  it('still emits a row for every (domain, launch locale) pair', async () => {
    // "We found nothing" and "there is nothing to find" must not render the
    // same. A report driven by the ROWS present would return an empty array
    // here; this one is driven by the requested locales and the covered
    // domains, so every pair is accounted for even when all of them are zero.
    const report = await readLocalizationCompleteness('launch', db);
    expect(report.rows).toHaveLength(LOCALIZATION_COVERAGE_DOMAINS.length * LAUNCH_LOCALES.length);
  });

  it('an alert run over an empty catalogue reports the pairs it examined', async () => {
    // The vacuity floor in the payload: an empty `alerts` array from a run that
    // examined nothing is byte-identical to one from a run that examined
    // everything and found nothing wrong.
    const alerts = await readLocalizationAlerts(db);
    expect(alerts.alerts).toHaveLength(0);
    expect(alerts.evaluatedPairs).toBe(
      LOCALIZATION_COVERAGE_DOMAINS.length * LAUNCH_LOCALES.length,
    );
    expect(alerts.evaluatedPairs).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('the denominator is the entity population', () => {
  let publishedIds: string[] = [];

  beforeAll(async () => {
    publishedIds = [
      await addCategory('desk.pub.one', 'Shoes', 'published'),
      await addCategory('desk.pub.two', 'Shirts', 'published'),
      await addCategory('desk.pub.three', 'Hats', 'published'),
    ];
    // A draft and a deprecated one — owed by nobody.
    await addCategory('desk.draft.one', 'Draft', 'draft');
    await addCategory('desk.dep.one', 'Deprecated', 'deprecated');
  });

  it('counts published entities and ignores draft and deprecated ones', async () => {
    // Five categories exist; three are owed a translation. A report that counted
    // rows in `categories` would say five, and every locale would look
    // permanently incomplete — which is how a completeness metric is ignored.
    const report = await readLocalizationCompleteness('launch', db);
    expect(rowFor(report, 'category', 'es').owed).toBe(3);
  });

  it('with nothing translated, reports 0% rather than 100%', async () => {
    // The positive control on the vacuity fix. Three entities owed, zero
    // localization rows in existence: a row-denominated ratio is 0/0 and this
    // one is 0/3.
    const row = rowFor(await readLocalizationCompleteness('launch', db), 'category', 'es');
    expect(row.completeness.kind).toBe('measured');
    expect(row.completeness.kind === 'measured' && row.completeness.settledBps).toBe(0);
    expect(row.absent).toBe(3);
  });

  it('`absent` is the count with no row — invisible to any tally over the rows', async () => {
    const row = rowFor(await readLocalizationCompleteness('launch', db), 'category', 'fr');
    expect(row.absent).toBe(3);
    expect(row.missing).toBe(0);
    expect(row.reviewed + row.approved + row.machineTranslated + row.stale).toBe(0);
  });

  it('a `missing` row moves out of `absent` without changing what is untranslated', async () => {
    // `missing` and `absent` are different states of the DESK — one has been
    // triaged, one has not — and their SUM is what a shopper experiences. This
    // asserts the split is real and the total is conserved, which is the
    // property that would break if the two were ever collapsed.
    const before = rowFor(await readLocalizationCompleteness('launch', db), 'category', 'de');
    await db.insert(categoryLocalizations).values({
      categoryId: publishedIds[0],
      locale: 'de',
      status: 'missing',
      provenance: 'mercaria',
      name: null,
    });
    const after = rowFor(await readLocalizationCompleteness('launch', db), 'category', 'de');
    expect(after.missing).toBe(before.missing + 1);
    expect(after.absent).toBe(before.absent - 1);
    expect(after.absent + after.missing).toBe(before.absent + before.missing);
  });

  it('an approval moves the completeness figure and nothing else does', async () => {
    await db.insert(categoryLocalizations).values({
      categoryId: publishedIds[0],
      locale: 'fr',
      status: 'approved',
      provenance: 'mercaria',
      name: 'Chaussures',
      reviewedByOxyUserId: 'desk-reviewer',
      reviewedAt: new Date(),
    });
    const row = rowFor(await readLocalizationCompleteness('launch', db), 'category', 'fr');
    expect(row.approved).toBe(1);
    // 1 of 3 == 3333 bps, floored.
    expect(row.completeness.kind === 'measured' && row.completeness.settledBps).toBe(3333);
  });

  it('a machine translation is NOT counted as settled', async () => {
    // `machine_translated` is servable and is work outstanding. Counting it is
    // how a locale reports 98% complete while a shopper reads a machine's guess.
    await db.insert(categoryLocalizations).values({
      categoryId: publishedIds[1],
      locale: 'fr',
      status: 'machine_translated',
      provenance: 'machine',
      name: 'Chemises',
    });
    const row = rowFor(await readLocalizationCompleteness('launch', db), 'category', 'fr');
    expect(row.machineTranslated).toBe(1);
    expect(row.completeness.kind === 'measured' && row.completeness.settledBps).toBe(3333);
  });

  it('the stale TRIGGER fires on a source edit and the report sees it', async () => {
    // The staleness descriptor claims the category trigger watches
    // `categories.name`. This drives the real trigger through a real UPDATE and
    // asserts the report's `stale` column moves — so the caveat published beside
    // the figure is measured, not asserted.
    const before = rowFor(await readLocalizationCompleteness('launch', db), 'category', 'fr');
    expect(before.approved).toBe(1);
    await db
      .update(categories)
      .set({ name: 'Footwear' })
      .where(eq(categories.id, publishedIds[0]));
    const after = rowFor(await readLocalizationCompleteness('launch', db), 'category', 'fr');
    expect(after.stale).toBe(before.stale + 1);
    expect(after.approved).toBe(before.approved - 1);
    // …and the settled figure FALLS, which is the whole point of tracking it.
    expect(after.completeness.kind === 'measured' && after.completeness.settledBps).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('product types are owed per published VERSION', () => {
  beforeAll(async () => {
    // `product_type_definitions_one_published_per_key` permits exactly ONE
    // published version per key, so "two published versions of one key" is
    // unrepresentable — the desk's per-version grain and a per-published-key
    // grain therefore coincide today. The grain is still stated per version
    // because `product_type_localizations` is per version: a translation is of a
    // MEANING and D5 freezes a published version's, so a scheme that ever
    // published two would be counted right without an edit here.
    //
    // `_published_audit_check` is a biconditional: anything past `draft`/`review`
    // must carry BOTH publication audit columns.
    const publishedAudit = { publishedByOxyUserId: 'desk-publisher', publishedAt: new Date() };
    await db.insert(productTypeDefinitions).values([
      { key: 'desk.phone', version: 1, lifecycle: 'published', name: 'Smartphone', ...publishedAudit },
      { key: 'desk.tablet', version: 1, lifecycle: 'published', name: 'Tablet', ...publishedAudit },
      // Draft and superseded versions of a published key — owed by nobody.
      { key: 'desk.phone', version: 2, lifecycle: 'draft', name: 'Smartphone v2' },
      { key: 'desk.laptop', version: 1, lifecycle: 'draft', name: 'Laptop' },
    ]);
  });

  it('counts published versions and ignores draft ones', async () => {
    const report = await readLocalizationCompleteness('launch', db);
    expect(rowFor(report, 'product_type', 'es').owed).toBe(2);
  });

  it('a draft version of an already-published key adds nothing to the backlog', async () => {
    // `desk.phone` has a published v1 and a draft v2. If the denominator counted
    // every row of a published KEY, this would be 3 — and a translator would be
    // shown work on a version whose meaning may still change.
    const report = await readLocalizationCompleteness('launch', db);
    expect(rowFor(report, 'product_type', 'ja').owed).toBe(2);
  });
});

describe('per-field authoring copy is owed only where there is copy', () => {
  beforeAll(async () => {
    // Built as a DRAFT and published afterwards: a published version's authoring
    // contract is frozen by trigger, so its fields cannot be inserted after the
    // fact. Its own key, because `_one_published_per_key` permits one published
    // version per key and the versions above are already using theirs.
    const [definition] = await db
      .insert(productTypeDefinitions)
      .values({ key: 'desk.fielded', version: 1, lifecycle: 'draft', name: 'Fielded' })
      .returning();
    // A field CITES its attribute by key and version, and a trigger refuses a
    // citation that does not match the definition it points at — so each field
    // needs its own definition rather than three citations of one.
    const attributes = await db
      .insert(attributeDefinitions)
      .values(
        ['desk_screen_a', 'desk_screen_b', 'desk_screen_c'].map((key) => ({
          key,
          label: key,
          valueType: 'string' as const,
          lifecycleState: 'draft' as const,
        })),
      )
      .returning();
    const field = (attribute: (typeof attributes)[number], position: number) => ({
      productTypeDefinitionId: definition.id,
      attributeDefinitionId: attribute.id,
      attributeKey: attribute.key,
      attributeDefinitionVersion: attribute.version,
      scope: 'product' as const,
      flow: 'merchant' as const,
      requirement: 'optional' as const,
      valuePolicy: 'typed_scalar' as const,
      position,
    });
    await db.insert(productTypeFields).values([
      // Carry base copy — owed.
      { ...field(attributes[0], 1), label: 'Screen size' },
      { ...field(attributes[1], 2), helpText: 'Measured diagonally' },
      // Carries NONE of the four — nothing to translate.
      field(attributes[2], 3),
    ]);
    await db
      .update(productTypeDefinitions)
      .set({
        lifecycle: 'published',
        publishedByOxyUserId: 'desk-publisher',
        publishedAt: new Date(),
      })
      .where(eq(productTypeDefinitions.id, definition.id));
  });

  it('excludes a field with no base label, help text, placeholder or example', async () => {
    // All four base columns are nullable. Counting a bare field would make every
    // locale permanently incomplete by exactly the number of bare fields — a
    // denominator nobody can ever satisfy, which is how a metric gets ignored.
    const report = await readLocalizationCompleteness('launch', db);
    expect(rowFor(report, 'product_type_field', 'es').owed).toBe(2);
  });

  it('publishes the #650 carry-forward gap beside the figure', async () => {
    // The caveat this domain needs and no other does: nothing carries per-field
    // translations onto a new product-type version, so this figure can collapse
    // to zero for a key through no translator's doing. A desk reading it without
    // the caveat would conclude its translators had stopped working.
    const report = await readLocalizationCompleteness('launch', db);
    const detection = report.stalenessDetections.find((d) => d.domain === 'product_type_field');
    expect(detection).toBeDefined();
    expect(detection.carriesForwardOnVersionBump).toBe('no');
    expect(detection.knownGapIssue).toBe('#650');
    // …and the version-level domain, which IS carried forward, says so — so the
    // field is a real discriminator rather than a constant.
    const versionLevel = report.stalenessDetections.find((d) => d.domain === 'product_type');
    expect(versionLevel.carriesForwardOnVersionBump).toBe('yes');
  });
});

describe('controlled values follow their DEFINITION lifecycle', () => {
  beforeAll(async () => {
    // Two rules shape this fixture, both enforced by the server:
    //
    //  - `attribute_definitions_published_audit_check`: anything but `draft`
    //    must carry `published_at`, and `_deprecated_at_check` admits
    //    `deprecated_at` only for `deprecated`/`retired`.
    //  - an ACTIVE definition's value vocabulary is FROZEN by trigger, so the
    //    enum values must be inserted while it is still `draft` and the
    //    lifecycle moved afterwards. Doing it the obvious way round is refused
    //    with "publish a new version instead".
    const [active] = await db
      .insert(attributeDefinitions)
      .values({ key: 'desk_colour', label: 'Colour', valueType: 'enum', lifecycleState: 'draft' })
      .returning();
    const [deprecated] = await db
      .insert(attributeDefinitions)
      .values({ key: 'desk_old', label: 'Old', valueType: 'enum', lifecycleState: 'draft' })
      .returning();
    await db.insert(attributeEnumValues).values([
      { attributeDefinitionId: active.id, value: 'red', label: 'Red' },
      { attributeDefinitionId: active.id, value: 'blue', label: 'Blue' },
      // Owed by nobody once its definition is deprecated.
      { attributeDefinitionId: deprecated.id, value: 'beige', label: 'Beige' },
    ]);
    await db
      .update(attributeDefinitions)
      .set({ lifecycleState: 'active', publishedAt: new Date() })
      .where(eq(attributeDefinitions.id, active.id));
    await db
      .update(attributeDefinitions)
      .set({ lifecycleState: 'deprecated', publishedAt: new Date(), deprecatedAt: new Date() })
      .where(eq(attributeDefinitions.id, deprecated.id));
  });

  it('counts values of active definitions only', async () => {
    // The enum value carries no lifecycle of its own, so the definition's is the
    // only statement available about whether its labels are worth translating.
    const report = await readLocalizationCompleteness('launch', db);
    expect(rowFor(report, 'attribute_value', 'es').owed).toBe(2);
  });

  it('covers a domain no existing surface measures per locale', async () => {
    // `quality.service.ts` measures categories per locale and product types at a
    // different grain; nothing measured controlled values per locale before.
    const report = await readLocalizationCompleteness('launch', db);
    const covered = new Set(report.rows.map((row) => row.domain));
    expect([...covered].sort()).toEqual([...LOCALIZATION_COVERAGE_DOMAINS].sort());
  });
});

/* -------------------------------------------------------------------------- */

describe('it does not disagree with the governance quality surface', () => {
  it('reports the same owed population and settled count for categories', async () => {
    // Two representations of one fact must not disagree, and a promise is not a
    // mechanism. Both are run against this file's own database — which is what
    // makes a total comparison safe rather than a delta with a race in it.
    const [desk, quality] = await Promise.all([
      readLocalizationCompleteness('all', db),
      measureLocaleCompleteness(db),
    ]);
    const cells = new Map(quality.map((cell) => [cell.key, cell]));
    // Floor: if `measureLocaleCompleteness` returned nothing, every comparison
    // below would pass by not running.
    expect(cells.size).toBeGreaterThan(0);

    let compared = 0;
    for (const row of desk.rows) {
      if (row.domain !== 'category') continue;
      const cell = cells.get(row.locale);
      if (!cell) continue;
      expect(cell.eligible).toBe(row.owed);
      expect(cell.present).toBe(row.reviewed + row.approved);
      expect(cell.stale).toBe(row.stale);
      compared += 1;
    }
    // The vacuity floor for the loop itself.
    expect(compared).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('the alerts name launch-locale gaps', () => {
  it('raises a blocking untranslated finding and never for a non-launch locale', async () => {
    const alerts = await readLocalizationAlerts(db);
    const untranslated = alerts.alerts.filter((alert) => alert.kind === 'untranslated');
    expect(untranslated.length).toBeGreaterThan(0);
    for (const alert of untranslated) expect(alert.severity).toBe('blocking');
    // Scoped by construction: no alert may name a locale no app ships.
    const launch: readonly string[] = LAUNCH_LOCALES;
    for (const alert of alerts.alerts) expect(launch).toContain(alert.locale);
  });

  it('carries the staleness caveat on a category finding and not on an attribute one', () => {
    // The caveat travels with the FINDING, so a consumer rendering one alert in
    // isolation still shows what its count cannot see. `attribute_value`'s
    // trigger watches everything it localizes, so it carries none — which is
    // what makes the category caveat's presence meaningful rather than boilerplate.
    return readLocalizationAlerts(db).then((alerts) => {
      const category = alerts.alerts.find((a) => a.domain === 'category');
      const attribute = alerts.alerts.find((a) => a.domain === 'attribute_value');
      expect(category).toBeDefined();
      expect(attribute).toBeDefined();
      expect(category.caveats.length).toBeGreaterThan(0);
      expect(category.caveats[0]).toContain('categories.description');
      expect(attribute.caveats).toHaveLength(0);
    });
  });

  it('reports evaluatedPairs even when it found findings', async () => {
    const alerts = await readLocalizationAlerts(db);
    expect(alerts.evaluatedPairs).toBe(
      LOCALIZATION_COVERAGE_DOMAINS.length * LAUNCH_LOCALES.length,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('side-by-side review shows the target and never a fallback', () => {
  let categoryId: string;

  beforeAll(async () => {
    categoryId = await addCategory('desk.review.one', 'Trousers', 'published');
    await db.insert(categoryLocalizations).values({
      categoryId,
      locale: 'es',
      status: 'approved',
      provenance: 'professional',
      name: 'Pantalones',
      reviewedByOxyUserId: 'desk-reviewer',
      reviewedAt: new Date(),
    });
  });

  it('puts the base text beside the translation', async () => {
    const view = await reviewLocalization('category', categoryId, 'es', db);
    expect(view).toBeDefined();
    const name = view.fields.find((field) => field.field === 'category.name');
    expect(name.source).toBe('Trousers');
    expect(name.target.kind).toBe('present');
    expect(name.target.kind === 'present' && name.target.text).toBe('Pantalones');
    expect(name.target.kind === 'present' && name.target.provenance).toBe('professional');
  });

  it('answers `absent` for an untranslated locale rather than the English', async () => {
    // The one question fallback makes unanswerable. A reviewer asking "is the
    // German approved" must never be shown the English that WOULD be served.
    const view = await reviewLocalization('category', categoryId, 'de', db);
    const name = view.fields.find((field) => field.field === 'category.name');
    expect(name.target.kind).toBe('absent');
    // …while the source is still shown, which is what they translate FROM.
    expect(name.source).toBe('Trousers');
  });

  it('reports a field with no base column as having none, not as blank', async () => {
    const view = await reviewLocalization('category', categoryId, 'es', db);
    const description = view.fields.find((field) => field.field === 'category.description');
    expect(description.baseSource.kind).toBe('none');
    expect(description.source).toBeNull();
  });

  it('tells `declared_missing` apart from `absent`', async () => {
    const other = await addCategory('desk.review.two', 'Socks', 'published');
    await db.insert(categoryLocalizations).values({
      categoryId: other,
      locale: 'ja',
      status: 'missing',
      provenance: 'mercaria',
      name: null,
    });
    const view = await reviewLocalization('category', other, 'ja', db);
    const name = view.fields.find((field) => field.field === 'category.name');
    expect(name.target.kind).toBe('declared_missing');
  });

  it('returns undefined for an entity that does not exist', async () => {
    // "No Spanish name" and "no such category" are different facts.
    const view = await reviewLocalization('category', '0'.repeat(24), 'es', db);
    expect(view).toBeUndefined();
  });

  it('carries the domain staleness descriptor to the reviewer', async () => {
    const view = await reviewLocalization('category', categoryId, 'es', db);
    expect(view.stalenessDetection.domain).toBe('category');
    expect(view.stalenessDetection.unwatched).toContain('categories.description');
  });
});
