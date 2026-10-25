import type { OxyServices } from '@oxy.so/core';

/** Commerce credentials have their own lifecycle; they never become Oxy identity. */
export interface CommerceCredentials {
  prepare(): Promise<{
    headers: Headers;
    accept(headers: Headers): void;
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
      const snapshot = await credentials.prepare();
      if (disposed || oxy.http.getSessionEpoch() !== epoch) {
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
      if (disposed || oxy.http.getSessionEpoch() !== epoch) {
        await response.body?.cancel();
        throw new DOMException('The account context ended', 'AbortError');
      }
      snapshot.accept(response.headers);
      return response;
    },
    dispose() {
      disposed = true;
      linked.dispose();
    },
  };
}
