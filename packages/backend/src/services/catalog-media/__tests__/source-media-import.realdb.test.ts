/**
 * External imagery copied into the canonical catalogue (Oxy ADR 0041): an
 * observation attached to a canonical product queues its stored `payload.media`
 * (migration 0170's source-link trigger), and the bounded dispatcher imports it
 * as Mercaria-application files into `canonical_images` — with the observation
 * as provenance, deduplicated by source URL, inside the caps.
 *
 * Only Oxy is replaced, at the SDK boundary (`__tests__/oxy-files-fake.ts`).
 * Every claim is scoped to this file's own products (`onlyProductIds`): the
 * database and the queue are shared with every realdb file, and ingestion tests
 * queue jobs of their own through the same trigger.
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { canonicalImages } from '../../../db/schema/canonicalCatalog.js';
import { canonicalSourceMediaImports } from '../../../db/schema/canonicalSourceMedia.js';
import {
  ensureCatalogSource,
  recordSourceObservation,
} from '../../../db/canonical/provenanceRepository.js';
import { insertCanonicalProductSourceLink } from '../../../db/canonical/canonicalProductRepository.js';
import { loadPrimaryProductImages } from '../../../db/search/searchCandidateRepository.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';
import { createCanonicalProduct } from '../../canonical/canonical-product.service.js';
import type { FakeOxyFiles } from '../../../__tests__/oxy-files-fake.js';

const oxyFiles = vi.hoisted(() => ({ current: undefined as undefined | FakeOxyFiles }));
vi.mock('../../../capabilities/oxy-service-client.js', async () => {
  const { createFakeOxyFiles } = await import('../../../__tests__/oxy-files-fake.js');
  oxyFiles.current = createFakeOxyFiles();
  return { oxyServiceClient: () => oxyFiles.current?.client };
});

const { drainCanonicalSourceMediaImports } = await import('../source-media-import.js');

const RUN = uuidv7().slice(-12);
let db: Database;
let sourceId = '';
const productIds: string[] = [];

function fake(): FakeOxyFiles {
  const current = oxyFiles.current;
  if (!current) throw new Error('fixture: no Oxy fake');
  return current;
}

async function mintProduct(label: string): Promise<string> {
  const product = await createCanonicalProduct({ name: `Source media ${label} ${RUN}` });
  productIds.push(product.id);
  return product.id;
}

async function observe(label: string, media: unknown[] | undefined): Promise<string> {
  const { record } = await recordSourceObservation(db, {
    sourceId,
    externalType: 'product',
    externalId: `source-media-${label}-${RUN}`,
    observedAt: new Date(),
    contentHash: createHash('sha256').update(`${label}-${RUN}`).digest('hex'),
    ...(media === undefined ? {} : { payload: { title: label, media } }),
  });
  return record.id;
}

async function attach(productId: string, sourceRecordId: string): Promise<void> {
  await insertCanonicalProductSourceLink(db, {
    productId,
    sourceRecordId,
    method: 'connector_declared',
    matchRule: 'test.source-media',
  });
}

async function jobs(productId: string) {
  return db
    .select()
    .from(canonicalSourceMediaImports)
    .where(eq(canonicalSourceMediaImports.canonicalProductId, productId));
}

async function images(productId: string) {
  return db
    .select({
      fileId: canonicalImages.fileId,
      sourceUrl: canonicalImages.sourceUrl,
      sourceRecordId: canonicalImages.sourceRecordId,
      position: canonicalImages.position,
    })
    .from(canonicalImages)
    .where(and(eq(canonicalImages.productId, productId), eq(canonicalImages.status, 'active')))
    .orderBy(canonicalImages.position);
}

function drain(only: string[], limits = { maxPerRecord: 6, maxPerProduct: 10 }) {
  return drainCanonicalSourceMediaImports({
    leaseOwner: `test-${RUN}`,
    batchSize: 10,
    maxInFlight: 50,
    maxAttempts: 3,
    limits,
    onlyProductIds: only,
  });
}

beforeAll(async () => {
  db = await connectPostgres();
  const source = await ensureCatalogSource(db, {
    kind: 'feed',
    name: `source-media-${RUN}`,
    // The owner copies regardless of the rights flags; they stay provenance.
    mayDisplay: false,
    mayStore: true,
    attributionRequired: false,
  });
  sourceId = source.id;
}, 120_000);

afterAll(async () => {
  await deleteTestCanonicalRows(db, { productIds });
  await closePostgres();
});

beforeEach(() => fake().reset());

describe('attaching an observation queues its imagery', () => {
  it('queues exactly when the stored payload names media', async () => {
    const productId = await mintProduct('queue');
    await attach(productId, await observe('no-media', undefined));
    await attach(productId, await observe('empty-media', []));
    expect(await jobs(productId)).toHaveLength(0);
    const withMedia = await observe('with-media', [`https://cdn.example.test/${RUN}/a.jpg`]);
    await attach(productId, withMedia);
    const queued = await jobs(productId);
    expect(queued.map((job) => job.sourceRecordId)).toEqual([withMedia]);
    expect(queued[0]?.status).toBe('pending');
  });
});

describe('the dispatcher copies imagery as application files, deduplicated and capped', () => {
  it('imports each HTTPS reference once, with the observation as provenance, and search shows it', async () => {
    const productId = await mintProduct('import');
    const a = `https://cdn.example.test/${RUN}/import-a.jpg`;
    const b = `https://cdn.example.test/${RUN}/import-b.jpg`;
    const first = await observe('import-1', [
      a,
      b,
      'provider-id-not-a-url',
      `http://${RUN}.test/x.jpg`,
    ]);
    await attach(productId, first);
    expect(await drain([productId])).toMatchObject({ completed: 1, failed: 0, attached: 2 });
    // Owned by the APPLICATION, never an account.
    expect(fake().imports.map((entry) => entry.owner)).toEqual(['app', 'app']);
    expect(await images(productId)).toEqual([
      { fileId: fake().fileIdFor('app', a), sourceUrl: a, sourceRecordId: first, position: 0 },
      { fileId: fake().fileIdFor('app', b), sourceUrl: b, sourceRecordId: first, position: 1 },
    ]);
    // A finished job is deleted.
    expect(await jobs(productId)).toHaveLength(0);
    // The product card / search projection reads the imported file.
    expect(await loadPrimaryProductImages(db, [productId])).toEqual([
      { productId, fileId: fake().fileIdFor('app', a), alt: null },
    ]);

    // A second offer of the same product naming a held URL imports nothing new.
    const second = await observe('import-2', [b]);
    await attach(productId, second);
    fake().reset();
    expect(await drain([productId])).toMatchObject({ completed: 1, attached: 0 });
    expect(fake().imports).toEqual([]);
    expect(await images(productId)).toHaveLength(2);
  });

  it('stops at the per-record and per-product caps', async () => {
    const productId = await mintProduct('caps');
    const urls = Array.from(
      { length: 5 },
      (_, index) => `https://cdn.example.test/${RUN}/cap-${index}.jpg`,
    );
    await attach(productId, await observe('caps-1', urls));
    await drain([productId], { maxPerRecord: 3, maxPerProduct: 10 });
    expect(await images(productId)).toHaveLength(3);
    await attach(
      productId,
      await observe('caps-2', [
        `https://cdn.example.test/${RUN}/cap-x.jpg`,
        `https://cdn.example.test/${RUN}/cap-y.jpg`,
      ]),
    );
    fake().reset();
    await drain([productId], { maxPerRecord: 3, maxPerProduct: 4 });
    expect(await images(productId)).toHaveLength(4);
    // The product is full: a further offer costs no Oxy call at all.
    await attach(productId, await observe('caps-3', [`https://cdn.example.test/${RUN}/cap-z.jpg`]));
    fake().reset();
    await drain([productId], { maxPerRecord: 3, maxPerProduct: 4 });
    expect(fake().imports.filter((entry) => entry.sourceUrl.endsWith('cap-z.jpg'))).toEqual([]);
  });

  it('skips a source Oxy refuses for good, and retries a job Oxy could not answer', async () => {
    const productId = await mintProduct('refusals');
    const refused = `https://cdn.example.test/${RUN}/refused.jpg`;
    const kept = `https://cdn.example.test/${RUN}/kept.jpg`;
    await attach(productId, await observe('refusals-1', [refused, kept]));
    fake().failNext(415);
    expect(await drain([productId])).toMatchObject({ completed: 1, attached: 1 });
    expect((await images(productId)).map((image) => image.sourceUrl)).toEqual([kept]);

    const transient = `https://cdn.example.test/${RUN}/transient.jpg`;
    await attach(productId, await observe('refusals-2', [transient]));
    fake().failNext(503);
    expect(await drain([productId])).toMatchObject({ completed: 0, failed: 1 });
    const [job] = await jobs(productId);
    expect(job?.status).toBe('pending');
    expect(job?.lastError).toMatch(/HTTP 503/);
    expect(job?.availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('holds the global in-flight cap', async () => {
    const productId = await mintProduct('in-flight');
    await attach(productId, await observe('in-flight', [`https://cdn.example.test/${RUN}/f.jpg`]));
    const none = await drainCanonicalSourceMediaImports({
      leaseOwner: `test-${RUN}`,
      batchSize: 10,
      maxInFlight: 0,
      maxAttempts: 3,
      limits: { maxPerRecord: 6, maxPerProduct: 10 },
      onlyProductIds: [productId],
    });
    expect(none).toEqual({ completed: 0, failed: 0, attached: 0 });
    expect((await jobs(productId))[0]?.status).toBe('pending');
    expect(
      await db
        .select()
        .from(canonicalImages)
        .where(inArray(canonicalImages.productId, [productId])),
    ).toHaveLength(0);
  });
});
