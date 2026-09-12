/**
 * The Mercaria Library — one view over two durable records (#1016 Workstream 10,
 * ADR 0011 D17).
 *
 * A buyer owns two kinds of digital thing and they are stored in two domains:
 * `asset_rights` (#1015, a creator's file) and `digital_fulfilments` (#1016, an
 * authorized retail artifact). This module projects both into one shape.
 *
 * ## There is no `library_entries` table, and that is the decision
 *
 * The epic says it outright: *"do not duplicate order truth in a disconnected
 * library database"*. A third table would be a copy of a fact two tables already
 * hold, and the day it disagreed with them is the day a buyer's purchase
 * disappears from their library while still existing in their order.
 *
 * ## One key asks both sources
 *
 * Both tables carry `buyer_key` in the same spelling — `oxy:<id>` or
 * `guest:<sessionId>` — so a guest reaches their retail purchases exactly as they
 * reach a download, through #101's scoped authorization, with no second identity
 * model and no email-plus-order-number lookup.
 *
 * ## What crosses to the client carries no secret
 *
 * `DigitalLibraryEntryView` has no secret property. `maskedHint` is at most four
 * characters and `revealed` is a boolean — enough to tell two purchases apart in
 * a list, not enough to use one. The secret is reached only through the reveal
 * path, which audits every time.
 */

import { inArray } from 'drizzle-orm';
import type { DigitalLibraryEntryView } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { findRightsForBuyer } from '../../db/digital/rightRepository.js';
import { findFulfilmentsForBuyer } from '../../db/digitalRetail/digitalFulfilmentRepository.js';
import { digitalAssets } from '../../db/schema/digitalAssets.js';
import { digitalFulfilmentArtifacts } from '../../db/schema/digitalRetail.js';

/** How many entries one page of a library holds. */
export const DEFAULT_LIBRARY_PAGE_SIZE = 50;

/**
 * What the buyer does next with a retail fulfilment.
 *
 * A total switch over the capability rather than a default, so a capability added
 * later cannot silently render as `none` — which would look to a buyer like a
 * purchase they cannot use.
 */
function actionForCapability(
  capability: DigitalLibraryEntryView['fulfilmentCapability'],
): DigitalLibraryEntryView['action'] {
  switch (capability) {
    case 'activation_key':
    case 'redemption_code':
    case 'licence_token':
      return 'reveal';
    case 'licence_file':
      return 'download';
    case 'direct_account_activation':
      return 'activate';
    case 'external_account_link_activation':
      return 'link_account';
    case null:
      return 'none';
  }
}

/**
 * Build one buyer's library.
 *
 * Both reads are bounded and the merge is by acquisition time, newest first. The
 * retail half needs one extra read — the active artifact's hint — and it is done
 * as ONE `inArray` rather than per row: a library page is the shape most likely
 * to become an N+1, and this one is over a table of bearer secrets whose reads
 * are worth counting.
 */
export async function buildBuyerLibrary(
  buyerKey: string,
  limit: number = DEFAULT_LIBRARY_PAGE_SIZE,
  tx?: DatabaseOrTransaction,
): Promise<DigitalLibraryEntryView[]> {
  const db = tx ?? getDb();

  const [rights, fulfilments] = await Promise.all([
    findRightsForBuyer(buyerKey, db),
    findFulfilmentsForBuyer(buyerKey, limit, db),
  ]);

  /* ---- the creator half (#1015) ----------------------------------------- */

  const assetIds = [...new Set(rights.map((right) => right.assetId))];
  const titles = new Map<string, string>();
  if (assetIds.length > 0) {
    const rows = await db
      .select({ id: digitalAssets.id, title: digitalAssets.title })
      .from(digitalAssets)
      .where(inArray(digitalAssets.id, assetIds));
    for (const row of rows) titles.set(row.id, row.title);
  }

  const creatorEntries: DigitalLibraryEntryView[] = rights.map((right) => ({
    id: right.id,
    origin: 'creator_asset',
    title: titles.get(right.assetId) ?? 'Digital asset',
    acquiredAt: right.grantedAt.toISOString(),
    // Only `active` authorizes a download; every other status is a thing the
    // buyer still OWNS a record of and cannot currently use, which is
    // `unavailable` rather than an entry that vanishes from their library.
    status: right.status === 'active' ? 'active' : 'unavailable',
    action: right.status === 'active' ? 'download' : 'none',
    fulfilmentCapability: null,
    maskedHint: null,
    revealed: false,
    orderId: right.orderId,
  }));

  /* ---- the retail half (#1016) ------------------------------------------ */

  const fulfilmentIds = fulfilments.map((fulfilment) => fulfilment.id);
  const hints = new Map<string, string | null>();
  if (fulfilmentIds.length > 0) {
    const rows = await db
      .select({
        fulfilmentId: digitalFulfilmentArtifacts.fulfilmentId,
        maskedHint: digitalFulfilmentArtifacts.maskedHint,
        state: digitalFulfilmentArtifacts.state,
      })
      .from(digitalFulfilmentArtifacts)
      .where(inArray(digitalFulfilmentArtifacts.fulfilmentId, fulfilmentIds));
    for (const row of rows) {
      if (row.state === 'active') hints.set(row.fulfilmentId, row.maskedHint);
    }
  }

  const retailEntries: DigitalLibraryEntryView[] = fulfilments.map((fulfilment) => ({
    id: fulfilment.id,
    origin: 'authorized_retail',
    title: fulfilment.displayTitle,
    acquiredAt: (fulfilment.deliveredAt ?? fulfilment.createdAt).toISOString(),
    status:
      fulfilment.status === 'delivered'
        ? 'active'
        : fulfilment.status === 'pending'
          ? 'pending'
          : 'unavailable',
    action:
      fulfilment.status === 'delivered' ? actionForCapability(fulfilment.capability) : 'none',
    fulfilmentCapability: fulfilment.capability,
    maskedHint: hints.get(fulfilment.id) ?? null,
    revealed: fulfilment.revealCount > 0,
    orderId: fulfilment.orderId,
  }));

  return [...creatorEntries, ...retailEntries]
    .sort((a, b) => (a.acquiredAt < b.acquiredAt ? 1 : a.acquiredAt > b.acquiredAt ? -1 : 0))
    .slice(0, limit);
}

/**
 * One library entry by fulfilment id, for the detail surface.
 *
 * Reads the buyer's page and finds the entry in it rather than querying the row
 * directly, so the OWNERSHIP check is the same one the list makes — a detail read
 * with its own predicate is how "somebody else's fulfilment" becomes readable by
 * id on exactly one surface.
 */
export async function findRetailLibraryEntry(
  buyerKey: string,
  fulfilmentId: string,
  tx?: DatabaseOrTransaction,
): Promise<DigitalLibraryEntryView | null> {
  const entries = await buildBuyerLibrary(buyerKey, DEFAULT_LIBRARY_PAGE_SIZE, tx);
  return entries.find((entry) => entry.id === fulfilmentId) ?? null;
}
