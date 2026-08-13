/**
 * Deleting the `stores` rows a test owns, together with the canonical link a
 * WHOLE-CATALOGUE pass may have attached to one of them.
 *
 * ## The mechanism, which belongs to no single file
 *
 * `services/backfill/stages/store-merchants.ts` is the one place in this
 * backend that reads `stores` unscoped: it pages EVERY active store in the
 * database, mints a canonical merchant for each and writes a
 * `native_store_links` row under THAT merchant. `backfill.realdb.test.ts`
 * drives the real stage against the ONE throwaway database a suite run shares,
 * so a store any other file created can acquire a link between that file's last
 * write and its own teardown.
 *
 * `native_store_links.store_id` is `ON DELETE RESTRICT`, deliberately — an
 * active canonical link is a fact a store deletion must confront rather than
 * silently orphan (see the table's header in `schema/merchants.ts`). So the
 * teardown does not fail quietly: it raises `23503` naming a constraint that
 * has nothing to do with whatever the file was testing, in a file that did
 * nothing wrong.
 *
 * ## Why the clear is scoped by STORE and never by merchant
 *
 * The link is minted under the BACKFILL's merchant. A teardown that clears
 * links by the merchants it created cannot see it, and neither can one that
 * clears by the link ids it recorded. Three files had exactly that shape and
 * read as correct to any census asking whether a file mentions the table —
 * `store-linkage.realdb.test.ts` is the one that failed a full local run while
 * this was being written. The only key that covers a link nobody in the file
 * knows about is the store id the file DOES own.
 *
 * ## Why one function rather than the same two lines twenty times
 *
 * Vitest orders files by SIZE, so which files overlap changes whenever any file
 * anywhere gains a line. That makes this a property every store-owning fixture
 * needs, not a fix for the pairs that happen to collide today — and a property
 * every fixture needs is one a new file should get by reaching for the obvious
 * thing rather than by remembering. `store-teardown-census.test.ts` fails the
 * build on a test that deletes `stores` any other way.
 *
 * Merchants are deliberately NOT removed here. The link is what RESTRICTs the
 * store; the merchant restricts nothing about it, an orphan row in a throwaway
 * database is inert, and a merchant may carry storefronts and tombstones whose
 * removal order is its owning file's business (`commerce-graph.realdb.test.ts`
 * neutralizes both before it can delete one). A helper that guessed at that
 * would trade this failure for a less obvious one.
 */

import { inArray } from 'drizzle-orm';
import type { Database } from '../postgres.js';
import { nativeStoreLinks } from '../schema/merchants.js';
import { stores } from '../schema/stores.js';

/**
 * Delete `storeIds` and any canonical link pointing at them.
 *
 * Callers still owe their OWN `ON DELETE RESTRICT` children first — listings,
 * orders, refunds, draft orders, locations — because those are rows the file
 * created and knows about. What this covers is the one dependent a file cannot
 * know about, because another file's fixture caused it.
 */
export async function deleteTestStores(
  db: Database,
  storeIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(storeIds)];
  if (ids.length === 0) return;
  await db.delete(nativeStoreLinks).where(inArray(nativeStoreLinks.storeId, ids));
  await db.delete(stores).where(inArray(stores.id, ids));
}
