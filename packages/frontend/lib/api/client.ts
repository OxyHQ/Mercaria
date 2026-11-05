import type { OxyServices } from '@oxy.so/core';
import axios from 'axios';
import { Platform } from 'react-native';
import config from '../config';
import { guestCredential } from '../stores/guest-credential-store';
import { portalCredential } from '../stores/portal-credential-store';
import { referralCredential } from '../stores/referral-credential-store';
import { createCommerceTransport } from './commerce-transport';
import { createCommerceCredentials } from './commerce-credentials';
import { migrateLegacyReferral } from './referral-migration';

let referralMigration: Promise<void> | undefined;
let owner: OxyServices | undefined;
let transport: ReturnType<typeof createCommerceTransport> | undefined;

/** Shared Oxy identity plus independent, origin-bound commerce header credentials. */
const apiClient = axios.create({
  baseURL: config.apiUrl,
  timeout: 10000,
  adapter: 'fetch',
  withCredentials: false,
  xsrfCookieName: '',
  withXSRFToken: false,
  env: {
    // @ts-expect-error Axios supports null to preserve replayable JSON; its types omit null.
    Request: null,
    fetch: (input, init) => {
      if (!transport) throw new Error('The Oxy provider has not bound the product API');
      return transport.fetch(input, init);
    },
  },
});

export function bindApiClient(oxy: OxyServices): void {
  if (owner === oxy) return;
  transport?.dispose();
  owner = oxy;
  transport = createCommerceTransport(oxy, config.apiUrl, {
    ...createCommerceCredentials(
      oxy,
      { guestCredential, portalCredential, referralCredential },
      Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
      async () => {
        if (Platform.OS === 'web') {
          referralMigration ??= migrateLegacyReferral(config.apiUrl, referralCredential).catch(
            () => {},
          );
          await referralMigration;
        }
      },
    ),
  });
}

export function releaseApiClient(oxy: OxyServices): void {
  if (owner !== oxy) return;
  transport?.dispose();
  transport = undefined;
  owner = undefined;
}

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
