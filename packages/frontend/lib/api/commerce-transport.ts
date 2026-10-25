import type { OxyServices } from '@oxy.so/core';

/** Commerce credentials have their own lifecycle; they never become Oxy identity. */
interface CommerceRequest {
  url: URL;
  method: string;
}
export interface CommerceCredentials {
  run?(request: CommerceRequest, operation: () => Promise<Response>): Promise<Response>;
  prepare(request: CommerceRequest): Promise<{
    headers: Headers;
    accept(headers: Headers): void | Promise<void>;
  }>;
}

/** Shared Oxy transport owns refresh, cancellation and account isolation. */
export function createCommerceTransport(
  oxy: OxyServices,
  baseURL: string,
  credentials: CommerceCredentials,
): { fetch: typeof fetch; dispose(): void } {
  const origin = new URL(baseURL).origin;
  const linked = oxy.createLinkedClient({ baseURL });
  let disposed = false;
  return {
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), baseURL);
      if (url.origin !== origin || url.username || url.password) {
        throw new Error('Commerce credentials require the configured API origin');
      }
      const epoch = oxy.http.getSessionEpoch();
      const initiallyAuthenticated = oxy.http.hasAccessToken();
      const request = {
        url,
        method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      };
      const ended = () =>
        disposed ||
        oxy.http.getSessionEpoch() !== epoch ||
        (!initiallyAuthenticated && oxy.http.hasAccessToken());
      const perform = async () => {
        if (ended() || init?.signal?.aborted)
          throw new DOMException('The account context ended', 'AbortError');
        const snapshot = await credentials.prepare(request);
        if (ended()) {
          throw new DOMException('The account context ended', 'AbortError');
        }
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        for (const key of [
          'x-mercaria-guest-token',
          'x-mercaria-portal-token',
          'x-mercaria-referral-state',
        ])
          headers.delete(key);
        snapshot.headers.forEach((value, key) => {
          headers.set(key, value);
        });
        if (typeof FormData !== 'undefined' && init?.body instanceof FormData) {
          headers.delete('content-type');
        }
        const response = await linked.fetchOptional(input, {
          ...init,
          headers,
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
        });
        try {
          if (ended()) throw new DOMException('The account context ended', 'AbortError');
          await snapshot.accept(response.headers);
          if (ended()) throw new DOMException('The account context ended', 'AbortError');
          return response;
        } catch (error) {
          // Releasing a failed credential write must also release the response stream.
          // Cancellation is best-effort and must not replace the original failure.
          try {
            await response.body?.cancel();
          } catch {
            /* Preserve the operation error. */
          }
          throw error;
        }
      };
      return credentials.run ? credentials.run(request, perform) : perform();
    },
    dispose() {
      disposed = true;
      linked.dispose();
    },
  };
}
