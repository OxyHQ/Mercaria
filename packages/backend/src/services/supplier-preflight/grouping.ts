/**
 * Decomposing a mixed cart into supplier orders, and refusing to claim a total
 * that is not known (#122 "Mixed carts and grouping").
 *
 * PURE. Grouping is a deterministic function of the lines, and the delivered
 * total is a function of the groups' answers — neither reads a row, a clock or
 * a configuration.
 *
 * ## An external or marketplace line has no shape here
 *
 * {@link RetailPreflightLine} carries a `procurementOfferId` and nothing that
 * could name a listing, a seller, a storefront or an external offer. So #122
 * mixed carts 5–6 ("keep connected marketplace seller groups separate",
 * "external referral offers never enter preflight") are held by the type: there
 * is no member a marketplace line could arrive in, and the caller that builds
 * these from a cart must already have partitioned them. `supplier-preflight-isolation.test.ts`
 * pins that no module in this domain reaches the offer, listing or referral
 * layers to undo it.
 *
 * ## Summing per-item shipping when the supplier priced the basket is
 * unrepresentable
 *
 * `SupplierShippingQuote`'s `basket` branch has ONE cost and no per-line
 * member, and its `per_item` branch has the per-line costs and no single cost.
 * {@link groupShippingCostMinor} switches on the basis, so the wrong arithmetic
 * has no expression — #122 mixed carts 3 is a property of the union rather than
 * a rule the composer has to remember.
 */

import type { CurrencyCode, Money, SupplierGroupDeliveredTotal, SupplierShippingQuote } from '@mercaria/shared-types';

/**
 * One retail line awaiting preflight.
 *
 * `fulfilmentOriginCountry` is part of the grouping key rather than a detail,
 * because a supplier shipping the same order from two warehouses is two
 * supplier orders with two shipping quotes, and merging them would produce one
 * cost for a parcel that does not exist.
 */
export interface RetailPreflightLine {
  procurementOfferId: string;
  supplierAccountId: string;
  /** ISO-3166-1 alpha-2, or NULL when the offer does not declare one. */
  fulfilmentOriginCountry: string | null;
  currency: CurrencyCode;
  supplierSku: string;
  canonicalVariantId: string | null;
  canonicalProductId: string | null;
  quantity: number;
  /** Supplier minimums and pack sizes ride the line so a group can preserve them. */
  minimumOrderQuantity: number | null;
  packSize: number | null;
}

/** One supplier order this cart decomposes into. */
export interface SupplierPreflightGroup {
  /**
   * The deterministic grouping key. `` (unit separator) appears in no uuid,
   * ISO country code or currency code, so two different groups cannot render to
   * one key — the `commerce_relationships.endpoint_key` separator rule.
   */
  key: string;
  supplierAccountId: string;
  fulfilmentOriginCountry: string | null;
  currency: CurrencyCode;
  lines: readonly RetailPreflightLine[];
}

/**
 * Group retail lines by supplier account, fulfilment origin and currency (#122
 * mixed carts 1).
 *
 * The output order is by KEY, not by input order, so the same cart decomposes
 * identically however its lines were added — which is what makes a re-preflight
 * of an unchanged cart converge on the same groups and therefore the same
 * request fingerprints.
 */
export function groupRetailLines(
  lines: readonly RetailPreflightLine[],
): readonly SupplierPreflightGroup[] {
  const groups = new Map<string, RetailPreflightLine[]>();
  for (const line of lines) {
    const key = groupKey(line);
    const existing = groups.get(key);
    if (existing) existing.push(line);
    else groups.set(key, [line]);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, groupLines]) => {
      const [first] = groupLines;
      if (!first) {
        // Unreachable: a key exists only because a line created it. Stated as a
        // throw rather than a non-null assertion, which the house rules forbid
        // and which would hide the day it stops being unreachable.
        throw new Error(`Supplier preflight group ${key} was built with no lines.`);
      }
      return {
        key,
        supplierAccountId: first.supplierAccountId,
        fulfilmentOriginCountry: first.fulfilmentOriginCountry,
        currency: first.currency,
        // Line order inside a group is the offer id, for the same determinism.
        lines: [...groupLines].sort((left, right) =>
          left.procurementOfferId < right.procurementOfferId ? -1 : 1,
        ),
      };
    });
}

