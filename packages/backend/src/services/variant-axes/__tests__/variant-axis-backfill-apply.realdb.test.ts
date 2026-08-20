/**
 * The legacy variant-axis backfill in APPLY mode, against a REAL Postgres
 * server (#367 step 4).
 *
 * ## The gap this closes
 *
 * `runVariantAxisBackfill` had exactly one test caller — the collision case in
 * `variant-axis-backfill.realdb.test.ts` — and it drives the entrypoint in
 * `dry_run` mode only. So nothing anywhere had ever observed a
 * `native_listing_variant_axes`, `native_variant_axis_assignments` or
 * `native_variant_signatures` row this backfill actually PERSISTED, and three
 * separate claims rested on that:
 *
 *  1. **The rollback.** `dry_run` is the identical body inside a transaction
 *     that is rolled back. The existing post-condition ("no axis was declared
 *     for the folded key") cannot tell a rollback from a REFUSAL, because its
 *     fixture is the ambiguity case — the pass declines to declare that axis in
 *     either mode, so deleting `tx.rollback()` outright would leave it green.
 *  2. **Coverage at the variant/option grain.** The other file's fixture is
 *     pathological by construction. Nothing observed a legacy option that
 *     RESOLVES becoming a typed axis with typed assignments and a signature.
 *  3. **Idempotency.** `backfill.service.ts`'s own docblock claims it, resting
 *     on `.onConflictDoNothing` and on `upsertVariantSignature`'s `setWhere`.
 *     A pass that writes nothing cannot be compared against a second pass, so
 *     the claim had no test at all.
 *
 * ## Why this is a separate file
 *
 * The other file's premise, stated in its own docblock, is that it WRITES
 * NOTHING ANYWHERE: it runs an unscoped page over every listing in the shared
 * database and is safe precisely because every per-listing transaction is
 * rolled back. Apply mode is the opposite premise — a pass that writes, which
 * must therefore be aimed at rows this file owns and at nothing else. Putting a
 * writing pass into a file that documents itself as non-writing is how the next
 * reader loses track of which premise holds. The two also cannot share a page:
 * cases in one file run sequentially, so an unscoped dry run's counters would
 * depend on whether the apply case had already run.
 *
 * ## How apply mode is aimed, and why that is a GUARANTEE rather than a hope
 *
 * The test database is shared by every file in a run, and an apply pass writes
 * to every listing on its page. Two mechanisms confine it:
 *
 *  - **The fixture's listing id is chosen to sort after every real id.**
 *    `generatedId()` is a uuid v7 whose leading field is the current
 *    millisecond, so every id any sibling can mint begins `0…`. This fixture's
 *    begins `ffffffff-ffff-…`, which as a uuid v7 timestamp is the year 10889.
 *    Nothing a sibling creates can land between the cursor below and this
 *    listing.
 *  - **The pager's own answer is asserted before anything is written.** The
 *    pass is driven with `afterListingId` set immediately below this fixture's
 *    id and `listingLimit` equal to its listing count, and
 *    `listListingIdsWithLegacyOptions` — the function the entrypoint itself
 *    calls — is asked first and must answer EXACTLY this file's ids. That turns
 *    the ordering argument above into a measurement, and it fails before any
 *    row is written rather than after.
 *
 * Because the page is exactly one listing, every counter this file asserts is
 * EXACT rather than a lower bound, which is what makes the idempotency case
 * able to tell convergence from an empty pass.
 *
 * ## The three-part shape, and how it maps onto the house standard
 *
 * `catalog-authoring/__tests__/publish-outbox-atomicity.realdb.test.ts` is the
 * pattern: observe the write INSIDE the transaction, then observe the rollback,
 * then a control proving the case measures the rollback rather than a function
 * that wrote nothing. That file can read inside the transaction because it opens
 * the transaction itself and hands the handle in. This one cannot —
 * `runVariantAxisBackfill` opens a transaction PER LISTING and rolls it back
 * itself, and a test that reached inside would have to re-implement the loop it
 * is measuring. So the two parts are supplied differently and neither is
 * dropped:
 *
 *  - **Inside the transaction** is the REPORT. `declareVariantAxis` answers
 *    `created: true` only from a non-empty `RETURNING` set and
 *    `upsertVariantSignature` only from a `setWhere` that actually fired, so a
 *    dry run reporting `axes.declared: 2` and `signatures.written: 2` is proof
 *    those statements executed and produced rows.
 *  - **The control** is the apply pass immediately after: same fixture, same
 *    cursor, same limit, `mode` the only difference. The rows appearing there is
 *    what attributes their absence here to `tx.rollback()`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { VariantAxisBackfillReport } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import {
  listingOptions,
  listings,
  productVariantOptionValues,
  productVariants,
} from '../../../db/schema/catalog.js';
import {
  attributeDefinitionCategories,
  attributeDefinitions,
  attributeEnumValues,
  attributeReindexRequests,
  attributeValueAliases,
} from '../../../db/schema/attributeRegistry.js';
import {
  nativeListingAttributeClaims,
  nativeListingVariantAxes,
  nativeVariantAttributeClaims,
  nativeVariantAxisAssignments,
  nativeVariantSignatures,
} from '../../../db/schema/variantAxes.js';
import { listListingIdsWithLegacyOptions } from '../../../db/variantAxes/legacyOptionRepository.js';
import {
  draftAttributeDefinition,
  publishAttributeDefinition,
} from '../../attributes/definition-registry.service.js';
import { runVariantAxisBackfill } from '../backfill.service.js';
import { reportPopulation } from '../../../__tests__/report-population.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '');
const OPERATOR = `axis-apply-operator-${RUN}`;

/**
 * A listing id that sorts after every id any sibling can mint. See the docblock.
 *
 * `id` is a `text` primary key with a uuid v7 `$defaultFn`, so an explicit value
 * is accepted — `generatedId()`'s own comment says a backfill supplies the
 * original id verbatim. The shape is kept uuid-like so nothing reading the row
 * has to cope with a novel format; only the timestamp field is impossible.
 */
