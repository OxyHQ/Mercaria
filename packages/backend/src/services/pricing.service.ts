/**
 * Pricing service — the SINGLE totals engine for Mercaria (B4).
 *
 * `calculateTotals` is the one authoritative place where a set of priced lines
 * becomes `subtotal → discountTotal → tax → shipping → grandTotal`. The cart
 * preview, the checkout order-build loop and any future quote endpoint ALL go
 * through it, so the buyer is never shown a total the checkout disagrees with.
 *
 * Everything is computed in INTEGER minor units of the SHOP (settlement) currency
 * (`input.currency`): native line prices are converted to the shop currency up
 * front, so all math is single-currency. Half-even rounding runs through the
 * shared `utils/money` helpers (`percentOf`, `roundMoney`, `allocateProportionally`).
 * The engine reconciles residual minor units so the SUM of every per-line
 * `(lineTotal − discount + tax)` EXACTLY equals the shop `grandTotal` — it throws
 * an internal error rather than ship an off-by-one. Every returned total is
 * `DualMoney`: the shop side plus a `presentment` side converted with the provided
 * `rates` (a presentment equal to the shop currency is byte-identical).
 *
 * COMBINABILITY RULE (deterministic):
 *   Discounts are partitioned into ORDER-level (`appliesTo.scope === 'order'`) and
 *   PRODUCT-level (scope products/collections). By default AT MOST ONE of each
 *   class is applied — the highest-amount one (best-for-customer), tie-broken by
 *   ascending `_id`. Two discounts of the SAME class stack only if BOTH carry the
 *   matching `combinesWith` flag for that class. A product-level and an
 *   order-level discount may COEXIST only if the order-level discount's
 *   `combinesWith.productDiscounts` AND the product-level discount's
 *   `combinesWith.orderDiscounts` are both true; otherwise only the class whose
 *   best combination yields the larger total is kept (ties keep the order class).
 */

import type {
  CurrencyCode,
  DiscountAllocation,
  DualMoney,
  FxRates,
  Money,
  TaxLine,
} from '@mercaria/shared-types';
import { Discount, type IDiscount } from '../models/discount.js';
import { TaxRate, type ITaxRate } from '../models/tax-rate.js';
import { Store, type IStoreTaxSettings } from '../models/store.js';
import {
  multiplyMoney,
  sumMoney,
  percentOf,
  roundMoney,
  roundMinorUnits,
  allocateProportionally,
} from '../utils/money.js';
import { convert, toDualMoney } from './fx.service.js';
import { log } from '../lib/logger.js';

/** Basis-point denominator: 10_000 bps = 100% (mirrors `utils/money`). */
const BASIS_POINTS_DENOMINATOR = 10_000;
/** Default get-leg discount when a BOGO `get` omits one: 100% off (free). */
const DEFAULT_GET_DISCOUNT_BPS = 10_000;

/** A single priced line fed to the engine. */
export interface PricingLine {
  /** The listing this line buys from. */
  listingId: string;
  /** The concrete variant. */
  variantId: string;
  /** The product's merchandising type (drives `TaxRate.productTypeScope`). */
  productType?: string;
  /** Collection ids the listing belongs to (drives collection-scoped discounts). */
  collectionIds?: string[];
  /** Live unit price. */
  unitPrice: Money;
  /** Units of this variant. */
  quantity: number;
}

/** The buyer's shipping destination, used to match tax-rate regions. */
export interface PricingShippingAddress {
  country?: string;
  region?: string;
  postalCode?: string;
}

/** Everything `calculateTotals` needs to price a single seller group. */
export interface PricingInput {
  /** The owning store (when a store group); absent for P2P groups → no discounts/taxes. */
  storeId?: string;
  /**
   * The priced lines, in display order (the result mirrors this order). Each
   * line's `unitPrice` may be in its NATIVE currency; the engine converts it to
   * `currency` (the shop currency) before pricing, so mixed-currency groups
   * settle consistently.
   */
  lines: PricingLine[];
  /**
   * The SHOP (settlement) currency every amount is priced in — the store's
   * `defaultCurrency` (or, for a P2P group, the seller's listing currency).
   */
  currency: CurrencyCode;
  /**
   * The buyer's PRESENTMENT currency (what they see/pay). Every result total is
   * returned as `DualMoney` (shop + presentment); a presentment equal to the shop
   * currency yields byte-identical sides.
   */
  presentmentCurrency: CurrencyCode;
  /**
   * FAIR-based rates covering the shop, presentment and every line-native
   * currency. Provided by the caller so checkout can snapshot the SAME rates onto
   * the order for reproducibility.
   */
  rates: FxRates;
  /** Discount codes the buyer is redeeming (case-insensitive). */
  discountCodes?: string[];
  /** The buyer's Oxy user id, for customer-eligibility gating. */
  customerId?: string;
  /** The buyer's customer-group tags, for group-eligibility gating. */
  customerGroupTags?: string[];
  /** The shipping destination, for tax-region matching. */
  shippingAddress?: PricingShippingAddress;
  /** Preview mode is read-only (no usage increments happen here regardless). */
  preview?: boolean;
}

