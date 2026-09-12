import { describe, expect, it } from 'vitest';
import {
  isMercariaError,
  MercariaAbortError,
  MercariaApiError,
  MercariaError,
  MercariaForbiddenError,
  MercariaGoneError,
  MercariaNetworkError,
  MercariaNotFoundError,
  MercariaRateLimitError,
  MercariaResponseError,
  MercariaTimeoutError,
  MercariaUnauthorizedError,
  MercariaUnavailableError,
  MercariaValidationError,
} from '../src/index';
import { parseRetryAfterSeconds } from '../src/transport';
import { productWire } from './fixtures';
import { failure, fakeClient, json, ok, rejection, type FakeResponse } from './helpers';

const SECRET = 'tok_super_secret_value';

async function errorFor(response: FakeResponse): Promise<MercariaError> {
  const { client } = fakeClient(() => response, { getAccessToken: () => SECRET });
  const error = await rejection(client.products.get('prod_1'));
  expect(isMercariaError(error)).toBe(true);
  return error as MercariaError;
}

function assertNoSecret(error: unknown): void {
  expect(String(error)).not.toContain(SECRET);
  expect(JSON.stringify(error)).not.toContain(SECRET);
  expect((error as Error).message).not.toContain(SECRET);
  expect((error as Error).stack ?? '').not.toContain(SECRET);
}

describe('HTTP status and envelope mapping', () => {
  it.each([
    [400, 'VALIDATION_ERROR', MercariaValidationError, false],
    [401, 'UNAUTHORIZED', MercariaUnauthorizedError, false],
    [403, 'FORBIDDEN', MercariaForbiddenError, false],
    [404, 'NOT_FOUND', MercariaNotFoundError, false],
    [410, 'GONE', MercariaGoneError, false],
    [429, 'RATE_LIMITED', MercariaRateLimitError, true],
    [500, 'INTERNAL_ERROR', MercariaUnavailableError, true],
    [503, 'SERVICE_UNAVAILABLE', MercariaUnavailableError, true],
  ] as const)('%i %s envelope → %o', async (status, code, ErrorClass, retryable) => {
    const error = await errorFor(failure(status, code, 'the reason'));
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.retryable).toBe(retryable);
    expect(error.message).toContain('the reason');
    assertNoSecret(error);
  });

  it('distinguishes not found, gone and unavailable without reading strings', async () => {
    const notFound = await errorFor(failure(404, 'NOT_FOUND'));
    const gone = await errorFor(failure(410, 'GONE'));
    const down = await errorFor({ status: 503, body: '<html>Service Unavailable</html>' });
    expect([notFound, gone, down].map((error) => error.constructor.name)).toEqual([
      'MercariaNotFoundError',
      'MercariaGoneError',
      'MercariaUnavailableError',
    ]);
    expect(notFound).not.toBeInstanceOf(MercariaGoneError);
    expect(gone).not.toBeInstanceOf(MercariaNotFoundError);
  });

  it('treats a 429 with a plain-text body as rate limited, with Retry-After seconds', async () => {
    const error = await errorFor({
      status: 429,
      body: 'Too many requests, please try again later.',
      headers: { 'content-type': 'text/plain', 'Retry-After': '37' },
    });
    expect(error).toBeInstanceOf(MercariaRateLimitError);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryable).toBe(true);
    expect((error as MercariaRateLimitError).retryAfterSeconds).toBe(37);
    expect(error.message).not.toContain('Too many requests');
    expect(error.toJSON()).toMatchObject({ retryAfterSeconds: 37 });
  });

  it('falls back to RateLimit-Reset, then the combined RateLimit header, then null', () => {
    const headers = (entries: Record<string, string>) => new Headers(entries);
    expect(parseRetryAfterSeconds(headers({ 'RateLimit-Reset': '12' }))).toBe(12);
    expect(parseRetryAfterSeconds(headers({ RateLimit: 'limit=100, remaining=0, reset=9' }))).toBe(9);
    expect(parseRetryAfterSeconds(headers({ 'Retry-After': 'Wed, 21 Oct 2015 07:28:10 GMT' }), Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))).toBe(10);
    expect(parseRetryAfterSeconds(headers({ 'Retry-After': 'soon' }))).toBeNull();
    expect(parseRetryAfterSeconds(headers({}))).toBeNull();
  });

  it('maps a 500 without an envelope to unavailable', async () => {
    const error = await errorFor({ status: 500, body: 'Internal Server Error' });
    expect(error).toBeInstanceOf(MercariaUnavailableError);
    expect(error.code).toBe('SERVICE_UNAVAILABLE');
    expect(error.retryable).toBe(true);
  });

  it('maps a 502 HTML proxy page to unavailable and never copies the body', async () => {
    const html = '<html><body><h1>502 Bad Gateway</h1><p>nginx internal detail</p></body></html>';
    const error = await errorFor({ status: 502, body: html, headers: { 'content-type': 'text/html' } });
    expect(error).toBeInstanceOf(MercariaUnavailableError);
    expect(error.status).toBe(502);
    expect(error.message).not.toContain('nginx');
    expect(error.message).not.toContain('<');
  });

  it('does NOT conclude not-found or gone from a bare 404/410 without a Mercaria body', async () => {
    for (const status of [404, 410]) {
      const error = await errorFor({ status, body: '<html>Not Found</html>' });
      expect(error).toBeInstanceOf(MercariaApiError);
      expect(error).not.toBeInstanceOf(MercariaNotFoundError);
      expect(error).not.toBeInstanceOf(MercariaGoneError);
      expect(error.code).toBe('HTTP_ERROR');
      expect(error.retryable).toBe(false);
    }
  });

  it('keeps an unknown server code out of `code` and falls back to the status', async () => {
    const error = await errorFor(failure(403, 'SOME_PRIVATE_CODE'));
    expect(error).toBeInstanceOf(MercariaForbiddenError);
    expect(error.code).toBe('FORBIDDEN');
  });

  it('maps 501 and other statuses to a non-retryable API error', async () => {
    const notImplemented = await errorFor({ status: 501, body: '' });
    const conflict = await errorFor({ status: 409, body: '' });
    expect(notImplemented).toBeInstanceOf(MercariaApiError);
    expect(notImplemented.retryable).toBe(false);
    expect(conflict).toBeInstanceOf(MercariaApiError);
    expect(conflict.status).toBe(409);
  });

  it('bounds and flattens a server message', async () => {
    const error = await errorFor(failure(400, 'VALIDATION_ERROR', `line one\nline two ${'x'.repeat(500)}`));
    expect(error.message).not.toContain('\n');
    expect(error.message.length).toBeLessThan(300);
  });

  it('ignores a non-string server message', async () => {
    const error = await errorFor(json(400, { success: false, error: 'VALIDATION_ERROR', message: { stack: 'at x' } }));
    expect(error.message).toBe('Mercaria API responded with HTTP 400');
  });
});

