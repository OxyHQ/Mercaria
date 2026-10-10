/**
 * The two pieces every provider shares: the transport (identification, pacing,
 * failure classification, the dump cache) and the generic adapter (cursor,
 * envelope, completeness, error vocabulary).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CatalogSourceFetchError, type AdapterFetchRequest } from '../../ingestion/adapter.js';
import { createOpenDataAdapter } from '../../ingestion/adapters/open-data.js';
import { createOpenDataHttp, readRetryAfterMs, type OpenDataHttp } from '../http.js';
import {
  OpenDataConfigurationError,
  OpenDataSchemaError,
  type OpenDataPage,
  type OpenDataPageContext,
  type OpenDataProvider,
} from '../provider.js';

function transport(
  responder: (url: string, init: RequestInit) => Response,
  clockStart = 1_000_000,
) {
  let now = clockStart;
  const sleeps: number[] = [];
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const http = createOpenDataHttp({
    userAgent: 'Mercaria-test/1.0 (test@example.com)',
    timeoutMs: 5_000,
    cacheDir: mkdtempSync(join(tmpdir(), 'open-data-cache-')),
    maxDownloadBytes: 1_000,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
      return responder(url, init ?? {});
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    clock: () => now,
  });
  return { http, calls, sleeps, advance: (ms: number) => (now += ms) };
}

describe('the open-data transport', () => {
  it('identifies Mercaria on every request and asks for JSON', async () => {
    const { http, calls } = transport(() => Response.json({ ok: true }));
    await expect(http.getJson('https://example.org/a')).resolves.toMatchObject({
      body: { ok: true },
    });
    expect(calls[0]?.headers['user-agent']).toBe('Mercaria-test/1.0 (test@example.com)');
    expect(calls[0]?.headers.accept).toBe('application/json');
  });

  it('refuses to exist without a User-Agent', () => {
    expect(() =>
      createOpenDataHttp({ userAgent: ' ', timeoutMs: 1, cacheDir: tmpdir(), maxDownloadBytes: 1 }),
    ).toThrow(/User-Agent/u);
  });

  it('spaces requests to one host by the provider interval, and not across hosts', async () => {
    const { http, sleeps } = transport(() => Response.json({}));
    await http.getJson('https://a.example/1', { minIntervalMs: 4_000 });
    await http.getJson('https://a.example/2', { minIntervalMs: 4_000 });
    await http.getJson('https://b.example/1', { minIntervalMs: 4_000 });
    expect(sleeps).toEqual([4_000]);
  });

  it("classifies a 429 as a rate limit carrying the host's Retry-After", async () => {
    const { http } = transport(
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }),
    );
    const error = await http.getJson('https://a.example/x').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CatalogSourceFetchError);
    expect((error as CatalogSourceFetchError).kind).toBe('rate_limit');
    expect((error as CatalogSourceFetchError).retryAfterMs).toBe(30_000);
  });

  it('classifies a refusal as auth_failure and does not retry it', async () => {
    const { http } = transport(() => new Response('', { status: 403 }));
    const error = (await http
      .getJson('https://a.example/x')
      .catch((caught: unknown) => caught)) as CatalogSourceFetchError;
    expect(error.kind).toBe('auth_failure');
    expect(error.retryable).toBe(false);
  });

  it('classifies a 5xx and a non-JSON 200 as retryable', async () => {
    const outage = (await transport(() => new Response('', { status: 503 }))
      .http.getJson('https://a.example/x')
      .catch((caught: unknown) => caught)) as CatalogSourceFetchError;
    expect([outage.kind, outage.retryable]).toEqual(['source_outage', true]);
    const html = (await transport(() => new Response('<html>maintenance</html>'))
      .http.getJson('https://a.example/x')
      .catch((caught: unknown) => caught)) as CatalogSourceFetchError;
    expect([html.kind, html.retryable]).toEqual(['parse_failure', true]);
  });

  it('answers a 404 with null only when the caller can read it as a removal', async () => {
    const { http } = transport(() => new Response('', { status: 404 }));
    await expect(http.getJson('https://a.example/x', { allowNotFound: true })).resolves.toBeNull();
    await expect(http.getJson('https://a.example/x')).rejects.toBeInstanceOf(
      CatalogSourceFetchError,
    );
  });

  it('caches a dump, serves it while fresh, and revalidates conditionally after', async () => {
    let served = 0;
    const { http, calls, advance } = transport((_url, init) => {
      served += 1;
      const headers = init.headers as Record<string, string>;
      if (headers['if-none-match'] === '"v1"') return new Response(null, { status: 304 });
      return new Response('dump-bytes', {
        headers: { etag: '"v1"', 'last-modified': 'Fri, 09 Oct 2026 23:08:21 GMT' },
      });
    });
    const first = await http.download('https://a.example/dump.gz', { maxAgeMs: 60_000 });
    const second = await http.download('https://a.example/dump.gz', { maxAgeMs: 60_000 });
    expect(served).toBe(1);
    expect(second.digest).toBe(first.digest);
    expect(first.lastModified?.toISOString()).toBe('2026-10-09T23:08:21.000Z');
    advance(120_000);
    const third = await http.download('https://a.example/dump.gz', { maxAgeMs: 60_000 });
    expect(served).toBe(2);
    expect(calls[1]?.headers['if-none-match']).toBe('"v1"');
    expect(third.path).toBe(first.path);
    expect(third.digest).toBe(first.digest);
  });

  it('refuses a dump over the byte bound rather than truncating it', async () => {
    const { http } = transport(() => new Response('x'.repeat(2_000)));
    const error = (await http
      .download('https://a.example/big', { maxAgeMs: 0 })
      .catch((caught: unknown) => caught)) as CatalogSourceFetchError;
    expect(error).toBeInstanceOf(CatalogSourceFetchError);
    expect(error.retryable).toBe(false);
  });

  it('reads Retry-After as seconds or a date', () => {
    expect(readRetryAfterMs('5', 0)).toBe(5_000);
    expect(readRetryAfterMs(new Date(60_000).toUTCString(), 0)).toBe(60_000);
    expect(readRetryAfterMs(null, 0)).toBeUndefined();
  });
});

describe('the generic open-data adapter', () => {
  const http = {} as OpenDataHttp;
  const request = (overrides: Partial<AdapterFetchRequest> = {}): AdapterFetchRequest => ({
    sourceId: 'source',
    cursor: null,
    pageSize: 2,
    credentialRef: null,
    sourceAccountRef: 'chain',
    since: null,
    territories: ['ES'],
    mode: 'incremental',
    externalIds: [],
    ...overrides,
  });
  function provider(
    fetchPage: (context: OpenDataPageContext) => Promise<OpenDataPage>,
    accountRefRequired = true,
  ): OpenDataProvider {
    return {
      slug: 'test_provider',
      name: 'Test',
      homepage: 'https://example.org',
      role: 'prices',
      kind: 'feed',
      licence: 'cc0_1_0',
      attribution: 'Test data',
      accountRefMeaning: 'a chain',
      accountRefRequired,
      refreshModes: ['full_snapshot', 'incremental'],
      minRequestIntervalMs: 0,
      fetchPage,
    };
  }
  const item = (id: string) => ({
    externalType: 'offer' as const,
    externalId: id,
    normalized: { title: id, identifiers: [], options: [], media: [] },
    raw: { id },
  });

  it('round-trips the provider cursor opaquely and stamps one instant per page', async () => {
    const seen: unknown[] = [];
    const adapter = createOpenDataAdapter(
      provider(async (context) => {
        seen.push(context.cursor);
        return { items: [item('a'), item('b')], next: { p: 2, d: 'x' }, complete: true };
      }),
      { http, clock: () => new Date('2025-10-10T00:00:00Z') },
    );
    const first = await adapter.fetchPage(request());
    expect(first.records.map((record) => record.observedAt.toISOString())).toEqual([
      '2025-10-10T00:00:00.000Z',
      '2025-10-10T00:00:00.000Z',
    ]);
    // Complete is withheld while a further page is queued.
    expect(first.complete).toBe(false);
    await adapter.fetchPage(request({ cursor: first.nextCursor }));
    expect(seen).toEqual([null, { p: 2, d: 'x' }]);
  });

  it('restarts on a cursor it cannot read', async () => {
    const seen: unknown[] = [];
    const adapter = createOpenDataAdapter(
      provider(async (context) => {
        seen.push(context.cursor);
        return { items: [], next: null, complete: true };
      }),
      { http },
    );
    const page = await adapter.fetchPage(request({ cursor: 'not-base64-json' }));
    expect(seen).toEqual([null]);
    expect(page.complete).toBe(true);
  });

  it('refuses a source that does not name the required sub-feed', async () => {
    const adapter = createOpenDataAdapter(
      provider(async () => ({ items: [], next: null, complete: true })),
      { http },
    );
    const error = (await adapter
      .fetchPage(request({ sourceAccountRef: ' ' }))
      .catch((caught: unknown) => caught)) as CatalogSourceFetchError;
    expect(error.kind).toBe('auth_failure');
    expect(error.retryable).toBe(false);
  });

  it("translates a provider's refusals into the closed failure vocabulary", async () => {
    const configuration = createOpenDataAdapter(
      provider(async () => {
        throw new OpenDataConfigurationError('bad ref');
      }),
      { http },
    );
    await expect(configuration.fetchPage(request())).rejects.toMatchObject({
      kind: 'auth_failure',
      retryable: false,
    });
    const drift = createOpenDataAdapter(
      provider(async () => {
        throw new OpenDataSchemaError('renamed field');
      }),
      { http },
    );
    await expect(drift.fetchPage(request())).rejects.toMatchObject({
      kind: 'schema_drift',
      retryable: false,
    });
  });

  it('carries positive removals with the page instant', async () => {
    const adapter = createOpenDataAdapter(
      provider(
        async () => ({
          items: [],
          removed: [{ externalType: 'product', externalId: 'gone' }],
          next: null,
          complete: false,
        }),
        false,
      ),
      { http, clock: () => new Date('2025-10-10T00:00:00Z') },
    );
    const page = await adapter.fetchPage(request({ sourceAccountRef: null }));
    expect(page.removals).toEqual([
      { externalType: 'product', externalId: 'gone', observedAt: new Date('2025-10-10T00:00:00Z') },
    ]);
  });
});
