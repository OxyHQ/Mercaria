/**
 * The creator surface: an asset, its versions, its files, its packages, its
 * licences and the one binding that makes a catalogue variant sell one
 * (#1015 W1/W2/W6, ADR 0010).
 *
 * ## Every handler re-establishes that the subject belongs to THIS store
 *
 * `loadStore` + `requireStorePermission('store:manage')` prove the caller is an
 * owner of the store in the PATH. They prove nothing about the asset id in the
 * path after it. So each handler below resolves its subject and compares the
 * store, and the refusal is a 404 rather than a 403 — a 403 confirms that the
 * id exists, which is the enumeration oracle #1015 W12 threat 1 is about and the
 * rule ADR 0010 D5 already applies on the buyer side.
 *
 * That check is not one middleware because the CHAIN differs per route: a file
 * belongs to a version belongs to an asset belongs to a store; a package
 * membership row belongs to a package belongs to an asset. Collapsing them into
 * one "load the asset" middleware would leave the second hop unchecked on
 * exactly the routes that have one, which is how a cross-store write gets in.
 *
 * ## The three facts a file is registered with are MEASURED, never sent
 *
 * `asset_files.content_hash` is documented as computed server-side and never
 * taken from the client (#1015 W1 requirement 7). The bytes do not transit this
 * API — an 8 GiB ceiling and a 10 MB JSON limit are not reconcilable — so a
 * creator uploads to Oxy and posts the `file_id`, and
 * `services/digital/storage.ts` reads the size, the verified media type and the
 * digest back from the asset service. A deployment that cannot ask answers 503
 * and registers nothing; it never falls back to believing the client.
 *
 * ## Publication asks three questions and none of them is "is this pretty"
 *
 * `config.digital.publicationEnabled` (ADR 0010 D13 — a version becoming sellable
 * is the lever that has a per-market launch gate in front of it), then
 * `everyFileScannedClean` (is any file MALICIOUS) and `everyFileInspectionAcceptable`
 * (is any file BROKEN). The last two are #1015 W1 requirement 12 and both answer
 * `false` for a version with no files, deliberately. They are separate calls so a
 * creator is told which one refused them, and the second exists because a `corrupt`
 * file is not malicious: a scanner calls it clean, and until the inspection gate
 * landed nothing else stood between it and a buyer.
 *
 * All three run before `publishAssetVersion`, which is itself a CAS — so a double
 * tap from a dashboard converges rather than publishing twice.
 */

import type { Request, Response } from 'express';
import { eq, max } from 'drizzle-orm';
import type {
  AssetFileRole,
  AssetFileVisibility,
  DigitalLicenceAttributionMode,
  DigitalLicenceRight,
  DigitalLicenceUpdatePolicy,
  DigitalVertical,
} from '@mercaria/shared-types';
import { unmetLicenceRightDependencies } from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { getDb } from '../db/postgres.js';
import { assetLicenceVersions, assetLicences } from '../db/schema/digitalRights.js';
import {
  addFileToPackage,
  everyFileInspectionAcceptable,
  everyFileScannedClean,
  findAssetPackage,
  findAssetVersion,
  findDigitalAsset,
  findVersionFiles,
  insertAssetFile,
  insertAssetPackage,
  insertAssetVersion,
  insertDigitalAsset,
  publishAssetVersion,
  withdrawAssetVersion,
  type AssetPackageRow,
  type AssetVersionRow,
  type DigitalAssetRow,
} from '../db/digital/assetRepository.js';
import {
  findAssetLicenceOption,
  findAssetLicenceVersion,
  insertAssetLicenceOption,
  insertAssetLicenceVersion,
  publishAssetLicenceVersion,
  upsertAssetLicence,
  type AssetLicenceVersionRow,
} from '../db/digital/licenceRepository.js';
import { upsertDigitalBinding } from '../db/digital/bindingRepository.js';
import { findVariantById } from '../db/catalog/variantRepository.js';
import { findListingById } from '../db/catalog/listingRepository.js';
import { majorVersionOf } from '../services/digital/version-coverage.js';
import {
  assetStorage,
  isDigitalStorageError,
  type StoredAssetObject,
} from '../services/digital/storage.js';
import { sendSuccess } from '../utils/api-response.js';
import { routeParam } from '../utils/request.js';
import {
  conflict,
  notFound,
  respondWithError,
  validationError,
  MercariaError,
} from '../lib/errors/error-codes.js';
import { ErrorCodes } from '../utils/api-response.js';

