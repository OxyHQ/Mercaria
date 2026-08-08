/**
 * Reducing a provider payload to what Mercaria may keep.
 *
 * #45 invariant 9: sensitive provider payloads are minimized and never logged
 * or stored wholesale. A payment provider's webhook body is the richest
 * personal-data object this system ever receives — billing address, email,
 * phone, card brand and last four, a network fingerprint, a device id, a
 * three-D-Secure result — and none of it is Mercaria's to hold.
 *
 * ## An ALLOW-list, and it has to be
 *
 * A deny-list of known-sensitive keys is the intuitive design and the wrong one:
 * it is correct only until the provider adds a field, which they do without
 * telling anyone and which is exactly when a new sensitive field appears. The
 * allow-list fails the other way — a genuinely useful new field is dropped until
 * someone adds it here, which is a missing column in an operator view rather
 * than a disclosure.
 *
 * ## What survives, and why each one earns it
 *
 * Ids (to correlate), amounts and currencies (to reconcile), statuses and
 * outcome codes (to explain), timestamps (to order events). Between them they
 * answer every question the operator surface (#50) asks of a stored event.
 * Anything else is read live from the provider by a human with their own
 * authorization, not from a copy Mercaria kept.
 */

/**
 * Keys whose values are kept verbatim when they are scalars.
 *
 * Matched case-INSENSITIVELY against the key's own name, so `paymentIntent`,
 * `payment_intent` and `PaymentIntent` are one rule rather than three — a
 * provider's casing is their business and a rule that depends on it is a rule
 * with a silent hole.
 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'object',
  'type',
  'status',
  'reason',
  'code',
  'declinecode',
  'failurecode',
  'failuremessage',
  'outcome',
  'networkstatus',
  'amount',
  'amountcaptured',
  'amountrefunded',
  'amountreceived',
  'currency',
  'created',
  'availableon',
  'arrivaldate',
  'livemode',
  'paymentintent',
  'charge',
  'transfer',
  'transfergroup',
  'sourcetransaction',
  'refund',
  'dispute',
  'payout',
  'account',
  'balancetransaction',
  'paymentid',
  'orderid',
  'orderids',
  'checkoutgroupid',
  'refundid',
]);

/** How deep to walk before giving up. A provider envelope is nested 3–4 levels. */
const MAX_DEPTH = 6;

/** How many elements of an array to keep. Enough to see a shape, not a dataset. */
const MAX_ARRAY_LENGTH = 20;

/** Longest string value kept. A provider id is short; a blob is not an id. */
const MAX_STRING_LENGTH = 256;

/** The marker left where a value was dropped, so a reader sees the hole. */
const REDACTED = '[redacted]';

/** `payment_intent` and `paymentIntent` both normalize to `paymentintent`. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Whether a value is a plain object worth walking into. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A scalar an allowed key may keep.
 *
 * `bigint` is deliberately absent: `JSON.parse` never produces one, so a
 * `bigint` reaching here came from code rather than from a provider, and the
 * jsonb column could not store it anyway.
 */
function redactScalar(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  return REDACTED;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return REDACTED;

  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY_LENGTH).map((entry) => redactValue(entry, depth + 1));
    return value.length > MAX_ARRAY_LENGTH
      ? [...kept, `${REDACTED} (${String(value.length - MAX_ARRAY_LENGTH)} more)`]
      : kept;
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // A NESTED object is always walked, whatever its key is called: a
      // provider nests the ids we want under names we have not enumerated
      // (`data.object`, `outcome`, `charges.data[0]`). Its own leaves are still
      // filtered by this same rule one level down, so walking in grants nothing.
      if (isPlainObject(entry) || Array.isArray(entry)) {
        out[key] = redactValue(entry, depth + 1);
        continue;
      }
      out[key] = ALLOWED_KEYS.has(normalizeKey(key)) ? redactScalar(entry) : REDACTED;
    }
    return out;
  }

  return REDACTED;
}

/**
 * Reduce a provider payload to the ids, amounts, statuses and timestamps
 * Mercaria may store.
 *
 * The result is always a plain object, including for a payload that is not one:
 * the column is `jsonb NOT NULL` and a caller should not have to branch on a
 * provider sending something unexpected.
 *
 * @param payload The parsed provider payload, exactly as received.
 */
export function redactProviderPayload(payload: unknown): Record<string, unknown> {
  if (!isPlainObject(payload)) {
    return { value: REDACTED };
  }
  const redacted = redactValue(payload, 0);
  return isPlainObject(redacted) ? redacted : { value: REDACTED };
}

/**
 * Reduce a provider's error message to something safe to persist and log.
 *
 * Provider messages routinely quote the input back — an email in a validation
 * error, a card's last four in a decline — so the message is truncated and
 * scrubbed of the two shapes that carry an identity on their own: an email
 * address and a long digit run.
 *
 * This is a second line of defence, not the first. The first is not putting
 * personal data into a provider request in the first place (#45 buyer
 * boundaries 7).
 */
export function redactProviderMessage(message: string): string {
  const scrubbed = message
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, REDACTED)
    .replace(/\b\d{9,}\b/g, REDACTED);
  return scrubbed.length > MAX_STRING_LENGTH
    ? `${scrubbed.slice(0, MAX_STRING_LENGTH)}…`
    : scrubbed;
}
