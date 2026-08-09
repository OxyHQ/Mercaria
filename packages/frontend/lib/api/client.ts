import axios from 'axios';
import { Platform } from 'react-native';
import config from '../config';
import {
  USES_HEADER_TRANSPORT,
  currentGuestToken,
  recordGuestToken,
} from '../stores/guest-credential-store';
import { currentPortalToken, recordPortalToken } from '../stores/portal-credential-store';

/**
 * The ONE HTTP client every Mercaria API call goes through.
 *
 * ## Two credentials, and they never mix (#104, ADR 0003 D2/D9)
 *
 * An Oxy bearer token when the person is signed in, and — only when they are
 * not — Mercaria's own guest credential. The server decides which one wins
 * (Oxy always does), so this layer attaches whatever it has and never chooses;
 * a client that picked would be a second precedence rule to keep in step with
 * the resolver.
 *
 * `withCredentials` is what makes the WEB half work at all: the guest
 * credential is an `HttpOnly` cookie on the API origin, so without it the
 * browser neither stores nor sends one and every signed-out cart request looks
 * like a brand-new visitor. `mercaria.co → api.mercaria.co` is same-site, so
 * `SameSite=Lax` passes it, and the backend's CORS layer already answers
 * `credentials: true` for the allow-listed origins.
 *
 * Native has no cookie jar to rely on, so it declares header transport and
 * carries the token itself. The response interceptor is where a freshly issued
 * or ROTATED token is picked up — rotation answers in kind (D3/D9), so a token
 * can change under a native client at any time and the only correct place to
 * notice is here, once, rather than in each call site.
 */
const apiClient = axios.create({
  baseURL: config.apiUrl,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
  // Web: send and accept the `__Host-mercaria_guest` cookie. Harmless on native,
  // where there is no cookie jar and the header transport is used instead.
  withCredentials: true,
});

// Token getter - will be set by AuthSetup component
let getAccessToken: (() => string | null) | null = null;

export function setTokenGetter(getter: () => string | null) {
  getAccessToken = getter;
}

/**
 * The audit-only client class a guest session is issued to (ADR 0003 D3).
 * Never authorization, never a device binding — a dimension for operators.
 */
const GUEST_CLIENT_CLASS = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

// Request interceptor: the Oxy bearer, and the guest credential's header half.
apiClient.interceptors.request.use(
  (config) => {
    if (getAccessToken) {
      const token = getAccessToken();
      if (token) {
        config.headers['Authorization'] = `Bearer ${token}`;
      }
    }

    if (USES_HEADER_TRANSPORT) {
      // Declared on EVERY request rather than only on the issuing write: the
      // server reads it only when it mints, and a client that declared it once
      // and then forgot would be handed a cookie it cannot store.
      config.headers['X-Mercaria-Guest-Transport'] = 'header';
      config.headers['X-Mercaria-Guest-Client'] = GUEST_CLIENT_CLASS;
      const guestToken = currentGuestToken();
      if (guestToken) {
        config.headers['X-Mercaria-Guest-Token'] = guestToken;
      }

      // The ORDER PORTAL credential (#108) — a second, independent header, for
      // the reason the server resolves it in a second middleware: a cart token
      // and a portal token have different scopes and different lifetimes, and
      // one header carrying either would make the server's structural scoping
      // (ADR 0003 D3/I3) a matter of which one the client happened to send.
      config.headers['X-Mercaria-Portal-Transport'] = 'header';
      const portalToken = currentPortalToken();
      if (portalToken) {
        config.headers['X-Mercaria-Portal-Token'] = portalToken;
      }
    }

    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor: pick up an issued or rotated guest token (native only).
apiClient.interceptors.response.use(
  (response) => {
    if (USES_HEADER_TRANSPORT) {
      const issued = response.headers['x-mercaria-guest-token'];
      if (typeof issued === 'string' && issued.length > 0) {
        recordGuestToken(issued);
      }
      const portalIssued = response.headers['x-mercaria-portal-token'];
      if (typeof portalIssued === 'string' && portalIssued.length > 0) {
        recordPortalToken(portalIssued);
      }
    }
    return response;
  },
  (error) => {
    // Let components handle auth errors
    return Promise.reject(error);
  }
);

/**
 * The message a failed API call should SHOW a person.
 *
 * axios rejects on any non-2xx before a caller reads the body, so the raw error
 * says `Request failed with status code 403` — which is exactly what a buyer
 * saw when the storefront started surfacing add-to-cart failures at all
 * (#104). The API's own envelope carries a human `message` beside its
 * machine-readable `error`, and this is the one place that unwraps it.
 *
 * Falls back rather than throwing: an offline request has no response body, and
 * "we could not add that to your cart" beats a network stack trace.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const body: unknown = error.response?.data;
    if (typeof body === 'object' && body !== null) {
      const message = (body as { message?: unknown }).message;
      if (typeof message === 'string' && message.length > 0) return message;
    }
    return fallback;
  }
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

export default apiClient;