/* -------------------------------------------------------------------------- */
/* Resolving a subject, and proving it is this store's                         */
/* -------------------------------------------------------------------------- */

/** The store the chain below is scoped to. `loadStore` has already run. */
function storeIdOf(req: Request): string {
  const storeId = req.store?.id;
  if (!storeId) {
    // Unreachable behind `loadStore`, and an explicit throw rather than a
    // non-null assertion: a silent `undefined` would travel into an ownership
    // comparison and make it vacuously true.
    throw new MercariaError({
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Store context is missing',
    });
  }
  return storeId;
}

/** This store's asset, or a 404 that does not say which of the two it was. */
async function requireStoreAsset(req: Request): Promise<DigitalAssetRow> {
  const asset = await findDigitalAsset(routeParam(req, 'assetId'));
  if (!asset || asset.storeId !== storeIdOf(req)) throw notFound('No such asset');
  return asset;
}

/** A version of THIS store's asset. Both hops, every time. */
async function requireStoreVersion(
  req: Request,
): Promise<{ asset: DigitalAssetRow; version: AssetVersionRow }> {
  const asset = await requireStoreAsset(req);
  const version = await findAssetVersion(routeParam(req, 'versionId'));
  if (!version || version.assetId !== asset.id) throw notFound('No such version');
  return { asset, version };
}

/** A package of THIS store's asset. */
async function requireStorePackage(
  req: Request,
): Promise<{ asset: DigitalAssetRow; pkg: AssetPackageRow }> {
  const asset = await requireStoreAsset(req);
  const pkg = await findAssetPackage(routeParam(req, 'packageId'));
  if (!pkg || pkg.assetId !== asset.id) throw notFound('No such package');
  return { asset, pkg };
}

/**
 * A licence this store may write to.
 *
 * `licenceRepository` has no find-by-id, so this is a NARROW select naming its
 * three columns rather than a whole-row read — the `PROTECTED_COLUMNS` gate's
 * rule applied even to a table with no protected column, because the habit is
 * what keeps the gate meaningful.
 */
async function requireStoreLicence(
  req: Request,
): Promise<{ id: string; storeId: string | null }> {
  const licenceId = routeParam(req, 'licenceId');
  const [row] = await getDb()
    .select({ id: assetLicences.id, storeId: assetLicences.storeId })
    .from(assetLicences)
    .where(eq(assetLicences.id, licenceId))
    .limit(1);
  // A platform reference licence (`store_id IS NULL`) is READABLE by every
  // store and writable by none: its versions are Mercaria's text, and a creator
  // adding a version to it would be publishing terms in the platform's name.
  if (!row || row.storeId !== storeIdOf(req)) throw notFound('No such licence');
  return row;
}

/**
 * A licence version this store may build an OPTION on.
 *
 * Wider than {@link requireStoreLicence} on purpose: an option may name a
 * Mercaria REFERENCE licence (`store_id IS NULL`), because that is what a
 * reference licence is for. What it may not name is another store's.
 */
async function requireUsableLicenceVersion(
  req: Request,
  licenceVersionId: string,
): Promise<AssetLicenceVersionRow> {
  const version = await findAssetLicenceVersion(licenceVersionId);
  if (!version) throw notFound('No such licence version');
  const [licence] = await getDb()
    .select({ storeId: assetLicences.storeId })
    .from(assetLicences)
    .where(eq(assetLicences.id, version.licenceId))
    .limit(1);
  if (!licence) throw notFound('No such licence version');
  if (licence.storeId !== null && licence.storeId !== storeIdOf(req)) {
    throw notFound('No such licence version');
  }
  return version;
}

