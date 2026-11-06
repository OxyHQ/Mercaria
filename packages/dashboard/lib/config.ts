import { Platform } from 'react-native';

/**
 * Centralized API + Oxy SSO configuration for the Mercaria dashboard.
 *
 * The dashboard consumes the SAME Mercaria backend API as the storefront
 * (everything relational), under the admin surface `/admin/stores/...`.
 * Priority for the API base URL:
 *   1. `EXPO_PUBLIC_API_URL` (from .env / build env)
 *   2. environment-based defaults (prod vs dev/localhost)
 */

// Default API URLs for different environments.
export const DEV_API_BASE_URL = 'http://localhost:4160';
export const PROD_API_BASE_URL = 'https://api.mercaria.co';

// Oxy IdP API base URL (the SSO provider that mints/validates sessions).
export const OXY_API_URL = process.env.EXPO_PUBLIC_OXY_API_URL ?? 'https://api.oxy.so';

/**
 * Oxy SSO client id for the Mercaria dashboard (registered via the Oxy console).
 * The `oxy_dk_` publicKey is a PUBLIC client identifier and is safe to commit;
 * it is the committed fallback used when `EXPO_PUBLIC_OXY_CLIENT_ID` is not
 * injected at build time. The dashboard is a distinct Oxy client from the
 * storefront so its sessions/approvals are scoped to the admin surface.
 */
export const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ??
  'oxy_dk_8993efc30f18b2cfd361374634df4099a63a247df675132c';

/**
 * GoWay's API origin (ADR 0013): the location editor reads and edits a store's
 * GoWay place there, with the merchant's own Oxy session. `undefined` leaves the
 * SDK on its own canonical origin; a development build points it at a local
 * GoWay with `EXPO_PUBLIC_GOWAY_API_URL`.
 */
export const GOWAY_API_URL: string | undefined = process.env.EXPO_PUBLIC_GOWAY_API_URL || undefined;

/**
 * Peable's gateway, which the payment sheet talks to with the merchant-as-payer's
 * material only (the plan session's own `client_secret`). Unset uses the SDK's
 * default, `https://api.peable.to` — the backend's `PEABLE_BASE_URL` default.
 */
export const PEABLE_GATEWAY_URL = process.env.EXPO_PUBLIC_PEABLE_GATEWAY_URL?.trim() || undefined;

/**
 * Peable's hosted checkout, which the sheet opens for the card where a native
 * build cannot host Peable's secure fields. Unset uses Peable's canonical origin.
 */
export const PEABLE_CHECKOUT_URL =
  process.env.EXPO_PUBLIC_PEABLE_CHECKOUT_URL?.trim() || 'https://checkout.peable.to';

const ENV = {
  dev: { apiUrl: DEV_API_BASE_URL },
  prod: { apiUrl: PROD_API_BASE_URL },
};

function getEnvVars(): { apiUrl: string } {
  // Priority 1: explicit EXPO_PUBLIC_API_URL.
  if (process.env.EXPO_PUBLIC_API_URL) {
    return { apiUrl: process.env.EXPO_PUBLIC_API_URL };
  }

  // Priority 2: environment-based defaults.
  if (!__DEV__) {
    return ENV.prod;
  }

  // Web in development always talks to localhost.
  if (Platform.OS === 'web') {
    return { apiUrl: DEV_API_BASE_URL };
  }

  return ENV.dev;
}

export default getEnvVars();
