/**
 * The only writer of the asset, version, file and package tables (#1015 W1).
 *
 * ## Publication is a CAS, and the current version is set in the same statement
 *
 * `publishVersion` carries `state = 'processing'` (or `'review'`) in its own
 * predicate and reports whether a row moved, so a double tap from a creator's
 * dashboard, a retry after a lost response and two tabs open at once all converge
 * on ONE transition. A read-then-write would satisfy the words and fail all three
 * — the `insertProductSave` and `markCollected` lesson, two domains over.
 *
 * The previous current version is demoted to `superseded` and
 * `digital_assets.current_version_id` is repointed inside the SAME transaction,
 * because those three facts are one fact: an asset whose `current_version_id`
 * names a version still marked `published` alongside a newer one has two answers
 * to "what would I buy right now".
 *
 * ## Nothing here deletes a published anything
 *
 * The triggers in migration 0156 refuse it, and this module does not try. What a
 * creator gets instead is `withdrawVersion`, which stops new acquisition and
 * leaves every existing right able to download (ADR 0010 D7).
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  AssetFileRole,
  AssetFileVisibility,
  AssetInspectionVerdict,
  AssetProvenanceSignalKind,
  AssetScanVerdict,
  AssetVersionState,
  DigitalVertical,
} from '@mercaria/shared-types';
import {
  ACQUIRABLE_ASSET_VERSION_STATES,
  PUBLISHABLE_ASSET_SCAN_VERDICTS,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  assetFileInspections,
  assetFiles,
  assetPackageFiles,
  assetPackages,
  assetProvenanceSignals,
  assetVersions,
  digitalAssets,
} from '../schema/digitalAssets.js';

/** One row of each table, for the services above. */
export type DigitalAssetRow = InferSelectModel<typeof digitalAssets>;
export type AssetVersionRow = InferSelectModel<typeof assetVersions>;
export type AssetFileRow = InferSelectModel<typeof assetFiles>;
export type AssetPackageRow = InferSelectModel<typeof assetPackages>;

/**
 * An asset file WITHOUT its storage key.
 *
 * The shape every read but `download.service` uses. It is a distinct type rather
 * than an `Omit` applied at each call site so that "a file, safe to serialize" is
 * a thing the type system knows about — `publicColumns` withholds the column and
 * this names what is left.
 */
export type PublicAssetFileRow = Omit<AssetFileRow, 'storageKey'>;

/** Columns of `asset_files` that may be serialized. Excludes `storageKey`. */
const PUBLIC_ASSET_FILE_COLUMNS = {
  id: assetFiles.id,
  versionId: assetFiles.versionId,
  fileName: assetFiles.fileName,
  format: assetFiles.format,
  mediaType: assetFiles.mediaType,
  role: assetFiles.role,
  visibility: assetFiles.visibility,
  byteSize: assetFiles.byteSize,
  contentHash: assetFiles.contentHash,
  scanVerdict: assetFiles.scanVerdict,
  scanAt: assetFiles.scanAt,
  createdAt: assetFiles.createdAt,
  updatedAt: assetFiles.updatedAt,
} as const;

export interface NewDigitalAsset {
  readonly storeId: string;
  readonly vertical: DigitalVertical;
  readonly title: string;
  readonly canonicalProductId?: string;
}

export async function insertDigitalAsset(
  input: NewDigitalAsset,
  tx?: DatabaseOrTransaction,
): Promise<DigitalAssetRow> {
  const db = tx ?? getDb();
  const [row] = await db
    .insert(digitalAssets)
    .values({
      storeId: input.storeId,
      vertical: input.vertical,
      title: input.title,
      canonicalProductId: input.canonicalProductId ?? null,
    })
    .returning();
  return row;
}

export async function findDigitalAsset(
  assetId: string,
  tx?: DatabaseOrTransaction,
): Promise<DigitalAssetRow | null> {
  const db = tx ?? getDb();
  const [row] = await db.select().from(digitalAssets).where(eq(digitalAssets.id, assetId)).limit(1);
  return row ?? null;
}

