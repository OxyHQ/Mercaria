/**
 * What Moovo is given, composed by an ALLOW-LIST and checked at runtime (#126
 * privacy 2, 3, 4 and 9).
 *
 * #126 privacy 2 is *"Moovo receives only logistics data required for
 * quote/transport"*. The type already says that — `MoovoTransportRequest` has
 * no buyer id, no email, no total, no supplier identity and no credential
 * member — but a type is a compile-time promise and this composes a payload
 * that leaves the process. So there are two gates, the
 * `SELLER_PROFILE_FORBIDDEN_FIELDS` (#92) arrangement:
 *
 *  1. the TYPE, which stops a field being added without a deliberate edit; and
 *  2. {@link assertMoovoRequestDisclosure}, which walks the composed value and
 *     THROWS on any key outside the allow-list — because the failure this
 *     catches is not a new field, it is an object passed through whole and a
 *     `buyerEmail` riding along on it.
 *
 * It throws rather than filtering, matching #107's metadata gates: a key that
 * should not exist is a defect in the composition, and dropping it silently
 * ships the composition that produced it.
 *
 * ## What is deliberately NOT passed, beyond the obvious
 *
 * **The guest portal credential** (#126 privacy 3). A `mgp_`/`mgx_` token
 * authorizes reading a purchase; a logistics provider has no use for one and
 * every reason not to hold one. There is no member for it and no code path that
 * reads `guest_portal_grants` from this domain — asserted by
 * `retail-logistics-isolation.test.ts`.
 *
 * **Mercaria's own service credential** (#126 privacy 4). The Oxy application
 * credential Mercaria authenticates to Moovo WITH never appears in a body:
 * #156's client puts it in the transport, which is why this module composes no
 * headers and holds no client.
 *
 * **The order total, the supplier cost and the supplier's identity.** A parcel
 * needs a destination and a content declaration. What it is worth is a customs
 * and insurance question nobody has asked yet, and a value handed over "in case
 * it is useful" is the commercial data privacy 2 keeps out. The supplier's
 * identity is ADR 0004 D2.8's *disclosed where law requires it and otherwise
 * not marketed* — the origin address is what a movement actually needs.
 *
 * ## The source reference is Mercaria's, and it is what makes a replay converge
 *
 * `sourceReference` comes off the fulfilment intent's own GENERATED column, so
 * two racing bookings compose byte-identical requests and Moovo deduplicates
 * them (#126 Mode A requirement 3, Mode B requirement 3). Nothing here mints
 * one; a value derived at composition time would differ between two attempts
 * and defeat the property it exists for.
 */

import type {
  MoovoExistingCarriage,
  MoovoTransportEndpoint,
  MoovoTransportLine,
  MoovoTransportRequest,
  RetailFulfilmentMode,
} from '@mercaria/shared-types';

/**
 * Every key that may appear in a Moovo request, at every level.
 *
 * ONE flat set rather than a nested schema, because the walk below is
 * depth-first over whatever it is handed and a nested description would have to
 * be kept in step with a shape the type already describes. What this set adds
 * is the runtime half: it catches a key the TYPE never mentioned, which is
 * exactly the case a type cannot catch.
 */
export const MOOVO_REQUEST_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'sourceReference',
  'mode',
  'origin',
  'destination',
  'lines',
  'existingCarriage',
  // endpoint
  'contactName',
  'contactPhone',
  'line1',
  'line2',
  'city',
  'region',
  'postalCode',
  'country',
  // line
  'orderItemId',
  'quantity',
  'description',
  // existing carriage
  'carrierName',
  'trackingReference',
  'dispatchedAt',
]);

/**
 * Keys that must never appear, named so a refusal says WHICH prohibition was
 * broken rather than "unrecognized key".
 *
 * Disjoint from {@link MOOVO_REQUEST_ALLOWED_KEYS} by a test — the
 * `RETAIL_FORBIDDEN_COMPONENT_KIND` device. The allow-list alone would refuse
 * every one of these, so this list buys nothing at runtime; what it buys is the
 * error MESSAGE, and a message naming `guestPortalToken` sends whoever hit it
 * to the right conversation, where "unexpected key" sends them to this file to
 * add it.
 */
