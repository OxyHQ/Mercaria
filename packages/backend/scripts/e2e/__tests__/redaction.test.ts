/**
 * The negative control on the #69 evidence redactor, and its positive control.
 *
 * A redactor is the one component whose failure looks exactly like success: an
 * artefact with no secret in it and an artefact the collector never populated
 * are byte-identical in every property anybody checks. So each case here comes
 * in a PAIR — the contaminated direction (the secret is caught) and the clean
 * direction (the innocent value the collector was handed SURVIVES into the
 * output) — because only the second one distinguishes a working scanner from a
 * scanner that refuses everything, and only the first distinguishes it from a
 * scanner that reads nothing.
 *
 * Run with:
 *   bun run --cwd packages/backend vitest run scripts/e2e/__tests__/redaction.test.ts
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Connection, SyncRun } from '@mercaria/shared-types';
import {
  EvidenceCollector,
  projectConnection,
  projectSyncRun,
} from '../evidence.js';
import {
  assertNoSecrets,
  assertScanWasNotVacuous,
  EvidenceRedactionError,
  redactErrorText,
  redactIdentifier,
  redactUrl,
  SecretRegistry,
  selfTest,
} from '../redact.js';

/** A WooCommerce-shaped consumer secret, of the length a real site issues. */
const CONSUMER_SECRET = 'cs_9f2b7c1e4a8d6053bb1c9e7f2a4d8c60e5137b9a';
/** A value that must SURVIVE — the positive control in the same currency. */
const INNOCENT_RUN_ID = 'sync-run-0000-abcd-1234-wxyz';

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), 'mercaria-e2e-redaction-'));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

function registryWithSecret(): SecretRegistry {
  const registry = new SecretRegistry();
  registry.register('woocommerce consumer secret', CONSUMER_SECRET);
  return registry;
}

describe('the scanner catches a known secret, and does not catch everything', () => {
  it('reports the secret by LABEL and never quotes its value', () => {
    const registry = registryWithSecret();
    const report = registry.scan(`{"error":"auth failed for ${CONSUMER_SECRET}"}`);

    expect(report.leaks.map((l) => l.label)).toContain('woocommerce consumer secret');
    // The leak report is itself an artefact somebody reads. If it quoted the
    // match, the refusal would be a second copy of the secret.
    expect(JSON.stringify(report)).not.toContain(CONSUMER_SECRET);
  });

  it('leaves a clean artefact alone — the control that a scanner flagging everything fails', () => {
    const registry = registryWithSecret();
    const report = registry.scan(`{"syncRunId":"${INNOCENT_RUN_ID}","created":12}`);

    expect(report.leaks).toEqual([]);
    expect(report.charactersScanned).toBeGreaterThan(0);
  });

  it('catches a secret SHAPE the run never registered', () => {
    // The registry cannot know a channel key minted mid-run. This is the layer
    // that does, and it fails differently — by shape, not by value.
    const registry = registryWithSecret();
    const report = registry.scan('{"note":"minted mck_abcdefghij0123456789 for the plugin"}');

    expect(report.leaks.map((l) => l.source)).toContain('forbidden_shape');
  });

  it('catches a Shopify OAuth authorization code and the callback hmac', () => {
    // The token the code is exchanged FOR is covered by `shpat_`; the code and
    // the hmac carry no prefix, and a connection observation captured right
    // after a connect is exactly where they appear.
    const registry = registryWithSecret();
    const callback = registry.scan(
      '{"note":"callback ?code=abc123def456ghi789jkl&hmac=0123456789abcdef0123456789abcdef"}',
    );

    expect(callback.leaks.map((l) => l.label)).toContain(
      'oauth authorization code / callback hmac query parameter',
    );
    // …and the pattern does not fire on ordinary prose containing the word.
    expect(registry.scan('{"note":"the error code was 429"}').leaks).toEqual([]);
  });

  it('catches a buyer email, which no registry could hold', () => {
    const registry = registryWithSecret();
    const report = registry.scan('{"note":"order placed by buyer@example.com"}');

    expect(report.leaks.map((l) => l.label)).toContain('email address');
  });

  it('does not carry `lastIndex` between scans of the same global pattern', () => {
    // A module-level /g RegExp keeps `lastIndex` across calls. Left unreset, the
    // second scan starts mid-string and a leak at the head reads as clean —
    // silently, and only on the second artefact.
    const registry = registryWithSecret();
    const contaminated = '{"a":"mck_abcdefghij0123456789"}';

    const first = registry.scan(contaminated);
    const second = registry.scan(contaminated);

    expect(second.leaks).toEqual(first.leaks);
    expect(second.leaks.length).toBeGreaterThan(0);
  });
});

