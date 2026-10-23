import type { OxyServer } from '@oxy.so/core/server';
import { oxyClient } from '../middleware/auth.js';

const OXY_API_URL = (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '');
let transport: ReturnType<OxyServer['createServiceClient']> | undefined;

/** Registered workload identity; application customer keys never become own authority. */
export function oxyServiceClient(): OxyServer {
  return oxyClient;
}

export function requiredOxyServiceClient(): OxyServer {
  return oxyClient;
}

/** Lazy so an inactive integration does not require credentials at process boot. */
export const oxyPlatformTransport = {
  fetch(input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> {
    transport ??= requiredOxyServiceClient().createServiceClient({
      baseURL: OXY_API_URL,
      audience: 'oxy-api',
    });
    return transport.fetch(input, init);
  },
};

export function resetOxyServiceClientForTests(): void {
  transport?.dispose();
  transport = undefined;
}