export interface NewAssetVersion {
  readonly assetId: string;
  readonly label: string;
  readonly majorVersion: number;
  readonly changelog?: string;
  readonly canonicalVariantId?: string;
}

export async function insertAssetVersion(
  input: NewAssetVersion,
  tx?: DatabaseOrTransaction,
): Promise<AssetVersionRow> {
  const db = tx ?? getDb();
  const [row] = await db
    .insert(assetVersions)
    .values({
      assetId: input.assetId,
      label: input.label,
      majorVersion: input.majorVersion,
      changelog: input.changelog ?? null,
      canonicalVariantId: input.canonicalVariantId ?? null,
    })
    .returning();
  return row;
}

export async function findAssetVersion(
  versionId: string,
  tx?: DatabaseOrTransaction,
): Promise<AssetVersionRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select()
    .from(assetVersions)
    .where(eq(assetVersions.id, versionId))
    .limit(1);
  return row ?? null;
}

/**
 * Move a version from `draft` to `processing`, or from `processing` to `review`.
 *
 * A CAS over the state it must be in, so a concurrent caller gets `false` rather
 * than a second transition.
 */
export async function advanceVersionState(
  versionId: string,
  from: readonly AssetVersionState[],
  to: AssetVersionState,
  tx?: DatabaseOrTransaction,
): Promise<boolean> {
  const db = tx ?? getDb();
  const rows = await db
    .update(assetVersions)
    .set({ state: to })
    .where(and(eq(assetVersions.id, versionId), inArray(assetVersions.state, [...from])))
    .returning({ id: assetVersions.id });
  return rows.length === 1;
}

/**
 * Publish a version, demote the one it replaces, and repoint the asset — one
 * transaction, because the three are one fact.
 *
 * Returns `false` when the version was not in a publishable state, which is how a
 * replayed request converges instead of raising. The caller distinguishes "already
 * published" by re-reading, because that is a different answer from "refused".
 */
export async function publishAssetVersion(
  versionId: string,
  now: Date,
  tx?: DatabaseOrTransaction,
): Promise<boolean> {
  const db = tx ?? getDb();
  const [version] = await db
    .update(assetVersions)
    .set({ state: 'published', publishedAt: now })
    .where(
      and(
        eq(assetVersions.id, versionId),
        inArray(assetVersions.state, ['draft', 'processing', 'review']),
      ),
    )
    .returning({ id: assetVersions.id, assetId: assetVersions.assetId });
  if (!version) return false;

  // Demote the outgoing current version. Scoped to `published` so a `restricted`
  // or `withdrawn` predecessor is not quietly relisted as merely superseded.
  await db
    .update(assetVersions)
    .set({ state: 'superseded' })
    .where(
      and(
        eq(assetVersions.assetId, version.assetId),
        eq(assetVersions.state, 'published'),
        sql`${assetVersions.id} <> ${versionId}`,
      ),
    );

  // `coalesce`, not a read-then-write: two concurrent first publications must not
  // each decide the column is empty. `listings.published_at`'s device.
  await db
    .update(digitalAssets)
    .set({
      currentVersionId: versionId,
      // `.toISOString()` with an explicit cast, NOT the `Date`. A `Date`
      // interpolated into a raw `sql` template reaches postgres.js as a bind
      // parameter it refuses — `ERR_INVALID_ARG_TYPE`, which `CONVENTIONS.md`
      // §Naming's third trap names as the WRITE direction of that hazard. This is
      // `firstActivationPublishedAt`'s spelling, one domain over, for the same
      // reason.
      publishedAt: sql`coalesce(${digitalAssets.publishedAt}, ${now.toISOString()}::timestamptz)`,
      state: sql`case when ${digitalAssets.state} = 'draft' then 'listed' else ${digitalAssets.state} end`,
    })
    .where(eq(digitalAssets.id, version.assetId));
  return true;
}

/**
 * Withdraw a version: stop new acquisition, keep every existing right working.
 *
 * ADR 0010 D7. A version may only be withdrawn from a state it was published in;
 * withdrawing a draft is a delete, which the trigger permits and this does not
 * pretend to be.
 */