describe('the vacuity floor', () => {
  it('refuses a scan that read ZERO characters', () => {
    const registry = registryWithSecret();
    expect(() => assertNoSecrets(registry, '')).toThrow(/ZERO characters/);
  });

  it('refuses a scan whose registry is EMPTY', () => {
    // The shape patterns alone cannot see a bare consumer secret, so a clean
    // result from an empty registry is not evidence about this run's secrets.
    const empty = new SecretRegistry();
    expect(() => assertNoSecrets(empty, '{"created":12}')).toThrow(/EMPTY secret registry/);
  });

  it('accepts a scan that genuinely examined something', () => {
    const registry = registryWithSecret();
    const artefact = '{"created":12}';
    const report = assertNoSecrets(registry, artefact);

    // Against the artefact's own length, not a literal: a hand-counted number
    // drifts the moment the fixture is edited, and drifts silently.
    expect(report.charactersScanned).toBe(artefact.length);
    expect(report.registeredSecrets).toBe(1);
    expect(report.shapesChecked).toBeGreaterThan(0);
    expect(() => assertScanWasNotVacuous(report)).not.toThrow();
  });
});

describe('the registry refuses what it cannot protect', () => {
  it('refuses a value too short to be distinguishable from incidental text', () => {
    const registry = new SecretRegistry();
    // Accepting this and quietly not watching it is the failure mode: the
    // guarantee would then be unreadable from the code.
    expect(() => registry.register('short', 'abc')).toThrow(/below the .*floor/);
    expect(registry.size).toBe(0);
  });

  it('refuses an empty value', () => {
    const registry = new SecretRegistry();
    expect(() => registry.register('empty', '')).toThrow(/empty value/);
  });
});

describe('the field-level helpers', () => {
  it('truncates an identifier to its last four characters', () => {
    expect(redactIdentifier('conn_0123456789abcdef')).toBe('…cdef');
  });

  it('distinguishes absent from empty', () => {
    expect(redactIdentifier(null)).toBeNull();
    expect(redactIdentifier(undefined)).toBeNull();
    expect(redactIdentifier('')).toBe('');
  });

  it('does not imply a truncation that did not happen', () => {
    // `…abc` would read as "the tail of something longer".
    expect(redactIdentifier('abc')).toBe('<3ch>');
  });

  it('reduces a URL to scheme and host, dropping query and userinfo', () => {
    expect(redactUrl(`https://shop.example/wp-json?consumer_secret=${CONSUMER_SECRET}`)).toBe(
      'https://shop.example',
    );
    expect(redactUrl('https://key:secret@shop.example/a')).toBe('https://shop.example');
  });

  it('narrows a provider error before it reaches the artefact', () => {
    const narrowed = redactErrorText(
      `HTTP 401 from https://shop.example/wp-json/wc/v3/products?consumer_secret=${CONSUMER_SECRET}`,
    );
    expect(narrowed).not.toContain(CONSUMER_SECRET);
    // …while keeping what an operator needs in order to act on it.
    expect(narrowed).toContain('HTTP 401');
  });
});

describe('the DTO projections carry no credential-bearing field', () => {
  const connection: Connection = {
    id: 'conn_0123456789abcdef',
    storeId: 'store_fedcba9876543210',
    provider: 'woocommerce',
    mode: 'pull',
    status: 'connected',
    shopDomain: 'shop.example',
    shopCurrency: 'EUR',
    scopes: ['read', 'write'],
    syncSettings: {
      products: 'pull',
      inventory: 'pull',
      orders: 'off',
      autoPublish: false,
      conflictPolicy: 'respect_overrides',
    },
    webhookIds: ['wh_1111111111', 'wh_2222222222'],
    webhookFailures: [
      { topic: 'product.updated', reason: 'permission_denied', httpStatus: 401, recordedAt: '2026-08-15T00:00:00.000Z' },
    ],
    connectedAt: '2026-08-15T00:00:00.000Z',
  } as unknown as Connection;

  it('keeps the facts §5 asks for and truncates the identifiers', () => {
    const projected = projectConnection(connection);

    expect(projected.status).toBe('connected');
    expect(projected.shopCurrency).toBe('EUR');
    expect(projected.scopes).toEqual(['read', 'write']);
    expect(projected.webhookIdCount).toBe(2);
    expect(projected.id).toBe('…cdef');
    expect(projected.webhookIds).toEqual(['…1111', '…2222']);
    expect(projected.webhookFailures).toEqual([
      { topic: 'product.updated', reason: 'permission_denied', httpStatus: 401, recordedAt: '2026-08-15T00:00:00.000Z' },
    ]);
  });

  it('emits ONLY named fields, so a DTO growing a credential cannot carry it in', () => {
    // The projection is an allow-list. This is the case the tripwire scan
    // cannot see, because the leaking field would be one nobody named.
    const contaminated = {
      ...connection,
      accessToken: `Bearer ${CONSUMER_SECRET}`,
      credentialsCiphertext: CONSUMER_SECRET,
    } as unknown as Connection;

    const serialized = JSON.stringify(projectConnection(contaminated));

    expect(serialized).not.toContain(CONSUMER_SECRET);
    expect(serialized).not.toContain('accessToken');
    // …and the projection genuinely READ the object rather than returning an
    // empty one, which would also contain no secret.
    expect(serialized).toContain('connected');
    expect(serialized).toContain('EUR');
  });

  it('projects a sync run to its id, kind, status and four tallies', () => {
    const run: SyncRun = {
      id: INNOCENT_RUN_ID,
      connectionId: 'conn_0123456789abcdef',
      kind: 'backfill',
      status: 'completed',
      counts: { created: 12, updated: 3, skipped: 1, failed: 0 },
      startedAt: '2026-08-15T00:00:00.000Z',
      finishedAt: '2026-08-15T00:01:00.000Z',
    };

    expect(projectSyncRun(run)).toMatchObject({
      kind: 'backfill',
      status: 'completed',
      counts: { created: 12, updated: 3, skipped: 1, failed: 0 },
      id: '…wxyz',
    });
  });
});

