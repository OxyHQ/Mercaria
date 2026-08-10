# Commercial presentation (#129)

What a buyer is told about **who is selling**, **who is paid** and **what
rights come with the purchase** — on the product page, in the cart, at checkout,
on the order and in the guest portal.

Mercaria has three genuinely different commercial relationships and one
non-commercial one, and this domain exists so a person can tell them apart
*before* every purchase action:

| Mode | Who sells | Who takes the money | Native cart |
|---|---|---|---|
| `mercaria_retail` | Mercaria, with an approved partner fulfilling | Mercaria | yes |
| `connected_marketplace` | a merchant or a P2P seller | Mercaria, on their behalf | yes |
| `external_referral` | another retailer, on their own site | that retailer | **no** |
| `informational` | nobody — this is context | nobody | **no** |

## The mode is READ, never re-inferred

Every one of the four is already a fact somewhere else, and #129 adds no fifth
authority:

- **#57's `OfferKind`** says whether a destination leaves Mercaria.
- **#123's `retail_offer_bindings`** says which catalogue variant Mercaria sells
  itself. There is no `mercaria_retail` member of `OfferKind` — ADR 0002 D18
  reserves it for epic #116's own migration — so the live binding is what tells
  Mercaria's own sale apart from an ordinary native listing.
- **#123's `orders.commercial_role`**, tied to `seller_type = 'platform'` by
  `orders_commercial_role_seller_check`, says what a *placed order* was.

`deriveCommercialMode` maps the first two onto the mode and reads nothing else.
Its input type, `CommercialModeFacts`, has a field for each permitted input and
**none** for a margin, a commission, a marketplace fee, a merchant plan, a
referral code or a payment-provider preference — the `SourcingCandidateFacts`
device — so #129 ranking rule 3 and referral rule 2 hold because the derivation
cannot see them, not because it declines to look.

The cart's split is where this matters most in practice.
`resolveVariantCommercialPresentations` calls **`partitionRetailLines`**, the
exact function `checkout.service` calls, rather than issuing a second query that
means the same thing. "The product page and the till cannot disagree" is
therefore a property of the call graph: one place asks which variants carry a
live binding, and both surfaces go through it.

It is deliberately **not** gated on `config.retail.enabled`. A deployment with
retail entry switched off still needs to know a variant is retail-bound, because
the alternative is describing Mercaria's own stock as a sale by whoever owns the
listing row — the exact misattribution this domain exists to prevent, appearing
at the moment somebody pulls an incident lever. Checkout refuses such a line by
name (`retail_line_ineligible`) for the same reason.

## Nothing in the union has a common field

`CommercialPresentation` is discriminated on `mode` with no shared
`sellerLabel`, `price` or `id` — the `CommerceActor` / `OrderBuyer` / `CartOwner`
device. Every consumer must `switch`, so acceptance 2 (*`Sold by Mercaria` never
appears on an affiliate referral or a connected-merchant offer*) is a compile
error rather than a copy review. A marketplace seller's display name and
Mercaria's legal entity are different facts about different parties, and one
field holding both is how they get swapped.

Two accessors exist and they are not interchangeable:

- `@mercaria/ui`'s **`commercialSellerLabel`** has copy for all four modes and is
  what a screen renders.
- the backend's **`orderSellerLabel`** handles the two an ORDER can carry and
  **throws** for the other two. `orders.commercial_role` has exactly two members,
  so an order in either of the others is not a state the database can be in — and
  a quiet fallback would turn that impossibility into a blank seller on somebody's
  receipt.

## Where each surface gets its answer

| Surface | Field | Derived from |
|---|---|---|
| product page | `ProductVariantDTO.commercial` | live retail binding, per VARIANT |
| cart | `CartGroup.commercial` + `CartGroup.sellerKey` | same, batched over the cart |
| checkout summary | the cart group's own presentation | — |
| order list / order page | `OrderSummary.commercial`, `Order.commercial` | `sellerType` + `commercial_role` |
| retail order page | `Order.retail` | #126's role snapshot and promise trail |
| guest portal | the same `Order` DTO, and `sellerLabel` for the bounded view | as above |
| retail price | `GET /retail-offers/:canonicalVariantId` | #120's stored quote |

**The disclosure is on the VARIANT, not the listing.** A retail binding is keyed
on `product_variant_id`, so a listing can in principle carry some configurations
Mercaria sells itself and some it does not. A listing-level claim would have to
pick one answer for both, and the wrong half of that pick is `Sold by Mercaria`
over somebody else's stock. It also means switching a swatch can change the
disclosure, which is truthful rather than surprising.

**`Order.commercial` is derived from the STORED role, never from a live
binding.** A binding retired after the sale must not change what a receipt says.