export async function withdrawAssetVersion(
  versionId: string,
  tx?: DatabaseOrTransaction,
): Promise<boolean> {
  const db = tx ?? getDb();
  const rows = await db
    .update(assetVersions)
    .set({ state: 'withdrawn' })
    .where(
      and(eq(assetVersions.id, versionId), inArray(assetVersions.state, ['published', 'superseded'])),
    )
    .returning({ id: assetVersions.id });
  return rows.length === 1;
}

export interface NewAssetFile {
  readonly versionId: string;
  readonly fileName: string;
  readonly format: string;
  readonly mediaType: string;
  readonly role: AssetFileRole;
  readonly visibility: AssetFileVisibility;
  readonly byteSize: number;
  readonly contentHash: string;
  readonly storageKey: string;
}

export async function insertAssetFile(
  input: NewAssetFile,
  tx?: DatabaseOrTransaction,
): Promise<PublicAssetFileRow> {
  const db = tx ?? getDb();
  const [row] = await db.insert(assetFiles).values({ ...input }).returning(
    PUBLIC_ASSET_FILE_COLUMNS,
  );
  return row;
}

/** Record a scan verdict. The only column family an immutable file may change. */
export async function recordAssetFileScan(
  fileId: string,
  verdict: AssetScanVerdict,
  scannedAt: Date,
  tx?: DatabaseOrTransaction,
): Promise<void> {
  const db = tx ?? getDb();
  await db.update(assetFiles).set({ scanVerdict: verdict, scanAt: scannedAt }).where(
    eq(assetFiles.id, fileId),
  );
}

/** Every file of a version, WITHOUT storage keys. */
export async function findVersionFiles(
  versionId: string,
  tx?: DatabaseOrTransaction,
): Promise<PublicAssetFileRow[]> {
  const db = tx ?? getDb();
  return db
    .select(PUBLIC_ASSET_FILE_COLUMNS)
    .from(assetFiles)
    .where(eq(assetFiles.versionId, versionId))
    .orderBy(asc(assetFiles.fileName));
}

/**
 * The storage key of ONE file, read explicitly.
 *
 * The ONE sanctioned reader of a protected column in this domain, and it reads
 * nothing else — so a caller that wanted a file row and took this by mistake gets
 * a key and no metadata, which does not compile into anything useful.
 * `download.service.ts` calls it after authorizing, never before.
 */
export async function findAssetFileStorageKey(
  fileId: string,
  tx?: DatabaseOrTransaction,
): Promise<{ storageKey: string; fileName: string; mediaType: string; byteSize: number } | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select({
      storageKey: assetFiles.storageKey,
      fileName: assetFiles.fileName,
      mediaType: assetFiles.mediaType,
      byteSize: assetFiles.byteSize,
    })
    .from(assetFiles)
    .where(eq(assetFiles.id, fileId))
    .limit(1);
  return row ?? null;
}

export interface NewAssetPackage {
  readonly assetId: string;
  readonly key: string;
  readonly name: string;
  readonly summary?: string;
}

export async function insertAssetPackage(
  input: NewAssetPackage,
  tx?: DatabaseOrTransaction,
): Promise<AssetPackageRow> {
  const db = tx ?? getDb();
  const [row] = await db
    .insert(assetPackages)
    .values({
      assetId: input.assetId,
      key: input.key,
      name: input.name,
      summary: input.summary ?? null,
    })
    .returning();
  return row;
}

export async function findAssetPackage(
  packageId: string,
  tx?: DatabaseOrTransaction,
): Promise<AssetPackageRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select()
    .from(assetPackages)
    .where(eq(assetPackages.id, packageId))
    .limit(1);
  return row ?? null;
}

/** Add one file of one version to a package. Idempotent on the pair. */
export async function addFileToPackage(
  input: { readonly packageId: string; readonly versionId: string; readonly fileId: string },
  tx?: DatabaseOrTransaction,
): Promise<void> {
  const db = tx ?? getDb();
  await db.insert(assetPackageFiles).values({ ...input }).onConflictDoNothing();
}

