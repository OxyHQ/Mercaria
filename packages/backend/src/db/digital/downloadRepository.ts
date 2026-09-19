/**
 * The only writer of `asset_download_grants` and `asset_download_events`
 * (#1015 W9, W12).
 *
 * ## The token is never stored, and redemption is a single statement
 *
 * `mintGrant` takes a token HASH the service computed; the token itself never
 * reaches this module. `redeemGrant` is one
 * `UPDATE … SET redemptions = redemptions + 1 … RETURNING` guarded by the expiry
 * and the cap, which is the Peable derivation-index device: a read followed by a
 * write lets two concurrent redemptions each see the same count and both pass a
 * cap of one. Here the cap is above one, so the race is not catastrophic — but the
 * counter would be wrong, and a counter nobody can trust is not an audit.
 *
 * ## A refused attempt is still recorded
 *
 * `recordDownloadEvent` takes a nullable `rightId`, because the commonest refusal
 * is that no right exists — and #1015 W12 threat 1 is somebody guessing asset ids,
 * which is visible only if the attempts with no right behind them are the ones
 * being written down.
 */

import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { AssetDownloadEventKind, AssetDownloadRefusalReason } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { assetDownloadEvents, assetDownloadGrants } from '../schema/digitalRights.js';

export type AssetDownloadGrantRow = InferSelectModel<typeof assetDownloadGrants>;

/** A grant row WITHOUT its token hash — the shape a response may carry. */
export type PublicAssetDownloadGrantRow = Omit<AssetDownloadGrantRow, 'tokenHash'>;

const PUBLIC_GRANT_COLUMNS = {
  id: assetDownloadGrants.id,
  rightId: assetDownloadGrants.rightId,
  fileId: assetDownloadGrants.fileId,
  redemptions: assetDownloadGrants.redemptions,
  maxRedemptions: assetDownloadGrants.maxRedemptions,
  expiresAt: assetDownloadGrants.expiresAt,
  createdAt: assetDownloadGrants.createdAt,
  updatedAt: assetDownloadGrants.updatedAt,
} as const;

export interface NewDownloadGrant {
  readonly rightId: string;
  readonly fileId: string;
  /** Lowercase hex SHA-256 of the token. The token stays with the caller. */
  readonly tokenHash: string;
  readonly maxRedemptions: number;
  readonly expiresAt: Date;
}

export async function mintGrant(
  input: NewDownloadGrant,
  tx?: DatabaseOrTransaction,
): Promise<PublicAssetDownloadGrantRow> {
  const db = tx ?? getDb();
  const [row] = await db.insert(assetDownloadGrants).values({ ...input }).returning(
    PUBLIC_GRANT_COLUMNS,
  );
  return row;
}

/** What a redemption attempt found. `null` means no usable grant by that hash. */
export interface RedeemedGrant {
  readonly grantId: string;
  readonly rightId: string;
  readonly fileId: string;
  readonly redemptions: number;
}

/**
 * Claim one redemption of the grant whose token hashes to `tokenHash`.
 *
 * ONE statement. The expiry and the cap are predicates in the same `UPDATE` that
 * increments, so there is no window in which a grant is read as usable and then
 * used after expiring.
 */
export async function redeemGrant(
  tokenHash: string,
  now: Date,
  tx?: DatabaseOrTransaction,
): Promise<RedeemedGrant | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .update(assetDownloadGrants)
    .set({ redemptions: sql`${assetDownloadGrants.redemptions} + 1` })
    .where(
      and(
        eq(assetDownloadGrants.tokenHash, tokenHash),
        gt(assetDownloadGrants.expiresAt, now),
        sql`${assetDownloadGrants.redemptions} < ${assetDownloadGrants.maxRedemptions}`,
      ),
    )
    .returning({
      grantId: assetDownloadGrants.id,
      rightId: assetDownloadGrants.rightId,
      fileId: assetDownloadGrants.fileId,
      redemptions: assetDownloadGrants.redemptions,
    });
  return row ?? null;
}

/**
 * Whether a grant with this hash exists at all, and why it was unusable.
 *
 * Called only AFTER `redeemGrant` returned nothing, so a caller can answer
 * `grant_expired` rather than `grant_exhausted` — two different things a buyer is
 * told differently. It reads no token: the hash is the lookup key and the caller
 * already has it.
 */
export async function classifyUnusableGrant(
  tokenHash: string,
  now: Date,
  tx?: DatabaseOrTransaction,
): Promise<'expired' | 'exhausted' | 'absent'> {
  const db = tx ?? getDb();
  const [row] = await db
    .select({
      expiresAt: assetDownloadGrants.expiresAt,
      redemptions: assetDownloadGrants.redemptions,
      maxRedemptions: assetDownloadGrants.maxRedemptions,
    })
    .from(assetDownloadGrants)
    .where(eq(assetDownloadGrants.tokenHash, tokenHash))
    .limit(1);
  if (!row) return 'absent';
  if (row.expiresAt <= now) return 'expired';
  return row.redemptions >= row.maxRedemptions ? 'exhausted' : 'absent';
}

/**
 * Delete grants that expired before `before`.
 *
 * The one DELETE in this domain, and it is deliberate: an expired grant is a door
 * that no longer opens, carries no commercial meaning and is not evidence — the
 * EVENT is. `asset_download_events.grant_id` is `ON DELETE SET NULL` precisely so
 * the audit survives the sweep.
 */
export async function deleteExpiredGrants(
  before: Date,
  tx?: DatabaseOrTransaction,
): Promise<number> {
  const db = tx ?? getDb();
  const rows = await db
    .delete(assetDownloadGrants)
    .where(lt(assetDownloadGrants.expiresAt, before))
    .returning({ id: assetDownloadGrants.id });
  return rows.length;
}

export interface NewDownloadEvent {
  readonly rightId: string | null;
  readonly grantId: string | null;
  readonly fileId: string | null;
  readonly requesterKey: string;
  readonly kind: AssetDownloadEventKind;
  readonly refusalReason?: AssetDownloadRefusalReason;
  readonly bytesTransferred?: number;
  readonly occurredAt: Date;
}

export async function recordDownloadEvent(
  input: NewDownloadEvent,
  tx?: DatabaseOrTransaction,
): Promise<void> {
  const db = tx ?? getDb();
  await db.insert(assetDownloadEvents).values({
    rightId: input.rightId,
    grantId: input.grantId,
    fileId: input.fileId,
    requesterKey: input.requesterKey,
    kind: input.kind,
    refusalReason: input.refusalReason ?? null,
    bytesTransferred: input.bytesTransferred ?? null,
    occurredAt: input.occurredAt,
  });
}
