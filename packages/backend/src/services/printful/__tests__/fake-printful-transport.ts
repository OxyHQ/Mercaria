/**
 * A fake Printful WIRE, not a fake adapter (#125).
 *
 * The distinction is the whole reason this file exists. #124's conformance suite
 * asks questions only a transport can answer — "did a second supplier order get
 * placed", "does the provider hold an order under this reference" — and a mocked
 * adapter would be measuring the mock. Faking the wire instead means the REAL
 * `createPrintfulOrderAdapter` is under test, with its real error taxonomy, its
 * real `afterWrite` reading, its real state mapping and its real convergence
 * lookup, driven through the real orchestration against a real database.
 *
 * It speaks Printful's documented request and response shapes
 * (`docs/suppliers/printful.md` §7): `POST /v2/orders`,
 * `POST /v2/orders/{id}/confirm`, `GET /v2/orders/{id}`, `GET /v2/orders`,
 * `DELETE /v2/orders/{id}`, plus the catalogue reads the preflight makes. What
 * it does NOT do is model Printful's real behaviour beyond what the published
 * documentation states — the shapes it returns are the shapes the documentation
 * describes, and where the documentation is silent (§11's open gates) the
 * conformance run proves the adapter's handling rather than the provider's.
 */

import type {
  PrintfulRequest,
  PrintfulResponse,
  PrintfulTransport,
} from '../transport-contract.js';
import { PrintfulTransportError } from '../transport-contract.js';

/** Every failure this wire can produce, in #124's own scenario vocabulary. */
export type PrintfulScenario =
  | 'healthy'
  | 'timeout_before_write'
  | 'timeout_after_write'
  | 'rejected'
  | 'received_only'
  | 'partial_shipment'
  | 'cancel_accepted'
  | 'cancel_rejected'
  | 'credential_expired'
  | 'rate_limited'
  | 'malformed_payload';

/** One order this wire believes Printful holds. */
interface HeldOrder {
  id: string;
  externalId: string;
  status: string;
}

/** A Printful wire whose behaviour is injected per client reference. */
export interface FakePrintfulTransport extends PrintfulTransport {
  /** Make one Mercaria client reference produce one scenario. */
  inject(clientReference: string, scenario: PrintfulScenario): void;
  /** Whether this wire currently holds an order under that reference. */
  hasOrder(clientReference: string): boolean;
  /** Flip whether a repeat create is answered from the held order. */
  setIdempotencySupport(honours: boolean): void;
  /** Forget every scenario and every held order. */
  reset(): void;
  /** The token this wire accepts. Anything else answers 401. */
  readonly credential: string;
}

/** The catalogue this wire publishes — one variant, EU-available, priced. */
const CATALOG_VARIANT_ID = '4012';

