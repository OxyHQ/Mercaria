/**
 * The commercial context one real-store verification run needs, seeded through
 * the REAL repositories.
 *
 * These are ordinary rows written by the same functions the API writes them
 * with — the `createStore` SERVICE, `insertStoreMember`, the real `categories`
 * table — not a fixture layer and not raw SQL.
 *
 * The SERVICE rather than the repository, and that distinction cost a run:
 * `createStore` also creates the store's default inventory Location, which
 * `createStoreProduct` resolves on EVERY import. Seeding through `insertStore`
 * produced a store with none, and the backfill then failed all 124 products with
 * `No location for store` — per product, while the run itself still reported
 * `completed`. `assertSeedIsUsable` below turns that into a loud failure at seed
 * time instead.
 *
 * Raw SQL is avoided for a second reason: it bypasses drizzle's `generatedId()`
 * defaults and the casing configuration (`db/postgres.ts` says exactly this
 * about `$client`).
 *
 * Idempotent, so a re-run of the driver reuses what is already there.
 *
 * It does NOT follow that the database may hold only one store. An earlier
 * version of this comment claimed a second store would make "one connection row,
 * not two" (W1's observable) unstateable, and that was wrong in a way worth
 * recording: the defect would have been in the ASSERTION, not in the
 * environment. Every count this harness makes is scoped to the store the run
 * owns (`countConnections` is `where store_id = $1 and provider = $2`), and the
 * stronger form of W1 is the scoped one anyway — "exactly one connection row for
 * this shop domain on this store" is what "a reconnect does not create a
 * duplicate" actually means. A GLOBAL count never tested that; it tested that
 * nothing else existed in the database, which fails in the victim the moment a
 * sibling seeds a row and names nothing about the cause.
 */

import { eq } from 'drizzle-orm';
import { connectPostgres, getDb } from '../../src/db/postgres.js';
import { categories } from '../../src/db/schema/catalog.js';
import {
  findStoreByHandle,
  findStoreMember,
  insertStoreMember,
  type StoreRecord,
} from '../../src/db/stores/storeRepository.js';
import { findDefaultLocationId } from '../../src/db/stores/locationRepository.js';
import { ROLE_PERMISSIONS } from '../../src/middleware/store-authz.js';
import { createStore } from '../../src/services/store.service.js';

/** The handle this run's store is created under. */
export const E2E_STORE_HANDLE = 'connector-verification-69';

/** What the seed produced, for the evidence document. */
export interface SeededContext {
  readonly store: StoreRecord;
  readonly categorySlug: string;
  /** True when this run created the store rather than reusing one. */
  readonly storeCreated: boolean;
  /** True when this run added the operator's membership. */
  readonly membershipCreated: boolean;
  /** True when this run created the default category. */
  readonly categoryCreated: boolean;
}

/**
 * Ensure the category imported products are filed under EXISTS.
 *
 * A freshly migrated database has none, and `CONNECTOR_DEFAULT_CATEGORY_SLUG`
 * naming a slug that does not exist fails the backfill — with a clear error, but
 * one that reads as a connector defect to anybody who did not seed first.
 */
async function ensureCategory(slug: string): Promise<boolean> {
  const db = getDb();
  const [existing] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, slug))
    .limit(1);
  if (existing) return false;

  await db.insert(categories).values({
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
    slug,
    ancestorSlugs: [slug],
    position: 0,
    isActive: true,
  });
  return true;
}

/**
 * Create (or reuse) the store, its owner membership and the default category.
 *
 * The operator is made an `owner`, which holds every permission including
 * `channels:write`. `ROLE_PERMISSIONS` is read from `store-authz.ts` rather than
 * listed here for the reason that module gives about `STORE_PERMISSIONS`: a
 * hand-copied list can grant a permission the database's own CHECK then refuses,
 * which surfaces as a 500 on an insert rather than as a wrong list.
 */
export async function seedVerificationContext(input: {
  readonly oxyUserId: string;
  readonly categorySlug: string;
}): Promise<SeededContext> {
  await connectPostgres();

  const categoryCreated = await ensureCategory(input.categorySlug);

  const existing = await findStoreByHandle(E2E_STORE_HANDLE);
  if (existing) {
    const member = await findStoreMember(existing.id, input.oxyUserId);
    let membershipCreated = false;
    if (!member) {
      await insertStoreMember(existing.id, {
        oxyUserId: input.oxyUserId,
        role: 'owner',
        permissions: ROLE_PERMISSIONS.owner,
      });
      membershipCreated = true;
    }
    const store = await findStoreByHandle(E2E_STORE_HANDLE);
    return {
      store,
      categorySlug: input.categorySlug,
      storeCreated: false,
      membershipCreated,
      categoryCreated,
    };
  }

  // The SERVICE, not `insertStore`. A store created through the repository has
  // no inventory Location, and `createStoreProduct` resolves one on every
  // import — so a repository-seeded store fails EVERY connector product with
  // `No location for store` while the run itself still reports `completed`.
  // Measured: 124 products, 124 failures, a green-looking run. `createStore`
  // creates the default location the same way the HTTP route does.
  //
  // EUR rather than the FAIR default: the WooCommerce site trades in a fiat
  // currency and the shop side of every imported amount is this store's own
  // accounting currency. Leaving it FAIR would make every "native currency
  // preserved" observable read against a currency the site never quoted.
  const store = await createStore(input.oxyUserId, {
    name: 'Connector verification 69',
    description: 'Non-production store used to verify the connectors against a real store.',
    brandColor: '#000000',
    defaultCurrency: 'EUR',
  });

  await assertSeedIsUsable(store.id);

  return {
    store,
    categorySlug: input.categorySlug,
    storeCreated: true,
    membershipCreated: true,
    categoryCreated,
  };
}

/**
 * Refuse a store a backfill could not import into.
 *
 * The positive control on the seed. Without it, a store with no Location fails
 * every product individually while the RUN reports `completed`, which reads as a
 * connector defect and is not one.
 */
async function assertSeedIsUsable(storeId: string): Promise<void> {
  const locationId = await findDefaultLocationId(storeId);
  if (!locationId) {
    throw new Error(
      `Seeded store ${storeId} has no default inventory Location, so every connector ` +
        'product import would fail with `No location for store` while the run still ' +
        'reported `completed`. Seed through `createStore`, not `insertStore`.',
    );
  }
}
