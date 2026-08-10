/**
 * What a buyer is actually told (#79 §"Notifications" 3, 4, 5, 8).
 *
 * PURE. It composes the payload and the copy from a trigger, and it is the ONE
 * place either is built — so the runtime gate that walks a real emitted payload
 * against {@link PRICE_ALERT_FORBIDDEN_NOTIFICATION_FIELDS} is walking
 * everything a buyer could ever receive.
 *
 * ## The link is to Mercaria, never to the destination (notification 3)
 *
 * The payload names the canonical product, the qualifying variant and the OFFER
 * id, and carries no URL of any kind. An outbound address stored in a
 * notification is precisely the "now-unvalidated destination" the rule forbids:
 * it would still be there a week later, pointing at a page that has moved, sold
 * out or changed price, and #37's redirect exists so that the destination is
 * composed at the moment somebody clicks and not before.
 *
 * ## Locale is ECHOED, never used to translate (notification 7)
 *
 * Mercaria has no i18n runtime on the server — every notification in this
 * codebase composes English and carries structured `data` — so the alert's
 * locale rides in the payload for a client to re-render from, and the copy below
 * is the English one. Pretending otherwise would mean shipping a translation
 * table nobody reviews, keyed on a field no client has ever set.
 */

import type {
  PriceAlertNotificationPayload,
  PriceAlertTrigger,
} from '@mercaria/shared-types';
import { CURRENCY_PRECISION, CURRENCY_SYMBOLS } from '@mercaria/shared-types';

/** The structured half — the allow-list, as a value the gate walks. */
export function priceAlertNotificationPayload(
  trigger: PriceAlertTrigger,
  locale: string | null,
): PriceAlertNotificationPayload {
  return {
    alertId: trigger.alertId,
    triggerId: trigger.id,
    canonicalProductId: trigger.canonicalProductId,
    canonicalVariantId: trigger.canonicalVariantId,
    offerId: trigger.offerId,
    ...(trigger.merchantId ? { merchantId: trigger.merchantId } : {}),
    amount: trigger.amount,
    target: trigger.target,
    basis: trigger.basis,
    ...(trigger.conditionGroup ? { conditionGroup: trigger.conditionGroup } : {}),
    nativeCheckoutEligible: trigger.nativeCheckoutEligible,
    ...(locale ? { locale } : {}),
  };
}

/**
 * A money value as a person reads it, in the currency's own precision.
 *
 * `CURRENCY_PRECISION` and never a hard-coded two. A zero-decimal currency's
 * minor unit IS its major unit and an eight-decimal one is six orders of
 * magnitude the other way, so a fixed two prints the first a hundred times too
 * small and the second a million times too big. This module names no currency
 * at all — `price-alert-isolation.test.ts` scans it, comments included.
 */
function formatAmount(money: { readonly amount: number; readonly currency: string }): string {
  const precision = CURRENCY_PRECISION[money.currency as keyof typeof CURRENCY_PRECISION] ?? 2;
  const symbol = CURRENCY_SYMBOLS[money.currency as keyof typeof CURRENCY_SYMBOLS] ?? '';
  const major = money.amount / 10 ** precision;
  const rendered = major.toFixed(precision);
  return symbol ? `${symbol}${rendered}` : `${rendered} ${money.currency}`;
}

/** The condition segments, as a shopper's words. */
const SEGMENT_TEXT: Readonly<Record<string, string>> = {
  new: 'new',
  open_box: 'open-box',
  refurbished: 'refurbished',
  used: 'used',
  for_parts: 'for-parts',
};

/**
 * The title and body.
 *
 * Four things the copy states because notification 4 asks for them and a buyer
 * cannot act without them: the amount, whether it is the item alone or a KNOWN
 * total including delivery, which condition segment it is, and whether they can
 * buy it here or are being sent to a merchant. The product's NAME is
 * deliberately absent: this module is pure and a name is a database read, and
 * the client renders the product from `canonicalProductId` anyway — a stale
 * copy of a name in a push payload is the one field that would go wrong
 * silently.
 */
export function priceAlertNotificationCopy(trigger: PriceAlertTrigger): {
  readonly title: string;
  readonly body: string;
} {
  const amount = formatAmount(trigger.amount);
  const target = formatAmount(trigger.target);
  const basis =
    trigger.basis === 'known_total' ? 'including delivery' : 'before delivery';
  const segment = trigger.conditionGroup ? SEGMENT_TEXT[trigger.conditionGroup] : undefined;
  const where = trigger.nativeCheckoutEligible
    ? 'You can buy it on Mercaria.'
    : 'It is listed by a merchant outside Mercaria.';

  return {
    title: `Price alert: ${amount}`,
    body:
      `A ${segment ? `${segment} ` : ''}offer is now ${amount} ${basis}, ` +
      `which is at or below your ${target} alert. ${where}`,
  };
}
