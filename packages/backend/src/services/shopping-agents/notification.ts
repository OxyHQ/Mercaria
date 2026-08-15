/**
 * What a notification actually carries, and what it may never carry
 * (#97 notification 3–7).
 *
 * PURE. The payload is composed FIELD BY FIELD from a stored finding — never
 * spread from a row — and every member is a Mercaria id, a bounded code or a
 * count.
 *
 * ## There is no URL of any kind, and that is #97 notification 6
 *
 * The issue asks that a notification "link to a current Mercaria result page,
 * not directly to an unvalidated external URL". The way that goes wrong is a
 * helpful someone copying the winning offer's `destination_url` in, because it
 * is right there on the offer — so the payload carries the CANONICAL PRODUCT
 * IDS and the client composes the Mercaria path, which is the only composition
 * that cannot become an outbound link. #79 reached the same place.
 *
 * ## And no product NAME
 *
 * A stale name in a push payload is the field that goes wrong silently: the
 * notification is queued, the catalogue is corrected, and a shopper is told
 * about a product under a title nobody uses. The client resolves the name when
 * it renders, from the id.
 *
 * {@link SHOPPING_AGENT_FORBIDDEN_NOTIFICATION_FIELDS} names what may never
 * appear, and it is walked at RUNTIME against a real emitted payload by the
 * isolation gate — #92's two-gate rule, because a static scan sees the fields
 * somebody wrote and not the ones a spread would add.
 */

import type {
  ShoppingAgentEvidenceCompleteness,
  ShoppingAgentFreshness,
  ShoppingAgentJobKind,
  ShoppingAgentNotificationPayload,
  ShoppingAgentPriceBasis,
  ShoppingAgentSelectedLine,
  ShoppingAgentSummary,
  CurrencyCode,
} from '@mercaria/shared-types';

/** Everything the payload is composed from. Named, never a row. */
export interface ShoppingAgentNotificationInput {
  readonly agentId: string;
  readonly findingId: string;
  readonly kind: ShoppingAgentJobKind;
  readonly priceBasis: ShoppingAgentPriceBasis;
  readonly objectiveAmountMinor?: number;
  readonly objectiveCurrency?: CurrencyCode;
  readonly objectiveDeltaMinor?: number;
  readonly completeness: ShoppingAgentEvidenceCompleteness;
  readonly freshness: ShoppingAgentFreshness;
  readonly selection: readonly ShoppingAgentSelectedLine[];
  readonly agentPolicyVersion: string;
}

/**
 * The payload one delivery carries.
 *
 * `outcome` is the literal `qualified` and not a parameter: the notification
 * table's own trigger refuses a row whose finding is anything else, so a
 * payload able to say `incomplete` would describe a state that cannot reach
 * this function.
 */
export function shoppingAgentNotificationPayload(
  input: ShoppingAgentNotificationInput,
): ShoppingAgentNotificationPayload {
  const productIds = [...new Set(input.selection.map((line) => line.canonicalProductId))].sort();
  return {
    agentId: input.agentId,
    findingId: input.findingId,
    kind: input.kind,
    outcome: 'qualified',
    priceBasis: input.priceBasis,
    ...(input.objectiveAmountMinor === undefined
      ? {}
      : { objectiveAmountMinor: input.objectiveAmountMinor }),
    ...(input.objectiveCurrency === undefined
      ? {}
      : { objectiveCurrency: input.objectiveCurrency }),
    ...(input.objectiveDeltaMinor === undefined
      ? {}
      : { objectiveDeltaMinor: input.objectiveDeltaMinor }),
    canonicalProductIds: productIds,
    lineCount: input.selection.length,
    // #97 notification 4 — "state whether the result is native, external,
    // official, used, nearby or mixed". A plan mixing both is neither, so these
    // are TWO booleans over the whole plan rather than one enum that would have
    // to pick a side.
    nativeCheckoutAvailable: input.selection.some((line) => line.nativeCheckoutEligible),
    officialChannel:
      input.selection.length > 0 && input.selection.every((line) => line.officialChannel),
    freshness: input.freshness,
    completeness: input.completeness,
    agentPolicyVersion: input.agentPolicyVersion,
  };
}

/**
 * The words a shopper reads, composed from the SUMMARY the finding already
 * carries.
 *
 * There is deliberately no second body: whatever survived
 * `validateShoppingAgentSummaryDraft` — or the deterministic template, when
 * nothing did — is what is sent, so a notification cannot say something the
 * finding's own summary does not.
 */
export function shoppingAgentNotificationCopy(input: {
  readonly kind: ShoppingAgentJobKind;
  readonly summary: ShoppingAgentSummary;
}): { readonly title: string; readonly body: string } {
  return {
    title: TITLE_FOR_KIND[input.kind],
    body: input.summary.sentences.map((sentence) => sentence.text).join(' '),
  };
}

/** One line per job kind. Copy, so it lives beside the vocabulary it renders. */
const TITLE_FOR_KIND: Readonly<Record<ShoppingAgentJobKind, string>> = Object.freeze({
  offer_price_threshold: 'A price you were watching has been met',
  used_or_refurbished_appearance: 'A used or refurbished one has appeared',
  official_channel_availability: 'Now available from an official channel',
  basket_target_total: 'Your saved basket is under its target',
  materially_better_plan: 'A better plan is available',
  constraint_satisfiable: 'Something now matches your requirements',
});
