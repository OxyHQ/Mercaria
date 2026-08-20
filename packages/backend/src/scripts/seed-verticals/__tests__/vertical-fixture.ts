/**
 * Seeding and tearing down a reference vertical inside the SHARED test database
 * (#367 Workstream 14).
 *
 * Not a test file — no `describe`, no `it`, nothing that would register a suite
 * when a case imports it.
 *
 * ## Every identity carries a per-RUN namespace
 *
 * Category `key`/`slug`, attribute `key`, product-type `(key, version)`,
 * brand/family/product `slug` and vehicle-make `key` are unique over the whole
 * database, and vitest runs files in parallel against ONE throwaway. Two files
 * applying one package would race on those uniques and the loser would fail on
 * a constraint that says nothing about what it was testing. So each file passes
 * its own token, and every assertion and every delete is scoped by it.
 *
 * ## What the teardown deliberately does NOT delete, and why
 *
 * THREE PARENTS survive, and each is a refusal by the SERVER rather than an
 * omission here:
 *
 * - **Attribute definitions.** `mercaria_attribute_definition_immutable`
 *   refuses to DELETE a version that has left `draft` ("stored values cite this
 *   version"), and this seed must publish them —
 *   `applyAttributeObservation` resolves the ACTIVE definition and
 *   `createVariant` collapses measurement units only against one. They stay
 *   ACTIVE and SCOPED to this run's categories, which is what keeps them out of
 *   every other file's reads: `listActiveDefinitionsForCategory` includes
 *   UNSCOPED definitions, so DELETING the scope rows — the obvious tidy-up —
 *   would make thirty definitions appear in every sibling's category.
 * - **Product-type definitions.** `product_type_definitions_immutable_once_published`
 *   refuses DELETE from `published` onward, for the same reason.
 * - **The CATEGORIES those two cite**, whose scope rows point at them with
 *   `ON DELETE restrict`. They are moved to `deprecated` instead, which
 *   `isCategoryLifecycleActive` reads as inactive, so `findActiveCategories` —
 *   what `GET /categories` and `feed.service` serve — never sees them again.
 *   The rows survive; the shelves do not.
 *
 * ## And so does EVERY CHILD OF A RETAINED PARENT
 *
 * That follows from the three above and is stated because the previous version
 * of this header did not: it said "everything else is deleted", and a reader
 * checking one table against that sentence found it false. Those children
 * `ON DELETE cascade` from their parent, and nothing here ever deletes the
 * parent — a `deprecated` category is an UPDATE — so the cascade never fires.
 *
 * Measured after one smartphone-package teardown (2026-08-17), which is the
 * whole of what survives:
 *
 * ```
 *   13  attribute_definitions          1  product_type_definitions
 *    4  attribute_value_localizations  3  product_type_localizations
 *    3  categories (0 of them ACTIVE)  7  category_localizations
 *   14  category_aliases               0  category_localized_slugs
 * ```
 *
 * The alias figure alone is NOT from that run: #732 grew the smartphone
 * package's list from five to fourteen, and fourteen is counted off the
 * package's own array rather than re-measured. Stated because a number carried
 * forward under a sentence that says "measured" is the shape of a stale census.
 *
 * Everything with an owner this fixture can delete is zero: brands, families,
 * products, variants, identifiers, observed facts, vehicles, fitments, claims,
 * sources, stores, listings and drafts.
 *
 * It is harmless and it is not nothing. Every read that could reach one of
 * those rows is either scoped to explicit ids (`readLocalizedCategories`,
 * `readLocalizedAttributeValues`) or filters `is_active`
 * (`findActiveCategories`) — INCLUDING `category_aliases`, which since #732 is
 * read on the retrieval path and whose read joins `categories` on `is_active`
 * for exactly this reason: the retained categories above are `0 of them
 * ACTIVE`. What it costs is that a namespace's parents outlive
 * its run — which is why the namespace is per-run rather than per-file, and why
 * a count over any of these tables must be scoped before it is trusted.
 *
 * The general rule, for whoever extends this: **a table is retained if its
 * nearest deletable ancestor is one of the three parents above.** Enumerating
 * the leaves is how this header went stale once already.
 *
 * Everything else is deleted, children first, so a wrong ordering still raises
 * loudly on a real `RESTRICT` rather than being swallowed.
 */

import { randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Database } from '../../../db/postgres.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';
import { deleteTestStores } from '../../../db/__tests__/store-teardown.js';
import { setCategoryLifecycle } from '../../../db/taxonomy/taxonomyRepository.js';
import { applyVerticalPackage, namespaceFor, type SeedHandles, type VerticalNamespace } from '../apply.js';
import { censusVerticalPackage, formatCensus } from '../census.js';
import type { VerticalPackage } from '../types.js';

/** The Oxy account every seeded row is attributed to. Namespaced like everything else. */
export function verticalActor(token: string): string {
  return `${token}-operator`;
}

/**
 * A namespace token for one file's run.
 *
 * Six hex characters after a fixed prefix: short enough to keep a category key
 * readable and random enough that two runs of one file against one long-lived
 * database do not collide on a unique.
 */
