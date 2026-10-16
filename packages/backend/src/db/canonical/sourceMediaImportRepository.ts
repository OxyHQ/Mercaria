/**
 * `canonical_source_media_imports` — the queue of observations whose imagery is
 * owed to a canonical product (`db/schema/canonicalSourceMedia.ts` says why).
 *
 * New rows come from the `mercaria_canonical_source_media_enqueue` trigger of
 * migration `0173`; {@link requestCanonicalSourceMediaImport} is the same insert
 * for the backfill that queues links made before the trigger existed, and its
 * handle is REQUIRED (house-invariants, #584).
 *
 * The claim is the house lease (`FOR UPDATE SKIP LOCKED`, owner-checked) with
 * one addition: a GLOBAL in-flight cap across every task, read in the same
 * statement, so N API tasks cannot together hold more than `maxInFlight`
 * imports against Oxy at once. The read and the claim are one statement but two
 * snapshots of the count can still interleave under concurrency, so the cap is
 * approximate by at most one batch per task — a bound, not an exact quota.
 */

import { and, asc, count, eq, gt, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { canonicalImages } from '../schema/canonicalCatalog.js';
import {
  CANONICAL_SOURCE_MEDIA_MAX_LAST_ERROR_LENGTH,
  canonicalSourceMediaImports,
} from '../schema/canonicalSourceMedia.js';
import { sourceRecords } from '../schema/provenance.js';

export type CanonicalSourceMediaImportRow = typeof canonicalSourceMediaImports.$inferSelect;

/** Queue an import, exactly as the trigger does (a repeat writes nothing). */
export async function requestCanonicalSourceMediaImport(
  canonicalProductId: string,
  sourceRecordId: string,
  db: DatabaseOrTransaction,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .insert(canonicalSourceMediaImports)
    .values({
      canonicalProductId,
      sourceRecordId,
      status: 'pending',
      attempts: 0,
      availableAt: now,
    })
    .onConflictDoNothing({
      target: [
        canonicalSourceMediaImports.canonicalProductId,
        canonicalSourceMediaImports.sourceRecordId,
      ],
    })
    .returning({ id: canonicalSourceMediaImports.id });
  return rows.length === 1;
}

export async function claimCanonicalSourceMediaImports(
  options: {
    leaseOwner: string;
    batchSize: number;
    maxInFlight: number;
    leaseMs?: number;
    now?: Date;
    /** Claim only these products' jobs — a re-drive, or a test on the shared database. */
    onlyProductIds?: readonly string[];
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<CanonicalSourceMediaImportRow[]> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs ?? 5 * 60_000);
  const [inFlight] = await db
    .select({ n: count() })
    .from(canonicalSourceMediaImports)
    .where(
      and(
        eq(canonicalSourceMediaImports.status, 'processing'),
        gt(canonicalSourceMediaImports.leaseUntil, now),
      ),
    );
  const room = Math.min(options.batchSize, options.maxInFlight - Number(inFlight?.n ?? 0));
  if (room < 1) return [];
  const due = and(
    options.onlyProductIds
      ? inArray(canonicalSourceMediaImports.canonicalProductId, [...options.onlyProductIds])
      : undefined,
    or(
      and(
        eq(canonicalSourceMediaImports.status, 'pending'),
        lte(canonicalSourceMediaImports.availableAt, now),
      ),
      and(
        eq(canonicalSourceMediaImports.status, 'processing'),
        lte(canonicalSourceMediaImports.leaseUntil, now),
      ),
    ),
  );
  const claimed = await db
    .update(canonicalSourceMediaImports)
    .set({
      status: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + leaseMs),
      attempts: sql`${canonicalSourceMediaImports.attempts} + 1`,
      lastError: null,
    })
    // Same-table subquery: its own range entry shadows the outer one.
    .where(
      sql`${canonicalSourceMediaImports.id} in (
        select ${canonicalSourceMediaImports.id} from ${canonicalSourceMediaImports}
        where ${due}
        order by ${asc(canonicalSourceMediaImports.availableAt)}
        limit ${room}
        for update skip locked
      )`,
    )
    .returning();
  // `UPDATE … RETURNING` answers in no particular order. Run the jobs oldest-due
  // first, as they were chosen: a drain Oxy's budget stops part-way then defers
  // the newest, not an arbitrary few.
  return claimed.sort(
    (a, b) => a.availableAt.getTime() - b.availableAt.getTime() || a.id.localeCompare(b.id),
  );
}