export const MOOVO_REQUEST_FORBIDDEN_KEYS: readonly string[] = [
  'buyerOxyUserId',
  'buyerEmail',
  'buyerPhoneAccount',
  'guestSessionId',
  'guestCheckoutId',
  'guestPortalToken',
  'oxyServiceCredential',
  'paymentIntentId',
  'orderTotal',
  'supplierCost',
  'supplierId',
  'supplierName',
  'purchaseOrderId',
];

/** What the composer is handed. Every field is already a snapshot on an order. */
export interface MoovoTransportRequestInput {
  /** The intent's own `moovo_source_reference`, read from the row. */
  sourceReference: string;
  mode: RetailFulfilmentMode;
  /** Where the goods start — the supplier's dispatch location. */
  origin: MoovoTransportEndpoint;
  /** Where they go — the order's immutable shipping-address snapshot. */
  destination: MoovoTransportEndpoint;
  lines: readonly MoovoTransportLine[];
  /** Mode B only: what the supplier already booked. */
  existingCarriage?: MoovoExistingCarriage;
}

/**
 * Compose one Moovo request, then assert its disclosure before returning it.
 *
 * The assertion runs HERE rather than at the port, so a caller cannot reach the
 * port with a hand-built request. That is the difference between a gate and a
 * convention: the port's parameter type is satisfied by any object of the right
 * shape, and this is the only function that produces one.
 */
export function composeMoovoTransportRequest(
  input: MoovoTransportRequestInput,
): MoovoTransportRequest {
  if (input.sourceReference.trim() === '') {
    throw new Error(
      'A Moovo transport request needs the fulfilment intent’s own source reference; ' +
        'composing one here would make two booking attempts differ and create two transports.',
    );
  }
  if (input.lines.length === 0) {
    throw new Error('A Moovo transport request must declare at least one line.');
  }
  if (input.mode === 'supplier_controlled' && !input.existingCarriage) {
    throw new Error(
      'A supplier-controlled transport is registered for TRACKING ONLY and must carry the ' +
        'carriage the supplier already booked; without it Moovo would be asked to arrange one.',
    );
  }
  if (input.mode === 'moovo_controlled' && input.existingCarriage) {
    throw new Error(
      'A Moovo-controlled transport must not carry existing carriage: two bookings for one ' +
        'movement is the duplicate shipment this path exists to prevent.',
    );
  }

  const request: MoovoTransportRequest = {
    sourceReference: input.sourceReference,
    mode: input.mode,
    origin: input.origin,
    destination: input.destination,
    lines: input.lines.map((line) => ({
      orderItemId: line.orderItemId,
      quantity: line.quantity,
      description: line.description,
    })),
    ...(input.existingCarriage ? { existingCarriage: input.existingCarriage } : {}),
  };
  assertMoovoRequestDisclosure(request);
  return request;
}

/**
 * Walk a composed request and throw on any key outside the allow-list.
 *
 * Depth-first over plain objects and arrays. It does not attempt to validate
 * VALUES — that is the type's job and the CHECKs' — because a disclosure gate
 * that also validated shape would fail for two unrelated reasons under one
 * message, and the one people would start suppressing is the one that matters.
 */
export function assertMoovoRequestDisclosure(value: unknown, path = 'request'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertMoovoRequestDisclosure(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;

  for (const [key, entry] of Object.entries(value)) {
    if (MOOVO_REQUEST_FORBIDDEN_KEYS.includes(key)) {
      throw new Error(
        `${path}.${key} may never be sent to Moovo: it is commercial or identity data, and ` +
          'a logistics provider receives only what a movement requires (#126 privacy 2).',
      );
    }
    if (!MOOVO_REQUEST_ALLOWED_KEYS.has(key)) {
      throw new Error(
        `${path}.${key} is not on the Moovo request allow-list. Decide whether a logistics ` +
          'provider may hold it before adding it here (#126 privacy 2).',
      );
    }
    assertMoovoRequestDisclosure(entry, `${path}.${key}`);
  }
}
