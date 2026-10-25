import { useStore } from 'zustand';
import { createCommerceCredential } from './commerce-credential';
import { commerceStorage } from './commerce-storage';

/** Order-group authority. Only explicit sign-out/claim/revocation clears it. */
export const portalCredential = createCommerceCredential(commerceStorage('mercaria.portal.token'));
export function discardPortalToken(): void {
  portalCredential.clear();
}
export function useHasPortalCredential() {
  const state = useStore(portalCredential.store);
  return { hasToken: state.token !== null, hydrated: state.hydrated };
}
