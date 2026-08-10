/**
 * The PRINTFUL supplier adapter (#125), selected by #119.
 *
 * One object implementing both halves of the contract — #122's `quote` and
 * #124's order methods — because `SupplierOrderAdapter` extends
 * `SupplierPreflightAdapter` and two lists describing one supplier disagree in
 * the permissive direction.
 *
 * ## What it declares, and the six things it deliberately does not
 *
 * Printful is PRINT-ON-DEMAND. Nothing is picked off a shelf, so there is no
 * stock to hold; nothing published states how long a price is good for; and its
 * returns are a CLAIM process rather than an API RMA. Six capabilities are
 * therefore absent from {@link PRINTFUL_CAPABILITIES}, and each absence is
 * load-bearing rather than a gap somebody should fill:
 *
 * | not declared | what the boundary then does |
 * |---|---|
 * | `inventory_reservation` | a reservation is unrepresentable — there is no row shape |
 * | `quote_expiry` | `providerExpiresAt` is stripped; Mercaria's policy TTL applies |
 * | `price_guarantee` | a `guaranteed` price becomes `advisory` |
 * | `address_validation` | Printful publishes no address-check endpoint |
 * | `tax_duty_estimate` | tax and duty stay absent — see below |
 * | `order_partial_acceptance` | line outcomes are stripped; a split answer is `unknown` |
 * | `tracking_events` | carrier scans are stripped; Printful supplies a NUMBER, not a trail |
 * | `invoice_retrieval`, `credit_note_retrieval`, `return_authorization` | account-gated, unverified — see `docs/suppliers/printful.md` §13–14 |
 *
 * Every one of those downgrades lands on the value that BLOCKS. That is the
 * point of declaring honestly: an undeclared capability costs Mercaria a sale it
 * cannot substantiate, and a falsely declared one costs a customer a promise
 * nobody can keep.
 *
 * `tax_duty_estimate` is the one worth stating at length, because Printful DOES
 * publish a `POST /tax/rates` endpoint and declaring it would look like
 * diligence. It answers about the DESTINATION's sales tax; what a preflight
 * needs is the tax on the supply Printful makes TO MERCARIA, which under an EU
 * B2B reverse charge depends on the VAT ID submitted to Printful billing — and
 * that is `docs/suppliers/printful.md` §11 gate 2, which is OPEN. #119 §4
 * component 5 settles the consequence: supplier-side VAT is input-deductible
 * and is NEVER a customer cost, so the customer's tax comes from Mercaria's own
 * `TaxRate` engine and this answer carries none. Quoting the destination's
 * sales tax as if it were the supplier's would put a number in the cost quote
 * that belongs to neither party. An undeclared tax capability does not block a
 * complete answer unless the active sourcing policy requires it (#122), so the
 * honest absence costs the pilot nothing.
 *
 * ## It is PURE, and that is enforced
 *
 * `supplier-order-isolation.test.ts` scans this directory and fails the build if
 * anything in it imports a database, a repository, a service or the config. So
 * the transport arrives as a {@link PrintfulTransport} and the credential
 * arrives per call, exactly as #124 intends: this adapter holds no secret
 * between calls and cannot cache one across a rotation.
 *
 * ## `live` is refused, and it is a CODE gate rather than a flag
 *
 * There is no Printful account (`docs/suppliers/printful.md` §1–2, §11 gates 1
 * and 5), so a `live` environment must not be reachable by setting an
 * environment variable. {@link assertPrintfulEnvironmentIsReachable} refuses it
 * outright and states what lifting it costs. It fails CLOSED and can never fail
 * open: nothing in this file can manufacture a token.
 */

import type {
  CurrencyCode,
  Money,
  PurchaseOrderReasonCode,
  SupplierAdapterCapability,
  SupplierCancellation,
  SupplierDestinationRestriction,
  SupplierOrderLineOutcome,
  SupplierOrderNormalizedState,
  SupplierOrderState,
  SupplierOrderSubmission,
  SupplierPreflightAnswer,
  SupplierProviderReasonCode,
  SupplierShipment,
  SupplierShippingOption,
} from '@mercaria/shared-types';
import { CURRENCY_PRECISION } from '@mercaria/shared-types';
import type {
  PrintfulRequest,
  PrintfulResponse,
  PrintfulTransport,
} from '../../printful/transport-contract.js';
import { PrintfulTransportError } from '../../printful/transport-contract.js';
import type { SupplierAdapterQuoteInput } from '../../supplier-preflight/adapter.js';
import type {
  SupplierOrderAdapter,
  SupplierOrderCancelInput,
  SupplierOrderLookupInput,
  SupplierOrderPollInput,
  SupplierOrderReadInput,
  SupplierOrderSubmitInput,
  SupplierWebhookInput,
  SupplierWebhookVerification,
} from '../adapter.js';
import { SupplierProviderError } from '../provider-error.js';

/** The slug a `supplier_accounts.provider` must carry to reach this adapter. */
export const PRINTFUL_PROVIDER = 'printful';

/**
 * This adapter's state-mapping version.
 *
 * Bumping it is how a mapping correction is DATED: every row read under it
 * records the number, so an order read last month and one read today are
 * distinguishable rather than silently reinterpreted.
 */
export const PRINTFUL_STATE_MAPPING_VERSION = 1;

/**
 * Printful's own published limit: 120 requests per 60 seconds, leaky bucket,
 * reported through `X-Ratelimit-*` (developers.printful.com, v2 §Rate limits).
 *
 * Stated here as CONSTANTS the registration reads when it provisions #122's
 * `supplier_call_leases` row, so the fleet-wide budget is Printful's number and
 * not a Mercaria guess.
 */
export const PRINTFUL_RATE_LIMIT = Object.freeze({
  requestsPerMinute: 120,
  /**
   * How many calls may be in flight at once, across every ECS task.
   *
   * NOT published by Printful, so it is Mercaria's own politeness bound and is
   * deliberately far below the per-minute allowance: a preflight spends up to
   * four calls, and a pilot bounded at a handful of orders a day has no reason
   * to open more than this.
   */
  concurrency: 4,
});

