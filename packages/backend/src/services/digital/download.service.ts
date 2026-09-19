/**
 * Authorizing a download, and minting the short-lived door that serves it
 * (#1015 W1 storage rules, W9, W12, ADR 0010 D5).
 *
 * ## The order of the checks IS the security property
 *
 * Every refusal below happens BEFORE any storage key is read. The protected-column
 * registry makes reading one an explicit act, and this module is the only place
 * that performs it — after the last refusal, never before. That ordering is what
 * makes #1015 acceptance criterion 7 true: *"an unauthorized user cannot obtain
 * the original from the viewer, API or guessed object path"*.
 *
 * ## Six questions, in this order, and none of them is "did they pay"
 *
 * 1. Are downloads enabled on this deployment?
 * 2. Does a right exist for this caller over this package?
 * 3. Is it in a status that authorizes?
 * 4. Does its update policy cover the version being asked for?
 * 5. Is that version in a downloadable state?
 * 6. Is the file IN the package at that version, and is it downloadable at all?
 *
 * #1015 boundary 4: a successful payment does not itself prove a buyer may
 * download arbitrary files. Nothing in the list above reads a payment — the right
 * is the authorization, and the payment is merely how the right came to exist.
 *
 * ## The token leaves once and is never stored
 *
 * `mintDownloadGrant` returns the token to its caller and persists only its
 * SHA-256. Nothing logs it — not the grant, not the event, not an error path —
 * because #1015 W1 rule 4 forbids logging a bearer-like download credential and a
 * log line is the one place a secret ends up by accident rather than by decision.
 */

