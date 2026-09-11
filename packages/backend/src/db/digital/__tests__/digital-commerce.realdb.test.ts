/**
 * The digital-commerce foundation against a REAL PostgreSQL database — #1015,
 * ADR 0010.
 *
 * Every guarantee this domain makes is held by a unique index, a CHECK, a trigger
 * or a single statement, and none of those exists under a mocked repository: a
 * mocked insert accepts a statement the server rejects outright, which is exactly
 * how a duplicated right, a swapped file, a fabricated shipping address or a
 * laundered licence would look green and ship broken.
 *
 * ## What each section answers, mapped to #1015's own acceptance criteria
 *
 *  1. A creator publishes one asset with immutable versions — criteria 1, 12.
 *  2. Payment creates EXACTLY ONE right under retries and reordering — criterion 4.
 *  3. The right records the purchased licence and version policy — criterion 5.
 *  4. An authorized buyer re-downloads without a permanent URL — criterion 6.
 *  5. An unauthorized caller cannot obtain the original — criterion 7.
 *  6. Free assets use the same architecture — criterion 11.
 *  7. Refund/dispute/restriction is deterministic and auditable — criterion 13.
 *  8. No fake inventory and no fake shipping record — criterion 16.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres database serves the whole suite and vitest runs files in
 * parallel workers, so every id, handle and buyer key this file writes carries a
 * per-run suffix, every aggregate is scoped to rows this file owns, and teardown
 * deletes exactly what it created — children first, since almost every foreign key
 * here is RESTRICT by design.
 *
 * Teardown goes AROUND four triggers that are themselves under test. That is the
 * escape `product-saves.realdb.test.ts` uses, under the same shared advisory lock
 * and with the same rule: ONE TABLE PER WINDOW (#301), because
 * `alter table … disable trigger` takes ShareRowExclusive and holding one while
 * acquiring another's deadlocks against a file doing it in the other order.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { isCheckViolation, uuidv7 } from '@oxy.so/db';
import { connectPostgres, type Database } from '../../postgres.js';
import { withTriggerToggleLock } from '../../__tests__/trigger-toggle-lock.js';
import { stores } from '../../schema/stores.js';
import { deleteTestStores } from '../../__tests__/store-teardown.js';
import {
  assetFileInspections,
  assetFiles,
  assetPackageFiles,
  assetPackages,
  assetProvenanceSignals,
  assetVersions,
  digitalAssets,
} from '../../schema/digitalAssets.js';
import {
  assetDownloadEvents,
  assetDownloadGrants,
  assetLicenceOptions,
  assetLicenceVersions,
  assetLicences,
  assetRightEvents,
  assetRights,
  assetVariantBindings,
} from '../../schema/digitalRights.js';
import { orderItems, orders } from '../../schema/orders.js';
import {
  addFileToPackage,
  findAcquirableVersion,
  everyFileInspectionAcceptable,
  everyFileScannedClean,
  insertAssetFile,
  insertAssetPackage,
  insertAssetVersion,
  insertDigitalAsset,
  publishAssetVersion,
  recordAssetFileScan,
  recordFileInspection,
  recordProvenanceSignal,
  findMatchingProvenanceSignals,
  withdrawAssetVersion,
} from '../assetRepository.js';
import {
  insertAssetLicenceVersion,
  publishAssetLicenceVersion,
  upsertAssetLicence,
} from '../licenceRepository.js';
import { findRightEvents, grantRight, transitionRight } from '../rightRepository.js';
import { mintDownloadGrant, redeemDownloadGrant } from '../../../services/digital/download.service.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);
const BUYER = `oxy:buyer-${RUN}`;
const OTHER_BUYER = `oxy:other-${RUN}`;

const createdStoreIds: string[] = [];
const createdAssetIds: string[] = [];
const createdLicenceIds: string[] = [];

/** `inArray` on an empty list renders `false`; a sentinel keeps the SQL valid. */
const safe = (ids: readonly string[]): string[] => (ids.length === 0 ? ['__none__'] : [...ids]);

