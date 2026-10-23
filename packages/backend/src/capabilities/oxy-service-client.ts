import { canAttestWorkloadIdentity, OxyServer } from '@oxy.so/core/server';

const OXY_API_URL = (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '');
let client: OxyServer | null | undefined;
let transport: ReturnType<OxyServer['createServiceClient']> | undefined;

/** Registered workload identity; application customer keys never become own authority. */
export function oxyServiceClient(): OxyServer | null {
  if (client === undefined) {
    client = canAttestWorkloadIdentity() ? new OxyServer({ baseURL: OXY_API_URL }) : null;
  }
  return client;
}

export function requiredOxyServiceClient(): OxyServer {
  const configured = oxyServiceClient();
  if (!configured) throw new Error('Mercaria has no attestable Oxy workload identity');
  return configured;
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
  client?.dispose();
  client = undefined;
}
