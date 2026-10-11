import { createGoWayClient, type GoWayClient } from '@goway.to/sdk';

/**
 * The storefront's GoWay client — the ONE place it is built.
 *
 * Where a shop front IS — its name, address, hours, photos, rating — is the
 * GoWay place's (ADR 0013), so the storefront reads it from GoWay with
 * `@goway.to/sdk` and links to GoWay's own page for the rest. Every read here
 * is PUBLIC: no token is attached, because browsing a store, like GoWay's own
 * map, must work signed out.
 *
 * Both origins are configuration: `EXPO_PUBLIC_GOWAY_API_URL` and
 * `EXPO_PUBLIC_GOWAY_WEB_URL` point a build at a local or staging GoWay, and
 * unset leaves the SDK on GoWay's own canonical origins. Pure — no React
 * Native import — so the link a shopper is sent to is testable under the node
 * runner.
 */
export const GOWAY_API_URL: string | undefined = process.env.EXPO_PUBLIC_GOWAY_API_URL || undefined;
export const GOWAY_WEB_URL: string | undefined = process.env.EXPO_PUBLIC_GOWAY_WEB_URL || undefined;

/** A client on the given origins; the configured ones by default. */
export function createStorefrontGoWayClient(
  origins: { apiBaseUrl?: string; webBaseUrl?: string } = {
    apiBaseUrl: GOWAY_API_URL,
    webBaseUrl: GOWAY_WEB_URL,
  },
): GoWayClient {
  return createGoWayClient({
    ...(origins.apiBaseUrl === undefined ? {} : { apiBaseUrl: origins.apiBaseUrl }),
    ...(origins.webBaseUrl === undefined ? {} : { webBaseUrl: origins.webBaseUrl }),
  });
}

export const goWayClient: GoWayClient = createStorefrontGoWayClient();

/** A GoWay place's public page — the SDK's canonical link. The id is opaque: encoded, never parsed. */
export function goWayPlaceUrl(goWayPlaceId: string): string {
  return goWayClient.links.place(goWayPlaceId);
}
