/**
 * The favorite → product-save migration (#80 migration rules 1–6).
 *
 * ## Nothing is ever removed, and that is acceptance 2
 *
 * "Existing favorites are never dropped during migration." This module issues no
 * DELETE and no UPDATE against `favorites` — the whole migration is INSERTs into
 * `product_saves` and `product_save_sources` — and
 * `product-save-isolation.test.ts` fails the build if a module here writes to
 * `favorites`. A listing save survives the migration whatever the migration
 * concluded about it, and the read mode decides whether it is still SHOWN
 * (`saved-items.service.ts`), which is a display decision the buyer's data
 * survives independently of.
 *
 * ## A replay cannot duplicate a save or a counter, and it rests on two
 * mechanisms rather than on this file being careful
 *
 * `product_saves_oxy_user_id_canonical_product_id_key` makes a second save
 * impossible whatever runs; the counter is DERIVED, so re-deriving it after a
 * replay produces the same number rather than a doubled one (#80 migration rule
 * 6, acceptance 6). The `product_save_sources` unique converges the LOG on top
 * of that — a separate property, stated separately, because that record cascades
 * with the favorite it names and idempotence must not depend on it.
 *
 * ## Unmatched and pinned favorites are left completely alone
 *
 * A listing with no CONFIDENT canonical attachment produces `unmatched` and no
 * save (#80 migration rule 3, acceptance 3), and an explicit PIN produces
 * `pin_preserved` and no save (#80 migration rule 4) — the buyer said they meant
 * the exact listing, and deriving a model save from that is Mercaria answering
 * a question they already answered. Both are SUCCESSES and both are counted, so
 * a report of a clean run says how much of the catalogue it deliberately left
 * behind rather than reporting a total that looks like coverage.
 *
 * ## A dry run is the default posture
 *
 * `PRODUCT_SAVE_MIGRATION_ENABLED=false` downgrades every request to a dry run
 * that reports exactly what it would do — the #60
 * `CANONICAL_WRITE_PUBLICATION_ENABLED` shape. The request is always answerable
 * and only the WRITE is gated, so an operator measures the migration before
 * authorising it rather than discovering its size afterwards.
 */

import type { ProductSaveMigrationReport } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import {
  findFavoriteMigrationPage,
  type FavoriteRecord,
} from '../../db/buyers/favoriteRepository.js';
import {
  findListingCanonicalMappings,
  type ListingCanonicalMapping,
} from '../../db/productSaves/listingMappingRepository.js';
import { insertProductSave } from '../../db/productSaves/productSaveRepository.js';
import {
  insertProductSaveSource,
  productSaveSourceExists,
} from '../../db/productSaves/productSaveSourceRepository.js';
import { rebuildProductSaveAggregate } from '../../db/productSaves/productSaveAggregateRepository.js';
import { log } from '../../lib/logger.js';
import { CONFIDENT_LINK_METHODS, PRODUCT_SAVE_MIGRATION_VERSION } from './mapping-version.js';

export interface RunMigrationInput {
  /** How many favorites this page examines. Bounded by the configured batch size. */
  readonly limit: number;
  /** The `favorites.id` the previous page stopped at. */
  readonly cursor?: string;
  /** Report without writing, even where writing is permitted. */
  readonly dryRun?: boolean;
}

/**
 * The one canonical product a favorited listing may become a save of.
 *
 * A listing attaches through its VARIANTS, and forty colours of one phone all
 * attach to canonical variants of ONE product — which is the ordinary case and
 * resolves cleanly. Attachments pointing at DIFFERENT products are the case
 * that must not resolve: a listing that is two products is exactly the
 * ambiguity #58 routes to a person, and picking the first is the silent false
 * merge this whole graph is built to avoid. It reports `undefined`, the favorite
 * stays a listing save, and #59's review queue is where it is answered.
 */
function resolveSingleProduct(
  mappings: readonly ListingCanonicalMapping[],
): ListingCanonicalMapping | undefined {
  const confident = mappings.filter((mapping) => CONFIDENT_LINK_METHODS.includes(mapping.method));
  if (confident.length === 0) return undefined;
  const products = new Set(confident.map((mapping) => mapping.canonicalProductId));
  if (products.size !== 1) return undefined;
  return confident[0];
}

/**
 * Run one page of the migration.
 *
 * Per-favorite error isolation is deliberate and matches #60's `examineSubject`:
 * one favorite whose listing is in a state nobody anticipated must not stop the
 * page, because a page that aborted on its worst row would leave the cursor
 * stuck on it forever. A page-level failure is different and is allowed to
 * propagate — the cursor has not advanced, so the next run starts where this one
 * did.
 */
