/**
 * The only writer of `asset_rights` and `asset_right_events` (#1015 W2, W9).
 *
 * ## The idempotency lives in the INDEX, and this module relies on it
 *
 * #1015 acceptance criterion 4: payment creates exactly one right *"under retries
 * and webhook reordering"*. A service-level "is there one already? then insert"
 * has a window between the two statements, and a reordered webhook is precisely a
 * second caller inside it. So `grantRight` is ONE statement —
 * `INSERT … ON CONFLICT DO NOTHING RETURNING` — and when it returns nothing it
 * reads the row the other caller wrote.
 *
 * The `created` flag it returns is what makes the difference observable: only the
 * first caller appends a `granted` event, so a retried webhook does not produce a
 * second audit entry for one acquisition.
 *
 * ## A status move is a CAS, and the event is appended in the same transaction
 *
 * A right whose status moved with no event is a refund nobody can evidence, so
 * `transitionRight` does both or neither. The CAS predicate names the status the
 * caller believed it was in, which makes a concurrent refund-and-revoke race
 * resolve to one winner rather than to two events describing one change.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  AssetRightEventKind,
  AssetRightRevocationBasis,
  AssetRightSource,
  AssetRightStatus,
  DigitalLicenceUpdatePolicy,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { assetRightEvents, assetRights } from '../schema/digitalRights.js';

export type AssetRightRow = InferSelectModel<typeof assetRights>;
export type AssetRightEventRow = InferSelectModel<typeof assetRightEvents>;

export interface NewAssetRight {
  readonly buyerKey: string;
  readonly assetId: string;
  readonly packageId: string;
  readonly purchasedVersionId: string;
  readonly licenceVersionId: string;
  readonly updatePolicy: DigitalLicenceUpdatePolicy;
  readonly source: AssetRightSource;
  readonly orderItemId: string | null;
  readonly orderId: string | null;
  readonly grantedAt: Date;
}

/** What `grantRight` did, so only the first caller writes an audit entry. */
export interface GrantRightResult {
  readonly right: AssetRightRow;
  readonly created: boolean;
}

/**
 * Create a right, converging on a replay.
 *
 * `onConflictDoNothing` with no target: BOTH partial unique indexes are in play —
 * `(order_item_id, package_id)` for a purchase and `(buyer_key, package_id)` for a
 * free claim — and naming one target would leave the other raising. An untargeted
 * `DO NOTHING` covers every constraint on the table, which is what is wanted here:
 * every one of them encodes "this right already exists".
 */
