# What Mercaria's catalogue classifies (#367 line 144, ADR 0007 D15)

A physical good, and nothing else.

Epic #367 line 144 asks to *"define how bundles, services, digital goods and
non-standard future commerce types fit or are intentionally excluded"*. This is
that definition. ADR 0007 D15 is the binding form; this file is the reference and
the evidence behind it.

**Code:** `packages/shared-types/src/commerce-type.ts` (the decision, as data) ·
`packages/backend/src/__tests__/commerce-type-exclusion.test.ts` (the wall) ·
`packages/backend/src/__tests__/commerce-type-structural-walls.test.ts` (the
pins) · `PRODUCT_TYPE_COMPOSITION_AXIS_KEYS` in
`packages/shared-types/src/product-type.ts` (the bundle half, as a CHECK).

---

## The four answers

| Asked about | Answer | How it is held |
|---|---|---|
| **Bundles** | **FIT.** No product type of their own. | ADR 0002 D15's `bundle_components`, already built. Composition may never become a variant axis — a rendered CHECK on two tables. |
| **Multipacks** | **FIT.** No product type of their own. | A `pack_count` variant of the same product with its own GTIN. `pack_count` is deliberately absent from the forbidden-axis tuple, and a test pins the absence. |
| **Services, digital goods, stored value, event admissions, consumer subscriptions** | **EXCLUDED.** | Six comment-stripped detectors over both source trees, plus six existing structural walls now pinned. |
| **Future types** | **A procedure, not an extension point.** | A closed prerequisite vocabulary and a total disposition map. |

---

## Bundles fit, and the fitting was already done

`bundle_components` is a real, migrated table with a quantity CHECK, a
self-containment CHECK, a pair unique index, a repository, a service writer,
curation copy-forward rules and its own merge-conflict kind
(`bundle_self_containment`). ADR 0002 D15 chose its shape and the reasoning
holds:

> A bundle (console + game) is its OWN product because it is bought, priced and
> identified as one thing, often with its own GTIN. Its components are recorded
> so comparison can decompose it.

Three consequences worth stating, because each is a question somebody will ask:

- **A bundle's price is its own price and its stock is its own stock.** Neither
  is derived from its components. That is why no pricing, cart, inventory or
  order module knows bundles exist, and why "price is not the sum of its parts"
  needs no code — the sum is never taken.
- **There is no `is_bundle` flag.** The rows ARE the fact. `detectRelation`
  reads `hasBundleComponents` and answers `bundle` whatever the title says.
- **The dominant live-code treatment of the word is a REFUSAL.**
  `bundle_mismatch` and `multipack_mismatch` are `MATCH_BLOCKERS` members, and
  `match_decisions_blockers_auto_check` makes an automatic match carrying one
  unrepresentable. A bundle can never be merged into its own component.

### What #367 line 144 adds

One thing: **composition may never become a variant axis.**
`PRODUCT_TYPE_COMPOSITION_AXIS_KEYS` (twelve keys — `bundle_components`,
`bundle_contents`, `bundle_items`, `box_contents`, `in_the_box`, `kit_contents`,
`included_items`, `includes`, `contains`, `contents`, `components`,
`component_variants`) joins `RESERVED_OFFER_FACT_KEYS` and
`PRODUCT_TYPE_COMPATIBILITY_AXIS_KEYS` in
`PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS`, which renders two CHECKs:
`product_type_fields_variant_axis_check` (an operator drafting a schema) and
`native_listing_variant_axes_forbidden_key_check` (a seller authoring a listing).

This is ADR 0007 D8's fitment rule applied to composition. The failure it
prevents is the same one, in the same direction: an axis named after what a
product contains multiplies one bundle into one variant per thing inside it,
which is the 400-SKU explosion D8 refuses for a brake pad. The keys stay
DEFINABLE — "what's in the box" is a good product-scope specification — and what
they may not be is an option row.

**`pack_count` is not among them and the absence is load-bearing.** ADR 0002 D15
makes a multipack a variant carrying exactly that axis, so forbidding it would
make every six-pack-and-single pair unrepresentable.
`product-type-schema.test.ts` asserts it, with the composition keys' presence
beside it as the control — without that, dropping every composition key would
leave the `not.toContain` green.

---

## Services and digital goods are excluded, and the exclusion is not new

**The important qualifier first.** Every wall below was already true of this
repository. Nothing here builds a new refusal. What line 144 asks for is the
difference between an accident and a decision, and the difference is that each
wall is now named, mapped to the commerce type it excludes, and pinned by a test
whose failure message says which ADR is being relaxed.

