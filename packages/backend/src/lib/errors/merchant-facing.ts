/**
 * Making a message safe to persist and to show a merchant (#292).
 *
 * TWO doors, ONE bound. {@link merchantFacingFailureMessage} takes a thrown value
 * of unknown provenance and classifies it; {@link boundMerchantFacingMessage}
 * takes a sentence this repository composed on a path that does not throw. The
 * first calls the second, so the scrub and the ceiling have one implementation
 * and every merchant-facing string passes through it.
 *
 * `respondWithError` already draws this line for an HTTP response: a
 * `MercariaError` is emitted with its own message because our own code composed
 * it, and anything else becomes a generic 500 "so internals never leak". The
 * connector sync paths are where that line was never drawn, because they do not
 * respond — they PERSIST. `sync_runs.error` is written by a `catch` and read
 * straight onto the merchant's channel screen by `toSyncRunDTO`, and the same
 * `err.message` is copied into the per-product `error` of an ingest response.
 *
 * What that published, measured on the #69 verification database: thirteen
 * `sync_runs` rows of 1065 characters each, every one of them the drizzle message
 *
 *     Failed query: insert into "product_variants" ("id", "listing_id", …)
 *     params: 01a0041c-…, …, MERCPUSH-VAR-JACKET-01, , 7650, EUR, …
 *
 * — the failing statement plus its bound parameters, so the connection id, the
 * provider, the SKU and the price. And in 1065 characters it never once named the
 * rule that was broken, because **drizzle replaces the driver's message with its
 * own**: the SQLSTATE and the constraint name live on `cause`, which is why
 * `constraintNameOf` walks that chain and why `error ~ 'constraint|_key|_idx'` is
 * FALSE on every one of those rows.
 *
 * ## The three branches, and why the default is the important one
 *
 * A `MercariaError` is OURS — every one on the connector paths is a sentence
 * somebody wrote for a merchant to read — so it is kept, scrubbed and bounded.
 *
 * A DRIVER error is reduced to its SQLSTATE and its constraint name, which is
 * `describeDriverError`'s posture as its own contract states it: "SQLSTATE and the
 * constraint name are the two things worth reading when a write is refused, and
 * neither is data." That function is not CALLED, because its third field is
 * `error.name` and a merchant reading `DrizzleQueryError` on their channel screen
 * learns nothing the other two do not already tell support.
 * {@link RECOGNISED_CONSTRAINTS} then names the few whose collision has a remedy
 * the merchant can actually carry out.
 *
 * Anything else — a `TypeError`, an undici failure, a string somebody threw — is a
 * fixed sentence. That is the branch that matters, because the value it replaces
 * is `err.message`, which is exactly where an unbounded upstream string lives. A
 * failure this cannot classify is not one worth publishing, and the run row
 * already carries `kind` and `finished_at`, so which operation failed and when are
 * on the record either way. The full error still reaches the LOG at every call
 * site, which is where a failing statement belongs.
 *
 * ## Why the recognised-constraint map degrades safely
 *
 * A hand-maintained map that SKIPS what is missing from it is not a gate. This is
 * not a gate, and the difference is the default: an unmapped constraint still
 * yields a bounded message naming the rule and the code, so a missing entry costs
 * a sentence of guidance and never costs the classification. Adding an entry is an
 * improvement, never a repair.
 */

import { constraintNameOf, sqlStateOf } from '@oxyhq/db';
import { isMercariaError } from './error-codes.js';
import { sanitizeMessage } from './sanitize.js';

/**
 * The ceiling on a persisted, merchant-visible failure message.
 *
 * Not short — generous enough that an ordinary composed refusal survives intact.
 * What it bounds is every message assembled from a list nobody capped, and two of
 * those are real rather than hypothetical.
 *
 * A zod `error.message` over a malformed platform payload, or a provider
 * answering with an HTML page, reaches `validationError` as an interpolation — so
 * it IS a `MercariaError`, and the "ours is safe" branch on its own would carry it
 * whole into a text column and onto a dashboard.
 *
 * And the ambiguous-variant refusals join one uuid per CANDIDATE. The reviewer's
 * reading of the push rail's was that its `sku` is capped at 120 by
 * `ingestInventorySchema`, which is true and is not the unbounded part: the
 * candidate list has no cap but `config.catalog.maxVariantsPerProduct`, which
 * defaults to 100 — about 3,900 characters, nearly four times the 1065-character
 * rows this file exists to stop, on a listing a merchant can legitimately have.
 */