/* -------------------------------------------------------------------------- */
/* Assets and versions                                                         */
/* -------------------------------------------------------------------------- */

/** POST /digital/stores/:storeId/assets — create a digital asset. */
export async function createDigitalAssetHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      vertical: DigitalVertical;
      title: string;
      canonicalProductId?: string;
    };
    // `DIGITAL_ENABLED_VERTICALS` is an ALLOW-list and empty means none (ADR
    // 0010 D13). Checked on CREATION rather than on publication so a creator is
    // told before they upload eight gigabytes, and it does not touch an asset
    // that already exists — turning a vertical off strands no prior purchase.
    if (!config.digital.enabledVerticals.includes(body.vertical)) {
      throw conflict(`This deployment does not sell ${body.vertical} assets.`);
    }
    const asset = await insertDigitalAsset({
      storeId: storeIdOf(req),
      vertical: body.vertical,
      title: body.title,
      ...(body.canonicalProductId !== undefined
        ? { canonicalProductId: body.canonicalProductId }
        : {}),
    });
    sendSuccess(res, asset, 201);
  } catch (error) {
    respondWithError(res, error, 'Creating the asset failed');
  }
}

/** POST /digital/stores/:storeId/assets/:assetId/versions — open a DRAFT version. */
export async function createAssetVersionHandler(req: Request, res: Response): Promise<void> {
  try {
    const asset = await requireStoreAsset(req);
    const body = req.body as {
      label: string;
      changelog?: string;
      canonicalVariantId?: string;
    };
    const version = await insertAssetVersion({
      assetId: asset.id,
      label: body.label,
      // Parsed from the label by the ONE implementation, never sent: a client
      // that could send both could make them disagree, and `same_major_version`
      // would then mean whatever it said (ADR 0010 D4).
      majorVersion: majorVersionOf(body.label),
      ...(body.changelog !== undefined ? { changelog: body.changelog } : {}),
      ...(body.canonicalVariantId !== undefined
        ? { canonicalVariantId: body.canonicalVariantId }
        : {}),
    });
    sendSuccess(res, version, 201);
  } catch (error) {
    respondWithError(res, error, 'Creating the version failed');
  }
}

/**
 * POST /digital/stores/:storeId/assets/:assetId/versions/:versionId/files
 *
 * Register a file the creator uploaded to Oxy. The response carries the PUBLIC
 * file row — `insertAssetFile` returns the column set that withholds
 * `storage_key`, so there is no path from this response to the object.
 */
export async function registerAssetFileHandler(req: Request, res: Response): Promise<void> {
  try {
    const { version } = await requireStoreVersion(req);
    // Only a version nothing has been sold from may gain files.
    // `asset_files_immutable_once_published` is the real guard (#1015 W12 threat
    // 8 — a creator swapping bytes after a sale); this is the readable refusal
    // in front of it, so a creator gets a sentence rather than a trigger.
    if (version.state !== 'draft' && version.state !== 'processing') {
      throw conflict('Files can only be added to a draft version.');
    }
    const body = req.body as {
      storageKey: string;
      fileName: string;
      format: string;
      role: AssetFileRole;
      visibility: AssetFileVisibility;
    };

    let object: StoredAssetObject | null;
    try {
      object = await assetStorage.describeAssetObject(body.storageKey);
    } catch (error) {
      if (isDigitalStorageError(error) && error.reason === 'unconfigured') {
        throw new MercariaError({
          code: ErrorCodes.INTERNAL_ERROR,
          message: 'Digital uploads are not fully configured on this deployment.',
          httpStatus: 503,
        });
      }
      throw new MercariaError({
        code: ErrorCodes.INTERNAL_ERROR,
        message: 'The uploaded file could not be verified. Try again.',
        httpStatus: 502,
        cause: error,
      });
    }
    if (!object) {
      // The same answer for "no such object" and "an object somebody else
      // uploaded that this service cannot read": distinguishing them is a probe
      // for which Oxy file ids exist.
      throw notFound('No uploaded file with that id');
    }

    const file = await insertAssetFile({
      versionId: version.id,
      fileName: body.fileName,
      format: body.format,
      role: body.role,
      visibility: body.visibility,
      // The three MEASURED facts. Note `mediaType` is the asset service's
      // verified value and not the format registry's nominal one: a `.stl` that
      // is really a zip is a different thing from what the creator said, and the
      // authorizer and the viewer read the verified value (see the column).
      mediaType: object.mediaType,
      byteSize: object.byteSize,
      contentHash: object.contentHash,
      storageKey: object.storageKey,
    });
    sendSuccess(res, file, 201);
  } catch (error) {
    respondWithError(res, error, 'Registering the file failed');
  }
}