The walls, each measured rather than assumed:

| Wall | Where | What it excludes |
|---|---|---|
| A checkout with no destination is refused | `destinationFromInput` throws `'A checkout needs a delivery destination.'`; `CheckoutDestination`'s three branches are all places | Anything with nowhere to be sent |
| A placed order carries a real postal address | `orders` takes `addressColumns('shippingAddress')` — recipient, line 1, city, postal code, country all NOT NULL. `optionalAddressColumns` exists and `draft_orders` uses it, so this is a choice. Even collection satisfies it, by snapshotting the pickup location's own address | Anything not delivered to a place |
| Exactly two fulfilment shapes reach an order | `checkout.service` throws rather than casting when a group is neither pickup nor shipping, explicitly so a third kind cannot write an order with a fabricated address | A third, non-physical fulfilment |
| Every order line is a catalog variant, in whole units | `order_items.variant_id` and `.quantity` NOT NULL, quantity CHECK `> 0`; no duration, unit-of-measure or sold-by column exists anywhere | Labour, time, metered supply |
| Completion is physical movement | `ORDER_STATUSES` and `SHIPPING_METHODS`, both CHECK-bound; no member means "the bytes were sent" or "the work was performed" | A non-physical completion |
| Condition describes an object | All nine `ITEM_CONDITION_KEYS` members; a CHECK on `order_items` | Anything with no condition |
| Tax is the goods place-of-supply rule | `rateMatchesRegion` reads the shipping country, region and postal code and nothing else. No billing country, residence or other consumer-location evidence is read anywhere | A digital supply, whose place of supply is the consumer's location |

And the two facts about representation, established by walking rather than by
recall: **nothing in the repository delivers a non-physical item** — no download,
licence key, redemption, entitlement or activation code exists in any table,
type, DTO or migration in the schema's whole history — and **nothing represents
a service sold to a buyer**: no duration, no schedulable resource, no
unit-of-measure, no appointment. `services/retail-service-requests/` is a
post-sale remedy queue and models nothing sellable.

### Where the repository already said so

Each excluded type cites an existing statement, which is why the list is five
members rather than an imagined taxonomy of everything a marketplace could sell:

- **`stored_value`** — `CHANNEL_ENTITY_POLICY.gift_cards` is `never_synced` for
  the reason `not_modelled_by_mercaria`, with the note *"Mercaria has no gift
  card record, so there is nothing for one to be imported into."*
- **`digital_good`, `stored_value`, `event_admission`** — `digital-goods`,
  `gift-cards` and `tickets` appear in this repository only as EXCLUDED category
  slugs on the guest-P2P bounded scope. No category with any of those slugs is
  seeded anywhere.
- **`consumer_subscription`** — the subscription machinery that exists is #89's
  merchant plans, Mercaria billing a merchant for its own software, which is why
  `merchant_subscription_plan` and `merchant_subscription_tier` are named as
  FORBIDDEN inputs by the comparison and supplier-preflight domains.
- **`service`** — ADR 0007's own open item, now closed.

### The one thing this cannot hold, stated rather than glossed

**Nothing stops a merchant mislabelling.** A category slug is free text and a
listing title is a seller's own words; a `digital-goods` category or a "PDF
ebook" listing is a lie no constraint can see, and the order would take an
address, charge a card and sit at `paid` with nothing delivered. That is a
moderation and taxonomy-governance question, not a schema one, and pretending a
column solved it is what the next section is about.

---

## Why there is no `commerce_type` column

The obvious spelling of this decision is a discriminator on `categories` or
`listings` whose CHECK admits one value. It is refused, for two reasons.

**The absent column IS the enforcement.** This is `canonicalCatalog.ts`'s reason
for refusing an `is_bundle` flag and `services/analytics/`'s for refusing a
property bag. A column with one legal value answers a question that has one
answer, and the moment a second answer is wanted the column is already there to
receive it — with no ADR amendment, because widening a CHECK looks like ordinary
schema work. So `commerce-type-exclusion.test.ts` fails the build if a
`commerce_type`, `product_kind`, `goods_type`, `listing_kind` or `item_nature`
appears.

**And it would not do the job it appears to do**, per the mislabelling paragraph
above. What CAN be held is the half that matters — that Mercaria's own model
never grows a REPRESENTATION of an excluded type by accident — and that is what
the gate holds.

---

## Future types: a procedure, not an extension point

