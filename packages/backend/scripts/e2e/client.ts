/**
 * A thin HTTP client against the RUNNING backend.
 *
 * Deliberately not a wrapper around the services: #69's remaining unknown is
 * what happens over real sockets, and a driver that called `requestBackfill`
 * directly would skip the route, the auth middleware, the store-permission gate,
 * the rate limiter and the JSON serialization — every one of which is part of
 * what a merchant's dashboard actually exercises.
 *
 * It records the WALL-CLOCK duration of each request, because that is half the
 * evidence for acceptance 4: a `202 {status:'enqueued'}` that took as long as
 * the catalogue took to import was not enqueued.
 */

import type { Connection, SyncRun, SyncRunKind } from '@mercaria/shared-types';

/** One HTTP exchange, with the timing the queue evidence reads. */
export interface ApiResponse<T> {
  readonly status: number;
  readonly ok: boolean;
  readonly body: T | null;
  /** Wall-clock milliseconds from request start to response body read. */
  readonly durationMs: number;
  /** The error message the API returned, when it returned one. */
  readonly error: string | null;
}

/** Calls the admin channel surface as a real merchant operator would. */
export class MercariaAdminClient {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string,
    private readonly storeId: string,
  ) {}

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    const started = Date.now();
    let status = 0;
    let payload: unknown = null;

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      status = response.status;
      const text = await response.text();
      payload = text ? safeParse(text) : null;
    } catch (err) {
      return {
        status: 0,
        ok: false,
        body: null,
        durationMs: Date.now() - started,
        error: `transport: ${(err as Error).message}`,
      };
    }

    const durationMs = Date.now() - started;
    const envelope = payload as { data?: T; error?: string; message?: string } | null;
    return {
      status,
      ok: status >= 200 && status < 300,
      body: (envelope?.data ?? (payload as T)) ?? null,
      durationMs,
      error: status >= 200 && status < 300 ? null : (envelope?.error ?? envelope?.message ?? `HTTP ${status}`),
    };
  }

  /** `POST /admin/stores/:storeId/channels/woocommerce/connect-key`. */
  connectWooCommerce(input: {
    shopDomain: string;
    consumerKey: string;
    consumerSecret: string;
  }): Promise<ApiResponse<Connection>> {
    return this.call('POST', `/admin/stores/${this.storeId}/channels/woocommerce/connect-key`, input);
  }

  /**
   * `POST /admin/stores/:storeId/channels/shopify/connect`.
   *
   * Unlike `connectWooCommerce` this returns an `authorizeUrl` rather than a
   * `Connection`: Shopify is OAuth, so the connection does not exist until a
   * human has opened that URL and authorized. A driver that typed this as
   * `Connection` would be asserting a round trip it cannot make.
   */
  connectShopify(input: { shopDomain: string }): Promise<ApiResponse<{ authorizeUrl: string }>> {
    return this.call('POST', `/admin/stores/${this.storeId}/channels/shopify/connect`, input);
  }

  /** `GET /admin/stores/:storeId/channels` — connections, scopes, webhook state. */
  listChannels(): Promise<ApiResponse<Connection[]>> {
    return this.call('GET', `/admin/stores/${this.storeId}/channels`);
  }

  /** `PATCH /admin/stores/:storeId/channels/:connectionId/settings`. */
  updateSyncSettings(connectionId: string, settings: unknown): Promise<ApiResponse<Connection>> {
    return this.call(
      'PATCH',
      `/admin/stores/${this.storeId}/channels/${connectionId}/settings`,
      settings,
    );
  }

  /** `POST /admin/stores/:storeId/channels/:connectionId/sync` — answers 202. */
  requestSync(connectionId: string): Promise<ApiResponse<{ status: string; connectionId: string }>> {
    return this.call('POST', `/admin/stores/${this.storeId}/channels/${connectionId}/sync`);
  }

  /** `GET /admin/stores/:storeId/channels/:connectionId/runs` — the tallies. */
  listRuns(connectionId: string): Promise<ApiResponse<SyncRun[]>> {
    return this.call('GET', `/admin/stores/${this.storeId}/channels/${connectionId}/runs`);
  }

  /** `GET /admin/stores/:storeId/channels/readiness` — the three readiness axes. */
  readiness(): Promise<ApiResponse<unknown>> {
    return this.call('GET', `/admin/stores/${this.storeId}/channels/readiness`);
  }

  /** `POST /admin/stores/:storeId/channels/:connectionId/webhooks/reregister` (#262). */
  reregisterWebhooks(connectionId: string): Promise<ApiResponse<{ status: string }>> {
    return this.call(
      'POST',
      `/admin/stores/${this.storeId}/channels/${connectionId}/webhooks/reregister`,
    );
  }

  /** `GET /admin/stores/:storeId/products` — spot-checking what a backfill wrote. */
  listProducts(query = ''): Promise<ApiResponse<unknown>> {
    return this.call('GET', `/admin/stores/${this.storeId}/products${query}`);
  }
}

