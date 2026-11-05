import { createCommerceCredential, webCredentialStorage } from './commerce-credential';

/** Attribution carrier only; never a guest/portal/Oxy identity. Native claims no referral links. */
export const referralCredential = createCommerceCredential(
  webCredentialStorage('mercaria.referral.state'),
  Date.now,
  true,
);

export function referralMetadata(token: string): { expiry: string; generation: string } | null {
  if (!/^mrf_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 8192) return null;
  try {
    const encoded = token.slice(4).split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(encoded));
    if (
      !Number.isSafeInteger(payload.t) ||
      !Number.isSafeInteger(payload.x) ||
      payload.t < 0 ||
      payload.x <= payload.t ||
      payload.x * 1000 <= Date.now()
    )
      return null;
    return {
      expiry: new Date(payload.x * 1000).toISOString(),
      generation: String(payload.t * 1000),
    };
  } catch {
    return null;
  }
}

/** Scrub only our exact fragment before router/analytics entry modules run. */
export function captureReferralFragment(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState' | 'state'>,
  accept: (token: string, expiry: string, generation: string) => void,
): boolean {
  if (!location.hash.startsWith('#mercaria-referral=')) return false;
  const encoded = location.hash.slice('#mercaria-referral='.length);
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  try {
    const token = decodeURIComponent(encoded);
    const metadata = referralMetadata(token);
    if (metadata) accept(token, metadata.expiry, metadata.generation);
  } catch {
    /* Malformed attribution is discarded; never report its value. */
  }
  return true;
}
