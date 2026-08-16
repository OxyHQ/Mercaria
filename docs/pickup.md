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

---

## 1. What is stored, and what is deliberately not

Eight tables, all additive. The operational `locations` row and its
`inventory_levels` are untouched: #93's own issue says it "reuses the existing
`Location`, `InventoryLevel` and POS domains", and this domain is the PUBLIC
face of them plus everything a handover needs.

| Table | Holds |
|---|---|
| `location_publications` | One location's public face: display name, the address fields the merchant chose, timezone, position, publication state, pickup switches, freshness policy |
| `location_opening_hours` | One interval per row, so a split shift is expressible |
| `location_closures` | Dated exceptions |
| `location_publication_events` | Append-only audit of publication and geocoding changes |
| `order_pickups` | One order's frozen collection snapshot plus its operational state |
| `pickup_collection_credentials` | A rotation counter and four instants. **No code, no hash, no ciphertext** |
| `pickup_collection_events` | Append-only audit of everything at a collection desk |
| `listing_local_discovery` | A P2P seller's coarse CELL. **No coordinate column** |

### Why a separate publication row rather than columns on `locations`

The two objects have different audiences, different editors and different
failure modes. `locations` holds the address a pallet is delivered to and the
name a warehouse manager gave a building; a publication holds what a merchant is
willing to have a stranger read, and **every field of its address is optional**
because "the city and nothing else" is a complete, common answer.

Widening `locations` instead would have meant the operational address and the
published one were the same nine columns — and the first naive
`select().from(locations)` on a public route would then disclose a stockroom's
street and the phone number of whoever signs for deliveries.

It also makes the default right by construction: a store with no publication row
is not discoverable, and that is the state every existing store is in.

---

## 2. The verdict is DERIVED and never stored

There is no `discoverable` column and no `pickup_eligible` column. Whether a
location may be shown, and whether a particular actor may check out for
collection there, is a conjunction over the LIVE `locations.is_active`, the LIVE
store, the LIVE listing status, the LIVE stock level and its age, the
publication's own state, and — for a guest — three deployment levers.

Six tables in four domains this one does not own. This is #57's
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

## 3. Position, and the geocoding provider Mercaria does not have

`LOCATION_GEOCODE_PROVENANCES` has three members and every one is a MERCHANT or
an OPERATOR act. **Mercaria runs no geocoding provider and calls none.**
`services/checkout` already asserts by scan that no address-correction client
exists on the checkout path, and adding one here would put a third party between
a merchant typing their own shop's address and that shop being findable.

`LOCATION_FORBIDDEN_GEOCODE_PROVENANCES` states the prohibition as a VALUE,
disjoint from the permitted tuple by a test. The last two members are the ones
worth reading: a coordinate derived from where BUYERS were, or from where
parcels went, is a position built out of other people's locations.

The consequence is stated rather than hidden: **a merchant who supplies no map
pin has a location that cannot be discovered by proximity at all.** That is an
honest "we do not know where this is", it is why `location_not_geocoded` is a
block reason, and it is why `changePublicationState` refuses to publish a
location with no pin.

### The null island

`(0, 0)` is a real point in the Gulf of Guinea and is what every failed import,
every uninitialised float and every "the form submitted before the map loaded"
produces. A plain range check ADMITS it and sorts it first for everybody in West
Africa. Both the CHECK and `assertUsableCoordinate` refuse the PAIR — and
Greenwich and Quito are still accepted, which is the fixture that tells a correct
refusal from a broken one.

### `ST_DWithin`, not a bounding box

A latitude/longitude box is wrong at both poles and broken across the
antimeridian, and the failure is silent — it returns a plausible list with the
wrong things in it. The GiST index on the generated `geography` column is what
makes the real spheroidal predicate an index scan.

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

