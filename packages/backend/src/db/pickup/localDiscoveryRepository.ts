/**
 * `listing_local_discovery` — the only writer of a P2P seller's coarse area.
 *
 * The write signature is what enforces #93 P2P rule 5: it takes CELL INDICES,
 * because that is what the table holds, so a caller with a precise coordinate
 * has to pass it through `toLocalArea` first and there is no overload that
 * would let them skip it. The table has no coordinate column to write into
 * either, so this is true of a migration and of `psql` as well as of this
 * module.
 *
 * ## The neighbourhood search is over CELLS, not over a radius
 *
 * A `ST_DWithin` here would be a precision this data does not have: every
 * position in the table is already rounded to a cell, so a distance computed
 * from one is accurate to roughly the cell size whatever the query says. The
 * read therefore selects a square RING of cells around the viewer's own cell
 * and lets the service estimate a band from the centres — which is honest about
 * the resolution and needs no geospatial index at all, just the plain
 * `(lat_index, lon_index)` btree.
 */

import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { listingLocalDiscovery } from '../schema/pickup.js';
import { listings } from '../schema/catalog.js';

/** One row of `listing_local_discovery`. */
export type ListingLocalDiscoveryRow = InferSelectModel<typeof listingLocalDiscovery>;

/** What a seller's opt-in saves. Indices only — see the module docblock. */
export interface LocalDiscoveryWrite {
  readonly listingId: string;
  readonly enabled: boolean;
  readonly cellLatIndex: number;
  readonly cellLonIndex: number;
  readonly cellPrecisionDegrees: number;
  readonly areaLabel: string;
  readonly country: string;
  readonly region: string | null;
}

/** Read one listing's opt-in. */
export async function findLocalDiscovery(
  listingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingLocalDiscoveryRow | null> {
  const [row] = await db
    .select()
    .from(listingLocalDiscovery)
    .where(eq(listingLocalDiscovery.listingId, listingId))
    .limit(1);
  return row ?? null;
}

/** Create or replace one listing's opt-in. */
export async function upsertLocalDiscovery(
  input: LocalDiscoveryWrite,
  db: DatabaseOrTransaction = getDb(),
): Promise<ListingLocalDiscoveryRow> {
  const [row] = await db
    .insert(listingLocalDiscovery)
    .values(input)
    .onConflictDoUpdate({
      target: listingLocalDiscovery.listingId,
      set: {
        enabled: input.enabled,
        cellLatIndex: input.cellLatIndex,
        cellLonIndex: input.cellLonIndex,
        cellPrecisionDegrees: input.cellPrecisionDegrees,
        areaLabel: input.areaLabel,
        country: input.country,
        region: input.region,
      },
    })
    .returning();
  return row;
}

/** One nearby P2P listing, as the public read projects it. */
export interface LocalDiscoveryCandidateRow {
  readonly listingId: string;
  readonly title: string;
  readonly priceAmount: number | null;
  readonly priceCurrency: string | null;
  readonly condition: string;
  readonly sellerOxyUserId: string;
  readonly areaLabel: string;
  readonly cellLatIndex: number;
  readonly cellLonIndex: number;
  readonly cellPrecisionDegrees: number;
}

/**
 * Enabled P2P listings inside a square ring of cells around one cell.
 *
 * `owner_type = 'user'` is stated EXPLICITLY rather than left to the listing's
 * owner-exclusivity CHECK, the `sellerListingsPredicate` reasoning from #92: a
 * store's stock must never read as a person's, and this is the one query where
 * a future widening of that CHECK would disclose it.
 *
 * `status = 'active'` excludes `restricted`, which is what a takedown writes —
 * so a moderation restriction removes a listing from local discovery in the
 * statement that applies it.
 */
export async function findNearbyLocalListings(
  input: {
    latIndex: number;
    lonIndex: number;
    ringCells: number;
    country?: string;
    limit: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly LocalDiscoveryCandidateRow[]> {
  const rows = await db
    .select({
      listingId: listings.id,
      title: listings.title,
      priceAmount: listings.priceRangeMinAmount,
      priceCurrency: listings.priceRangeMinCurrency,
      condition: listings.condition,
      sellerOxyUserId: listings.oxyUserId,
      areaLabel: listingLocalDiscovery.areaLabel,
      cellLatIndex: listingLocalDiscovery.cellLatIndex,
      cellLonIndex: listingLocalDiscovery.cellLonIndex,
      cellPrecisionDegrees: listingLocalDiscovery.cellPrecisionDegrees,
    })
    .from(listingLocalDiscovery)
    .innerJoin(listings, eq(listings.id, listingLocalDiscovery.listingId))
    .where(
      and(
        eq(listingLocalDiscovery.enabled, true),
        gte(listingLocalDiscovery.cellLatIndex, input.latIndex - input.ringCells),
        lte(listingLocalDiscovery.cellLatIndex, input.latIndex + input.ringCells),
        gte(listingLocalDiscovery.cellLonIndex, input.lonIndex - input.ringCells),
        lte(listingLocalDiscovery.cellLonIndex, input.lonIndex + input.ringCells),
        eq(listings.status, 'active'),
        eq(listings.ownerType, 'user'),
        ...(input.country === undefined ? [] : [eq(listingLocalDiscovery.country, input.country)]),
      ),
    )
    .orderBy(asc(listings.id))
    .limit(input.limit);

  return rows.map((row) => ({
    listingId: row.listingId,
    title: row.title,
    priceAmount: row.priceAmount === null ? null : Number(row.priceAmount),
    priceCurrency: row.priceCurrency,
    condition: row.condition,
    sellerOxyUserId: row.sellerOxyUserId ?? '',
    areaLabel: row.areaLabel,
    cellLatIndex: row.cellLatIndex,
    cellLonIndex: row.cellLonIndex,
    cellPrecisionDegrees: row.cellPrecisionDegrees,
  }));
}