/**
 * POST /digital/stores/:storeId/assets/:assetId/versions/:versionId/publish
 *
 * The lever and the scan gate, then the CAS.
 */
export async function publishAssetVersionHandler(req: Request, res: Response): Promise<void> {
  try {
    const { version } = await requireStoreVersion(req);
    if (!config.digital.publicationEnabled) {
      throw conflict('Publishing digital versions is switched off on this deployment.');
    }
    // #1015 W1 requirement 12. `everyFileScannedClean` answers `false` for a
    // version with NO files, deliberately — publishing an empty deliverable is
    // not a thing a creator means to do.
    if (!(await everyFileScannedClean(version.id))) {
      throw conflict('Every file in this version must pass a scan before it can be published.');
    }
    // The scan's sibling, and the one the scan does not cover: a `corrupt` file is
    // not malicious, so a scanner calls it clean and nothing else stood between it
    // and a buyer. `unsupported` and `missing_resources` deliberately PASS — see
    // `PUBLISHABLE_ASSET_INSPECTION_VERDICTS` for why each membership is a
    // decision. The two checks are separate calls rather than one conjunction so
    // the creator is told WHICH gate refused them.
    if (!(await everyFileInspectionAcceptable(version.id))) {
      throw conflict(
        'Every file in this version must be inspected successfully before it can be published.',
      );
    }
    const published = await publishAssetVersion(version.id, new Date());
    if (!published) {
      // Not an error the caller can fix by retrying: the version was already
      // past the publishable states. Re-read tells them which.
      const current = await findAssetVersion(version.id);
      throw conflict(`This version is ${current?.state ?? 'unknown'} and cannot be published.`);
    }
    sendSuccess(res, await findAssetVersion(version.id));
  } catch (error) {
    respondWithError(res, error, 'Publishing the version failed');
  }
}

/**
 * POST /digital/stores/:storeId/assets/:assetId/versions/:versionId/withdraw
 *
 * Stops NEW acquisition and leaves every existing right able to download —
 * `withdrawn` is IN `DOWNLOADABLE_ASSET_VERSION_STATES` and that is the
 * load-bearing half of ADR 0010 D7.
 */
export async function withdrawAssetVersionHandler(req: Request, res: Response): Promise<void> {
  try {
    const { version } = await requireStoreVersion(req);
    const withdrawn = await withdrawAssetVersion(version.id);
    if (!withdrawn) {
      throw conflict('Only a published or superseded version can be withdrawn.');
    }
    sendSuccess(res, await findAssetVersion(version.id));
  } catch (error) {
    respondWithError(res, error, 'Withdrawing the version failed');
  }
}

/* -------------------------------------------------------------------------- */
/* Packages                                                                    */
/* -------------------------------------------------------------------------- */

/** POST /digital/stores/:storeId/assets/:assetId/packages — the deliverable. */
export async function createAssetPackageHandler(req: Request, res: Response): Promise<void> {
  try {
    const asset = await requireStoreAsset(req);
    const body = req.body as { key: string; name: string; summary?: string };
    const pkg = await insertAssetPackage({
      assetId: asset.id,
      key: body.key,
      name: body.name,
      ...(body.summary !== undefined ? { summary: body.summary } : {}),
    });
    sendSuccess(res, pkg, 201);
  } catch (error) {
    respondWithError(res, error, 'Creating the package failed');
  }
}

