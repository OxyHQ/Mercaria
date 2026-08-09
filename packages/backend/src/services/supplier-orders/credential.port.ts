/**
 * Reading a supplier's credential from the approved secret system (ADR 0004
 * D6.5, #124 security 1 and 9).
 *
 * ## Mercaria stores a PATH, never a secret
 *
 * `supplier_accounts.credential_reference` is an SSM path under
 * `/oxy/mercaria/suppliers/*`, shape-CHECKed so a pasted API key fails the
 * write, and registered PROTECTED so no whole-row read can ship it (#118).
 * Nothing in this repository reads SSM today, which leaves exactly one honest
 * arrangement: a narrow port, a default that refuses, and a deployment that
 * supplies the reader.
 *
 * ## The default refuses, so nothing is called with a credential nobody proved
 *
 * {@link unavailableCredentialReader} answers `null` for every reference, and
 * the provider-call chokepoint turns that into `credential_not_valid` — a
 * REFUSAL that is recorded as an attempt with a named reason, not a silent
 * skip. So a deployment with no secret reader places no supplier orders and
 * says why, and a webhook it cannot verify is refused rather than stored.
 *
 * ## Rotation does not orphan existing orders (#124 security 9)
 *
 * The reference is stable and the VALUE behind it is what rotates, so a
 * purchase order placed under an old credential is read, cancelled and
 * reconciled under the new one with nothing to migrate. That is the whole
 * reason the column holds a path rather than a version: a credential embedded
 * in a purchase order would have to be rewritten, and #118's trigger makes
 * rewriting one impossible.
 */

import { log } from '../../lib/logger.js';

/** The one function a deployment registers. */
export type SupplierCredentialReader = (reference: string) => Promise<string | null>;

/**
 * The default reader: every reference answers `null`.
 *
 * Logged ONCE per process rather than per call, because a deployment without a
 * secret reader would otherwise fill its logs with one line per provider
 * attempt while telling an operator nothing they did not learn from the first.
 */
export const unavailableCredentialReader: SupplierCredentialReader = async (reference) => {
  warnOnce(reference);
  return await Promise.resolve(null);
};

let warned = false;
function warnOnce(reference: string): void {
  if (warned) return;
  warned = true;
  log.general.warn(
    { referenceLength: reference.length },
    '[Procurement] no supplier credential reader is registered; every provider call is refused ' +
      'with `credential_not_valid` and every supplier webhook is refused as unverifiable',
  );
}

let reader: SupplierCredentialReader = unavailableCredentialReader;

/**
 * Register the real reader.
 *
 * Re-registering REPLACES — the `registerSupplierAdapter` reasoning: startup
 * ordering across lazily imported modules is not something a port should have
 * an opinion about.
 */
export function registerSupplierCredentialReader(next: SupplierCredentialReader): void {
  reader = next;
}

/** Restore the refusing default. Exists for tests, which must not leak a reader. */
export function resetSupplierCredentialReader(): void {
  reader = unavailableCredentialReader;
  warned = false;
}

/**
 * The secret behind one reference, or `null`.
 *
 * The value is returned and never logged, never stored and never put on an
 * error. A caller that fails to reach a provider records the FAILURE, not what
 * it authenticated with.
 */
export async function readSupplierCredential(reference: string | null): Promise<string | null> {
  if (reference === null || reference.length === 0) return null;
  return await reader(reference);
}