/** A 64-char lowercase hex hash, which the CHECK on `content_hash` requires. */
const hash = (seed: string): string =>
  Array.from({ length: 64 }, (_, i) => '0123456789abcdef'[(seed.charCodeAt(i % seed.length) + i) % 16]).join('');

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  const assetIds = safe(createdAssetIds);
  const versionIds = (
    await db
      .select({ id: assetVersions.id })
      .from(assetVersions)
      .where(inArray(assetVersions.assetId, assetIds))
  ).map((row) => row.id);
  const fileIds = (
    await db
      .select({ id: assetFiles.id })
      .from(assetFiles)
      .where(inArray(assetFiles.versionId, safe(versionIds)))
  ).map((row) => row.id);
  const rightIds = (
    await db
      .select({ id: assetRights.id })
      .from(assetRights)
      .where(inArray(assetRights.buyerKey, [BUYER, OTHER_BUYER]))
  ).map((row) => row.id);

  // ONE TABLE PER WINDOW (#301). Four windows, in dependency order.
  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(sql`alter table asset_download_events disable trigger asset_download_events_append_only`);
    await tx.delete(assetDownloadEvents).where(inArray(assetDownloadEvents.rightId, safe(rightIds)));
    await tx
      .delete(assetDownloadEvents)
      .where(inArray(assetDownloadEvents.requesterKey, [BUYER, OTHER_BUYER, 'anonymous']));
    await tx.execute(sql`alter table asset_download_events enable trigger asset_download_events_append_only`);
  });
  await db.delete(assetDownloadGrants).where(inArray(assetDownloadGrants.rightId, safe(rightIds)));
  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(sql`alter table asset_right_events disable trigger asset_right_events_append_only`);
    await tx.delete(assetRightEvents).where(inArray(assetRightEvents.rightId, safe(rightIds)));
    await tx.execute(sql`alter table asset_right_events enable trigger asset_right_events_append_only`);
  });
  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(sql`alter table asset_rights disable trigger asset_rights_commercial_half_immutable`);
    await tx.delete(assetRights).where(inArray(assetRights.buyerKey, [BUYER, OTHER_BUYER]));
    await tx.execute(sql`alter table asset_rights enable trigger asset_rights_commercial_half_immutable`);
  });

  await db.delete(assetVariantBindings).where(inArray(assetVariantBindings.variantId, [`variant-${RUN}`]));
  await db.delete(assetLicenceOptions).where(inArray(assetLicenceOptions.assetId, assetIds));
  await db.delete(assetPackageFiles).where(inArray(assetPackageFiles.versionId, safe(versionIds)));
  await db.delete(assetPackages).where(inArray(assetPackages.assetId, assetIds));
  await db.delete(assetFileInspections).where(inArray(assetFileInspections.fileId, safe(fileIds)));
  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(sql`alter table asset_provenance_signals disable trigger asset_provenance_signals_append_only`);
    await tx.delete(assetProvenanceSignals).where(inArray(assetProvenanceSignals.versionId, safe(versionIds)));
    await tx.execute(sql`alter table asset_provenance_signals enable trigger asset_provenance_signals_append_only`);
  });
  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(sql`alter table asset_files disable trigger asset_files_immutable_once_published`);
    await tx.delete(assetFiles).where(inArray(assetFiles.versionId, safe(versionIds)));
    await tx.execute(sql`alter table asset_files enable trigger asset_files_immutable_once_published`);
  });
  await db.update(digitalAssets).set({ currentVersionId: null }).where(inArray(digitalAssets.id, assetIds));
  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(sql`alter table asset_versions disable trigger asset_versions_immutable_once_published`);
    await tx.delete(assetVersions).where(inArray(assetVersions.assetId, assetIds));
    await tx.execute(sql`alter table asset_versions enable trigger asset_versions_immutable_once_published`);
  });
  await db.delete(digitalAssets).where(inArray(digitalAssets.id, assetIds));
  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(
      sql`alter table asset_licence_versions disable trigger asset_licence_versions_immutable_once_published`,
    );
    await tx.delete(assetLicenceVersions).where(inArray(assetLicenceVersions.licenceId, safe(createdLicenceIds)));
    await tx.execute(
      sql`alter table asset_licence_versions enable trigger asset_licence_versions_immutable_once_published`,
    );
  });
  await db.delete(assetLicences).where(inArray(assetLicences.id, safe(createdLicenceIds)));
  if (createdOrderIds.length > 0) {
    // `order_items` cascades from `orders`, and the digital-snapshot trigger is on
    // UPDATE only — so no trigger window is needed here.
    await db.delete(orders).where(inArray(orders.id, createdOrderIds));
  }
  await deleteTestStores(db, createdStoreIds);
}, 120_000);

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

async function mintStore(label: string): Promise<string> {
  const [row] = await db
    .insert(stores)
    .values({
      handle: `dig-${label}-${RUN}`,
      name: `Digital store ${label} ${RUN}`,
      description: '',
      brandColor: '#000000',
    })
    .returning({ id: stores.id });
  createdStoreIds.push(row.id);
  return row.id;
}

/** A published licence version with the rights the case needs. */
async function mintLicenceVersion(
  storeId: string,
  slug: string,
  rights: readonly ('personal_use' | 'modification' | 'commercial_project_use')[],
): Promise<string> {
  const licence = await upsertAssetLicence({
    storeId,
    authorship: 'creator',
    slug: `${slug}-${RUN}`,
    name: `Licence ${slug}`,
  });
  createdLicenceIds.push(licence.id);
  const version = await insertAssetLicenceVersion({
    licenceId: licence.id,
    version: 1,
    summary: 'Test terms',
    rights,
    attribution: 'optional',
    seatLimit: null,
    revenueLimitAmount: null,
    revenueLimitCurrency: null,
    projectLimit: null,
    additionalTerms: null,
  });
  expect(await publishAssetLicenceVersion(version.id, new Date())).toBe(true);
  return version.id;
}

/** An asset with one published version, one package and two files in it. */
async function mintPublishedAsset(label: string): Promise<{
  assetId: string;
  versionId: string;
  packageId: string;
  meshFileId: string;
  previewFileId: string;
}> {
  const storeId = await mintStore(label);
  const asset = await insertDigitalAsset({ storeId, vertical: 'three_d', title: `Asset ${label}` });
  createdAssetIds.push(asset.id);
  const version = await insertAssetVersion({ assetId: asset.id, label: '1.0', majorVersion: 1 });

  const mesh = await insertAssetFile({
    versionId: version.id,
    fileName: 'model.stl',
    format: 'stl',
    mediaType: 'model/stl',
    role: 'mesh',
    visibility: 'rightful_download_only',
    byteSize: 2048,
    contentHash: hash(`${label}-mesh`),
    storageKey: `private/${RUN}/${label}/model.stl`,
  });
  const preview = await insertAssetFile({
    versionId: version.id,
    fileName: 'preview.glb',
    format: 'glb',
    mediaType: 'model/gltf-binary',
    role: 'web_derivative',
    visibility: 'preview_only',
    byteSize: 512,
    contentHash: hash(`${label}-preview`),
    storageKey: `private/${RUN}/${label}/preview.glb`,
  });
  await recordAssetFileScan(mesh.id, 'clean', new Date());
  await recordAssetFileScan(preview.id, 'clean', new Date());

  const pkg = await insertAssetPackage({ assetId: asset.id, key: 'printable', name: 'Printable' });
  await addFileToPackage({ packageId: pkg.id, versionId: version.id, fileId: mesh.id });
  await addFileToPackage({ packageId: pkg.id, versionId: version.id, fileId: preview.id });

  expect(await publishAssetVersion(version.id, new Date())).toBe(true);
  return {
    assetId: asset.id,
    versionId: version.id,
    packageId: pkg.id,
    meshFileId: mesh.id,
    previewFileId: preview.id,
  };
}

/* -------------------------------------------------------------------------- */
/* Order fixtures                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The minimum an `orders` row needs, money included, in one currency.
 *
 * Spelled out rather than built through `insertOrder`, deliberately: what several
 * cases below assert is what the DATABASE refuses, and a repository that declined
 * to compose an illegal row would make those assertions untestable.
 */