/**
 * The authoritative totals for one seller group. Every total is `DualMoney` (the
 * settlement `shop` side + the buyer's `presentment` side). The discount/tax
 * BREAKDOWN lines (`appliedDiscounts`/`taxLines`) carry SHOP-currency amounts —
 * they are the settlement/refund basis; the presentment figure a buyer sees is
 * the dual `discountTotal`/`tax` totals.
 */
export interface PricingResult {
  /** Sum of every line total. */
  subtotal: DualMoney;
  /** Total of every discount allocation (equals `sum(perLineDiscount)`). */
  discountTotal: DualMoney;
  /** Total tax added (0 when tax-inclusive or no rate matched). */
  tax: DualMoney;
  /** Shipping (a Moovo seam — always zero here; checkout adds the config cost). */
  shipping: DualMoney;
  /** `subtotal − discountTotal + tax + shipping`. */
  grandTotal: DualMoney;
  /** One allocation per applied discount/affected line (persisted on the order; SHOP currency). */
  appliedDiscounts: DiscountAllocation[];
  /** One tax line per added rate (informational lines when tax-inclusive; SHOP currency). */
  taxLines: TaxLine[];
  /** Discount attributed to each input line, in input order (shop + presentment). */
  perLineDiscount: DualMoney[];
}

/** A discount classified for the combinability decision. */
interface ApplicableDiscount {
  discount: IDiscount;
  /** The matched code (for the allocation), when a code-method discount. */
  code?: string;
  /** `order` (whole order) or `line` (specific lines). */
  level: 'order' | 'line';
  /** The total amount this discount removes (shop-currency minor units). */
  amount: number;
  /** Per-line removal for a line-scoped discount (input order); empty for order-level. */
  perLine: number[];
}

/**
 * Compute the authoritative totals for one seller group. Loads the store's active
 * discounts, tax rates and tax settings in one query EACH (only when `storeId` is
 * present). When `storeId` is absent (a P2P group) there are no discounts/taxes:
 * `grandTotal === subtotal`, all arrays empty, `perLineDiscount` all-zero.
 */
