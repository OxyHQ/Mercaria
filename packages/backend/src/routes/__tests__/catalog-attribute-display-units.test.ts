/**
 * The public attribute surface CALLS the display-unit chooser (#367 Workstream 4,
 * "localize unit display and choose display units by locale/market/user
 * preference without mutating stored values").
 *
 * ## Why this file exists beside `display-units.test.ts`
 *
 * That one measures the mechanism. This one measures that the mechanism is
 * REACHED — a module can be correct, tested and called by nothing, which is the
 * shape a "green and inert" gate takes and which this repository has recorded
 * more than once. The assertions therefore run against the real router built by
 * `createApp`, over real HTTP, so the query schema, the route wiring and the
 * handler are all in the path.
 *
 * Only the two data reads are stubbed. Everything between the socket and them —
 * `express.json`, the rate limiter mount, `validateQuery`, the `.strict()`
 * schema and the projection — is production code.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';

/**
 * One selected row per attribute the fixtures below serve.
 *
 * `screen_size` is a measurement with a declared precision; `weight` is one
 * with none, so the source's significant digits decide; `finish` is a string,
 * which nothing may convert; `legacy_length` carries a stored unit the table
 * does not know, which must be REFUSED rather than rendered beside a guess.
 */
const ROWS = [
  {
    attributeKey: 'screen_size',
    sourceDisplayValue: '6.1 in',
    normalizationState: 'normalized',
    normalizedNumber: 154.94,
    normalizedUnit: 'mm',
    normalizedNumberMax: null,
    normalizedText: null,
    normalizedBoolean: null,
    normalizedDate: null,
    normalizedAmountMinor: null,
    normalizedCurrency: null,
    componentAxis: null,
    position: 0,
    verificationState: 'unverified',
  },
  {
    attributeKey: 'weight',
    sourceDisplayValue: '187 g',
    normalizationState: 'normalized',
    normalizedNumber: 187,
    normalizedUnit: 'g',
    normalizedNumberMax: null,
    normalizedText: null,
    normalizedBoolean: null,
    normalizedDate: null,
    normalizedAmountMinor: null,
    normalizedCurrency: null,
    componentAxis: null,
    position: 0,
    verificationState: 'unverified',
  },
  {
    attributeKey: 'finish',
    sourceDisplayValue: 'Black Titanium',
    normalizationState: 'normalized',
    normalizedNumber: null,
    normalizedUnit: null,
    normalizedNumberMax: null,
    normalizedText: 'black titanium',
    normalizedBoolean: null,
    normalizedDate: null,
    normalizedAmountMinor: null,
    normalizedCurrency: null,
    componentAxis: null,
    position: 0,
    verificationState: 'unverified',
  },
  {
    attributeKey: 'legacy_length',
    sourceDisplayValue: '14 smoots',
    normalizationState: 'normalized',
    normalizedNumber: 14,
    normalizedUnit: 'smoot',
    normalizedNumberMax: null,
    normalizedText: null,
    normalizedBoolean: null,
    normalizedDate: null,
    normalizedAmountMinor: null,
    normalizedCurrency: null,
    componentAxis: null,
    position: 0,
    verificationState: 'unverified',
  },
];

/** `screen_size` declares one decimal place; nothing else declares any. */
const DEFINITIONS: Readonly<Record<string, { label: string; decimalPlaces: number | null }>> = {
  screen_size: { label: 'Screen size', decimalPlaces: 1 },
  weight: { label: 'Weight', decimalPlaces: null },
  finish: { label: 'Finish', decimalPlaces: null },
  legacy_length: { label: 'Legacy length', decimalPlaces: null },
};

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    next();
  },
  oxyClient: {},
  optionalAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
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
vi.mock('../../lib/logger.js', () => ({
  log: {
    general: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('../../db/postgres.js', () => ({
  getDb: () => ({}),
  checkPostgresHealth: () => Promise.resolve(true),
  assertMigrationsCurrent: () => Promise.resolve(),
  closePostgres: () => Promise.resolve(),
}));
vi.mock('../../db/canonical/attributeRepository.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/canonical/attributeRepository.js')>()),
  listSelectedAttributeValues: () => Promise.resolve(ROWS),
}));
vi.mock('../../services/attributes/definition-registry.service.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../services/attributes/definition-registry.service.js')
  >()),
  resolveActiveDefinition: (_db: unknown, key: string) => {
    const definition = DEFINITIONS[key];
    if (definition === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      row: {
        key,
        label: definition.label,
        valueType: 'measurement',
        displayPolicy: 'public',
        decimalPlaces: definition.decimalPlaces,
        version: 1,
      },
    });
  },
}));

