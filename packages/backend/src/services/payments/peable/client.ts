/**
 * The HTTP client for the Peable gateway.
 *
 * ## Why this exists rather than `@peable.to/sdk`
 *
 * Peable publishes a server SDK, and using it would be the obvious choice. It
 * is not used here for one concrete reason: the settling surface this adapter
 * needs — connected accounts and transfers — is newer than the published
 * version, so consuming the SDK would couple every Mercaria release to a Peable
 * `npm publish`. A thin client against a versioned HTTP contract does not.
 *
 * The trade is real and worth naming: this file has to be kept in step with the
 * gateway's contract by hand. It is small, every response is validated at the
 * boundary rather than cast, and the `peable-provider` contract suite is what
 * catches a drift.
 *
 * ## Authentication
 *
 * An Oxy SERVICE token, minted from Mercaria's own `ApplicationCredential`
 * against oxy-api and cached until shortly before expiry — the exact credential
 * `oxyClient.serviceAuth()` validates at the gateway. Re-minted reactively on a
 * 401, because a token can expire between the check and the call, and a
 * pre-emptive margin alone would make that a payment failure.
 *
 * The credential is never sent to Peable. Only the minted token is.
 */

import { config } from '../../../config/index.js';
import { log } from '../../../lib/logger.js';
import { PaymentProviderError } from '../provider.js';
import type { PaymentProviderStage } from '../provider.js';

/** Refresh this long before the minted token's stated expiry. */
const REFRESH_MARGIN_MS = 60_000;

/** How long one gateway call may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 20_000;

interface ServiceTokenEnvelope {
  readonly data: { readonly token: string; readonly expiresIn: number };
}

function isServiceTokenEnvelope(body: unknown): body is ServiceTokenEnvelope {
  if (typeof body !== 'object' || body === null || !('data' in body)) return false;
  const { data } = body as { data: unknown };
  if (typeof data !== 'object' || data === null) return false;
  const candidate = data as { token?: unknown; expiresIn?: unknown };
  return typeof candidate.token === 'string' && typeof candidate.expiresIn === 'number';
}

let cachedToken: string | null = null;
let cachedExpiresAt = 0;
let inflight: Promise<string> | null = null;

/** Drop the cached token. Test support, and what a 401 triggers. */
export function resetPeableToken(): void {
  cachedToken = null;
  cachedExpiresAt = 0;
  inflight = null;
}

async function mintToken(): Promise<string> {
  const { oxyApiUrl, publicKey, secret } = config.payments.peable;
  let response: Response;
  try {
    response = await fetch(`${oxyApiUrl}/auth/service-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: publicKey, apiSecret: secret }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    // A mint that could not reach oxy-api is RETRYABLE: nothing was charged and
    // the next attempt may well work.
    throw new PaymentProviderError({
      provider: 'peable',
      stage: 'createPayment',
      message: `could not reach Oxy to mint a service token: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      retryable: true,
    });
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isServiceTokenEnvelope(body)) {
    throw new PaymentProviderError({
      provider: 'peable',
      stage: 'createPayment',
      // A 4xx from the mint is a CREDENTIAL problem and no retry fixes it; a
      // 5xx is theirs and might.
      message: `Oxy refused to mint a service token (${String(response.status)})`,
      retryable: response.status >= 500,
    });
  }

  cachedToken = body.data.token;
  cachedExpiresAt = Date.now() + body.data.expiresIn * 1000;
  return cachedToken;
}

async function getToken(): Promise<string> {
  if (cachedToken !== null && Date.now() < cachedExpiresAt - REFRESH_MARGIN_MS) {
    return cachedToken;
  }
  // One mint in flight at a time. Without this, a burst of checkouts on a cold
  // process mints one token per request against Oxy's own rate limit.
  inflight ??= mintToken().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** What the gateway returns when it refuses. */
interface GatewayError {
  readonly error?: { readonly type?: string; readonly message?: string };
}

function messageOf(body: unknown, status: number): string {
  const candidate = body as GatewayError | undefined;
  return candidate?.error?.message ?? `the Peable gateway answered ${String(status)}`;
}

/**
 * Whether a gateway status could ever succeed on a retry.
 *
 * `409` is absent from the retryable set on purpose even though it reads like a
 * conflict: the gateway answers `200` for a converged idempotent replay, so a
 * `409` from it means a genuine conflict that a retry repeats.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

export interface GatewayRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  /**
   * The gateway operation this serves, for the error's `stage`. Not derived
   * from the path: a reader chasing a failure needs the DOMAIN word, and a
   * path-derived guess would say `transfers` for a reversal.
   */
  readonly stage: PaymentProviderStage;
  /**
   * Forwarded as `Idempotency-Key`. Every mutating call carries one, derived
   * from a durable Mercaria id — the adapter never invents one.
   */
  readonly idempotencyKey?: string;
}

/**
 * One gateway call.
 *
 * Retries the token ONCE on a 401 and nothing else. Retrying a request because
 * it failed is the outbox's job — it has a durable row, a schedule and a
 * budget; this has none of those, and a retry loop here would multiply a slow
 * gateway into a request that never returns.
 */
export async function peableRequest<T>(request: GatewayRequest): Promise<T> {
  const attempt = async (token: string): Promise<Response> => {
    try {
      return await fetch(`${config.payments.peable.baseUrl}${request.path}`, {
        method: request.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(request.idempotencyKey ? { 'Idempotency-Key': request.idempotencyKey } : {}),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new PaymentProviderError({
        provider: 'peable',
        stage: request.stage,
        message: `could not reach the Peable gateway: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        // Reaching nobody means nothing happened. Retrying is safe and is what
        // the idempotency key exists to make safe even when it DID happen.
        retryable: true,
      });
    }
  };

  let response = await attempt(await getToken());
  if (response.status === 401) {
    // The token expired between the margin check and the call, or was revoked.
    // One re-mint, then the answer stands.
    resetPeableToken();
    response = await attempt(await getToken());
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const retryable = isRetryableStatus(response.status);
    log.general.warn(
      { status: response.status, path: request.path, retryable },
      '[Peable] the gateway refused a request',
    );
    throw new PaymentProviderError({
      provider: 'peable',
      stage: request.stage,
      message: messageOf(body, response.status),
      retryable,
    });
  }
  return body as T;
}
