import { describe, expect, it } from 'vitest';
import type { OrderRecord } from '../../../db/orders/orderRepository.js';
import { buildPurchaseEvidence } from '../purchase-evidence.js';

/** Narrow financial fixture: this pure projection never reads mutable catalog or identities. */
function order(
  input: { id?: string; fx?: boolean; rounding?: number; subtotal?: number } = {},
): OrderRecord {
  const id = input.id ?? 'order-1';
  return {
    id,
    totalsSubtotalShopAmount: input.subtotal ?? 100,
    totalsSubtotalShopCurrency: 'EUR',
    totalsShippingShopAmount: 0,
    totalsTaxShopAmount: 0,
    totalsDiscountTotalShopAmount: 0,
    totalsGrandTotalShopAmount: 100,
    totalsGrandTotalPresentmentCurrency: input.fx ? 'USD' : 'EUR',
    totalsShippingPresentmentCurrency: input.fx ? 'USD' : 'EUR',
    totalsTaxPresentmentCurrency: input.fx ? 'USD' : 'EUR',
    totalsDiscountTotalPresentmentCurrency: input.fx ? 'USD' : 'EUR',
    totalsShippingPresentmentAmount: 0,
    totalsTaxPresentmentAmount: 0,
    totalsDiscountTotalPresentmentAmount: 0,
    totalsGrandTotalPresentmentAmount: 100 + (input.rounding ?? 0),
    items: [
      {
        id: `${id}:item-1`,
        title: 'Wooden blocks',
        variantTitle: 'Natural',
        optionValues: [{ name: 'Finish', value: 'Untreated' }],
        quantity: 2,
        unitPriceShopAmount: 50,
        unitPriceShopCurrency: 'EUR',
        lineTotalShopAmount: 100,
        lineTotalShopCurrency: 'EUR',
        unitPricePresentmentAmount: 50,
        unitPricePresentmentCurrency: input.fx ? 'USD' : 'EUR',
        lineTotalPresentmentAmount: 100,
        lineTotalPresentmentCurrency: input.fx ? 'USD' : 'EUR',
      },
    ],
  } as unknown as OrderRecord;
}

describe('exact guardian purchase evidence', () => {
  it('preserves every seller, quantity and selected option and stable ordering', () => {
    const first = order({ id: 'a' });
    const second = order({ id: 'b' });
    const merchants = new Map([
      ['a', 'merchant-a'],
      ['b', 'merchant-b'],
    ]);
    const evidence = buildPurchaseEvidence([second, first], merchants);
    expect(evidence).toMatchObject({
      amountMinor: 200,
      currency: 'EUR',
      roundingAdjustmentMinor: 0,
      merchantAccountIds: ['merchant-a', 'merchant-b'],
      lineItems: [
        {
          itemReference: 'a:item-1',
          quantity: 2,
          lineAmountMinor: 100,
          optionsText: 'Natural · Finish: Untreated',
        },
        { itemReference: 'b:item-1', quantity: 2, lineAmountMinor: 100 },
      ],
    });
    expect(buildPurchaseEvidence([first, second], merchants)).toEqual(evidence);
  });

  it.each([-2, 2])(
    'represents the conservative per-order FX rounding boundary %s explicitly',
    (rounding) => {
      const evidence = buildPurchaseEvidence(
        [order({ fx: true, rounding })],
        new Map([['order-1', 'merchant']]),
      );
      expect(evidence.roundingAdjustmentMinor).toBe(rounding);
      expect(evidence.amountMinor).toBe(100 + rounding);
      expect(evidence.discountMinor).toBe(0);
    },
  );

  it.each([-3, 3])(
    'rejects an unexplained FX difference %s outside the measured stage bound',
    (rounding) => {
      expect(() =>
        buildPurchaseEvidence([order({ fx: true, rounding })], new Map([['order-1', 'merchant']])),
      ).toThrow('unexplained');
    },
  );

  it('allows no rounding in source currency and rejects source subtotal corruption separately', () => {
    expect(() =>
      buildPurchaseEvidence([order({ rounding: 1 })], new Map([['order-1', 'merchant']])),
    ).toThrow('unexplained');
    expect(() =>
      buildPurchaseEvidence(
        [order({ fx: true, subtotal: 101 })],
        new Map([['order-1', 'merchant']]),
      ),
    ).toThrow('subtotal');
  });

  it('does not truncate meaningful options to fit the authorization contract', () => {
    const record = order();
    record.items[0].optionValues[0].value = 'x'.repeat(301);
    expect(() => buildPurchaseEvidence([record], new Map([['order-1', 'merchant']]))).toThrow(
      'selection detail',
    );
  });
});