describe('malformed success responses', () => {
  it.each([
    ['an empty body', { status: 200, body: '' }],
    ['invalid JSON', { status: 200, body: '{"success": tru' }],
    ['a JSON array', json(200, [])],
    ['no envelope', json(200, productWire())],
    ['success:false on a 200', json(200, { success: false, error: 'NOT_FOUND', message: 'nope' })],
    ['success without data', json(200, { success: true })],
    ['an invalid DTO', ok({ ...productWire(), availability: 'discontinued' })],
  ] as const)('%s → MercariaResponseError', async (_name, response) => {
    const error = await errorFor(response);
    expect(error).toBeInstanceOf(MercariaResponseError);
    expect(error.code).toBe('MALFORMED_RESPONSE');
    expect(error.status).toBe(200);
    expect(error.retryable).toBe(false);
    assertNoSecret(error);
  });

  it('names the offending field path, not its value', async () => {
    const wire = productWire();
    (wire.price as Record<string, unknown>).currency = 'DOGE_SECRET_VALUE';
    const error = await errorFor(ok(wire));
    expect(error.message).toContain('data.price.currency');
    expect(error.message).not.toContain('DOGE_SECRET_VALUE');
  });

  it('treats an empty error body as an error for its status', async () => {
    const error = await errorFor({ status: 503, body: '' });
    expect(error).toBeInstanceOf(MercariaUnavailableError);
  });
});