`LOCATION_AVAILABILITY_STATES` is `in_stock | low_stock | out_of_stock`, and
`exactQuantity` is present ONLY where `discloses_exact_stock` is on. A consumer
that wants to render "3 left" has to read a property that is usually absent,
which is the shape that makes the default safe (#93 inventory rule).

The low-stock threshold is the location's own, so a shop that carries two of
everything is not permanently "low" and a warehouse that carries four hundred is
not permanently "in stock" at three.

---

## 6. Privacy: the shopper's coordinate lives inside one function call

It arrives on the request, it is passed to PostGIS, and it is gone. What leaves
`nearby.service.ts` is the COARSE CELL (`toLocalArea`, 0.1° ≈ 11 km) on the
echoed origin and in the one structured log line, plus per-location distances
rounded OUTWARD.

Nothing writes it anywhere, no analytics event carries it (#77's schema has no
column that could), and `pickup-isolation.test.ts` fails the build if this domain
learns to emit one.

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

## 7. The manual-location fallback needs no gazetteer

`GET /nearby/places` answers with the distinct public CITIES among published
locations that actually hold the item, composed from the SAME `where` the result
read uses — so a city offered there always yields something when picked, and a
dead end wearing a search box is impossible.

Selecting one hands back a CELL CENTRE as the next request's origin, so the
fallback path never sees a precise coordinate at all.

This answers #93 acceptance 5 ("denied location permission has a functional
manual-location fallback") without an outbound call, and it is now met **end to
end**: `components/nearby/NearbyOriginControl.tsx` is the entry box, and §18
below describes the screen around it. The city list is offered BESIDE the
device-location control rather than after a refusal, so a shopper who never
wants to share a position does not have to decline a prompt to find out that
typing a city works.

The match is a PREFIX on the city and on the postal code, deliberately not a
trigram similarity: a fuzzy match would offer a shopper a city they did not type,
and the remedy for a typo is one more keystroke rather than a guess.

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
buyer typed. What the ORDER records is a snapshot composed from the merchant's
own PUBLICATION, which is the already-public place the goods are, and which is
exactly what the POS path has snapshotted since the Mongo port
(`buildPickupSnapshot` in `draft-order.service`).

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
| `GET /nearby` | Mounted only when `NEARBY_DISCOVERY_ENABLED` is on. `resolveCommerceActor`, so signed-out browsing works. `Cache-Control: private, no-store` |
| `GET /nearby/places` | The manual fallback |
| `GET /nearby/p2p` | 404 while `P2P_LOCAL_DISCOVERY_ENABLED` is off |
| `GET /search?nearLatitude=&nearLongitude=` | #70's filter 10, a CONTRACT CHANGE rather than a parameter that was accepted and ignored. A MEMBERSHIP filter, never an ordering |

### Buyer

| Route | Notes |
|---|---|
| `GET /orders/:id/collection` | The snapshot and the code, through #106's `authorizeOrderAccess` |
| `GET /guest/orders/:groupId/orders/:id/collection` | The SAME handler, through #108's portal grant (#93 verification rule 9) |

### Merchant and POS

Under `/admin/stores/:storeId/`, on the permissions that already existed (#93
operations rule 4): `locations:write` for the shop front, `orders:fulfill` for the
desk, `orders:read` to look one up.

- `locations/publications`, `locations/:id/publication` (GET/PUT),
  `…/publication/{state,pickup-pause,confirm,closures,events}`
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
NEARBY_DISCOVERY_ENABLED=false            # mounts /nearby
STORE_PICKUP_ENABLED=false                # may a checkout resolve a pickup
GUEST_STORE_PICKUP_ENABLED=false          # may a GUEST collect
P2P_LOCAL_DISCOVERY_ENABLED=false         # the coarse P2P surface
GUEST_PICKUP_REQUIRE_NOTIFICATION_TRANSPORT=false
PICKUP_COLLECTION_CODE_KEY=               # 64 hex; demanded by STORE_PICKUP_ENABLED
```

`STORE_PICKUP_ENABLED=true` **requires** `PICKUP_COLLECTION_CODE_KEY` (the
half-configuration rule), and `GUEST_STORE_PICKUP_ENABLED` additionally requires
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

`GET /internal/pickup/consistency` runs four probes, each an exact count plus a
bounded sample. Detection and repair are separate acts (the
`payment_discrepancies` posture) — every remedy is a merchant's decision, and a
sweep that guessed would be a sweep that moved somebody's shop.

| Probe | What it catches |
|---|---|
| `publishedWithoutPosition` | Published with no pin: looks live in the dashboard, invisible to every shopper. The longest feedback loop in the domain |
| `probableDuplicates` | Two published locations of one store within 150 m. Not an error — a department store has two entrances — which is why it reports |
| `publishedWithNoLiveListing` | Offering collection with no live listing anywhere at the location: the "inventory level → native offer → public location" chain (#93 operations rule 7) walked in the direction that finds the silent case |
| `openCollectionsAtClosedLocations` | A buyer holding an order for a place that stopped offering collection |

### Runbook

**A shopper reports "it says available and the shelf was empty".** Read the
location's `stock_confirmation_interval_seconds` and the level row's
`updated_at`. If the interval is longer than the merchant's real cadence, the
merchant shortens it — the number is theirs, on purpose.

**A merchant reports "my shop does not appear".** Run the consistency probes
first: `publishedWithoutPosition` is the commonest cause. Otherwise call
`deriveLocationDiscoverability` through the merchant's own publication read,
which returns the whole reason list rather than the first.

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

- **A place-name gazetteer.** `GET /nearby/places` answers from the published
  locations themselves, which is provider-free and can never offer an empty city
  — but it cannot resolve a place where nothing is stocked. Closing that needs a
  geocoding provider and the decision not to have one (§3).
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
- [ ] `NEARBY_DISCOVERY_ENABLED=true` only after a merchant has published at
      least one location with a pin — the surface is honest but empty otherwise.
- [ ] `STORE_PICKUP_ENABLED=true` only after the collection-desk flow has been
      walked end to end on a real store with real staff permissions.
- [ ] `GUEST_STORE_PICKUP_ENABLED` stays OFF until #111's rollout review.
- [ ] `CATALOG_OPERATOR_OXY_USER_IDS` non-empty, or `/internal/pickup/*` is not
      mounted and nobody can restrict a location or read the probes.
- [ ] PostGIS present on the target database (a privileged role installs it once;
      `db/migrate.ts` ensures it and fails with a privilege message rather than
      an unknown-type one).

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
- **The GiST index over `location_publications.geo_point` is asserted to EXIST**
  (`pickup.realdb.test.ts`, `'is covered by a GiST index, which no functional
  test could miss the absence of'`) — no functional case could ever catch its
  absence, since `ST_DWithin` returns the same rows against a sequential scan,
  just slower, invisible at fixture scale and catastrophic at catalogue scale.
  The assertion reads `pg_indexes`, asserts the row count FIRST (so "found no
  index" cannot be what a pass looks like), and asserts `USING gist`
  specifically — a plain btree over a `geography` column is created without
  complaint and cannot serve the operator. Mutation-tested by renaming the index
  in the migration: exactly that test goes red and all other functional cases
  stay green, which is the whole argument for having it — this repo's worked
  example of "an index is the one thing a functional test can never detect the
  absence of."
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
