/**
 * The two operator writes that change a selected fact or a mapping now EMIT
 * (#821, #367 "emit reindex/cache invalidation events").
 *
 * ## Why this is a ROUTE test and not a service test
 *
 * The defect was never "the mechanism is wrong". `enqueueAttributeReindex` was
 * correct, tested and in use; what was missing was a CALL. A mechanism can be
 * green and inert, so the only assertion worth making is that the ENTRYPOINT
 * reaches it — and here that is not a formality, because
 * `POST /internal/commerce-graph/attribute-values/:id/select` sits in front of a
 * HOMONYM. There are two exported `selectAttributeValue` functions:
 *
 *  - `services/attributes/attribute-observation.service.ts` — enqueues, and is
 *    reached from the review queue;
 *  - `services/curation/correction.service.ts` — is what this ROUTE calls, and
 *    is the one that emitted nothing.
 *
 * A test that imported "the" service and called it would have had a 50% chance
 * of measuring the wrong function while reporting the route covered. Driving the
 * URL cannot pick the wrong one. The same applies to the mapping route, whose
 * handler previously called the repository directly: a service-level test would
 * stay green if somebody re-pointed the controller back at
 * `upsertAttributeSourceMapping`.
 *
 * ## What makes each assertion non-vacuous
 *
 * Every case reads the reindex table BEFORE the request and asserts the row is
 * ABSENT, then asserts it present after. Without the negative control a row a
 * sibling file wrote — or one this file's earlier case wrote — would satisfy it.
 * Rows are matched on the four COLUMNS rather than on `reindexRequestId`'s
 * output, so a bug in the id derivation cannot make the test agree with itself.
 *
 * `enqueueAttributeReindex` is idempotent on a deterministic id, so calling a
 * route twice and finding one row would measure the id derivation and NOT the
 * call site. Nothing here counts repeats.
 *
 * The fan-out cases additionally assert the fixture is non-empty first: a sweep
 * over an attribute key no entity carries enqueues nothing and passes for the
 * wrong reason.
 *
 * ## What this file deliberately does NOT claim
 *
 * `attribute_reindex_requests` still has no consumer — `processed_at` has
 * readers and no writers, and the schema assigns the drain to #61. These rows
 * are a durable record nothing drains yet, which is the documented state and the
 * reason #367's box stays PARTIAL. Nothing here should be read as evidence that
 * a reindex HAPPENS.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { withTriggerToggleLock } from '../../db/__tests__/trigger-toggle-lock.js';
import type { AttributeReindexReason } from '@mercaria/shared-types';
import type { Database } from '../../db/postgres.js';
import { attributeReindexRequests, attributeSourceMappings } from '../../db/schema/attributeRegistry.js';
import { canonicalAttributeValues } from '../../db/schema/canonicalCatalog.js';
import { catalogRevisions } from '../../db/schema/curation.js';
import { catalogSources, sourceRecords } from '../../db/schema/provenance.js';

/** Unique to this run: the throwaway database is shared across parallel FILES. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '').toLowerCase();
const OPERATOR = `oxy-user-attr-emit-${RUN}`;

/** Both keys are namespaced, so the fan-out can only ever reach this file's rows. */
const KEY_SELECT = `emit_select_${RUN}`;
const KEY_MAPPED = `emit_mapped_${RUN}`;
const KEY_REPOINTED = `emit_repointed_${RUN}`;
const ALL_KEYS = [KEY_SELECT, KEY_MAPPED, KEY_REPOINTED];

const SOURCE_FIELD = `emit_field_${RUN}`;

vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  getRequiredOxyUserId: () => OPERATOR,
}));
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    next();
  },
  oxyClient: {},
  optionalAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    next();
  },
}));
vi.mock('../../lib/rate-limit.js', () => ({
  makeRateLimiter:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
      next();
    },
  makeActorRateLimiter:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
      next();
    },
}));

let db: Database;
let closePostgres: () => Promise<void>;
let server: Server;
let base: string;

let productId = '';
let variantAbsentProductId = '';
let sourceId = '';
let sourceRecordId = '';
/** The `candidate` value the select route promotes. */
let selectableValueId = '';

const createdProductIds: string[] = [];

let teardownCanonical: typeof import('../../db/__tests__/canonical-teardown.js').deleteTestCanonicalRows;