export async function calculateTotals(input: PricingInput): Promise<PricingResult> {
  const { currency, presentmentCurrency, rates } = input;

  // Wrap a SHOP-currency minor-unit amount as `DualMoney` (shop + presentment).
  const dual = (amount: number): DualMoney =>
    toDualMoney({ amount, currency }, presentmentCurrency, rates);

  // Convert every line's native unit price into the SHOP currency up front, so
  // all downstream math is single-currency (a same-currency line is unchanged).
  const lines: PricingLine[] = input.lines.map((line) => ({
    ...line,
    unitPrice: convert(line.unitPrice, currency, rates),
  }));

  // 1. Subtotal + per-line totals (SHOP currency).
  const lineTotals = lines.map((line) => multiplyMoney(line.unitPrice, line.quantity).amount);
  const subtotal = sumMoney(
    lines.map((line) => multiplyMoney(line.unitPrice, line.quantity)),
    currency,
  );

  // No store → no discounts/taxes (pure P2P group).
  if (!input.storeId) {
    return {
      subtotal: dual(subtotal.amount),
      discountTotal: dual(0),
      tax: dual(0),
      shipping: dual(0),
      grandTotal: dual(subtotal.amount),
      appliedDiscounts: [],
      taxLines: [],
      perLineDiscount: lines.map(() => dual(0)),
    };
  }

  const now = new Date();
  const normalizedCodes = new Set(
    (input.discountCodes ?? []).map((code) => code.trim().toUpperCase()).filter((c) => c.length > 0),
  );

  // 2. Load store tax settings + active discounts + active tax rates (one query each).
  const [storeDoc, activeDiscounts, taxRates] = await Promise.all([
    Store.findById(input.storeId).select('taxSettings').lean<{ taxSettings?: IStoreTaxSettings } | null>(),
    Discount.find({
      storeId: input.storeId,
      isActive: true,
      startsAt: { $lte: now },
      $or: [{ endsAt: { $exists: false } }, { endsAt: null }, { endsAt: { $gte: now } }],
    }).lean<IDiscount[]>(),
    TaxRate.find({ storeId: input.storeId, isActive: true }).lean<ITaxRate[]>(),
  ]);

  const taxSettings: IStoreTaxSettings = storeDoc?.taxSettings ?? {
    pricesIncludeTax: false,
    chargeTaxOnProducts: true,
  };

  // 3. Discounts → per-line removals + allocations.
  const { perLineDiscount, allocations } = applyDiscounts({
    input,
    lines,
    lineTotals,
    subtotal: subtotal.amount,
    activeDiscounts,
    now,
    normalizedCodes,
  });

  const discountTotal = perLineDiscount.reduce((sum, amount) => sum + amount, 0);

  // 4. Taxes over the discounted per-line base.
  const taxableBase = lineTotals.map((total, i) => total - perLineDiscount[i]);
  const { taxLines, perLineTax, taxTotal } = applyTaxes({
    lines,
    taxableBase,
    taxRates,
    taxSettings,
    shippingAddress: input.shippingAddress,
    currency,
  });

  // 5. Shipping is a later seam (Moovo) — always zero here.
  const shipping = 0;

  // 6. Reconcile so the sum of per-line (lineTotal − discount + tax) === grandTotal.
  const grandTotalAmount = subtotal.amount - discountTotal + taxTotal + shipping;
  reconcileExactness({ lineTotals, perLineDiscount, perLineTax, grandTotalAmount, shipping });

  const result: PricingResult = {
    subtotal: dual(subtotal.amount),
    discountTotal: dual(discountTotal),
    tax: dual(taxTotal),
    shipping: dual(shipping),
    grandTotal: dual(grandTotalAmount),
    appliedDiscounts: allocations.map((a) => ({ ...a, amount: { ...a.amount } })),
    taxLines,
    perLineDiscount: perLineDiscount.map((amount) => dual(amount)),
  };
  return result;
}

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

/** Inputs to the discount stage. */
interface ApplyDiscountsArgs {
  input: PricingInput;
  lines: PricingLine[];
  lineTotals: number[];
  subtotal: number;
  activeDiscounts: IDiscount[];
  now: Date;
  normalizedCodes: Set<string>;
}

/** Output of the discount stage: per-line removals + the per-discount allocations. */
interface ApplyDiscountsResult {
  perLineDiscount: number[];
  allocations: DiscountAllocation[];
}

/**
 * Gate, classify, and select the discounts to apply, then allocate them: product
 * (line-scoped) discounts attribute to their matching lines; the order-level
 * discount allocates across ALL lines proportionally to each line's remaining
 * (un-discounted) weight. A line's discount is clamped to its remaining total so
 * a line can never go negative.
 */
