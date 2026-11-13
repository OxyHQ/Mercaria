# Donated materials

`/materials` in the storefront lets people and Oxy organizations offer materials,
request quantities, accept reservations, cancel and confirm receipt. The current
Oxy account is shown before any action; account switching uses Oxy Services.
The profile and desktop navigation link to this screen.

Materials are free. This domain never creates a cart, commercial order, payment,
fee or checkout. Collection remains personal pickup. The offer's public area is
approximate; collection instructions are private and only appear on an authorized
participant's accepted or delivered reservation. Cancellation hides them from
subsequent API responses. Public offer reads never contain collection instructions.
People may of course retain information they already received.

## State and quantities

A request begins `requested` and reserves nothing. Only the donor account accepts
it, moving it to `accepted`. Either participant can cancel a pending or accepted
request. Only the recipient confirms actual receipt, moving an accepted reservation
to `delivered`; a received donation cannot be cancelled.

An offer reports total `quantity`, `committedQuantity` (accepted reservations),
`receivedQuantity` (recipient-confirmed deliveries), and `availableQuantity`
(total less both). Counters are computed from Mercaria reservation records.
Every request/transition/closure locks the offer row first, including transitions
on different reservations. Acceptance checks available units while holding that
lock. Cancellation releases committed units; receipt moves committed to received
without returning stock. Closing an offer prevents new requests and acceptance,
while accepted pickup and receipt continue.

Creation keys are unique per owning/requesting account. Reusing one with a changed
payload fails with `conflict`. Reservation actions carry `idempotencyKey` and
`actingAccountId`; the replay ledger binds a key to the action and returns current
state, so a replay never resurrects a cancelled reservation or repeats receipt.
The SDK never automatically retries writes. Keep the key when retrying a lost
response. The offer form keeps its key after failure and makes a fresh one only
for changed content or after a successful creation.

## Identity and integration

Account IDs reference Oxy. No membership, account names or roles are copied into
Mercaria. Undelegated personal ownership is checked against the verified actor;
all other access checks ask Oxy using the caller's bearer on every request, with
no role cache. Owner/admin/editor roles may manage materials. Revocation denies
future reads/writes; Oxy failure returns 503. A delegated organization session
never becomes an owner merely because its subject equals the organization.

Contracts and OpenAPI are under `packages/contracts`. `/public/v1/materials/*`
uses bare success bodies (201 for creation) and standard typed error bodies.
Mutations and reservation reads require an Oxy bearer. CORS permits bearer-only
cross-app calls without cookies, scoped to the materials prefix; catalog methods
retain their existing read-only policy. Responses disable storage. Lists use
keyset cursors bound to account, status and offer filters, at most 50 per page.

`@mercaria.co/sdk` exposes `client.materials`:

- `listOffers`, `iterateOffers`, `getOffer`, `createOffer`, `closeOffer`.
- `request(offerId, { requesterAccountId, quantity, idempotencyKey })`.
- `listReservations`, `iterateReservations`, `getReservation(id, accountId)`.
- `accept`, `cancel`, `confirmDelivery` with `{ actingAccountId, idempotencyKey }`.

For pending pickups, use
`client.materials.iterateReservations({ accountId, status: 'accepted' })`.
Each reservation exposes `id`, `offerId`, `donorAccountId`, `requesterAccountId`,
`quantity`, `status`, authorized `pickupInstructions`, and timestamps.
External products store only the opaque reservation ID and resolve current facts
through this SDK. Transport is a separate integration: there is no transport
booking, price or copied Moovo record in this change. Transport authorization
cannot be inferred from a donated-material acceptance.

The UI has English and Spanish copy; other shipped locales currently use English
for these new strings. Browser regression fixtures exercise the actual Oxy
provider, SDK and form controls; they substitute Oxy HTTP authority, not database
semantics. PostgreSQL tests independently cover contention, revocation, replay,
privacy, delivery and cursor scope through services and the complete HTTP chain.

## Optional Moovo transport

An accepted reservation can request transport or keep personal pickup. The form
prefills only facts already available (material/quantity and freeform pickup
notes); both structured addresses, coordinates, contacts and parcel facts must
be supplied. The frontend uses `moovoForOxy` from the owning `@oxy.so/moovo-sdk`
directly. It shows Moovo's exact quote and selected payer, requires that payer's
explicit confirmation, then lets a donation participant request fulfillment.
A donor, recipient or authorized sponsoring organization can pay; an organization
editor cannot approve expenditure. A different payer receives a review link at
`/materials-transport/<transport-id>` and can switch Oxy accounts there.

`materials.linkTransport(id, { actingAccountId, transportId })` persists only
`material_reservations.moovo_transport_id`. The backend verifies the current
Moovo reference through a request-local official Oxy-linked SDK read. It checks
that the transport belongs to this reservation before attaching it, and only
replaces a reference whose previous proposal was explicitly cancelled. No
transport price, address, approval or status is stored in Mercaria. The UI reads
current state from Moovo independently and hides old content on failures.

A lost create response is recovered by reservation ID; a lost booking response
is recovered by the same transport ID. Repeated writes preserve their operation
identity. The user can retry attaching an already created reference without
requesting another shipment. Cancelling a donation keeps its transport reference
and does **not** cancel an existing transport. Unbooked proposals have a separate
cancel action; requested deliveries are managed in Moovo.

Moovo's current internal courier quotes use 100 minor units per FAIR, distinct
from Mercaria's 100,000,000. The owning SDK's `formatTransportPrice` renders them;
they must not be passed to Mercaria's money formatter. Current fulfillment is a
real Moovo courier job with payment explicitly pending; payment collection is
unavailable and no charge is claimed. Donation items remain free.

Configuration: `EXPO_PUBLIC_MOOVO_API_URL` for the frontend and `MOOVO_API_URL`
for backend reference verification, both defaulting to `https://api.moovo.now`.
The owning transport SDK is installed from the registry as
`@oxy.so/moovo-sdk@0.1.0`, with no consumer patch. Migration `0167` adds
the transport reference column before deployment.

Verification includes actual PostgreSQL/HTTP/SDK reference attachment, mismatch
rejection and reference retention after donation cancellation, plus browser flows
for exact price, explicit payer confirmation, a different payer, personal pickup,
proposal cancellation and lost create/booking responses. English and Spanish
transport copy is provided; the other shipped locales currently use English
fallback strings, as the material donation foundation does.
