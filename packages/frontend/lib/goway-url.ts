/**
 * GoWay's web origin — where a collection point's place page lives
 * (`/place/<goWayPlaceId>`). Place facts are GoWay's (ADR 0013), so the
 * storefront links to them rather than restating them.
 *
 * Overridable with `EXPO_PUBLIC_GOWAY_WEB_URL` for a staging GoWay; the
 * default is GoWay's canonical public origin. Pure — no React Native import —
 * so the link a shopper is sent to is testable under the node runner.
 */
export const GOWAY_WEB_URL = (process.env.EXPO_PUBLIC_GOWAY_WEB_URL || 'https://goway.to').replace(/\/+$/, '');

/** A GoWay place's public page. The id is opaque: encoded, never parsed. */
export function goWayPlaceUrl(goWayPlaceId: string, origin: string = GOWAY_WEB_URL): string {
  return `${origin}/place/${encodeURIComponent(goWayPlaceId)}`;
}