export function verticalRunToken(file: string): string {
  return `v367${file}${randomBytes(3).toString('hex')}`;
}

export interface SeededVertical {
  readonly ns: VerticalNamespace;
  readonly handles: SeedHandles;
  readonly actorOxyUserId: string;
}

/**
 * Apply a package and REFUSE to hand back anything unless the census matched.
 *
 * The refusal is the point. A file whose fixture half-applied would otherwise
 * run every case against a catalogue missing the rows those cases are about,
 * and the failures would name whichever assertion happened to touch a missing
 * row first. `formatCensus` puts the entity counts in the message, so the
 * failure names the table instead.
 */
export async function seedVerticalForTest(
  db: Database,
  pkg: VerticalPackage,
  token: string,
): Promise<SeededVertical> {
  const actorOxyUserId = verticalActor(token);
  const { report, handles } = await applyVerticalPackage(
    pkg,
    { apply: true, namespace: token, actorOxyUserId },
    db,
  );
  if (report.divergent > 0) {
    const detail = report.steps
      .filter((step) => step.outcome === 'divergent')
      .map((step) => `${step.entity} ${step.identity}: ${step.detail ?? 'divergent'}`)
      .join('\n');
    throw new Error(`Seeding '${pkg.name}' produced divergent steps:\n${detail}`);
  }

  const ns = namespaceFor(token);
  const verdict = await censusVerticalPackage(db, pkg, ns);
  if (verdict.outcome !== 'matched') {
    throw new Error(`Seeding '${pkg.name}' did not match its own census:\n${formatCensus(verdict)}`);
  }
  return { ns, handles, actorOxyUserId };
}

/** A store row, minimal and namespaced, for the authoring half of a file. */
export async function createTestStore(db: Database, token: string): Promise<string> {
  const storeId = `${token}-store`;
  await db.execute(sql`
    insert into stores (id, name, handle, description, brand_color)
    values (${storeId}, ${`${token} store`}, ${`${token}-store-handle`}, '', '#101010')
    on conflict (id) do nothing
  `);
  return storeId;
}

/**
 * Remove everything this run created that the server permits removing, and
 * retire what it does not. See the header for the two exceptions.
 *
 * Order is children-first and deliberate. Every foreign key crossed here is
 * `RESTRICT`, so a wrong order raises `23503` naming the table that refused —
 * which is what a teardown should do rather than swallowing the error and
 * leaving a sibling to fail on the residue.
 */
