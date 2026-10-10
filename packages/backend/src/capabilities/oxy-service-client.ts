import { OxyServer } from '@oxy.so/core/server';

const OXY_API_URL = (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '');

let client: OxyServer | null | undefined;

export function oxyServiceClient(): OxyServer | null {
  if (client !== undefined) return client;
  const key = process.env.OXY_APPLICATION_KEY?.trim();
  const secret = process.env.OXY_APPLICATION_SECRET?.trim();
  if (!key || !secret) {
    client = null;
    return client;
  }
  client = new OxyServer({ baseURL: OXY_API_URL, serviceAuth: { apiKey: key, apiSecret: secret } });
  return client;
}

export async function requiredOxyServiceToken(): Promise<string> {
  const configured = oxyServiceClient();
  if (!configured) throw new Error('Oxy application credentials are not configured');
  return configured.serviceToken();
}

export function invalidateOxyServiceToken(): void {
  oxyServiceClient()?.invalidateServiceToken();
}

export function resetOxyServiceClientForTests(): void {
  client = undefined;
}
