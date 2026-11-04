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
    isCurrent?(): boolean;
    onAuthorityChange?(listener: () => void): () => void;
  }>;
}

/** Keep the independent domain fence until the caller consumes or cancels the body. */
function retainDomainFence(
  response: Response,
  current: () => boolean,
  release: () => void,
): Response {
  const assertCurrent = () => {
    if (!current()) throw new DOMException('The commerce authority ended', 'AbortError');
  };
  if (!response.body || typeof ReadableStream === 'undefined') {
    // Native fetch may buffer a response without exposing Web Streams. Guard its
    // consuming methods instead; no browser-only primitive is required on native.
    if ([204, 205, 304].includes(response.status)) {
      release();
      return response;
    }
    return new Proxy(response, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'clone')
          return () => {
            assertCurrent();
            return retainDomainFence(target.clone(), current, release);
          };
        if (
          ['text', 'json', 'arrayBuffer', 'blob', 'formData', 'bytes'].includes(String(property)) &&
          typeof value === 'function'
        ) {
          return async (...args: unknown[]) => {
            try {
              assertCurrent();
              const result = await value.apply(target, args);
              assertCurrent();
              return result;
            } finally {
              release();
            }
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        assertCurrent();
        const result = await reader.read();
        assertCurrent();
        if (result.done) {
          release();
          controller.close();
        } else controller.enqueue(result.value);
      } catch (error) {
        try {
          await reader.cancel(error);
        } catch {
          /* Preserve the original failure. */
        }
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
  const guarded = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  for (const property of ['url', 'redirected', 'type'] as const)
    Object.defineProperty(guarded, property, { value: response[property] });
  return guarded;
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
  const active = new Set<() => void>();
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
          'x-mercaria-guest-persistence',
        ])
          headers.delete(key);
        snapshot.headers.forEach((value, key) => {
          headers.set(key, value);
        });
        if (typeof FormData !== 'undefined' && init?.body instanceof FormData) {
          headers.delete('content-type');
        }
        const controller = new AbortController();
        const current = () =>
          !controller.signal.aborted && !ended() && (snapshot.isCurrent?.() ?? true);
        const inputSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const abort = () => controller.abort();
        let unsubscribe = () => {};
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          unsubscribe();
          inputSignal?.removeEventListener('abort', stop);
          active.delete(stop);
        };
        const stop = () => {
          abort();
          release();
        };
        active.add(stop);
        if (snapshot.onAuthorityChange) unsubscribe = snapshot.onAuthorityChange(stop);
        inputSignal?.addEventListener('abort', stop, { once: true });
        if (inputSignal?.aborted || !current()) stop();
        let response: Response | undefined;
        try {
          response = await linked.fetchOptional(input, {
            ...init,
            signal: controller.signal,
            headers,
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
          });
          if (!current()) throw new DOMException('The commerce authority ended', 'AbortError');
          await snapshot.accept(response.headers);
          if (!current()) throw new DOMException('The commerce authority ended', 'AbortError');
          return retainDomainFence(response, current, release);
        } catch (error) {
          try {
            await response?.body?.cancel();
          } catch {
            /* Preserve the operation error. */
          }
          release();
          throw error;
        }
      };
      return credentials.run ? credentials.run(request, perform) : perform();
    },
    dispose() {
      disposed = true;
      for (const stop of active) stop();
      linked.dispose();
    },
  };
}
