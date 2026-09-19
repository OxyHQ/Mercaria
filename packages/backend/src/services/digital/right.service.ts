/**
 * Turning a PAID order into the buyer's durable rights, and moving those rights
 * when the money does (#1015 W9, ADR 0010 D5/D6).
 *
 * ## The grant is derived from the AUTHORITATIVE paid state, never from a webhook
 *
 * #1015 W9 requirement 1: create the right *"idempotently from the authoritative
 * paid order state"*. So nothing here takes a provider payload. The input is an
 * order id; the order's own lines carry the snapshot (`order_items.digital_*`),
 * and the snapshot was written at checkout when the catalogue was read. A webhook
 * arriving twice, out of order, or after an operator repair all reach the same
 * statement and the unique index converges them.
 *
 * ## Why this is called from `order.service`'s `paid` block and not from a queue
 *
 * A queue would make "the buyer can download" eventually-consistent with "the
 * buyer paid", and the window is the one in which a buyer is looking at their
 * library. It runs inline, after the CAS, beside the review-eligibility grant —
 * and like that grant it is best-effort with respect to the TRANSITION: the order
 * is paid whether or not this succeeds, because failing the transition would
 * re-enter the whole side-effect block on the retry and commit stock twice.
 *
 * What it is NOT is best-effort with respect to the BUYER. A failure leaves the
 * order at `paid` rather than `digitally_delivered`, which is the honest state —
 * the money is taken and the deliverable is not yet handed over — and any later
 * call finishes the job.
 */

import type {
  AssetRightRevocationBasis,
  BuyerAssetRightSummary,
  DigitalLicenceUpdatePolicy,
} from '@mercaria/shared-types';
import { DOWNLOAD_AUTHORIZING_ASSET_RIGHT_STATUSES } from '@mercaria/shared-types';
import { eq } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { assetVersions, digitalAssets } from '../../db/schema/digitalAssets.js';
import { assetLicenceVersions, assetLicences } from '../../db/schema/digitalRights.js';
import { orderItems } from '../../db/schema/orders.js';
import {
  findPackageFilesAtVersion,
  findAssetPackage,
} from '../../db/digital/assetRepository.js';
import {
  findRightsForBuyer,
  findRightsForOrder,
  grantRight,
  transitionRight,
  type AssetRightRow,
  type TransitionRightOutcome,
} from '../../db/digital/rightRepository.js';
import { coveredVersion, type CoverableVersion } from './version-coverage.js';
import { log } from '../../lib/logger.js';

/** One digital line of a paid order, as the grant path needs it. */
interface DigitalOrderLine {
  readonly orderItemId: string;
  readonly packageId: string;
  readonly assetVersionId: string;
  readonly licenceVersionId: string;
  readonly updatePolicy: DigitalLicenceUpdatePolicy;
}

/** What `grantRightsForPaidOrder` did, so the caller can decide about the status. */
export interface GrantRightsForOrderResult {
  /** Digital lines the order carries. 0 means a physical-only order. */
  readonly digitalLineCount: number;
  /** Rights created by THIS call. 0 on a converged replay. */
  readonly created: number;
  /** Rights that now exist for this order, created or already present. */
  readonly present: number;
  /** True when every digital line of the order has its right. */
  readonly complete: boolean;
}

/**
 * Create the rights a paid order owes, idempotently.
 *
 * Reads the lines rather than being handed them, so a caller cannot pass a
 * line-set that disagrees with the order — which is the shape in which a
 * "broaden the rights" bug would arrive (#1015 W12 threat 9).
 */
export async function grantRightsForPaidOrder(
  orderId: string,
  buyerKey: string,
  tx?: DatabaseOrTransaction,
): Promise<GrantRightsForOrderResult> {
  const db = tx ?? getDb();
  const lines = await readDigitalLines(orderId, db);
  if (lines.length === 0) {
    return { digitalLineCount: 0, created: 0, present: 0, complete: true };
  }

  const now = new Date();
  let created = 0;
  let present = 0;
  for (const line of lines) {
    const pkg = await findAssetPackage(line.packageId, db);
    if (!pkg) {
      // The package was deleted between checkout and payment. The snapshot on the
      // line is still the record of what was sold, so this is logged and skipped
      // rather than thrown: throwing would abandon the rights for every OTHER line
      // of the same order, which is a strictly worse outcome for the buyer.
      log.general.error(
        { orderId, orderItemId: line.orderItemId, packageId: line.packageId },
        'Digital order line names a package that no longer exists; right not granted',
      );
      continue;
    }
    const result = await grantRight(
      {
        buyerKey,
        assetId: pkg.assetId,
        packageId: line.packageId,
        purchasedVersionId: line.assetVersionId,
        licenceVersionId: line.licenceVersionId,
        updatePolicy: line.updatePolicy,
        source: 'purchase',
        orderItemId: line.orderItemId,
        orderId,
        grantedAt: now,
      },
      'system',
      db,
    );
    present += 1;
    if (result.created) created += 1;
  }

  return {
    digitalLineCount: lines.length,
    created,
    present,
    complete: present === lines.length,
  };
}

