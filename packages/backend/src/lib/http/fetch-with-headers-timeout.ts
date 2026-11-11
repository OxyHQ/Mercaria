/**
 * `fetch` with a deadline on the part a bare `fetch` never bounds: connecting
 * and receiving the response headers.
 *
 * A stalled socket otherwise holds a job open forever. The timer is cleared the
 * moment headers arrive, so it does NOT cut a legitimately long body short;
 * reading the body is bounded by its own deadline at the call site (for
 * example `readResponseBody({ timeoutMs })`). Aborting from the caller's own
 * signal still works.
 */
export const DEFAULT_HEADERS_TIMEOUT_MS = 30_000;

export async function fetchWithHeadersTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_HEADERS_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init.signal;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) controller.abort(callerSignal.reason);
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`No response headers within ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}