const TAIL_PREFIX = 'ffffffff-ffff-7fff-8fff-';
/** Strictly below the listing id, and above every uuid v7. Never inserted. */
const PAGE_CURSOR = `${TAIL_PREFIX}${RUN.slice(0, 11)}0`;
const LISTING_ID = `${TAIL_PREFIX}${RUN.slice(0, 11)}1`;

/**
 * The two options that RESOLVE — by the two DIFFERENT routes the resolver has —
 * and the one that cleanly does not.
 *
 * `legacyOptionNameToKey` trims, lowercases and folds spaces to `_`, so
 * `Axis Color <RUN>` and `Axis Storage <RUN>` fold onto the definition keys
 * published below. `Axis Unmapped <RUN>` folds to a perfectly well-formed key
 * nobody ever defined, which is the ordinary `unmapped` outcome — a fixture of
 * nothing but pathological rows cannot observe a write, and a fixture of nothing
 * but resolving rows cannot observe the refusal counters beside it.
 *
 * Both resolving routes are here because they write DIFFERENT COLUMNS. A
 * controlled value lands as an `enum_value_id`; a measurement lands as
 * `normalized_number` + `normalized_unit`, which
 * `native_variant_axis_assignments_unit_check` constrains and which no test
 * anywhere had ever written through this backfill.
 */
const COLOR_KEY = `axis_color_${RUN}`.toLowerCase();
const COLOR_NAME = `Axis Color ${RUN}`;
const STORAGE_KEY = `axis_storage_${RUN}`.toLowerCase();
const STORAGE_NAME = `Axis Storage ${RUN}`;
const UNMAPPED_NAME = `Axis Unmapped ${RUN}`;
/** Every definition key this file publishes, so the teardown reaches all of them. */
const CREATED_KEYS = [COLOR_KEY, STORAGE_KEY];