export async function grantRight(
  input: NewAssetRight,
  actor: string,
  tx?: DatabaseOrTransaction,
): Promise<GrantRightResult> {
  const run = async (db: DatabaseOrTransaction): Promise<GrantRightResult> => {
    const [inserted] = await db
      .insert(assetRights)
      .values({
        buyerKey: input.buyerKey,
        assetId: input.assetId,
        packageId: input.packageId,
        purchasedVersionId: input.purchasedVersionId,
        licenceVersionId: input.licenceVersionId,
        updatePolicy: input.updatePolicy,
        source: input.source,
        orderItemId: input.orderItemId,
        orderId: input.orderId,
        grantedAt: input.grantedAt,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      await db.insert(assetRightEvents).values({
        rightId: inserted.id,
        kind: 'granted',
        resultingStatus: 'active',
        actor,
        occurredAt: input.grantedAt,
      });
      return { right: inserted, created: true };
    }

    const existing = await findExistingRight(input, db);
    if (!existing) {
      // The insert conflicted, so a row matching one of the unique indexes exists.
      // Failing to find it means the lookup below and the index disagree, which is
      // a bug worth a loud error rather than a silent second grant.
      throw new Error(
        `asset right for package ${input.packageId} conflicted but could not be read back`,
      );
    }
    return { right: existing, created: false };
  };
  // One transaction, because the insert and its `granted` event are one fact: a
  // right with no grant event is an acquisition nobody can evidence. The
  // `'transaction' in db` probe is `orderRepository`'s — a caller already inside a
  // transaction must not open a nested one, and a caller that is not must not skip
  // it.
  const db = tx ?? getDb();
  return 'transaction' in db ? db.transaction(run) : run(db);
}

/** The row a conflicting insert must have hit, by whichever index applies. */
async function findExistingRight(
  input: NewAssetRight,
  db: DatabaseOrTransaction,
): Promise<AssetRightRow | null> {
  const predicate = input.orderItemId
    ? and(eq(assetRights.orderItemId, input.orderItemId), eq(assetRights.packageId, input.packageId))
    : and(eq(assetRights.buyerKey, input.buyerKey), eq(assetRights.packageId, input.packageId));
  const [row] = await db.select().from(assetRights).where(predicate).limit(1);
  return row ?? null;
}

/** Why a transition did not happen, so a route can answer 409 rather than 500. */
export type TransitionRightOutcome = 'moved' | 'stale' | 'missing';

export interface TransitionRightInput {
  readonly rightId: string;
  /** The statuses the caller believed the right was in — the compare half. */
  readonly from: readonly AssetRightStatus[];
  readonly to: AssetRightStatus;
  readonly kind: AssetRightEventKind;
  readonly actor: string;
  readonly occurredAt: Date;
  readonly revocationBasis?: AssetRightRevocationBasis;
  readonly detail?: string;
}

/**
 * Move a right's status and append its event, together.
 *
 * Three-way rather than boolean, for the reason Peable's `transitionIntent` is: a
 * route answers 409 for a right that moved under it and 404 for one that is not
 * there, and a boolean cannot tell the caller which.
 */
export async function transitionRight(
  input: TransitionRightInput,
  tx?: DatabaseOrTransaction,
): Promise<TransitionRightOutcome> {
  const run = async (db: DatabaseOrTransaction): Promise<TransitionRightOutcome> => {
    const rows = await db
      .update(assetRights)
      .set({
        status: input.to,
        revocationBasis:
          input.to === 'revoked_for_policy' ? (input.revocationBasis ?? null) : null,
      })
      .where(and(eq(assetRights.id, input.rightId), inArray(assetRights.status, [...input.from])))
      .returning({ id: assetRights.id });

    if (rows.length === 1) {
      await db.insert(assetRightEvents).values({
        rightId: input.rightId,
        kind: input.kind,
        resultingStatus: input.to,
        actor: input.actor,
        detail: input.detail ?? null,
        occurredAt: input.occurredAt,
      });
      return 'moved';
    }
    const existing = await findRight(input.rightId, db);
    return existing ? 'stale' : 'missing';
  };
  // One transaction, because the status move and its event are one fact. The
  // `'transaction' in db` probe is `orderRepository`'s: a caller already inside a
  // transaction must not open a nested one, and a caller that is not must not skip
  // it.
  const db = tx ?? getDb();
  return 'transaction' in db ? db.transaction(run) : run(db);
}

export async function findRight(
  rightId: string,
  tx?: DatabaseOrTransaction,
): Promise<AssetRightRow | null> {
  const db = tx ?? getDb();
  const [row] = await db.select().from(assetRights).where(eq(assetRights.id, rightId)).limit(1);
  return row ?? null;
}

/** Every right a buyer holds, newest first. The buyer library's read. */
export async function findRightsForBuyer(
  buyerKey: string,
  tx?: DatabaseOrTransaction,
): Promise<AssetRightRow[]> {
  const db = tx ?? getDb();
  return db
    .select()
    .from(assetRights)
    .where(eq(assetRights.buyerKey, buyerKey))
    .orderBy(desc(assetRights.grantedAt));
}

/**
 * Every right an ORDER produced.
 *
 * Read by the refund path, which must move each of them, and by the
 * `digitally_delivered` transition, which must confirm the order delivered what it
 * owed before claiming it did.
 */
export async function findRightsForOrder(
  orderId: string,
  tx?: DatabaseOrTransaction,
): Promise<AssetRightRow[]> {
  const db = tx ?? getDb();
  return db.select().from(assetRights).where(eq(assetRights.orderId, orderId));
}

/** A right's audit trail, oldest first. */
export async function findRightEvents(
  rightId: string,
  tx?: DatabaseOrTransaction,
): Promise<AssetRightEventRow[]> {
  const db = tx ?? getDb();
  return db
    .select()
    .from(assetRightEvents)
    .where(eq(assetRightEvents.rightId, rightId))
    .orderBy(assetRightEvents.occurredAt);
}