import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AssetDownloadRefusalReason } from '@mercaria/shared-types';
import {
  ASSET_DOWNLOAD_GRANT_MAX_REDEMPTIONS,
  ASSET_DOWNLOAD_GRANT_TTL_SECONDS,
  DOWNLOADABLE_ASSET_VERSION_STATES,
  DOWNLOAD_AUTHORIZING_ASSET_RIGHT_STATUSES,
  PUBLICLY_VIEWABLE_ASSET_FILE_ROLES,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { assetVersions } from '../../db/schema/digitalAssets.js';
import {
  findAssetFileStorageKey,
  findPackageFilesAtVersion,
  type PublicAssetFileRow,
} from '../../db/digital/assetRepository.js';
import { findRight, findRightsForBuyer } from '../../db/digital/rightRepository.js';
import {
  classifyUnusableGrant,
  mintGrant,
  recordDownloadEvent,
  redeemGrant,
} from '../../db/digital/downloadRepository.js';
import { coversVersion, type CoverableVersion } from './version-coverage.js';

/** The token and the grant it opens. The token is the caller's to hand on, once. */
export interface MintedDownloadGrant {
  readonly grantId: string;
  /** Opaque, 256 bits of randomness, base64url. Never logged, never stored. */
  readonly token: string;
  readonly expiresAt: Date;
  readonly fileName: string;
  readonly byteSize: number;
}

/** Authorization either succeeds with a grant or fails with a named reason. */
export type DownloadAuthorization =
  | { readonly outcome: 'granted'; readonly grant: MintedDownloadGrant }
  | { readonly outcome: 'refused'; readonly reason: AssetDownloadRefusalReason };

export interface MintDownloadGrantInput {
  readonly requesterKey: string;
  readonly rightId: string;
  /** Which version the caller wants. Usually the one their right covers. */
  readonly versionId: string;
  readonly fileId: string;
}

/**
 * Authorize a download and mint a grant, or refuse with a reason.
 *
 * Every path — including every refusal — writes an `asset_download_events` row, so
 * the enumeration attempts #1015 W12 threat 1 describes are visible. The event
 * carries no user agent, no IP and no device id (`~/AGENTS.md`'s no-IP invariant):
 * what support needs is whether the bytes left, and what a fingerprint buys is
 * identifying the person.
 */
export async function mintDownloadGrant(
  input: MintDownloadGrantInput,
  tx?: DatabaseOrTransaction,
): Promise<DownloadAuthorization> {
  const db = tx ?? getDb();
  const now = new Date();

  const refuse = async (
    reason: AssetDownloadRefusalReason,
    rightId: string | null,
  ): Promise<DownloadAuthorization> => {
    await recordDownloadEvent(
      {
        rightId,
        grantId: null,
        fileId: input.fileId,
        requesterKey: input.requesterKey,
        kind: 'refused',
        refusalReason: reason,
        occurredAt: now,
      },
      db,
    );
    return { outcome: 'refused', reason };
  };

  // 1. The deployment lever. Checked first so a disabled deployment does no reads
  //    at all, and so the refusal reason is the lever rather than something that
  //    looks like the buyer's fault.
  if (!config.digital.downloadsEnabled) {
    return refuse('downloads_disabled', null);
  }

  // 2. The right must exist AND belong to this caller. One lookup, then an
  //    ownership comparison — never a query that trusts a caller-supplied buyer
  //    key, which would make the id the whole of the authorization.
  const right = await findRight(input.rightId, db);
  if (!right || right.buyerKey !== input.requesterKey) {
    // Deliberately the same answer for "no such right" and "somebody else's
    // right": distinguishing them would confirm that an id exists, which is the
    // enumeration oracle threat 1 is about.
    return refuse('no_right', null);
  }

  // 3. Status.
  if (!DOWNLOAD_AUTHORIZING_ASSET_RIGHT_STATUSES.includes(right.status)) {
    return refuse('right_not_active', right.id);
  }

  // 4 and 5. Coverage, and the target version's own state.
  const versions = await readAssetVersions(right.assetId, db);
  const purchased = versions.find((version) => version.id === right.purchasedVersionId);
  const target = versions.find((version) => version.id === input.versionId);
  if (!purchased || !target) {
    return refuse('version_not_covered', right.id);
  }
  if (!DOWNLOADABLE_ASSET_VERSION_STATES.includes(target.state)) {
    return refuse('version_not_downloadable', right.id);
  }
  if (!coversVersion(purchased, right.updatePolicy, versions, input.versionId)) {
    return refuse('version_not_covered', right.id);
  }

  // 6. The file must be IN the package at that version. This is the check that
  //    stops a cheaper licence reaching a `source` file: the package defines what
  //    was sold, and a file outside it is not refused by its own properties but by
  //    not being part of the deliverable.
  const files = await findPackageFilesAtVersion(right.packageId, input.versionId, db);
  const file = files.find((candidate) => candidate.id === input.fileId);
  if (!file) {
    return refuse('file_not_in_package', right.id);
  }
  if (file.visibility === 'preview_only') {
    // A web derivative is streamed by the viewer and never handed over as a file,
    // because a downloadable derivative is a free copy of a paid mesh at lower
    // fidelity.
    return refuse('file_not_downloadable', right.id);
  }

  // Authorized. Only NOW is a storage key readable — and the read happens in the
  // serving step, not here, so even this function never holds one.
  const token = randomBytes(32).toString('base64url');
  const grant = await mintGrant(
    {
      rightId: right.id,
      fileId: file.id,
      tokenHash: hashToken(token),
      maxRedemptions: ASSET_DOWNLOAD_GRANT_MAX_REDEMPTIONS,
      expiresAt: new Date(now.getTime() + ASSET_DOWNLOAD_GRANT_TTL_SECONDS * 1000),
    },
    db,
  );
  await recordDownloadEvent(
    {
      rightId: right.id,
      grantId: grant.id,
      fileId: file.id,
      requesterKey: input.requesterKey,
      kind: 'authorized',
      occurredAt: now,
    },
    db,
  );

  return {
    outcome: 'granted',
    grant: {
      grantId: grant.id,
      token,
      expiresAt: grant.expiresAt,
      fileName: file.fileName,
      byteSize: file.byteSize,
    },
  };
}

/** What redeeming a token yielded: the object to stream, or a reason it did not. */
export type DownloadRedemption =
  | {
      readonly outcome: 'ready';
      readonly storageKey: string;
      readonly fileName: string;
      readonly mediaType: string;
      readonly byteSize: number;
    }
  | { readonly outcome: 'refused'; readonly reason: AssetDownloadRefusalReason };

/**
 * Redeem a token and resolve the object to stream.
 *
 * The ONE place a storage key is read, and it is read after `redeemGrant` has
 * already claimed a redemption in a single statement — so a token that raced
 * itself cannot produce two streams from one remaining use.
 *
 * The right's status is re-checked here and not only at mint time. A five-minute
 * window is short but it is not zero, and a refund or a revocation inside it must
 * stop the transfer rather than be noticed on the next request.
 */
export async function redeemDownloadGrant(
  token: string,
  requesterKey: string,
  tx?: DatabaseOrTransaction,
): Promise<DownloadRedemption> {
  const db = tx ?? getDb();
  const now = new Date();
  const tokenHash = hashToken(token);

  if (!config.digital.downloadsEnabled) {
    return { outcome: 'refused', reason: 'downloads_disabled' };
  }

  const claimed = await redeemGrant(tokenHash, now, db);
  if (!claimed) {
    const why = await classifyUnusableGrant(tokenHash, now, db);
    const reason: AssetDownloadRefusalReason =
      why === 'expired' ? 'grant_expired' : why === 'exhausted' ? 'grant_exhausted' : 'no_right';
    await recordDownloadEvent(
      { rightId: null, grantId: null, fileId: null, requesterKey, kind: 'refused', refusalReason: reason, occurredAt: now },
      db,
    );
    return { outcome: 'refused', reason };
  }

  const right = await findRight(claimed.rightId, db);
  if (
    !right ||
    right.buyerKey !== requesterKey ||
    !DOWNLOAD_AUTHORIZING_ASSET_RIGHT_STATUSES.includes(right.status)
  ) {
    await recordDownloadEvent(
      {
        rightId: claimed.rightId,
        grantId: claimed.grantId,
        fileId: claimed.fileId,
        requesterKey,
        kind: 'refused',
        refusalReason: 'right_not_active',
        occurredAt: now,
      },
      db,
    );
    return { outcome: 'refused', reason: 'right_not_active' };
  }

  const object = await findAssetFileStorageKey(claimed.fileId, db);
  if (!object) {
    await recordDownloadEvent(
      {
        rightId: claimed.rightId,
        grantId: claimed.grantId,
        fileId: claimed.fileId,
        requesterKey,
        kind: 'refused',
        refusalReason: 'file_not_in_package',
        occurredAt: now,
      },
      db,
    );
    return { outcome: 'refused', reason: 'file_not_in_package' };
  }

  await recordDownloadEvent(
    {
      rightId: claimed.rightId,
      grantId: claimed.grantId,
      fileId: claimed.fileId,
      requesterKey,
      kind: 'started',
      occurredAt: now,
    },
    db,
  );
  return {
    outcome: 'ready',
    storageKey: object.storageKey,
    fileName: object.fileName,
    mediaType: object.mediaType,
    byteSize: object.byteSize,
  };
}

/**
 * The files a caller with NO right may be shown for a version.
 *
 * The public product page's read, and the answer to #1015 W12 threat 15 — *"public
 * viewer accidentally referencing private source assets"*. It filters on the ROLE
 * tuple rather than on visibility, because `PUBLICLY_VIEWABLE_ASSET_FILE_ROLES`
 * is the tuple whose two members are a deliberate decision and whose omissions
 * (`mesh`, `documentation`) are the paid product.
 */
export async function listPubliclyViewableFiles(
  packageId: string,
  versionId: string,
  tx?: DatabaseOrTransaction,
): Promise<PublicAssetFileRow[]> {
  const files = await findPackageFilesAtVersion(packageId, versionId, tx);
  return files.filter((file) => PUBLICLY_VIEWABLE_ASSET_FILE_ROLES.includes(file.role));
}

/**
 * Whether a buyer already holds an active right over a package.
 *
 * Read by the free-claim path, so a second claim converges rather than raising,
 * and by the product page, so a buyer is shown "in your library" instead of a buy
 * button.
 */
export async function holdsActiveRight(
  buyerKey: string,
  packageId: string,
  tx?: DatabaseOrTransaction,
): Promise<boolean> {
  const rights = await findRightsForBuyer(buyerKey, tx);
  return rights.some(
    (right) =>
      right.packageId === packageId &&
      DOWNLOAD_AUTHORIZING_ASSET_RIGHT_STATUSES.includes(right.status),
  );
}

/** SHA-256, lowercase hex — the one hashing of a download token. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
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
