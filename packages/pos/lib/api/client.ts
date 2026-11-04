import type { LinkedHttpClient, OxyServices } from '@oxy.so/core';
import axios from 'axios';
import config from '../config';

let owner: OxyServices | undefined;
let linked: LinkedHttpClient | undefined;

/** Oxy owns the session, refresh and origin fence; Axios keeps response conventions. */
const apiClient = axios.create({
  baseURL: config.apiUrl,
  timeout: 15000,
  adapter: 'fetch',
  xsrfCookieName: '',
  withXSRFToken: false,
  withCredentials: false,
  env: {
    // @ts-expect-error Axios supports null to disable Request construction; its types omit null. Preserve replayable JSON bodies.
    Request: null,
    fetch: (input, init) => {
      if (!linked) throw new Error('The Oxy provider has not bound the product API');
      if (typeof FormData !== 'undefined' && init?.body instanceof FormData) {
        const headers = new Headers(init.headers);
        headers.delete('content-type');
        return linked.fetchOptional(input, { ...init, headers });
      }
      return linked.fetchOptional(input, init);
    },
  },
});

/** Bind during provider render, before children can dispatch. */
export function bindApiClient(oxy: OxyServices): void {
  if (owner === oxy) return;
  linked?.dispose();
  owner = oxy;
  linked = oxy.createLinkedClient({ baseURL: config.apiUrl });
}

/** An obsolete provider cannot dispose the current binding. */
export function releaseApiClient(oxy: OxyServices): void {
  if (owner !== oxy) return;
  linked?.dispose();
  linked = undefined;
  owner = undefined;
}

export default apiClient;