/**
 * The EU customs-territory countries a pilot dispatch may originate from.
 *
 * ADR 0004 D2.9 permits only EU-customs-territory dispatch, and #119 §3 records
 * the capability Mercaria must NOT design around: Printful publishes no
 * per-order guarantee that an EU-destination order is fulfilled from an EU
 * facility — routing is its own optimisation. So this adapter ENFORCES the
 * bound at quote time (an availability answer outside these regions is never
 * `orderable`) rather than assuming it, and an observed non-EU dispatch origin
 * on a placed order is a pilot stop condition the retail-pilot domain records.
 *
 * It is a code constant rather than configuration on purpose: "which countries
 * are inside the EU customs territory" is a fact about the customs union, not a
 * per-deployment choice, and a configurable list is one typo from admitting a
 * dispatch ADR 0004 forbids.
 */
export const PRINTFUL_EU_FULFILMENT_COUNTRIES: readonly string[] = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
];

/**
 * Printful's own selling-region names, and which ones satisfy the EU bound.
 *
 * `GET /v2/catalog-products/{id}/availability` answers per selling region
 * (`worldwide`, `europe`, `north_america`, …). A variant that is available only
 * outside `europe` cannot be dispatched from an EU facility, so it is not
 * `orderable` for this pilot however much stock Printful reports.
 */
const PRINTFUL_EU_SELLING_REGIONS: readonly string[] = ['europe', 'eu', 'worldwide'];

/**
 * What this adapter can actually do, and nothing more.
 *
 * Thirteen of the twenty-four. See the module docblock for what each absence
 * costs and why it is correct; `docs/suppliers/printful.md` §7 and §10 carry the
 * evidence for each entry.
 */
export const PRINTFUL_CAPABILITIES: readonly SupplierAdapterCapability[] = [
  // Preflight — `GET /v2/catalog-variants/{id}`, `/availability`, `/prices`.
  'live_product_lookup',
  'live_stock_lookup',
  // `POST /v2/shipping-rates` returns costs AND delivery estimates for the
  // recipient address, which is the single call that makes Printful's direct
  // cost complete before any order exists (#119 §4).
  'destination_shipping_quote',
  'delivery_estimate',
  // `POST /v2/orders` creates a DRAFT that fulfils nothing until `confirm`.
  'order_draft_validation',
  // `DELETE /v2/orders/{id}` removes a draft.
  'cancellation_before_submission',
  'update_notifications',
  // Order side.
  'order_draft_submission',
  'order_state_read',
  'order_reference_lookup',
  'order_cancellation',
  'shipment_read',
  'order_webhooks',
  'order_polling',
];

/**
 * Printful's order statuses, mapped to Mercaria's normalized ones.
 *
 * Three entries carry decisions rather than translations, and each is the
 * conservative reading:
 *
 *  - **`onhold` → `accepted`, not `processing`.** Both are pre-shipment, so
 *    neither is wrong about the goods; `accepted` is the LOWER rank, and a
 *    lower rank can never make an order look further along than it is. An order
 *    Printful has stopped is not an order it is working on.
 *  - **`returned` → absent, therefore `unknown`.** A parcel that came back is
 *    neither `delivered` nor `cancelled`, and there is no normalized state that
 *    says it. Mapping it to either would be a false statement to a customer, so
 *    it raises `unmapped_provider_state` and reaches an operator — which is the
 *    correct next action, because the recovery is #127's return path.
 *  - **No entry produces `delivered`.** Printful's lifecycle ends at
 *    `fulfilled` — goods handed to a carrier. Delivery is a CARRIER fact this
 *    provider never asserts, and inventing one would start the return window
 *    from a date nobody observed.
 *
 * Anything absent answers `unknown` by construction. That is not a gap: it is
 * how a status Printful adds later is DISCOVERED rather than silently read as
 * the nearest-looking one.
 */
const PRINTFUL_ORDER_STATES: Readonly<Record<string, SupplierOrderNormalizedState>> = {
  draft: 'received',
  pending: 'accepted',
  onhold: 'accepted',
  'on-hold': 'accepted',
  inprocess: 'processing',
  partial: 'partially_shipped',
  fulfilled: 'shipped',
  canceled: 'cancelled',
  cancelled: 'cancelled',
  failed: 'rejected',
};

/**
 * Printful's error vocabulary, mapped to the closed reason set.
 *
 * The provider's own message is unbounded free text shaped by somebody else and
 * NEVER lands in a column (#122's `SupplierProviderReasonCode` docblock). What
 * is matched is the RFC 9457 `title`/`detail` reduced to a lower-case token, and
 * anything unrecognised is `other` rather than a guess.
 */
function printfulReasonCode(status: number, detail: string): SupplierProviderReasonCode {
  const text = detail.toLowerCase();
  if (status === 401 || status === 403) return 'credential_invalid';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_internal_error';
  if (text.includes('out of stock') || text.includes('discontinued')) {
    return text.includes('discontinued') ? 'discontinued' : 'out_of_stock';
  }
  if (text.includes('variant') && (text.includes('not found') || text.includes('unknown'))) {
    return 'sku_unknown';
  }
  if (text.includes('country') || text.includes('shipping to') || text.includes('destination')) {
    return 'destination_unsupported';
  }
  if (text.includes('currency')) return 'currency_unsupported';
  if (status === 404) return 'sku_unknown';
  if (status === 400 || status === 422) return 'validation_rejected';
  return 'other';
}

/**
 * Why a purchase order was REJECTED, in #118's own closed vocabulary.
 *
 * A second, narrower mapping than {@link printfulReasonCode} rather than a
 * widening of it, because the two answer different questions and their tuples
 * genuinely differ: `SupplierProviderReasonCode` classifies a CALL that failed
 * (`credential_invalid`, `rate_limited`), and `PurchaseOrderReasonCode`
 * classifies an ORDER that will not be fulfilled. Collapsing them would put
 * `rate_limited` on a purchase order, which reads to an operator as a
 * commercial refusal when it was a transport one.
 *
 * Anything unrecognised is `supplier_error` rather than `other`: Printful
 * answered and refused, which is a supplier fact, where `other` reads as
 * "nobody classified this".
 */
function printfulOrderReasonCode(detail: string): PurchaseOrderReasonCode {
  const value = detail.toLowerCase();
  if (value.includes('out of stock') || value.includes('discontinued')) return 'out_of_stock';
  if (value.includes('variant') || value.includes('not found')) return 'sku_unknown';
  if (value.includes('address') || value.includes('zip') || value.includes('postal')) {
    return 'address_invalid';
  }
  if (value.includes('country') || value.includes('shipping to')) return 'destination_not_served';
  if (value.includes('price')) return 'price_changed';
  return 'supplier_error';
}

