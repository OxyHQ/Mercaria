/**
 * How an abuse counter's subject is named (#111 abuse control 2).
 *
 * ## The keyed digest, and why the SCOPE is in the preimage
 *
 * Every counter subject is `HMAC-SHA-256(key, scope + ':' + axis + ':' +
 * value)`. The key makes it useless to somebody who has the table but not the
 * secret; the SCOPE and AXIS in the preimage make it useless to somebody who
 * has both.
 *
 * That second half is the part worth reading. With a bare
 * `HMAC(key, emailHash)` the same digest would appear under `recovery_request`
 * and under `claim_attempt`, so anybody holding the key could join a person's
 * recovery attempts to their claim attempts — a per-person activity profile
 * assembled out of two rate limiters. Putting the scope in the preimage makes
 * the two digests different values, so the counters bound each action
 * independently and compose into nothing.
 *
 * ## A COARSE network range, never an address
 *
 * `networkRangeOf` truncates to a /24 or a /64 before hashing. #108 chose the
 * same width for the same reason: it bounds a flood and identifies nobody, and
 * the alternative — a per-address counter — makes one carrier NAT one person
 * and one office one abuser.
 *
 * There is deliberately no function here that takes a user agent, a screen
 * metric, a device identifier or a card fingerprint. "Layered controls that
 * avoid device fingerprinting" is a property of what this module can be given,
 * and `guest-governance-isolation.test.ts` fails the build if that changes.
 */

import { createHmac } from 'node:crypto';
import type { GuestAbuseAxis, GuestAbuseScope } from '@mercaria/shared-types';
import { config } from '../../config/index.js';

/**
 * The subject digest for one (scope, axis, value).
 *
 * Throws when no key is configured rather than falling back to an unkeyed
 * digest. An unkeyed one over an email or a /24 is an offline ORACLE anybody
 * with the table can run, and the whole point of the column is that it is not
 * one — `resolveGuestAbuseControlsEnabled` already keeps the deployment off in
 * that state, so reaching this throw means a caller ignored the flag.
 */
export function abuseSubjectHash(input: {
  scope: GuestAbuseScope;
  axis: GuestAbuseAxis;
  value: string;
}): string {
  const key = config.guest.governance.abuseSubjectHashKey;
  if (key === '') {
    throw new Error(
      'GUEST_ABUSE_SUBJECT_HASH_KEY is not configured; an unkeyed subject digest is an oracle',
    );
  }
  return createHmac('sha256', key)
    .update(`${input.scope}:${input.axis}:${input.value}`)
    .digest('hex');
}

/**
 * The coarse network range for a client address.
 *
 * IPv4 to a /24, IPv6 to a /64 — the widths a routing table hands out to one
 * subscriber, so the counter bounds "one connection" rather than "one device".
 * An unparseable address returns the string unchanged, which is safe in the
 * direction that matters: it counts as its own subject and bounds itself, and
 * cannot merge with anybody else's range.
 */
export function networkRangeOf(address: string): string {
  if (address.includes(':')) {
    const groups = address.split(':');
    return `${groups.slice(0, 4).join(':')}::/64`;
  }
  const octets = address.split('.');
  if (octets.length !== 4) return address;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

/**
 * The window a moment falls in, for a counting window of `windowSeconds`.
 *
 * Fixed windows rather than a sliding one, and the cost is stated: a burst
 * straddling a boundary can spend two windows' allowance. That is accepted for
 * the reason #108 accepts it — a sliding window needs a row per attempt, which
 * is the per-attempt log this domain is built not to keep.
 */
export function windowStartFor(now: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}