function groupKey(line: RetailPreflightLine): string {
  return [line.supplierAccountId, line.fulfilmentOriginCountry ?? '', line.currency].join('');
}

/**
 * Whether a group's supplier minimums and pack sizes are satisfied (#122 mixed
 * carts 4).
 *
 * Evaluated per LINE and not per group, because a minimum order quantity and a
 * pack size are properties of one SKU: a group holding three of one item and
 * one of another satisfies neither by having four units in it.
 */
export function findGroupQuantityViolations(
  group: SupplierPreflightGroup,
): readonly { procurementOfferId: string; violation: 'below_minimum' | 'pack_size' }[] {
  const violations: { procurementOfferId: string; violation: 'below_minimum' | 'pack_size' }[] = [];
  for (const line of group.lines) {
    if (line.minimumOrderQuantity !== null && line.quantity < line.minimumOrderQuantity) {
      violations.push({ procurementOfferId: line.procurementOfferId, violation: 'below_minimum' });
    }
    if (line.packSize !== null && line.packSize > 1 && line.quantity % line.packSize !== 0) {
      violations.push({ procurementOfferId: line.procurementOfferId, violation: 'pack_size' });
    }
  }
  return violations;
}

/**
 * What a group's shipping actually costs, in minor units — or nothing.
 *
 * The `unknown` branch returns `null` and NOT zero, and the return type says
 * so, so a caller adding it to a total has to handle the `null` explicitly.
 * That is the same device `deriveOfferDelivery` uses (#57): reading silence as
 * free requires writing the coercion out loud.
 */
export function groupShippingCostMinor(shipping: SupplierShippingQuote): number | null {
  switch (shipping.basis) {
    case 'basket':
      // ONE cost for the whole group. There is no per-line member here to sum,
      // which is #122 mixed carts 3 held by the union rather than by a rule.
      return shipping.cost.amount;
    case 'per_item':
      return shipping.costs.reduce((total, cost) => total + cost.amount, 0);
    case 'unknown':
      return null;
  }
}

/** One group's answer, as the delivered-total composer needs it. */
export interface GroupTotalInput {
  key: string;
  currency: CurrencyCode;
  /** The group's item subtotal in minor units, when every line was priced. */
  itemSubtotalMinor: number | null;
  shipping: SupplierShippingQuote;
  /** Tax and duty, when the supplier stated them. Absent is absent, never zero. */
  taxMinor: number | null;
  dutyMinor: number | null;
  /** Whether the group's own preflight came back `complete`. */
  complete: boolean;
}

/**
 * Compose the delivered total for a whole cart — or refuse to (#122 mixed carts
 * 7–8).
 *
 * The incomplete branch of {@link SupplierGroupDeliveredTotal} has no `total`
 * member at all, so "do not claim a complete delivered total when one group
 * remains unquoted" is the only shape this function can return when a group is
 * missing. A caller cannot read past it without switching on `complete`.
 *
 * A mixed-currency cart is reported as unquoted rather than converted: this
 * domain does no FX (a test asserts it), and inventing a rate to make one
 * number out of two currencies is exactly the kind of quiet arithmetic #120
 * keeps out of the money path.
 */
export function composeDeliveredTotal(
  groups: readonly GroupTotalInput[],
  presentmentCurrency: CurrencyCode,
): SupplierGroupDeliveredTotal {
  const unquoted: string[] = [];
  const groupTotals: Money[] = [];
  let total = 0;

  for (const group of groups) {
    const shippingMinor = groupShippingCostMinor(group.shipping);
    if (
      !group.complete ||
      group.currency !== presentmentCurrency ||
      group.itemSubtotalMinor === null ||
      shippingMinor === null
    ) {
      unquoted.push(group.key);
      continue;
    }
    // Tax and duty are added only where the supplier stated them. An unstated
    // tax is not zero — it is a gap the group's own completeness already
    // reported through `tax_treatment_unknown` when the policy required it.
    const groupTotal =
      group.itemSubtotalMinor + shippingMinor + (group.taxMinor ?? 0) + (group.dutyMinor ?? 0);
    groupTotals.push({ amount: groupTotal, currency: presentmentCurrency });
    total += groupTotal;
  }

  if (unquoted.length > 0) {
    return { complete: false, unquotedGroupKeys: [...unquoted].sort() };
  }
  return {
    complete: true,
    total: { amount: total, currency: presentmentCurrency },
    groupTotals,
  };
}
