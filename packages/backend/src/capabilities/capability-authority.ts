import { createPublicKey, type KeyObject } from 'node:crypto';
import {
  auditResultSchema,
  capabilityTicketClaimsSchema,
  policyDecisionSchema,
  type CapabilityTicketClaims,
} from '@oxyhq/contracts';
import { CapabilityTicketError, verifyCapabilityTicket } from '@oxyhq/core/server';
import { z } from 'zod';

import { requiredOxyServiceToken } from './oxy-service-client.js';

type AuditResult = z.infer<typeof auditResultSchema>;

const OXY_API_URL = (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '');
const JWKS_TTL_MS = 5 * 60 * 1_000;

const publicJwkSchema = z.object({
  kty: z.string(),
  crv: z.string(),
  x: z.string(),
  kid: z.string().min(1),
  use: z.string().optional(),
  alg: z.string().optional(),
});
const jwksSchema = z.object({ keys: z.array(publicJwkSchema) });
const introspectionEnvelopeSchema = z.object({
  active: z.boolean(),
  claims: z.unknown().optional(),
  decision: z.unknown().optional(),
});

let cachedKeys = new Map<string, KeyObject>();
let keysExpireAt = 0;

async function loadPublicKeys(force = false): Promise<void> {
  if (!force && cachedKeys.size > 0 && Date.now() < keysExpireAt) return;
  const response = await fetch(`${OXY_API_URL}/capabilities/.well-known/jwks.json`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Oxy capability JWKS returned ${response.status}`);
  const body = jwksSchema.parse(await response.json());
  const keys = new Map<string, KeyObject>();
  for (const jwk of body.keys) {
    keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
  }
  if (keys.size === 0) throw new Error('Oxy capability JWKS contains no keys');
  cachedKeys = keys;
  keysExpireAt = Date.now() + JWKS_TTL_MS;
}

export async function verifyMercariaCapabilityTicket(
  token: string,
): Promise<CapabilityTicketClaims> {
  await loadPublicKeys();
  const options = {
    audience: 'oxy-mercaria-api',
    issuer: OXY_API_URL,
    resolvePublicKey: (keyId: string) => cachedKeys.get(keyId),
  };
  try {
    return verifyCapabilityTicket(token, options);
  } catch (error) {
    if (!(error instanceof CapabilityTicketError) || error.code !== 'unknown_key') throw error;
    await loadPublicKeys(true);
    return verifyCapabilityTicket(token, options);
  }
}

async function authorityRequest(path: string, body: Record<string, unknown>): Promise<unknown> {
  const token = await requiredOxyServiceToken();
  const response = await fetch(`${OXY_API_URL}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Oxy capability authority returned ${response.status}`);
  return response.json();
}

/** Recalculates mutable user, account, grant, credential and app authority. */
export async function introspectMercariaCapabilityTicket(
  token: string,
  localClaims: CapabilityTicketClaims,
): Promise<boolean> {
  const envelope = introspectionEnvelopeSchema.parse(
    await authorityRequest('/capabilities/tickets/introspect', { ticket: token }),
  );
  const claims = envelope.claims === undefined
    ? undefined
    : capabilityTicketClaimsSchema.parse(envelope.claims);
  const decision = envelope.decision === undefined
    ? undefined
    : policyDecisionSchema.parse(envelope.decision);
  return envelope.active === true
    && decision?.allowed === true
    && claims?.jti === localClaims.jti
    && claims.aud === localClaims.aud
    && claims.tool === localClaims.tool
    && claims.resource.effectiveAccountId === localClaims.resource.effectiveAccountId;
}

export async function auditMercariaCapabilityTicket(input: {
  ticket: string;
  result: AuditResult;
  rollbackSupported: boolean;
  idempotencyKeyHash?: string;
}): Promise<void> {
  await authorityRequest('/capabilities/audit', {
    ticket: input.ticket,
    result: input.result,
    rollback: { supported: input.rollbackSupported, attempted: false },
    ...(input.idempotencyKeyHash ? { idempotencyKeyHash: input.idempotencyKeyHash } : {}),
  });
}

export function resetMercariaCapabilityAuthorityForTests(): void {
  cachedKeys = new Map();
  keysExpireAt = 0;
}
