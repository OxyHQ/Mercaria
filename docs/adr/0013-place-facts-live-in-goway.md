# ADR 0013: A location's place facts live in GoWay; Mercaria keeps commerce and a `goWayPlaceId`

- **Status:** Accepted
- **Date:** 2026-10-04
- **Supersedes:** #93's "Mercaria runs no geocoding provider" rule and its
  merchant-pin provenance (`LOCATION_GEOCODE_PROVENANCES`,
  `LOCATION_FORBIDDEN_GEOCODE_PROVENANCES`, `docs/pickup.md` §3 as it was).
  Nothing else in ADRs 0001–0012 is reopened.
- **Org-wide rule it implements:** `~/Oxy/docs/api-conventions.md`, "Cross-app
  references": *a product stores another product's resource as an opaque ID
  with no foreign key and fetches current facts through that product's SDK;
  the one exception is a frozen record such as an order's pickup address.*
- **Builds on:** ADR 0012 (a store is owned by an Oxy account) — the account
  that claims the GoWay place is the account that owns the store.

## Context

GoWay (Oxy's map) and Mercaria both modelled the same physical shop, twice, with
nothing joining them. A Mercaria location's publication carried a display name,
a public address, an IANA timezone, a phone and a URL, four accessibility flags,
a merchant-dropped pin with a generated PostGIS point, a weekly schedule
(`location_opening_hours`) and dated closures (`location_closures`). A GoWay
place carries the same facts, plus categories, typed attributes with
verification tiers, hours exceptions, history, moderation and a claim by the
business's Oxy account. A merchant had to keep two copies in step by hand; the
shopper on goway.to and the shopper on mercaria.co could be told different
opening hours for one door.

## Decisions

### D1. GoWay is the source of truth for where a location is and what it is like

Name, address, position, timezone, weekly hours and their exceptions, contact,
accessibility and every other place attribute live on the GoWay place.
`locations.go_way_place_id` is the whole of what Mercaria stores about them: an
opaque id, no foreign key, unique per store (`locations_go_way_place_id_store_id_key`).
Mercaria keeps what is Mercaria's — whether a location is published, whether
and how it offers collection, its pause and the operator's restriction, its
inventory source and stock-freshness policy, the storefront it is a branch of.
`0159` (pre) adds the id, `0162` (post) drops the copies.

### D2. A position comes from the GoWay place the merchant chose or created

The dashboard searches GoWay (or creates a place with a map pin) and the
merchant picks the place; there is no other way to give a location a position.
This replaces #93's rule that Mercaria calls no geocoder and that a position is
a merchant's own pin: GoWay is Oxy's own place authority, its places carry
their provenance, and a merchant moving their shop moves it in GoWay, where the
map, its history and its moderation already are. The manual-location fallback
on `/nearby/places` now resolves a typed town through GoWay's geocoder — the
gazetteer #93 asked for and could not have.

### D3. The trust rule: a location trades from a place only when the place names it back

A location is linked — and may be published and discovered — only when all of:

1. it names a GoWay place (`go_way_place_id` is set);
2. a PUBLIC GoWay read shows the place exists, is `active` and is not merged —
   a merged place is followed (`mergedInto`) and the stored id rewritten, by
   the verify act only (D5);
3. the place's strongest `commerce.mercaria.store` assertion is THIS location's
   id at `business_asserted` or `oxy_verified`.

Only whoever acts for an approved claim on the place can assert at
`business_asserted` (only GoWay's moderators at `oxy_verified`), and the claim
is filed for the store's owning Oxy account. So the back-reference proves that
whoever controls the place controls the store, and the link is bidirectional
and verifiable by anyone with a public read. A collection also needs the place
to carry a country and a timezone, because an order's snapshot cannot be
written without them. The rule is DERIVED on every read and never stored,
exactly as #93's discoverability is: when the link breaks, the location stops
being discoverable at the next read.

### D4. Reads go through one adapter, with a short cache

`services/goway/` is the only backend code that imports `@goway.to/sdk`
(`pickup-isolation.test.ts` holds it). Its base URL is `GOWAY_API_URL`, every
request has a budget (`GOWAY_TIMEOUT_MS`), and its failures are three answers:
not found, gone (with the merge pointer), unavailable. Every read is PUBLIC —
no service credential exists to hold. Place reads by id are cached (Redis when
configured, in-process otherwise) for at most a minute: the cache TTL is
capped at the shortest stock-confirmation interval a location may declare, so
the link is re-checked at least as often as the freshest stock claim. A
last-good place is kept for a day to describe a collection during an outage.
Reads keyed on a shopper's position are never cached.

### D5. The merchant edits the place in GoWay, with their own session

The dashboard calls GoWay directly with the merchant's Oxy session (user tokens
are `aud=oxy-api`, not app-bound; GoWay's CORS admits Mercaria's origins): it
claims the place for the store's `oxyAccountId`, edits hours, exceptions,
contact and attributes, and asserts `commerce.mercaria.store`. Mercaria's
backend never writes to GoWay. `POST …/locations/:id/place-link/verify`
re-checks the rule fresh, follows a merge, and returns what is missing;
publishing runs it and refuses a location it refuses.

### D6. The collection snapshot is frozen from the place at checkout

`order_pickups` keeps its own name, address and timezone, read from the GoWay
place when the order is placed and frozen by trigger, plus the place's id
(`0159` adds it to the freeze). It is history — the buyer agreed to collect
from what they were shown — which is the convention's one allowed copy.

## Consequences

- **Availability.** Discovery and collection now depend on GoWay answering.
  Nearby answers `503` rather than an empty page. A collection checkout uses a
  last-good place when GoWay is down and fails closed (`503`, retryable, saying
  why) when there is none. Delivery checkouts never ask GoWay
  (`checkout.stripe.realdb.test.ts`). The merchant-activation count of
  collectable locations reads an outage as "not collectable". This is the
  accepted cost of one source of truth; the cache bounds it.
- **Privacy.** A shopper's coordinate is forwarded to GoWay for the length of
  one nearby request, as their browser would send it, and is transient there by
  GoWay's own rule. Mercaria still logs only the coarse cell and caches nothing
  keyed on a position (`goway-places.realdb.test.ts`).
- **Existing publications.** `0162` withdraws every published location that
  names no place, with an audit row; a merchant links a place and publishes
  again. Export the place facts BEFORE deploying (`docs/pickup.md`, "Moving to
  GoWay") — nothing re-derives a dropped column.
- **Merges** unlink a location from the public reads until the merchant's next
  verify (the dashboard runs one whenever the location is opened).
- **Duplicates** are GoWay's to find; the 150 m duplicate probe is gone, and
  two of one store's locations cannot name one place.
- **Legacy points removed with it.** `listings.longitude`/`latitude`/`geo`
  (a point read only by an unused `/listings?lng&lat&radiusM` filter)
  and `seller_listing_drafts`' coarse location are dropped: a P2P seller's area
  is `listing_local_discovery`'s cell and nothing else. PostGIS stays a required
  extension only because the migration chain names `geography`.

## Rejected

- **Copy the place into Mercaria and sync it.** Two copies that can disagree is
  the problem, with a sync job added.
- **Store the link on GoWay only.** A place asserting a location id proves
  nothing about which store wants it; the location must name the place too.
- **Accept a community or imported back-reference.** Anyone can report a
  capability; only a claimant can assert at the business tier.
- **Follow merges on the public reads.** It would mean a GoWay read per
  mismatch on the hottest path, and a stored id that never converges.