export const MERCHANT_FACING_MESSAGE_MAX_LENGTH = 500;

/** What the reader is told when nothing about the failure could be classified. */
export const UNCLASSIFIED_FAILURE_MESSAGE =
  'This run failed for an unexpected reason. The details are in Mercaria’s server log.';

/**
 * Constraints whose collision has a MERCHANT remedy, and what that remedy is.
 *
 * Deliberately small. Every entry is a rule a merchant's own catalogue can break,
 * phrased as the thing they can go and change; a constraint only an internal
 * defect can break has no entry, because the default already says "the details are
 * in the log" at more length and with the two handles support needs.
 */
const RECOGNISED_CONSTRAINTS: Readonly<Record<string, string>> = {
  listings_store_id_handle_key:
    'Two products in this store claim the same URL handle. Change the handle on one ' +
    'of them, then run the sync again.',
  listings_store_id_source_key_idx:
    'Two products claim the same id on this channel. That is normally two deliveries ' +
    'of one product and resolves itself; if it persists, the channel is publishing ' +
    'one id for two products.',
  orders_store_id_source_key:
    'Two orders claim the same id on this channel. The second was not imported.',
  product_variants_source_external_variant_key:
    'Two variants claim the same variant id on this channel. Neither was updated.',
};

/**
 * Scrub and bound a message THIS repository composed on a path that does not
 * throw — the second of the two doors, and the one a per-item outcome uses.
 *
 * The distinction between the two is what is known about the input, not where it
 * is going. {@link merchantFacingFailureMessage} takes a thrown value of unknown
 * provenance and must decide whether any of it may be published; this takes a
 * sentence assembled here from local values, where there is nothing to classify
 * and classifying anyway would DESTROY it — a plain string is not a
 * `MercariaError` and carries no SQLSTATE, so it would land on the "anything
 * else" branch and be replaced wholesale.
 *
 * Wrapping such a message in a `conflict()` purely to feed it through the other
 * door is the alternative, and it produces the identical string by a longer
 * route: an Error object built to satisfy a signature and never thrown. The
 * invariant worth holding is not "everything goes through one FUNCTION" but "no
 * merchant-facing string escapes without the scrub and the bound", and
 * {@link merchantFacingFailureMessage} calls this, so there is exactly one
 * implementation of that and two doors onto it.
 *
 * Scrub, then bound — in that order, and the order is the property. Truncating
 * first can cut a credential in half, and half a credential no longer matches the
 * `{20,}` run `sanitizeMessage` keys on: the scrubber would then report a clean
 * string over text it had been handed too late to read. #77's redaction rules
 * record the same finding about their own ordering.
 */
export function boundMerchantFacingMessage(message: string): string {
  const scrubbed = sanitizeMessage(message).trim();
  if (scrubbed.length <= MERCHANT_FACING_MESSAGE_MAX_LENGTH) return scrubbed;
  return `${scrubbed.slice(0, MERCHANT_FACING_MESSAGE_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * The merchant-facing message for a thrown value.
 *
 * Never returns the empty string: a blank `sync_runs.error` beside
 * `status = 'failed'` reads as "no reason was recorded", which is what an unwritten
 * column already means, so the two would be indistinguishable.
 */
export function merchantFacingFailureMessage(err: unknown): string {
  if (isMercariaError(err)) {
    const bounded = boundMerchantFacingMessage(err.message);
    return bounded.length > 0 ? bounded : UNCLASSIFIED_FAILURE_MESSAGE;
  }

  const constraint = constraintNameOf(err);
  const sqlState = sqlStateOf(err);
  if (constraint !== undefined || sqlState !== undefined) {
    const remedy = constraint !== undefined ? RECOGNISED_CONSTRAINTS[constraint] : undefined;
    if (remedy !== undefined) return remedy;
    // No entry: name the rule and the code, and stop. A constraint name and a
    // SQLSTATE are both structural — neither is a value the statement carried — and
    // they are the two handles that make the server log line findable from the
    // dashboard, which is what a support conversation actually needs.
    const handles = [
      constraint !== undefined ? `rule ${constraint}` : undefined,
      sqlState !== undefined ? `code ${sqlState}` : undefined,
    ].filter((part): part is string => part !== undefined);
    return boundMerchantFacingMessage(
      `The database refused this write (${handles.join(', ')}). ` +
        'The details are in Mercaria’s server log.',
    );
  }

  return UNCLASSIFIED_FAILURE_MESSAGE;
}