export async function runFavoriteMigrationPage(
  input: RunMigrationInput,
): Promise<ProductSaveMigrationReport> {
  const dryRun = input.dryRun === true || !config.productSaves.migrationApplyEnabled;
  const limit = Math.min(input.limit, config.productSaves.migrationBatchSize);
  const db = getDb();

  const favorites = await findFavoriteMigrationPage(limit, input.cursor, db);
  const mappings = await findListingCanonicalMappings(
    favorites.map((favorite) => favorite.listingId),
    db,
  );

  let created = 0;
  let converged = 0;
  let unmatched = 0;
  let pinPreserved = 0;
  let alreadyMigrated = 0;
  const touchedProducts = new Set<string>();

  for (const favorite of favorites) {
    try {
      const outcome = await migrateOneFavorite(favorite, mappings.get(favorite.listingId) ?? [], dryRun);
      switch (outcome.kind) {
        case 'created':
          created += 1;
          touchedProducts.add(outcome.canonicalProductId);
          break;
        case 'converged':
          converged += 1;
          touchedProducts.add(outcome.canonicalProductId);
          break;
        case 'unmatched':
          unmatched += 1;
          break;
        case 'pin_preserved':
          pinPreserved += 1;
          break;
        case 'already_migrated':
          alreadyMigrated += 1;
          break;
      }
    } catch (err) {
      // Counted as `unmatched`, which is honest rather than convenient: the
      // favorite was NOT migrated and is still a listing save, which is exactly
      // what that outcome means. Swallowing it into a total would make a failed
      // row indistinguishable from a clean run — the failure mode #60's vacuity
      // floor exists to close, and the reason the log line carries the row id.
      unmatched += 1;
      log.general.error(
        { err, favoriteId: favorite.id, listingId: favorite.listingId },
        '[ProductSaves] a favorite could not be migrated; it stays a listing save',
      );
    }
  }

  if (!dryRun) {
    for (const canonicalProductId of touchedProducts) {
      await rebuildProductSaveAggregate(canonicalProductId, db);
    }
  }

  const last = favorites[favorites.length - 1];
  return {
    migrationVersion: PRODUCT_SAVE_MIGRATION_VERSION,
    dryRun,
    scanned: favorites.length,
    created,
    converged,
    unmatched,
    pinPreserved,
    alreadyMigrated,
    ...(favorites.length === limit && last ? { nextCursor: last.id } : {}),
  };
}

type MigrationOutcome =
  | { readonly kind: 'created' | 'converged'; readonly canonicalProductId: string }
  | { readonly kind: 'unmatched' | 'pin_preserved' | 'already_migrated'; readonly canonicalProductId?: undefined };

/**
 * Examine ONE favorite.
 *
 * The order of the checks is the order of #80's own migration rules and is
 * load-bearing: a PIN is answered before the mapping is even looked at, so a
 * pinned listing that happens to have a perfect canonical attachment still stays
 * a pin. Reversing the two would make the strongest signal a buyer can give —
 * "I meant this exact one" — lose to an automatic match.
 */
async function migrateOneFavorite(
  favorite: FavoriteRecord,
  mappings: readonly ListingCanonicalMapping[],
  dryRun: boolean,
): Promise<MigrationOutcome> {
  if (favorite.saveIntent === 'listing_pin') return { kind: 'pin_preserved' };

  if (await productSaveSourceExists(favorite.id, PRODUCT_SAVE_MIGRATION_VERSION)) {
    return { kind: 'already_migrated' };
  }

  const mapping = resolveSingleProduct(mappings);
  if (!mapping) return { kind: 'unmatched' };

  if (dryRun) {
    // A dry-run outcome is a PREDICTION and is reported as one. #60 records the
    // same decision: refusing to report `created` in dry-run mode would make the
    // mode unable to answer the question it exists for.
    return { kind: 'created', canonicalProductId: mapping.canonicalProductId };
  }

  const db = getDb();
  return db.transaction(async (tx) => {
    const { save, created } = await insertProductSave(
      {
        oxyUserId: favorite.oxyUserId,
        canonicalProductId: mapping.canonicalProductId,
        sourceContext: 'favorite_migration',
        // NO preferred variant, deliberately. The favorited listing attaches to
        // one canonical configuration, and writing it here would narrow the
        // buyer's save to it — an INFERENCE, and an arbitrary one: a buyer who
        // favorited two listings of one product in two colours would get
        // whichever the migration reached first, silently, forever. "Any
        // configuration" is the only reading of a listing favorite that is
        // never wrong, and the buyer can narrow it themselves (#80 API rule 5).
        migrationVersion: PRODUCT_SAVE_MIGRATION_VERSION,
      },
      tx,
    );
    await insertProductSaveSource(
      {
        saveId: save.id,
        favoriteId: favorite.id,
        listingId: favorite.listingId,
        productVariantId: mapping.productVariantId,
        migrationVersion: PRODUCT_SAVE_MIGRATION_VERSION,
      },
      tx,
    );
    // `converged` is #80 migration rule 4 and acceptance 1 working, not a
    // failure: a second favorited listing of a product the buyer already saves
    // records its provenance against the SAME save and creates nothing.
    return {
      kind: created ? ('created' as const) : ('converged' as const),
      canonicalProductId: mapping.canonicalProductId,
    };
  });
}