function applyDiscounts(args: ApplyDiscountsArgs): ApplyDiscountsResult {
  const { input, lines, lineTotals, subtotal, activeDiscounts, normalizedCodes } = args;
  const currency = input.currency;
  const perLineDiscount = lines.map(() => 0);
  const allocations: DiscountAllocation[] = [];

  // Candidate set: automatic discounts + code discounts whose code was entered.
  const candidates: { discount: IDiscount; code?: string }[] = [];
  for (const discount of activeDiscounts) {
    if (discount.method === 'automatic') {
      candidates.push({ discount });
      continue;
    }
    const matchedCode = discount.codes.find((c) => normalizedCodes.has(c.code.trim().toUpperCase()));
    if (matchedCode) {
      candidates.push({ discount, code: matchedCode.code });
    }
  }

  // Gate + compute amount for each candidate; drop the inapplicable.
  const applicable: ApplicableDiscount[] = [];
  const totalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);
  for (const candidate of candidates) {
    const { discount } = candidate;
    if (!passesGates(discount, { subtotal, totalQuantity, input })) {
      continue;
    }
    const computed = computeDiscount(discount, { lines, lineTotals, subtotal, currency });
    if (computed.amount <= 0) {
      continue;
    }
    applicable.push({ discount, code: candidate.code, ...computed });
  }

  // Best-for-customer, combinability-aware selection.
  const selected = selectCombination(applicable);

  // Allocate: line-scoped discounts attribute to their lines first, recording the
  // remaining per-line base so an order-level discount allocates over what's left.
  for (const sel of selected.filter((s) => s.level === 'line')) {
    for (let i = 0; i < lines.length; i += 1) {
      const remaining = lineTotals[i] - perLineDiscount[i];
      const take = Math.min(sel.perLine[i], remaining);
      if (take <= 0) {
        continue;
      }
      perLineDiscount[i] += take;
      allocations.push({
        discountId: String(sel.discount._id),
        ...(sel.code ? { code: sel.code } : {}),
        title: sel.discount.title,
        valueType: sel.discount.valueType,
        amount: { amount: take, currency },
        target: 'line',
        targetLineIndex: i,
      });
    }
  }

  // Order-level discounts allocate across all lines by remaining weight.
  for (const sel of selected.filter((s) => s.level === 'order')) {
    const weights = lines.map((_, i) => Math.max(0, lineTotals[i] - perLineDiscount[i]));
    const remainingTotal = weights.reduce((sum, w) => sum + w, 0);
    const cappedAmount = Math.min(sel.amount, remainingTotal);
    if (cappedAmount <= 0) {
      continue;
    }
    const parts = allocateProportionally({ amount: cappedAmount, currency }, weights);
    for (let i = 0; i < parts.length; i += 1) {
      perLineDiscount[i] += parts[i].amount;
    }
    allocations.push({
      discountId: String(sel.discount._id),
      ...(sel.code ? { code: sel.code } : {}),
      title: sel.discount.title,
      valueType: sel.discount.valueType,
      amount: { amount: cappedAmount, currency },
      target: 'order',
    });
  }

  return { perLineDiscount, allocations };
}

/** Schedule is already filtered by the query; gate the remaining requirements. */
function passesGates(
  discount: IDiscount,
  ctx: { subtotal: number; totalQuantity: number; input: PricingInput },
): boolean {
  // Minimum requirement.
  const min = discount.minimumRequirement;
  if (min && min.type === 'subtotal' && ctx.subtotal < min.value) {
    return false;
  }
  if (min && min.type === 'quantity' && ctx.totalQuantity < min.value) {
    return false;
  }

  // Customer eligibility.
  const eligibility = discount.customerEligibility;
  if (eligibility && eligibility.type === 'customers') {
    const ids = eligibility.customerIds ?? [];
    if (!ctx.input.customerId || !ids.includes(ctx.input.customerId)) {
      return false;
    }
  }
  if (eligibility && eligibility.type === 'groups') {
    const groups = eligibility.groupTags ?? [];
    const tags = ctx.input.customerGroupTags ?? [];
    if (!tags.some((t) => groups.includes(t))) {
      return false;
    }
  }

  // Total usage ceiling: current usage = sum of this discount's code usageCounts.
  const totalMax = discount.usageLimits?.totalMax;
  if (typeof totalMax === 'number') {
    const used = discount.codes.reduce((sum, c) => sum + (c.usageCount ?? 0), 0);
    if (used >= totalMax) {
      return false;
    }
  }

  return true;
}

/** A computed discount's level + amount + per-line removal. */
interface ComputedDiscount {
  level: 'order' | 'line';
  amount: number;
  perLine: number[];
}