*"Non-standard future commerce types"* invites an open `type` column, a
`metadata` bag or a plugin seam. This repository refuses those and has written
down why more than once: `services/analytics/` has no property bag because an
open bag is the one mechanism by which something reaches production unreviewed,
and `services/payments/redact.ts` is an allow-list because a deny-list is correct
only until the provider adds a field. ADR 0007 D14 already bounds JSONB to three
named uses.

So the future is a procedure. `COMMERCE_TYPE_PREREQUISITES` is a CLOSED
nine-member tuple, each member naming one of the walls above:

`delivery_destination` · `order_address_snapshot` ·
`fulfilment_completion_signal` · `entitlement_delivery` · `inventory_semantics` ·
`tax_place_of_supply` · `withdrawal_and_guarantee_terms` · `condition_semantics` ·
`pricing_basis`

**To admit a commerce type:**

1. Add it to `MERCARIA_COMMERCE_TYPES` and remove it from
   `EXCLUDED_COMMERCE_TYPES`. `tsc` now demands a disposition; the disjointness
   test demands you not do both.
2. Move the exact-membership assertion in `commerce-type-exclusion.test.ts`. It
   is `toEqual`, not containment, precisely so this is a deliberate line in the
   diff.
3. Discharge every prerequisite the type's old disposition named, in the same
   change. Because the vocabulary is closed, a type cannot be admitted by
   inventing a reason it needs none of them.
4. Remove its detector, and amend ADR 0007 D15.

Admitting a type therefore disarms its own detector — which is the intended
shape. `~/Oxy/AGENTS.md` §Gates: *a gate that pushes you toward the hazard is
worse than no gate; ask what the cheapest green is.* Here the cheapest green is
the decision itself, made where a reviewer sees it.

`inventory_semantics` is the prerequisite most likely to be waved past, so it is
worth stating: `product_variants.inventoryTracked = false` yields a
permanently-in-stock variant with a NULL published quantity. That is close to
what a service or a digital good needs and is **not the same statement** — it
says the count is unknown, not that counting is the wrong question.

---

## How the gate is measured

`commerce-type-exclusion.test.ts` is a whole-tree absence scan, which is the
shape most likely to be quietly vacuous. Its controls, and what each one caught:

- **The population is deliberately the whole tree**, and the file says so.
  `docs/isolation-gates.md` §"What does close it" is about a gate whose
  population is one DOMAIN; that hazard does not apply, because the decision is
  that no module anywhere may introduce these.
- **Per-root floors, never one total** — `backend/src` and `shared-types/src`
  break independently — plus a per-root top-level DIRECTORY floor, because a lost
  subtree does not always move the file floor. `shared-types/src` is flat and its
  directory floor is 0, stated rather than omitted.
- **A separate "read real source" floor**, because a reader handing back `''` for
  every module produces the same module count and no line to match.
- **A mutation victim per scanned DIRECTORY, not one per gate**, per
  `docs/isolation-gates.md`. Thirteen units; each plant test also asserts the
  victim is in the swept population, which is the half a synthetic probe can
  never test, and asserts the victim was clean BEFORE the plant.
- **Each detector mutated SEPARATELY.** Measured: breaking the `service`
  detector's pattern turned **thirteen** tests red, one per unit, and no other
  detector's.
- **A comment control per detector**, because a docblock naming what a module
  refuses to do is exactly how this repository documents a prohibition — a scan
  that kept comments would report every wall as a breach of itself.
- **Stripper controls**, because a stripper that ate too much would make every
  absence pass vacuously.
- **The exemption is asserted to exist AND to still match.** Measured: emptying
  the exemption set turns six tests red across three detectors, which is also the
  proof that the scan reaches `shared-types/src` at all.

Four mutations were run against the finished gate:

| Mutation | Result |
|---|---|
| Break one detector's pattern | 13 red, all in that detector |
| Narrow `SCANNED_ROOTS` to one root | 2 red — the `assertEachOf` floor and the units assertion, independently |
| Plant a real violation on disk in `cart.service.ts` | 4 red, naming file and line |
| Empty the exemption set | 6 red across 3 detectors |

The detectors are keyed on IDENTIFIERS rather than words, and each one records
what it is not looking for. That is not fastidiousness: `digital_storage` is the
unit family every RAM and storage attribute is measured in, `*.service.ts` is
every module in `src/services/`, `entitlement_grants` and
`merchant_subscription_*` are #89's SaaS billing, `booking` is a Moovo courier
booking and the accounting sense of booking a ledger transaction, `reservation`
is an inventory hold, and `ticket` is a support ticket, an Expo push receipt and
Portuguese for average order value. A gate that detected those would have its
cheapest green in deleting it.