const orderValues = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  orderNumber: `MRC-${RUN}-${Math.floor(Math.random() * 1e6)}`,
  buyerOrigin: 'oxy',
  buyerOxyUserId: `buyer-${RUN}`,
  sellerType: 'user',
  sellerOxyUserId: `seller-${RUN}`,
  commercialRole: 'connected_marketplace',
  shippingLabel: 'Digital delivery',
  shippingCostShopAmount: 0,
  shippingCostShopCurrency: 'EUR',
  shippingCostPresentmentAmount: 0,
  shippingCostPresentmentCurrency: 'EUR',
  totalsSubtotalShopAmount: 0,
  totalsSubtotalShopCurrency: 'EUR',
  totalsSubtotalPresentmentAmount: 0,
  totalsSubtotalPresentmentCurrency: 'EUR',
  totalsDiscountTotalShopAmount: 0,
  totalsDiscountTotalShopCurrency: 'EUR',
  totalsDiscountTotalPresentmentAmount: 0,
  totalsDiscountTotalPresentmentCurrency: 'EUR',
  totalsShippingShopAmount: 0,
  totalsShippingShopCurrency: 'EUR',
  totalsShippingPresentmentAmount: 0,
  totalsShippingPresentmentCurrency: 'EUR',
  totalsTaxShopAmount: 0,
  totalsTaxShopCurrency: 'EUR',
  totalsTaxPresentmentAmount: 0,
  totalsTaxPresentmentCurrency: 'EUR',
  totalsGrandTotalShopAmount: 0,
  totalsGrandTotalShopCurrency: 'EUR',
  totalsGrandTotalPresentmentAmount: 0,
  totalsGrandTotalPresentmentCurrency: 'EUR',
  ...overrides,
});

const createdOrderIds: string[] = [];

/** A placed DIGITAL order with one line carrying the digital snapshot. */
async function mintDigitalOrder(snapshot: {
  packageId: string;
  assetVersionId: string;
  licenceVersionId: string;
  updatePolicy: 'purchased_version_only' | 'same_major_version' | 'all_future_versions';
}): Promise<{ orderId: string; orderItemId: string }> {
  const [order] = await db
    .insert(orders)
    .values(
      orderValues({
        shippingMethod: 'digital',
        digitalSupplyCountry: 'ES',
        digitalSupplyEvidence: 'buyer_declared',
        digitalWithdrawalBasis: 'waived_on_immediate_supply',
        digitalSupplyConsentAt: new Date(),
      }) as never,
    )
    .returning({ id: orders.id });
  createdOrderIds.push(order.id);
  const [item] = await db
    .insert(orderItems)
    .values({
      orderId: order.id,
      listingId: `listing-${RUN}`,
      variantId: `variant-${RUN}`,
      title: 'Digital line',
      variantTitle: 'Printable',
      unitPriceShopAmount: 600,
      unitPriceShopCurrency: 'EUR',
      unitPricePresentmentAmount: 600,
      unitPricePresentmentCurrency: 'EUR',
      quantity: 1,
      lineTotalShopAmount: 600,
      lineTotalShopCurrency: 'EUR',
      lineTotalPresentmentAmount: 600,
      lineTotalPresentmentCurrency: 'EUR',
      digitalPackageId: snapshot.packageId,
      digitalAssetVersionId: snapshot.assetVersionId,
      digitalLicenceVersionId: snapshot.licenceVersionId,
      digitalUpdatePolicy: snapshot.updatePolicy,
      position: 0,
    })
    .returning({ id: orderItems.id });
  return { orderId: order.id, orderItemId: item.id };
}

/* -------------------------------------------------------------------------- */
/* 1. The creator side                                                         */
/* -------------------------------------------------------------------------- */