export function createFakePrintfulTransport(): FakePrintfulTransport {
  const scenarios = new Map<string, PrintfulScenario>();
  const orders = new Map<string, HeldOrder>();
  let honoursIdempotency = true;
  let nextOrderId = 1;
  const credential = 'pf-test-token';

  const json = (status: number, body: unknown): PrintfulResponse => ({
    status,
    headers: {},
    body,
    parsed: true,
  });

  const orderBody = (order: HeldOrder): unknown => ({
    id: order.id,
    external_id: order.externalId,
    status: order.status,
    costs: { total: '44.00' },
    shipments:
      order.status === 'fulfilled' || order.status === 'partial'
        ? [
            {
              id: `shp-${order.id}`,
              tracking_number: `TRACK-${order.id}`,
              carrier: 'carrier',
              service: 'standard',
              ship_date: new Date().toISOString(),
            },
          ]
        : [],
    ...(order.status === 'failed' ? { error: 'out of stock' } : {}),
  });

  /** Which client reference a request is about, whatever shape it arrives in. */
  const referenceOf = (request: PrintfulRequest): string | null => {
    const body = request.body;
    if (typeof body === 'object' && body !== null) {
      const external = (body as Record<string, unknown>)['external_id'];
      if (typeof external === 'string') return external;
    }
    const match = /\/v2\/orders\/([^/]+)/.exec(request.path);
    if (match) {
      const id = decodeURIComponent(match[1] ?? '');
      for (const order of orders.values()) if (order.id === id) return order.externalId;
    }
    return null;
  };

  return {
    baseUrl: 'https://api.printful.com',
    credential,

    inject(clientReference, scenario) {
      scenarios.set(clientReference, scenario);
    },
    hasOrder(clientReference) {
      return orders.has(clientReference);
    },
    setIdempotencySupport(honours) {
      honoursIdempotency = honours;
    },
    reset() {
      scenarios.clear();
      orders.clear();
      honoursIdempotency = true;
      nextOrderId = 1;
    },

    async call(request: PrintfulRequest): Promise<PrintfulResponse> {
      await Promise.resolve();
      const reference = referenceOf(request);
      const scenario = reference === null ? 'healthy' : (scenarios.get(reference) ?? 'healthy');

      // A wrong token is refused before anything else, exactly as Printful
      // would: an unauthenticated request never reaches an order.
      if (request.credential !== null && request.credential !== credential) {
        return json(401, { detail: 'Invalid authorization token' });
      }
      if (scenario === 'credential_expired' && request.path.startsWith('/v2/orders')) {
        return json(401, { detail: 'Invalid authorization token' });
      }
      if (scenario === 'rate_limited' && request.path.startsWith('/v2/orders')) {
        return { status: 429, headers: { 'retry-after': '30' }, body: { detail: 'Too many requests' }, parsed: true };
      }

      // --- Catalogue reads, for the #122 preflight half. ---
      if (request.path === `/v2/catalog-variants/${CATALOG_VARIANT_ID}`) {
        return json(200, { id: Number(CATALOG_VARIANT_ID), name: 'Unisex t-shirt / White / M' });
      }
      if (request.path === `/v2/catalog-variants/${CATALOG_VARIANT_ID}/prices`) {
        return json(200, { currency: 'EUR', product: { price: '12.95' } });
      }
      if (request.path === `/v2/catalog-variants/${CATALOG_VARIANT_ID}/availability`) {
        return json(200, {
          data: [
            {
              selling_region_name: 'europe',
              availability: 'in stock',
              techniques: [{ country_code: 'ES' }],
            },
          ],
        });
      }
      if (request.path.startsWith('/v2/catalog-variants/')) {
        return json(404, { detail: 'Variant not found' });
      }
      if (request.path === '/v2/shipping-rates') {
        return json(200, {
          data: [{ id: 'STANDARD', name: 'Flat Rate', rate: '4.19', minDeliveryDays: 3, maxDeliveryDays: 5 }],
        });
      }

      // --- Orders. ---
      if (request.method === 'POST' && request.path === '/v2/orders') {
        if (reference === null) return json(400, { detail: 'external_id is required' });
        if (scenario === 'timeout_before_write') {
          throw new PrintfulTransportError('connection refused', {
            afterWrite: false,
            retryable: true,
          });
        }
        const existing = orders.get(reference);
        if (existing && honoursIdempotency) return json(200, orderBody(existing));
        if (existing && !honoursIdempotency) {
          // A provider WITHOUT idempotency would create a SECOND order. The
          // orchestration must never reach here; reaching it is the failure the
          // conformance suite exists to catch.
          const duplicate: HeldOrder = {
            id: `pf-${String(nextOrderId++)}`,
            externalId: `${reference}#duplicate`,
            status: 'draft',
          };
          orders.set(duplicate.externalId, duplicate);
          return json(200, orderBody(duplicate));
        }

        const created: HeldOrder = {
          id: `pf-${String(nextOrderId++)}`,
          externalId: reference,
          status: 'draft',
        };
        if (scenario === 'timeout_after_write') {
          // The order IS created and the caller never learns it. This is the
          // case the whole convergence path exists for.
          orders.set(reference, created);
          throw new PrintfulTransportError('socket hang up after request', {
            afterWrite: true,
            retryable: true,
          });
        }
        if (scenario === 'malformed_payload') {
          orders.set(reference, created);
          return { status: 200, headers: {}, body: null, parsed: false };
        }
        orders.set(reference, created);
        return json(200, orderBody(created));
      }

      const confirmMatch = /^\/v2\/orders\/([^/]+)\/confirm$/.exec(request.path);
      if (request.method === 'POST' && confirmMatch) {
        const id = decodeURIComponent(confirmMatch[1] ?? '');
        const order = [...orders.values()].find((entry) => entry.id === id);
        if (!order) return json(404, { detail: 'Order not found' });
        if (scenario === 'rejected') {
          order.status = 'failed';
        } else if (scenario === 'received_only') {
          // Printful HAS the order and has not decided. The purchase order stays
          // `submitted`, which is also the state a submission still owed is in —
          // the collision #124's attempt log exists to tell apart.
          order.status = 'draft';
        } else if (scenario === 'partial_shipment') {
          order.status = 'partial';
        } else {
          order.status = 'pending';
        }
        return json(200, orderBody(order));
      }

      const orderMatch = /^\/v2\/orders\/([^/]+)$/.exec(request.path);
      if (orderMatch) {
        const id = decodeURIComponent(orderMatch[1] ?? '');
        const order = [...orders.values()].find((entry) => entry.id === id);
        if (!order) return json(404, { detail: 'Order not found' });
        if (request.method === 'DELETE') {
          if (scenario === 'cancel_rejected') {
            return json(400, { detail: 'Order has already been fulfilled' });
          }
          order.status = 'canceled';
          return json(200, orderBody(order));
        }
        return json(200, orderBody(order));
      }

      if (request.method === 'GET' && request.path === '/v2/orders') {
        return json(200, { data: [...orders.values()].map((order) => orderBody(order)) });
      }

      return json(404, { detail: `unhandled ${request.method} ${request.path}` });
    },
  };
}

/** The catalogue variant this wire publishes — the preflight fixtures' SKU. */
export const FAKE_PRINTFUL_VARIANT_ID = CATALOG_VARIANT_ID;
