import { Platform } from "react-native";

/**
 * Centralized API + Oxy SSO configuration for the Mercaria POS.
 *
 * The POS consumes the SAME Mercaria backend API as the storefront and the
 * dashboard (everything relational), under the admin surface
 * `/admin/stores/...`. Priority for the API base URL:
 *   1. `EXPO_PUBLIC_API_URL` (from .env / build env)
 *   2. environment-based defaults (prod vs dev/localhost)
 */

// Default API URLs for different environments.
export const DEV_API_BASE_URL = "http://localhost:3001";
export const PROD_API_BASE_URL = "https://api.mercaria.co";

// Oxy IdP API base URL (the SSO provider that mints/validates sessions).
export const OXY_API_URL =
  process.env.EXPO_PUBLIC_OXY_API_URL ?? "https://api.oxy.so";

/**
 * Oxy SSO client id for the Mercaria POS (registered via the Oxy console).
 * The `oxy_dk_` publicKey is a PUBLIC client identifier and is safe to commit;
 * it is the committed fallback used when `EXPO_PUBLIC_OXY_CLIENT_ID` is not
 * injected at build time.
 *
 * NOTE: there is no dedicated POS Oxy client registered yet, so this falls back
 * to the SAME publicKey as the dashboard. A dedicated POS Oxy client SHOULD be
 * registered in the Oxy console and injected via `EXPO_PUBLIC_OXY_CLIENT_ID` so
 * the POS register's sessions/approvals are scoped independently.
 */
export const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ??
  "oxy_dk_8993efc30f18b2cfd361374634df4099a63a247df675132c";

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
  if (Platform.OS === "web") {
    return { apiUrl: DEV_API_BASE_URL };
  }

  return ENV.dev;
}

export default getEnvVars();
