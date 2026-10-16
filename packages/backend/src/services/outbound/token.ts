/**
 * The opaque outbound token — `mox_<payload>.<signature>` (#67 outbound rule 1).
 *
 * ## Why there is nothing to get wrong here
 *
 * The requirement is that "the token cannot encode or accept an arbitrary
 * destination URL". That is not a validation performed below; it is the shape
 * of {@link AffiliateOutboundTokenClaims}, which has ONE member and it is an
 * offer id. There is no field a URL could arrive in, so the open-redirect
 * question is settled before any code in this file runs.
 *
 * What the signature buys is narrower and worth stating so nobody mistakes it
 * for the security property: it stops a stranger minting a token naming a
 * GUESSED offer id, so nothing unsigned ever reaches a database read. The
 * `referral_links` token makes the same distinction one domain over, and the
 * construction is deliberately identical — HMAC-SHA256 over a base64url payload,
 * compared with `verifySecret` in constant time — because two spellings of one
 * mechanism in one repository is how the weaker one gets copied next.
 *
 * ## No expiry inside the token
 *
 * An outbound token sits in a rendered page and in a shared link, and its
 * lifecycle questions — is the offer still active, still fresh, still permitted
 * to link out — all belong to rows that change independently of it. Baking a
 * deadline in would answer a question no reader is asking and would make a
 * cached page's link fail for a reason unrelated to why it should fail. The
 * gate re-derives all of it per click.
 *
 * The `nonce` is not a lifetime and not a session. It makes two tokens for one
 * offer differ, so a token is not a guessable FUNCTION of an offer id — without
 * it, anybody holding one token could compute every other.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { verifySecret } from '@oxy.so/core/server';
import { z } from 'zod';
import {
  AFFILIATE_OUTBOUND_TOKEN_PREFIX,
  type AffiliateOutboundTokenClaims,
} from '@mercaria/shared-types';
import { derivedSecret } from '../../lib/derived-secrets.js';
import { validationError } from '../../lib/errors/error-codes.js';

/**
 * The signed payload. `.strict()`, so a token carrying an extra key is refused
 * rather than having it stripped — a key nobody declared is a defect in
 * whatever minted it, and accepting the rest would ship that defect.
 */
const tokenPayloadSchema = z
  .object({
    offerId: z.string().min(1),
    nonce: z.string().min(1),
  })
  .strict();

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * Sign a payload under the outbound-token key, derived from
 * `MERCARIA_SECRET_KEY` under its own purpose (`lib/derived-secrets.ts`) — so
 * it is never empty and never shared with the referral link token's key.
 */
function sign(payloadB64: string): string {
  return createHmac('sha256', derivedSecret('outbound-token'))
    .update(payloadB64)
    .digest('base64url');
}

/** Mint a token naming one offer. The offer is the WHOLE of what it says. */
export function mintAffiliateOutboundToken(params: { offerId: string }): string {
  const payload = { offerId: params.offerId, nonce: randomBytes(12).toString('hex') };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${AFFILIATE_OUTBOUND_TOKEN_PREFIX}${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Verify a token and return its claims.
 *
 * @throws `validationError` on anything malformed or unsigned. The caller turns
 *   every throw into ONE indistinguishable refusal — a distinguishable answer
 *   would let somebody probe which offer ids exist.
 */
export function verifyAffiliateOutboundToken(token: string): AffiliateOutboundTokenClaims {
  if (!token.startsWith(AFFILIATE_OUTBOUND_TOKEN_PREFIX)) {
    // The prefix is a SHAPE GATE, checked before any hashing: a `mgs_` cart
    // credential or an `mgp_` portal credential presented here fails on its
    // spelling rather than on a comparison, which is #108's rule about keeping
    // two credential kinds structurally apart.
    throw validationError('Malformed outbound token');
  }
  const body = token.slice(AFFILIATE_OUTBOUND_TOKEN_PREFIX.length);
  const parts = body.split('.');
  if (parts.length !== 2) {
    throw validationError('Malformed outbound token');
  }
  const [payloadB64, providedSig] = parts;
  if (!verifySecret(providedSig, sign(payloadB64))) {
    throw validationError('Outbound token signature mismatch');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw validationError('Malformed outbound token payload');
  }
  const parsed = tokenPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw validationError('Malformed outbound token payload');
  }
  return { offerId: parsed.data.offerId };
}