/** Compute a discount's removal amount + per-line attribution (clamped to bases). */
function computeDiscount(
  discount: IDiscount,
  ctx: { lines: PricingLine[]; lineTotals: number[]; subtotal: number; currency: CurrencyCode },
): ComputedDiscount {
  const { lines, lineTotals, subtotal, currency } = ctx;
  const orderLevel = discount.appliesTo.scope === 'order';

  // The indices of the lines a product-level discount applies to.
  const matchedIndices = orderLevel
    ? lines.map((_, i) => i)
    : lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => lineMatchesAppliesTo(line, discount))
        .map(({ i }) => i);

  if (discount.valueType === 'bogo' || discount.valueType === 'free_item') {
    return computeBogo(discount, ctx);
  }

  if (orderLevel) {
    if (discount.valueType === 'percentage') {
      const amount = percentOf({ amount: subtotal, currency }, discount.value).amount;
      return { level: 'order', amount: Math.min(amount, subtotal), perLine: [] };
    }
    // fixed_amount, clamped to subtotal.
    return { level: 'order', amount: Math.min(discount.value, subtotal), perLine: [] };
  }

  // Product-level: base = sum of matching lines.
  const matchedBase = matchedIndices.reduce((sum, i) => sum + lineTotals[i], 0);
  const perLine = lines.map(() => 0);
  if (matchedBase <= 0) {
    return { level: 'line', amount: 0, perLine };
  }

  if (discount.valueType === 'percentage') {
    // Apply the percentage per matching line so each line's removal is exact.
    let amount = 0;
    for (const i of matchedIndices) {
      const take = Math.min(
        percentOf({ amount: lineTotals[i], currency }, discount.value).amount,
        lineTotals[i],
      );
      perLine[i] = take;
      amount += take;
    }
    return { level: 'line', amount, perLine };
  }

  // fixed_amount product-level: clamp to the matched base, distribute across matched lines.
  const capped = Math.min(discount.value, matchedBase);
  const matchedWeights = lines.map((_, i) => (matchedIndices.includes(i) ? lineTotals[i] : 0));
  const parts = allocateProportionally({ amount: capped, currency }, matchedWeights);
  for (let i = 0; i < parts.length; i += 1) {
    perLine[i] = parts[i].amount;
  }
  return { level: 'line', amount: capped, perLine };
}

/**
 * Compute a BOGO / free-item discount (product-level).
 *
 * Counts the units that qualify under the `buy` leg across all lines, derives the
 * number of rewarded units = `floor(buyUnits / buy.quantity) * get.quantity`
 * (capped at the available `get`-scope units), then discounts the CHEAPEST
 * rewarded units by `get.discountPercent ?? 10000` bps (free_item ⇒ 100%). If
 * `buy`/`get` are missing the discount contributes 0.
 */
function computeBogo(
  discount: IDiscount,
  ctx: { lines: PricingLine[]; lineTotals: number[] },
): ComputedDiscount {
  const { lines } = ctx;
  const perLine = lines.map(() => 0);
  const buy = discount.buy;
  const get = discount.get;
  if (!buy || !get || buy.quantity <= 0 || get.quantity <= 0) {
    return { level: 'line', amount: 0, perLine };
  }

  // Units that qualify under the buy leg.
  const buyUnits = lines
    .filter((line) => lineMatchesLeg(line, buy))
    .reduce((sum, line) => sum + line.quantity, 0);
  const rewards = Math.floor(buyUnits / buy.quantity);
  if (rewards <= 0) {
    return { level: 'line', amount: 0, perLine };
  }
  let freeUnits = rewards * get.quantity;

  // The discountable per-unit prices in the get scope (cheapest first).
  const getUnits: { lineIndex: number; unitPrice: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lineMatchesLeg(lines[i], get)) {
      for (let q = 0; q < lines[i].quantity; q += 1) {
        getUnits.push({ lineIndex: i, unitPrice: lines[i].unitPrice.amount });
      }
    }
  }
  getUnits.sort((a, b) => a.unitPrice - b.unitPrice || a.lineIndex - b.lineIndex);

  const getDiscountBps =
    discount.valueType === 'free_item' ? DEFAULT_GET_DISCOUNT_BPS : get.discountPercent ?? DEFAULT_GET_DISCOUNT_BPS;

  let amount = 0;
  for (const unit of getUnits) {
    if (freeUnits <= 0) {
      break;
    }
    const take = roundMinorUnits((unit.unitPrice * getDiscountBps) / BASIS_POINTS_DENOMINATOR);
    perLine[unit.lineIndex] += take;
    amount += take;
    freeUnits -= 1;
  }

  return { level: 'line', amount, perLine };
}

/** Whether a line is in a discount's `appliesTo` (product/collection) scope. */
function lineMatchesAppliesTo(line: PricingLine, discount: IDiscount): boolean {
  const applies = discount.appliesTo;
  if (applies.scope === 'products') {
    return (applies.productIds ?? []).includes(line.listingId);
  }
  if (applies.scope === 'collections') {
    const ids = applies.collectionIds ?? [];
    return (line.collectionIds ?? []).some((c) => ids.includes(c));
  }
  return false;
}