/**
 * Which files a package contains AT one version, without storage keys.
 *
 * The authorizer's whole question, answered by the denormalized `version_id` on
 * the membership row rather than by a join through `asset_files` — see the table's
 * docblock for why the denormalization is paid for.
 */
export async function findPackageFilesAtVersion(
  packageId: string,
  versionId: string,
  tx?: DatabaseOrTransaction,
): Promise<PublicAssetFileRow[]> {
  const db = tx ?? getDb();
  return db
    .select(PUBLIC_ASSET_FILE_COLUMNS)
    .from(assetPackageFiles)
    .innerJoin(assetFiles, eq(assetFiles.id, assetPackageFiles.fileId))
    .where(
      and(eq(assetPackageFiles.packageId, packageId), eq(assetPackageFiles.versionId, versionId)),
    )
    .orderBy(asc(assetFiles.fileName));
}

/**
 * The newest version of an asset a NEW acquisition may pin.
 *
 * Reads `ACQUIRABLE_ASSET_VERSION_STATES` rather than `'published'` so the one
 * member list is stated once. Ordered newest-first by publication instant, which
 * is the only ordering that is right when a creator publishes out of label order.
 */
export async function findAcquirableVersion(
  assetId: string,
  tx?: DatabaseOrTransaction,
): Promise<AssetVersionRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select()
    .from(assetVersions)
    .where(
      and(
        eq(assetVersions.assetId, assetId),
        inArray(assetVersions.state, [...ACQUIRABLE_ASSET_VERSION_STATES]),
      ),
    )
    .orderBy(desc(assetVersions.publishedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Record one inspection result (#1015 W4).
 *
 * `onConflictDoUpdate` on `(file_id, processor_name, processor_version)`: a worker
 * retried after a crash must converge rather than raise, and re-running the SAME
 * processor version on the same file is expected to produce the same numbers. A
 * NEW processor version writes a NEW row, which is what makes #1015 W4 requirement
 * 13 — *"so results can be recomputed later"* — true: the old measurement is still
 * there to compare against.
 */
export async function recordFileInspection(
  input: NewAssetFileInspection,
  tx?: DatabaseOrTransaction,
): Promise<void> {
  const db = tx ?? getDb();
  const values = {
    fileId: input.fileId,
    verdict: input.verdict,
    processorName: input.processorName,
    processorVersion: input.processorVersion,
    triangleCount: input.triangleCount ?? null,
    vertexCount: input.vertexCount ?? null,
    meshCount: input.meshCount ?? null,
    boundingBoxXMm: input.boundingBoxXMm ?? null,
    boundingBoxYMm: input.boundingBoxYMm ?? null,
    boundingBoxZMm: input.boundingBoxZMm ?? null,
    watertight: input.watertight ?? null,
    hasUvMapping: input.hasUvMapping ?? null,
    hasRig: input.hasRig ?? null,
    animationCount: input.animationCount ?? null,
    missingResourceCount: input.missingResourceCount ?? null,
    failureDetail: input.failureDetail ?? null,
    measuredAt: input.measuredAt,
  };
  await db
    .insert(assetFileInspections)
    .values(values)
    .onConflictDoUpdate({
      target: [
        assetFileInspections.fileId,
        assetFileInspections.processorName,
        assetFileInspections.processorVersion,
      ],
      set: values,
    });
}

/** What one inspection measured. Every geometry field optional: NULL is "not measured". */
export interface NewAssetFileInspection {
  readonly fileId: string;
  readonly verdict: AssetInspectionVerdict;
  readonly processorName: string;
  readonly processorVersion: string;
  readonly triangleCount?: number;
  readonly vertexCount?: number;
  readonly meshCount?: number;
  readonly boundingBoxXMm?: number;
  readonly boundingBoxYMm?: number;
  readonly boundingBoxZMm?: number;
  readonly watertight?: boolean;
  readonly hasUvMapping?: boolean;
  readonly hasRig?: boolean;
  readonly animationCount?: number;
  readonly missingResourceCount?: number;
  readonly failureDetail?: string;
  readonly measuredAt: Date;
}

/** Every inspection of a version's files, newest processor run last. */
export async function findVersionInspections(
  versionId: string,
  tx?: DatabaseOrTransaction,
): Promise<InferSelectModel<typeof assetFileInspections>[]> {
  const db = tx ?? getDb();
  return db
    .select({
      id: assetFileInspections.id,
      fileId: assetFileInspections.fileId,
      verdict: assetFileInspections.verdict,
      processorName: assetFileInspections.processorName,
      processorVersion: assetFileInspections.processorVersion,
      triangleCount: assetFileInspections.triangleCount,
      vertexCount: assetFileInspections.vertexCount,
      meshCount: assetFileInspections.meshCount,
      boundingBoxXMm: assetFileInspections.boundingBoxXMm,
      boundingBoxYMm: assetFileInspections.boundingBoxYMm,
      boundingBoxZMm: assetFileInspections.boundingBoxZMm,
      watertight: assetFileInspections.watertight,
      hasUvMapping: assetFileInspections.hasUvMapping,
      hasRig: assetFileInspections.hasRig,
      animationCount: assetFileInspections.animationCount,
      missingResourceCount: assetFileInspections.missingResourceCount,
      failureDetail: assetFileInspections.failureDetail,
      measuredAt: assetFileInspections.measuredAt,
      createdAt: assetFileInspections.createdAt,
    })
    .from(assetFileInspections)
    .innerJoin(assetFiles, eq(assetFiles.id, assetFileInspections.fileId))
    .where(eq(assetFiles.versionId, versionId))
    .then((rows) => rows as InferSelectModel<typeof assetFileInspections>[]);
}

/**
 * Record one provenance signal (#1015 W8).
 *
 * `onConflictDoNothing` on the whole identity tuple: the same fingerprint for the
 * same file is the same fact, and a re-upload of identical bytes must not grow the
 * evidence table. There is deliberately no update path — the table is append-only
 * by trigger, and a signal that could be edited is not evidence.
 */
export async function recordProvenanceSignal(
  input: {
    readonly versionId: string;
    readonly fileId: string | null;
    readonly kind: AssetProvenanceSignalKind;
    readonly value: string;
  },
  tx?: DatabaseOrTransaction,
): Promise<void> {
  const db = tx ?? getDb();
  await db
    .insert(assetProvenanceSignals)
    .values({
      versionId: input.versionId,
      fileId: input.fileId,
      kind: input.kind,
      value: input.value,
    })
    .onConflictDoNothing();
}

/**
 * Other versions carrying the same provenance signal — the re-upload sweep's read.
 *
 * Returns EVIDENCE and nothing else: a list of versions, never a verdict. #1015 W8
 * requirement 1 is that a hash match is evidence and not proof of ownership, and
 * the shape of this function is where that holds — there is no `isStolen` to
 * return and no confidence to compute, so a caller cannot accuse anybody with it.
 * What it feeds is a moderation review a human decides.
 */
export async function findMatchingProvenanceSignals(
  kind: AssetProvenanceSignalKind,
  value: string,
  excludeVersionId: string,
  tx?: DatabaseOrTransaction,
): Promise<{ versionId: string; fileId: string | null }[]> {
  const db = tx ?? getDb();
  const rows = await db
    .select({
      versionId: assetProvenanceSignals.versionId,
      fileId: assetProvenanceSignals.fileId,
    })
    .from(assetProvenanceSignals)
    .where(and(eq(assetProvenanceSignals.kind, kind), eq(assetProvenanceSignals.value, value)));
  return rows.filter((row) => row.versionId !== excludeVersionId);
}

/**
 * Whether every file of a version has a `clean` scan verdict.
 *
 * The publication gate's question (#1015 W1 requirement 12). A version with NO
 * files answers `false`: publishing an empty deliverable is not a thing a creator
 * means to do, and the alternative — `every()` over an empty list being `true` —
 * is how an empty version would become publishable.
 */
export async function everyFileScannedClean(
  versionId: string,
  tx?: DatabaseOrTransaction,
): Promise<boolean> {
  const files = await findVersionFiles(versionId, tx);
  if (files.length === 0) return false;
  return files.every((file) => PUBLISHABLE_ASSET_SCAN_VERDICTS.includes(file.scanVerdict));
}
