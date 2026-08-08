import { Platform } from 'react-native';

/**
 * Centralized API configuration
 * Priority:
 * 1. EXPO_PUBLIC_API_URL environment variable (from .env)
 * 2. Fallback to environment-based defaults
 */

// Default API URLs for different environments
export const DEV_API_BASE_URL = 'http://localhost:4160';
export const STAGING_API_BASE_URL = 'https://staging-api.mercaria.co';
export const PROD_API_BASE_URL = 'https://api.mercaria.co';

// Oxy SSO client id for Mercaria (registered via seed-oxy-applications.ts).
// The oxy_dk_ publicKey is a public client identifier and is safe to commit; it is
// the committed fallback used when EXPO_PUBLIC_OXY_CLIENT_ID is not injected at build.
export const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ??
  'oxy_dk_8993efc30f18b2cfd361374634df4099a63a247df675132c';

/**
 * Stripe's publishable key — a PUBLIC value, safe in a client bundle by design.
 *
 * The FALLBACK, not the source of truth. The checkout response carries the key
 * belonging to the account that actually created the payment, and that one wins:
 * a client secret confirmed against a different account's key fails with a
 * mismatched-intent error that reads as a client bug. This is what the payment
 * step uses when the server sends none.
 *
 * Empty when unset, which the payment step treats as "cards are unavailable" and
 * renders honestly rather than initialising a payment sheet that cannot work.
 */
export const STRIPE_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';

const ENV = {
  dev: {
    apiUrl: DEV_API_BASE_URL,
  },
  staging: {
    apiUrl: STAGING_API_BASE_URL,
  },
  prod: {
    apiUrl: PROD_API_BASE_URL,
  },
};

const getEnvVars = () => {
  // Priority 1: Use EXPO_PUBLIC_API_URL if set in .env
  if (process.env.EXPO_PUBLIC_API_URL) {
    return {
      apiUrl: process.env.EXPO_PUBLIC_API_URL,
    };
  }

  // Priority 2: Use environment-based defaults
  const env = __DEV__ ? 'development' : 'production';

  if (env === 'production') {
    return ENV.prod;
  }

  // For web platform in development, always use localhost
  if (Platform.OS === 'web' && __DEV__) {
    return {
      apiUrl: DEV_API_BASE_URL,
    };
  }

  return ENV.dev;
};

export default getEnvVars();
