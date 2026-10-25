import type { OxyServices } from '@oxy.so/core';
import type { createCommerceCredential } from '../stores/commerce-credential';
import type { CommerceCredentials } from './commerce-transport';

type Credential = ReturnType<typeof createCommerceCredential>;

/** Domain credentials stay independent of Oxy, but every request snapshots both authorities. */
export function createCommerceCredentials(
  oxy: OxyServices,
  {
    guestCredential,
    portalCredential,
    referralCredential,
  }: {
    guestCredential: Credential;
    portalCredential: Credential;
    referralCredential: Credential;
  },
  platform: 'web' | 'ios' | 'android',
  beforeRequest?: () => Promise<void>,
): CommerceCredentials {
  const isGuestWrite = (url: URL, method: string) =>
    !['GET', 'HEAD', 'OPTIONS'].includes(method) &&
    (url.pathname === '/guest/session' ||
      url.pathname.startsWith('/guest/session/') ||
      url.pathname === '/checkout' ||
      url.pathname === '/cart' ||
      url.pathname.startsWith('/cart/')) &&
    !oxy.http.hasAccessToken();
  return {
    async run(request, operation) {
      if (!isGuestWrite(request.url, request.method)) return operation();
      await guestCredential.ready;
      if (guestCredential.current().token) return operation();
      // Two first writes must share the first durable session, including separate tabs.
      // Reads and already-authenticated Oxy operations never acquire this issuance lock.
      return guestCredential.exclusive(async () => {
        await guestCredential.synchronize();
        return operation();
      });
    },
    async prepare({ url, method }) {
      await beforeRequest?.();
      await Promise.all([guestCredential.ready, portalCredential.ready, referralCredential.ready]);
      await Promise.all([
        guestCredential.settled(),
        portalCredential.settled(),
        referralCredential.settled(),
      ]);
      const guestState = guestCredential.current();
      const needsGuestPersistence = isGuestWrite(url, method);
      const issuesPortal =
        method === 'POST' &&
        ['/guest/orders/exchange', '/guest/orders/confirmation'].includes(url.pathname);
      if (
        (needsGuestPersistence && !guestState.storageAvailable) ||
        (issuesPortal && !portalCredential.current().storageAvailable)
      ) {
        throw new Error(
          'Secure storage is unavailable. Enable storage and reload before continuing.',
        );
      }
      const guest = guestCredential.snapshot();
      const portal = portalCredential.snapshot();
      const referral = referralCredential.snapshot();
      const headers = new Headers({
        'X-Mercaria-Guest-Transport': 'header',
        'X-Mercaria-Portal-Transport': 'header',
        'X-Mercaria-Guest-Client': platform,
      });
      if (guest.token) {
        headers.set('X-Mercaria-Guest-Token', guest.token);
        // The central CommerceActor refuses guest rotation before DB work when
        // persistence is unavailable; catalog routes and Oxy actors stay usable.
        if (!guestState.storageAvailable)
          headers.set('X-Mercaria-Guest-Persistence', 'unavailable');
      }
      if (portal.token) headers.set('X-Mercaria-Portal-Token', portal.token);
      if (referral.token) headers.set('X-Mercaria-Referral-State', referral.token);
      return {
        headers,
        isCurrent: () => guest.isCurrent() && portal.isCurrent(),
        onAuthorityChange(listener: () => void) {
          const unsubscribers = [
            guest.onAuthorityChange(listener),
            portal.onAuthorityChange(listener),
          ];
          return () => {
            for (const unsubscribe of unsubscribers) unsubscribe();
          };
        },
        async accept(response: Headers) {
          const guestApplied = guest.accept(
            response.get('X-Mercaria-Guest-Token'),
            response.get('X-Mercaria-Guest-Expires-At'),
            response.get('X-Mercaria-Guest-Generation'),
          );
          const portalApplied = portal.accept(
            response.get('X-Mercaria-Portal-Token'),
            response.get('X-Mercaria-Portal-Expires-At'),
            response.get('X-Mercaria-Portal-Generation'),
          );
          // The server clears a redeemed/dropped carrier; it never grants commerce authority.
          const referralApplied =
            response.get('X-Mercaria-Referral-State') === ''
              ? referral.accept('', null, null)
              : undefined;
          await Promise.all([
            guestCredential.settled(),
            portalCredential.settled(),
            referralCredential.settled(),
          ]);
          for (const [credential, applied] of [
            [guestCredential, guestApplied],
            [portalCredential, portalApplied],
            [referralCredential, referralApplied],
          ] as const) {
            if (applied === undefined || (await credential.persisted(applied))) continue;
            // A concurrent tab may have already stored a newer valid grant. Never
            // overwrite it or fail merely because our older CAS lost that race.
            const current = credential.current();
            if (
              current.revision > applied &&
              current.token &&
              (await credential.persisted(current.revision))
            )
              continue;
            throw new Error(
              'The commerce credential could not be saved. Enable secure storage before continuing.',
            );
          }
        },
      };
    },
  };
}
