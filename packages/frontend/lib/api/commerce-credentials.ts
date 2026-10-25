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
      const writesGuest = isGuestWrite(url, method);
      const issuesPortal =
        method === 'POST' &&
        ['/guest/orders/exchange', '/guest/orders/confirmation'].includes(url.pathname);
      if (
        (writesGuest && !guestCredential.current().storageAvailable) ||
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
      if (guest.token) headers.set('X-Mercaria-Guest-Token', guest.token);
      if (portal.token) headers.set('X-Mercaria-Portal-Token', portal.token);
      if (referral.token) headers.set('X-Mercaria-Referral-State', referral.token);
      return {
        headers,
        async accept(response: Headers) {
          guest.accept(
            response.get('X-Mercaria-Guest-Token'),
            response.get('X-Mercaria-Guest-Expires-At'),
            response.get('X-Mercaria-Guest-Generation'),
          );
          portal.accept(
            response.get('X-Mercaria-Portal-Token'),
            response.get('X-Mercaria-Portal-Expires-At'),
            response.get('X-Mercaria-Portal-Generation'),
          );
          // The server clears a redeemed/dropped carrier; it never grants commerce authority.
          if (response.get('X-Mercaria-Referral-State') === '') referral.accept('', null, null);
          await Promise.all([
            guestCredential.settled(),
            portalCredential.settled(),
            referralCredential.settled(),
          ]);
        },
      };
    },
  };
}