function ownedLease(id: string, leaseOwner: string, now: Date) {
  return and(
    eq(canonicalSourceMediaImports.id, id),
    eq(canonicalSourceMediaImports.status, 'processing'),
    eq(canonicalSourceMediaImports.leaseOwner, leaseOwner),
    gt(canonicalSourceMediaImports.leaseUntil, now),
  );
}

/** A finished job is deleted: the images it wrote are the record. */
export async function completeCanonicalSourceMediaImport(
  id: string,
  leaseOwner: string,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(canonicalSourceMediaImports)
    .where(ownedLease(id, leaseOwner, now))
    .returning({ id: canonicalSourceMediaImports.id });
  return rows.length === 1;
}

export async function releaseCanonicalSourceMediaImport(
  options: {
    id: string;
    leaseOwner: string;
    deadLettered: boolean;
    availableAt: Date;
    error: string;
    now?: Date;
    /**
     * Give back the attempt the claim counted: the job was DEFERRED (Oxy's rate
     * limit, or this task's own pacing), not failed, so it never nears
     * `dead_letter` however long Oxy stays busy.
     */
    refundAttempt?: boolean;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(canonicalSourceMediaImports)
    .set({
      ...(options.refundAttempt
        ? { attempts: sql`greatest(${canonicalSourceMediaImports.attempts} - 1, 0)` }
        : {}),
      status: options.deadLettered ? 'dead_letter' : 'pending',
      availableAt: options.availableAt,
      lastError: options.error.slice(0, CANONICAL_SOURCE_MEDIA_MAX_LAST_ERROR_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(options.id, options.leaseOwner, options.now ?? new Date()))
    .returning({ id: canonicalSourceMediaImports.id });
  return rows.length === 1;
}

/**
 * The observation's stored media references, as the ingestion projection
 * wrote them (`buildStoredPayload`: an array of strings, URLs or provider
 * ids). A record stored without a payload — its source may not store — has
 * none. Anything else in the array (an operator observation's `{ kind,
 * reference }` objects) is not this path's input and is skipped.
 */
export async function findSourceRecordMedia(
  sourceRecordId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const [row] = await db
    .select({ payload: sourceRecords.payload })
    .from(sourceRecords)
    .where(eq(sourceRecords.id, sourceRecordId))
    .limit(1);
  const media = (row?.payload as { media?: unknown } | null | undefined)?.media;
  return Array.isArray(media)
    ? media.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** How many images a product SHOWS — active, imported, product grain. */
export async function countDisplayableProductImages(
  productId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(canonicalImages)
    .where(
      and(
        eq(canonicalImages.productId, productId),
        eq(canonicalImages.status, 'active'),
        isNotNull(canonicalImages.fileId),
      ),
    );
  return Number(row?.n ?? 0);
}

/** The next free gallery position of a product (after every existing row). */
export async function nextProductImagePosition(
  productId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${canonicalImages.position})` })
    .from(canonicalImages)
    .where(eq(canonicalImages.productId, productId));
  return row?.max === null || row?.max === undefined ? 0 : Number(row.max) + 1;
}

/**
 * Lock a product row for the rest of the caller's transaction: observations of
 * one product attach imagery one at a time (the `attachCanonicalMediaBySource`
 * premise — `applyProductSourceObservation` holds the same row lock).
 */
export async function lockCanonicalProductForMedia(
  productId: string,
  db: DatabaseOrTransaction,
): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(
    sql`select id from canonical_products where id = ${productId} for update`,
  );
  return rows.length === 1;
}

/**
 * One keyset page of ACTIVE source links whose observation names media — the
 * links made before the `0173` trigger existed, which the backfill queues.
 */
export async function findSourceLinksWithMediaPage(
  options: { after?: string; limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<{ linkId: string; productId: string; sourceRecordId: string }[]> {
  const rows = await db.execute<{
    link_id: string;
    product_id: string;
    source_record_id: string;
  }>(sql`
    select l.id as link_id, l.product_id, l.source_record_id
      from canonical_product_source_links l
      join source_records r on r.id = l.source_record_id
     where l.status = 'active'
       and jsonb_typeof(r.payload -> 'media') = 'array'
       and jsonb_array_length(r.payload -> 'media') > 0
       ${options.after === undefined ? sql`` : sql`and l.id > ${options.after}`}
     order by l.id
     limit ${options.limit}`);
  return rows.map((row) => ({
    linkId: String(row.link_id),
    productId: String(row.product_id),
    sourceRecordId: String(row.source_record_id),
  }));
}