/**
 * THE go-live gate, in TWO layers, and only the second one ever goes away.
 *
 * **Layer one — `live` is refused outright, today.** No Printful account
 * exists, no contract is signed, and `docs/suppliers/printful.md` §11's
 * eight-item entry checklist is entirely OPEN — including gate 8, the
 * end-to-end test order, which is the first time any of this code will have
 * touched a real provider. A live call before that is not a configuration
 * choice somebody could reasonably make; it is money leaving through a path
 * nothing has exercised. So it is refused HERE, in the adapter, where no
 * environment variable and no copied staging flag can reach it.
 *
 * Lifting it is one deliberate act: delete the `LIVE_REFUSED_UNTIL_GATED`
 * branch below, in a change that records §11's gates as done. That is the
 * whole of what #125's successor has to do, and it is deliberately a CODE
 * change rather than a setting, because a setting is what gets flipped at 3am
 * by somebody who has not read the checklist.
 *
 * **Layer two — the credential.** It outlives layer one and is what keeps a
 * `live` account safe afterwards: an empty token, or one of the placeholder
 * values a half-finished secret sync leaves behind (`-`, `TODO` — the standing
 * secrets rule names exactly these), authenticates as nobody, and on a WRITE
 * cannot be told from a refusal. `auth`, not `retryable`: an unprovisioned
 * account answers identically every time, and retrying burns the rate budget on
 * a question already answered.
 *
 * A `null` credential means the ORDER contract's value is not in play — the
 * quote path, where #122 hands none. Layer two is not skipped there, it is
 * DELEGATED: `createPrintfulTransport` refuses a call it cannot resolve a
 * credential for, so both paths fail closed and neither can fail open.
 */
const LIVE_REFUSED_UNTIL_GATED = true;

function assertPrintfulEnvironmentIsReachable(
  environment: 'test' | 'live',
  credential: string | null,
): void {
  if (environment !== 'live') return;
  if (LIVE_REFUSED_UNTIL_GATED) {
    throw new SupplierProviderError({
      message:
        'the Printful adapter refuses a `live` supplier account: no Printful account exists and ' +
        'no end-to-end test order has been run (docs/suppliers/printful.md §11, every gate open). ' +
        'Lifting this is a code change that records those gates, not a setting.',
      errorClass: 'auth',
      afterWrite: false,
    });
  }
  if (credential === null) return;
  const token = credential.trim();
  if (token === '' || token === '-' || token.toUpperCase() === 'TODO') {
    throw new SupplierProviderError({
      message:
        'the Printful adapter refuses a `live` supplier account with no provisioned credential: ' +
        'a live call with a placeholder token cannot be told from a refusal',
      errorClass: 'auth',
      afterWrite: false,
    });
  }
}

/** Read a Printful decimal money string into minor units, in STRING arithmetic. */
function printfulMinorUnits(value: unknown, currency: CurrencyCode): number | null {
  // Deliberately NOT `parseFeedMoney`: that parser resolves the locale
  // ambiguity of a merchant's FILE (`1.234,56`), and applying its grouping
  // heuristic to an API field that is always a plain decimal point would read a
  // legitimate `1.234` as one thousand two hundred and thirty-four. An API
  // value is unambiguous, so the parser refuses anything that is not.
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const precision = CURRENCY_PRECISION[currency];
  if (precision === undefined) return null;
  const [integer, fraction = ''] = text.split('.');
  // `Math.round(19.99 * 100)` is 1999 and `Math.round(1.005 * 100)` is 100 —
  // the second is wrong and is invisible until somebody is charged it. Padding
  // and truncating as TEXT gives the exact value Printful wrote.
  const padded = `${fraction}${'0'.repeat(precision + 1)}`;
  const kept = padded.slice(0, precision);
  const nextDigit = Number(padded.slice(precision, precision + 1));
  const scaled = Number(`${integer}${kept}`);
  if (!Number.isSafeInteger(scaled)) return null;
  const rounded = nextDigit >= 5 ? scaled + 1 : scaled;
  return Number.isSafeInteger(rounded) ? rounded : null;
}

function money(value: unknown, currency: CurrencyCode): Money | null {
  const amount = printfulMinorUnits(value, currency);
  return amount === null ? null : { amount, currency };
}

/** Read a property off an unknown JSON body without asserting its shape. */
function field(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  return (source as Record<string, unknown>)[key];
}

