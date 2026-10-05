import {
  createMercariaClient,
  type MercariaClient,
  type MercariaClientOptions,
  type MercariaFetchInit,
} from '../src/index';

/** One request the fetch double received. */
export interface RecordedRequest {
  url: string;
  init: MercariaFetchInit;
}

export interface FakeResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

export function json(status: number, value: unknown, headers: Record<string, string> = {}): FakeResponse {
  return { status, body: JSON.stringify(value), headers: { 'content-type': 'application/json', ...headers } };
}

export function ok(data: unknown): FakeResponse {
  return json(200, data);
}

/** A contract error body: `{ error: { code, message, details? } }`. */
export function failure(
  status: number,
  code: string,
  message = 'server said no',
  details?: Record<string, string | number | boolean | null>,
): FakeResponse {
  return json(status, { error: details === undefined ? { code, message } : { code, message, details } });
}

/** A real WHATWG `Response`, so the transport is exercised against the genuine interface. */
function toResponse(fake: FakeResponse): Response {
  const status = fake.status ?? 200;
  // A `Response` with a body is not allowed for these statuses.
  const body = status === 204 || status === 304 ? null : (fake.body ?? '');
  return new Response(body, { status, headers: fake.headers ?? {} });
}

/**
 * A client whose fetch answers from `respond`, recording every call. No
 * network is ever touched.
 */
export function fakeClient(
  respond: (request: RecordedRequest) => FakeResponse | Promise<FakeResponse> = () => ok(null),
  options: Omit<MercariaClientOptions, 'fetch'> = {},
): { client: MercariaClient; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const client = createMercariaClient({
    ...options,
    fetch: async (url, init) => {
      const recorded = { url, init };
      requests.push(recorded);
      return toResponse(await respond(recorded));
    },
  });
  return { client, requests };
}

/** Await a promise expected to reject, and return what it rejected with. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}
