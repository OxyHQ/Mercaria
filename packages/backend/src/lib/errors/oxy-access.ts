/**
 * How a read of Oxy made AS the person behind a request failed — the ONE
 * reading of that, for every caller.
 *
 * It is the SDK's outcome mapping (`OxyAccessError` / `accessErrorStatus`): a
 * 401 means the session is gone, a 403 or 404 is Oxy's definitive "no", and
 * everything else — a 5xx, a timeout, a dropped connection, a malformed answer —
 * is Oxy being unavailable, which a caller answers 503 and never caches or reads
 * as a "no". `oxyClient.accountAccessFor` already throws `OxyAccessError`; a call
 * through `oxyClient.withUser` rejects with the raw `OxyApiError`, which is
 * mapped the same way here.
 */

import { OxyApiError } from '@oxy.so/core';
import { OxyAccessError } from '@oxy.so/core/server';

export type OxyAccessOutcome = 'session_required' | 'denied' | 'unavailable';

export function oxyAccessOutcome(error: unknown): OxyAccessOutcome {
  if (error instanceof OxyAccessError) {
    if (error.code === 'ACCESS_SESSION_REQUIRED') return 'session_required';
    return error.code === 'ACCESS_DENIED' ? 'denied' : 'unavailable';
  }
  const status = error instanceof OxyApiError ? error.status : undefined;
  if (status === 401) return 'session_required';
  if (status === 403 || status === 404) return 'denied';
  return 'unavailable';
}
