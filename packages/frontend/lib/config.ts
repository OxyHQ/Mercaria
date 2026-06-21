import { Platform } from 'react-native';

/**
 * Centralized API configuration
 * Priority:
 * 1. EXPO_PUBLIC_API_URL environment variable (from .env)
 * 2. Fallback to environment-based defaults
 */

// Default API URLs for different environments
export const DEV_API_BASE_URL = 'http://localhost:3001';
export const STAGING_API_BASE_URL = 'https://staging-api.mercaria.co';
export const PROD_API_BASE_URL = 'https://api.mercaria.co';

// Oxy SSO client id for Mercaria (registered via seed-oxy-applications.ts).
// The oxy_dk_ publicKey is a public client identifier and is safe to commit; it is
// the committed fallback used when EXPO_PUBLIC_OXY_CLIENT_ID is not injected at build.
export const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ??
  'oxy_dk_8993efc30f18b2cfd361374634df4099a63a247df675132c';

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