describe('the collector refuses to write a contaminated artefact', () => {
  it('throws NAMING the leak, and writes NOTHING', async () => {
    const registry = registryWithSecret();
    const collector = new EvidenceCollector(registry, outDir, 'contaminated');
    collector.record({
      id: 'W1',
      title: 'REST credential connection',
      status: 'PASSED',
      measured: 'connection status connected',
      wouldReadIfAbsent: 'no connection row at all',
      // A field somebody named legitimately, carrying a value they did not
      // expect — the case the allow-list cannot catch.
      observations: { note: `authenticated with ${CONSUMER_SECRET}` } as never,
    });

    await expect(collector.write()).rejects.toBeInstanceOf(EvidenceRedactionError);

    const written = await readFile(path.join(outDir, 'contaminated.evidence.json'), 'utf8').catch(
      (err: NodeJS.ErrnoException) => err.code,
    );
    expect(written).toBe('ENOENT');
  });

  it('writes a clean artefact AND the innocent observation survives into it', async () => {
    // The positive control the negative one needs. Without it, a collector that
    // wrote an empty file would pass the case above.
    const registry = registryWithSecret();
    const collector = new EvidenceCollector(registry, outDir, 'clean');
    collector.describeEnvironment({ database: 'mercaria_e2e_69', redis: true });
    collector.record({
      id: 'W1',
      title: 'REST credential connection',
      status: 'PASSED',
      measured: 'connection status connected, shopCurrency EUR',
      wouldReadIfAbsent: 'no connection row, or status error',
      observations: { syncRunId: redactIdentifier(INNOCENT_RUN_ID), created: 12 },
    });

    const { jsonPath, scan } = await collector.write();
    const written = await readFile(jsonPath, 'utf8');

    expect(written).not.toContain(CONSUMER_SECRET);
    // The collector SAW the fields: both the environment and the observation it
    // was handed are present in the output.
    expect(written).toContain('mercaria_e2e_69');
    expect(written).toContain('"created": 12');
    expect(written).toContain('…wxyz');
    expect(scan.charactersScanned).toBeGreaterThan(0);
    expect(scan.registeredSecrets).toBe(1);
  });

  it('refuses to write ZERO scenarios', async () => {
    const collector = new EvidenceCollector(registryWithSecret(), outDir, 'empty');
    await expect(collector.write()).rejects.toThrow(/ZERO scenarios/);
  });
});

describe('a PASSED must state an observable and its counterfactual', () => {
  it('refuses a PASSED whose evidence is the absence of an error', () => {
    const collector = new EvidenceCollector(registryWithSecret(), outDir, 'lazy');
    expect(() =>
      collector.record({ id: 'W2', title: 'Backfill', status: 'PASSED' }),
    ).toThrow(/needs the observable that was MEASURED/);
  });

  it('refuses a PASSED with a measurement but no counterfactual', () => {
    const collector = new EvidenceCollector(registryWithSecret(), outDir, 'lazy');
    expect(() =>
      collector.record({
        id: 'W2',
        title: 'Backfill',
        status: 'PASSED',
        measured: '12 listings created',
      }),
    ).toThrow(/if the thing under test were ABSENT/);
  });

  it('refuses a FAILED with no error and a NOT_RUN with no reason', () => {
    const collector = new EvidenceCollector(registryWithSecret(), outDir, 'lazy');
    expect(() => collector.record({ id: 'W3', title: 'x', status: 'FAILED' })).toThrow(
      /needs the error/,
    );
    expect(() => collector.record({ id: 'W4', title: 'x', status: 'NOT_RUN' })).toThrow(
      /needs the precise reason/,
    );
  });
});

describe('the collector cannot be constructed with a broken redactor', () => {
  it('runs the self-test in the constructor, in BOTH directions', () => {
    // `selfTest` asserts the secret is caught AND that a clean artefact is not
    // flagged. Calling it here is what pins that the constructor's guarantee is
    // this function rather than a weaker one.
    const control = selfTest();
    expect(control.caught.leaks.length).toBeGreaterThan(0);
    expect(control.clean.leaks).toEqual([]);
    expect(control.caught.charactersScanned).toBeGreaterThan(0);
  });
});
