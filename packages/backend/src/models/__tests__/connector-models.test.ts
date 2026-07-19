/**
 * Basic validation tests for the connector models (`Connection`, `SyncRun`).
 *
 * `mongodb-memory-server` is unavailable offline, so these exercise Mongoose's
 * schema validation directly (`Document.validate()`), which runs without a DB
 * connection: defaults are applied, required fields are enforced, enum fields
 * reject unknown values, the encrypted-credential sub-document requires all three
 * parts, and the declared indexes are asserted structurally.
 */

import { describe, it, expect } from 'vitest';
import { Connection } from '../connection.js';
import { SyncRun } from '../sync-run.js';

describe('Connection model', () => {
  it('validates a minimal connection and applies sync-setting defaults', async () => {
    const conn = new Connection({ storeId: 'store_1', provider: 'shopify', mode: 'pull' });
    await expect(conn.validate()).resolves.toBeUndefined();
    expect(conn.status).toBe('disconnected');
    expect(conn.syncSettings.products).toBe('off');
    expect(conn.syncSettings.inventory).toBe('off');
    expect(conn.syncSettings.orders).toBe('off');
    expect(conn.syncSettings.autoPublish).toBe(false);
    expect(conn.syncSettings.conflictPolicy).toBe('respect_overrides');
    expect(conn.scopes).toEqual([]);
    expect(conn.webhookIds).toEqual([]);
    expect(conn.connectedAt).toBeInstanceOf(Date);
  });

  it('requires storeId, provider and mode', async () => {
    const conn = new Connection({});
    await expect(conn.validate()).rejects.toMatchObject({
      errors: {
        storeId: expect.anything(),
        provider: expect.anything(),
        mode: expect.anything(),
      },
    });
  });

  it('rejects an unknown provider', async () => {
    const conn = new Connection({ storeId: 's', mode: 'pull' });
    conn.set('provider', 'bigcommerce');
    await expect(conn.validate()).rejects.toMatchObject({
      errors: { provider: expect.anything() },
    });
  });

  it('rejects an invalid per-resource sync direction', async () => {
    const conn = new Connection({ storeId: 's', provider: 'shopify', mode: 'pull' });
    conn.set('syncSettings.products', 'sideways');
    await expect(conn.validate()).rejects.toMatchObject({
      errors: { 'syncSettings.products': expect.anything() },
    });
  });

  it('requires all three parts of the encrypted credential blob', async () => {
    const conn = new Connection({ storeId: 's', provider: 'shopify', mode: 'pull' });
    conn.set('credentials', { ciphertext: 'x', iv: 'y' });
    await expect(conn.validate()).rejects.toMatchObject({
      errors: { 'credentials.tag': expect.anything() },
    });
  });

  it('declares a unique { storeId, provider } index', () => {
    const unique = Connection.schema
      .indexes()
      .find(([fields]) => fields.storeId === 1 && fields.provider === 1);
    expect(unique).toBeDefined();
    expect(unique?.[1]?.unique).toBe(true);
  });
});

describe('SyncRun model', () => {
  it('validates a minimal run and applies count/status defaults', async () => {
    const run = new SyncRun({ connectionId: 'conn_1', kind: 'backfill' });
    await expect(run.validate()).resolves.toBeUndefined();
    expect(run.status).toBe('running');
    expect(run.counts.created).toBe(0);
    expect(run.counts.updated).toBe(0);
    expect(run.counts.skipped).toBe(0);
    expect(run.counts.failed).toBe(0);
    expect(run.startedAt).toBeInstanceOf(Date);
  });

  it('requires connectionId and kind', async () => {
    const run = new SyncRun({});
    await expect(run.validate()).rejects.toMatchObject({
      errors: {
        connectionId: expect.anything(),
        kind: expect.anything(),
      },
    });
  });

  it('rejects an unknown kind and status', async () => {
    const run = new SyncRun({ connectionId: 'c', kind: 'backfill' });
    run.set('kind', 'teleport');
    run.set('status', 'exploded');
    await expect(run.validate()).rejects.toMatchObject({
      errors: {
        kind: expect.anything(),
        status: expect.anything(),
      },
    });
  });

  it('declares a { connectionId, startedAt } index', () => {
    const found = SyncRun.schema
      .indexes()
      .find(([fields]) => fields.connectionId === 1 && 'startedAt' in fields);
    expect(found).toBeDefined();
  });
});
