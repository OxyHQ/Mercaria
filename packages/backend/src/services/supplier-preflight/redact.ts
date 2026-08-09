/**
 * What an operator may see of a preflight (#122 operations 5: "safe operator
 * inspection with redacted destination and source response").
 *
 * `services/payments/redact.ts` is the precedent and the reasoning carries
 * over, with one difference worth stating: the payment domain redacts a
 * provider PAYLOAD it stores, while this domain stores no payload at all — the
 * quote's columns are an allow-list of normalized, closed-set values, and the
 * raw answer lives behind `source_record_ref` in a restricted store. So what is
 * redacted here is narrower and the redaction is mostly structural already.
 *
 * What is left to do at this layer is the same three things every operator
 * surface in this repository does:
 *
 *  - **The projection NAMES every field** ({@link projectSupplierQuoteTrace}),
 *    the `provider_accounts` status-projection device: a column added to
 *    `supplier_quotes` later cannot reach an operator response without somebody
 *    typing it here, into a type that has no property to hold it.
 *  - **A live provider handle is shown as its last four characters** — enough
 *    to correlate with the supplier's own dashboard, not enough to present back
 *    to their API and cancel a hold.
 *  - **A provider message is scrubbed and bounded.** Provider error text
 *    routinely quotes the input back, and an address or an email arriving that
 *    way would land in a log line that no column-level rule can see.
 */

import type {
  SupplierPreflightFailureKind,
  SupplierQuoteTrace,
  SupplierPreflightBlockReason,
  SupplierPreflightExceptionKind,
} from '@mercaria/shared-types';
import type { SupplierQuoteRow } from '../../db/supplierPreflight/quoteRepository.js';
import type { SupplierReservationRow } from '../../db/supplierPreflight/reservationRepository.js';
import { deriveSupplierQuoteUsage } from './quote-usage.js';

/** Longest stored or logged provider message. */
const MAX_MESSAGE_LENGTH = 512;

/** The marker left where a value was removed, so a reader sees the hole. */
const REDACTED = '[redacted]';

/**
 * Reduce a provider's error text to something safe to store and log.
 *
 * A second line of defence, not the first — the first is that a preflight
 * request carries no recipient name, address line, phone or email, so there is
 * far less for a provider to quote back than a payment request offers. What
 * remains reachable is the postal code and city the request DOES carry, so the
 * scrub removes the two shapes those arrive in (a digit run and an
 * alphanumeric postal token) alongside the email shape the payments version
 * already handles.
 *
 * Deliberately NOT imported from `services/payments/redact.ts`: that function's
 * rules are tuned to what a card processor says, this one's to what a
 * fulfilment API says, and one function serving both would drift toward
 * whichever domain edited it last.
 */
export function redactSupplierProviderMessage(message: string): string {
  const scrubbed = message
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, REDACTED)
    // Any run of 6+ digits: a phone number, an order reference carrying one, a
    // postal code in the countries that use only digits.
    .replace(/\b\d{6,}\b/g, REDACTED)
    // A UK/NL/CA-shaped postal token: letters and digits interleaved. Bounded
    // to 5–8 characters so ordinary SKUs and service codes survive, which
    // matters because those are what makes a message useful at all.
    .replace(/\b(?=[A-Z0-9]{5,8}\b)(?=.*\d)(?=.*[A-Z])[A-Z0-9]+\b/g, REDACTED);
  return scrubbed.length > MAX_MESSAGE_LENGTH
    ? `${scrubbed.slice(0, MAX_MESSAGE_LENGTH)}…`
    : scrubbed;
}

/**
 * The last four characters of a provider reference.
 *
 * The `provider_accounts` account-id rule: enough to line up with what the
 * supplier's own dashboard shows, not enough to present back to their API. A
 * value too short to redact meaningfully is replaced entirely rather than shown
 * whole, because a four-character reservation id is still a usable handle.
 */
export function redactProviderReference(value: string | null): string | null {
  if (value === null) return null;
  return value.length > 8 ? `…${value.slice(-4)}` : REDACTED;
}

/**
 * One quote, projected for an operator.
 *
 * Field by field on purpose — never a spread of the row. The protected columns
 * are already withheld by `publicColumns`, and this second, explicit layer is
 * what stops a NEW column (a supplier note, a raw reason string, a richer
 * destination) reaching an operator response by default. Two independent
 * mechanisms, the way `SELLER_PROFILE_FORBIDDEN_FIELDS` (#92) pairs a scanned
 * gate with a runtime walk.
 *
 * The destination is the coarse pair the row actually holds; there is no finer
 * value to redact, which is the point of storing none.
 */
export function projectSupplierQuoteTrace(
  quote: SupplierQuoteRow,
  reservation: SupplierReservationRow | undefined,
  providerReservationId: string | null,
  now: Date = new Date(),
): SupplierQuoteTrace {
  return {
    quoteId: quote.id,
    supplierId: quote.supplierId,
    supplierAccountId: quote.supplierAccountId,
    procurementOfferId: quote.procurementOfferId,
    supplierSku: quote.supplierSku,
    quantity: quote.quantity,
    environment: quote.environment,
    status: quote.status,
    blockReasons: quote.blockReasons as SupplierPreflightBlockReason[],
    exceptionKind: quote.exceptionKind as SupplierPreflightExceptionKind | null,
    availability: quote.availability,
    identity: quote.identityConfirmation,
    usage: deriveSupplierQuoteUsage(
      {
        consumedAt: quote.consumedAt,
        releasedAt: quote.releasedAt,
        supersededByQuoteId: quote.supersededByQuoteId,
        expiresAt: quote.expiresAt,
      },
      now,
    ),
    destinationCountry: quote.destinationCountry,
    destinationRegion: quote.destinationRegion,
    quotedAt: quote.quotedAt.toISOString(),
    expiresAt: quote.expiresAt.toISOString(),
    reservation: {
      present: reservation !== undefined,
      providerReservationIdSuffix: redactProviderReference(providerReservationId),
      providerExpiresAt: reservation?.providerExpiresAt.toISOString() ?? null,
      consumedAt: reservation?.consumedAt?.toISOString() ?? null,
      releasedAt: reservation?.releasedAt?.toISOString() ?? null,
    },
    attempts: quote.attempts,
    lastFailureKind: quote.lastFailureKind as SupplierPreflightFailureKind | null,
    latencyMs: quote.latencyMs,
  };
}
