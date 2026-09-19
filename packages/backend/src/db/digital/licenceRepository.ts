/**
 * The only writer of the licence tables (#1015 W2, ADR 0010 D3).
 *
 * Publishing a licence version is the point past which its terms are frozen — by
 * the `asset_licence_versions_immutable_once_published` trigger, not by this
 * module — so everything here is either an insert, a CAS on `state`, or a read.
 * There is deliberately no `updateLicenceVersionTerms`.
 */

import { and, asc, desc, eq } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  DigitalLicenceAttributionMode,
  DigitalLicenceAuthorship,
  DigitalLicenceRight,
  DigitalLicenceUpdatePolicy,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  assetLicenceOptions,
  assetLicenceVersions,
  assetLicences,
} from '../schema/digitalRights.js';

export type AssetLicenceRow = InferSelectModel<typeof assetLicences>;
export type AssetLicenceVersionRow = InferSelectModel<typeof assetLicenceVersions>;
export type AssetLicenceOptionRow = InferSelectModel<typeof assetLicenceOptions>;

export interface NewAssetLicence {
  readonly storeId: string | null;
  readonly authorship: DigitalLicenceAuthorship;
  readonly slug: string;
  readonly name: string;
}

/**
 * Insert a licence, converging on the owner + slug pair.
 *
 * `onConflictDoNothing` plus a read rather than a raise, because seeding the
 * Mercaria reference licences runs on every boot of a fresh deployment and a
 * second boot must not fail. The conflict target is stated per branch, since the
 * two unique indexes are partial on `store_id IS NULL` and one `ON CONFLICT`
 * cannot name both.
 */
export async function upsertAssetLicence(
  input: NewAssetLicence,
  tx?: DatabaseOrTransaction,
): Promise<AssetLicenceRow> {
  const db = tx ?? getDb();
  const [inserted] = await db
    .insert(assetLicences)
    .values({
      storeId: input.storeId,
      authorship: input.authorship,
      slug: input.slug,
      name: input.name,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const existing = await findAssetLicenceBySlug(input.storeId, input.slug, tx);
  if (!existing) {
    // Unreachable through either unique index, and it is an explicit throw rather
    // than a non-null assertion: a silent `undefined` here would travel into a
    // licence version's foreign key and fail somewhere unrelated.
    throw new Error(`asset licence ${input.slug} neither inserted nor found`);
  }
  return existing;
}

export async function findAssetLicenceBySlug(
  storeId: string | null,
  slug: string,
  tx?: DatabaseOrTransaction,
): Promise<AssetLicenceRow | null> {
  const db = tx ?? getDb();
  const rows = await db
    .select()
    .from(assetLicences)
    .where(eq(assetLicences.slug, slug))
    .limit(50);
  return rows.find((row) => row.storeId === storeId) ?? null;
}

export interface NewAssetLicenceVersion {
  readonly licenceId: string;
  readonly version: number;
  readonly summary: string;
  readonly rights: readonly DigitalLicenceRight[];
  readonly attribution: DigitalLicenceAttributionMode;
  readonly seatLimit: number | null;
  readonly revenueLimitAmount: number | null;
  readonly revenueLimitCurrency: string | null;
  readonly projectLimit: number | null;
  readonly additionalTerms: string | null;
}

export async function insertAssetLicenceVersion(
  input: NewAssetLicenceVersion,
  tx?: DatabaseOrTransaction,
): Promise<AssetLicenceVersionRow> {
  const db = tx ?? getDb();
  const [row] = await db
    .insert(assetLicenceVersions)
    .values({
      licenceId: input.licenceId,
      version: input.version,
      summary: input.summary,
      rights: [...input.rights],
      attribution: input.attribution,
      seatLimit: input.seatLimit,
      revenueLimitAmount: input.revenueLimitAmount,
      revenueLimitCurrency: input.revenueLimitCurrency as never,
      projectLimit: input.projectLimit,
      additionalTerms: input.additionalTerms,
    })
    .returning();
  return row;
}

/** Publish a licence version. A CAS on `draft`, so a replay converges. */
export async function publishAssetLicenceVersion(
  versionId: string,
  now: Date,
  tx?: DatabaseOrTransaction,
): Promise<boolean> {
  const db = tx ?? getDb();
  const rows = await db
    .update(assetLicenceVersions)
    .set({ state: 'published', publishedAt: now })
    .where(and(eq(assetLicenceVersions.id, versionId), eq(assetLicenceVersions.state, 'draft')))
    .returning({ id: assetLicenceVersions.id });
  return rows.length === 1;
}

export async function findAssetLicenceVersion(
  versionId: string,
  tx?: DatabaseOrTransaction,
): Promise<AssetLicenceVersionRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select()
    .from(assetLicenceVersions)
    .where(eq(assetLicenceVersions.id, versionId))
    .limit(1);
  return row ?? null;
}

/** The newest PUBLISHED version of a licence, which is what an option may name. */
export async function findPublishedLicenceVersion(
  licenceId: string,
  tx?: DatabaseOrTransaction,
): Promise<AssetLicenceVersionRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select()
    .from(assetLicenceVersions)
    .where(
      and(eq(assetLicenceVersions.licenceId, licenceId), eq(assetLicenceVersions.state, 'published')),
    )
    .orderBy(desc(assetLicenceVersions.version))
    .limit(1);
  return row ?? null;
}

export interface NewAssetLicenceOption {
  readonly assetId: string;
  readonly packageId: string;
  readonly licenceVersionId: string;
  readonly updatePolicy: DigitalLicenceUpdatePolicy;
  readonly position?: number;
}

export async function insertAssetLicenceOption(
  input: NewAssetLicenceOption,
  tx?: DatabaseOrTransaction,
): Promise<AssetLicenceOptionRow> {
  const db = tx ?? getDb();
  const [row] = await db
    .insert(assetLicenceOptions)
    .values({
      assetId: input.assetId,
      packageId: input.packageId,
      licenceVersionId: input.licenceVersionId,
      updatePolicy: input.updatePolicy,
      position: input.position ?? 0,
    })
    .returning();
  return row;
}

export async function findAssetLicenceOption(
  optionId: string,
  tx?: DatabaseOrTransaction,
): Promise<AssetLicenceOptionRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select()
    .from(assetLicenceOptions)
    .where(eq(assetLicenceOptions.id, optionId))
    .limit(1);
  return row ?? null;
}

/** Every option a product page lists for one asset, in display order. */
export async function findAssetLicenceOptions(
  assetId: string,
  tx?: DatabaseOrTransaction,
): Promise<AssetLicenceOptionRow[]> {
  const db = tx ?? getDb();
  return db
    .select()
    .from(assetLicenceOptions)
    .where(eq(assetLicenceOptions.assetId, assetId))
    .orderBy(asc(assetLicenceOptions.position), asc(assetLicenceOptions.id));
}
