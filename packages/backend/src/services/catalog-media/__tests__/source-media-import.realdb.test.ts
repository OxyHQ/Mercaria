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
import {
  claimCanonicalSourceMediaImports,
  releaseCanonicalSourceMediaImport,
  requestCanonicalSourceMediaImport,
} from '../../../db/canonical/sourceMediaImportRepository.js';
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

describe('what is queued, and in what order', () => {
  it('queues nothing for an observation whose images the product already holds', async () => {
    const productId = await mintProduct('held');
    const url = `https://cdn.example.test/${RUN}/held.jpg`;
    await attach(productId, await observe('held-first', [url]));
    await drain([productId]);
    expect(await images(productId)).toHaveLength(1);

    // Ingestion re-observes the offer: a new record, a new link, the same image.
    await attach(productId, await observe('held-again', [url]));
    expect(await jobs(productId)).toHaveLength(0);

    // A new image in the next observation is queued.
    await attach(
      productId,
      await observe('held-new', [url, `https://cdn.example.test/${RUN}/held-2.jpg`]),
    );
    expect(await jobs(productId)).toHaveLength(1);
  });

  it('queues a product that shows no image at priority 0 and drains it first', async () => {
    const shown = await mintProduct('priority-shown');
    await attach(
      shown,
      await observe('priority-shown-a', [`https://cdn.example.test/${RUN}/s-a.jpg`]),
    );
    await drain([shown]);
    expect(await images(shown)).toHaveLength(1);
    // Queued FIRST: the product already shows an image.
    await attach(
      shown,
      await observe('priority-shown-b', [`https://cdn.example.test/${RUN}/s-b.jpg`]),
    );
    const blank = await mintProduct('priority-blank');
    await attach(
      blank,
      await observe('priority-blank-a', [`https://cdn.example.test/${RUN}/b-a.jpg`]),
    );

    expect((await jobs(shown))[0]?.priority).toBe(1);
    expect((await jobs(blank))[0]?.priority).toBe(0);

    const claimed = await claimCanonicalSourceMediaImports({
      leaseOwner: `test-${RUN}`,
      batchSize: 1,
      maxInFlight: 50,
      onlyProductIds: [shown, blank],
    });
    expect(claimed.map((job) => job.canonicalProductId)).toEqual([blank]);
    const [first] = claimed;
    if (!first) throw new Error('fixture: nothing claimed');
    await releaseCanonicalSourceMediaImport({
      id: first.id,
      leaseOwner: `test-${RUN}`,
      deadLettered: false,
      refundAttempt: true,
      availableAt: new Date(0),
      error: 'test: released',
      now: new Date(),
    });
  });

  it('the backfill queues nothing for an observation whose images the product holds', async () => {
    const productId = await mintProduct('backfill-held');
    const url = `https://cdn.example.test/${RUN}/bh.jpg`;
    await attach(productId, await observe('backfill-held-a', [url]));
    await drain([productId]);
    const again = await observe('backfill-held-b', [url]);
    expect(await requestCanonicalSourceMediaImport(productId, again, db)).toBe(false);
    expect(await jobs(productId)).toHaveLength(0);
  });

  it('the backfill queues at the same priority', async () => {
    const blank = await mintProduct('priority-backfill');
    const record = await observe('priority-backfill-a', [`https://cdn.example.test/${RUN}/pb.jpg`]);
    expect(await requestCanonicalSourceMediaImport(blank, record, db)).toBe(true);
    expect((await jobs(blank))[0]?.priority).toBe(0);
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

    // A second offer of the same product naming a held URL queues nothing
    // (migration 0176), so nothing is drained and nothing is imported.
    const second = await observe('import-2', [b]);
    await attach(productId, second);
    fake().reset();
    expect(await jobs(productId)).toHaveLength(0);
    expect(await drain([productId])).toMatchObject({ completed: 0, attached: 0 });
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

  it('asks Oxy for a whole drain in ONE request, and DEFERS it when Oxy rate-limits that request', async () => {
    const one = await mintProduct('batched-1');
    const two = await mintProduct('batched-2');
    const urls = (label: string) =>
      [0, 1].map((index) => `https://cdn.example.test/${RUN}/${label}-${index}.jpg`);
    await attach(one, await observe('batched-1', urls('batched-1')));
    await attach(two, await observe('batched-2', urls('batched-2')));
    // Oxy's budget is spent for an hour — longer than the adapter's own
    // two-minute bound, so it hands the 429 back at once.
    fake().failNextRequest(429, { retryAfterSeconds: 3600 });
    const startedAt = Date.now();
    expect(await drain([one, two])).toEqual({
      completed: 0,
      failed: 0,
      deferred: 2,
      attached: 0,
    });
    expect(fake().requests).toBe(1);
    for (const productId of [one, two]) {
      const [job] = await jobs(productId);
      expect(job?.status).toBe('pending');
      // Deferred, not failed: the claim's attempt is given back.
      expect(job?.attempts).toBe(0);
      expect(job?.lastError).toMatch(/budget/);
      expect(job?.availableAt.getTime()).toBeGreaterThanOrEqual(startedAt + 3_599_000);
    }
    // Once the budget is back, both jobs' four images come in one request.
    await db
      .update(canonicalSourceMediaImports)
      .set({ availableAt: new Date(Date.now() - 1_000) })
      .where(inArray(canonicalSourceMediaImports.canonicalProductId, [one, two]));
    fake().reset();
    expect(await drain([one, two])).toEqual({
      completed: 2,
      failed: 0,
      deferred: 0,
      attached: 4,
    });
    expect(fake().requests).toBe(1);
    expect(fake().imports).toHaveLength(4);
  });

  it('keeps what Oxy stored when one source fails transiently, and retries only that one', async () => {
    const productId = await mintProduct('partial');
    const [flaky, fine] = ['flaky', 'fine'].map(
      (label) => `https://cdn.example.test/${RUN}/partial-${label}.jpg`,
    );
    await attach(productId, await observe('partial', [flaky, fine]));
    fake().failNext(503);
    expect(await drain([productId])).toMatchObject({ completed: 0, failed: 1, attached: 1 });
    expect((await images(productId)).map((image) => image.sourceUrl)).toEqual([fine]);
    const [job] = await jobs(productId);
    // A real failure: the attempt counts, and the backoff holds it.
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toMatch(/HTTP 503/);
    await db
      .update(canonicalSourceMediaImports)
      .set({ availableAt: new Date(Date.now() - 1_000) })
      .where(eq(canonicalSourceMediaImports.canonicalProductId, productId));
    fake().reset();
    expect(await drain([productId])).toMatchObject({ completed: 1, attached: 1 });
    expect(fake().imports.map((entry) => entry.sourceUrl)).toEqual([flaky]);
  });

  it('paces a task by REQUESTS, deferring the sources past it', async () => {
    const productId = await mintProduct('paced');
    const urls = Array.from(
      { length: 55 },
      (_, index) => `https://cdn.example.test/${RUN}/paced-${index}.jpg`,
    );
    await attach(productId, await observe('paced', urls));
    const limits = { maxPerRecord: 60, maxPerProduct: 100 };
    let clock = Date.now();
    const pacer = new SourceMediaImportPacer(1, () => clock);
    const startedAt = Date.now();
    // 55 sources need two requests of up to 50; the pace allows one a minute.
    expect(await drain([productId], limits, pacer)).toEqual({
      completed: 0,
      failed: 0,
      deferred: 1,
      attached: 50,
    });
    expect(fake().requests).toBe(1);
    const [job] = await jobs(productId);
    expect(job?.attempts).toBe(0);
    // Back when the minute's request leaves the window.
    expect(job?.availableAt.getTime()).toBeGreaterThanOrEqual(startedAt + 55_000);
    clock += 60_000;
    await db
      .update(canonicalSourceMediaImports)
      .set({ availableAt: new Date(Date.now() - 1_000) })
      .where(eq(canonicalSourceMediaImports.canonicalProductId, productId));
    expect(await drain([productId], limits, pacer)).toMatchObject({ completed: 1, attached: 5 });
    expect(fake().requests).toBe(2);
    expect(await images(productId)).toHaveLength(55);
  });

  it('claims a freshly queued job however far the database clock runs ahead of the task', async () => {
    const productId = await mintProduct('skew');
    await attach(productId, await observe('skew', [`https://cdn.example.test/${RUN}/skew.jpg`]));
    // The trigger stamped `available_at` with the database's now(); a task ten
    // minutes behind it must still find the job due.
    const behind = new Date(Date.now() - 10 * 60_000);
    const result = await drainCanonicalSourceMediaImports({
      leaseOwner: `test-${RUN}`,
      batchSize: 10,
      maxInFlight: 50,
      maxAttempts: 3,
      limits: { maxPerRecord: 6, maxPerProduct: 10 },
      onlyProductIds: [productId],
      now: () => behind,
    });
    expect(result).toMatchObject({ completed: 1, attached: 1 });
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