describe('network failure, abort and timeout', () => {
  it('wraps a fetch that throws as a retryable network error with the cause kept out of JSON', async () => {
    const cause = new TypeError(`fetch failed ${SECRET}`);
    const { client } = fakeClient(
      () => {
        throw cause;
      },
      { getAccessToken: () => SECRET },
    );
    const error = (await rejection(client.products.get('prod_1'))) as MercariaNetworkError;
    expect(error).toBeInstanceOf(MercariaNetworkError);
    expect(error).not.toBeInstanceOf(MercariaTimeoutError);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.status).toBeNull();
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(cause);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(String(error)).not.toContain(SECRET);
    expect(Object.keys(error)).not.toContain('cause');
  });

  it('refuses an already-aborted signal without calling the token getter or fetch', async () => {
    let getterCalls = 0;
    const { client, requests } = fakeClient(() => ok(productWire()), {
      getAccessToken: () => {
        getterCalls += 1;
        return SECRET;
      },
    });
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(client.products.get('prod_1', { signal: controller.signal }));
    expect(error).toBeInstanceOf(MercariaAbortError);
    expect((error as MercariaAbortError).retryable).toBe(false);
    expect(getterCalls).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it('aborts an in-flight request, even when fetch ignores the signal', async () => {
    const controller = new AbortController();
    const { client, requests } = fakeClient(() => new Promise<FakeResponse>(() => undefined));
    const pending = client.products.get('prod_1', { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init.signal?.aborted).toBe(false);
    controller.abort();
    const error = await rejection(pending);
    expect(error).toBeInstanceOf(MercariaAbortError);
    expect(requests[0]?.init.signal?.aborted).toBe(true);
  });

  it('aborts while the token getter is still pending', async () => {
    const controller = new AbortController();
    const { client, requests } = fakeClient(() => ok(productWire()), {
      getAccessToken: () => new Promise<string>(() => undefined),
    });
    const pending = client.products.get('prod_1', { signal: controller.signal });
    controller.abort();
    expect(await rejection(pending)).toBeInstanceOf(MercariaAbortError);
    expect(requests).toHaveLength(0);
  });

  it('times out as a retryable network error', async () => {
    const { client } = fakeClient(() => new Promise<FakeResponse>(() => undefined), { timeoutMs: 20 });
    const error = (await rejection(client.products.get('prod_1'))) as MercariaTimeoutError;
    expect(error).toBeInstanceOf(MercariaTimeoutError);
    expect(error).toBeInstanceOf(MercariaNetworkError);
    expect(error.code).toBe('TIMEOUT');
    expect(error.retryable).toBe(true);
  });

  it('succeeds normally with a signal that never fires, and detaches from it', async () => {
    const controller = new AbortController();
    const { client } = fakeClient(() => ok(productWire()));
    await client.products.get('prod_1', { signal: controller.signal });
    controller.abort();
  });
});

describe('the error classes', () => {
  it('carry names, codes and prototypes a consumer can rely on', () => {
    const error = new MercariaGoneError('gone', { status: 410 });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(MercariaError);
    expect(error).toBeInstanceOf(MercariaGoneError);
    expect(error).not.toBeInstanceOf(MercariaNotFoundError);
    expect(error.name).toBe('MercariaGoneError');
    expect(error.code).toBe('GONE');
    expect(String(error)).toBe('MercariaGoneError: gone');
    expect(error.toJSON()).toEqual({ name: 'MercariaGoneError', code: 'GONE', status: 410, retryable: false, message: 'gone' });
  });

  it('answer instanceof across two copies of the package (ESM beside CJS)', () => {
    // A second copy has its own class objects. Simulate one: a class with the
    // same brand but a different identity must still be recognised, and a
    // plain Error must not.
    const LINEAGE = Symbol.for('@mercaria.co/sdk:error-lineage');
    const foreign = Object.assign(new Error('from the other copy'), {
      [LINEAGE]: ['MercariaTimeoutError', 'MercariaNetworkError', 'MercariaError'],
    });
    expect(foreign).toBeInstanceOf(MercariaTimeoutError);
    expect(foreign).toBeInstanceOf(MercariaNetworkError);
    expect(isMercariaError(foreign)).toBe(true);
    expect(foreign).not.toBeInstanceOf(MercariaAbortError);
    expect(new Error('plain')).not.toBeInstanceOf(MercariaError);
    expect(isMercariaError({ code: 'GONE' })).toBe(false);
  });

  it('lets a consumer construct them for its own tests', () => {
    const error = new MercariaRateLimitError('slow down', { status: 429, retryAfterSeconds: 3 });
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(3);
    expect(new MercariaUnavailableError('down').retryable).toBe(true);
    expect(new MercariaApiError('x', { code: undefined }).code).toBe('HTTP_ERROR');
  });
});
