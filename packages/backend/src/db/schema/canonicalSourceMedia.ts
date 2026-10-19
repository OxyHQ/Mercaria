/**
 * `canonical_source_media_imports` — "this canonical product is now attached to
 * a source observation whose payload names images: copy them".
 *
 * The owner's decision is that Mercaria shows external imagery by COPYING it —
 * an eBay, Awin, open-data, Shopify-storefront or feed observation's
 * `source_records.payload.media` becomes `canonical_images` rows holding files
 * the Mercaria application owns (Oxy ADR 0043), with `source_url` and
 * `source_record_id` as provenance. Nothing displays a supplier URL.
 *
 * ## Why a queue, and why the trigger is on the SOURCE LINK
 *
 * Every path that attaches an observation to a canonical product writes an
 * active `canonical_product_source_links` row — the ingestion matcher, #60's
 * backfill minting a product, an operator's observation — so a trigger there
 * (migration `0173`) is the one place that sees all three, in the writer's own
 * transaction. It enqueues only when the observation's stored payload actually
 * names media. The import itself runs later, bounded: a feed of a million
 * offers enqueues a million cheap rows and is drained at the dispatcher's rate,
 * a global in-flight cap and per-record / per-product caps, never as a burst
 * against Oxy. A converged job is deleted; a dead letter stays visible.
 *
 * The CAPS are what make this safe at catalogue scale, not the queue alone: a
 * product that already shows `maxImagesPerProduct` images imports nothing more,
 * however many offers it has, and an import of a URL the product already holds
 * is never made (identity is the source URL, `attachCanonicalMediaBySource`).
 *
 * ## What is queued, and in what order
 *
 * Ingestion re-observes every offer on every run, and each observation is a new
 * `source_records` row and a new link — so a link whose observation names only
 * images the product already holds queues nothing (migration `0176`): 149,000
 * such no-op jobs once buried the products that had no image at all. And a
 * product that SHOWS no image is drained first (`priority` 0, set when the job
 * is queued): one with images can wait, one without is a blank card today.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { canonicalProducts } from './canonicalCatalog';
import { asEnumValues, checkOneOf } from './columns';
import { sourceRecords } from './provenance';

/** A finished job is DELETED, so the table holds only owed or failed work. */
export const CANONICAL_SOURCE_MEDIA_IMPORT_STATUSES = [
  'pending',
  'processing',
  'dead_letter',
] as const;
export type CanonicalSourceMediaImportStatus =
  (typeof CANONICAL_SOURCE_MEDIA_IMPORT_STATUSES)[number];

export const CANONICAL_SOURCE_MEDIA_MAX_LAST_ERROR_LENGTH = 2_000;

export const canonicalSourceMediaImports = pgTable(
  'canonical_source_media_imports',
  {
    id: generatedId(),
    /** CASCADE: a deleted product owes no imagery. A MERGED one is followed to its winner. */
    canonicalProductId: text()
      .notNull()
      .references(() => canonicalProducts.id, { onDelete: 'cascade' }),
    /** The observation whose `payload.media` is copied, and the provenance of each image. */
    sourceRecordId: text()
      .notNull()
      .references(() => sourceRecords.id, { onDelete: 'restrict' }),
    status: text({ enum: asEnumValues(CANONICAL_SOURCE_MEDIA_IMPORT_STATUSES) })
      .notNull()
      .default('pending'),
    attempts: integer().notNull().default(0),
    /** 0: the product showed no image when this was queued — drained first. 1: it did. */
    priority: integer().notNull().default(1),
    availableAt: timestamptz().notNull(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'canonical_source_media_imports_status_check',
      t.status,
      CANONICAL_SOURCE_MEDIA_IMPORT_STATUSES,
    ),
    check('canonical_source_media_imports_attempts_check', sql`${t.attempts} >= 0`),
    check('canonical_source_media_imports_priority_check', sql`${t.priority} in (0, 1)`),
    check(
      'canonical_source_media_imports_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= ${sql.raw(String(CANONICAL_SOURCE_MEDIA_MAX_LAST_ERROR_LENGTH))}`,
    ),
    /** One owed import per (product, observation): a repeated link writes nothing new. */
    uniqueIndex('canonical_source_media_imports_product_record_key').on(
      t.canonicalProductId,
      t.sourceRecordId,
    ),
    index('canonical_source_media_imports_pending_idx')
      .on(t.priority, t.availableAt, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index('canonical_source_media_imports_reclaim_idx')
      .on(t.leaseUntil, t.createdAt)
      .where(sql`${t.status} = 'processing'`),
    index('canonical_source_media_imports_record_idx').on(t.sourceRecordId),
  ],
);
