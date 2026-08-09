/**
 * The discovery cohort one eBay source sweeps — issue #65 adapter rule 9 and
 * acceptance 7, "public rollout starts with a bounded category or market
 * cohort".
 *
 * eBay's Browse API grants search-driven discovery and publishes no catalogue
 * export, so a marketplace's "catalogue" inside Mercaria is exactly the union of
 * the queries an operator configured. These rows ARE that cohort — which is why
 * they are a table an operator widens one row at a time rather than a list in an
 * environment variable: a rollout is a sequence of decisions somebody made, each
 * with the evidence of what it returned beside it.
 */

import { and, asc, eq } from 'drizzle-orm';
import type { EbayDiscoveryQueryKind, EbayMarketplaceId } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { EBAY_MAX_TEXT_LENGTH, ebayDiscoveryQueries } from '../schema/ebay.js';

export type EbayDiscoveryQueryRow = typeof ebayDiscoveryQueries.$inferSelect;

export interface UpsertDiscoveryQueryInput {
  sourceId: string;
  marketplaceId: EbayMarketplaceId;
  queryKind: EbayDiscoveryQueryKind;
  queryValue: string;
  position: number;
  enabled: boolean;
  maxOffset: number;
  createdByOxyUserId: string;
  note: string | null;
}

/**
 * Add or reconfigure one discovery query.
 *
 * `ON CONFLICT DO UPDATE` on the identity unique, so re-adding a query an
 * operator already configured converges rather than sweeping the same category
 * twice. `last_completed_at` and `last_item_count` are deliberately NOT touched:
 * they are evidence of what the previous sweep found, and a reconfiguration that
 * erased them would destroy the only record of whether the cohort was ever
 * productive.
 */
export async function upsertEbayDiscoveryQuery(
  db: DatabaseOrTransaction = getDb(),
  input: UpsertDiscoveryQueryInput,
): Promise<EbayDiscoveryQueryRow> {
  const [row] = await db
    .insert(ebayDiscoveryQueries)
    .values({
      sourceId: input.sourceId,
      marketplaceId: input.marketplaceId,
      queryKind: input.queryKind,
      queryValue: input.queryValue,
      position: input.position,
      enabled: input.enabled,
      maxOffset: input.maxOffset,
      createdByOxyUserId: input.createdByOxyUserId,
      note: input.note === null ? null : input.note.slice(0, EBAY_MAX_TEXT_LENGTH),
    })
    .onConflictDoUpdate({
      target: [
        ebayDiscoveryQueries.sourceId,
        ebayDiscoveryQueries.marketplaceId,
        ebayDiscoveryQueries.queryKind,
        ebayDiscoveryQueries.queryValue,
      ],
      set: {
        position: input.position,
        enabled: input.enabled,
        maxOffset: input.maxOffset,
        note: input.note === null ? null : input.note.slice(0, EBAY_MAX_TEXT_LENGTH),
      },
    })
    .returning();
  if (!row) throw new Error('ebay_discovery_queries upsert returned no row');
  return row;
}

/**
 * The ENABLED targets a sweep visits, in their total order.
 *
 * Ordered on `(position, id)` rather than on `created_at`: two rows created in
 * the same millisecond order arbitrarily under a uuid v7 primary key (the
 * finding in `~/Oxy/AGENTS.md`), and a cohort that reordered between pages would
 * make a cursor mean something different on the retry than it did on the
 * attempt — which in a verification pass is how an item gets skipped and then
 * retired for having been missed.
 */
export async function listEnabledEbayDiscoveryQueries(
  db: DatabaseOrTransaction = getDb(),
  sourceId: string,
): Promise<EbayDiscoveryQueryRow[]> {
  return db
    .select()
    .from(ebayDiscoveryQueries)
    .where(and(eq(ebayDiscoveryQueries.sourceId, sourceId), eq(ebayDiscoveryQueries.enabled, true)))
    .orderBy(asc(ebayDiscoveryQueries.position), asc(ebayDiscoveryQueries.id));
}

/** Every query for a source, enabled or not — the operator listing. */
export async function listEbayDiscoveryQueries(
  db: DatabaseOrTransaction = getDb(),
  sourceId: string,
): Promise<EbayDiscoveryQueryRow[]> {
  return db
    .select()
    .from(ebayDiscoveryQueries)
    .where(eq(ebayDiscoveryQueries.sourceId, sourceId))
    .orderBy(asc(ebayDiscoveryQueries.position), asc(ebayDiscoveryQueries.id));
}

/** Record what one completed sweep of a query found. Evidence, never control flow. */
export async function recordEbayDiscoverySweep(
  db: DatabaseOrTransaction = getDb(),
  input: { id: string; itemCount: number; now: Date },
): Promise<void> {
  await db
    .update(ebayDiscoveryQueries)
    .set({ lastCompletedAt: input.now, lastItemCount: input.itemCount })
    .where(eq(ebayDiscoveryQueries.id, input.id));
}
