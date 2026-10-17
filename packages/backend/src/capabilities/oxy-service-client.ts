import { OxyServer } from '@oxy.so/core/server';
import { oxyServiceIdentity } from './oxy-service-identity.js';

const OXY_API_URL = (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '');

let client: OxyServer | null | undefined;

/** Mercaria's Oxy service principal, or null where it has none (`oxyServiceIdentity`). */
export function oxyServiceClient(): OxyServer | null {
  if (client !== undefined) return client;
  const identity = oxyServiceIdentity();
  if (identity?.kind === 'key_pair') {
    client = new OxyServer({
      baseURL: OXY_API_URL,
      serviceAuth: { apiKey: identity.apiKey, apiSecret: identity.apiSecret },
    });
  } else if (identity?.kind === 'workload') {
    client = new OxyServer({ baseURL: OXY_API_URL });
  } else {
    client = null;
  }
  return client;
}

export async function requiredOxyServiceToken(): Promise<string> {
  const configured = oxyServiceClient();
  if (!configured)
    throw new Error(
      'Mercaria has no Oxy identity: no task role to attest and no application key pair',
    );
  return configured.serviceToken();
}

export function invalidateOxyServiceToken(): void {
  oxyServiceClient()?.invalidateServiceToken();
}

/**
 * The same identity in the shape `@peable.to/sdk` takes as `tokenProvider`.
 * Peable resolves its merchant from the token's application id and environment
 * (merchants.oxyAppId), so the task role reaches the merchant a key pair did
 * and Mercaria holds no Peable credential of its own.
 */
export const oxyServiceTokenProvider = Object.freeze({
  getToken: requiredOxyServiceToken,
  invalidate: invalidateOxyServiceToken,
});

export function resetOxyServiceClientForTests(): void {
  client = undefined;
}
