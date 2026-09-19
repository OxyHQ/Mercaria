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
  return json(200, { success: true, data });
}

export function failure(status: number, error: string, message = 'server said no'): FakeResponse {
  return json(status, { success: false, error, message });
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
