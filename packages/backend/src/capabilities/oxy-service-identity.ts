import { canAttestWorkloadIdentity } from '@oxy.so/core/server';

/**
 * How Mercaria proves who it is to Oxy, or `null` where it cannot.
 *
 * On ECS the task role IS the identity (oxy ADR 0026): `oxy-mercaria-task` is
 * bound to the Mercaria application and attested whenever no key pair is
 * configured. A pair, where one is set (a laptop, a CI box), still wins. A
 * partial pair is no identity at all, never half of one.
 *
 * Its own module, apart from `oxy-service-client.ts`: config asks it at module
 * load, and many suites replace the client module with a mock — a rule config
 * depends on must not live where a test substitutes it.
 */
export type OxyServiceIdentity =
  | { kind: 'key_pair'; apiKey: string; apiSecret: string }
  | { kind: 'workload' };

export function oxyServiceIdentity(): OxyServiceIdentity | null {
  const apiKey = process.env.OXY_APPLICATION_KEY?.trim();
  const apiSecret = process.env.OXY_APPLICATION_SECRET?.trim();
  if (apiKey && apiSecret) return { kind: 'key_pair', apiKey, apiSecret };
  if (!apiKey && !apiSecret && canAttestWorkloadIdentity()) return { kind: 'workload' };
  return null;
}

export function hasOxyServiceIdentity(): boolean {
  return oxyServiceIdentity() !== null;
}
