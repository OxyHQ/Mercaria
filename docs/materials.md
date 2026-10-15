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
