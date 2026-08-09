/**
 * `awin_feeds` — one feed an advertiser publishes, and everything needed to
 * decide whether to download it (#66).
 *
 * The two staleness detectors this table carries are NOT redundant and the
 * distinction lives here rather than in a comment somewhere:
 * `imported_last_imported_at` is what the last pass actually CONSUMED, so the
 * scheduler can skip a feed for the cost of one CSV across the whole network;
 * `http_etag`/`http_last_modified` are #63's conditional-request validators,
 * which are a claim about the BYTES rather than about the provider's own
 * pipeline. See the schema docblock for why both are needed.
 */

import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import type { AwinFeedColumn } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { awinFeeds } from '../schema/awin.js';

export type AwinFeedRow = typeof awinFeeds.$inferSelect;

export interface DiscoverAwinFeedInput {
  advertiserRowId: string;
  feedId: string;
  feedName: string;
  language?: string | null;
  currency?: string | null;
  productCount?: number | null;
  listedLastImportedAt?: Date | null;
  now?: Date;
}

/**
 * Record that the feed list mentioned this feed.
 *
 * Idempotent on `(advertiser_row_id, feed_id)`. It writes only what the LIST
 * says and never the import state: a discovery pass that reset
 * `imported_last_imported_at` would make every feed look due, which is the
 * whole network re-downloaded on the hour.
 */
export async function discoverAwinFeed(
  input: DiscoverAwinFeedInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<AwinFeedRow> {
  const now = input.now ?? new Date();
  const listed = {
    feedName: input.feedName,
    language: input.language ?? null,
    currency: input.currency ?? null,
    productCount: input.productCount ?? null,
    listedLastImportedAt: input.listedLastImportedAt ?? null,
    lastSeenInListAt: now,
  };
  const [row] = await db
    .insert(awinFeeds)
    .values({ advertiserRowId: input.advertiserRowId, feedId: input.feedId, ...listed })
    .onConflictDoUpdate({
      target: [awinFeeds.advertiserRowId, awinFeeds.feedId],
      set: { ...listed, updatedAt: now },
    })
    .returning();
  if (row === undefined) throw new Error('awin_feeds upsert returned no row');
  return row;
}

export async function findAwinFeed(
  feedRowId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AwinFeedRow | null> {
  const [row] = await db.select().from(awinFeeds).where(eq(awinFeeds.id, feedRowId)).limit(1);
  return row ?? null;
}

export async function listAwinFeeds(
  advertiserRowId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly AwinFeedRow[]> {
  return db
    .select()
    .from(awinFeeds)
    .where(eq(awinFeeds.advertiserRowId, advertiserRowId))
    .orderBy(asc(awinFeeds.feedId));
}

/**
 * The feed this advertiser's source fetches.
 *
 * The FIRST by feed id, deterministically, and the choice is stated because it
 * is a real limitation rather than an oversight: an advertiser that publishes
 * several feeds (per language, per vertical) currently ingests one of them. The
 * alternative — one source per FEED — would give a retailer several merchants
 * and several storefronts, which breaks acceptance 3 outright. Ingesting
 * several feeds under one source is a page-ordering change inside the adapter
 * and is deferred rather than half-built.
 */
export async function findPrimaryAwinFeed(
  advertiserRowId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AwinFeedRow | null> {
  const [row] = await db
    .select()
    .from(awinFeeds)
    .where(and(eq(awinFeeds.advertiserRowId, advertiserRowId), isNotNull(awinFeeds.lastSeenInListAt)))
    .orderBy(asc(awinFeeds.feedId))
    .limit(1);
  return row ?? null;
}

export interface RecordAwinFeedImportInput {
  feedRowId: string;
  digest: string;
  /** The `Last Imported` this pass consumed — the cheap staleness detector. */
  consumedLastImportedAt: Date | null;
  declaredColumns: readonly AwinFeedColumn[];
  mappingVersion: number;
  now?: Date;
}

/** A pass that actually read the feed. */
export async function recordAwinFeedImport(
  input: RecordAwinFeedImportInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const now = input.now ?? new Date();
  await db
    .update(awinFeeds)
    .set({
      lastImportAt: now,
      lastImportDigest: input.digest,
      importedLastImportedAt: input.consumedLastImportedAt,
      declaredColumns: [...input.declaredColumns],
      mappingVersion: input.mappingVersion,
      updatedAt: now,
    })
    .where(eq(awinFeeds.id, input.feedRowId));
}

/** Store the validators the NEXT conditional request will present. */
export async function recordAwinFeedValidators(
  input: { feedRowId: string; etag: string | null; lastModified: string | null; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const now = input.now ?? new Date();
  await db
    .update(awinFeeds)
    .set({ httpEtag: input.etag, httpLastModified: input.lastModified, updatedAt: now })
    .where(eq(awinFeeds.id, input.feedRowId));
}

/**
 * Forget this feed's conditional-request validators.
 *
 * Called when the mapping version moves. A 304 answers "your copy of the BYTES
 * is current", which stays true across a mapping change and would make the
 * re-read the version bump exists to schedule a no-op — the feed would be
 * re-read only when the advertiser next republished, which for a stable
 * catalogue is never.
 */
export async function clearAwinFeedValidators(
  input: { feedRowId: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const now = input.now ?? new Date();
  await db
    .update(awinFeeds)
    .set({ httpEtag: null, httpLastModified: null, updatedAt: now })
    .where(eq(awinFeeds.id, input.feedRowId));
}

/** Feeds the list stopped mentioning, for the closure reconciliation. */
export async function listAwinFeedsMissingFromList(
  input: { advertiserRowId: string; polledAt: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly AwinFeedRow[]> {
  return db
    .select()
    .from(awinFeeds)
    .where(
      and(
        eq(awinFeeds.advertiserRowId, input.advertiserRowId),
        // A feed seen BEFORE this poll started was not in this poll's list.
        sql`${awinFeeds.lastSeenInListAt} is null
            or ${awinFeeds.lastSeenInListAt} < ${input.polledAt.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(awinFeeds.feedId));
}