/** Both variants' ids, so every assertion is scoped to rows this file inserted. */
let variantIds: string[] = [];
/** The apply pass that first wrote, kept so the second pass can be compared to it. */
let firstApply: VariantAxisBackfillReport | undefined;

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  // The options, variants, option values, axes, assignments, signatures and
  // claims all cascade from `listings`, so the listing goes first — and it MUST,
  // because an axis references its definition `on delete restrict`.
  await db.delete(listings).where(eq(listings.id, LISTING_ID));

  const definitionIds = (
    await db
      .select({ id: attributeDefinitions.id })
      .from(attributeDefinitions)
      .where(inArray(attributeDefinitions.key, CREATED_KEYS))
  ).map((row) => row.id);
  if (definitionIds.length > 0) {
    await db
      .delete(attributeReindexRequests)
      .where(inArray(attributeReindexRequests.attributeKey, CREATED_KEYS));
    // Demote first: a published version refuses DELETE, which IS the trigger
    // working. The same teardown as `attribute-registry.realdb.test.ts`.
    await db
      .update(attributeDefinitions)
      .set({ lifecycleState: 'draft', publishedAt: null, deprecatedAt: null })
      .where(inArray(attributeDefinitions.id, definitionIds));
    await db
      .delete(attributeValueAliases)
      .where(inArray(attributeValueAliases.attributeDefinitionId, definitionIds));
    await db
      .delete(attributeEnumValues)
      .where(inArray(attributeEnumValues.attributeDefinitionId, definitionIds));
    await db
      .delete(attributeDefinitionCategories)
      .where(inArray(attributeDefinitionCategories.attributeDefinitionId, definitionIds));
    await db.delete(attributeDefinitions).where(inArray(attributeDefinitions.id, definitionIds));
  }
  await closePostgres();
});

/**
 * Publish the two active, variant-defining definitions the resolving options need.
 *
 * `mercaria_native_variant_axis_citation` refuses an axis whose definition is not
 * `variant_defining`, so a definition without it would make the resolving half of
 * this fixture fail at the database rather than resolve — the two are not
 * interchangeable and the trigger is the reason.
 */
async function publishAxisDefinitions(): Promise<void> {
  await draftAttributeDefinition({
    key: COLOR_KEY,
    label: 'Axis colour',
    valueType: 'enum',
    variantDefining: true,
    // `red` is reached through a recorded alias (`Rojo`) and so is `blue`, but the
    // registry folds a canonical value into its OWN alias map, so both halves of
    // the ONE lookup `resolveLegacyOptionValue` performs stay exercised by a value
    // that has to survive all the way to the assignment row.
    enumValues: [
      { value: 'red', label: 'Red', aliases: ['Rojo'] },
      { value: 'blue', label: 'Blue', aliases: ['Azul'] },
    ],
    actorOxyUserId: OPERATOR,
  });
  await publishAttributeDefinition(COLOR_KEY, 1, OPERATOR);

  // The OTHER resolving route: no controlled values, so the value goes through
  // #94's `normalizeAttributeObservation` and lands as a base-unit magnitude.
  // `digital_storage`'s base unit is `B`, so `256 GB` is stored as a number of
  // bytes and two spellings of one capacity would collide — which is the property
  // the signature depends on and which only a measurement axis reaches.
  await draftAttributeDefinition({
    key: STORAGE_KEY,
    label: 'Axis storage',
    valueType: 'measurement',
    unitFamily: 'digital_storage',
    variantDefining: true,
    actorOxyUserId: OPERATOR,
  });
  await publishAttributeDefinition(STORAGE_KEY, 1, OPERATOR);
}

/**
 * One P2P listing with two resolving options, an unmapped option and two variants.
 *
 * The two variants resolve to DIFFERENT values deliberately: two variants whose
 * typed values fold to one digest are withheld wholesale by
 * `listingsWithIndistinguishableVariants`, which would make this fixture write
 * nothing and look exactly like a fixture whose registry lookup failed.
 */
