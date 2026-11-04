import type { OxyServices } from '@oxy.so/core';
import { QueryClient } from '@tanstack/react-query';

function createClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: 1 },
    },
  });
}

/** Product query/mutation caches never cross an Oxy context, including logout/login. */
export function createCommerceQueryScope(
  oxy: OxyServices,
  sources: Array<{
    revision(): number;
    subscribe(listener: () => void): () => void;
  }> = [],
) {
  let observedEpoch = oxy.http.getSessionEpoch();
  let authenticatedInEpoch = oxy.http.hasAccessToken();
  const context = () => {
    const epoch = oxy.http.getSessionEpoch();
    if (epoch !== observedEpoch) {
      observedEpoch = epoch;
      authenticatedInEpoch = false;
    }
    // First sign-in may populate an initially anonymous epoch. A transient 401 refresh
    // clear within that same epoch must not reset the established account cache.
    authenticatedInEpoch ||= oxy.http.hasAccessToken();
    return [epoch, authenticatedInEpoch, ...sources.map((source) => source.revision())].join(':');
  };
  let current = { epoch: context(), client: createClient() };
  function getSnapshot() {
    const epoch = context();
    if (epoch !== current.epoch) {
      void current.client.cancelQueries();
      current.client.clear();
      current = { epoch, client: createClient() };
    }
    return current;
  }
  return {
    getSnapshot,
    subscribe(listener: () => void) {
      const changed = () => {
        const previous = current;
        if (getSnapshot() !== previous) listener();
      };
      const subscriptions = [
        oxy.http.addTokenChangeListener(changed),
        ...sources.map((source) => source.subscribe(changed)),
      ];
      return () => {
        for (const unsubscribe of subscriptions) unsubscribe();
      };
    },
    dispose() {
      void current.client.cancelQueries();
      current.client.clear();
    },
  };
}