/**
 * POST /digital/stores/:storeId/assets/:assetId/packages/:packageId/files
 *
 * Membership is `(package, version, file)` and the version is carried
 * deliberately — it is the download authorizer's whole question. So every file
 * named must BE a file of that version, checked here, because no CHECK can tie
 * two tables and a membership row pointing at a version the file does not belong
 * to would make a file reachable at a version it was never in.
 */
export async function addAssetPackageFilesHandler(req: Request, res: Response): Promise<void> {
  try {
    const { asset, pkg } = await requireStorePackage(req);
    const body = req.body as { versionId: string; fileIds: string[] };

    const version = await findAssetVersion(body.versionId);
    if (!version || version.assetId !== asset.id) throw notFound('No such version');

    const files = await findVersionFiles(version.id);
    const known = new Set(files.map((file) => file.id));
    const unknown = body.fileIds.filter((fileId) => !known.has(fileId));
    if (unknown.length > 0) {
      throw validationError(
        `${unknown.length === 1 ? 'One file is' : `${unknown.length} files are`} not part of that version.`,
      );
    }

    for (const fileId of body.fileIds) {
      // Idempotent on `(package, file)`, so a retried batch converges instead of
      // raising halfway through and leaving a package half-assembled.
      await addFileToPackage({ packageId: pkg.id, versionId: version.id, fileId });
    }
    sendSuccess(res, { packageId: pkg.id, versionId: version.id, fileIds: body.fileIds }, 201);
  } catch (error) {
    respondWithError(res, error, 'Adding files to the package failed');
  }
}

/* -------------------------------------------------------------------------- */
/* Licences                                                                    */
/* -------------------------------------------------------------------------- */

/** POST /digital/stores/:storeId/licences — a named licence, metadata only. */
export async function createAssetLicenceHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { slug: string; name: string };
    const licence = await upsertAssetLicence({
      storeId: storeIdOf(req),
      // Always `creator` through this surface. `mercaria_reference` is the
      // platform's own seeded text, and a creator's licence presenting itself as
      // the platform's standard one is the distinction a buyer comparing two
      // "Commercial" licences is relying on.
      authorship: 'creator',
      slug: body.slug,
      name: body.name,
    });
    sendSuccess(res, licence, 201);
  } catch (error) {
    respondWithError(res, error, 'Creating the licence failed');
  }
}

/**
 * POST /digital/stores/:storeId/licences/:licenceId/versions — a DRAFT of the
 * terms.
 *
 * The version NUMBER is assigned here and never sent: it is monotonic per
 * licence behind a unique index, so two tabs both sending `2` would be a
 * constraint violation rather than a decision anybody made.
 */
export async function createAssetLicenceVersionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const licence = await requireStoreLicence(req);
    const body = req.body as {
      summary: string;
      rights: DigitalLicenceRight[];
      attribution: DigitalLicenceAttributionMode;
      seatLimit?: number;
      projectLimit?: number;
      revenueLimit?: { amount: number; currency: string };
      additionalTerms?: string;
    };

    // Enforced at write time and by nothing in the database, deliberately: a
    // CHECK over two elements of one array column reads as an accident the next
    // reader simplifies away. `unmetLicenceRightDependencies` is the one
    // implementation and it returns the offending PAIRS, so the refusal names
    // the dependency rather than saying "invalid".
    const unmet = unmetLicenceRightDependencies(body.rights);
    if (unmet.length > 0) {
      throw validationError(
        `These rights need one they do not grant: ${unmet
          .map(([right, requires]) => `${right} needs ${requires}`)
          .join('; ')}.`,
      );
    }

    const [existing] = await getDb()
      .select({ highest: max(assetLicenceVersions.version) })
      .from(assetLicenceVersions)
      .where(eq(assetLicenceVersions.licenceId, licence.id));
    const nextVersion = (existing?.highest ?? 0) + 1;

    const version = await insertAssetLicenceVersion({
      licenceId: licence.id,
      version: nextVersion,
      summary: body.summary,
      rights: body.rights,
      attribution: body.attribution,
      seatLimit: body.seatLimit ?? null,
      projectLimit: body.projectLimit ?? null,
      revenueLimitAmount: body.revenueLimit?.amount ?? null,
      revenueLimitCurrency: body.revenueLimit?.currency ?? null,
      additionalTerms: body.additionalTerms ?? null,
    });
    sendSuccess(res, version, 201);
  } catch (error) {
    respondWithError(res, error, 'Creating the licence version failed');
  }
}