beforeAll(async () => {
  // `config/index.ts` reads `process.env` once at import and freezes it, and
  // `app.ts` decides every `/internal/*` mount from that frozen value — so the
  // allow-list has to be set BEFORE the graph loads. The
  // `catalog-rollout.realdb.test.ts` device.
  process.env.CATALOG_OPERATOR_OXY_USER_IDS = OPERATOR;
  vi.resetModules();

  const postgres = await import('../../db/postgres.js');
  db = await postgres.connectPostgres();
  closePostgres = postgres.closePostgres;
  ({ deleteTestCanonicalRows: teardownCanonical } = await import(
    '../../db/__tests__/canonical-teardown.js'
  ));

  const { createCanonicalProduct } = await import(
    '../../services/canonical/canonical-product.service.js'
  );
  const first = await createCanonicalProduct({
    name: `Emit fixture ${RUN}`,
    actorOxyUserId: OPERATOR,
  });
  productId = first.id;
  createdProductIds.push(first.id);
  const second = await createCanonicalProduct({
    name: `Emit fixture second ${RUN}`,
    actorOxyUserId: OPERATOR,
  });
  variantAbsentProductId = second.id;
  createdProductIds.push(second.id);

  const [source] = await db
    .insert(catalogSources)
    .values({
      kind: 'feed',
      name: `attr-emit-${RUN}`,
      mayDisplay: true,
      mayStore: true,
      attributionRequired: false,
    })
    .returning();
  if (!source) throw new Error('catalog source insert returned no row');
  sourceId = source.id;

  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId,
      externalType: 'product',
      externalId: `emit-${RUN}`,
      observedAt: new Date(),
      contentHash: RUN.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/gu, '0'),
    })
    .returning();
  if (!record) throw new Error('source record insert returned no row');
  sourceRecordId = record.id;

  // One CANDIDATE value the select route will promote, and two values under the
  // keys the mapping fan-out has to sweep. Inserted directly rather than through
  // `applyAttributeObservation`, so the starting selection state is stated here
  // rather than being a consequence of the observation decision procedure.
  const [selectable] = await db
    .insert(canonicalAttributeValues)
    .values({
      productId,
      attributeKey: KEY_SELECT,
      sourceDisplayValue: 'Matte',
      normalizedText: 'matte',
      normalizationState: 'normalized',
      selectionState: 'candidate',
      method: 'operator',
      sourceRecordId,
    })
    .returning();
  if (!selectable) throw new Error('candidate value insert returned no row');
  selectableValueId = selectable.id;

  await db.insert(canonicalAttributeValues).values([
    {
      productId,
      attributeKey: KEY_MAPPED,
      sourceDisplayValue: '15',
      normalizedNumber: 15,
      normalizationState: 'normalized',
      selectionState: 'candidate',
      method: 'connector_declared',
      sourceRecordId,
    },
    {
      productId: variantAbsentProductId,
      attributeKey: KEY_MAPPED,
      sourceDisplayValue: '17',
      normalizedNumber: 17,
      normalizationState: 'normalized',
      selectionState: 'candidate',
      method: 'connector_declared',
      sourceRecordId,
    },
    {
      productId,
      attributeKey: KEY_REPOINTED,
      sourceDisplayValue: '15',
      normalizedNumber: 15,
      normalizationState: 'normalized',
      selectionState: 'candidate',
      method: 'connector_declared',
      sourceRecordId,
    },
  ]);

  const { createApp } = await import('../../app.js');
  server = await new Promise<Server>((resolve) => {
    const listening = createApp().listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 180_000);

afterAll(async () => {
  if (db) {
    await db
      .delete(attributeReindexRequests)
      .where(inArray(attributeReindexRequests.attributeKey, ALL_KEYS));
    await db
      .delete(canonicalAttributeValues)
      .where(inArray(canonicalAttributeValues.attributeKey, ALL_KEYS));
    // Before the source rows: `attribute_source_mappings.catalog_source_id` and
    // `canonical_attribute_values.source_record_id` are both ON DELETE RESTRICT.
    if (sourceId !== '') {
      await db
        .delete(attributeSourceMappings)
        .where(eq(attributeSourceMappings.catalogSourceId, sourceId));
    }
    if (teardownCanonical) await teardownCanonical(db, { productIds: createdProductIds });
    if (sourceRecordId !== '') {
      // The select route records a `catalog_revisions` row citing the
      // observation, and that reference is ON DELETE RESTRICT (ADR 0002 D19)
      // while the table itself is append-only by trigger — so the row has to be
      // removed through the shared toggle window, which is what every other
      // realdb file that writes a revision does.
      //
      // Scoped to THIS file's own source record: a revision belongs to whoever
      // wrote it, and deleting a sibling's would turn a loud teardown failure
      // into a silent wrong answer somewhere else (`canonical-teardown.ts`).
      await withTriggerToggleLock(db, async (tx) => {
        await tx.execute(
          sql`alter table catalog_revisions disable trigger catalog_revisions_append_only`,
        );
        await tx
          .delete(catalogRevisions)
          .where(eq(catalogRevisions.sourceRecordId, sourceRecordId));
        await tx.execute(
          sql`alter table catalog_revisions enable trigger catalog_revisions_append_only`,
        );
      });
    }
    if (sourceId !== '') {
      await db.delete(sourceRecords).where(eq(sourceRecords.sourceId, sourceId));
      await db.delete(catalogSources).where(eq(catalogSources.id, sourceId));
    }
  }
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (closePostgres) await closePostgres();
  delete process.env.CATALOG_OPERATOR_OXY_USER_IDS;
});

async function post(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

/**
 * Reindex rows matched on COLUMNS, never on `reindexRequestId`'s output.
 *
 * Asking the mechanism to spell its own key and then looking that key up is a
 * check that agrees with itself whatever the derivation does.
 */
async function reindexRows(
  attributeKey: string,
  reason: AttributeReindexReason,
): Promise<{ entityKind: string; entityId: string }[]> {
  const rows = await db
    .select({
      entityKind: attributeReindexRequests.entityKind,
      entityId: attributeReindexRequests.entityId,
    })
    .from(attributeReindexRequests)
    .where(
      and(
        eq(attributeReindexRequests.attributeKey, attributeKey),
        eq(attributeReindexRequests.reason, reason),
      ),
    );
  return rows;
}

/** The entities carrying a key, read independently of the fan-out's own helper. */
async function entitiesCarrying(attributeKey: string): Promise<number> {
  const rows = await db
    .select({ id: canonicalAttributeValues.id })
    .from(canonicalAttributeValues)
    .where(eq(canonicalAttributeValues.attributeKey, attributeKey));
  return rows.length;
}

describe('POST /internal/commerce-graph/attribute-values/:id/select emits a reindex', () => {
  it('enqueues an operator_correction for the entity whose shown value changed', async () => {
    // The negative control. Without it, a row from any other source would pass.
    expect(
      await reindexRows(KEY_SELECT, 'operator_correction'),
      'a reindex row existed BEFORE the route was called',
    ).toEqual([]);

    const response = await post(
      `/internal/commerce-graph/attribute-values/${selectableValueId}/select`,
      { reason: 'the manufacturer sheet says matte' },
    );
    expect(response.status, response.text).toBe(200);

    expect(await reindexRows(KEY_SELECT, 'operator_correction')).toEqual([
      { entityKind: 'product', entityId: productId },
    ]);
  });

  it('really did change the selection, so the emit is not the only thing that ran', async () => {
    const [row] = await db
      .select({ selectionState: canonicalAttributeValues.selectionState })
      .from(canonicalAttributeValues)
      .where(eq(canonicalAttributeValues.id, selectableValueId));
    expect(row?.selectionState).toBe('selected');
  });
});

describe('POST /internal/catalog-attributes/source-mappings emits a reindex', () => {
  it('enqueues normalization_rules_changed for every entity carrying the mapped key', async () => {
    // The vacuity floor: a sweep over a key nobody carries enqueues nothing and
    // would pass for the wrong reason.
    expect(await entitiesCarrying(KEY_MAPPED), 'the fixture carries no values').toBe(2);
    expect(
      await reindexRows(KEY_MAPPED, 'normalization_rules_changed'),
      'a reindex row existed BEFORE the route was called',
    ).toEqual([]);

    const response = await post('/internal/catalog-attributes/source-mappings', {
      catalogSourceId: sourceId,
      sourceField: SOURCE_FIELD,
      attributeKey: KEY_MAPPED,
      assumedUnit: 'in',
    });
    expect(response.status, response.text).toBe(201);

    const rows = await reindexRows(KEY_MAPPED, 'normalization_rules_changed');
    expect(rows.map((row) => row.entityId).sort()).toEqual(
      [productId, variantAbsentProductId].sort(),
    );
    expect(new Set(rows.map((row) => row.entityKind))).toEqual(new Set(['product']));
  });

  it('re-pointing the field sweeps the OLD key as well as the new one', async () => {
    expect(await entitiesCarrying(KEY_REPOINTED), 'the fixture carries no values').toBe(1);
    expect(await reindexRows(KEY_REPOINTED, 'normalization_rules_changed')).toEqual([]);

    // Same (catalogSourceId, sourceField) as the case above, so this UPDATES the
    // mapping rather than inserting a second one — the field now means a
    // different attribute, and every value the old rule produced is stale too.
    const response = await post('/internal/catalog-attributes/source-mappings', {
      catalogSourceId: sourceId,
      sourceField: SOURCE_FIELD,
      attributeKey: KEY_REPOINTED,
      assumedUnit: 'cm',
    });
    expect(response.status, response.text).toBe(201);

    expect(
      (await reindexRows(KEY_REPOINTED, 'normalization_rules_changed')).map((row) => row.entityId),
      'the NEW key was not swept',
    ).toEqual([productId]);
    // And the previous key is still covered — the under-enqueue direction is the
    // bug, so this is asserted on the key the mapping just stopped pointing at.
    expect(
      (await reindexRows(KEY_MAPPED, 'normalization_rules_changed')).map((row) => row.entityId).sort(),
      'the OLD key lost its coverage',
    ).toEqual([productId, variantAbsentProductId].sort());

    // One row, updated in place, rather than two mappings for one field.
    const mappings = await db
      .select({ attributeKey: attributeSourceMappings.attributeKey })
      .from(attributeSourceMappings)
      .where(eq(attributeSourceMappings.catalogSourceId, sourceId));
    expect(mappings).toEqual([{ attributeKey: KEY_REPOINTED }]);
  });
});
