/**
 * External imagery copied into the canonical catalogue (Oxy ADR 0043): an
 * observation attached to a canonical product queues its stored `payload.media`
 * (migration 0173's source-link trigger), and the bounded dispatcher imports it
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

const { drainCanonicalSourceMediaImports, SourceMediaImportPacer } = await import(
  '../source-media-import.js'
);

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

function drain(
  only: string[],
  limits = { maxPerRecord: 6, maxPerProduct: 10 },
  pacer?: InstanceType<typeof SourceMediaImportPacer>,
) {
  return drainCanonicalSourceMediaImports({
    leaseOwner: `test-${RUN}`,
    batchSize: 10,
    maxInFlight: 50,
    maxAttempts: 3,
    limits,
    onlyProductIds: only,
    ...(pacer === undefined ? {} : { pacer }),
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
    expect(none).toEqual({ completed: 0, failed: 0, deferred: 0, attached: 0 });
    expect((await jobs(productId))[0]?.status).toBe('pending');
    expect(
      await db
        .select()
        .from(canonicalImages)
        .where(inArray(canonicalImages.productId, [productId])),
    ).toHaveLength(0);
  });

  it('DEFERS a job Oxy rate-limits: keeps what it imported, refunds the attempt, holds the batch', async () => {
    const limited = await mintProduct('rate-limited');
    const waiting = await mintProduct('rate-limited-sibling');
    const first = `https://cdn.example.test/${RUN}/limited-1.jpg`;
    const second = `https://cdn.example.test/${RUN}/limited-2.jpg`;
    await attach(limited, await observe('rate-limited', [first, second]));
    await attach(
      waiting,
      await observe('rate-limited-sibling', [`https://cdn.example.test/${RUN}/sibling.jpg`]),
    );
    // The claim takes jobs oldest-available first; pin the order so the limited
    // job runs first and the sibling is the one held behind it.
    for (const [productId, ageMs] of [
      [limited, 10_000],
      [waiting, 5_000],
    ] as const)
      await db
        .update(canonicalSourceMediaImports)
        .set({ availableAt: new Date(Date.now() - ageMs) })
        .where(eq(canonicalSourceMediaImports.canonicalProductId, productId));
    const client = fake().client;
    const original = client.assets.importAppFile;
    let calls = 0;
    // The first import lands; then Oxy's budget is spent for an hour — a wait
    // longer than the adapter's own two minutes, so it gives the 429 back at once.
    client.assets.importAppFile = async (sourceUrl, options) => {
      calls += 1;
      if (calls > 1)
        throw Object.assign(new Error('Too many application file uploads.'), {
          status: 429,
          details: { retryAfterSeconds: 3600 },
        });
      return original(sourceUrl, options);
    };
    try {
      const startedAt = Date.now();
      const result = await drain([limited, waiting]);
      expect(result).toEqual({ completed: 0, failed: 0, deferred: 2, attached: 1 });
      // Never a second call after the refusal: the sibling waits with the batch.
      expect(calls).toBe(2);
      expect((await images(limited)).map((image) => image.sourceUrl)).toEqual([first]);
      for (const productId of [limited, waiting]) {
        const [job] = await jobs(productId);
        expect(job?.status).toBe('pending');
        // Deferred, not failed: the claim's attempt is given back.
        expect(job?.attempts).toBe(0);
        expect(job?.lastError).toMatch(/budget/);
        expect(job?.availableAt.getTime()).toBeGreaterThanOrEqual(startedAt + 3_599_000);
      }
    } finally {
      client.assets.importAppFile = original;
    }
    // Once the budget is back the job finishes, asking Oxy only for the rest.
    await db
      .update(canonicalSourceMediaImports)
      .set({ availableAt: new Date(Date.now() - 1_000) })
      .where(inArray(canonicalSourceMediaImports.canonicalProductId, [limited, waiting]));
    fake().reset();
    expect(await drain([limited, waiting])).toMatchObject({ completed: 2, deferred: 0 });
    expect(fake().imports.map((entry) => entry.sourceUrl)).not.toContain(first);
    expect((await images(limited)).map((image) => image.sourceUrl)).toEqual([first, second]);
  });

  it('paces a task under its share of Oxy’s budget, deferring what is past it', async () => {
    const productId = await mintProduct('paced');
    const urls = [0, 1, 2].map((index) => `https://cdn.example.test/${RUN}/paced-${index}.jpg`);
    await attach(productId, await observe('paced', urls));
    let clock = Date.now();
    const pacer = new SourceMediaImportPacer(2, () => clock);
    const startedAt = Date.now();
    expect(await drain([productId], undefined, pacer)).toEqual({
      completed: 0,
      failed: 0,
      deferred: 1,
      attached: 2,
    });
    expect(fake().imports).toHaveLength(2);
    const [job] = await jobs(productId);
    expect(job?.attempts).toBe(0);
    // Back when the oldest of the minute's imports leaves the window.
    expect(job?.availableAt.getTime()).toBeGreaterThanOrEqual(startedAt + 55_000);
    clock += 60_000;
    await db
      .update(canonicalSourceMediaImports)
      .set({ availableAt: new Date(Date.now() - 1_000) })
      .where(eq(canonicalSourceMediaImports.canonicalProductId, productId));
    expect(await drain([productId], undefined, pacer)).toMatchObject({ completed: 1, attached: 1 });
    expect(await images(productId)).toHaveLength(3);
  });
});

describe('SourceMediaImportPacer', () => {
  it('admits N per rolling minute and names the wait for the next', () => {
    let now = 1_000_000;
    const pacer = new SourceMediaImportPacer(2, () => now);
    expect(pacer.take()).toEqual({ ok: true });
    now += 10_000;
    expect(pacer.take()).toEqual({ ok: true });
    expect(pacer.take()).toEqual({ ok: false, waitMs: 50_000 });
    now += 50_000;
    expect(pacer.take()).toEqual({ ok: true });
    expect(pacer.take()).toEqual({ ok: false, waitMs: 10_000 });
  });
});
