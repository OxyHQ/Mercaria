import type { PurchaseEffects } from '@oxy.so/contracts';
import { assertSafeMoneyAmount } from '@mercaria/shared-types';
import type { OrderRecord } from '../../db/orders/orderRepository.js';
import { conflict } from '../../lib/errors/error-codes.js';

type Evidence = Pick<
  PurchaseEffects,
  | 'lineItems'
  | 'merchantAccountIds'
  | 'shippingMinor'
  | 'taxMinor'
  | 'discountMinor'
  | 'roundingAdjustmentMinor'
  | 'amountMinor'
  | 'currency'
  | 'summary'
>;

function checked(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw conflict(`The checkout ${field} cannot be represented safely.`);
  }
  return Number(value);
}

/** Exact receipt evidence. Never change a financial snapshot to satisfy an approval schema. */
export function buildPurchaseEvidence(
  orders: readonly OrderRecord[],
  merchantByOrderId: ReadonlyMap<string, string>,
): Evidence {
  if (!orders.length) throw conflict('This checkout has no orders.');
  const currency = orders[0].totalsGrandTotalPresentmentCurrency;
  const lineItems: Evidence['lineItems'] = [];
  let shipping = 0n;
  let tax = 0n;
  let discount = 0n;
  let adjustment = 0n;
  let amount = 0n;
  for (const order of [...orders].sort((a, b) => a.id.localeCompare(b.id))) {
    const merchant = merchantByOrderId.get(order.id);
    if (!merchant || !order.items.length)
      throw conflict('The checkout merchant cannot be verified.');
    const shopCurrency = order.totalsSubtotalShopCurrency;
    const shopLines = order.items.reduce((sum, line) => sum + BigInt(line.lineTotalShopAmount), 0n);
    if (shopLines !== BigInt(order.totalsSubtotalShopAmount)) {
      throw conflict('The stored item amounts do not match the order subtotal.');
    }
    if (
      shopLines +
        BigInt(order.totalsShippingShopAmount) +
        BigInt(order.totalsTaxShopAmount) -
        BigInt(order.totalsDiscountTotalShopAmount) !==
      BigInt(order.totalsGrandTotalShopAmount)
    ) {
      throw conflict('The stored order total contains an unexplained amount.');
    }
    let presentmentLines = 0n;
    for (const item of [...order.items].sort((a, b) => a.id.localeCompare(b.id))) {
      if (
        item.lineTotalPresentmentCurrency !== currency ||
        item.unitPricePresentmentCurrency !== currency ||
        item.lineTotalShopCurrency !== shopCurrency ||
        item.unitPriceShopCurrency !== shopCurrency ||
        BigInt(item.unitPriceShopAmount) * BigInt(item.quantity) !==
          BigInt(item.lineTotalShopAmount)
      ) {
        throw conflict('The stored item pricing is inconsistent.');
      }
      for (const value of [item.unitPricePresentmentAmount, item.lineTotalPresentmentAmount]) {
        assertSafeMoneyAmount(value, 'purchase approval item');
      }
      // No truncation: a guardian must see every selected option. An unusually
      // long selection requires ordinary adult checkout until explicitly reviewed.
      const optionsText = [
        item.variantTitle,
        ...item.optionValues.map(({ name, value }) => `${name}: ${value}`),
      ]
        .filter(Boolean)
        .join(' · ');
      if (item.title.length > 300 || optionsText.length > 300) {
        throw conflict('This item has too much selection detail for supervised checkout.');
      }
      lineItems.push({
        itemReference: item.id,
        title: item.title,
        optionsText,
        merchantAccountId: merchant,
        quantity: item.quantity,
        unitAmountMinor: item.unitPricePresentmentAmount,
        lineAmountMinor: item.lineTotalPresentmentAmount,
      });
      presentmentLines += BigInt(item.lineTotalPresentmentAmount);
    }
    if (
      [
        order.totalsGrandTotalPresentmentCurrency,
        order.totalsShippingPresentmentCurrency,
        order.totalsTaxPresentmentCurrency,
        order.totalsDiscountTotalPresentmentCurrency,
      ].some((value) => value !== currency)
    ) {
      throw conflict('A supervised checkout must have one payment currency.');
    }
    const orderShipping = BigInt(order.totalsShippingPresentmentAmount);
    const orderTax = BigInt(order.totalsTaxPresentmentAmount);
    const orderDiscount = BigInt(order.totalsDiscountTotalPresentmentAmount);
    const orderAmount = BigInt(order.totalsGrandTotalPresentmentAmount);
    const rounding = orderAmount - (presentmentLines + orderShipping + orderTax - orderDiscount);
    // pricing.service converts n lines, discount, tax, and grand total once
    // each, with half-even error <= 0.5. Shipping is already converted and added
    // unchanged to both sides. Same-currency arithmetic has no rounding at all.
    const bound = currency === shopCurrency ? 0n : BigInt(Math.floor((order.items.length + 3) / 2));
    if (rounding < -bound || rounding > bound)
      throw conflict('The checkout has an unexplained total difference.');
    shipping += orderShipping;
    tax += orderTax;
    discount += orderDiscount;
    adjustment += rounding;
    amount += orderAmount;
  }
  if (lineItems.length > 200)
    throw conflict('This checkout contains too many items for one approval.');
  return {
    lineItems,
    merchantAccountIds: [...new Set(lineItems.map((line) => line.merchantAccountId))].sort(),
    shippingMinor: checked(shipping, 'shipping'),
    taxMinor: checked(tax, 'tax'),
    discountMinor: checked(discount, 'discount'),
    roundingAdjustmentMinor: checked(adjustment, 'rounding'),
    amountMinor: checked(amount, 'total'),
    currency,
    summary: `Mercaria checkout: ${lineItems.length} item selections, ${orders.length} seller orders.`,
  };
}