/** The digital lines of one order, from the immutable snapshot on each. */
async function readDigitalLines(
  orderId: string,
  db: DatabaseOrTransaction,
): Promise<DigitalOrderLine[]> {
  const rows = await db
    .select({
      orderItemId: orderItems.id,
      packageId: orderItems.digitalPackageId,
      assetVersionId: orderItems.digitalAssetVersionId,
      licenceVersionId: orderItems.digitalLicenceVersionId,
      updatePolicy: orderItems.digitalUpdatePolicy,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  // The CHECK `order_items_digital_snapshot_complete_check` makes a partial
  // snapshot unrepresentable, so a row with a package id has all four. The filter
  // is on the one column and the rest are narrowed from it rather than re-tested,
  // which keeps the invariant stated in ONE place — the constraint.
  return rows
    .filter((row) => row.packageId !== null)
    .map((row) => ({
      orderItemId: row.orderItemId,
      packageId: row.packageId as string,
      assetVersionId: row.assetVersionId as string,
      licenceVersionId: row.licenceVersionId as string,
      updatePolicy: row.updatePolicy as DigitalLicenceUpdatePolicy,
    }));
}

/**
 * Move every right an order produced to `refunded`.
 *
 * Called when the order reaches `refunded`. Each move is a CAS from `active` or
 * `disputed_hold`, so a right already refunded is left alone and a right revoked
 * for policy is NOT quietly downgraded to a refund — the stronger state wins,
 * which matters because a revocation records a legal basis a refund does not.
 */
export async function refundRightsForOrder(
  orderId: string,
  actor: string,
  tx?: DatabaseOrTransaction,
): Promise<number> {
  const db = tx ?? getDb();
  const rights = await findRightsForOrder(orderId, db);
  let moved = 0;
  for (const right of rights) {
    const outcome = await transitionRight(
      {
        rightId: right.id,
        from: ['active', 'disputed_hold'],
        to: 'refunded',
        kind: 'refunded',
        actor,
        occurredAt: new Date(),
      },
      db,
    );
    if (outcome === 'moved') moved += 1;
  }
  return moved;
}

/** Put a right on hold while a chargeback is open. Reversible, unlike a refund. */
export async function holdRightForDispute(
  rightId: string,
  actor: string,
  tx?: DatabaseOrTransaction,
): Promise<TransitionRightOutcome> {
  return transitionRight(
    {
      rightId,
      from: ['active'],
      to: 'disputed_hold',
      kind: 'dispute_opened',
      actor,
      occurredAt: new Date(),
    },
    tx,
  );
}

/**
 * Close a right under a documented legal basis.
 *
 * The basis is a required argument from a CLOSED set, so "revoked because an
 * operator felt like it" does not type-check — #1015 W2's *"only under a
 * documented legal basis"* as a signature rather than as a policy.
 */
export async function revokeRightForPolicy(
  rightId: string,
  basis: AssetRightRevocationBasis,
  actor: string,
  detail: string,
  tx?: DatabaseOrTransaction,
): Promise<TransitionRightOutcome> {
  return transitionRight(
    {
      rightId,
      from: ['active', 'disputed_hold'],
      to: 'revoked_for_policy',
      kind: 'revoked',
      actor,
      occurredAt: new Date(),
      revocationBasis: basis,
      detail,
    },
    tx,
  );
}

/**
 * The buyer's library.
 *
 * Every right, with the file inventory of the version each right currently
 * covers — so the buyer sees what they are about to fetch before fetching it
 * (#1015 W9 requirement 4), and sees that an update exists when one does
 * (requirement 5). Carries NO storage key: the repository's public column set is
 * what makes that structural rather than careful.
 */
export async function listBuyerLibrary(
  buyerKey: string,
  tx?: DatabaseOrTransaction,
): Promise<BuyerAssetRightSummary[]> {
  const db = tx ?? getDb();
  const rights = await findRightsForBuyer(buyerKey, db);
  const summaries: BuyerAssetRightSummary[] = [];
  for (const right of rights) {
    const summary = await summarizeRight(right, db);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

/** One library line. `null` when the asset graph behind it is unreadable. */
async function summarizeRight(
  right: AssetRightRow,
  db: DatabaseOrTransaction,
): Promise<BuyerAssetRightSummary | null> {
  const [asset] = await db
    .select({ id: digitalAssets.id, title: digitalAssets.title })
    .from(digitalAssets)
    .where(eq(digitalAssets.id, right.assetId))
    .limit(1);
  const pkg = await findAssetPackage(right.packageId, db);
  const versions = await readAssetVersions(right.assetId, db);
  const purchased = versions.find((version) => version.id === right.purchasedVersionId);
  if (!asset || !pkg || !purchased) return null;

  const covered = coveredVersion(purchased, right.updatePolicy, versions);
  const [licence] = await db
    .select({ name: assetLicences.name })
    .from(assetLicenceVersions)
    .innerJoin(assetLicences, eq(assetLicences.id, assetLicenceVersions.licenceId))
    .where(eq(assetLicenceVersions.id, right.licenceVersionId))
    .limit(1);

  const authorizes = DOWNLOAD_AUTHORIZING_ASSET_RIGHT_STATUSES.includes(right.status);
  const files = await findPackageFilesAtVersion(right.packageId, covered.id, db);

  return {
    rightId: right.id,
    status: right.status,
    source: right.source,
    grantedAt: right.grantedAt.toISOString(),
    assetId: asset.id,
    assetTitle: asset.title,
    packageId: pkg.id,
    packageName: pkg.name,
    purchasedVersionId: purchased.id,
    purchasedVersionLabel: purchased.label,
    availableVersionId: covered.id,
    availableVersionLabel: covered.label,
    updateAvailable: covered.id !== purchased.id,
    licenceName: licence?.name ?? '',
    licenceVersionId: right.licenceVersionId,
    files: files.map((file) => ({
      fileId: file.id,
      fileName: file.fileName,
      format: file.format,
      byteSize: file.byteSize,
      /**
       * Whether a grant would be minted for this file RIGHT NOW.
       *
       * It folds the right's status in, so a refunded right lists what was bought
       * with every file marked un-downloadable rather than listing nothing — a
       * buyer looking at a refunded purchase needs to see it, and a library that
       * hid it would look like the purchase never happened.
       */
      downloadable: authorizes && file.visibility !== 'preview_only',
    })),
  };
}

/** Every version of an asset, in the minimal shape the coverage rule reads. */
async function readAssetVersions(
  assetId: string,
  db: DatabaseOrTransaction,
): Promise<CoverableVersion[]> {
  return db
    .select({
      id: assetVersions.id,
      label: assetVersions.label,
      majorVersion: assetVersions.majorVersion,
      state: assetVersions.state,
      publishedAt: assetVersions.publishedAt,
    })
    .from(assetVersions)
    .where(eq(assetVersions.assetId, assetId));
}

/**
 * Carry a guest's rights over to the Oxy account that claimed their order
 * (#1015 W9 requirement 9, ADR 0010 D9.5).
 *
 * ## Why this is a NEW right rather than a re-key
 *
 * `asset_rights.buyer_key` is immutable by trigger, deliberately: the thing that
 * would make #1015 W12 threat 9 real is an UPDATE moving a right between owners,
 * and a guard that allowed it "only for claims" is a guard with an exception. So a
 * claim GRANTS a fresh right to the Oxy account, with `source: 'migration'`, and
 * marks the guest's right `superseded` — which is what that status is for, and is
 * not a withdrawal: the replacement carries the access.
 *
 * Both happen in the caller's transaction, so a claim that rolls back does not
 * leave a buyer holding two rights to one thing.
 *
 * ## Why the guest's right is not simply deleted
 *
 * ADR 0010 D6 and the trigger both forbid it, and the reason is the audit: the
 * original acquisition is what a dispute about the PURCHASE is answered from, and
 * the claim is a separate later fact. Two rows and an event trail say what
 * happened; one re-keyed row says a different thing happened.
 */
export async function carryRightsToClaimant(
  orderId: string,
  claimantOxyUserId: string,
  tx: DatabaseOrTransaction,
): Promise<number> {
  const rights = await findRightsForOrder(orderId, tx);
  const now = new Date();
  let carried = 0;
  for (const right of rights) {
    if (right.status !== 'active') continue;
    const result = await grantRight(
      {
        buyerKey: `oxy:${claimantOxyUserId}`,
        assetId: right.assetId,
        packageId: right.packageId,
        purchasedVersionId: right.purchasedVersionId,
        licenceVersionId: right.licenceVersionId,
        updatePolicy: right.updatePolicy,
        source: 'migration',
        // No order line: the purchase line already belongs to the guest's right,
        // and `asset_rights_order_item_package_key` is unique on it — a second
        // right naming the same line is exactly what that index refuses, and
        // rightly, because it would be a second record of one purchase.
        orderItemId: null,
        orderId: null,
        grantedAt: now,
      },
      `oxy:${claimantOxyUserId}`,
      tx,
    );
    if (!result.created) continue;
    await transitionRight(
      {
        rightId: right.id,
        from: ['active'],
        to: 'superseded',
        kind: 'superseded',
        actor: `oxy:${claimantOxyUserId}`,
        occurredAt: now,
        detail: `carried to ${result.right.id} on guest order claim`,
      },
      tx,
    );
    carried += 1;
  }
  return carried;
}
