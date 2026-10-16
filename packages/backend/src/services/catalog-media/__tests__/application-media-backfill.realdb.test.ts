/**
 * The application-media backfill (Oxy ADR 0043): category art, brand logos and
 * canonical images into files the MERCARIA APPLICATION owns.
 *
 * Only Oxy is replaced, at the SDK boundary (`__tests__/oxy-files-fake.ts`,
 * which imports per owner and URL like Oxy). Every compare-and-swap below runs
 * against the real rows. Each case scopes the run to its own row with `id`, so
 * no case touches a row another realdb file owns.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { brands } from '../../../db/schema/organizations.js';
import { categories } from '../../../db/schema/catalog.js';
import { insertCategory } from '../../../db/taxonomy/taxonomyRepository.js';
import { createBrand } from '../../canonical/brand.service.js';
import { createHash } from 'node:crypto';
import { and } from 'drizzle-orm';
import { canonicalImages, canonicalProducts } from '../../../db/schema/canonicalCatalog.js';
import { canonicalSourceMediaImports } from '../../../db/schema/canonicalSourceMedia.js';
import {
  ensureCatalogSource,
  recordSourceObservation,
} from '../../../db/canonical/provenanceRepository.js';
import { insertCanonicalProductSourceLink } from '../../../db/canonical/canonicalProductRepository.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';
import { createCanonicalProduct } from '../../canonical/canonical-product.service.js';
import type { FakeOxyFiles } from '../../../__tests__/oxy-files-fake.js';

const oxyFiles = vi.hoisted(() => ({ current: undefined as undefined | FakeOxyFiles }));
vi.mock('../../../capabilities/oxy-service-client.js', async () => {
  const { createFakeOxyFiles } = await import('../../../__tests__/oxy-files-fake.js');
  oxyFiles.current = createFakeOxyFiles();
  return { oxyServiceClient: () => oxyFiles.current?.client };
});

const {
  backfillApplicationMedia,
  backfillCanonicalDescriptionImages,
  backfillCanonicalImageDuplicates,
  backfillCanonicalSourceMediaQueue,
} = await import('../application-media-backfill.js');
const { resolveMedia } = await import('../urls.js');

const RUN = uuidv7().slice(-12);

/** A value the test just arranged to exist; a missing one is a fixture failure. */
function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`fixture: no ${what}`);
  return value;
}
let db: Database;

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);
const productIds: string[] = [];
afterAll(async () => {
  await deleteTestCanonicalRows(db, { productIds });
  await closePostgres();
});

async function mintProduct(label: string, description?: string): Promise<string> {
  const product = await createCanonicalProduct({
    name: `App media ${label} ${RUN}`,
    ...(description === undefined ? {} : { description }),
  });
  productIds.push(product.id);
  return product.id;
}

async function observation(label: string, payload?: Record<string, unknown>): Promise<string> {
  const source = await ensureCatalogSource(db, {
    kind: 'feed',
    name: `app-media-${RUN}`,
    mayDisplay: true,
    mayStore: true,
    attributionRequired: false,
  });
  const { record } = await recordSourceObservation(db, {
    sourceId: source.id,
    externalType: 'product',
    externalId: `app-media-${label}-${RUN}`,
    observedAt: new Date(),
    contentHash: createHash('sha256').update(`${label}-${RUN}`).digest('hex'),
    ...(payload === undefined ? {} : { payload }),
  });
  return record.id;
}
beforeEach(() => oxyFiles.current?.reset());