/** Whether a line is in a BOGO leg's (product/collection) scope. */
function lineMatchesLeg(
  line: PricingLine,
  leg: { scope: 'products' | 'collections'; productIds?: string[]; collectionIds?: string[] },
): boolean {
  if (leg.scope === 'products') {
    return (leg.productIds ?? []).includes(line.listingId);
  }
  const ids = leg.collectionIds ?? [];
  return (line.collectionIds ?? []).some((c) => ids.includes(c));
}

/**
 * Select the best-for-customer combination of applicable discounts subject to the
 * combinability rule documented at the top of this file. Deterministic: within a
 * class the candidates are sorted by amount desc then `_id` asc.
 */
function selectCombination(applicable: ApplicableDiscount[]): ApplicableDiscount[] {
  const byAmountThenId = (a: ApplicableDiscount, b: ApplicableDiscount): number =>
    b.amount - a.amount || (String(a.discount._id) < String(b.discount._id) ? -1 : 1);

  const orderClass = applicable.filter((d) => d.level === 'order').sort(byAmountThenId);
  const productClass = applicable.filter((d) => d.level === 'line').sort(byAmountThenId);

  const bestOrder = pickStack(orderClass, 'orderDiscounts');
  const bestProduct = pickStack(productClass, 'productDiscounts');

  const orderAmount = bestOrder.reduce((sum, d) => sum + d.amount, 0);
  const productAmount = bestProduct.reduce((sum, d) => sum + d.amount, 0);

  // Cross-class coexistence requires BOTH sides to permit the other class.
  if (bestOrder.length > 0 && bestProduct.length > 0) {
    const orderPermitsProduct = bestOrder.every((d) => d.discount.combinesWith.productDiscounts);
    const productPermitsOrder = bestProduct.every((d) => d.discount.combinesWith.orderDiscounts);
    if (orderPermitsProduct && productPermitsOrder) {
      return [...bestOrder, ...bestProduct];
    }
    // Not allowed to coexist: keep the class that yields more (ties → order).
    return productAmount > orderAmount ? bestProduct : bestOrder;
  }

  return [...bestOrder, ...bestProduct];
}

/**
 * Pick the best stack within ONE class. The single highest-amount discount always
 * applies; additional same-class discounts join only if EVERY member of the stack
 * (including the new one) carries the matching `combinesWith` flag.
 */
function pickStack(
  sorted: ApplicableDiscount[],
  flag: 'orderDiscounts' | 'productDiscounts',
): ApplicableDiscount[] {
  if (sorted.length === 0) {
    return [];
  }
  const stack = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const candidate = sorted[i];
    const allCombine =
      candidate.discount.combinesWith[flag] && stack.every((d) => d.discount.combinesWith[flag]);
    if (allCombine) {
      stack.push(candidate);
    }
  }
  return stack;
}

// ---------------------------------------------------------------------------
// Taxes
// ---------------------------------------------------------------------------

/** Inputs to the tax stage. */
interface ApplyTaxesArgs {
  lines: PricingLine[];
  taxableBase: number[];
  taxRates: ITaxRate[];
  taxSettings: IStoreTaxSettings;
  shippingAddress?: PricingShippingAddress;
  currency: CurrencyCode;
}

/** Output of the tax stage. */
interface ApplyTaxesResult {
  taxLines: TaxLine[];
  /** Tax attributed to each input line (only the ADDED, exclusive portion). */
  perLineTax: number[];
  /** Total ADDED tax (0 when tax-inclusive). */
  taxTotal: number;
}

/**
 * Apply matching tax rates to the discounted per-line base. EXCLUSIVE (default):
 * tax is added and accumulated per line. INCLUSIVE
 * (`taxSettings.pricesIncludeTax`): the contained tax is backed out as an
 * INFORMATIONAL tax line but NOT added to the grand total (and `perLineTax` is
 * zero). `chargeTaxOnProducts === false` short-circuits to no tax at all.
 */