/** Parse a body without throwing on a non-JSON error page. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}

/**
 * Poll `runs` until the run of the requested KIND, started after `since`,
 * reaches a terminal status.
 *
 * Filtering on both is load-bearing rather than tidy. `runs[0]` is the NEWEST
 * run, and on a platform where product webhooks fire during a backfill (routine
 * on Shopify) that is frequently a `webhook` run which settles in milliseconds —
 * so a caller waiting on a backfill gets a plausible `completed` run that is not
 * the one it asked about, and records its tallies as the backfill's. The
 * `startedAt` floor covers the second half: a PREVIOUS run of the same kind is
 * also not the one under test.
 *
 * A run that never settles inside the budget returns `null` for the duration
 * rather than a guess, because "it was still running" and "it finished and we
 * missed it" are different facts.
 *
 * `lastReadError` is the same distinction one level down, and it exists because
 * `listRuns` never throws: a 401, a 429 or a dropped socket answers `body:
 * null`, which `Array.isArray` turns into an empty candidate list — byte for
 * byte what "the run has not appeared yet" looks like. Without it a caller that
 * exhausts its budget cannot tell a worker that never started from an API that
 * refused every poll, and will report the first while the second is true. It is
 * cleared on a settled run (the reads that mattered succeeded) and carries the
 * LAST failure otherwise, since an intermittent refusal that later succeeded is
 * not what the caller is being warned about.
 *
 * `pollIntervalMs` is a parameter rather than a constant because the two
 * drivers chose differently and both were right: the WooCommerce runner drives
 * a local site and wants the tighter loop, the Shopify driver waits up to
 * thirty minutes against a real merchant's production API, where 500 ms is
 * 1,800 requests per rate-limit window instead of 300. Defaulted to the
 * WooCommerce runner's own value, so adopting the parameter changed nothing
 * for it.
 *
 * `kind` is REQUIRED rather than optional, and that is the whole point of the
 * fix. Optional would leave the ORIGINAL bug as the default: a caller who
 * forgets it gets `runs[0]` back, wrong the moment a webhook lands mid-backfill,
 * and the failure is silent — a plausible `completed` run whose tallies get
 * recorded as another run's. Required turns "remembered" into "cannot be
 * forgotten" and makes `tsc` name every site. A caller that genuinely wants any
 * run has no value to pass, deliberately: silence meaning "any" is what makes
 * the wrong answer the default.
 */
export async function waitForTerminalRun(
  client: MercariaAdminClient,
  connectionId: string,
  since: number,
  budgetMs: number,
  kind: SyncRunKind,
  pollIntervalMs = 500,
): Promise<{ run: SyncRun | null; settledAfterMs: number | null; lastReadError: string | null }> {
  const deadline = Date.now() + budgetMs;
  let latest: SyncRun | null = null;
  let lastReadError: string | null = null;

  while (Date.now() < deadline) {
    const response = await client.listRuns(connectionId);
    lastReadError = response.ok ? null : response.error;
    const runs = Array.isArray(response.body) ? response.body : [];
    const candidates = runs.filter(
      (run) => run.kind === kind && Date.parse(run.startedAt) >= since - 1000,
    );
    latest = candidates[0] ?? null;
    if (latest && (latest.status === 'completed' || latest.status === 'failed')) {
      return { run: latest, settledAfterMs: Date.now() - since, lastReadError: null };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return { run: latest, settledAfterMs: null, lastReadError };
}