describe('application-owned media backfill', () => {
  it('previews without importing, and reports hashes rather than URLs', async () => {
    const brand = await createBrand({ name: `App Media Preview ${RUN}` });
    await db
      .update(brands)
      .set({ logoFileId: `operator-logo-${RUN}` })
      .where(eq(brands.id, brand.id));
    const report = await backfillApplicationMedia(
      { target: 'brand_logo', mode: 'preview', limit: 1, id: brand.id },
      db,
    );
    expect(report.entries).toEqual([
      {
        id: brand.id,
        plan: 'adopt',
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        outcome: 'pending',
      },
    ]);
    expect(JSON.stringify(report)).not.toContain('cloud.oxy.so');
    expect(oxyFiles.current?.imports).toEqual([]);
  });

  it('adopts an operator-owned logo as the application’s, then finds nothing left to change', async () => {
    const brand = await createBrand({ name: `App Media Adopt ${RUN}` });
    const operatorFile = `operator-logo-adopt-${RUN}`;
    await db.update(brands).set({ logoFileId: operatorFile }).where(eq(brands.id, brand.id));
    const first = await backfillApplicationMedia(
      { target: 'brand_logo', mode: 'apply', limit: 1, id: brand.id },
      db,
    );
    expect(first.entries[0]?.outcome).toBe('applied');
    const fake = present(oxyFiles.current, 'Oxy fake');
    const appFile = fake.fileIdFor('app', present(resolveMedia(operatorFile), 'public URL'));
    expect(fake.imports.map((entry) => entry.owner)).toEqual(['app']);
    const [after] = await db.select().from(brands).where(eq(brands.id, brand.id));
    expect(after?.logoFileId).toBe(appFile);
  });

  it('reports an import Oxy answers with the file the row already holds as unchanged', async () => {
    const brand = await createBrand({ name: `App Media Unchanged ${RUN}` });
    const fake = present(oxyFiles.current, 'Oxy fake');
    // Oxy deduplicates an application's bytes per owner, so adopting a file the
    // application already owns answers that same file.
    const held = fake.fileIdFor('app', present(resolveMedia(`already-app-${RUN}`), 'public URL'));
    await db.update(brands).set({ logoFileId: held }).where(eq(brands.id, brand.id));
    const original = fake.client.assets.importAppFile;
    fake.client.assets.importAppFile = async () => ({
      file: { id: held, mime: 'image/png', size: 10, visibility: 'public', status: 'active' },
      outcome: 'existing',
      deduplicated: true,
    });
    try {
      const report = await backfillApplicationMedia(
        { target: 'brand_logo', mode: 'apply', limit: 1, id: brand.id },
        db,
      );
      expect(report.entries[0]?.outcome).toBe('unchanged');
      expect(report.retryIds).toEqual([]);
    } finally {
      fake.client.assets.importAppFile = original;
    }
  });

  it('imports legacy category art from its supplier URL and leaves the URL as provenance', async () => {
    const legacy = `https://images.example.test/${RUN}.jpg`;
    const category = await insertCategory({
      key: `app-media-${RUN}`,
      name: `App Media ${RUN}`,
      slug: `app-media-${RUN}`,
      imageUrl: legacy,
    });
    const report = await backfillApplicationMedia(
      { target: 'category_image', mode: 'apply', limit: 1, id: category.id },
      db,
    );
    expect(report.entries[0]).toMatchObject({ plan: 'import', outcome: 'applied' });
    const [after] = await db.select().from(categories).where(eq(categories.id, category.id));
    expect(after?.imageFileId).toBe(present(oxyFiles.current, 'Oxy fake').fileIdFor('app', legacy));
    expect(after?.imageUrl).toBe(legacy);
  });

  it('refuses to overwrite an edit made while the import was in flight', async () => {
    const brand = await createBrand({ name: `App Media Race ${RUN}` });
    await db
      .update(brands)
      .set({ logoFileId: `race-before-${RUN}` })
      .where(eq(brands.id, brand.id));
    const client = present(oxyFiles.current, 'Oxy fake').client;
    const original = client.assets.importAppFile;
    client.assets.importAppFile = async (sourceUrl, options) => {
      await db
        .update(brands)
        .set({ logoFileId: `race-edit-${RUN}` })
        .where(eq(brands.id, brand.id));
      return original(sourceUrl, options);
    };
    try {
      const report = await backfillApplicationMedia(
        { target: 'brand_logo', mode: 'apply', limit: 1, id: brand.id },
        db,
      );
      expect(report.entries[0]?.outcome).toBe('changed');
      expect(report.retryIds).toEqual([brand.id]);
      const [after] = await db.select().from(brands).where(eq(brands.id, brand.id));
      expect(after?.logoFileId).toBe(`race-edit-${RUN}`);
    } finally {
      client.assets.importAppFile = original;
    }
  });

  it('re-owns the images of a canonical description, rewriting only those <img> sources', async () => {
    const operatorFile = `operator-description-${RUN}`;
    const description = `<p>Size chart</p><img src="https://cloud.oxy.so/${operatorFile}" alt="chart">`;
    const productId = await mintProduct('description', description);
    const preview = await backfillCanonicalDescriptionImages(
      { mode: 'preview', limit: 1, id: productId },
      db,
    );
    expect(preview.entries).toEqual([
      { id: productId, images: [expect.stringMatching(/^[a-f0-9]{64}$/)], outcome: 'pending' },
    ]);
    const applied = await backfillCanonicalDescriptionImages(
      { mode: 'apply', limit: 1, id: productId },
      db,
    );
    expect(applied.entries[0]?.outcome).toBe('applied');
    const appFile = present(oxyFiles.current, 'Oxy fake').fileIdFor(
      'app',
      present(resolveMedia(operatorFile), 'public URL'),
    );
    const [row] = await db
      .select({ description: canonicalProducts.description })
      .from(canonicalProducts)
      .where(eq(canonicalProducts.id, productId));
    expect(row?.description).toBe(
      `<p>Size chart</p><img src="https://cloud.oxy.so/${appFile}" alt="chart">`,
    );
  });

  it('collapses rows the old identity bug duplicated onto one survivor', async () => {
    const productId = await mintProduct('duplicates');
    const recordId = await observation('duplicates');
    const sourceUrl = `https://supplier.example.test/${RUN}/dup.jpg`;
    const inserted = await db
      .insert(canonicalImages)
      .values([
        { productId, sourceRecordId: recordId, sourceUrl, fileId: `dup-a-${RUN}`, position: 0 },
        {
          productId,
          sourceRecordId: recordId,
          sourceUrl,
          fileId: `dup-b-${RUN}`,
          position: 1,
          alt: 'Front',
        },
        {
          productId,
          sourceRecordId: recordId,
          sourceUrl: `${sourceUrl}?other`,
          fileId: `keep-${RUN}`,
          position: 2,
        },
      ])
      .returning({ id: canonicalImages.id, fileId: canonicalImages.fileId });
    const pair = [present(inserted[0], 'row').id, present(inserted[1], 'row').id];
    const preview = await backfillCanonicalImageDuplicates({ mode: 'preview', limit: 500 }, db);
    const mine = preview.entries.find((entry) => pair.includes(entry.survivorId));
    if (!mine) throw new Error('fixture: the duplicate group was not found');
    // Both rows are active and hold a file and share a created_at, so the id
    // decides; the other row of the pair is the duplicate.
    const survivor = mine.survivorId;
    expect(mine).toMatchObject({
      duplicateIds: pair.filter((id) => id !== survivor),
      outcome: 'pending',
    });
    expect(JSON.stringify(mine)).not.toContain('supplier.example');
    // Apply scoped to this group: resume from just before the survivor.
    const groups = preview.entries.map((entry) => entry.survivorId).sort();
    const index = groups.indexOf(survivor);
    const applied = await backfillCanonicalImageDuplicates(
      { mode: 'apply', limit: 1, ...(index > 0 ? { after: groups[index - 1] } : {}) },
      db,
    );
    expect(applied.entries[0]).toMatchObject({ survivorId: survivor, outcome: 'applied' });
    const rows = await db
      .select({ id: canonicalImages.id, alt: canonicalImages.alt })
      .from(canonicalImages)
      .where(eq(canonicalImages.productId, productId));
    expect(rows.map((row) => row.id).sort()).toEqual(
      [survivor, present(inserted[2], 'row').id].sort(),
    );
    // The survivor keeps an alt text: its own, or the one only the duplicate had.
    expect(rows.find((row) => row.id === survivor)?.alt).toBe('Front');
  });

  it('queues the imagery of source links made before the trigger, idempotently', async () => {
    const productId = await mintProduct('queue');
    const recordId = await observation('queue', {
      title: 'queue',
      media: [`https://supplier.example.test/${RUN}/queue.jpg`],
    });
    await insertCanonicalProductSourceLink(db, {
      productId,
      sourceRecordId: recordId,
      method: 'connector_declared',
      matchRule: 'test.app-media',
    });
    // The trigger queued it; simulate a link made before 0171 by removing the job.
    await db
      .delete(canonicalSourceMediaImports)
      .where(
        and(
          eq(canonicalSourceMediaImports.canonicalProductId, productId),
          eq(canonicalSourceMediaImports.sourceRecordId, recordId),
        ),
      );
    let after: string | undefined;
    let found: { outcome: string } | undefined;
    for (let page = 0; page < 100 && !found; page += 1) {
      const report = await backfillCanonicalSourceMediaQueue(
        { mode: 'apply', limit: 500, ...(after ? { after } : {}) },
        db,
      );
      found = report.entries.find((entry) => entry.productId === productId);
      if (!report.resumeAfterId) break;
      after = report.resumeAfterId;
    }
    expect(found?.outcome).toBe('queued');
    const queued = await db
      .select()
      .from(canonicalSourceMediaImports)
      .where(eq(canonicalSourceMediaImports.canonicalProductId, productId));
    expect(queued).toHaveLength(1);
  });
});