describe('a creator publishes an asset, and the version is then immutable', () => {
  it('publishes, becomes current, and reports itself acquirable', async () => {
    const { assetId, versionId } = await mintPublishedAsset('publish');
    const [asset] = await db.select().from(digitalAssets).where(eq(digitalAssets.id, assetId));
    expect(asset.currentVersionId).toBe(versionId);
    expect(asset.state).toBe('listed');
    expect(asset.publishedAt).not.toBeNull();
    const acquirable = await findAcquirableVersion(assetId);
    expect(acquirable?.id).toBe(versionId);
  });

  it('REFUSES to rewrite a published version’s identity or changelog', async () => {
    const { versionId } = await mintPublishedAsset('frozen-version');
    await expect(
      db.update(assetVersions).set({ label: '9.9' }).where(eq(assetVersions.id, versionId)),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db.update(assetVersions).set({ changelog: 'rewritten' }).where(eq(assetVersions.id, versionId)),
    ).rejects.toSatisfy(isCheckViolation);
    // The control: the STATE may still move, or `withdrawVersion` below could not
    // work and the assertions above would be measuring a frozen row rather than a
    // frozen column set.
    expect(await withdrawAssetVersion(versionId)).toBe(true);
  });

  it('REFUSES to swap a file that belongs to a published version', async () => {
    // #1015 W12 threat 8: "creator replaces a file after purchase without
    // versioning". The bytes a buyer paid for cannot change under them.
    const { meshFileId } = await mintPublishedAsset('frozen-file');
    await expect(
      db
        .update(assetFiles)
        .set({ storageKey: 'private/elsewhere/model.stl' })
        .where(eq(assetFiles.id, meshFileId)),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db.update(assetFiles).set({ contentHash: hash('swapped') }).where(eq(assetFiles.id, meshFileId)),
    ).rejects.toSatisfy(isCheckViolation);
    // And the visibility, which is the one that would WIDEN what a licence covers.
    await expect(
      db.update(assetFiles).set({ visibility: 'public_download' }).where(eq(assetFiles.id, meshFileId)),
    ).rejects.toSatisfy(isCheckViolation);
    // The control: the scan verdict is still writable, because a security
    // withdrawal discovered after publication has to be recordable.
    await recordAssetFileScan(meshFileId, 'infected', new Date());
    const [file] = await db.select().from(assetFiles).where(eq(assetFiles.id, meshFileId));
    expect(file.scanVerdict).toBe('infected');
  });

  it('REFUSES to delete a published version or its files', async () => {
    const { versionId, meshFileId } = await mintPublishedAsset('no-delete');
    await expect(db.delete(assetFiles).where(eq(assetFiles.id, meshFileId))).rejects.toSatisfy(
      isCheckViolation,
    );
    await expect(db.delete(assetVersions).where(eq(assetVersions.id, versionId))).rejects.toSatisfy(
      isCheckViolation,
    );
  });

  it('REFUSES to rewrite published licence terms', async () => {
    // ADR 0010 D3: editing a licence tomorrow cannot change yesterday's purchase.
    const storeId = await mintStore('licence-frozen');
    const versionId = await mintLicenceVersion(storeId, 'frozen', ['personal_use']);
    await expect(
      db
        .update(assetLicenceVersions)
        .set({ rights: ['personal_use', 'commercial_project_use'] })
        .where(eq(assetLicenceVersions.id, versionId)),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db.update(assetLicenceVersions).set({ seatLimit: 99 }).where(eq(assetLicenceVersions.id, versionId)),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('reports a version unpublishable while a file is unscanned', async () => {
    const storeId = await mintStore('unscanned');
    const asset = await insertDigitalAsset({ storeId, vertical: 'three_d', title: 'Unscanned' });
    createdAssetIds.push(asset.id);
    const version = await insertAssetVersion({ assetId: asset.id, label: '1.0', majorVersion: 1 });
    // No files yet: `false`, deliberately — an empty deliverable is not publishable.
    expect(await everyFileScannedClean(version.id)).toBe(false);
    const file = await insertAssetFile({
      versionId: version.id,
      fileName: 'model.stl',
      format: 'stl',
      mediaType: 'model/stl',
      role: 'mesh',
      visibility: 'rightful_download_only',
      byteSize: 10,
      contentHash: hash('unscanned'),
      storageKey: `private/${RUN}/unscanned.stl`,
    });
    expect(await everyFileScannedClean(version.id)).toBe(false);
    await recordAssetFileScan(file.id, 'clean', new Date());
    expect(await everyFileScannedClean(version.id)).toBe(true);
  });

  it('reports a version unpublishable while a file is uninspected, corrupt or unreadable', async () => {
    // The scan gate's sibling, and the escape it leaves open: a `corrupt` file is
    // not malicious, so a scanner calls it `clean` and until this gate landed
    // nothing else stood between that file and a buyer.
    const storeId = await mintStore('uninspected');
    const asset = await insertDigitalAsset({ storeId, vertical: 'three_d', title: 'Uninspected' });
    createdAssetIds.push(asset.id);
    const version = await insertAssetVersion({ assetId: asset.id, label: '1.0', majorVersion: 1 });
    // No files: `false`, for the same reason the scan gate answers `false` —
    // `every()` over an empty list is `true`, which is how an uninspected
    // deliverable becomes publishable.
    expect(await everyFileInspectionAcceptable(version.id)).toBe(false);

    const file = await insertAssetFile({
      versionId: version.id,
      fileName: 'model.stl',
      format: 'stl',
      mediaType: 'model/stl',
      role: 'mesh',
      visibility: 'rightful_download_only',
      byteSize: 10,
      contentHash: hash('uninspected'),
      storageKey: `private/${RUN}/uninspected.stl`,
    });
    // A file with NO inspection row at all. Nothing has looked at it.
    expect(await everyFileInspectionAcceptable(version.id)).toBe(false);

    // `corrupt` — the header declares more triangles than the file holds. A
    // scanner would call this clean.
    const firstRun = new Date(Date.now() - 60_000);
    await recordFileInspection({
      fileId: file.id,
      verdict: 'corrupt',
      processorName: 'mercaria-mesh-inspect',
      processorVersion: '1.0.0',
      failureDetail: 'declares 900 triangles and holds 12',
      measuredAt: firstRun,
    });
    expect(await everyFileInspectionAcceptable(version.id)).toBe(false);

    // The creator fixes the file and the pipeline runs again. Inspections are
    // append-only, so BOTH rows exist — and an `every()` over all of them would
    // keep the old mistake blocking them forever with no way to clear it.
    await recordFileInspection({
      fileId: file.id,
      verdict: 'measured',
      processorName: 'mercaria-mesh-inspect',
      processorVersion: '2.0.0',
      triangleCount: 12,
      measuredAt: new Date(),
    });
    expect(await everyFileInspectionAcceptable(version.id)).toBe(true);
  });

  it('publishes an UNSUPPORTED or resource-missing file, and refuses an unread one', async () => {
    // Three memberships that are decisions rather than defaults. `unsupported` and
    // `missing_resources` PASS: blocking the first makes `blend`/`fbx`/`pdf`
    // unsellable in order to express "we did not look", and blocking the second
    // makes a pack whose texture reference is satisfied externally unpublishable
    // on a guess — it is disclosed on the technical panel instead. `failed` does
    // NOT pass: "we could not look" must not read like "we looked and it was fine".
    const storeId = await mintStore('verdicts');
    const asset = await insertDigitalAsset({ storeId, vertical: 'three_d', title: 'Verdicts' });
    createdAssetIds.push(asset.id);

    const cases = [
      { verdict: 'unsupported' as const, publishable: true },
      { verdict: 'missing_resources' as const, publishable: true },
      { verdict: 'failed' as const, publishable: false },
      { verdict: 'refused_too_large' as const, publishable: false },
      { verdict: 'pending' as const, publishable: false },
    ];

    for (const [index, probe] of cases.entries()) {
      const version = await insertAssetVersion({
        assetId: asset.id,
        label: `1.${index}`,
        majorVersion: 1,
      });
      const file = await insertAssetFile({
        versionId: version.id,
        fileName: `asset-${index}.blend`,
        format: 'blend',
        mediaType: 'application/octet-stream',
        role: 'source',
        visibility: 'rightful_download_only',
        byteSize: 10,
        contentHash: hash(`verdict-${index}`),
        storageKey: `private/${RUN}/verdict-${index}.blend`,
      });
      await recordFileInspection({
        fileId: file.id,
        verdict: probe.verdict,
        processorName: 'mercaria-mesh-inspect',
        processorVersion: '1.0.0',
        measuredAt: new Date(),
      });
      expect(
        await everyFileInspectionAcceptable(version.id),
        `${probe.verdict} should ${probe.publishable ? 'pass' : 'be refused'}`,
      ).toBe(probe.publishable);
    }
  });

  it('refuses a version where ONE of several files is unacceptable', async () => {
    // The gate is over every file, not any file. A two-file version with one good
    // mesh would pass a `some()` and is exactly the shape a real deliverable has.
    const storeId = await mintStore('mixed');
    const asset = await insertDigitalAsset({ storeId, vertical: 'three_d', title: 'Mixed' });
    createdAssetIds.push(asset.id);
    const version = await insertAssetVersion({ assetId: asset.id, label: '1.0', majorVersion: 1 });

    const good = await insertAssetFile({
      versionId: version.id,
      fileName: 'good.stl',
      format: 'stl',
      mediaType: 'model/stl',
      role: 'mesh',
      visibility: 'rightful_download_only',
      byteSize: 10,
      contentHash: hash('mixed-good'),
      storageKey: `private/${RUN}/mixed-good.stl`,
    });
    const bad = await insertAssetFile({
      versionId: version.id,
      fileName: 'bad.stl',
      format: 'stl',
      mediaType: 'model/stl',
      role: 'mesh',
      visibility: 'rightful_download_only',
      byteSize: 10,
      contentHash: hash('mixed-bad'),
      storageKey: `private/${RUN}/mixed-bad.stl`,
    });
    const measuredAt = new Date();
    await recordFileInspection({
      fileId: good.id,
      verdict: 'measured',
      processorName: 'mercaria-mesh-inspect',
      processorVersion: '1.0.0',
      triangleCount: 12,
      measuredAt,
    });
    await recordFileInspection({
      fileId: bad.id,
      verdict: 'corrupt',
      processorName: 'mercaria-mesh-inspect',
      processorVersion: '1.0.0',
      measuredAt,
    });

    expect(await everyFileInspectionAcceptable(version.id)).toBe(false);

    // The control: clearing the one bad file flips it, so the refusal above was
    // about that file and not about the version having two.
    await recordFileInspection({
      fileId: bad.id,
      verdict: 'measured',
      processorName: 'mercaria-mesh-inspect',
      processorVersion: '2.0.0',
      triangleCount: 12,
      measuredAt: new Date(Date.now() + 1_000),
    });
    expect(await everyFileInspectionAcceptable(version.id)).toBe(true);
  });

  it('keeps measured metadata separate from anything a seller claimed', async () => {
    // #1015 W4. The analyzer's numbers live in their own table with the processor
    // that produced them, so a recomputation is distinguishable from the original.
    const { meshFileId } = await mintPublishedAsset('measured');
    await recordFileInspection({
      fileId: meshFileId,
      verdict: 'measured',
      processorName: 'mercaria-mesh-inspect',
      processorVersion: '1.0.0',
      triangleCount: 42_180,
      watertight: true,
      measuredAt: new Date(),
    });
    // A retry of the SAME processor version converges rather than duplicating.
    await recordFileInspection({
      fileId: meshFileId,
      verdict: 'measured',
      processorName: 'mercaria-mesh-inspect',
      processorVersion: '1.0.0',
      triangleCount: 42_180,
      watertight: true,
      measuredAt: new Date(),
    });
    // A NEW processor version writes a NEW row, so the old measurement survives.
    await recordFileInspection({
      fileId: meshFileId,
      verdict: 'measured',
      processorName: 'mercaria-mesh-inspect',
      processorVersion: '2.0.0',
      triangleCount: 42_180,
      watertight: false,
      measuredAt: new Date(),
    });
    const rows = await db
      .select()
      .from(assetFileInspections)
      .where(eq(assetFileInspections.fileId, meshFileId));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.processorVersion))).toEqual(new Set(['1.0.0', '2.0.0']));
  });

  it('REFUSES a bounding box with two of three dimensions', async () => {
    const { meshFileId } = await mintPublishedAsset('bbox');
    await expect(
      db.insert(assetFileInspections).values({
        fileId: meshFileId,
        verdict: 'measured',
        processorName: 'partial',
        processorVersion: '1',
        boundingBoxXMm: 10,
        boundingBoxYMm: 20,
        measuredAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('retains provenance as EVIDENCE, and refuses to edit or forget it', async () => {
    // #1015 W8: a hash match is evidence, not proof. What the repository can answer
    // is "who else has this fingerprint", and nothing more.
    const first = await mintPublishedAsset('prov-a');
    const second = await mintPublishedAsset('prov-b');
    const shared = hash('shared-geometry');
    await recordProvenanceSignal({
      versionId: first.versionId,
      fileId: first.meshFileId,
      kind: 'geometry_fingerprint',
      value: shared,
    });
    await recordProvenanceSignal({
      versionId: second.versionId,
      fileId: second.meshFileId,
      kind: 'geometry_fingerprint',
      value: shared,
    });
    const matches = await findMatchingProvenanceSignals('geometry_fingerprint', shared, second.versionId);
    expect(matches.map((row) => row.versionId)).toEqual([first.versionId]);

    await expect(
      db
        .update(assetProvenanceSignals)
        .set({ value: hash('rewritten') })
        .where(eq(assetProvenanceSignals.versionId, first.versionId)),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db.delete(assetProvenanceSignals).where(eq(assetProvenanceSignals.versionId, first.versionId)),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

/* -------------------------------------------------------------------------- */
/* 2-3. The buyer's right                                                      */
/* -------------------------------------------------------------------------- */

describe('payment creates EXACTLY ONE right, under retries and reordering', () => {
  it('converges on a replay and appends only ONE granted event', async () => {
    // #1015 acceptance criterion 4. The idempotency is the unique index, so the
    // second call is a real second INSERT that the server refuses.
    const { assetId, versionId, packageId } = await mintPublishedAsset('idem');
    const storeId = createdStoreIds[createdStoreIds.length - 1];
    const licenceVersionId = await mintLicenceVersion(storeId, 'idem', ['personal_use']);
    // A REAL order and line, because `asset_rights.order_item_id` carries a
    // foreign key and `asset_rights_order_pairing_check` requires the order id
    // beside it — a fabricated string id would be refused by the first and a
    // missing `orderId` by the second, and both refusals are correct.
    const { orderId, orderItemId } = await mintDigitalOrder({
      packageId,
      assetVersionId: versionId,
      licenceVersionId,
      updatePolicy: 'purchased_version_only',
    });
    const input = {
      buyerKey: BUYER,
      assetId,
      packageId,
      purchasedVersionId: versionId,
      licenceVersionId,
      updatePolicy: 'purchased_version_only' as const,
      source: 'purchase' as const,
      orderItemId,
      orderId,
      grantedAt: new Date(),
    };
    const first = await grantRight(input, 'system');
    const second = await grantRight(input, 'system');
    const third = await grantRight({ ...input, grantedAt: new Date() }, 'system');

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(second.right.id).toBe(first.right.id);
    expect(third.right.id).toBe(first.right.id);

    const rows = await db.select().from(assetRights).where(eq(assetRights.orderItemId, orderItemId));
    expect(rows).toHaveLength(1);
    const events = await findRightEvents(first.right.id);
    expect(events.filter((event) => event.kind === 'granted')).toHaveLength(1);
  });

  it('records the EXACT purchased licence version and update policy', async () => {
    // #1015 acceptance criterion 5, and criterion 12 with it: publishing a new
    // version later cannot move these.
    const { assetId, versionId, packageId } = await mintPublishedAsset('snapshot');
    const storeId = createdStoreIds[createdStoreIds.length - 1];
    const licenceVersionId = await mintLicenceVersion(storeId, 'snapshot', ['personal_use', 'modification']);
    const { orderId, orderItemId } = await mintDigitalOrder({
      packageId,
      assetVersionId: versionId,
      licenceVersionId,
      updatePolicy: 'same_major_version',
    });
    const { right } = await grantRight(
      {
        buyerKey: BUYER,
        assetId,
        packageId,
        purchasedVersionId: versionId,
        licenceVersionId,
        updatePolicy: 'same_major_version',
        source: 'purchase',
        orderItemId,
        orderId,
        grantedAt: new Date(),
      },
      'system',
    );
    expect(right.licenceVersionId).toBe(licenceVersionId);
    expect(right.purchasedVersionId).toBe(versionId);
    expect(right.updatePolicy).toBe('same_major_version');

    // And the commercial half cannot be rewritten — #1015 W12 threat 9, "buyer
    // claims a higher licence than purchased", whose shape is exactly this UPDATE.
    const otherLicence = await mintLicenceVersion(storeId, 'upgrade', [
      'personal_use',
      'commercial_project_use',
    ]);
    await expect(
      db.update(assetRights).set({ licenceVersionId: otherLicence }).where(eq(assetRights.id, right.id)),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db.update(assetRights).set({ buyerKey: OTHER_BUYER }).where(eq(assetRights.id, right.id)),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(db.delete(assetRights).where(eq(assetRights.id, right.id))).rejects.toSatisfy(
      isCheckViolation,
    );
    // The control: the STATUS moves, which is what makes a refund expressible.
    expect(
      await transitionRight({
        rightId: right.id,
        from: ['active'],
        to: 'refunded',
        kind: 'refunded',
        actor: 'system',
        occurredAt: new Date(),
      }),
    ).toBe('moved');
  });

  it('allows ONE free claim per buyer per package, with no order line', async () => {
    // #1015 W7 and criterion 11: a free asset uses the same architecture rather
    // than a separate hack, and the partial unique index is what bounds the claim.
    const { assetId, versionId, packageId } = await mintPublishedAsset('free');
    const storeId = createdStoreIds[createdStoreIds.length - 1];
    const licenceVersionId = await mintLicenceVersion(storeId, 'free', ['personal_use']);
    const claim = {
      buyerKey: BUYER,
      assetId,
      packageId,
      purchasedVersionId: versionId,
      licenceVersionId,
      updatePolicy: 'all_future_versions' as const,
      source: 'free_claim' as const,
      orderItemId: null,
      orderId: null,
      grantedAt: new Date(),
    };
    expect((await grantRight(claim, BUYER)).created).toBe(true);
    expect((await grantRight(claim, BUYER)).created).toBe(false);
    // A DIFFERENT buyer claims the same package, which must succeed — the control
    // that the index is on the pair and not on the package alone.
    expect((await grantRight({ ...claim, buyerKey: OTHER_BUYER }, OTHER_BUYER)).created).toBe(true);
    const rows = await db.select().from(assetRights).where(eq(assetRights.packageId, packageId));
    expect(rows).toHaveLength(2);
  });

  it('REFUSES a purchase with no order line, and a revocation with no basis', async () => {
    const { assetId, versionId, packageId } = await mintPublishedAsset('checks');
    const storeId = createdStoreIds[createdStoreIds.length - 1];
    const licenceVersionId = await mintLicenceVersion(storeId, 'checks', ['personal_use']);
    await expect(
      db.insert(assetRights).values({
        buyerKey: BUYER,
        assetId,
        packageId,
        purchasedVersionId: versionId,
        licenceVersionId,
        updatePolicy: 'purchased_version_only',
        source: 'purchase',
        orderItemId: null,
        orderId: null,
        grantedAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db.insert(assetRights).values({
        buyerKey: BUYER,
        assetId,
        packageId,
        purchasedVersionId: versionId,
        licenceVersionId,
        updatePolicy: 'purchased_version_only',
        source: 'free_claim',
        status: 'revoked_for_policy',
        grantedAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db.insert(assetRights).values({
        buyerKey: 'nobody',
        assetId,
        packageId,
        purchasedVersionId: versionId,
        licenceVersionId,
        updatePolicy: 'purchased_version_only',
        source: 'free_claim',
        grantedAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('moves a right deterministically, and the trail is append-only', async () => {
    // #1015 acceptance criterion 13.
    const { assetId, versionId, packageId } = await mintPublishedAsset('trail');
    const storeId = createdStoreIds[createdStoreIds.length - 1];
    const licenceVersionId = await mintLicenceVersion(storeId, 'trail', ['personal_use']);
    const { right } = await grantRight(
      {
        buyerKey: BUYER,
        assetId,
        packageId,
        purchasedVersionId: versionId,
        licenceVersionId,
        updatePolicy: 'purchased_version_only',
        source: 'free_claim',
        orderItemId: null,
        orderId: null,
        grantedAt: new Date(),
      },
      BUYER,
    );
    expect(
      await transitionRight({
        rightId: right.id,
        from: ['active'],
        to: 'disputed_hold',
        kind: 'dispute_opened',
        actor: 'system',
        occurredAt: new Date(),
      }),
    ).toBe('moved');
    // The CAS half: a caller that believed it was still `active` is told `stale`
    // rather than moving it a second time.
    expect(
      await transitionRight({
        rightId: right.id,
        from: ['active'],
        to: 'refunded',
        kind: 'refunded',
        actor: 'system',
        occurredAt: new Date(),
      }),
    ).toBe('stale');
    expect(
      await transitionRight({
        rightId: right.id,
        from: ['disputed_hold'],
        to: 'revoked_for_policy',
        kind: 'revoked',
        actor: 'operator:ops',
        occurredAt: new Date(),
        revocationBasis: 'upheld_intellectual_property_claim',
        detail: 'claim upheld',
      }),
    ).toBe('moved');
    expect(await transitionRight({
      rightId: `missing-${RUN}`,
      from: ['active'],
      to: 'refunded',
      kind: 'refunded',
      actor: 'system',
      occurredAt: new Date(),
    })).toBe('missing');

    const events = await findRightEvents(right.id);
    expect(events.map((event) => event.kind)).toEqual(['granted', 'dispute_opened', 'revoked']);
    await expect(
      db.update(assetRightEvents).set({ detail: 'edited' }).where(eq(assetRightEvents.rightId, right.id)),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db.delete(assetRightEvents).where(eq(assetRightEvents.rightId, right.id)),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

/* -------------------------------------------------------------------------- */
/* 4-5. Downloading                                                            */
/* -------------------------------------------------------------------------- */

describe('a download is authorized against the RIGHT, never against a URL', () => {
  async function mintRight(label: string, policy: 'purchased_version_only' | 'all_future_versions') {
    const asset = await mintPublishedAsset(label);
    const storeId = createdStoreIds[createdStoreIds.length - 1];
    const licenceVersionId = await mintLicenceVersion(storeId, label, ['personal_use']);
    const { right } = await grantRight(
      {
        buyerKey: BUYER,
        assetId: asset.assetId,
        packageId: asset.packageId,
        purchasedVersionId: asset.versionId,
        licenceVersionId,
        updatePolicy: policy,
        source: 'free_claim',
        orderItemId: null,
        orderId: null,
        grantedAt: new Date(),
      },
      BUYER,
    );
    return { ...asset, rightId: right.id };
  }

  it('mints a grant, and the SAME right can be redeemed again later', async () => {
    // #1015 acceptance criterion 6: re-download without a permanent public URL.
    const { rightId, versionId, meshFileId } = await mintRight('download', 'purchased_version_only');
    const first = await mintDownloadGrant({
      requesterKey: BUYER,
      rightId,
      versionId,
      fileId: meshFileId,
    });
    expect(first.outcome).toBe('granted');
    if (first.outcome !== 'granted') return;
    expect(first.grant.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const redeemed = await redeemDownloadGrant(first.grant.token, BUYER);
    expect(redeemed.outcome).toBe('ready');
    if (redeemed.outcome !== 'ready') return;
    expect(redeemed.storageKey).toContain('private/');

    // A SECOND grant, later, from the same right — which is what "re-download"
    // means, and what a one-shot signed URL could not provide.
    const second = await mintDownloadGrant({
      requesterKey: BUYER,
      rightId,
      versionId,
      fileId: meshFileId,
    });
    expect(second.outcome).toBe('granted');

    // The token is NEVER stored: only its hash, and the hash is not the token.
    const grants = await db.select().from(assetDownloadGrants).where(eq(assetDownloadGrants.rightId, rightId));
    expect(grants).toHaveLength(2);
    for (const grant of grants) {
      expect(grant.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      if (first.outcome === 'granted') expect(grant.tokenHash).not.toBe(first.grant.token);
    }
  });

  it('REFUSES another buyer’s right with the same answer as a missing one', async () => {
    // #1015 W12 threat 1. Distinguishing the two would confirm that an id exists.
    const { rightId, versionId, meshFileId } = await mintRight('foreign', 'purchased_version_only');
    const foreign = await mintDownloadGrant({
      requesterKey: OTHER_BUYER,
      rightId,
      versionId,
      fileId: meshFileId,
    });
    const missing = await mintDownloadGrant({
      requesterKey: OTHER_BUYER,
      rightId: `no-such-right-${RUN}`,
      versionId,
      fileId: meshFileId,
    });
    expect(foreign).toEqual({ outcome: 'refused', reason: 'no_right' });
    expect(missing).toEqual({ outcome: 'refused', reason: 'no_right' });
  });

  it('REFUSES a preview-only file, which the public viewer streams instead', async () => {
    const { rightId, versionId, previewFileId } = await mintRight('preview', 'purchased_version_only');
    expect(
      await mintDownloadGrant({ requesterKey: BUYER, rightId, versionId, fileId: previewFileId }),
    ).toEqual({ outcome: 'refused', reason: 'file_not_downloadable' });
  });

  it('REFUSES a file that is not in the purchased package', async () => {
    // The check that stops a cheaper licence reaching a `source` file: the package
    // defines what was sold.
    const { rightId, versionId } = await mintRight('outside', 'purchased_version_only');
    const other = await mintPublishedAsset('outside-other');
    expect(
      await mintDownloadGrant({ requesterKey: BUYER, rightId, versionId, fileId: other.meshFileId }),
    ).toEqual({ outcome: 'refused', reason: 'file_not_in_package' });
  });

  it('REFUSES a version the update policy does not cover', async () => {
    const { assetId, rightId, meshFileId } = await mintRight('policy', 'purchased_version_only');
    const second = await insertAssetVersion({ assetId, label: '2.0', majorVersion: 2 });
    const file = await insertAssetFile({
      versionId: second.id,
      fileName: 'model.stl',
      format: 'stl',
      mediaType: 'model/stl',
      role: 'mesh',
      visibility: 'rightful_download_only',
      byteSize: 4096,
      contentHash: hash('v2-mesh'),
      storageKey: `private/${RUN}/policy/v2.stl`,
    });
    await recordAssetFileScan(file.id, 'clean', new Date());
    expect(await publishAssetVersion(second.id, new Date())).toBe(true);
    expect(
      await mintDownloadGrant({ requesterKey: BUYER, rightId, versionId: second.id, fileId: file.id }),
    ).toEqual({ outcome: 'refused', reason: 'version_not_covered' });
    // The control: the purchased version is still reachable, so the refusal above
    // is about coverage and not about the asset having become unreadable.
    const still = await mintDownloadGrant({
      requesterKey: BUYER,
      rightId,
      versionId: (await db.select().from(assetRights).where(eq(assetRights.id, rightId)))[0]
        .purchasedVersionId,
      fileId: meshFileId,
    });
    expect(still.outcome).toBe('granted');
  });

  it('REFUSES a download once the right stops being active, mid-window', async () => {
    // The five-minute window is short and is not zero: a refund inside it must stop
    // the transfer rather than be noticed on the next request.
    const { rightId, versionId, meshFileId } = await mintRight('refunded-mid', 'purchased_version_only');
    const granted = await mintDownloadGrant({
      requesterKey: BUYER,
      rightId,
      versionId,
      fileId: meshFileId,
    });
    expect(granted.outcome).toBe('granted');
    if (granted.outcome !== 'granted') return;
    await transitionRight({
      rightId,
      from: ['active'],
      to: 'refunded',
      kind: 'refunded',
      actor: 'system',
      occurredAt: new Date(),
    });
    expect(await redeemDownloadGrant(granted.grant.token, BUYER)).toEqual({
      outcome: 'refused',
      reason: 'right_not_active',
    });
    expect(
      await mintDownloadGrant({ requesterKey: BUYER, rightId, versionId, fileId: meshFileId }),
    ).toEqual({ outcome: 'refused', reason: 'right_not_active' });
  });

  it('REFUSES an unknown token and records the attempt', async () => {
    const before = await db
      .select({ id: assetDownloadEvents.id })
      .from(assetDownloadEvents)
      .where(eq(assetDownloadEvents.requesterKey, OTHER_BUYER));
    expect(await redeemDownloadGrant('not-a-real-token', OTHER_BUYER)).toEqual({
      outcome: 'refused',
      reason: 'no_right',
    });
    const after = await db
      .select({ id: assetDownloadEvents.id })
      .from(assetDownloadEvents)
      .where(eq(assetDownloadEvents.requesterKey, OTHER_BUYER));
    // FLOORED rather than compared to an exact count: the database is shared and
    // this buyer key is this file's own, but other cases in this file write it too.
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('exhausts a grant after its redemption cap', async () => {
    const { rightId, versionId, meshFileId } = await mintRight('exhaust', 'purchased_version_only');
    const granted = await mintDownloadGrant({
      requesterKey: BUYER,
      rightId,
      versionId,
      fileId: meshFileId,
    });
    if (granted.outcome !== 'granted') throw new Error('expected a grant');
    for (let i = 0; i < 5; i += 1) {
      expect((await redeemDownloadGrant(granted.grant.token, BUYER)).outcome, `redemption ${i}`).toBe(
        'ready',
      );
    }
    expect(await redeemDownloadGrant(granted.grant.token, BUYER)).toEqual({
      outcome: 'refused',
      reason: 'grant_exhausted',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 8. No fake shipping record                                                  */
/* -------------------------------------------------------------------------- */

describe('a digital order carries NO address, and a physical one must', () => {
  it('accepts a `digital` order with every address column NULL', async () => {
    const [row] = await db
      .insert(orders)
      .values(
        orderValues({
          shippingMethod: 'digital',
          digitalSupplyCountry: 'ES',
          digitalSupplyEvidence: 'buyer_declared',
          digitalWithdrawalBasis: 'waived_on_immediate_supply',
          digitalSupplyConsentAt: new Date(),
        }) as never,
      )
      .returning({ id: orders.id });
    createdOrderIds.push(row.id);
    expect(row.id).toBeTruthy();
  });

  it('REFUSES a `digital` order carrying a fabricated address', async () => {
    // #1015 boundary 16 as a constraint rather than a convention. The NOT NULLs
    // this replaced could be satisfied by exactly this row.
    await expect(
      db.insert(orders).values(
        orderValues({
          shippingMethod: 'digital',
          digitalSupplyCountry: 'ES',
          digitalSupplyEvidence: 'buyer_declared',
          digitalWithdrawalBasis: 'statutory_cooling_off',
          shippingAddressRecipientName: 'Nobody',
          shippingAddressLine1: 'n/a',
          shippingAddressCity: 'n/a',
          shippingAddressPostalCode: '00000',
          shippingAddressCountry: 'ES',
        }) as never,
      ),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES a PHYSICAL order with no address — the wall the NOT NULLs held', async () => {
    await expect(
      db.insert(orders).values(orderValues({ shippingMethod: 'standard' }) as never),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES a `digital` order with no place of supply', async () => {
    await expect(
      db.insert(orders).values(orderValues({ shippingMethod: 'digital' }) as never),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES a waiver with no consent timestamp, and a timestamp with no waiver', async () => {
    await expect(
      db.insert(orders).values(
        orderValues({
          shippingMethod: 'digital',
          digitalSupplyCountry: 'ES',
          digitalSupplyEvidence: 'buyer_declared',
          digitalWithdrawalBasis: 'waived_on_immediate_supply',
        }) as never,
      ),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db.insert(orders).values(
        orderValues({
          shippingMethod: 'digital',
          digitalSupplyCountry: 'ES',
          digitalSupplyEvidence: 'buyer_declared',
          digitalWithdrawalBasis: 'statutory_cooling_off',
          digitalSupplyConsentAt: new Date(),
        }) as never,
      ),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('REFUSES a lowercase supply country, and a partial supply triple', async () => {
    await expect(
      db.insert(orders).values(
        orderValues({
          shippingMethod: 'digital',
          digitalSupplyCountry: 'es',
          digitalSupplyEvidence: 'buyer_declared',
          digitalWithdrawalBasis: 'statutory_cooling_off',
        }) as never,
      ),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db.insert(orders).values(
        orderValues({
          shippingMethod: 'digital',
          digitalSupplyCountry: 'ES',
          digitalWithdrawalBasis: 'statutory_cooling_off',
        }) as never,
      ),
    ).rejects.toSatisfy(isCheckViolation);
  });
});