let server: Server;
let baseUrl: string;

interface PublicValue {
  key: string;
  displayValue: string;
}

beforeAll(async () => {
  vi.resetModules();
  process.env.STRIPE_ENABLED = 'false';
  const { createApp } = await import('../../app.js');
  const app = createApp();
  server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => {
      resolve(started);
    });
  });
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

async function values(query: string): Promise<Map<string, string>> {
  const response = await fetch(`${baseUrl}/catalog-attributes/values/product/prod-1${query}`);
  expect(response.status, `GET ${query} answered ${String(response.status)}`).toBe(200);
  const body = (await response.json()) as { data: { values: PublicValue[] } };
  const rendered = new Map(body.data.values.map((value) => [value.key, value.displayValue]));
  // The fixture really arrived, or every assertion below is about an empty map.
  expect(rendered.size).toBe(ROWS.length);
  return rendered;
}

describe('the public values route composes a display unit', () => {
  it('serves the SOURCE words when no preference is stated', async () => {
    // Today's behaviour, byte for byte. The parameters are additive: a client
    // that never sends one sees exactly what it saw before they existed.
    const rendered = await values('');
    expect(rendered.get('screen_size')).toBe('6.1 in');
    expect(rendered.get('weight')).toBe('187 g');
    expect(rendered.get('finish')).toBe('Black Titanium');
  });

  it('renders a US shopper inches and pounds, and a metric one the base units', async () => {
    const us = await values('?unitSystem=us');
    expect(us.get('screen_size')).toBe('6.1 in');
    expect(us.get('weight')).toBe('0.412 lb');

    const metric = await values('?unitSystem=metric');
    // The declared precision, applied in the DISPLAY unit — and different from
    // the source's own words, which is what proves a rendering happened at all.
    expect(metric.get('screen_size')).toBe('154.9 mm');
    expect(metric.get('weight')).toBe('187 g');
  });

  it('accepts a MARKET as the fallback, and the two agree', async () => {
    const byMarket = await values('?market=US');
    const bySystem = await values('?unitSystem=us');
    expect(byMarket.get('screen_size')).toBe(bySystem.get('screen_size'));
    expect(byMarket.get('weight')).toBe(bySystem.get('weight'));
    // A metric market is a real answer and not the same one.
    const spain = await values('?market=ES');
    expect(spain.get('weight')).toBe('187 g');
    expect(spain.get('weight')).not.toBe(bySystem.get('weight'));
  });

  it('leaves a non-measurement alone, whatever the preference', async () => {
    for (const query of ['?unitSystem=us', '?unitSystem=uk', '?market=US']) {
      const rendered = await values(query);
      expect(rendered.get('finish'), `${query} converted a string`).toBe('Black Titanium');
    }
  });

  it('serves the source words for a stored unit the table does not know', async () => {
    // The refusal reaching the wire. `14` beside a guessed `mm` is exactly the
    // fabricated dimension #94 forbids, so the honest answer is the words the
    // source wrote.
    const rendered = await values('?unitSystem=us');
    expect(rendered.get('legacy_length')).toBe('14 smoots');
  });

  it('refuses a query parameter nobody declared', async () => {
    // `.strict()` on the schema, reached through the real route. A query able to
    // carry a unit or a magnitude is where one would eventually be trusted.
    for (const query of ['?normalizedNumber=999', '?unit=in', '?unitSystem=imperial']) {
      const response = await fetch(
        `${baseUrl}/catalog-attributes/values/product/prod-1${query}`,
      );
      expect(response.status, `${query} was accepted`).toBe(400);
    }
  });
});
