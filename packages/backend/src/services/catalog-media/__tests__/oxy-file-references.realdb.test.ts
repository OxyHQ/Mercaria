/**
 * Oxy file usage registration against the REAL schema (Oxy ADR 0041):
 * the triggers of migration 0170, the outbox's revision pair, the ledger diff,
 * the file-event detach and its append-only audit, and the reconciliation's
 * inventory.
 *
 * Only Oxy is replaced (`oxy-files.ts`, the one adapter). Every row, trigger,
 * unique index and CHECK below is the server's, because a mocked insert accepts
 * what the server refuses and has no trigger at all — which is the whole of this
 * design.
 *
 * The database is SHARED with every other realdb file: every claim and every
 * assertion is scoped to entities and file ids this file minted.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { brands } from '../../../db/schema/organizations.js';
import { categories, listingImages, listings } from '../../../db/schema/catalog.js';
import {
  oxyFileEventActions,
  oxyFileEvents,
  oxyFileReferenceOutboxes,
  oxyFileReferences,
} from '../../../db/schema/oxyFiles.js';
import { insertCategory } from '../../../db/taxonomy/taxonomyRepository.js';
import { createBrand } from '../../canonical/brand.service.js';

const oxy = vi.hoisted(() => ({
  add: vi.fn(),
  remove: vi.fn(),
  reconcile: vi.fn(),
}));
vi.mock('../oxy-files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../oxy-files.js')>()),
  addOxyFileReferences: (...args: unknown[]) => oxy.add(...args),
  removeOxyFileReferences: (...args: unknown[]) => oxy.remove(...args),
  reconcileOxyFileReferences: (...args: unknown[]) => oxy.reconcile(...args),
}));

const { convergeEntityReferences, drainFileReferenceOutbox } = await import(
  '../file-reference-outbox.js'
);
const { handleOxyFileEvent } = await import('../file-events.js');
const { reconcileEntityType } = await import('../file-reference-reconciliation.js');
const { completeFileReferenceOutbox, claimFileReferenceOutbox, requestFileReferenceConvergence } =
  await import('../../../db/oxyFiles/referenceOutboxRepository.js');

const RUN = uuidv7().slice(-12).replaceAll('-', '');
let db: Database;

/** A value the test just arranged to exist; a missing one is a fixture failure. */
function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`fixture: no ${what}`);
  return value;
}

function fileId(label: string): string {
  return `test-${label}-${RUN}`;
}

async function outboxRows(entityType: string, entityIds: readonly string[]) {
  return db
    .select()
    .from(oxyFileReferenceOutboxes)
    .where(
      and(
        eq(oxyFileReferenceOutboxes.entityType, entityType as 'brand_logo'),
        inArray(oxyFileReferenceOutboxes.entityId, [...entityIds]),
      ),
    );
}

async function ledger(entityType: string, entityIds: readonly string[]) {
  return db
    .select({
      entityId: oxyFileReferences.entityId,
      fileId: oxyFileReferences.fileId,
      state: oxyFileReferences.state,
    })
    .from(oxyFileReferences)
    .where(
      and(
        eq(oxyFileReferences.entityType, entityType as 'brand_logo'),
        inArray(oxyFileReferences.entityId, [...entityIds]),
      ),
    );
}