async function makeFixtureListing(): Promise<void> {
  await db.insert(listings).values({
    id: LISTING_ID,
    ownerType: 'user',
    oxyUserId: `axis-apply-seller-${RUN}`,
    storeId: null,
    title: `Axis apply ${RUN}`,
    description: 'A fixture listing with two resolving and one unmapped legacy option.',
    condition: 'new',
    conditionAssertion: 'seller_declared',
    status: 'active',
    categorySlugs: [],
    tags: [],
  });

  await db.insert(listingOptions).values([
    { listingId: LISTING_ID, name: COLOR_NAME, values: ['Rojo', 'Azul'], position: 0 },
    { listingId: LISTING_ID, name: STORAGE_NAME, values: ['256 GB', '512 GB'], position: 1 },
    { listingId: LISTING_ID, name: UNMAPPED_NAME, values: ['Cualquiera'], position: 2 },
  ]);

  const inserted = await db
    .insert(productVariants)
    .values([
      { listingId: LISTING_ID, title: 'Rojo', position: 0 },
      { listingId: LISTING_ID, title: 'Azul', position: 1 },
    ])
    .returning({ id: productVariants.id });
  variantIds = inserted.map((row) => row.id);
  expect(variantIds.length, 'the fixture did not create two variants').toBe(2);

  await db.insert(productVariantOptionValues).values([
    { variantId: variantIds[0], name: COLOR_NAME, value: 'Rojo', position: 0 },
    { variantId: variantIds[0], name: STORAGE_NAME, value: '256 GB', position: 1 },
    // Under the option that never resolves, so `attribute_unresolved` is
    // observed on a value the registry was never even asked about.
    { variantId: variantIds[0], name: UNMAPPED_NAME, value: 'Cualquiera', position: 2 },
    { variantId: variantIds[1], name: COLOR_NAME, value: 'Azul', position: 0 },
    { variantId: variantIds[1], name: STORAGE_NAME, value: '512 GB', position: 1 },
  ]);
}

/** Everything this fixture's own rows amount to, read back scoped to its ids. */
async function readPersistedState(): Promise<{
  axes: {
    attributeKey: string;
    attributeDefinitionVersion: number;
    legacyOptionName: string | null;
  }[];
  assignments: {
    variantId: string;
    attributeKey: string;
    normalizedValue: string;
    displayValue: string;
    enumValueId: string | null;
    normalizedNumber: number | null;
    normalizedUnit: string | null;
    sourceClaimId: string | null;
  }[];
  signatures: { variantId: string; axisCount: number; signature: string }[];
  listingClaims: number;
  variantClaims: number;
}> {
  const axes = await db
    .select({
      attributeKey: nativeListingVariantAxes.attributeKey,
      attributeDefinitionVersion: nativeListingVariantAxes.attributeDefinitionVersion,
      legacyOptionName: nativeListingVariantAxes.legacyOptionName,
    })
    .from(nativeListingVariantAxes)
    .where(eq(nativeListingVariantAxes.listingId, LISTING_ID));

  const assignments =
    variantIds.length === 0
      ? []
      : await db
          .select({
            variantId: nativeVariantAxisAssignments.variantId,
            attributeKey: nativeVariantAxisAssignments.attributeKey,
            normalizedValue: nativeVariantAxisAssignments.normalizedValue,
            displayValue: nativeVariantAxisAssignments.displayValue,
            enumValueId: nativeVariantAxisAssignments.enumValueId,
            normalizedNumber: nativeVariantAxisAssignments.normalizedNumber,
            normalizedUnit: nativeVariantAxisAssignments.normalizedUnit,
            sourceClaimId: nativeVariantAxisAssignments.sourceClaimId,
          })
          .from(nativeVariantAxisAssignments)
          .where(inArray(nativeVariantAxisAssignments.variantId, variantIds));

  const signatures = await db
    .select({
      variantId: nativeVariantSignatures.variantId,
      axisCount: nativeVariantSignatures.axisCount,
      signature: nativeVariantSignatures.signature,
    })
    .from(nativeVariantSignatures)
    .where(eq(nativeVariantSignatures.listingId, LISTING_ID));

  const listingClaims = await db
    .select({ id: nativeListingAttributeClaims.id })
    .from(nativeListingAttributeClaims)
    .where(eq(nativeListingAttributeClaims.listingId, LISTING_ID));
  const variantClaims =
    variantIds.length === 0
      ? []
      : await db
          .select({ id: nativeVariantAttributeClaims.id })
          .from(nativeVariantAttributeClaims)
          .where(inArray(nativeVariantAttributeClaims.variantId, variantIds));

  return {
    axes,
    assignments,
    signatures,
    listingClaims: listingClaims.length,
    variantClaims: variantClaims.length,
  };
}

