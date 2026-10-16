/**
 * The application-media backfill (Oxy ADR 0041): category art, brand logos and
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
import type { FakeOxyFiles } from '../../../__tests__/oxy-files-fake.js';

const oxyFiles = vi.hoisted(() => ({ current: undefined as undefined | FakeOxyFiles }));
vi.mock('../../../capabilities/oxy-service-client.js', async () => {
  const { createFakeOxyFiles } = await import('../../../__tests__/oxy-files-fake.js');
  oxyFiles.current = createFakeOxyFiles();
  return { oxyServiceClient: () => oxyFiles.current?.client };
});

const { backfillApplicationMedia } = await import('../application-media-backfill.js');
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
afterAll(async () => {
  await closePostgres();
});
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
});