export async function teardownVertical(db: Database, token: string): Promise<void> {
  const ns = namespaceFor(token);
  const attrPrefix = `${ns.snake}_%`;
  const slugPrefix = `${ns.kebab}-%`;
  const categoryPrefix = `${ns.kebab}.%`;
  const tokenPrefix = `${token}%`;

  const productIds = await idsOf(db, sql`select id from canonical_products where slug like ${slugPrefix}`);
  const variantIds =
    productIds.length === 0
      ? []
      : await idsOf(
          db,
          sql`select v.id from canonical_variants v join canonical_products p on p.id = v.product_id where p.slug like ${slugPrefix}`,
        );

  // Compatibility first: `compatibility_claims` refuses DELETE by trigger, and
  // its `fitment_id` is `restrict`, so the claims genuinely have to go before
  // the fitments do. ONE table in the window, disabled and re-enabled inside
  // it — `advisory-lock-census.test.ts` fails the build on any other spelling,
  // and a bare `db.transaction` would leave the trigger off database-wide after
  // a throw, so every later file asserting it refuses a write would pass
  // VACUOUSLY.
  const claimCount = await countOf(
    db,
    sql`select count(*)::int as total from compatibility_claims c join canonical_variants v on v.id = c.subject_variant_id join canonical_products p on p.id = v.product_id where p.slug like ${slugPrefix}`,
  );
  if (claimCount > 0) {
    const { withTriggerToggleLock } = await import('../../../db/__tests__/trigger-toggle-lock.js');
    await withTriggerToggleLock(db, async (tx) => {
      await tx.execute(
        sql`alter table compatibility_claims disable trigger mercaria_compatibility_claims_raw_freeze`,
      );
      await tx.execute(sql`
        delete from compatibility_claims
        where subject_variant_id in (
          select v.id from canonical_variants v
          join canonical_products p on p.id = v.product_id
          where p.slug like ${slugPrefix}
        )
      `);
      await tx.execute(
        sql`alter table compatibility_claims enable trigger mercaria_compatibility_claims_raw_freeze`,
      );
    });
  }

  await db.execute(sql`
    delete from automotive_fitments
    where subject_variant_id in (
      select v.id from canonical_variants v
      join canonical_products p on p.id = v.product_id
      where p.slug like ${slugPrefix}
    )
  `);
  await db.execute(sql`
    delete from vehicle_configurations where generation_id in (
      select g.id from vehicle_generations g
      join vehicle_models m on m.id = g.model_id
      join vehicle_makes k on k.id = m.make_id
      where k.key like ${attrPrefix})
  `);
  await db.execute(sql`
    delete from vehicle_generations where model_id in (
      select m.id from vehicle_models m
      join vehicle_makes k on k.id = m.make_id
      where k.key like ${attrPrefix})
  `);
  await db.execute(
    sql`delete from vehicle_models where make_id in (select id from vehicle_makes where key like ${attrPrefix})`,
  );
  await db.execute(sql`delete from vehicle_makes where key like ${attrPrefix}`);

  // Anything the file's own authoring half created. `product_variants`,
  // `native_listing_links` and the listing's satellites all CASCADE from
  // `listings`, so the listing delete is what carries them.
  await db.execute(
    sql`delete from catalog_authoring_draft_values where draft_id in (select id from catalog_authoring_drafts where store_id like ${tokenPrefix})`,
  );
  await db.execute(
    sql`delete from catalog_authoring_draft_variants where draft_id in (select id from catalog_authoring_drafts where store_id like ${tokenPrefix})`,
  );
  await db.execute(sql`delete from catalog_authoring_drafts where store_id like ${tokenPrefix}`);
  await db.execute(sql`delete from listings where store_id like ${tokenPrefix}`);
  await db.execute(sql`delete from locations where store_id like ${tokenPrefix}`);
  // `deleteTestStores` and NEVER a bare delete. `services/backfill/stages/store-merchants.ts`
  // pages EVERY active store in the shared database and writes a
  // `native_store_links` row under its own merchant, and that foreign key is
  // `ON DELETE restrict` — so a store this file owns can acquire a dependent
  // that this file cannot know about, between its last write and its teardown.
  // The helper clears the link by STORE id, which is the only key that covers
  // one nobody here recorded.
  const storeIds = await idsOf(db, sql`select id from stores where id like ${tokenPrefix}`);
  await deleteTestStores(db, storeIds);

  // Canonical children, then the canonical rows through the shared helper —
  // which declines exactly the ids a sibling's matcher has since cited rather
  // than deleting another file's row.
  // A SUBQUERY and never `= any(${ids})`: drizzle renders a bare JavaScript
  // array into an `sql` template as a ROW CONSTRUCTOR, so `any((\$1, \$2, …))`
  // is refused by Postgres with `op ANY/ALL (array) requires array on right
  // side`. The subquery also keeps the predicate in one place.
  const variantScope = sql`
    select v.id from canonical_variants v
    join canonical_products p on p.id = v.product_id
    where p.slug like ${slugPrefix}
  `;
  const productScope = sql`select id from canonical_products where slug like ${slugPrefix}`;

  await db.execute(sql`delete from product_identifiers where variant_id in (${variantScope})`);
  await db.execute(sql`delete from canonical_attribute_values where attribute_key like ${attrPrefix}`);
  await db.execute(sql`delete from canonical_variant_attributes where variant_id in (${variantScope})`);
  await db.execute(sql`delete from canonical_variant_aliases where variant_id in (${variantScope})`);
  await db.execute(
    sql`delete from canonical_variant_source_links where variant_id in (${variantScope})`,
  );
  if (variantIds.length > 0) await deleteTestCanonicalRows(db, { variantIds });

  await db.execute(sql`delete from canonical_product_aliases where product_id in (${productScope})`);
  await db.execute(
    sql`delete from canonical_product_source_links where product_id in (${productScope})`,
  );
  if (productIds.length > 0) await deleteTestCanonicalRows(db, { productIds });

  await db.execute(
    sql`delete from canonical_product_family_aliases where family_id in (select id from canonical_product_families where slug like ${slugPrefix})`,
  );
  await db.execute(sql`delete from canonical_product_families where slug like ${slugPrefix}`);
  await db.execute(
    sql`delete from brand_aliases where brand_id in (select id from brands where slug like ${slugPrefix})`,
  );
  await db.execute(sql`delete from brands where slug like ${slugPrefix}`);

  await db.execute(
    sql`delete from source_records where source_id in (select id from catalog_sources where name like ${`${ns.kebab}:%`})`,
  );
  await db.execute(sql`delete from catalog_sources where name like ${`${ns.kebab}:%`}`);

  // The categories STAY and are retired. See the header: the attribute and
  // product-type definitions that cite them cannot be deleted, and their scope
  // rows are `RESTRICT`. `deprecated` is what `isCategoryLifecycleActive` reads
  // as inactive, so nothing shopper-visible sees them again.
  const categoryIds = await idsOf(db, sql`select id from categories where key like ${categoryPrefix}`);
  for (const id of [...categoryIds].reverse()) {
    await setCategoryLifecycle(id, 'deprecated', db);
  }
}

async function idsOf(db: Database, statement: ReturnType<typeof sql>): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(statement);
  return [...rows].map((row) => row.id);
}

async function countOf(db: Database, statement: ReturnType<typeof sql>): Promise<number> {
  const rows = await db.execute<{ total: number }>(statement);
  return [...rows][0]?.total ?? 0;
}
