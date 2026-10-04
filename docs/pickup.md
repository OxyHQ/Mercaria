# Location publication, nearby discovery and collection (#93)

A shopper standing in a city wants to know whether the exact thing they are
looking at is on a shelf near them, and whether they can pay for it now and walk
in and collect it. Answering that needs four facts Mercaria did not publish
before this issue: **where** a store's locations are, **which** of them the
merchant is willing to have discovered, **what** is collectable there right now,
and **who** may collect it.

This document is the reference for all four. Schema decisions are in
`packages/backend/src/db/schema/CONVENTIONS.md` §"Location publication and
collection (#93)"; the load-bearing rules are summarised in the repo-root
`AGENTS.md`.

**Where a location IS is GoWay's (ADR 0013).** Its name, address, position,
timezone, hours and exceptions, contact and accessibility live on a GoWay
place; Mercaria stores `locations.go_way_place_id` and reads the rest through
`services/goway/`. Everything below that says "where" means "what the GoWay
place says, read at that moment".

---

## 1. What is stored, and what is deliberately not

Six tables, plus one column on `locations`. The operational `locations` row and
its `inventory_levels` are otherwise untouched: #93's own issue says it "reuses
the existing `Location`, `InventoryLevel` and POS domains", and this domain is
the PUBLIC face of them plus everything a handover needs.

| Where | Holds |
|---|---|
| `locations.go_way_place_id` | The GoWay place the location trades from. Opaque, no foreign key, unique per store |
| `location_publications` | Mercaria's commerce terms for one location: publication state, pickup switches and instructions, identity and payment requirement, pause, operator restriction, inventory source, freshness policy, disclosure, storefront |
| `location_publication_events` | Append-only audit of publication and place-link changes |
| `order_pickups` | One order's frozen collection snapshot (read from the GoWay place) plus its operational state |
| `pickup_collection_credentials` | A rotation counter and four instants. **No code, no hash, no ciphertext** |
| `pickup_collection_events` | Append-only audit of everything at a collection desk |
| `listing_local_discovery` | A P2P seller's coarse CELL. **No coordinate column** |

`0161` dropped the place facts a publication used to copy (name, address,
timezone, phone, URL, four accessibility flags, the pin and its generated
PostGIS point) and the two tables that copied the schedule
(`location_opening_hours`, `location_closures`).

### Why a separate publication row rather than columns on `locations`

The two objects have different audiences and different failure modes.
`locations` holds the address a pallet is delivered to and the name a warehouse
manager gave a building; a publication holds whether a stranger may be sent
there and on what terms. Keeping them apart means the first naive
`select().from(locations)` on a public route still discloses nothing — the
operational address is never projected, and the public address is the GoWay
place's.

It also makes the default right by construction: a store with no publication row
is not discoverable, and that is the state every existing store is in.

---

## 2. The verdict is DERIVED and never stored

There is no `discoverable` column and no `pickup_eligible` column. Whether a
location may be shown, and whether a particular actor may check out for
collection there, is a conjunction over the LIVE `locations.is_active`, the LIVE
store, the LIVE listing status, the LIVE stock level and its age, the
publication's own state, and — for a guest — three deployment levers.

Six tables in four domains this one does not own, plus the GoWay place. This is #57's
`deriveNativeCheckoutEligibility` divergence from the one-stored-verdict rule,
taken for the same reason and with the same payoff: **a moderation restriction
stops a collection in the statement that applies it, with no sweep in between.**

`services/pickup/eligibility.ts` imports no repository, no configuration and no
database handle — the #121 posture — so every combination of inputs is
exercisable without building eleven tables of fixtures.

### The buyer never sees a reason

A public nearby response OMITS a location it will not serve; it does not
explain. Given three published shop fronts and a per-reason answer, a client
varying one input at a time reads out a merchant's stock position, their pause
levers and their moderation state — #107's `guest_rollout_blocked` reasoning,
with more to lose. The `PickupBlockReason` codes exist for the merchant's own
dashboard, the operator trace and the structured log.

---

## 3. Position: the GoWay place, and the trust rule

A location has a position exactly when it names a GoWay place the merchant
chose or created in the dashboard (ADR 0013, D2). There is no Mercaria pin and
no second source.

### The trust rule

A location is LINKED — and so may be published and discovered — only when:

1. `locations.go_way_place_id` is set;
2. a public GoWay read shows the place exists, is `active` and is not merged;
3. the place's strongest `commerce.mercaria.store` assertion is this location's
   id, at `business_asserted` or `oxy_verified`;

and, for a collection, the place carries a country and a timezone. Only whoever
acts for an approved claim on the place can assert at `business_asserted`, and
the dashboard files that claim for the store's owning Oxy account (ADR 0012),
so the back-reference is the proof that the place and the store are run by the
same people. `services/goway/place-facts.ts`'s `placeLinkGaps` is the rule;
`PLACE_LINK_GAPS` names each failing condition and `placeLinkBlockers` maps
them to one block reason per remedy (`place_not_linked`, `place_unavailable`,
`place_link_unverified`, `place_incomplete`).

The verdict is derived on every read from the cached place (fresh for at most a
minute — never longer than the shortest stock interval a location may declare),
so a broken link stops discovery at the next read. It is never stored.

### Merges

GoWay merges duplicate places and keeps a one-hop `mergedInto` pointer. The
public reads do NOT follow it — a merged place is unlinked — and the merchant's
verify act does: `POST …/locations/:id/place-link/verify` rewrites the stored
id to the survivor and audits `place_merge_followed`. The survivor must still
name the location back.

### The one door

`services/goway/` is the only backend code that imports `@goway.to/sdk`
(`pickup-isolation.test.ts`, wall 4). Reads are public — Mercaria holds no GoWay
credential — and every failure is one of three: not found, gone, unavailable.

---

## 4. Freshness is the LOCATION's own policy

`location_publications.stock_confirmation_interval_seconds` is NOT NULL **with
no default**. A default would be the deployment-wide freshness TTL #68 forbids by
name, arriving through the back door — every merchant who never touched the field
would silently share one number.

Requiring it makes the claim a merchant's own, at the grain that actually
varies: a till writes through in seconds and a nightly connector run does not.
`location_inventory_sources` (`pos | connector | manual`) records which of the
two a location is, so the buyer-facing "confirmed 4 minutes ago" is meaningful
beside it.

The staleness test is pinned by a fixture pair with ONE age and TWO intervals and
opposite verdicts — a shared TTL would agree with whichever it happened to be set
to, and a single-interval fixture set could not tell them apart.

---

## 5. Availability is a bounded state, never a number by default

`locationAvailabilityState` (`services/pickup/eligibility.ts`) is the one
spelling of the rule below, shared by nearby and the public location reads.

`LOCATION_AVAILABILITY_STATES` is `in_stock | low_stock | out_of_stock`, and
`exactQuantity` is present ONLY where `discloses_exact_stock` is on. A consumer
that wants to render "3 left" has to read a property that is usually absent,
which is the shape that makes the default safe (#93 inventory rule).

The low-stock threshold is the location's own, so a shop that carries two of
everything is not permanently "low" and a warehouse that carries four hundred is
not permanently "in stock" at three.

---

## 6. Privacy: the shopper's coordinate lives inside one request

It arrives on the request, it is forwarded to GoWay for the length of ONE
request — exactly as the shopper's browser would send it, and transient there
by GoWay's own rule — and it is gone. What leaves `nearby.service.ts` is the
COARSE CELL (`toLocalArea`, 0.1° ≈ 11 km) on the echoed origin and in the one
structured log line, plus per-location distances rounded OUTWARD.

Nothing writes it anywhere: the GoWay place cache is keyed on place ids and a
nearby page is never cached, a GoWay failure is logged by its CODE (a transport
error can carry the request URL), no analytics event carries it (#77's schema
has no column that could), and `pickup-isolation.test.ts` fails the build if
this domain learns to emit one. `goway-places.realdb.test.ts` asserts the
coordinate reached GoWay and no log line or cache entry.

### Why the metre figure is coarsened

Published shop fronts are public points. Three exact distances from an unknown
position to three known points solve for that position. `coarsenMetres` is what
stops a nearby response being that system of equations, and it rounds UP rather
than to nearest so the number is never an understatement of how far somebody has
to travel.

### The cell function is SHARED with P2P discovery

Deliberately. A buyer's position and a seller's deserve the same treatment, and
one function means a change to the cell size cannot apply to one and miss the
other.

---

## 7. The manual-location fallback: a town the shopper types

`GET /nearby/places?q=` resolves what the shopper TYPED through GoWay's
geocoder and keeps a town only when something is collectable around it: each
candidate's cell centre is asked exactly the question picking it will ask (the
default radius, the same GoWay read and the same SQL predicate,
`countCollectableAtLocations`), so a town offered there yields results when
picked rather than being a dead end wearing a search box. Without `q` the answer
is empty — there is nothing to enumerate without a point.

Selecting one hands back a CELL CENTRE as the next request's origin, so the
fallback path never sees a precise coordinate at all.

This answers #93 acceptance 5 ("denied location permission has a functional
manual-location fallback") end to end: `components/nearby/NearbyOriginControl.tsx`
is the entry box. The town search is offered BESIDE the device-location control
rather than after a refusal, so a shopper who never wants to share a position
does not have to decline a prompt to find out that typing a town works.

---

## 8. Checkout: the #93 seam #105 left open

`services/pickup/checkout-gate.ts`'s `resolvePickupForCheckout` replaced
`assertPickupLocationEligible`, which used to refuse every pickup. The refusal
SHAPE is unchanged — a `CheckoutRefusal` naming the seller keys, raised before any
stock is reserved — so nothing downstream learned that pickup became possible.

It is a CLEAN CUT: `assertPickupLocationEligible` is gone rather than left as an
alias, and `checkout.service` calls the new function directly. It lives in
`services/pickup/` rather than in `fulfilment-eligibility.ts` because it is
ASYNCHRONOUS and RESOLVES a snapshot as well as refusing, while everything in
that module is a pure in-memory decision.

### Every LINE is validated at the EXACT location

#93 pickup rule 14 and acceptance 3. A cart with two items from one shop where
only one is on that shop's shelf is refused, naming the seller — because the
alternative is a buyer told to collect a parcel that is half short.

### Stock moves at the chosen branch

`reserve(variantId, qty, locationId)` — the SAME guarded UPDATE every other
checkout uses, whose predicate has been race-safe at the location grain since the
Mongo port. The whole of the change #93 needed here was passing an id that was
already an optional parameter.

Three companions matter and none is optional:

- **`order_items.location_id` carries the branch.** `transition('paid')` commits
  against it and a refund restocks against it — both already read
  `item.locationId` — so setting it at checkout is what makes a collection's
  stock movements land at the right branch rather than at the store's default.
- **The rollback releases at the SAME location.** `Reservation` carries the id,
  because `release` with no location routes to the DEFAULT one: a rolled-back
  collection would otherwise return units to a different branch from the one it
  took them from, and the shelf the buyer was standing next to would stay short.
- **The snapshot commits in the orders' transaction.** A converging idempotency
  replay discards this attempt's group, so a pickup row committed outside it
  would be a collection for an order that never existed.

### The address on a collection order

`destination.ts` still produces **no** `NormalizedCheckoutAddress` for a pickup —
#105's invariant is unchanged and nothing fabricates a street from anything the
buyer typed. What the ORDER records is a snapshot read from the GoWay PLACE the
location trades from — its default name, address and timezone, and its id —
frozen by trigger. It is the one copy of a place fact Mercaria keeps, and the
convention allows it because it is history: the buyer agreed to collect from
what they were shown.

### GoWay down: pickup fails closed, delivery does not notice

`resolvePickupForCheckout` reads the place once. A last-good copy stands in
while GoWay cannot answer; with none, the collection is refused with a `503`
that says why, before any stock moves. A delivery checkout never reaches the
gate and never asks GoWay (`checkout.stripe.realdb.test.ts`).

The recipient name is the literal word `Collection` and **never a person's
name**: `NormalizedCheckoutContact` carries no name field, reading one off an Oxy
profile is what #105 contact rule 5 forbids, and a collection has no carrier to
address.

---

## 9. The collection credential

```
code = base32(HMAC-SHA256(PICKUP_COLLECTION_CODE_KEY, orderId + ':' + version))
```

Ten characters of a Crockford-style alphabet with `I`, `L`, `O` and `U` removed —
the first three are misread off a phone screen and the fourth turns up in words
nobody wants on a receipt. Three consequences, each a requirement #93 states
separately:

- **A buyer can be shown it again** (#93 client rule 13). A one-way hash cannot
  serve that; re-derivation gives the same code every time without a reversible
  secret in a row.
- **Rotation is instant and total** (#93 verification rule 5). `version + 1`
  invalidates every copy at once, with no revocation list and no window. There is
  deliberately no grace acceptance of `version - 1`.
- **A dump discloses nothing.** No ciphertext, no digest, no lookup-by-code path
  anywhere in the domain.

### It is not the portal token and it authorizes no read

#93 verification rule 2. A portal credential (`mgp_`, #108) reads an order; a
collection code opens a shutter for one parcel at one counter. It has no prefix
in the `mgs_`/`mgx_`/`mgp_` family, no resolver and no middleware.

### Validation is scoped by the CALLER, not by the code

#93 verification rule 3. Nothing searches by code: `verifyCollectionCode` takes
the order id the route already authorized through `requireStorePermission` and
re-derives. A store cannot even ask the question about somebody else's order,
because it has no order id to ask with.

---

## 10. The collection desk moves no money and no stock

`pickup-isolation.test.ts` fails the build if any module under
`services/pickup/` imports the inventory service, the refund service, the payment
domain or the order writer. It makes #93 acceptance 14 true of code nobody has
written yet, and it is correct rather than cautious: **the units were committed
when the order was PAID**, so a collection that touched inventory would be
committing them a second time.

The corollaries are stated rather than hidden:

- **Cancelling a collection does not cancel the order.** It withdraws the handover
  and revokes the code; the merchant's existing order-cancel path returns the
  money and the units. Two steps, because they are two decisions and one of them
  moves money.
- **The order's STATUS is not moved either** (#93 pickup rule 12). `shipped` was
  not reused — a parcel handed across a counter was never shipped, and saying it
  was would put a carrier's word on a fact no carrier touched. A merchant's order
  list reads `order_pickups.state` to know a handover is done.

### Idempotency is a CAS, not a prior read

Every transition carries its own predicate and reports whether a row moved. A
second tap on a POS, a retry after a lost response and two members of staff at
two tills all converge on ONE transition and ONE audit entry. Mutation-tested:
removing the predicate turns exactly the three acceptance-14 cases red.

---

## 11. Guest store pickup readiness

#93 lists ten conditions. Seven are covered by the discoverability derivation
(publication, activation, pickup switches, freshness, moderation, the store, the
listing). The three that are genuinely guest-specific:

| Condition | How it is answered |
|---|---|
| The store passes #85 guest checkout readiness | #107's EXISTING `GUEST_SELLER_ACTIVATION_REQUIRED`. `guestSellerActivated` cannot be `true` today, so turning it on refuses EVERY guest collection by name — the fail-closed direction |
| The guest portal and transactional notifications are operational | `GUEST_PICKUP_REQUIRE_NOTIFICATION_TRANSPORT`, default OFF |
| Collection verification is implemented | No clause needed: `STORE_PICKUP_ENABLED` demands `PICKUP_COLLECTION_CODE_KEY` |

The notification default is the honest one rather than the lax one. #108 ships
the portal with an EMPTY transport registry and nothing sends; a buyer
nonetheless reaches their order through the confirmation grant the return screen
PULLS. Demanding a transport unconditionally would make guest collection
unreachable on every deployment that exists, which is not what "readiness" means.
A deployment that has wired mail turns the lever on and gets the strict reading.

**Reusing #107's activation flag rather than adding a parallel one is
deliberate**: "is this merchant activated for guest checkout" already has exactly
one answer, and a second lever could only disagree with it.

---

## 12. P2P proximity

`listing_local_discovery` stores `cell_lat_index`, `cell_lon_index` and
`cell_precision_degrees`. **A precise position is not something this row
withholds — it is something the row cannot hold.** #93 P2P rule 5 is therefore
true of every serializer anybody writes, including ones nobody has written, and
true of a `psql` session too.

The write accepts a precise coordinate because the alternative is worse: a client
that rounds badly, or forgets to, would be the only thing between a seller's home
and a public response. The server rounds and has nowhere to put the original.

`NearbyP2pListingResult` carries an area LABEL and a distance BAND and no metre
figure at all — a cell-to-cell estimate is accurate to roughly 11 km, and a metre
figure beside it would claim a precision that does not exist.

### It is not a collection promise, and it cannot become one

#93 P2P rules 6 and 8, and acceptance 13. The type carries no location, no hours,
no instructions and no eligibility verdict. `derivePickupEligibility` refuses a
`user` seller **for every actor**, and `services/guest-p2p/gate.ts`'s
`assertGuestP2PCheckoutAllowed` refuses a guest at group construction (ADR 0003
D18) — #112's decision, not #105's `assertGuestSellerTypesAllowed`, which #112
deleted from `fulfilment-eligibility.ts`: the seller type is decided in exactly
one place now. So store guest pickup being on cannot make P2P guest pickup
reachable, and there is no flag that would — #112's `GuestP2PAuthorization` has
no member meaning yes.

---

## 13. Surfaces

### Public

| Route | Notes |
|---|---|
| `GET /nearby` | Mounted only when `NEARBY_DISCOVERY_ENABLED` is on. `resolveCommerceActor`, so signed-out browsing works. `Cache-Control: private, no-store`. `?locale=` for place names; the cursor is GoWay's, passed through |
| `GET /nearby/places` | The manual fallback: `?q=` a town |
| `GET /nearby/p2p` | 404 while `P2P_LOCAL_DISCOVERY_ENABLED` is off |
| `GET /search?nearLatitude=&nearLongitude=` | #70's filter 10, a CONTRACT CHANGE rather than a parameter that was accepted and ignored. A MEMBERSHIP filter, never an ordering |

### Public integration (`/public/v1`)

`GET /public/v1/locations?goWayPlaceId=`, `/locations/:id`,
`/locations/:id/products` and `/stores/:id/locations` — the shop fronts another
Oxy application (GoWay's place page, first) reads, gated by the same trust rule
(§3) and with each product's availability decided by the same
`inventoryBlockers` and `locationAvailabilityState` as nearby (§4, §5). Status
rules, the 503 for an unreachable GoWay and the projection are
`docs/public-api.md`'s. The storefront's store page lists its own shop fronts
from the same route, so the map and the store cannot disagree.

### Buyer

| Route | Notes |
|---|---|
| `GET /orders/:id/collection` | The snapshot and the code, through #106's `authorizeOrderAccess` |
| `GET /guest/orders/:groupId/orders/:id/collection` | The SAME handler, through #108's portal grant (#93 verification rule 9) |

### Merchant and POS

Under `/admin/stores/:storeId/`, on the permissions that already existed (#93
operations rule 4): `locations:write` for the shop front, `orders:fulfill` for the
desk, `orders:read` to look one up.

- `locations/publications`, `locations/:id/publication` (GET/PUT — the GoWay
  place id and the commerce terms only), `…/publication/{state,pickup-pause,events}`
- `locations/:id/place-link/verify` — the trust rule, now, explained; follows a
  merge
- There is no hours, closures or address route: those are the GoWay place's,
  edited in GoWay with the merchant's own session
- `locations/:id/pickups` — one BRANCH's queue
- `orders/:id/pickup` and `…/pickup/{ready,collect,cancel,rotate-code}`

There is deliberately **no route that returns the current code to a merchant**. A
code is the buyer's; a desk verifies one by having it presented. Rotation returns
the NEW code, because the shop is the party that has to tell the customer it
changed.

### Seller (P2P)

`GET`/`PUT /seller/listings/:id/local-discovery`.

### Operator

`/internal/pickup/*`, on the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list
#54/#55/#56/#57/#58/#60/#62/#68/#83/#94 use — **not a seventh list**. Withdrawing
a published shop front is a catalogue-moderation power over the same graph.

READ plus ONE write. There is no "set this location's position", no "publish this
location", no "mark this collection collected" and no route that returns a code —
each would be Mercaria acting as a merchant, or as a buyer, in a domain where
both already have their own authenticated surface.

---

## 14. Environment

```
GOWAY_API_URL=                            # GoWay's API origin; needed by the two levers below
GOWAY_TIMEOUT_MS=2500
GOWAY_PLACE_CACHE_TTL_SECONDS=60          # at most 60, the shortest stock interval
GOWAY_PLACE_STALE_TTL_SECONDS=86400       # last-good place during an outage
NEARBY_DISCOVERY_ENABLED=false            # mounts /nearby
STORE_PICKUP_ENABLED=false                # may a checkout resolve a pickup
GUEST_STORE_PICKUP_ENABLED=false          # may a GUEST collect
P2P_LOCAL_DISCOVERY_ENABLED=false         # the coarse P2P surface
GUEST_PICKUP_REQUIRE_NOTIFICATION_TRANSPORT=false
PICKUP_COLLECTION_CODE_KEY=               # 64 hex; demanded by STORE_PICKUP_ENABLED
```

`STORE_PICKUP_ENABLED=true` **requires** `PICKUP_COLLECTION_CODE_KEY` and
`GOWAY_API_URL`, and `NEARBY_DISCOVERY_ENABLED=true` requires `GOWAY_API_URL`
(the half-configuration rule), and `GUEST_STORE_PICKUP_ENABLED` additionally requires
store pickup — the dependency is one-way, so turning guest pickup off leaves
authenticated collection working, which is the direction #93 operations rule 10
needs.

### The fourth lever #93 asks for is deliberately ABSENT

#93 operations rule 9 lists four flags, the last being P2P guest pickup. Its
absence is a **stronger** guarantee than a switch defaulting off: guest P2P
checkout is refused at group construction (ADR 0003 D18), #105 states outright
that "there is deliberately no flag for it", and `derivePickupEligibility`
refuses a `user` seller for every actor. A dormant switch reads as a decision
already taken.

### No lever gates a durable record

`order_pickups`, the credential, the trail and the buyer's own read all keep
working with every lever off — #93 operations rule 10 — and
`pickup-isolation.test.ts` fails the build if a collection, portal or refund path
starts reading `config.pickup`.

---

## 15. Operations

`GET /internal/pickup/consistency` runs three probes, each an exact count plus a
bounded sample. Detection and repair are separate acts (the
`payment_discrepancies` posture) — every remedy is a merchant's decision, and a
sweep that guessed would be a sweep that moved somebody's shop.

| Probe | What it catches |
|---|---|
| `publishedWithoutPlace` | Published and naming no GoWay place: looks live in the dashboard, invisible to every shopper. Whether the place still names the location back is derived per read, not probed — it would cost a GoWay read per location |
| `publishedWithNoLiveListing` | Offering collection with no live listing anywhere at the location: the "inventory level → native offer → public location" chain (#93 operations rule 7) walked in the direction that finds the silent case |
| `openCollectionsAtClosedLocations` | A buyer holding an order for a place that stopped offering collection |

### Runbook

**A shopper reports "it says available and the shelf was empty".** Read the
location's `stock_confirmation_interval_seconds` and the level row's
`updated_at`. If the interval is longer than the merchant's real cadence, the
merchant shortens it — the number is theirs, on purpose.

**A merchant reports "my shop does not appear".** Their dashboard's place-link
check (`…/place-link/verify`) names every failing condition of the trust rule —
commonest: the claim is still pending in GoWay, so the back-reference is only
`community_reported`. Then the consistency probes, then
`deriveLocationDiscoverability`, which returns the whole reason list rather
than the first.

**A collection code will not scan.** Staff use the audited override
(`POST …/pickup/collect` with `{override:{reason}}`), which is #93 verification
rule 7 and is what stops a customer being stranded at a counter. Every attempt is
in `pickup_collection_events`, refusals included.

**A code has leaked.** `POST …/pickup/rotate-code`. Every outstanding copy stops
working at once.

**A location has to come down NOW.** The merchant pauses it
(`…/publication/pickup-pause`); an operator restricts it
(`POST /internal/pickup/publications/:id/restriction`). The two are different
columns on purpose: a merchant must not be able to lift Mercaria's restriction by
un-pausing their own shop. Placed collections are untouched by either — see
`openCollectionsAtClosedLocations`.

---

---

## 16. The client half

`packages/ui` (`lib/pickup-labels.ts`, `NearbyLocationCard`,
`PickupCollectionPanel`), `packages/frontend`
(`components/nearby/`, `app/(app)/nearby.tsx`, and the pickup branches of
checkout, the order detail and the guest portal) and `packages/dashboard`
(`components/orders/PickupDeskCard.tsx`).

### The three surfaces, and why there are three

| Surface | Asks the server for | Why |
|---|---|---|
| Product page — `NearbyAvailability` in BROWSE mode | availability only | #93 nearby rule 12: a page view must not spend per-location eligibility work, and a shopper reading about a product has not decided to buy it here |
| `/nearby` — the same component with `withCheckoutEligibility` | availability AND the actor verdict | this is the surface that HAS decided, so it may offer "Collect here" |
| Checkout | nothing new | the choice arrives as `?pickup=<locationId>` and the SERVER re-validates it against the actor and every line in the group |

`NearbyAvailability` is the ONE component #93 client rule 7 asks for. It takes a
canonical subject and nothing about the page it is on, so a third surface mounts
it rather than growing a fourth rendering of the same idea.

### What a buyer is never told

`checkoutEligibility` is the one place `PickupBlockReason`s reach a client, and
`describeBuyerPickupBlock` (`@mercaria/ui`) collapses them to ONE sentence before
anything renders them — §2's rule, held in a pure function rather than in each
screen's discretion. The full per-reason copy exists, is exported, and is
merchant-facing: the dashboard reads it about the reader's own shop.

The one branch on the reasons is whether signing in would change the answer. It
is offered only when EVERY reason is guest-specific, so #93 client rule 10's
"optional benefit, not a condition" cannot become an account prompt in front of
a shop that would refuse an account holder too.

### Permission, and the refusal that is not a dark pattern

Nothing is asked for on mount: `useNearbyOrigin` exposes `requestDeviceOrigin`
and a control calls it. There is no `watchPosition`, no subscription and no
background read anywhere, so #93 location-input rule 3 is the ABSENCE of those
calls rather than a setting.

The city picker sits BESIDE the device control from the start rather than
appearing after a refusal, and a refusal REMOVES the device control instead of
leaving a button that re-prompts. Both are deliberate: a shopper who never wants
to share a position should not have to decline a prompt to discover that typing
a city works, and asking again is the pattern the rule exists to prevent.

### What is in a URL, and what is not

The buyer's coordinate lives in one component's state for as long as the screen
is open. It is never a route param, never in a store, never in an analytics call
and never in a React Query key — the key carries the COARSE cell (`use-nearby.ts`).

`?pickup=` and `?pickupName=` carry a merchant's own published shop front, which
#93 client rule 14 does not cover: it is public, it is the merchant's rather
than the buyer's, and it authorizes nothing. It is in the URL because the choice
has to survive a reload and a bank redirect, which is client rule 11.

### The collection code

Rendered by `PickupCollectionPanel` on the buyer's order detail and in the guest
portal, fetched by its own call against its own authorized route — never a field
of an order DTO, which is logged, cached and forwarded into support tooling.

It is shown on BOTH portal views, including the bounded one a just-paid device
holds. That is #93 pickup rule 13 (a guest must not have to claim the order into
Oxy to collect it) and it matches the server, whose collection route requires a
portal session and a matching group and no scope beyond it.

It is TEXT and not a QR image, deliberately: the alphabet was already chosen to
be read off a phone screen and spoken aloud, so a shopper with a cracked screen
or a screen reader can still complete a handover, and no app needs a QR
generator dependency to show one.

### Merchant desk

`PickupDeskCard` renders only for a collection order — the 404 a delivery order
answers with makes it return `null` — and carries mark-ready, collect-by-code,
the audited override, rotate and cancel, plus the trail. It shows NO buyer
identity: `OrderPickup` has no field for one, so #93 merchant rule 2 and
acceptance 11 are properties of the type. There is no "show the customer's code"
control, because no route returns one.

### What is NOT met, and why

- **#93 client rule 6's "best overall" sort.** The nearby list offers two orders
  — nearest (the server's own, rendered untouched) and lowest price — and both
  are facts. A "best overall" would be a weighted blend of distance and price
  composed on the client, which is a SECOND, unversioned ranking authority of
  exactly the kind #74's policy versions exist to be the only home for. The
  nearby endpoint applies no #74 policy at all: it is a proximity read over
  locations, not a comparison over offers, so there is no published ranking to
  reuse here. Closing this means either a ranked nearby endpoint under a policy
  version, or a `nearest` member on `OfferComparisonIntent` plus a viewer
  position on the product-page read — `/p/:handle` accepts no coordinate today,
  which is why `best_nearby_pickup` is still never awarded on that page even
  though #93 closed `resolvePickupProximity`.
- **The device-location prompt on NATIVE.** `useNearbyOrigin` answers
  `unsupported` there and has since #93's server half: the native apps carry no
  location dependency, and adding one is a config-plugin change plus a
  store-listing permission disclosure. The manual place picker is a COMPLETE
  path without it, and the refusal copy says "this app cannot read a device
  location" rather than a generic failure — so the feature is usable on native,
  and it is the browser that exercises the permission path. Nothing here has
  been verified against a real iOS or Android permission dialog.
- **Sorting applies to the LOADED page.** `/nearby` is keyset-paginated and the
  hook reads one page; when a next cursor exists the screen says so rather than
  claiming a comparison it did not make. Paging is not wired.

### Where a shopper cannot reach this

`/search` and the watchlists were named in #93 client rule 7 as surfaces that
could reuse the component. Neither mounts it: a search result page and a
watchlist are LISTS, and a nearby section per row is one request per row against
an endpoint keyed on a position. The component is reusable and the two screens
are where it would go; the request shape is what stopped it, not the component.

## 17. What #93 asked for and did not get

Stated rather than quietly narrowed.

- **Buyer cancellation of a collection order.** #110's
  `resolveCancellationEligibility` returns `pickup_not_supported` for a pickup
  order, and #110's own comment says why: a cancellation that took the `release`
  path would release a reservation while a collectable-inventory hold nobody
  modelled stayed behind. It is #110's decision and it still fails closed; the
  merchant-side cancellation is `…/pickup/cancel` plus the existing order-cancel
  path.
- **A `mercaria_retail` collection.** #116 owns the offer kind; nothing here
  reaches it.
- **The #85 activation state itself.** Named, fail-closed, and reusing #107's
  lever (§11).

---

## 18. Production-readiness checklist

- [ ] `PICKUP_COLLECTION_CODE_KEY` provisioned (64 hex) in SSM, and in the
      deploy workflow's explicit secret allow-list **in the same change** as the
      task definition entry.
- [ ] `GOWAY_API_URL=https://api.goway.to` in the oxy-infra task definition's
      `environment` (configuration, not a secret) BEFORE either lever turns on.
- [ ] `NEARBY_DISCOVERY_ENABLED=true` only after a merchant has published at
      least one linked location — the surface is honest but empty otherwise.
- [ ] `STORE_PICKUP_ENABLED=true` only after the collection-desk flow has been
      walked end to end on a real store with real staff permissions.
- [ ] `GUEST_STORE_PICKUP_ENABLED` stays OFF until #111's rollout review.
- [ ] `CATALOG_OPERATOR_OXY_USER_IDS` non-empty, or `/internal/pickup/*` is not
      mounted and nobody can restrict a location or read the probes.
- [ ] PostGIS present on the target database — no runtime read uses it any
      more, but the migration chain names `geography` (`db/requiredExtensions.ts`).
- [ ] Before `0161` (post): export the place facts and link the locations — see
      "Moving to GoWay" below.

## Teardown and the trigger-toggle window

This suite's fixtures share the test database with every other realdb file, so
two rules from `docs/postgres-testing-and-migrations.md` bite here directly:

- **A trigger-toggle window may name exactly ONE table.** The first version of
  this file's teardown held two in one window and `cd6e8fd`'s census caught it.
  `DISABLE TRIGGER` takes ShareRowExclusive, whose counterparty is an ordinary
  writer holding RowExclusive, and `withTriggerToggleLock` only serialises window
  against window — so it cannot see that party. **Split, never reorder to match a
  writer.**
- **Stores go through `deleteTestStores` and canonical rows through
  `deleteTestCanonicalRows`**, which DECLINE exactly the ids a sibling's
  `match_decisions` pins rather than deleting somebody else's row.
- **No fixture may carry a date the real clock is still travelling toward** —
  the direction opposite `docs/postgres-testing-and-migrations.md`'s "write
  fixture instants relative to now" rule, and the subtler one: a fixture date
  the wall clock has not yet REACHED passes today and fails on the day it
  arrives, for whoever happens to be running the suite then. Measured in
  `services/pickup/__tests__/eligibility.test.ts`'s closure test, where a
  closure has to span the whole 7-day open horizon: rather than extending the
  closure's end date forward from the real `now`, the fix moved the injected
  CLOCK itself back a week, so both the closure and the horizon it spans sit
  safely in the past.

## Moving to GoWay (`0160` → `0161`)

`0160` (pre) adds `locations.go_way_place_id`; `0161` (post) withdraws every
PUBLISHED publication whose location names no place (one `state_withdrawn`
audit row each) and drops the place-fact columns and tables. Nothing re-derives
a dropped value, so count and export BEFORE the deploy:

```sql
-- How many publications 0161 will withdraw.
select count(*) from location_publications p
join locations l on l.id = p.location_id
where p.publication_state = 'published' and l.go_way_place_id is null;

-- Every place fact Mercaria holds, one JSON document per publication — what
-- the merchant (or an operator acting with them) needs to find or create the
-- GoWay place and re-enter hours, closures, contact and accessibility there.
select p.id as publication_id, p.store_id, p.location_id, p.publication_state,
       json_build_object(
         'name', p.display_name,
         'address', json_build_object('line1', p.public_line1, 'line2', p.public_line2,
           'city', p.public_city, 'region', p.public_region,
           'postalCode', p.public_postal_code, 'country', p.public_country),
         'timezone', p.timezone, 'phone', p.public_phone, 'url', p.public_url,
         'accessibility', json_build_object('stepFree', p.accessibility_step_free,
           'toilet', p.accessibility_toilet, 'parking', p.accessibility_parking,
           'hearingLoop', p.accessibility_hearing_loop),
         'position', case when p.latitude is null then null
           else json_build_object('latitude', p.latitude, 'longitude', p.longitude) end,
         'hours', (select coalesce(json_agg(json_build_object('weekday', h.weekday,
             'opensMinute', h.opens_minute, 'closesMinute', h.closes_minute)
             order by h.weekday, h.opens_minute), '[]'::json)
           from location_opening_hours h where h.publication_id = p.id),
         'closures', (select coalesce(json_agg(json_build_object('from', c.from_date,
             'through', c.through_date, 'note', c.note) order by c.from_date), '[]'::json)
           from location_closures c where c.publication_id = p.id and c.through_date >= current_date)
       ) as place_facts
from location_publications p
order by p.store_id, p.location_id;
```

Linking is the merchant's act, in the dashboard: find or create the place,
claim it for the store's Oxy account, assert `commerce.mercaria.store`, save,
publish. Mercaria has no service credential to write to GoWay, and a link an
operator typed for them would fail the trust rule anyway until the store's own
account holds the claim.

### `0162` ships in the NEXT release, never with `0161`

`0162` (pre) adds `location_publications.published_at` — the first
publication, which the public location reads tell "withdrawn" (410) from
"never published" (404) by — and backfills it from the publication trail,
`0161`'s withdrawals included. A `pre` queued behind an unapplied `post` is
refused by the migration planner (`@oxy.so/db`'s `planMigrationRun`): the
ledger is a high-water mark, so `0162` cannot apply before `0161`, and `0161`
cannot apply before the image that stops reading the dropped columns is
serving. Deploy the release carrying `0161` first, let its post phase run, then
the one carrying `0162`. `goway-place-migration.realdb.test.ts` runs them as
those two releases.
