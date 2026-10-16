import { canAttestWorkloadIdentity, OxyServer } from '@oxy.so/core/server';

const OXY_API_URL = (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '');

let client: OxyServer | null | undefined;

/**
 * Mercaria's Oxy service principal, or null where it has none.
 *
 * On ECS the task role IS the identity (oxy ADR 0026): `oxy-mercaria-task` is
 * bound to the Mercaria application, and `serviceToken()` attests it whenever
 * no key pair is configured. A pair, where one is set (a laptop, a CI box),
 * still wins. A partial pair is no identity at all, never half of one.
 */
export function oxyServiceClient(): OxyServer | null {
  if (client !== undefined) return client;
  const key = process.env.OXY_APPLICATION_KEY?.trim();
  const secret = process.env.OXY_APPLICATION_SECRET?.trim();
  if (key && secret) {
    client = new OxyServer({
      baseURL: OXY_API_URL,
      serviceAuth: { apiKey: key, apiSecret: secret },
    });
  } else if (!key && !secret && canAttestWorkloadIdentity()) {
    client = new OxyServer({ baseURL: OXY_API_URL });
  } else {
    client = null;
  }
  return client;
}

/**
 * Whether Mercaria HAS an Oxy service identity — the same rule as
 * {@link oxyServiceClient}, without building or caching a client, so config can
 * ask it at module load.
 */
export function hasOxyServiceIdentity(): boolean {
  const key = process.env.OXY_APPLICATION_KEY?.trim();
  const secret = process.env.OXY_APPLICATION_SECRET?.trim();
  if (key && secret) return true;
  return !key && !secret && canAttestWorkloadIdentity();
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
