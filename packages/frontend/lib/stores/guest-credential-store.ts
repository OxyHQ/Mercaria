import { useStore } from 'zustand';
import { createCommerceCredential, type CommerceCredentialState } from './commerce-credential';
import { commerceStorage } from './commerce-storage';

/** Cart authority, independent from Oxy and the separately scoped order portal. */
export const guestCredential = createCommerceCredential(commerceStorage('mercaria.guest.token'));
export function useGuestCredentialStore<T>(selector: (state: CommerceCredentialState) => T): T {
  return useStore(guestCredential.store, selector);
}
export function discardGuestToken(): void {
  guestCredential.clear();
}
export function useGuestCredential() {
  const state = useStore(guestCredential.store);
  return {
    hasToken: state.token !== null,
    hydrated: state.hydrated,
    storageAvailable: state.storageAvailable,
  };
}
