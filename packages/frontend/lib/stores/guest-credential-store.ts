/**
 * The guest commerce credential, client side (#104, ADR 0003 D9).
 *
 * ONE opaque bearer token with one lifecycle and two carriages, and the whole
 * difference between them lives here:
 *
 *  - **Web** — the server sets `__Host-mercaria_guest`, `HttpOnly`, so this
 *    module holds NOTHING. There is nothing to store, nothing to read, and
 *    deliberately no way for JavaScript on this origin to obtain the token. The
 *    only client-side change web needs is `withCredentials` on the API client.
 *  - **Native** — the server returns the token once in the
 *    `X-Mercaria-Guest-Token` response header; it lives in `expo-secure-store`
 *    and is presented as the request header of the same name.
 *
 * ## Why a store and not a module-level `let`
 *
 * The axios interceptor needs a SYNCHRONOUS read (`getState()`), while secure
 * storage is asynchronous and the cart screen must re-render when storage turns
 * out to be unavailable. A module-level mutable binding read inside a component
 * is precisely the stale-read the React Compiler produces: it assumes purity,
 * freezes the first value and serves it forever. A zustand store gives the
 * interceptor its synchronous read and components a real subscription, with no
 * `useEffect` and no manual `useSyncExternalStore` wiring.
 *
 * ## Hydration happens at IMPORT, not in an effect
 *
 * The token must be on the first cart request, and an effect runs after the
 * first render has already committed. The module kicks its own read off when it
 * is first imported — `lib/api/client.ts` imports it, so anything that can make
 * a request has already started it — and the store's `hydrated` flag is what UI
 * waits on rather than a promise nobody holds.
 *
 * ## What NEVER happens here
 *
 * The token is never logged, never put in a URL, never sent to analytics and
 * never rendered. `expo-secure-store` and the request interceptor are its only
 * two destinations, and `useGuestCredential` deliberately exposes `hasToken`
 * rather than the token, so a component cannot leak what it cannot read.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

/** The key `expo-secure-store` keeps the native token under. */
const SECURE_STORE_KEY = 'mercaria.guest.token';

/** Header transport is native-only; web uses the `HttpOnly` cookie (D9). */
export const USES_HEADER_TRANSPORT = Platform.OS !== 'web';

interface GuestCredentialState {
  /** The native bearer token, or `null`. Always `null` on web, by construction. */
  token: string | null;
  /** Whether the initial read has finished. UI waits on this, not on a promise. */
  hydrated: boolean;
  /**
   * Whether secure storage is usable. `false` means the device refused it (a
   * locked keychain, a hostile ROM, a simulator without one), which the cart
   * screen surfaces as a recovery state rather than failing silently — the cart
   * still works for the life of the app process, it just will not survive a
   * restart.
   */
  storageAvailable: boolean;
  /** Record a token the server just issued or rotated. */
  setToken: (token: string) => void;
  /** Forget the token — after a merge revoked it, or on an explicit sign-out. */
  clearToken: () => void;
  /** Internal: the hydration result. */
  hydrate: (result: { token: string | null; storageAvailable: boolean }) => void;
}

export const useGuestCredentialStore = create<GuestCredentialState>((set) => ({
  token: null,
  // Web has nothing to hydrate: the credential is a cookie the browser holds
  // and the server reads, so the store is "ready" the moment it exists.
  hydrated: !USES_HEADER_TRANSPORT,
  storageAvailable: true,
  setToken: (token) => {
    set({ token });
    if (!USES_HEADER_TRANSPORT) return;
    void SecureStore.setItemAsync(SECURE_STORE_KEY, token).catch(() => {
      // Storage refused the write. The token stays usable in memory for this
      // process — losing the cart NOW would be worse than losing it at the next
      // launch — and the flag is what tells the buyer their cart is not durable.
      set({ storageAvailable: false });
    });
  },
  clearToken: () => {
    set({ token: null });
    if (!USES_HEADER_TRANSPORT) return;
    void SecureStore.deleteItemAsync(SECURE_STORE_KEY).catch(() => {
      // A failed delete leaves a revoked token on disk. It authorizes nothing —
      // the server revoked it — so there is nothing to escalate.
    });
  },
  hydrate: (result) => set({ ...result, hydrated: true }),
}));

/**
 * The synchronous read the axios interceptor uses. Outside React on purpose:
 * an interceptor is not a component and must not subscribe to anything.
 */
export function currentGuestToken(): string | null {
  return useGuestCredentialStore.getState().token;
}

/** Record a token the server issued or rotated on a response. */
export function recordGuestToken(token: string): void {
  useGuestCredentialStore.getState().setToken(token);
}

/** Discard the credential after the server revoked it (a completed merge). */
export function discardGuestToken(): void {
  useGuestCredentialStore.getState().clearToken();
}

/**
 * What a component may know about the credential: whether one exists and
 * whether it will survive a restart. Never the token itself.
 */
export function useGuestCredential(): {
  hasToken: boolean;
  hydrated: boolean;
  storageAvailable: boolean;
} {
  const token = useGuestCredentialStore((state) => state.token);
  const hydrated = useGuestCredentialStore((state) => state.hydrated);
  const storageAvailable = useGuestCredentialStore((state) => state.storageAvailable);
  return { hasToken: token !== null, hydrated, storageAvailable };
}

/**
 * Read the stored token once, at module load.
 *
 * Web resolves immediately with nothing to do. Native reads secure storage and,
 * if the platform refuses, marks storage unavailable rather than throwing into
 * an unhandled rejection — a device without a usable keychain must still be
 * able to shop.
 */
async function hydrateFromSecureStore(): Promise<void> {
  if (!USES_HEADER_TRANSPORT) return;
  try {
    const token = await SecureStore.getItemAsync(SECURE_STORE_KEY);
    useGuestCredentialStore.getState().hydrate({ token, storageAvailable: true });
  } catch {
    useGuestCredentialStore.getState().hydrate({ token: null, storageAvailable: false });
  }
}

void hydrateFromSecureStore();
