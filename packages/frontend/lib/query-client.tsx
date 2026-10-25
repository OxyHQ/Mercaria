import type { OxyServices } from '@oxy.so/core';
import { QueryClientProvider } from '@tanstack/react-query';
import { Fragment, type ReactNode, useEffect, useMemo, useSyncExternalStore } from 'react';
import { guestCredential } from './stores/guest-credential-store';
import { portalCredential } from './stores/portal-credential-store';
import { createCommerceQueryScope } from './commerce-query-scope';

export function QueryProvider({ oxy, children }: { oxy: OxyServices; children: ReactNode }) {
  const scope = useMemo(
    () =>
      createCommerceQueryScope(
        oxy,
        [guestCredential, portalCredential].map(({ store }) => ({
          revision: () => store.getState().externalRevision,
          subscribe: (listener: () => void) => store.subscribe(listener),
        })),
      ),
    [oxy],
  );
  const { client, epoch } = useSyncExternalStore(
    scope.subscribe,
    scope.getSnapshot,
    scope.getSnapshot,
  );
  useEffect(() => () => scope.dispose(), [scope]);
  return (
    <QueryClientProvider client={client}>
      <Fragment key={epoch}>{children}</Fragment>
    </QueryClientProvider>
  );
}