function applyTaxes(args: ApplyTaxesArgs): ApplyTaxesResult {
  const { lines, taxableBase, taxRates, taxSettings, shippingAddress, currency } = args;
  const perLineTax = lines.map(() => 0);

  if (taxSettings.chargeTaxOnProducts === false) {
    return { taxLines: [], perLineTax, taxTotal: 0 };
  }

  // Region + priority ordering: higher priority first, then ascending _id.
  const matched = taxRates
    .filter((rate) => rateMatchesRegion(rate, shippingAddress))
    .sort((a, b) => b.priority - a.priority || (String(a._id) < String(b._id) ? -1 : 1));

  const taxLines: TaxLine[] = [];
  let taxTotal = 0;

  for (const rate of matched) {
    let lineAccrued = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (!rateAppliesToLine(rate, lines[i])) {
        continue;
      }
      const base = taxableBase[i];
      if (base <= 0) {
        continue;
      }
      if (taxSettings.pricesIncludeTax) {
        // Contained tax: base − round(base * 10000 / (10000 + rateBps)).
        const net = roundMinorUnits(
          (base * BASIS_POINTS_DENOMINATOR) / (BASIS_POINTS_DENOMINATOR + rate.rateBps),
        );
        lineAccrued += base - net;
      } else {
        const add = percentOf({ amount: base, currency }, rate.rateBps).amount;
        perLineTax[i] += add;
        lineAccrued += add;
      }
    }
    if (lineAccrued > 0) {
      taxLines.push({ name: rate.name, rateBps: rate.rateBps, amount: { amount: lineAccrued, currency } });
      if (!taxSettings.pricesIncludeTax) {
        taxTotal += lineAccrued;
      }
    }
  }

  // Each emitted line is already integer minor units; roundMoney keeps the shape.
  return {
    taxLines: taxLines.map((line) => ({ ...line, amount: roundMoney(line.amount) })),
    perLineTax,
    taxTotal,
  };
}

/** Whether a tax rate's region matches the shipping destination. */
function rateMatchesRegion(rate: ITaxRate, address?: PricingShippingAddress): boolean {
  const region = rate.region;
  if (region.country && region.country !== address?.country) {
    return false;
  }
  if (region.region && region.region !== address?.region) {
    return false;
  }
  if (region.postalCodePattern) {
    const postal = address?.postalCode;
    if (!postal) {
      return false;
    }
    try {
      if (!new RegExp(region.postalCodePattern).test(postal)) {
        return false;
      }
    } catch (err) {
      // A malformed stored pattern must not match (and must not crash pricing).
      log.general.warn({ err, pattern: region.postalCodePattern }, 'Invalid tax-rate postalCodePattern');
      return false;
    }
  }
  return true;
}

/** Whether a tax rate's product-type scope includes a line's product type. */
function rateAppliesToLine(rate: ITaxRate, line: PricingLine): boolean {
  const scope = rate.productTypeScope ?? [];
  if (scope.length === 0) {
    return true;
  }
  return line.productType !== undefined && scope.includes(line.productType);
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** Inputs to the exactness reconciliation. */
interface ReconcileArgs {
  lineTotals: number[];
  perLineDiscount: number[];
  perLineTax: number[];
  grandTotalAmount: number;
  shipping: number;
}

/**
 * Guarantee that the sum of per-line `(lineTotal − discount + tax)` plus shipping
 * EXACTLY equals `grandTotal`. Half-even percent math can leave a residual of a
 * few minor units; push it onto the LARGEST line (largest `lineTotal`; ties → the
 * lowest index) by nudging that line's tax. Throws an internal error if a residual
 * cannot be reconciled — never ships an off-by-one.
 */
function reconcileExactness(args: ReconcileArgs): void {
  const { lineTotals, perLineDiscount, perLineTax, grandTotalAmount, shipping } = args;
  const lineSum = lineTotals.reduce(
    (sum, total, i) => sum + (total - perLineDiscount[i] + perLineTax[i]),
    0,
  );
  const residual = grandTotalAmount - (lineSum + shipping);
  if (residual === 0) {
    return;
  }

  if (lineTotals.length === 0) {
    if (residual !== 0) {
      throw new Error(`Pricing reconciliation failed: residual ${residual} with no lines`);
    }
    return;
  }

  // Largest line (largest lineTotal; ties → lowest index).
  let largest = 0;
  for (let i = 1; i < lineTotals.length; i += 1) {
    if (lineTotals[i] > lineTotals[largest]) {
      largest = i;
    }
  }
  perLineTax[largest] += residual;

  // Re-verify; a non-zero residual now is a bug we refuse to ship.
  const verifySum = lineTotals.reduce(
    (sum, total, i) => sum + (total - perLineDiscount[i] + perLineTax[i]),
    0,
  );
  if (verifySum + shipping !== grandTotalAmount) {
    throw new Error(
      `Pricing reconciliation failed: per-line sum ${verifySum + shipping} !== grandTotal ${grandTotalAmount}`,
    );
  }
}
