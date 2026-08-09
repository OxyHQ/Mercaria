/**
 * What may be stored and logged about a supplier order (#124 security 4,
 * idempotency 8).
 *
 * `services/payments/redact.ts` is the precedent and
 * `services/supplier-preflight/redact.ts` the near neighbour; this one has the
 * hardest job of the three, because a SUBMISSION carries what neither of the
 * others does: the recipient's name, street, city, postal code and phone
 * number. Everything below exists because a fulfilment API quotes its input
 * back — in an error message, in an event payload, in a validation complaint —
 * and every one of those lands somewhere a column-level rule cannot see.
 *
 * Three mechanisms, in decreasing order of how much they are relied on:
 *
 *  1. **Absence.** No table in this domain has an address, recipient, phone or
 *     email column. The destination exists once, on `purchase_orders`, redacted
 *     by shape (#118). Nothing here can store one because nothing here has a
 *     column for one.
 *  2. **The ALLOW-LIST.** {@link projectSupplierEventPayload} keeps
 *     `SUPPLIER_EVENT_PAYLOAD_FIELDS` and drops the rest — never a deny-list,
 *     which is correct only until the provider adds a field, and a fulfilment
 *     API's next field is very often the recipient's name.
 *  3. **The scrub.** {@link redactSupplierOrderMessage} removes the shapes a
 *     provider quotes back inside free text. It is the last line, not the
 *     first: it cannot know that `Calle Mayor 14` is an address.
 */

import { createHash } from 'node:crypto';
import { SUPPLIER_EVENT_PAYLOAD_FIELDS } from '@mercaria/shared-types';

/** Longest stored or logged provider message. Matches the columns' CHECKs. */
const MAX_MESSAGE_LENGTH = 512;

/** The marker left where a value was removed, so a reader sees the hole. */
const REDACTED = '[redacted]';

/** Longest allow-listed scalar kept in a stored summary. */
const MAX_SUMMARY_SCALAR_LENGTH = 200;

/** Most array members kept in a stored summary — a bound, not a truncation policy. */
const MAX_SUMMARY_ARRAY_LENGTH = 20;

/**
 * Reduce a provider's free text to something safe to store and log.
 *
 * Deliberately NOT imported from either neighbour: the payments version is
 * tuned to what a card processor says and the preflight version to what a
 * QUOTING API says, while this one has to survive a fulfilment API quoting a
 * street address back. One function serving all three would drift toward
 * whichever domain edited it last.
 *
 * The rules and their order:
 *
 *  - Emails first, because an address containing digits would otherwise be
 *    partially eaten by the digit rule and become unrecognisable.
 *  - A street-shaped fragment: a number attached to a capitalised word run.
 *    This is the rule neither neighbour has, and it is why this function exists
 *    separately rather than being imported.
 *  - Any run of FIVE or more digits: a phone number, an order reference
 *    carrying one, and — the reason the threshold differs from the preflight
 *    version's six — a postal code. Five digits is the most common postal
 *    length there is (ES, FR, DE, IT, US), so a six-digit floor misses the
 *    exact case a fulfilment API quotes back most often. The cost is stated
 *    rather than hidden: a purely numeric five-digit SKU loses its digits in a
 *    provider message. That is the right side of the trade here, because this
 *    domain's requests carry a full street address and the preflight's do not.
 *  - A UK/NL/CA-shaped postal token (letters and digits interleaved, 5–8
 *    characters). Bounded so ordinary alphanumeric SKUs and carrier service
 *    codes survive, which matters because those are what makes a message
 *    useful at all.
 */
export function redactSupplierOrderMessage(message: string): string {
  const scrubbed = message
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, REDACTED)
    .replace(/\b\d{1,4}[A-Za-z]?[,\s]+(?:[A-Z][\p{L}'.-]+[\s,]*){1,4}/gu, `${REDACTED} `)
    .replace(/\b\d{5,}\b/g, REDACTED)
    .replace(/\b(?=[A-Z0-9]{5,8}\b)(?=.*\d)(?=.*[A-Z])[A-Z0-9]+\b/g, REDACTED);
  const collapsed = scrubbed.replace(/\s{2,}/g, ' ').trim();
  return collapsed.length > MAX_MESSAGE_LENGTH
    ? `${collapsed.slice(0, MAX_MESSAGE_LENGTH)}…`
    : collapsed;
}

/**
 * The last four characters of a provider reference.
 *
 * The `provider_accounts` account-id rule: enough to line up with what the
 * supplier's own dashboard shows, not enough to present back to their API and
 * act on the order. A value too short to redact meaningfully is replaced
 * entirely rather than shown whole.
 */
export function redactSupplierReference(value: string | null): string | null {
  if (value === null) return null;
  return value.length > 8 ? `…${value.slice(-4)}` : REDACTED;
}

/**
 * Keep only the allow-listed keys of a provider payload, bounded.
 *
 * Nested objects are NOT walked: a nested object is where a provider puts the
 * shipping address, and a projection that descended into one would have to
 * allow-list every path rather than every key — which is the shape that goes
 * stale silently. A nested value under an allow-listed key is therefore
 * summarised as its type rather than its content.
 */
export function projectSupplierEventPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set(SUPPLIER_EVENT_PAYLOAD_FIELDS);
  const projection: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!allowed.has(key)) continue;
    const summarised = summariseValue(value);
    if (summarised !== undefined) projection[key] = summarised;
  }
  return projection;
}

/** One allow-listed value, reduced to a scalar, a scalar array, or nothing. */
function summariseValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return redactSupplierOrderMessage(value).slice(0, MAX_SUMMARY_SCALAR_LENGTH);
  }
  if (Array.isArray(value)) {
    const members = value
      .slice(0, MAX_SUMMARY_ARRAY_LENGTH)
      .filter((member): member is string | number => typeof member === 'string' || typeof member === 'number')
      .map((member) =>
        typeof member === 'string'
          ? redactSupplierOrderMessage(member).slice(0, MAX_SUMMARY_SCALAR_LENGTH)
          : member,
      );
    return members;
  }
  // An object under an allow-listed key: its SHAPE is worth recording (an
  // operator reading a trace needs to know the provider sent something there),
  // its content is not, and walking into it is how an address arrives.
  return `[object:${String(Object.keys(value as Record<string, unknown>).length)} keys]`;
}

/**
 * The sha-256 of a canonical value, hex.
 *
 * Used for the request digest and the polled-event content identity. UNKEYED,
 * deliberately, and the difference from #122's keyed fingerprint is worth
 * stating: that one exists so a stored value cannot be brute-forced back into a
 * destination and is therefore an HMAC under its own key. This one exists to
 * answer "is this the same request as last time" and "have I seen this
 * observation", both of which are comparisons against values the same process
 * computed — so a key would add a rotation hazard (every stored digest becomes
 * incomparable) for no attacker the column is not already protected from: the
 * digest is registered PROTECTED, so it never leaves the database.
 */
export function digestSupplierValue(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * A canonical JSON rendering with SORTED keys.
 *
 * Two renderings of one request must be byte-identical or the digest stops
 * answering the question it exists for. `JSON.stringify` preserves insertion
 * order, and an object built by spreading a partial over a default has whatever
 * order those two happened to have — the moderation-envelope determinism rule,
 * applied to a hash nobody ever reads.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const out: Record<string, unknown> = {};
  for (const [key, member] of entries) out[key] = sortKeys(member);
  return out;
}
