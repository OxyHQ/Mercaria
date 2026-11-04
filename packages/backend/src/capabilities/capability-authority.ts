/**
 * Mercaria's half of an Oxy capability ticket: verify it, and report what was
 * done with it.
 *
 * Verification is the SDK's, built ONCE: `createLiveCapabilityTicketVerifier`
 * checks the signature against Oxy's published key set (`createOxyJwksKeyResolver`,
 * which caches it and refreshes on an unknown `kid`), the issuer, the audience
 * and the lifetime, and then asks Oxy LIVE whether it still stands behind the
 * ticket — and refuses unless Oxy's claims are byte-for-byte the signed ones. A
 * ticket revoked between planning and execution is refused however valid its
 * signature. There is no local JWKS cache, key decoding or partial claim
 * comparison here.
 *
 * The three outcomes a caller must tell apart are three error types:
 *
 * - `CapabilityTicketError` (the SDK's) — not a ticket Oxy signed for this
 *   audience, or expired: 401.
 * - {@link CapabilityTicketRevokedError} — Oxy answered, and the ticket is
 *   inactive or its policy decision denies it: 403.
 * - anything else — Oxy could not be asked (or answered something unusable):
 *   503, never a "no".
 */

import type { auditResultSchema, CapabilityTicketClaims } from '@oxy.so/contracts';
import { createLiveCapabilityTicketVerifier, createOxyJwksKeyResolver } from '@oxy.so/core/server';
import type { z } from 'zod';

import { OXY_API_URL } from '../config/oxy-identity.js';
import { oxyClient } from '../middleware/auth.js';
import { MERCARIA_CAPABILITY_CATALOG } from './mercaria.catalog.js';

type AuditResult = z.infer<typeof auditResultSchema>;

/** How long one live introspection may take before the ticket is refused as unavailable. */
const INTROSPECTION_TIMEOUT_MS = 10_000;

/** Oxy answered: the ticket is no longer active, or its policy decision denies it. */
export class CapabilityTicketRevokedError extends Error {
  constructor() {
    super('Oxy no longer stands behind this capability ticket');
    this.name = 'CapabilityTicketRevokedError';
  }
}

const verifyTicket = createLiveCapabilityTicketVerifier({
  issuer: OXY_API_URL,
  audience: MERCARIA_CAPABILITY_CATALOG.audience,
  resolvePublicKey: createOxyJwksKeyResolver({
    jwksUrl: `${OXY_API_URL}/capabilities/.well-known/jwks.json`,
  }),
  timeoutMs: INTROSPECTION_TIMEOUT_MS,
  introspect: async (ticket, { signal }) => {
    const answer = await oxyClient.agency.introspectCapabilityTicket(ticket, { signal });
    if (answer.active !== true || answer.decision?.allowed !== true) {
      throw new CapabilityTicketRevokedError();
    }
    return answer;
  },
});

/** The ticket's claims, once its signature and Oxy's live decision both stand. */
export function verifyMercariaCapabilityTicket(ticket: string): Promise<CapabilityTicketClaims> {
  return verifyTicket(ticket);
}

/** Record the outcome of an invocation with Oxy, as Mercaria's own workload. */
export async function auditMercariaCapabilityTicket(input: {
  ticket: string;
  result: AuditResult;
  rollbackSupported: boolean;
  idempotencyKeyHash?: string;
}): Promise<void> {
  await oxyClient.serviceRequest(
    'POST',
    '/capabilities/audit',
    {
      ticket: input.ticket,
      result: input.result,
      rollback: { supported: input.rollbackSupported, attempted: false },
      ...(input.idempotencyKeyHash ? { idempotencyKeyHash: input.idempotencyKeyHash } : {}),
    },
    { timeout: INTROSPECTION_TIMEOUT_MS, cache: false },
  );
}
