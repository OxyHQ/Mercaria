import { OxyServices } from '@oxyhq/core';

const OXY_API_URL = (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '');

let client: OxyServices | null | undefined;

export function oxyServiceClient(): OxyServices | null {
  if (client !== undefined) return client;
  const key = process.env.OXY_APPLICATION_KEY?.trim();
  const secret = process.env.OXY_APPLICATION_SECRET?.trim();
  if (!key || !secret) {
    client = null;
    return client;
  }
  client = new OxyServices({ baseURL: OXY_API_URL });
  client.configureServiceAuth(key, secret);
  return client;
}

export async function requiredOxyServiceToken(): Promise<string> {
  const configured = oxyServiceClient();
  if (!configured) throw new Error('Oxy application credentials are not configured');
  return configured.getServiceToken();
}

export function invalidateOxyServiceToken(): void {
  oxyServiceClient()?.invalidateServiceToken();
}

export function resetOxyServiceClientForTests(): void {
  client = undefined;
}

