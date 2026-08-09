/**
 * The guest ORDER PORTAL credential, client side (#108, ADR 0003 D9).
 *
 * `guest-credential-store.ts`'s decisions, applied to the second credential and
 * deliberately in a SECOND store rather than a second field on the first. The
 * two have different lifetimes, different scopes and different revocation
 * events — a cart token dies at sign-in, a portal token dies when its group's
 * access is secured — and one store holding both would make "clear the
 * credential" a call somebody has to remember to qualify.
 *
 *  - **Web** — the server sets `__Host-mercaria_portal`, `HttpOnly`, so this
 *    module holds NOTHING. There is nothing to store, nothing to read, and
 *    deliberately no way for JavaScript on this origin to obtain the token.
 *  - **Native** — the server returns it once in the `X-Mercaria-Portal-Token`
 *    response header; it lives in `expo-secure-store` and is presented as the
 *    request header of the same name.
 *
 * ## What NEVER happens here
 *
 * The token is never logged, never put in a URL, never sent to analytics and
 * never rendered. `useHasPortalCredential` exposes a BOOLEAN rather than the
 * token, so a component cannot leak what it cannot read.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

/** The key `expo-secure-store` keeps the native portal token under. */
const SECURE_STORE_KEY = 'mercaria.portal.token';

/** Header transport is native-only; web uses the `HttpOnly` cookie (D9). */
export const PORTAL_USES_HEADER_TRANSPORT = Platform.OS !== 'web';

interface PortalCredentialState {
  /** The native bearer token, or `null`. Always `null` on web, by construction. */
  token: string | null;
  /** Whether the initial read has finished. UI waits on this, not on a promise. */
  hydrated: boolean;
  setToken: (token: string) => void;
  clearToken: () => void;
  hydrate: (token: string | null) => void;
}

export const usePortalCredentialStore = create<PortalCredentialState>((set) => ({
  token: null,
  // Web has nothing to hydrate: the credential is a cookie the browser holds
  // and the server reads, so the store is "ready" the moment it exists.
  hydrated: !PORTAL_USES_HEADER_TRANSPORT,
  setToken: (token) => {
    set({ token });
    if (!PORTAL_USES_HEADER_TRANSPORT) return;
    void SecureStore.setItemAsync(SECURE_STORE_KEY, token).catch(() => {
      // Storage refused the write. The token stays usable in memory for this
      // process — losing access to an order NOW is worse than losing it at the
      // next launch — and a new link is always one recovery request away.
    });
  },
  clearToken: () => {
    set({ token: null });
    if (!PORTAL_USES_HEADER_TRANSPORT) return;
    void SecureStore.deleteItemAsync(SECURE_STORE_KEY).catch(() => {
      // A failed delete leaves a revoked token on disk. It authorizes nothing —
      // the server revoked it — so there is nothing to escalate.
    });
  },
  hydrate: (token) => set({ token, hydrated: true }),
}));

/**
 * The synchronous read the axios interceptor uses. Outside React on purpose: an
 * interceptor is not a component and must not subscribe to anything.
 */
export function currentPortalToken(): string | null {
  return usePortalCredentialStore.getState().token;
}

/** Record a credential the server just minted on a response. */
export function recordPortalToken(token: string): void {
  usePortalCredentialStore.getState().setToken(token);
}

/** Discard the credential after signing out of the portal. */
export function discardPortalToken(): void {
  usePortalCredentialStore.getState().clearToken();
}

/**
 * Whether this device holds a portal credential, and whether the answer is
 * settled yet. Never the token.
 *
 * On web this is always `false` even while a live `HttpOnly` cookie exists —
 * which is correct rather than a limitation: the browser holds the credential
 * and the SERVER is the only thing that can say whether it is live, so a
 * component that needs to know asks `GET /guest/orders/session` instead of
 * guessing from local state.
 */
export function useHasPortalCredential(): { hasToken: boolean; hydrated: boolean } {
  const token = usePortalCredentialStore((state) => state.token);
  const hydrated = usePortalCredentialStore((state) => state.hydrated);
  return { hasToken: token !== null, hydrated };
}

/**
 * Read the stored token once, at module load.
 *
 * `lib/api/client.ts` imports this module, so anything that can make a request
 * has already started the read — the same reason `guest-credential-store.ts`
 * hydrates at import rather than in an effect: an effect runs after the first
 * render has already committed, and the first portal request happens before
 * that.
 */
async function hydrateFromSecureStore(): Promise<void> {
  if (!PORTAL_USES_HEADER_TRANSPORT) return;
  try {
    usePortalCredentialStore.getState().hydrate(await SecureStore.getItemAsync(SECURE_STORE_KEY));
  } catch {
    usePortalCredentialStore.getState().hydrate(null);
  }
}

void hydrateFromSecureStore();