async function mintBrand(label: string, logo: string | null): Promise<string> {
  const brand = await createBrand({ name: `Oxy Files ${label} ${RUN}` });
  if (logo !== null)
    await db.update(brands).set({ logoFileId: logo }).where(eq(brands.id, brand.id));
  return brand.id;
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

const listingIds: string[] = [];
afterAll(async () => {
  if (listingIds.length) await db.delete(listings).where(inArray(listings.id, listingIds));
  await closePostgres();
});

beforeEach(() => {
  oxy.add.mockReset().mockImplementation(async (refs: { fileId: string }[]) =>
    refs.map((ref) => ({
      ...ref,
      result: ref.fileId.includes('refused') ? 'not_found' : 'created',
    })),
  );
  oxy.remove
    .mockReset()
    .mockImplementation(async (refs: object[]) =>
      refs.map((ref) => ({ ...ref, result: 'removed' })),
    );
  oxy.reconcile.mockReset();
});

describe('the triggers enqueue the ENTITY on every write that changes a held file', () => {
  it('insert, change, no-op update and clear each do what they should', async () => {
    const brandId = await mintBrand('trigger', null);
    // A brand with no logo holds nothing: no request.
    expect(await outboxRows('brand_logo', [brandId])).toHaveLength(0);

    await db
      .update(brands)
      .set({ logoFileId: fileId('a') })
      .where(eq(brands.id, brandId));
    const [first] = await outboxRows('brand_logo', [brandId]);
    expect(first?.status).toBe('pending');
    expect(first?.requestedRevision).toBe(1);

    // An update that does not touch the watched column enqueues nothing more.
    await db.update(brands).set({ description: 'unrelated' }).where(eq(brands.id, brandId));
    expect((await outboxRows('brand_logo', [brandId]))[0]?.requestedRevision).toBe(1);

    // A change bumps the SAME row's revision: one convergence owed, not two.
    await db
      .update(brands)
      .set({ logoFileId: fileId('b') })
      .where(eq(brands.id, brandId));
    await db.update(brands).set({ logoFileId: null }).where(eq(brands.id, brandId));
    const rows = await outboxRows('brand_logo', [brandId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestedRevision).toBe(3);
  });

  it('a rolled-back write leaves no request behind', async () => {
    const brandId = await mintBrand('rollback', null);
    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(brands)
          .set({ logoFileId: fileId('rb') })
          .where(eq(brands.id, brandId));
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await outboxRows('brand_logo', [brandId])).toHaveLength(0);
  });

  it('category art enqueues for the id column and for a legacy URL', async () => {
    const category = await insertCategory({
      key: `oxy-files-${RUN}`,
      name: `Oxy Files ${RUN}`,
      slug: `oxy-files-${RUN}`,
      imageUrl: 'https://images.example.test/legacy.jpg',
    });
    expect(await outboxRows('category_image', [category.id])).toHaveLength(1);
    await db.delete(categories).where(eq(categories.id, category.id));
    expect((await outboxRows('category_image', [category.id]))[0]?.requestedRevision).toBe(2);
  });
});

describe('convergence diffs what an entity holds against what Oxy acknowledged', () => {
  it('adds, records refusals, removes, and is a no-op the second time', async () => {
    const kept = await mintBrand('kept', fileId('kept'));
    const refused = await mintBrand('refused', fileId('refused'));
    expect(await convergeEntityReferences('brand_logo', [kept, refused])).toEqual({
      added: 1,
      removed: 0,
      refused: 1,
    });
    expect(oxy.add).toHaveBeenCalledTimes(1);
    expect(
      (await ledger('brand_logo', [kept, refused])).sort((a, b) =>
        a.fileId.localeCompare(b.fileId),
      ),
    ).toEqual([
      { entityId: kept, fileId: fileId('kept'), state: 'registered' },
      { entityId: refused, fileId: fileId('refused'), state: 'refused' },
    ]);

    // Nothing changed: nothing is sent.
    await convergeEntityReferences('brand_logo', [kept, refused]);
    expect(oxy.add).toHaveBeenCalledTimes(1);
    expect(oxy.remove).not.toHaveBeenCalled();

    // Replace one logo, clear the other.
    await db
      .update(brands)
      .set({ logoFileId: fileId('kept2') })
      .where(eq(brands.id, kept));
    await db.update(brands).set({ logoFileId: null }).where(eq(brands.id, refused));
    expect(await convergeEntityReferences('brand_logo', [kept, refused])).toEqual({
      added: 1,
      removed: 1,
      refused: 0,
    });
    // The refused pair is forgotten without telling Oxy: it never held it.
    expect(oxy.remove).toHaveBeenCalledExactlyOnceWith([
      { entityType: 'brand_logo', entityId: kept, fileId: fileId('kept') },
    ]);
    expect(await ledger('brand_logo', [kept, refused])).toEqual([
      { entityId: kept, fileId: fileId('kept2'), state: 'registered' },
    ]);
  });

  it('an Oxy failure leaves the ledger and the request where they were', async () => {
    const brandId = await mintBrand('failure', fileId('failure'));
    oxy.add.mockRejectedValueOnce(new Error('Oxy could not register file references.'));
    const owner = `test-owner-${RUN}-failure`;
    const result = await drainFileReferenceOutbox({
      leaseOwner: owner,
      batchSize: 10,
      maxAttempts: 3,
      only: { entityType: 'brand_logo', entityIds: [brandId] },
    });
    expect(result).toEqual({ converged: 0, failed: 1 });
    expect(await ledger('brand_logo', [brandId])).toEqual([]);
    const [row] = await outboxRows('brand_logo', [brandId]);
    expect(row?.status).toBe('pending');
    expect(row?.lastError).toMatch(/Oxy could not register/);
    expect(row?.availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('a converged job is DELETED, but a write during the run re-arms it', async () => {
    const brandId = await mintBrand('race', fileId('race'));
    const owner = `test-owner-${RUN}-race`;
    const claimed = await claimFileReferenceOutbox({
      leaseOwner: owner,
      batchSize: 10,
      only: { entityType: 'brand_logo', entityIds: [brandId] },
    });
    expect(claimed).toHaveLength(1);
    // A request lands mid-run: the processing row stays processing.
    await requestFileReferenceConvergence('brand_logo', brandId, db);
    expect((await outboxRows('brand_logo', [brandId]))[0]?.status).toBe('processing');
    expect(await completeFileReferenceOutbox(present(claimed[0], 'claim').id, owner)).toBe(true);
    const [rearmed] = await outboxRows('brand_logo', [brandId]);
    expect(rearmed?.status).toBe('pending');

    const result = await drainFileReferenceOutbox({
      leaseOwner: owner,
      batchSize: 10,
      maxAttempts: 3,
      only: { entityType: 'brand_logo', entityIds: [brandId] },
    });
    expect(result).toEqual({ converged: 1, failed: 0 });
    expect(await outboxRows('brand_logo', [brandId])).toEqual([]);
    expect(await ledger('brand_logo', [brandId])).toEqual([
      { entityId: brandId, fileId: fileId('race'), state: 'registered' },
    ]);
  });
});

describe('a blocked file leaves every page that showed it, with an audit', () => {
  it('clears the brand logo and the category art, and records both', async () => {
    const blocked = fileId('blocked');
    const brandId = await mintBrand('blocked', blocked);
    const category = await insertCategory({
      key: `oxy-files-blocked-${RUN}`,
      name: `Oxy Files Blocked ${RUN}`,
      slug: `oxy-files-blocked-${RUN}`,
      imageFileId: blocked,
    });
    const eventId = `evt-${RUN}-blocked`;
    const result = await handleOxyFileEvent({
      id: eventId,
      type: 'file.blocked',
      fileId: blocked,
      occurredAt: new Date(),
    });
    expect(result.duplicate).toBe(false);
    expect(result.actions).toEqual(
      expect.arrayContaining([
        { entityType: 'brand_logo', entityId: brandId, action: 'removed' },
        { entityType: 'category_image', entityId: category.id, action: 'removed' },
      ]),
    );
    const [brand] = await db.select().from(brands).where(eq(brands.id, brandId));
    expect(brand?.logoFileId).toBeNull();
    const [after] = await db.select().from(categories).where(eq(categories.id, category.id));
    expect(after?.imageFileId).toBeNull();
    // The removal itself asks for the references to be withdrawn.
    expect(await outboxRows('brand_logo', [brandId])).toHaveLength(1);

    // A redelivery is a duplicate and does nothing.
    expect(
      await handleOxyFileEvent({
        id: eventId,
        type: 'file.blocked',
        fileId: blocked,
        occurredAt: undefined,
      }),
    ).toEqual({ duplicate: true, actions: [] });
    const audit = await db
      .select({ entityType: oxyFileEventActions.entityType, action: oxyFileEventActions.action })
      .from(oxyFileEventActions)
      .innerJoin(oxyFileEvents, eq(oxyFileEvents.id, oxyFileEventActions.oxyFileEventId))
      .where(eq(oxyFileEvents.eventId, eventId));
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('removes the gallery image and the description <img>, and enqueues both withdrawals', async () => {
    const blocked = fileId('gallery');
    const kept = fileId('gallery-kept');
    const [inserted] = await db
      .insert(listings)
      .values({
        ownerType: 'user',
        oxyUserId: `seller-${RUN}`,
        title: 'Takedown fixture',
        description: `<p>Size</p><img src="https://cloud.oxy.so/${blocked}"><img src="https://cloud.oxy.so/${kept}">`,
        condition: 'used_good',
        conditionAssertion: 'seller_declared',
        status: 'active',
      })
      .returning();
    const listing = present(inserted, 'listing');
    listingIds.push(listing.id);
    await db.insert(listingImages).values([
      { listingId: listing.id, fileId: blocked, position: 0 },
      { listingId: listing.id, fileId: kept, position: 1 },
    ]);
    // Both writes asked for their entity's references to converge.
    expect(await outboxRows('listing_image', [listing.id])).toHaveLength(1);
    expect(await outboxRows('listing_description_image', [listing.id])).toHaveLength(1);
    const before = present(
      (await outboxRows('listing_image', [listing.id]))[0],
      'request',
    ).requestedRevision;

    const result = await handleOxyFileEvent({
      id: `evt-${RUN}-gallery`,
      type: 'file.deleted',
      fileId: blocked,
      occurredAt: undefined,
    });
    expect(result.actions).toEqual(
      expect.arrayContaining([
        { entityType: 'listing_image', entityId: listing.id, action: 'removed' },
        { entityType: 'listing_description_image', entityId: listing.id, action: 'removed' },
      ]),
    );
    const gallery = await db
      .select({ fileId: listingImages.fileId })
      .from(listingImages)
      .where(eq(listingImages.listingId, listing.id));
    expect(gallery).toEqual([{ fileId: kept }]);
    const [after] = await db.select().from(listings).where(eq(listings.id, listing.id));
    expect(after?.description).not.toContain(blocked);
    expect(after?.description).toContain(kept);
    expect(
      present((await outboxRows('listing_image', [listing.id]))[0], 'request').requestedRevision,
    ).toBeGreaterThan(before);
  });

  it('records a non-detaching event and changes nothing', async () => {
    const trashed = fileId('trashed');
    const brandId = await mintBrand('trashed', trashed);
    const result = await handleOxyFileEvent({
      id: `evt-${RUN}-trashed`,
      type: 'file.trashed',
      fileId: trashed,
      occurredAt: undefined,
    });
    expect(result).toEqual({ duplicate: false, actions: [] });
    const [brand] = await db.select().from(brands).where(eq(brands.id, brandId));
    expect(brand?.logoFileId).toBe(trashed);
  });

  it('the audit is append-only', async () => {
    const refusal = async (statement: ReturnType<typeof sql>) => {
      const error = await db.execute(statement).then(
        () => undefined,
        (caught: unknown) => caught as { cause?: { message?: string } },
      );
      return String(error?.cause?.message ?? '');
    };
    const eventId = `evt-${RUN}-trashed`;
    expect(
      await refusal(sql`update oxy_file_events set file_id = file_id where event_id = ${eventId}`),
    ).toMatch(/append-only/);
    expect(await refusal(sql`delete from oxy_file_events where event_id = ${eventId}`)).toMatch(
      /append-only/,
    );
    // Positive control: the row is there, so the refusals were about IT.
    expect(
      await db.select().from(oxyFileEvents).where(eq(oxyFileEvents.eventId, eventId)),
    ).toHaveLength(1);
  });
});

describe('reconciliation sends the whole inventory of a type', () => {
  it('streams every pair the rows hold, and a dry run writes no ledger', async () => {
    const brandId = await mintBrand('inventory', fileId('inventory'));
    let received: { fileId: string; entityId: string }[] = [];
    oxy.reconcile.mockImplementation(
      async (_type: string, items: AsyncIterable<{ fileId: string; entityId: string }>) => {
        received = [];
        for await (const item of items) received.push(item);
        return {
          sessionId: 's',
          entityType: 'brand_logo',
          dryRun: true,
          added: 1,
          removed: 0,
          unchanged: 0,
          refused: 0,
        };
      },
    );
    const outcome = await reconcileEntityType('brand_logo', { dryRun: true });
    expect(received).toContainEqual({ fileId: fileId('inventory'), entityId: brandId });
    // Brands with no logo are not in the inventory.
    expect(received.every((item) => item.fileId.length > 0)).toBe(true);
    expect(outcome.inventory).toBeGreaterThanOrEqual(1);
    expect(outcome.dryRun).toBe(true);
    expect(await ledger('brand_logo', [brandId])).toEqual([]);
  });
});