/**
 * The row identity every "converged" claim actually rests on.
 *
 * `id` catches a delete-and-reinsert, `xmin` catches an UPDATE that wrote the
 * same values back — `moderation-writes.realdb.test.ts`'s finding, which is that
 * drizzle applies a column's `$onUpdate` to a conflict branch's `set`, so "write
 * the same data back" is not even a quiet write. A count alone sees neither.
 */
async function readRowIdentity(): Promise<{
  axes: { id: string; xmin: string }[];
  assignments: { id: string; xmin: string }[];
  signatures: { id: string; xmin: string }[];
  claims: { id: string; xmin: string }[];
}> {
  const rows = async (table: string, predicate: ReturnType<typeof sql>) => {
    const result = await db.execute(
      sql`select id, xmin::text as xmin from ${sql.raw(table)} where ${predicate} order by id`,
    );
    return result.map((row) => ({ id: String(row.id), xmin: String(row.xmin) }));
  };
  const variantList = sql.join(
    variantIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return {
    axes: await rows('native_listing_variant_axes', sql`listing_id = ${LISTING_ID}`),
    assignments: await rows('native_variant_axis_assignments', sql`variant_id in (${variantList})`),
    signatures: await rows('native_variant_signatures', sql`listing_id = ${LISTING_ID}`),
    claims: await rows('native_variant_attribute_claims', sql`variant_id in (${variantList})`),
  };
}

/** One pass over exactly this file's listing and nothing else. */
async function runScopedPass(mode: 'dry_run' | 'apply'): Promise<VariantAxisBackfillReport> {
  return runVariantAxisBackfill(db, {
    mode,
    afterListingId: PAGE_CURSOR,
    listingLimit: 1,
  });
}

/**
 * What one pass over this fixture must report, whichever mode it ran in.
 *
 * Both modes run the identical body, so a difference between the two reports
 * would itself be the defect — `dry_run` reporting less than `apply` is how a
 * predict branch would look.
 */
function expectFirstPassCounters(report: VariantAxisBackfillReport, label: string): void {
  expect(report.scanned.listings, `${label}: the page was not exactly this fixture`).toBe(1);
  expect(report.scanned.listingOptions, `${label}: all three legacy options must be read`).toBe(3);
  expect(report.scanned.variantOptionValues, `${label}: all five option values must be read`).toBe(
    5,
  );

  // THE IN-TRANSACTION WITNESS, and the reason the rollback case below is not
  // vacuous. `declareVariantAxis` answers `created: true` only from a non-empty
  // `RETURNING` set, so a positive `axes.declared` is proof the INSERT executed
  // and produced a row — inside the transaction, whatever happened to it after.
  expect(report.axes.declared, `${label}: no axis INSERT returned a row`).toBe(2);
  expect(report.axes.alreadyDeclared, `${label}: nothing should have been there yet`).toBe(0);
  expect(report.axes.unresolved, `${label}: the unmapped option must be refused`).toBe(1);

  expect(report.assignments.written, `${label}: no assignment was written`).toBe(4);
  expect(report.assignments.alreadyWritten, `${label}`).toBe(0);
  expect(report.assignments.unresolved, `${label}: the unmapped value must be refused`).toBe(1);
  expect(report.assignments.withheld, `${label}: nothing is indistinguishable here`).toBe(0);

  // Three listing-grain claims and five variant-grain ones: every legacy row is
  // preserved whether or not it resolved (ADR 0007 D7).
  expect(report.claims.written, `${label}: every legacy row must become a claim`).toBe(8);
  expect(report.claims.alreadyPresent, `${label}`).toBe(0);
  expect(report.signatures.written, `${label}: both variants must get a signature`).toBe(2);
  expect(report.signatures.unchanged, `${label}`).toBe(0);

  // Exactly two, and they are two GRAINS of one cause: the listing option and
  // the variant value beneath it. A pass that reported one has stopped carrying
  // the option's refusal down to its values.
  expect(report.unresolved.byAttributeRefusal.unmapped, `${label}`).toBe(2);
  expect(report.unresolved.byValueRefusal.attribute_unresolved, `${label}`).toBe(1);
  expect(report.diagnostics.listingsWithIndistinguishableVariants, `${label}`).toBe(0);
  expect(report.diagnostics.assignmentsRemoved, `${label}`).toBe(0);
}

describe('the backfill in apply mode', () => {
  beforeAll(async () => {
    await publishAxisDefinitions();
    await makeFixtureListing();
  });

  it('rolls back in dry_run what it persists in apply — the mode is the only difference', async () => {
    // ── The scoping proof, taken BEFORE anything is written ──────────────────
    //
    // The entrypoint's own pager, asked the same question the pass will ask. If
    // a sibling's listing could sit between the cursor and this fixture, this is
    // where it shows up — and it shows up before an apply pass could write to it.
    const page = await listListingIdsWithLegacyOptions(db, {
      afterListingId: PAGE_CURSOR,
      limit: 1,
    });
    expect(
      page.listingIds,
      'the aimed page is not exactly this file\'s listing; an apply pass here would write to a row this file does not own',
    ).toEqual([LISTING_ID]);

    // ── dry_run: the writes are REACHED ─────────────────────────────────────
    const dryRun = await runScopedPass('dry_run');
    expect(dryRun.mode).toBe('dry_run');
    expectFirstPassCounters(dryRun, 'dry_run');

    // ── …and then rolled back ───────────────────────────────────────────────
    const afterDryRun = await readPersistedState();
    expect(afterDryRun.axes, 'dry_run left an axis behind — the rollback did not happen').toEqual(
      [],
    );
    expect(afterDryRun.assignments, 'dry_run left an assignment behind').toEqual([]);
    expect(afterDryRun.signatures, 'dry_run left a signature behind').toEqual([]);
    expect(afterDryRun.listingClaims, 'dry_run left a listing claim behind').toBe(0);
    expect(afterDryRun.variantClaims, 'dry_run left a variant claim behind').toBe(0);

    // ── THE CONTROL: the same pass, same fixture, same cursor, apply ────────
    //
    // Without this the absence above proves nothing — a backfill that wrote
    // nothing at all satisfies it exactly as well as one whose transaction was
    // rolled back. The ONLY thing that differs between this call and the one
    // above is `mode`, so the rows appearing here is what attributes their
    // absence there to `tx.rollback()` rather than to this fixture.
    const apply = await runScopedPass('apply');
    expect(apply.mode).toBe('apply');
    expectFirstPassCounters(apply, 'apply');
    firstApply = apply;

    const persisted = await readPersistedState();
    expect(
      [...persisted.axes].sort((a, b) => a.attributeKey.localeCompare(b.attributeKey)),
      'apply mode persisted no axis; the fixture cannot measure the rollback',
    ).toEqual([
      { attributeKey: COLOR_KEY, attributeDefinitionVersion: 1, legacyOptionName: COLOR_NAME },
      { attributeKey: STORAGE_KEY, attributeDefinitionVersion: 1, legacyOptionName: STORAGE_NAME },
    ]);

    // ── The CONTROLLED-VALUE route ──────────────────────────────────────────
    //
    // The first observation anywhere of a legacy option VALUE that resolved
    // becoming a row. `Rojo` reaches `red` through a recorded alias and keeps the
    // seller's own word in `display_value`.
    const colour = persisted.assignments
      .filter((row) => row.attributeKey === COLOR_KEY)
      .sort((a, b) => a.normalizedValue.localeCompare(b.normalizedValue));
    expect(colour.map((row) => [row.normalizedValue, row.displayValue])).toEqual([
      ['blue', 'Azul'],
      ['red', 'Rojo'],
    ]);
    for (const row of colour) {
      expect(row.enumValueId, 'a controlled value resolved to no enum row').not.toBeNull();
      // A controlled value is not a magnitude, and `..._unit_check` is what would
      // refuse a unit smuggled in beside it.
      expect(row.normalizedNumber, 'a controlled value carries a magnitude').toBeNull();
      expect(row.normalizedUnit, 'a controlled value carries a unit').toBeNull();
    }

    // ── The MEASUREMENT route, which writes different columns ────────────────
    //
    // `256 GB` and `512 GB` land as base-unit magnitudes (`digital_storage`'s base
    // unit is the byte), so two spellings of one capacity would collide on the
    // signature. These two columns had never been written by this backfill in any
    // test, and `native_variant_axis_assignments_unit_check` is what refuses a
    // unit with no magnitude beside it.
    const storage = persisted.assignments
      .filter((row) => row.attributeKey === STORAGE_KEY)
      .sort((a, b) => (a.normalizedNumber ?? 0) - (b.normalizedNumber ?? 0));
    expect(storage.map((row) => row.displayValue)).toEqual(['256 GB', '512 GB']);
    for (const row of storage) {
      expect(row.normalizedNumber, 'a measurement resolved to no magnitude').not.toBeNull();
      expect(row.normalizedUnit, 'a measurement resolved to no unit').toBe('B');
      expect(row.enumValueId, 'a measurement resolved to an enum value').toBeNull();
      // The signature input is the magnitude rendered ONCE in the base unit, so
      // the folded text has to contain the number and the base unit and nothing
      // resembling the seller's own spelling.
      expect(row.normalizedValue).toBe(`${row.normalizedNumber} b`);
    }
    expect(
      (storage[1]?.normalizedNumber ?? 0) / (storage[0]?.normalizedNumber ?? 1),
      '512 GB is not twice 256 GB in base units; the magnitudes are not comparable',
    ).toBe(2);

    for (const row of persisted.assignments) {
      // ADR 0007 D7: the typed value names the assertion it came from, and the
      // claim is undeletable while the variant lives.
      expect(row.sourceClaimId, 'the assignment cites no retained claim').not.toBeNull();
    }
    expect(
      new Set(persisted.assignments.map((row) => row.variantId)).size,
      'every assignment landed on one variant',
    ).toBe(2);

    expect(persisted.signatures.map((row) => row.axisCount)).toEqual([2, 2]);
    expect(
      new Set(persisted.signatures.map((row) => row.signature)).size,
      'the two variants share a signature; the listing unique index should have refused it',
    ).toBe(2);
    // Every legacy row preserved, resolved or not.
    expect(persisted.listingClaims, 'a legacy option was not retained as a claim').toBe(3);
    expect(persisted.variantClaims, 'a legacy option value was not retained as a claim').toBe(5);

    reportPopulation(
      `[apply] population: 1 listing, ${dryRun.scanned.listingOptions} legacy options, ` +
        `${dryRun.scanned.variantOptionValues} legacy option values, ` +
        `${variantIds.length} variants; persisted ${persisted.axes.length} axes, ` +
        `${persisted.assignments.length} assignments, ${persisted.signatures.length} signatures, ` +
        `${persisted.listingClaims + persisted.variantClaims} claims.`,
    );
  });

  it('a second apply over unchanged data writes nothing, and the first pass is why that is convergence', async () => {
    // The discriminator the issue statement asks for: zero written on both
    // passes proves nothing at all, so the FIRST pass's positive counts are a
    // precondition of this case rather than a nicety.
    expect(
      firstApply,
      'the first apply case did not run; there is nothing for this to have converged on',
    ).toBeDefined();
    expect(firstApply?.axes.declared, 'the first pass declared no axis').toBe(2);
    expect(firstApply?.assignments.written, 'the first pass wrote no assignment').toBe(4);
    expect(firstApply?.claims.written, 'the first pass wrote no claim').toBe(8);
    expect(firstApply?.signatures.written, 'the first pass wrote no signature').toBe(2);

    const before = await readRowIdentity();
    expect(before.axes.length, 'there is no persisted axis to converge on').toBe(2);
    expect(before.assignments.length, 'there is no persisted assignment to converge on').toBe(4);
    expect(before.signatures.length, 'there is no persisted signature to converge on').toBe(2);
    expect(before.claims.length, 'there is no persisted variant claim to converge on').toBe(5);

    const second = await runScopedPass('apply');

    // Same population read, every outcome on the OTHER side of the ledger.
    expect(second.scanned.listings).toBe(1);
    expect(second.scanned.listingOptions).toBe(3);
    expect(second.scanned.variantOptionValues).toBe(5);
    expect(second.axes.declared, 'the second pass declared an axis again').toBe(0);
    expect(second.axes.alreadyDeclared, 'the second pass did not recognise the existing axes').toBe(
      2,
    );
    expect(second.assignments.written, 'the second pass rewrote an assignment').toBe(0);
    expect(second.assignments.alreadyWritten).toBe(4);
    expect(second.claims.written, 'the second pass wrote a duplicate claim').toBe(0);
    expect(second.claims.alreadyPresent).toBe(8);
    expect(second.signatures.written, 'the second pass moved a signature').toBe(0);
    expect(second.signatures.unchanged).toBe(2);
    // The refusals are re-derived every pass rather than remembered, so they do
    // NOT converge — and reporting them as "already present" would hide a
    // registry that stopped resolving something.
    expect(second.axes.unresolved).toBe(1);
    expect(second.assignments.unresolved).toBe(1);
    expect(second.diagnostics.assignmentsRemoved, 'the second pass orphaned a row').toBe(0);

    // And the rows themselves did not move. The counters above are the service's
    // own account of what it did; this is Postgres's. `id` catches a
    // delete-and-reinsert (which `replaceVariantAxisAssignments` performs, and
    // which the `unchanged` guard is what prevents), `xmin` catches an update
    // that wrote identical values back.
    const after = await readRowIdentity();
    expect(after.axes, 'the axis row was rewritten by a no-op pass').toEqual(before.axes);
    expect(
      after.assignments,
      'the assignment rows were deleted and reinserted by a no-op pass',
    ).toEqual(before.assignments);
    expect(after.signatures, 'the signature rows were rewritten by a no-op pass').toEqual(
      before.signatures,
    );
    expect(after.claims, 'the claim rows were rewritten by a no-op pass').toEqual(before.claims);

    reportPopulation(
      `[idempotency] first pass wrote 2 axes / 4 assignments / 8 claims / 2 signatures; ` +
        `second pass wrote 0 of each over the same ${second.scanned.listingOptions} options and ` +
        `${second.scanned.variantOptionValues} option values, with ` +
        `${after.axes.length + after.assignments.length + after.signatures.length + after.claims.length} ` +
        'row identities unchanged.',
    );
  });
});