function text(source: unknown, key: string): string | null {
  const value = field(source, key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function integer(source: unknown, key: string): number | null {
  const value = field(source, key);
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function list(source: unknown, key: string): readonly unknown[] {
  const value = field(source, key);
  return Array.isArray(value) ? value : [];
}

/**
 * Printful answers v1 as `{ code, result }` and v2 as the object itself.
 *
 * Unwrapping in ONE place is what lets the rest of this file read one shape
 * whichever version an endpoint lives on — and #119 §12 pins the integration to
 * v1 where equivalent, so both are genuinely in play.
 */
function payload(response: PrintfulResponse): unknown {
  const result = field(response.body, 'result');
  return result === undefined ? response.body : result;
}

/** The RFC 9457 `detail`, or v1's `result` string, reduced to one line. */
function errorDetail(response: PrintfulResponse): string {
  for (const key of ['detail', 'title', 'error', 'result', 'message']) {
    const value = field(response.body, key);
    if (typeof value === 'string' && value.length > 0) return value.slice(0, 300);
    const nested = field(value, 'message');
    if (typeof nested === 'string' && nested.length > 0) return nested.slice(0, 300);
  }
  return `printful responded ${response.status}`;
}

/**
 * Turn any transport outcome into either a body or a classified throw.
 *
 * `afterWrite` is carried from the transport for a socket failure and is
 * `false` for every HTTP answer — an answer means Printful decided, and its
 * decision is in the status. The one exception is an unparseable 2xx, which is
 * ambiguous: the call succeeded and nobody can read what it did.
 */
function unwrap(response: PrintfulResponse, operation: string): unknown {
  if (response.status >= 200 && response.status < 300) {
    if (!response.parsed && response.status !== 204) {
      throw new SupplierProviderError({
        message: `printful ${operation} answered ${response.status} with an unreadable body`,
        errorClass: 'unknown',
        afterWrite: true,
      });
    }
    return payload(response);
  }
  const detail = errorDetail(response);
  const reason = printfulReasonCode(response.status, detail);
  if (response.status === 429) {
    const retryAfter = Number(response.headers['retry-after'] ?? response.headers['Retry-After'] ?? '');
    throw new SupplierProviderError({
      message: `printful ${operation} was rate limited`,
      errorClass: 'quota',
      afterWrite: false,
      providerCode: reason,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : null,
    });
  }
  if (response.status === 401 || response.status === 403) {
    throw new SupplierProviderError({
      message: `printful ${operation} rejected the credential`,
      errorClass: 'auth',
      afterWrite: false,
      providerCode: reason,
    });
  }
  if (response.status >= 500) {
    throw new SupplierProviderError({
      message: `printful ${operation} failed upstream (${response.status})`,
      errorClass: 'retryable',
      afterWrite: false,
      providerCode: reason,
    });
  }
  throw new SupplierProviderError({
    // The provider's own words never reach a column; the CODE does.
    message: `printful ${operation} refused the request (${response.status})`,
    errorClass: response.status === 404 ? 'terminal' : 'validation',
    afterWrite: false,
    providerCode: reason,
  });
}

/** Every call this adapter makes, so the transport's failure model is applied once. */
async function call(
  transport: PrintfulTransport,
  request: PrintfulRequest,
  operation: string,
): Promise<unknown> {
  let response: PrintfulResponse;
  try {
    response = await transport.call(request);
  } catch (error) {
    if (error instanceof PrintfulTransportError) {
      throw new SupplierProviderError({
        message: `printful ${operation}: ${error.message}`,
        // A socket failure is retryable in the ordinary sense; whether it may be
        // RESUBMITTED is the separate `afterWrite` question the orchestration
        // asks, and it is the transport's answer rather than this classification.
        errorClass: 'retryable',
        afterWrite: error.afterWrite,
        cause: error,
      });
    }
    throw error;
  }
  return unwrap(response, operation);
}

/** The line shape Printful's order API takes. */
function orderItems(
  lines: SupplierOrderSubmitInput['draft']['lines'],
): readonly Record<string, unknown>[] {
  return lines.map((line) => ({
    // Printful's own catalogue variant id, which is what the procurement offer
    // stores as the supplier SKU. It is sent as `variant_id` when numeric and as
    // `external_variant_id` otherwise, because a sync variant is addressed by
    // the merchant's own id and a catalogue variant by Printful's.
    ...(/^\d+$/.test(line.supplierSku)
      ? { variant_id: Number(line.supplierSku) }
      : { external_variant_id: line.supplierSku }),
    quantity: line.quantity,
    // Mercaria's own line handle, echoed back on the order so a line outcome
    // can be attributed without matching on a SKU that may repeat.
    external_id: line.clientLineReference,
  }));
}

/** The recipient shape Printful's order and shipping-rate APIs take. */
function recipient(destination: SupplierOrderSubmitInput['draft']['destination']): Record<string, unknown> {
  return {
    name: destination.recipient.name,
    ...(destination.recipient.company ? { company: destination.recipient.company } : {}),
    address1: destination.address.line1,
    ...(destination.address.line2 ? { address2: destination.address.line2 } : {}),
    city: destination.address.city,
    ...(destination.address.region ? { state_code: destination.address.region } : {}),
    country_code: destination.address.country,
    zip: destination.address.postalCode,
    ...(destination.recipient.phone ? { phone: destination.recipient.phone } : {}),
  };
}

/** One Printful order object, read into the normalized state. */
function readOrderState(order: unknown, currency: CurrencyCode): SupplierOrderState {
  const providerState = text(order, 'status') ?? '';
  const costs = field(order, 'costs');
  const total = money(field(costs, 'total'), currency);
  const shipments = list(order, 'shipments')
    .map((entry) => readShipment(entry))
    .filter((entry): entry is SupplierShipment => entry !== null);
  const externalOrderId = text(order, 'id') ?? String(integer(order, 'id') ?? '');
  const state = PRINTFUL_ORDER_STATES[providerState] ?? 'unknown';
  // A rejection has to say WHY, or an operator reading the purchase order sees
  // a refusal with no next action. The provider's own sentence never lands —
  // only the closed code it maps to — so `providerMessage` stays null whatever
  // Printful wrote.
  const failure = state === 'rejected' || state === 'cancelled'
    ? (text(order, 'error') ?? text(order, 'reason') ?? text(order, 'dashboard_url') ?? '')
    : '';
  return {
    externalOrderId: externalOrderId === '' ? null : externalOrderId,
    state,
    providerState,
    stateMappingVersion: PRINTFUL_STATE_MAPPING_VERSION,
    observedAt: new Date().toISOString(),
    reasonCode: state === 'rejected' ? printfulOrderReasonCode(failure) : null,
    providerMessage: null,
    total,
    // Printful reports no per-line acceptance, and `order_partial_acceptance` is
    // undeclared, so the boundary would strip these anyway. Emitting none is the
    // honest form of the same statement.
    lineOutcomes: [] as readonly SupplierOrderLineOutcome[],
    duplicateOfExistingOrder: false,
    shipments,
    // Printful accepts a cancellation only while an order has not entered
    // fulfilment; `fulfilled`, `canceled` and `failed` are past that point.
    cancellable: providerState === 'draft' || providerState === 'pending' || providerState === 'onhold',
  };
}

/** One Printful shipment, or nothing when it carries no tracking number. */
function readShipment(entry: unknown): SupplierShipment | null {
  const trackingNumber = text(entry, 'tracking_number');
  // A shipment with no tracking number cannot be followed and cannot be told
  // apart from another parcel of the same order, so it is not reported. An
  // absent parcel blocks; an unidentifiable one would pretend to inform.
  if (trackingNumber === null) return null;
  const shipDate = text(entry, 'ship_date');
  const shippedAt = shipDate === null ? new Date().toISOString() : new Date(shipDate).toISOString();
  const numericId = integer(entry, 'id');
  return {
    shipmentReference: text(entry, 'id') ?? (numericId === null ? null : String(numericId)),
    trackingNumber,
    carrier: text(entry, 'carrier'),
    service: text(entry, 'service'),
    shippedAt,
    // Printful never asserts delivery — its lifecycle ends at handover to a
    // carrier. `null` is the true answer, and `tracking_events` is undeclared
    // so a scan trail is unrepresentable too.
    deliveredAt: null,
    packages: [],
    trackingEvents: [],
  };
}

/** A submission view of an order Printful answered with. */
function toSubmission(state: SupplierOrderState, duplicate: boolean): SupplierOrderSubmission {
  return {
    externalOrderId: state.externalOrderId,
    state: state.state,
    providerState: state.providerState,
    stateMappingVersion: state.stateMappingVersion,
    observedAt: state.observedAt,
    reasonCode: state.reasonCode,
    providerMessage: state.providerMessage,
    total: state.total,
    lineOutcomes: state.lineOutcomes,
    duplicateOfExistingOrder: duplicate,
  };
}

/**
 * How many pages of recent orders a client-reference lookup may read.
 *
 * Bounded because the lookup runs on the ambiguity path, where a slow answer
 * delays a paid customer's order; and because an unbounded scan of an account's
 * whole history would spend the rate budget the submission retry needs. Hitting
 * the bound is NOT "not found" — see {@link findOrderByClientReference}.
 */
const LOOKUP_PAGE_LIMIT = 5;
const LOOKUP_PAGE_SIZE = 100;

/** Build the adapter over one transport. */
export function createPrintfulOrderAdapter(transport: PrintfulTransport): SupplierOrderAdapter {
  /** Every call shares the account gate and the credential. */
  const request = (
    context: { providerAccountId: string; environment: 'test' | 'live'; credential: string; timeoutMs: number },
    parts: Pick<PrintfulRequest, 'method' | 'path'> & Partial<PrintfulRequest>,
  ): PrintfulRequest => {
    assertPrintfulEnvironmentIsReachable(context.environment, context.credential);
    return {
      credential: context.credential,
      // The provider account id IS the Printful store id for an account-level
      // token; a store-scoped token ignores the header, which is why it is
      // always sent rather than conditionally omitted.
      storeId: context.providerAccountId,
      timeoutMs: context.timeoutMs,
      ...parts,
    };
  };

  return {
    provider: PRINTFUL_PROVIDER,
    capabilities: PRINTFUL_CAPABILITIES,
    stateMappingVersion: PRINTFUL_STATE_MAPPING_VERSION,

    mapProviderState(providerState: string): SupplierOrderNormalizedState {
      return PRINTFUL_ORDER_STATES[providerState.trim().toLowerCase()] ?? 'unknown';
    },

    /**
     * The #122 half: what Printful says about this exact item, right now.
     *
     * Four calls, in an order that spends the cheapest refusals first — the
     * variant must exist before its availability matters, and its availability
     * must permit an EU dispatch before a shipping rate is worth asking for.
     * A failure at any step throws, and #122's `unknownAnswer()` is what the
     * caller turns that into: `unknown` availability, which BLOCKS.
     */
    async quote(input: SupplierAdapterQuoteInput): Promise<SupplierPreflightAnswer> {
      const currency = input.currency as CurrencyCode;
      // `credential: null` — #122's quote contract carries none, so the
      // transport resolves one for this account and refuses a `live` one it
      // cannot. See `PrintfulRequest.credential`.
      const context = {
        providerAccountId: input.providerAccountId,
        environment: input.environment,
        credential: null,
        timeoutMs: input.timeoutMs,
      };
      const identity = await resolveVariant(transport, context, input);
      if (identity.identity !== 'confirmed') {
        return {
          ...emptyAnswer(),
          identity: identity.identity,
          reasonCodes: identity.reasonCodes,
        };
      }

      const availability = await resolveAvailability(transport, context, identity.variantId);
      const unitCost = identity.price;
      const shipping = await resolveShipping(transport, context, input, identity.variantId, currency);

      return {
        identity: 'confirmed',
        availability: availability.state,
        maxOrderableQuantity: null,
        minimumOrderQuantity: 1,
        packSize: 1,
        unitCost: unitCost === null ? null : { amount: unitCost, currency },
        supplierFees: null,
        shipping: shipping.quote,
        shippingOptions: shipping.options,
        handlingDaysMin: null,
        handlingDaysMax: null,
        dispatchDaysMin: null,
        dispatchDaysMax: null,
        deliveryDaysMin: shipping.deliveryDaysMin,
        deliveryDaysMax: shipping.deliveryDaysMax,
        // Absent, not zero, and not the destination's sales tax — see the
        // module docblock on `tax_duty_estimate`. Customs is structurally zero
        // for an EU dispatch to an EU destination (ADR 0004 D2.9), so there is
        // no duty and no import responsibility to assign either.
        tax: null,
        duty: null,
        importResponsibility: null,
        fulfilmentOriginCountry: availability.originCountry,
        destinationRestrictions: shipping.restrictions,
        providerQuoteReference: null,
        // Printful states no expiry on a rate or a catalogue price, and
        // `quote_expiry` is undeclared — Mercaria's own policy TTL applies.
        providerExpiresAt: null,
        // Published prices are OBSERVED, never held. Declaring otherwise would
        // be `inferred_price_guarantee`.
        priceGuarantee: 'advisory',
        stockGuarantee: 'advisory',
        // Print-on-demand holds nothing. `inventory_reservation` is undeclared,
        // so this is the only branch that could ever be returned.
        reservation: { supported: false, reason: 'capability_not_declared' },
        reasonCodes: availability.reasonCodes,
        sourceRecordRef: null,
      };
    },

    // No `releaseReservation`: `inventory_reservation` is undeclared, and
    // `registerSupplierAdapter` refuses the pair only in the other direction.
    // A method here would be dead code claiming a hold exists to hand back.

    /**
     * Create the DRAFT and confirm it — two calls, and the split is the design.
     *
     * `POST /v2/orders` creates an order that fulfils nothing;
     * `POST /v2/orders/{id}/confirm` is what commits it. A failure BETWEEN them
     * leaves a draft, which is exactly the recoverable state: the convergence
     * lookup finds it by client reference and this method adopts it rather than
     * creating a second one.
     */
    async submitOrder(input: SupplierOrderSubmitInput): Promise<SupplierOrderSubmission> {
      const currency = input.draft.currency;
      const created = await call(
        transport,
        request(input, {
          method: 'POST',
          path: '/v2/orders',
          body: {
            external_id: input.draft.clientReference,
            recipient: recipient(input.draft.destination),
            order_items: orderItems(input.draft.lines),
            ...(input.draft.shippingServiceCode ? { shipping: input.draft.shippingServiceCode } : {}),
            currency,
          },
        }),
        'order create',
      );

      const draftState = readOrderState(created, currency);
      if (draftState.externalOrderId === null) {
        // An accepted create with no id is unusable and, crucially, AMBIGUOUS:
        // the order may exist and Mercaria cannot address it.
        throw new SupplierProviderError({
          message: 'printful order create answered without an order id',
          errorClass: 'unknown',
          afterWrite: true,
        });
      }

      const confirmed = await call(
        transport,
        request(input, {
          method: 'POST',
          path: `/v2/orders/${encodeURIComponent(draftState.externalOrderId)}/confirm`,
        }),
        'order confirm',
      );
      return toSubmission(readOrderState(confirmed, currency), false);
    },

    /**
     * A dry run that creates a DRAFT and deletes it again.
     *
     * Printful publishes no separate validation endpoint, and a draft is the
     * documented way to have it check a recipient and a variant set without
     * fulfilling anything (#119 §3 row 9). The delete is best-effort by
     * construction: a draft left behind costs nothing and is visible, whereas
     * failing the validation because the cleanup failed would refuse a
     * checkout over housekeeping.
     */
    async validateDraft(input: SupplierOrderSubmitInput): Promise<SupplierOrderSubmission> {
      const currency = input.draft.currency;
      const created = await call(
        transport,
        request(input, {
          method: 'POST',
          path: '/v2/orders',
          body: {
            external_id: `${input.draft.clientReference}:validate`,
            recipient: recipient(input.draft.destination),
            order_items: orderItems(input.draft.lines),
            currency,
          },
        }),
        'order validate',
      );
      const state = readOrderState(created, currency);
      if (state.externalOrderId !== null) {
        // The cleanup RETHROWS rather than being swallowed, and that is the
        // conservative direction rather than the tidy one. A validation draft
        // whose delete failed is a draft Printful still holds under a reference
        // one character from the real one, so reporting the validation as
        // successful would leave a stray order behind with nothing recording
        // it. A failure here is `afterWrite: true` for the same reason: the
        // draft exists.
        await call(
          transport,
          request(input, {
            method: 'DELETE',
            path: `/v2/orders/${encodeURIComponent(state.externalOrderId)}`,
          }),
          'order validate cleanup',
        );
      }
      return toSubmission(state, false);
    },

    async readOrder(input: SupplierOrderReadInput): Promise<SupplierOrderState> {
      const order = await call(
        transport,
        request(input, { method: 'GET', path: `/v2/orders/${encodeURIComponent(input.externalOrderId)}` }),
        'order read',
      );
      return readOrderState(order, 'EUR');
    },

    /**
     * THE ambiguity converger, and the one method whose `null` costs money.
     *
     * #124's `convergeAmbiguousSubmission` treats `null` as PROOF that the
     * provider holds no order under Mercaria's reference, and it is the one path
     * on which a second submission is reachable. So `null` is returned only when
     * absence is genuinely PROVEN, and every other outcome THROWS — leaving the
     * ambiguity standing, which the outbox retries and which submits nothing in
     * the meantime.
     *
     * Two conditions have to hold, and the second is the one nobody expects:
     *
     *  1. **The scan was exhaustive.** Hitting {@link LOOKUP_PAGE_LIMIT} means
     *     the order may be on a page nobody read.
     *  2. **At least one order carried an `external_id` PROPERTY, or there were
     *     no orders at all.** Printful documents `external_id` addressing for
     *     Sync Products and Variants and does NOT document it for the Orders API
     *     (`docs/suppliers/printful.md` §11, an open gate). If this account's
     *     order objects do not echo the field, every comparison fails and the
     *     scan reports "not found" for an order that exists — a check that
     *     cannot tell success from failure, and one whose failure direction is a
     *     duplicate supplier order. An account with NO orders is the honest
     *     exception: nothing to echo, and absence is established by the empty
     *     enumeration itself.
     */
    async findOrderByClientReference(
      input: SupplierOrderLookupInput,
    ): Promise<SupplierOrderState | null> {
      let seenOrders = 0;
      let seenExternalIds = 0;
      for (let page = 0; page < LOOKUP_PAGE_LIMIT; page += 1) {
        const body = await call(
          transport,
          request(input, {
            method: 'GET',
            path: '/v2/orders',
            query: { limit: LOOKUP_PAGE_SIZE, offset: page * LOOKUP_PAGE_SIZE },
          }),
          'order lookup',
        );
        const orders = Array.isArray(body) ? body : list(body, 'data');
        for (const order of orders) {
          seenOrders += 1;
          const external = field(order, 'external_id');
          if (external !== undefined && external !== null) seenExternalIds += 1;
          if (external === input.clientReference) return readOrderState(order, 'EUR');
        }
        if (orders.length < LOOKUP_PAGE_SIZE) {
          // The enumeration is exhausted. Absence is provable only if the field
          // was observable at all.
          if (seenOrders > 0 && seenExternalIds === 0) {
            throw new SupplierProviderError({
              message:
                'printful order lookup read ' +
                `${String(seenOrders)} orders and none carried an external_id, so the absence of ` +
                'Mercaria’s reference proves nothing — treating it as “no such order” would ' +
                'permit a duplicate supplier order',
              errorClass: 'unknown',
              afterWrite: false,
            });
          }
          return null;
        }
      }
      throw new SupplierProviderError({
        message:
          `printful order lookup reached its ${String(LOOKUP_PAGE_LIMIT)}-page bound without ` +
          'exhausting the account’s orders, so absence is unproven',
        errorClass: 'retryable',
        afterWrite: false,
      });
    },

    /**
     * Ask Printful to cancel — `DELETE /v2/orders/{id}`.
     *
     * A refusal is REPORTED as a rejection rather than thrown: #124 keeps the
     * four cancellation answers apart, and a supplier that will not cancel is
     * an answer a customer needs, not a transport failure to retry.
     */
    async cancelOrder(input: SupplierOrderCancelInput): Promise<SupplierCancellation> {
      try {
        await call(
          transport,
          request(input, {
            method: 'DELETE',
            path: `/v2/orders/${encodeURIComponent(input.externalOrderId)}`,
          }),
          'order cancel',
        );
      } catch (error) {
        if (
          error instanceof SupplierProviderError &&
          (error.errorClass === 'validation' || error.errorClass === 'terminal') &&
          !error.afterWrite
        ) {
          return {
            state: 'rejected',
            reasonCode: 'supplier_cancelled',
            providerMessage: null,
            observedAt: new Date().toISOString(),
            lineOutcomes: [],
          };
        }
        throw error;
      }
      return {
        state: 'accepted',
        reasonCode: 'operator_cancelled',
        providerMessage: null,
        observedAt: new Date().toISOString(),
        lineOutcomes: [],
      };
    },

    async readShipments(input: SupplierOrderReadInput): Promise<readonly SupplierShipment[]> {
      const order = await call(
        transport,
        request(input, { method: 'GET', path: `/v2/orders/${encodeURIComponent(input.externalOrderId)}` }),
        'shipment read',
      );
      return readOrderState(order, 'EUR').shipments;
    },

    /**
     * Verify a Printful webhook delivery.
     *
     * SYNCHRONOUS, per the contract: verification is a signature check and never
     * a network call, so a delivery cannot be admitted because a verification
     * lookup happened to succeed.
     *
     * Printful's published webhook security is HTTPS enforcement plus a request
     * signature and an expiry on the payload. The exact signing scheme is
     * account-gated (`docs/suppliers/printful.md` §15), so what is verified here
     * is the SHARED SECRET Printful echoes in the configured callback URL's
     * path — the mechanism a deployment can actually establish today — and the
     * refusal branch carries no parsed content at all, which is what makes an
     * unverified delivery unstorable rather than stored-and-applied-later.
     */
    verifyWebhook(input: SupplierWebhookInput): SupplierWebhookVerification {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.body.toString('utf8'));
      } catch {
        return { verified: false, reason: 'unparseable body' };
      }
      const presented = text(parsed, 'secret');
      if (presented === null || !timingSafeEqualText(presented, input.secret)) {
        return { verified: false, reason: 'shared secret mismatch' };
      }
      const type = text(parsed, 'type') ?? '';
      const data = field(parsed, 'data');
      const order = field(data, 'order') ?? data;
      const providerState = text(order, 'status') ?? '';
      const created = integer(parsed, 'created');
      const observedAt = created === null ? new Date() : new Date(created * 1_000);
      const shipmentEntry = field(data, 'shipment');
      const shipment = shipmentEntry === undefined ? null : readShipment(shipmentEntry);
      const externalOrderId = text(order, 'id') ?? String(integer(order, 'id') ?? '');
      return {
        verified: true,
        verification: 'shared_secret',
        // Printful does not publish a per-delivery event id, so the identity of
        // a delivery is its type, its order and its instant — deterministic, so
        // a redelivery converges on ONE stored row rather than doubling a
        // shipment.
        providerEventId: `${type}:${externalOrderId}:${String(observedAt.getTime())}`,
        eventType: type,
        externalOrderId: externalOrderId === '' ? null : externalOrderId,
        clientReference: text(order, 'external_id'),
        state: PRINTFUL_ORDER_STATES[providerState] ?? 'unknown',
        providerState,
        observedAt,
        payload: { orderStatus: providerState, eventType: type },
        shipments: shipment === null ? [] : [shipment],
      };
    },

    async pollChanges(input: SupplierOrderPollInput): Promise<readonly SupplierOrderState[]> {
      const body = await call(
        transport,
        request(input, {
          method: 'GET',
          path: '/v2/orders',
          query: { limit: Math.min(input.limit, LOOKUP_PAGE_SIZE), offset: 0 },
        }),
        'order poll',
      );
      const orders = Array.isArray(body) ? body : list(body, 'data');
      return orders
        .map((order) => readOrderState(order, 'EUR'))
        .filter((state) => new Date(state.observedAt).getTime() >= input.since.getTime())
        .slice(0, input.limit);
    },
  };
}

/** A constant-time text comparison, so a secret is not learnable one byte at a time. */
function timingSafeEqualText(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < presented.length; index += 1) {
    diff |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

/** The answer shape a refused identity carries: everything unknown, nothing claimed. */
function emptyAnswer(): SupplierPreflightAnswer {
  return {
    identity: 'unknown',
    availability: 'unknown',
    maxOrderableQuantity: null,
    minimumOrderQuantity: null,
    packSize: null,
    unitCost: null,
    supplierFees: null,
    shipping: { basis: 'unknown', restrictions: [] },
    shippingOptions: [],
    handlingDaysMin: null,
    handlingDaysMax: null,
    dispatchDaysMin: null,
    dispatchDaysMax: null,
    deliveryDaysMin: null,
    deliveryDaysMax: null,
    tax: null,
    duty: null,
    importResponsibility: null,
    fulfilmentOriginCountry: null,
    destinationRestrictions: [],
    providerQuoteReference: null,
    providerExpiresAt: null,
    priceGuarantee: 'advisory',
    stockGuarantee: 'advisory',
    reservation: { supported: false, reason: 'capability_not_declared' },
    reasonCodes: [],
    sourceRecordRef: null,
  };
}

interface VariantIdentity {
  identity: SupplierPreflightAnswer['identity'];
  variantId: string;
  price: number | null;
  reasonCodes: readonly SupplierProviderReasonCode[];
}

/** Confirm the exact catalogue variant and read its published price. */
async function resolveVariant(
  transport: PrintfulTransport,
  context: { providerAccountId: string; environment: 'test' | 'live'; credential: string; timeoutMs: number },
  input: SupplierAdapterQuoteInput,
): Promise<VariantIdentity> {
  assertPrintfulEnvironmentIsReachable(context.environment, context.credential);
  const sku = input.supplierSku.trim();
  if (!/^\d+$/.test(sku)) {
    // Printful's catalogue variants are numeric ids. A SKU that is not one
    // cannot be resolved to exactly one variant, and guessing which product a
    // free-text SKU means is how two different garments become one offer.
    return { identity: 'ambiguous', variantId: sku, price: null, reasonCodes: ['sku_ambiguous'] };
  }
  const variant = await call(
    transport,
    {
      method: 'GET',
      path: `/v2/catalog-variants/${sku}`,
      credential: context.credential,
      storeId: context.providerAccountId,
      timeoutMs: context.timeoutMs,
    },
    'catalog variant read',
  );
  const resolvedId = String(integer(variant, 'id') ?? text(variant, 'id') ?? '');
  if (resolvedId === '') {
    return { identity: 'unknown', variantId: sku, price: null, reasonCodes: ['sku_unknown'] };
  }
  if (resolvedId !== sku) {
    // Printful answered about a DIFFERENT variant. #122 keeps `mismatched` and
    // `ambiguous` apart on purpose: this one is a catalogue correction (#59),
    // not an operator exception.
    return { identity: 'mismatched', variantId: resolvedId, price: null, reasonCodes: ['sku_unknown'] };
  }
  const prices = await call(
    transport,
    {
      method: 'GET',
      path: `/v2/catalog-variants/${sku}/prices`,
      credential: context.credential,
      storeId: context.providerAccountId,
      timeoutMs: context.timeoutMs,
    },
    'catalog variant prices',
  );
  const currency = input.currency as CurrencyCode;
  const priceCurrency = text(prices, 'currency');
  // A price in another currency is NOT converted here: this domain does no FX
  // (#122's own rule), and converting a supplier cost inside an adapter would
  // put a rate nobody recorded into a customer's price.
  const amount =
    priceCurrency !== null && priceCurrency.toUpperCase() !== currency
      ? null
      : printfulMinorUnits(field(field(prices, 'product'), 'price') ?? field(prices, 'price'), currency);
  return { identity: 'confirmed', variantId: sku, price: amount, reasonCodes: [] };
}

interface AvailabilityAnswer {
  state: SupplierPreflightAnswer['availability'];
  originCountry: string | null;
  reasonCodes: readonly SupplierProviderReasonCode[];
}

/**
 * Whether this variant can be made AND dispatched from inside the EU customs
 * territory (ADR 0004 D2.9).
 *
 * The EU check is the bound #119 §3 says the adapter must ENFORCE rather than
 * assume, and it lands on `unavailable` rather than `unknown` deliberately:
 * Printful answered, and the answer is that this item cannot be dispatched from
 * where the pilot requires. That is a fact a buyer can act on, where `unknown`
 * would route it to an operator who has nothing to fix.
 */
async function resolveAvailability(
  transport: PrintfulTransport,
  context: { providerAccountId: string; environment: 'test' | 'live'; credential: string; timeoutMs: number },
  variantId: string,
): Promise<AvailabilityAnswer> {
  const body = await call(
    transport,
    {
      method: 'GET',
      path: `/v2/catalog-variants/${encodeURIComponent(variantId)}/availability`,
      credential: context.credential,
      storeId: context.providerAccountId,
      timeoutMs: context.timeoutMs,
    },
    'catalog availability read',
  );
  const entries = list(body, 'data');
  if (entries.length === 0) {
    // No availability statement at all. Not a refusal — Mercaria simply does not
    // know, which blocks.
    return { state: 'unknown', originCountry: null, reasonCodes: [] };
  }
  let anyStocked = false;
  let euStocked = false;
  let originCountry: string | null = null;
  for (const entry of entries) {
    const region = (text(entry, 'selling_region_name') ?? '').toLowerCase();
    const status = (text(entry, 'availability') ?? '').toLowerCase();
    const stocked = status === 'in stock' || status === 'in_stock' || status === 'stocked_on_demand';
    if (!stocked) continue;
    anyStocked = true;
    if (PRINTFUL_EU_SELLING_REGIONS.includes(region)) {
      euStocked = true;
      for (const technique of list(entry, 'techniques')) {
        const country = (text(technique, 'country_code') ?? '').toUpperCase();
        if (PRINTFUL_EU_FULFILMENT_COUNTRIES.includes(country)) originCountry = country;
      }
    }
  }
  if (euStocked) return { state: 'orderable', originCountry, reasonCodes: [] };
  if (anyStocked) {
    return { state: 'restricted', originCountry: null, reasonCodes: ['destination_unsupported'] };
  }
  return { state: 'unavailable', originCountry: null, reasonCodes: ['out_of_stock'] };
}

interface ShippingAnswer {
  quote: SupplierPreflightAnswer['shipping'];
  options: readonly SupplierShippingOption[];
  deliveryDaysMin: number | null;
  deliveryDaysMax: number | null;
  restrictions: readonly SupplierDestinationRestriction[];
}

/**
 * `POST /v2/shipping-rates`.
 *
 * The shipping basis is `basket`, and that is a fact about Printful rather than
 * a simplification: it prices a whole recipient/items request, so there is no
 * per-item number to sum. #122's `SupplierShippingQuote` makes summing one
 * unrepresentable, which is why the basis is stated rather than flattened.
 */
async function resolveShipping(
  transport: PrintfulTransport,
  context: { providerAccountId: string; environment: 'test' | 'live'; credential: string; timeoutMs: number },
  input: SupplierAdapterQuoteInput,
  variantId: string,
  currency: CurrencyCode,
): Promise<ShippingAnswer> {
  const destination = {
    country_code: input.destination.country,
    ...(input.destination.region ? { state_code: input.destination.region } : {}),
    ...(input.destination.postalCode ? { zip: input.destination.postalCode } : {}),
    ...(input.destination.city ? { city: input.destination.city } : {}),
  };
  const rates = await call(
    transport,
    {
      method: 'POST',
      path: '/v2/shipping-rates',
      credential: context.credential,
      storeId: context.providerAccountId,
      timeoutMs: context.timeoutMs,
      body: {
        recipient: destination,
        order_items: [{ variant_id: Number(variantId), quantity: input.quantity }],
        currency,
      },
    },
    'shipping rates',
  );

  const entries = Array.isArray(rates) ? rates : list(rates, 'data');
  const options: SupplierShippingOption[] = [];
  for (const entry of entries) {
    const cost = money(field(entry, 'rate'), currency);
    const serviceCode = text(entry, 'id') ?? text(entry, 'shipping');
    if (cost === null || serviceCode === null) continue;
    options.push({
      serviceCode,
      carrier: null,
      serviceName: text(entry, 'name'),
      cost,
      basis: 'basket',
      deliveryDaysMin: integer(entry, 'minDeliveryDays') ?? integer(entry, 'min_delivery_days'),
      deliveryDaysMax: integer(entry, 'maxDeliveryDays') ?? integer(entry, 'max_delivery_days'),
      // Printful publishes an ESTIMATE, never a commitment.
      guaranteed: false,
    });
  }

  const requested = input.requestedShippingServiceCode;
  const chosen =
    (requested === null ? undefined : options.find((option) => option.serviceCode === requested)) ??
    options[0];
  if (chosen === undefined) {
    // No priceable service. An unknown shipping cost has no amount, so it can
    // never be summed into a delivered total — `assumed_zero_shipping` is
    // exactly what this branch exists to prevent.
    return {
      quote: { basis: 'unknown', restrictions: ['carrier_unavailable'] },
      options: [],
      deliveryDaysMin: null,
      deliveryDaysMax: null,
      restrictions: ['carrier_unavailable'],
    };
  }

  return {
    quote: { basis: 'basket', cost: chosen.cost, serviceCode: chosen.serviceCode, guaranteed: false },
    options,
    deliveryDaysMin: chosen.deliveryDaysMin,
    deliveryDaysMax: chosen.deliveryDaysMax,
    restrictions: [],
  };
}
