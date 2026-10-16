import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { CATALOG_SAFETY_REVIEW_DECISIONS } from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { listings } from './catalog';
import { payments } from './payments';
import { orderItems } from './orders';

/** Append-only operator review. A digest mismatch is unreadable, never an implicit approval. */
export const catalogSafetyReviews = pgTable(
  'catalog_safety_reviews',
  {
    id: generatedId(),
    /** Assigned by PostgreSQL after the listing lock; wall clocks and UUID ordering carry no authority. */
    revision: bigint({ mode: 'number' }).generatedAlwaysAsIdentity({
      maxValue: Number.MAX_SAFE_INTEGER,
    }),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'restrict' }),
    contentDigest: text().notNull(),
    decision: text({ enum: asEnumValues(CATALOG_SAFETY_REVIEW_DECISIONS) }).notNull(),
    reviewerOxyUserId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'catalog_safety_reviews_decision_check',
      t.decision,
      CATALOG_SAFETY_REVIEW_DECISIONS,
    ),
    check('catalog_safety_reviews_digest_check', sql`${t.contentDigest} ~ '^[a-f0-9]{64}$'`),
    uniqueIndex('catalog_safety_reviews_revision_key').on(t.revision),
    index('catalog_safety_reviews_listing_revision_idx').on(t.listingId, t.revision.desc()),
  ],
);

/** Immutable request identity recorded before cart consumption or order effects. */
export const supervisedCheckoutRequests = pgTable(
  'supervised_checkout_requests',
  {
    id: generatedId(),
    buyerOxyUserId: text().notNull(),
    idempotencyKey: text().notNull(),
    requestFingerprint: text().notNull(),
    selectionFingerprint: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('supervised_checkout_requests_buyer_key').on(t.buyerOxyUserId, t.idempotencyKey),
    check(
      'supervised_checkout_requests_key_check',
      sql`length(${t.idempotencyKey}) between 1 and 128`,
    ),
    check(
      'supervised_checkout_requests_fingerprints_check',
      sql`${t.requestFingerprint} ~ '^[a-f0-9]{64}$' and ${t.selectionFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/** Payment coordination only. The approval decision and its state belong exclusively to Oxy. */
export const supervisedPurchaseOperations = pgTable(
  'supervised_purchase_operations',
  {
    id: generatedId(),
    paymentId: text()
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    approvalId: text(),
    expiresAt: timestamptz().notNull(),
    requestFingerprint: text().notNull(),
    cartFingerprint: text().notNull(),
    paymentFingerprint: text().notNull(),
    paymentStartedAt: timestamptz(),
    cancellationConfirmedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('supervised_purchase_operations_payment_key').on(t.paymentId),
    uniqueIndex('supervised_purchase_operations_approval_key').on(t.approvalId),
    check(
      'supervised_purchase_operations_fingerprints_check',
      sql`${t.requestFingerprint} ~ '^[a-f0-9]{64}$' and ${t.cartFingerprint} ~ '^[a-f0-9]{64}$' and ${t.paymentFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/** The reviewed content and merchant for each immutable purchased line, sealed before requesting approval. */
export const supervisedPurchaseLines = pgTable(
  'supervised_purchase_lines',
  {
    id: generatedId(),
    operationId: text().notNull(),
    orderItemId: text()
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    merchantAccountId: text().notNull(),
    contentDigest: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'supervised_purchase_lines_operation_fk',
      columns: [t.operationId],
      foreignColumns: [supervisedPurchaseOperations.id],
    }).onDelete('restrict'),
    uniqueIndex('supervised_purchase_lines_order_item_key').on(t.orderItemId),
    index('supervised_purchase_lines_operation_idx').on(t.operationId),
    check('supervised_purchase_lines_digest_check', sql`${t.contentDigest} ~ '^[a-f0-9]{64}$'`),
  ],
);