**`CartGroup.sellerKey` is composed server-side.** A marketplace group's key is
`store:<id>` or `user:<id>`; Mercaria's own lines answer to the flat `platform`
key #123 put in the same namespace. A screen building the key from `vendor.kind`
and `vendor.id` would send `store:<id>` for a group Mercaria sells, and checkout
would answer *"no matching cart items"* to a buyer whose basket is full.

**Groups are split by commercial mode as well as by vendor.** A cart holding one
item Mercaria sells itself and one from the same catalogue owner has TWO groups
rather than one mislabelled card. `vendor` still names the catalogue owner — an
item's page link and thumbnail need it — and the seller a buyer reads comes from
`commercial`.

## Rendering #120's verdict, and the fourth state that is #129's

`docs/retail-pricing.md` assigns #129 *"`presentation` + `blockReasons` on every
quote"*. `GET /retail-offers/:canonicalVariantId?country=XX` is that reader.

It **reads a stored quote and never composes one.** Composing calls a supplier,
and a public route that did so would spend a provider call per page view, drain
#122's per-supplier lease on people who are not buying, and hand anyone with a
URL a way to exhaust it.

`findRetailCostQuoteForPresentation` is deliberately WIDER than
`findChargeableRetailCostQuote`: that one answers *may money move against this*
and filters `completeness = 'complete'`; this answers *what may a page say*, and
a quote that concluded `not_purchasable` is exactly the answer `blockReasons`
exists to give. Narrowing to `complete` would leave a blocked offer
indistinguishable from one nobody has priced, and those route differently — the
first states why, the second says nothing.

The destination fallback is **ordered, not combined**: a quote composed FOR this
market beats a destination-less one, and with no destination supplied only the
destination-less quote is eligible. A total composed for Germany is never shown
to somebody who has told Mercaria nothing.

`RetailOfferPriceStatement` is discriminated on `presentation`, whose three
quoted values are #120's tuple verbatim, plus `unquoted` — #129's own fourth
state, for the case #120 cannot have because #120 always has a quote in hand.
Money appears **only** on the two branches that may claim one:

```ts
| { presentation: 'exact_cost_only';   buyerPayable: Money; … }
| { presentation: 'starting_item_cost'; itemCostFrom: Money; … }
| { presentation: 'not_purchasable';   … }              // no amount property
| { presentation: 'unquoted'; reason: RetailOfferUnquotedReason }  // no amount
```

so *"the UI must not display a total the domain refused to certify"* is a type
error rather than a review note. `starting_item_cost` carries an ITEM cost and
not a total: `awaiting_destination` means shipping and tax are not yet knowable,
and a figure labelled as a total there is the claim that value exists to prevent.

`priceFinality` travels separately, verbatim from #121's determination —
`additional_charges_possible` does not block, and folding it into the price
statement would lose the difference between *charges may apply* and *we cannot
say*.

## "Confirming availability" (ADR 0004 D9.1)

The ADR states the rule in one sentence: customer-facing copy may call an order
*confirmed* only after every purchase order under it is accepted; between the
charge and acceptance the truthful state is *"payment received — we are
confirming availability with our fulfilment partner"*.

`deriveRetailOrderProgressStage` is a total function of the order's own two
status columns, and `paid → confirming_availability` is the case it was written
for. `processing → confirmed` because **D9.2 already binds a retail order's
`processing` to every purchase order being accepted** — so the acceptance fact
reaches this surface through a column that carries nothing else, and no purchase
order, supplier or procurement intent is read here at all. That is not
squeamishness about a join: those rows carry the supplier's identity and
Mercaria's wholesale position, and a projection that loaded them "to be safe" is
one field away from serving them.

`paymentStatus` is read for exactly one case the order status cannot answer: an
order at `pending_payment` whose payment already failed is not waiting for
anything, and telling a buyer it is leaves them watching a screen that will never
move.

**There is no `preparing` stage, and its absence is a statement about what
Mercaria can observe.** #129 order rule 4 names preparation as a step and #126
records `retail_fulfilment_intents` for it, but the Moovo half that would report
a package becoming ready is #157/#159 and is unbuilt. A `preparing` stage would
sit in every buyer's timeline and never advance.

## Two delivery statements, kept apart

`Order.retail` carries #126's `accepted` and `current` promises **separately**,
and neither substitutes for the other:

- **accepted** is what the buyer agreed to at checkout. Immutable, `guaranteed`,
  authored only by `mercaria_checkout`.
- **current** is what a source has said since. Absent means *nothing has been
  observed since checkout* — not *unchanged*, and showing the accepted window
  under a "current estimate" heading would be the silent rewrite #126 built an
  append-only trail to prevent.
