/**
 * The RUNTIME half of ADR 0005 A5 (#147 acceptance 3).
 *
 * #92's two-gate rule: a static scan sees the code somebody wrote, and a walk
 * sees what a serializer actually emitted. `referral-dashboard-isolation.test.ts`
 * is the static half; this is the walk, and it runs over a REAL composed
 * dashboard in the real-server suite rather than over a fixture somebody shaped
 * to pass.
 *
 * ## What it looks for, and why a value check would be worse
 *
 * FIELD NAMES, from `REFERRAL_PARTNER_FORBIDDEN_FIELDS`. A value check ("does
 * this string look like an email") is the wrong instrument twice over: it
 * cannot see an opaque id that identifies a person perfectly well, and it
 * produces false positives on a campaign key somebody named after a customer.
 * A name is a decision somebody made about what a field IS.
 *
 * ## It THROWS
 *
 * The `PAYMENT_METADATA_KEYS` posture: a forbidden field reaching a partner
 * projection is a defect in the composition, and dropping it silently ships
 * that defect with the leak merely postponed to the next field somebody adds.
 * A 500 on a partner's own dashboard is a bad afternoon; a buyer's identity in
 * a partner's export is somebody else's.
 */

import { REFERRAL_PARTNER_FORBIDDEN_FIELDS } from '@mercaria/shared-types';

/** How deep the walk goes. The dashboard is four deep; ten is slack, not a bound. */
const MAX_WALK_DEPTH = 10;

const FORBIDDEN = new Set(REFERRAL_PARTNER_FORBIDDEN_FIELDS.map((name) => name.toLowerCase()));

/**
 * Every forbidden field name found in a value, with the path it was found at.
 *
 * Case-INSENSITIVE, because the failure this catches is a serializer emitting
 * `BuyerEmail` where the list says `buyerEmail`, and a case-sensitive scan
 * reads that as clean. (Measured in the Moovo client: a redactor that
 * lower-cased its own output made an assertion pass vacuously.)
 */
export function findForbiddenPartnerFields(value: unknown, path = '$', depth = 0): string[] {
  if (depth > MAX_WALK_DEPTH) return [];
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findForbiddenPartnerFields(entry, `${path}[${index}]`, depth + 1),
    );
  }
  if (typeof value !== 'object') return [];
  const found: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN.has(key.toLowerCase())) found.push(`${path}.${key}`);
    found.push(...findForbiddenPartnerFields(entry, `${path}.${key}`, depth + 1));
  }
  return found;
}

/**
 * Refuse to emit a partner projection that carries a forbidden field.
 *
 * Called at the ONE place a composed dashboard leaves this domain, so "was the
 * projection checked" is a property of the call graph rather than of each
 * route remembering.
 */
export function assertPartnerSafeProjection(value: unknown, context: string): void {
  const found = findForbiddenPartnerFields(value);
  if (found.length === 0) return;
  throw new Error(
    `${context}: referral partner projection carries forbidden field(s) ${found.join(', ')}. ` +
      'ADR 0005 A5 permits per-period counts and per-reward {date, state, net amount, source, campaign} and nothing else.',
  );
}
