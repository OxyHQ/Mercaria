# ADR 0010: Digital goods are a commerce type — assets, licences, buyer rights and digital fulfilment

- **Status:** Accepted
- **Date:** 2026-09-11
- **Issue:** epic [#1015](https://github.com/OxyHQ/Mercaria/issues/1015)
- **Amends:** [ADR 0007](0007-universal-catalog-taxonomy-and-authoring.md) **D15**,
  which classified a physical good and nothing else. `digital_good` moves from
  `EXCLUDED_COMMERCE_TYPES` to `MERCARIA_COMMERCE_TYPES` under D15's own admission
  procedure. The other four exclusions — `service`, `stored_value`,
  `event_admission`, `consumer_subscription` — are untouched, and every wall that
  holds them is still in place.
- **Inherits unchanged:** [ADR 0002](0002-canonical-commerce-graph.md) (a digital
  product is an ordinary canonical product with ordinary variants),
  [ADR 0001](0001-stripe-connect-architecture.md) D1 and D3–D12 and
  [ADR 0009](0009-peable-payment-rail.md) (a digital order is funded by the same
  rail, with the same ledger and the same commission residual),
  [ADR 0003](0003-commerce-actor-guest-identity.md) (a guest may buy a download,
  and the actor union is how).

## Context

`docs/commerce-types.md` is the document this ADR argues with, and it argued the
other way on purpose. It measured seven walls that made a digital good unsellable
here, named each one, and pinned it with a test whose failure message says which
ADR is being relaxed. Then it wrote down the procedure for relaxing them:

> To admit a commerce type: add it to `MERCARIA_COMMERCE_TYPES` and remove it from
> `EXCLUDED_COMMERCE_TYPES` … discharge every prerequisite the type's old
> disposition named, in the same change … remove its detector, and amend ADR 0007
> D15.

This is that change. It is worth stating plainly that **the walls were not in the
way of anything until now** — they were a true description of a repository that
sold parcels — and that #1015 is not a request to weaken them but a request to
pay for the one type it wants. Seven prerequisites were named; seven are
discharged; the detector is gone and a narrower one replaces it.

**What made this tractable is that the catalogue already had the right shape.**
#367 gave Mercaria category → product type → canonical product → canonical
variant → listing → offer, and every one of those is as true of a 3D model as of a
brake pad. What the catalogue has never modelled, for anything, is **what gets
handed over**. That is the whole of the new domain: an asset, its immutable
versions, the files in one, the packages an offer sells, the licence terms a buyer
is held to, and the durable right that authorizes a download.

**The launch vertical is deliberately narrow.** 3D assets for printing, games and
visualization, because they are the category where Mercaria's physical side is a
real advantage later (#1015 Workstream 10) and because the metadata a buyer needs
is measurable rather than a matter of taste. The foundation is built so a second
vertical is rows in a registry rather than a second commerce stack — #1015
acceptance criterion 20 — and `DIGITAL_VERTICALS` already admits eight.

## Decisions

### D1. The vocabulary, and nothing collapses into a JSON blob

#1015 Workstream 0 asks for exactly this, so it is first. Eleven nouns, each a
table or a tuple:

| Concept | Where it lives |
|---|---|
| Digital asset | `digital_assets` — the creative work as a COMMERCIAL identity. Owns no bytes. |
| Asset version | `asset_versions` — one IMMUTABLE release. Bytes belong here. |
| Asset file | `asset_files` — one stored binary of one version, with its measured size, media type and content hash. |
| Asset package | `asset_packages` + `asset_package_files` — the named DELIVERABLE an offer sells: a subset of one version's files. |
| Licence definition | `asset_licences` — a named licence. Mutable metadata only. |
| Licence version | `asset_licence_versions` — the TERMS, immutable once published. |
| Licence option | `asset_licence_options` — this licence version, over this package, with this update policy. |
| Buyer right | `asset_rights` — what a buyer durably OWNS. |
| Right history | `asset_right_events` — append-only. |
| Download grant | `asset_download_grants` — a short-lived, single-file door. |
| Download event | `asset_download_events` — the access audit. |

Plus `asset_file_inspections` (what Mercaria MEASURED), `asset_provenance_signals`
(upload-time evidence) and `asset_variant_bindings` (the one join to the
catalogue).

**"Entitlement" is not used for the buyer side, and that is a naming decision with
a reason.** #1015 W2 requires this domain be separate from #89's merchant-plan
entitlements, and its own suggested names (`DigitalEntitlement`,
`DigitalEntitlementGrant`) sit one adjective away from `entitlement_grants`,
`MerchantEntitlementCapability` and `EntitlementGrantReason`, which already exist
here and mean Mercaria billing a merchant for its own software. Two domains one
adjective apart is how a service resolves the wrong one. The buyer side is an
**asset right** throughout.

### D2. What attaches where

- **Canonical product** — the work as the catalogue knows it. An asset points at
  one.
- **Canonical variant** — a materially different DELIVERABLE CONFIGURATION may be
  one: `printable`, `game-ready`, `rigged`, `source-files` (#1015 boundary 7). A
  FILE FORMAT may not, because several formats belong to one purchased package
  (boundary 6).
- **Listing / variant** — where price lives, unchanged. A digital offer is a
  listing variant like any other, bound to a licence option by
  `asset_variant_bindings`.
- **Order line** — carries the SNAPSHOT: package, asset version, licence version,
  update policy. Four columns, all-or-nothing by CHECK.
- **Order** — carries the place of supply and the withdrawal basis, because both
  are properties of the buyer and this checkout rather than of a deliverable.

**A buyer choosing between Personal €6 and Commercial €25 is choosing between two
VARIANTS**, each bound to its own licence option. That is boundary 5 holding in
the direction people expect it to fail: the licence is not a variant AXIS and the
rights still live on the licence version, but a priced choice is a priced thing
and the catalogue already knows how to price variants.

### D3. A purchase pins a LICENCE VERSION, and that row is immutable

Editing a licence tomorrow cannot change yesterday's purchase. The mechanism is
not a service check: `asset_licence_versions_immutable_once_published` refuses
every UPDATE of every terms column once `published_at` is set, and refuses DELETE
outright. A right names the version by id and copies none of its text — copying
would create a second record of one fact, and in a dispute somebody would compare
them.

### D4. Whether updates are included is the OPTION's answer, not the platform's

`DIGITAL_LICENCE_UPDATE_POLICIES` has three members —
`purchased_version_only`, `same_major_version`, `all_future_versions` — and the
right freezes which one applied. #1015 W0 question 4 lists all three as
possibilities and every one of them is somebody's real commercial model; pinning
one would make the others unrepresentable, and deriving it at read time would mean
a buyer's rights changed when Mercaria changed its mind.

`same_major_version` reads `asset_versions.major_version`, the leading integer of
the creator's own label. **A creator numbering releases `spring-2026` gets 0 for
all of them, so that policy behaves as `purchased_version_only` for them.** Stated
here rather than left to be discovered, because the alternative is a policy whose
meaning depends on a string nobody validated.

`coveredVersion` and `coversVersion` (`services/digital/version-coverage.ts`) are
the one implementation, and they are PURE — which is why the rule is tested
exhaustively rather than illustratively.

### D5. A RIGHT authorizes a download. A payment does not

#1015 boundary 4. The chain is `paid order line → asset_rights → download grant →
download event`, and every arrow is a server-side authorization. Six questions are
asked in this order, and none of them reads a payment:

1. Are downloads enabled on this deployment?
2. Does a right exist for this caller over this package?
3. Is it in a status that authorizes? (`active`, and only `active`.)
4. Does its update policy cover the version being asked for?
5. Is that version in a downloadable state?
6. Is the file IN the package at that version, and downloadable at all?

**Every refusal happens before any storage key is read.** `asset_files.storage_key`
is a PROTECTED column, so reading one is an explicit, greppable act, and
`download.service.ts` is the only module that performs it — after the last
refusal.

The grant carries a SHA-256 of a token handed to the buyer once; the token itself
is never stored and never logged (#1015 W1 rule 4). It expires in five minutes and
is redeemable five times, which is what makes a resumed transfer work without
making the grant a shareable URL.

**"No right" and "somebody else's right" get the SAME answer.** Distinguishing
them would confirm that an id exists, which is the enumeration oracle #1015 W12
threat 1 is about.

### D6. Nothing is deleted; a refund is a state transition plus an event

`asset_rights` has no delete path — `asset_rights_commercial_half_immutable`
refuses DELETE outright and freezes every commercial column against UPDATE, so
the shape that would make #1015 W12 threat 9 real ("buyer claims a higher licence
than purchased") does not exist. Only `status` and the revocation basis move.

`ASSET_RIGHT_STATUSES` distinguishes `refunded` (terminal, the money went back),
`disputed_hold` (reversible, a chargeback is open), `revoked_for_policy` (closed
under a documented legal basis from a CLOSED set) and `superseded` (replaced by
another right). `asset_right_events` records every move and refuses UPDATE and
DELETE — `ledger_transactions`' treatment, because this is what a chargeback and
a takedown dispute are answered from.

A refund moves a right from `active` or `disputed_hold` only, so a right already
`revoked_for_policy` is not quietly downgraded: the stronger state wins, and it
matters because a revocation records a legal basis a refund does not.

### D7. A withdrawal or a takedown never revokes a prior legitimate purchase

`DOWNLOADABLE_ASSET_VERSION_STATES` is `['published', 'superseded', 'withdrawn']`.
`superseded` and `withdrawn` are IN the set and that is the load-bearing half: a
set listing only `published` would revoke every historical purchase the moment a
creator shipped an update or retired a version. What withdrawal stops is NEW
acquisition — `ACQUIRABLE_ASSET_VERSION_STATES` is `['published']`, one member.

`restricted` is the one state that stops access, and it is moderation's.

**A seller cannot delete an asset that has sales behind it.** Every foreign key
from `asset_rights` into the asset graph is `ON DELETE RESTRICT`, and the version
and file triggers refuse DELETE once published. #1015 W0 question 8 asked what
happens; the answer is that it fails, loudly, and the seller withdraws instead.

### D8. `delivery_destination` and `order_address_snapshot`, discharged

A fourth checkout destination, `digital_delivery`, which carries **no field at
all** — not an address with empty strings, and not a sentinel location. The two
things a digital checkout needs (the consumer's country, the supply consent) are
top-level `CheckoutInput` fields, because a MIXED physical + digital cart needs
both and has a shipping destination.

**The server decides whether that destination was true.** `checkout.service`
resolves the cart first and refuses `digital_delivery` for any cart holding a
physical line, with a message about the ITEM rather than about a destination type
nobody typed.

On `orders`, the five required address columns became **nullable** and a CHECK
took their place:

> `orders_shipping_address_digital_check` — a `digital` order has all NINE address
> columns NULL; every other order has the five required ones NOT NULL.

**That is stricter than the NOT NULLs it replaced**, which is the only reading
under which this is not a weakening: a NOT NULL could be satisfied by a fabricated
street — exactly what a digital order would have had to write — and the CHECK
cannot. #1015 boundary 16 is now a constraint rather than a convention.

### D9. `fulfilment_completion_signal`, discharged

A ninth order status, `digitally_delivered`, and a fourth fulfilment method,
`digital`.

**The method joins `SHIPPING_METHODS` rather than making
`orders.shipping_method` nullable.** `pickup` has been a non-shipping member of
that tuple since #93, so it has been a FULFILMENT vocabulary under a legacy name
for as long as collection has existed. The alternative is worse: every existing
read of that column is typed non-nullable, a `NULL` would reach four hydration
paths with no branch for it, and "this order has no fulfilment method" is not what
a digital order means.

The transition table gained exactly one edge — `paid → digitally_delivered` — and
`digitally_delivered` exits only to the two refund states. **The digital and
physical paths are therefore DISJOINT by construction**: no physical status lists
`digitally_delivered` as a predecessor, and `paid` is the only one that lists it
as a successor.

**D9.5.** A guest's right is keyed on their session, and a session expires. When a
guest CLAIMS their order (#101, ADR 0003 D14), the claim grants a fresh right to
the Oxy account with `source: 'migration'` and marks the guest's right
`superseded`. It is a new right rather than a re-key because `buyer_key` is
immutable by trigger and a guard with an exception is not a guard.

### D10. `tax_place_of_supply`, discharged — and the rule is PER LINE

`docs/commerce-types.md` named this wall precisely: *"`rateMatchesRegion` reads
the shipping country, region and postal code and nothing else"* — the
place-of-supply rule for GOODS, and structurally the wrong one for an
electronically supplied service.

**Reusing it would not have failed loudly.** A digital-only order carries no
address, so every region-scoped rate would simply have failed to match and the
order would have been taxed at zero: a green build, a plausible invoice, an
under-collection per sale.

So the region filter moved from the rate list into the (rate, line) loop. A
physical line is matched on country, region and postal code, exactly as before. A
digital line is matched on the consumer's **country alone**, and a rate scoped to a
region or a postal code does not match it at all — because nothing establishes
either for a digital supply, and matching vacuously on a NULL is the bug.

**A digital line with no place of supply matches NOTHING**, deliberately: a
checkout that reached pricing without establishing where the supply happened has a
bug, and taxing it at the shipping address would hide that bug behind a plausible
invoice.

**What is recorded is one country and the KIND of evidence for it, and nothing
else.** `FORBIDDEN_DIGITAL_SUPPLY_EVIDENCE_KINDS` names what may never establish
it — `ip_geolocation`, `ip_address`, `device_fingerprint`, `browser_locale`,
`timezone_offset` — and a test keeps the two sets disjoint. `~/AGENTS.md`'s no-IP
invariant holds here with no exception.

### D11. `condition_semantics` and `withdrawal_and_guarantee_terms`, discharged

**Condition:** a digital line carries NONE, and
`order_items_digital_no_condition_check` says so. `ITEM_CONDITION_KEYS` is
untouched at nine members. A tenth `not_applicable` member was the other way to
say this and is worse: it would have given every PHYSICAL listing a way to decline
to describe itself, which is the erosion #90 exists to prevent.

**Withdrawal:** `DIGITAL_WITHDRAWAL_BASES` is a closed three-member tuple —
`statutory_cooling_off`, `waived_on_immediate_supply`,
`not_applicable_trader_buyer`. The consumer regime answers immediate digital
supply with express consent plus acknowledgement of the loss, so the waiver is
paired with a timestamp by `orders_digital_withdrawal_consent_check`: a waiver
nobody can date is, in a dispute, the same as no waiver.

**Guarantee:** the goods conformity guarantee is replaced by
`DIGITAL_CONFORMITY_BASIS` — conformity with the DESCRIBED deliverable. That is
answerable only because measured facts and seller claims are separate tables, which
is why D12 is not optional.

### D12. Measured facts and seller claims are different TABLES, and stock is not a question

`asset_file_inspections` holds what the pipeline measured, with the processor name
and version that produced it; a creator's "optimized for Unreal" is a product-type
attribute value #367 already owns. One table with a provenance flag would let a
write path set the flag wrongly; two tables cannot be confused by one.

Every geometry column is nullable and NULL means **not measured**, which is why
`verdict` exists beside them: a `0` triangle count and an unmeasured one are
different facts, and #1015 W4's *"do not overclaim machine-generated validation"*
is unholdable if they share a representation.

**On stock:** a digital variant is `inventoryTracked = false`, which
`docs/commerce-types.md` warned is *close but not the same statement* —
"the count is unknown" rather than "counting is the wrong question". The statement
this ADR makes is the second one, and what makes it true in code is that
`metaForMutation` short-circuits an untracked variant, so a digital line produces
**no inventory movement at all**: no reservation, no commit, no restock, no row.
There is no stock column anywhere in the digital schema and a test asserts the
absence. `inventory_semantics` was not one of the seven prerequisites
`digital_good`'s exclusion named; #1015 boundary 1 asks anyway, and this is the
answer.

### D13. Five independent feature levers, and only one touches an existing right

#1015 acceptance criterion 19 requires that uploads, publication, paid checkout,
downloads and a vertical be disableable **without stranding prior purchases**. One
master flag could not do that. So:

| Lever | Default | What it stops |
|---|---|---|
| `DIGITAL_UPLOADS_ENABLED` | off | new files |
| `DIGITAL_PUBLICATION_ENABLED` | off | a version becoming sellable |
| `DIGITAL_PAID_CHECKOUT_ENABLED` | off | buying (a free claim still works) |
| `DIGITAL_DOWNLOADS_ENABLED` | **on** | minting new grants |
| `DIGITAL_ENABLED_VERTICALS` | empty | a whole vertical |

`downloadsEnabled` is the only one that reaches an existing right, hence the only
one defaulting on: it is an INCIDENT lever, and the thing you reach for mid-incident
must not be the thing that destroys what buyers hold. Turning it off refuses new
grants with `downloads_disabled` and leaves every right `active`.

Everything else defaults OFF because digital commerce has a launch gate in front of
it that is not a code review — see D15.

### D14. Creator content is not training data, and there is no column saying otherwise

Default: **no training use**, and it is not a per-asset flag a UI could flip. A
column would imply the permitting value exists; it does not, and it cannot until a
separate, explicit contract does. A test asserts no `train*`-shaped column exists
in the digital schema.

### D15. Paid digital launch is gated per market, and the gate is not a code review

#1015 W11 requirement 9 and acceptance criterion 15. Before
`DIGITAL_PAID_CHECKOUT_ENABLED` is turned on for a market, three sign-offs are
required and recorded in `HANDOFF.md`:

1. the payment provider permits a third-party digital-goods marketplace on this
   account (Peable, and through it whichever provider settles);
2. the tax treatment of electronically supplied services in that market is
   configured — rates exist, scoped to a COUNTRY, because a digital supply matches
   nothing narrower;
3. the consumer-law review of the withdrawal waiver copy for that market.

The code cannot hold these, and pretending a flag is a review is how a flag gets
flipped. What the code holds is that the flag defaults off and that a digital line
with no country-scoped rate is taxed at zero **visibly** rather than plausibly.

### D16. Gift cards, keys and third-party codes are still out

`stored_value` stays excluded, and `EXCLUDED_COMMERCE_TYPES` still carries it.
#1015 W11 says so itself: stored value and third-party redemption codes have
materially different fraud, regulatory and provider requirements and get their own
epic. **A redemption code is not a creator file download** and must never be
modelled as one — there is no `redemption_code` column and the `stored_value`
detector in `commerce-type-exclusion.test.ts` still forbids one.

## What this does not change

- **The catalogue.** No new product-type mechanism, no second authoring path, no
  `commerce_type` column. ADR 0007 D15's refusal of a discriminator stands, and
  the detector for it is still armed.
- **The money.** Same rail, same ledger, same commission residual, same fee
  schedules (#88). A digital sale is a connected-marketplace sale.
- **Physical orders.** No physical order's behaviour changes. The address
  constraint is stricter for them, not looser; the transition table gained one
  edge they cannot take; the tax rule for them is byte-for-byte what it was.
- **Shipping.** Still hidden, still Moovo's, and a digital order never enters it.

## Consequences

- **Fifteen new tables and one migration** (`0156`), `pre`-phase, with four
  immutability triggers and three append-only ones. The five NOT NULLs on
  `orders`' address columns are gone and a stricter CHECK replaced them.
- **The digital-good detector is removed** and
  `digital-commerce-walls.test.ts` replaces it with boundary-shaped gates. That
  swap is the part a future reader should check first: if the new gates erode, the
  old wall is not there to catch it.
- **`commerce-type-structural-walls.test.ts` moved three pins**, in this change,
  where a reviewer sees them. `ITEM_CONDITION_KEYS` did not move.
- **Phases B–E of #1015 are not in this change.** The processing workers, the 3D
  viewer, the storefront and creator surfaces, re-upload detection and the physical
  print bridge are all downstream of this foundation, and `HANDOFF.md` carries
  what each still needs. What this ADR commits to is that none of them requires a
  second commerce stack.