/**
 * POST /digital/stores/:storeId/licences/:licenceId/versions/:versionId/publish
 *
 * The point past which the terms are frozen — by
 * `asset_licence_versions_immutable_once_published`, not by this handler (ADR
 * 0010 D3). A CAS on `draft`, so a replay converges.
 */
export async function publishAssetLicenceVersionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const licence = await requireStoreLicence(req);
    const versionId = routeParam(req, 'versionId');
    const version = await findAssetLicenceVersion(versionId);
    if (!version || version.licenceId !== licence.id) throw notFound('No such licence version');

    const published = await publishAssetLicenceVersion(version.id, new Date());
    if (!published) {
      throw conflict(`This licence version is ${version.state} and cannot be published.`);
    }
    sendSuccess(res, await findAssetLicenceVersion(version.id));
  } catch (error) {
    respondWithError(res, error, 'Publishing the licence version failed');
  }
}

/**
 * POST /digital/stores/:storeId/assets/:assetId/licence-options
 *
 * This licence version, over this package, with this update policy.
 */
export async function createAssetLicenceOptionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const asset = await requireStoreAsset(req);
    const body = req.body as {
      packageId: string;
      licenceVersionId: string;
      updatePolicy: DigitalLicenceUpdatePolicy;
      position?: number;
    };

    const pkg = await findAssetPackage(body.packageId);
    if (!pkg || pkg.assetId !== asset.id) throw notFound('No such package');

    const licenceVersion = await requireUsableLicenceVersion(req, body.licenceVersionId);
    // `resolveDigitalLines` refuses an option whose licence version is not
    // `published`, so an option built on a draft is a listing nobody can buy
    // that reports no error anywhere. Refused here, where somebody is watching.
    if (licenceVersion.state !== 'published') {
      throw conflict('A licence version must be published before an option can use it.');
    }

    const option = await insertAssetLicenceOption({
      assetId: asset.id,
      packageId: pkg.id,
      licenceVersionId: licenceVersion.id,
      updatePolicy: body.updatePolicy,
      ...(body.position !== undefined ? { position: body.position } : {}),
    });
    sendSuccess(res, option, 201);
  } catch (error) {
    respondWithError(res, error, 'Creating the licence option failed');
  }
}

/**
 * POST /digital/stores/:storeId/variant-bindings — make a catalogue variant sell
 * a deliverable.
 *
 * BOTH sides are checked against the store. `asset_variant_bindings.variant_id`
 * carries no foreign key by design (the catalogue and the digital domain are
 * joined here and nowhere else), so nothing in the database would stop a member
 * of store A attaching store B's licence option to their own variant — and a
 * binding is exactly what makes a line digital at checkout.
 */
export async function bindAssetVariantHandler(req: Request, res: Response): Promise<void> {
  try {
    const storeId = storeIdOf(req);
    const body = req.body as { variantId: string; licenceOptionId: string };

    const option = await findAssetLicenceOption(body.licenceOptionId);
    if (!option) throw notFound('No such licence option');
    const asset = await findDigitalAsset(option.assetId);
    if (!asset || asset.storeId !== storeId) throw notFound('No such licence option');

    const variant = await findVariantById(body.variantId);
    if (!variant) throw notFound('No such variant');
    const listing = await findListingById(variant.listingId);
    if (!listing || listing.ownerType !== 'store' || listing.storeId !== storeId) {
      throw notFound('No such variant');
    }

    await upsertDigitalBinding({
      variantId: variant.id,
      licenceOptionId: option.id,
    });
    sendSuccess(res, { variantId: variant.id, licenceOptionId: option.id }, 201);
  } catch (error) {
    respondWithError(res, error, 'Binding the variant failed');
  }
}