- **`refreshFailing`** is a third fact again. A surface showing only the newest
  observed estimate would be confidently precise about a figure whose refresh has
  been failing for a day.

A window with only one end is rendered with only that end. #126 stores the two
bounds separately because a source may publish one, and filling the other in —
with the same date, with "or later", with anything — would be Mercaria inventing
half a promise.

`sourceRef` is dropped in the projection rather than filtered downstream: it is a
supplier quote id or a Moovo transport id and sits in `PROTECTED_COLUMNS`.

## The copy, and where it lives

The disclosure KEYS are in `@mercaria/shared-types`
(`COMMERCIAL_DISCLOSURE_KEYS`, twelve, matching #129 §"Content and legal copy");
the WORDS are in `@mercaria/ui` `lib/commercial-copy.ts` — the `condition.ts` and
`offer-labels.ts` arrangement. A stored disclosure key on a placed order must
keep resolving after a copy correction, which it cannot if the sentence is the
key.

**Which keys a presentation requires is decided once, server-side**, by
`commercialDisclosureKeys`. A screen renders that list and never composes its
own, which is what #129's *do not scatter legal role logic across individual
components* means in practice: an affiliate notice appears because the server
decided the offer needs one, not because a screen guessed from a destination URL.

An `affiliate` destination owes a paid-relationship disclosure and a plain
`external` one does not — that is the distinction #57's two kinds exist to make,
and deriving it from the kind rather than from a per-source flag is what keeps
the two from disagreeing.

**No colour scale.** Every chip is the same neutral shape and the words carry the
meaning — `ConditionBadge`'s reasoning, plus one: the four modes are not a
quality ranking (an external referral is not a worse offer, it is a different
contract), and a green/amber treatment would turn a disclosure into a
recommendation. #129 offer-detail rule 12 asks for accessibility labels that do
not rely on badge colour, and the simplest way to satisfy it is to have no colour
to rely on.

## What cannot reach a customer surface

`COMMERCIAL_FORBIDDEN_DISCLOSURE_FACTS` names eleven prohibitions as VALUES,
disjoint from every field this domain defines: the wholesale cost, the supplier's
identity, SKU, account and agreement, the procurement offer, the carrier account,
a provider's own rejection text, the referring partner and their commission, and
any Mercaria margin figure.

`commercial-presentation-isolation.test.ts` holds six walls with a vacuity floor
and a mutation self-test on every detector, and it scans the STOREFRONT as well
as the backend — the file that would put `Sold by Mercaria` over a merchant's
sale is a screen, and `packages/frontend` has no test runner
(`seller-identity-isolation.test.ts` made the same call for the same reason). It
also WALKS really-emitted presentations for every forbidden key, because a scan
proves what the source says and a walk proves what the wire carries: a spread of
a repository row would introduce every column at once without any of their names
appearing in the gate.

The gate's own positive control is that the walk really sees
`supplierFulfilmentDisclosureKey` — the one supplier word a buyer IS told — so
"no matches" cannot mean "walked nothing".

## OxyPay and FairCoin

Neither exists as a payment option, a placeholder, a teaser, a disabled row or a
feature flag, and the gate scans RAW source including copy because #129's
§"Future OxyPay copy boundary" forbids a *coming soon* string as firmly as a
provider branch. Stripe is the only implemented native rail; a future FairCoin
integration arrives through OxyPay under its own ADR.

## What #129 did NOT build, and why

Each is a named seam rather than a stub that lies:

- **The canonical product page, brand pages, merchant storefront pages and
  search** (#71, #72, #73, #70) — those surfaces are being built separately and
  consume `CommercialPresentation` as their contract. #129 supplies the
  vocabulary and the derivation; it does not build somebody else's screen.
- **Price alerts and watchlists** (#79, #81) — the same. #129 §"Search, alerts
  and watchlists" rules are contract requirements on those issues, satisfied by
  their reading this domain rather than inventing a second seller vocabulary.
- **The offer-mode analytics events** (#77's seam discipline) — #77 requires a
  bounded reason CODE before an event may be emitted, and the storefront has no
  analytics client at all. Emitting only the half that has codes would make the
  metric read a confident permanent 100%, which is the failure #77's `#106` seam
  note describes. This belongs with #111's rollout work.
- **A per-group checkout selector richer than `sellerKeys`** — #123's namespace
  answers the question and #129 uses it; nothing new was invented.
- **`mercaria_retail` as an offer KIND** (#116) — until that migration, a retail
  offer is not distinguishable in the `offers` table and the distinction
  materialises at the variant binding and on the placed order.
- **`preparing` as a progress stage** (#157/#159) — see above.
