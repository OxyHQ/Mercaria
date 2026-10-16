# The canonical product page (#71)

One page for one product and every eligible way to acquire it — Mercaria's own
sellers, the brand's official store, ordinary retailers, refurbished units and
somebody's used copy — without any of them being mistaken for another.

Code: `services/product-page/` (5 modules), `db/productPage/productPageRepository.ts`,
`controllers/product-page.controller.ts`, `routes/product-page.ts`,
`middleware/product-page-schemas.ts`, `@mercaria/shared-types` `product-page.ts`,
`@mercaria/ui` `OfferConditionBadge` / `OfferLabelBadge` / `formatSourceMoney`,
and the storefront's `app/(app)/p/[handle].tsx` plus `components/product/`.

Binding dependencies: #56's canonical identity, #57's offer model, #55's
verified relationships, #61's measured reads, #68's freshness, #74's ranking,
#76's review scopes, #78's price history, #90's condition taxonomy.

**NO new tables and NO migration.** #61 measured the canonical graph at a
million offers and adopted no projection or materialized view; this page is
composed at request time from the reads that measurement covers.

---

## What this domain adds, and what it deliberately does not

It adds a COMPOSITION and three decisions: the partition (one offer, one
group), the withheld-offers branch, and the outbound handoff to #67.

It adds no ordering, no scoring, no eligibility verdict, no currency default and
no write. Every one of those belongs to a domain that already owns it, and
`services/product-page/__tests__/product-page-isolation.test.ts` fails the build
if a module here starts to reach for one — including the STOREFRONT files, which
have no test runner of their own (#92's precedent: the scan lives where a runner
exists).

## Why the composition is server-side

A client could fetch the ranked ids from `/offer-comparison` and the offer rows
from `/offers` and join them. It would be joining two different moments, and the
failure is silent: `/offers` is a keyset page in a DIFFERENT order (cheapest
first, #57's contract), so a ranked offer outside its window has no row and
renders as nothing at all. The shopper sees a comparison with holes in it and
nothing anywhere says so.

`rankOfferComparison` already returns both halves — the ranked entries and the
`Offer` DTOs behind them. Serving them together is the only place the join
cannot be wrong, and it is also where the seller identities an offer row needs
are resolved: an offer names a merchant id or a listing id, and resolving either
per row from a client is an N+1 over the one thing a popular product has a lot
of.

## The partition: one offer, one group

`ProductPageOfferGroupKey` partitions the served rows. CONDITION is the primary
axis, because #90's rule is that new, refurbished and used may never blend on
one price line; verified official standing then splits the `new` segment, which
is #71's groups 3 and 4.

| Group | What lands in it |
|---|---|
| `official_direct` | condition `new`, on a channel #55 verified as the brand's own |
| `new_retail` | condition `new`, everybody else |
| `open_box` / `refurbished` / `used` / `for_parts` | #90's remaining segments |
| `condition_unknown` | the source published no condition |

Three consequences worth stating, because each is a case somebody will want to
"fix":

- **An official store's REFURBISHED offer is under `refurbished`, not
  `official_direct`.** Apple's certified refurbished store is the case that
  makes it matter. The badge still travels on the row; the segment is what a
  shopper reads as "this is new".
- **An `authorized_reseller` is NOT `official_direct`.** #55 keeps the brand's
  own channel and a reseller the brand authorised as separate kinds with
  separate badges. Merging them here would undo that in the one place a shopper
  actually reads it.
- **`condition_unknown` exists and is never folded into `new_retail`.** Reading
  an absent condition as new tells a shopper an unlabelled feed item is
  factory-sealed — the coercion `deriveOfferCondition` already refuses one layer
  down.

A HIGHLIGHT is a POINTER — an offer id plus the #74 award that earned it — never
a copy of the row. That is #71's "must not duplicate the same offer in
misleading ways" as a shape rather than a review comment: the row renders once,
in its group, and the highlight names it. Highlights are exactly the COMPARISON
labels (`OFFER_LABEL_KIND`); standing labels are badges on their rows, because
"official direct store" repeated as a highlight for each of a brand's four
channels is a list nobody can read.

### `cheapest_new` is a #74 label, added by this issue

#71 asks for a "cheapest new offer" beside its "best overall". A page that
picked one itself would be running a second comparison — outside the versioned
policy, attributable to no impression, unreproducible from an operator trace. So
it is awarded where `cheapest_used` already is: `services/ranking/labels.ts`,
lowest KNOWN item price within one condition segment, taken from the tie-broken
order. Like every label it is awarded FROM the ranked order and is never a term
in the score.

`OFFER_LABEL_KIND` was added in the same change. #74 documented the
comparison/standing distinction from the start and no code could read it;
deriving it from a label's spelling (`cheapest_*`, `best_*`) would be a string
rule that rots the first time one is renamed.

## Withheld is not empty

`ProductPageOffers` is a discriminated union whose withheld branch has no rows,
no policy and no currency to read. `CANONICAL_OFFER_COMPARISON` is a separate
lever from `CANONICAL_READS` precisely so withdrawing price comparison during an
incident does not take product identity down with it (#60 feature flags 2 and
3) — and the union is what stops that reading as a product nobody sells.

Three distinct states, three distinct sentences:

- **withheld** — "price comparison is temporarily unavailable here";
- **available, no rows, `excludedCount > 0`** — "we know of offers and none can
  be shown right now";
- **available, no rows, `excludedCount === 0`** — "no current offers".

`excludedCount` is the COUNT and never the list. `/offer-comparison` ships every
exclusion with its reasons and it is right that it does — "why is my offer
missing" is a seller's question and that surface exists to answer it. A
shopper's page carrying it would publish one seller's refusal to every other
seller's customers.

## The outbound handoff, through #67

**#37's outbound redirect (`/out/:token`) is built** (#67, `services/outbound/`),
and `resolveProductPageOutbound` hands off to it: the `outbound` branch carries
a MERCARIA path (`redirectPath`) by TYPE, never a merchant URL. Two
alternatives stay refused, for the reasons that shaped the redirect itself:

- **Linking straight to `offer.destinationUrl`** asserts at RENDER time what
  only a click can establish. #68 built `assertOfferOutboundEligible` precisely
  because a buyer leaves a product page open for an hour, and the offer that was
  current when it rendered is the one that is not current when they finally
  click. It would also discard the commercial relationship an `affiliate` offer
  exists under, silently and with no error anywhere.
- **Deciding the destination here** would be a second place answering where
  Mercaria may send a browser — the shape an open redirect takes. This module
  mints a token naming the OFFER and knows nothing else; every revalidation,
  every right and every host comparison happens once, in `services/outbound/`.

What the page always shows is everything a shopper needs in order to DECIDE:
the merchant, the channel, the price in both currencies, the delivery facts,
the condition, the availability, how recently Mercaria checked, and the
destination HOST — disclosed alongside the redirect, not instead of it. A
hostname is a disclosure (#67 rule 5), not a link — it cannot be followed by
accident and cannot carry tracking parameters, because it is not a URL. With
`OUTBOUND_REDIRECT_ENABLED` off, `resolveProductPageOutbound` falls back to
that host-only disclosure, exactly as it did before #67 shipped.

`ProductPageOutbound`'s external branches carry no variant id and no listing id,
which is #71 acceptance 3 on this surface: there is nothing an add-to-cart call
could be handed. The native branch carries both, and the switch is on the
DERIVED checkout verdict — so a native offer never gets an outbound branch
either, whatever it happens to hold.

## Identity, redirects and configurations

- **A merged product's old handle resolves to its winner** (ADR 0002 D12), and
  the page SAYS so: `redirect` names the requested handle and the canonical one,
  and the client replaces the URL. The HTTP-level 301 and the `rel=canonical`
  tag are #75's, which owns public routing and SEO. There is deliberately no
  `reason` enum — a merge chain is the only way this arises, since aliases are
  search input and never identity, and a one-member vocabulary is a value nobody
  can act on.
- **A configuration that is not this product's is REFUSED**, never ignored.
  Ignoring it would silently widen the page to every offer, which is #71
  acceptance 4 failing in the direction nobody notices.
- **A variant-scoped page is a different READ**, not a filtered one: the
  comparison is scoped to one canonical variant, so it cannot contain another
  configuration's offer. On a PRODUCT-scoped page every row names its own
  configuration instead.
- **`ProductPageVariant` is a projection**, not `CanonicalVariant`: a
  forty-configuration product would otherwise carry forty copies of every
  identifier, image and provenance row for a control that renders a name. Its
  `offerCount` is ABSENT on a withheld page rather than zero — the withheld
  rule, one level down: a zero beside every configuration answers the offers
  question the page is not answering.

## Seller identity spans two systems

An EXTERNAL offer names a canonical merchant and a storefront; a NATIVE offer
projects a listing whose owner is a Mercaria store or a person with an Oxy
account (#92). `ProductPageSeller` is a union with no common `id` field — the
`CommerceActor` device — so a person's Oxy id can never be rendered into a
merchant route by a template that reached for `seller.id`. `unknown` is a real
member: a deleted store or an unresolvable merchant names NOBODY rather than
naming somebody wrong.

The Oxy profile read fails OPEN: a person whose profile does not resolve is a
`native_person` with their account id as the display name. A comparison that
500s because an identity service was slow is a worse product than one that shows
a seller by their handle.

`marketplaceSeller` is carried from the offer's own DERIVED `sellerRole` (ADR
0002 D8) rather than recomputed: comparing the two merchant ids in a second
place is a second answer to "is this a marketplace offer", and the pair can only
disagree in the direction that mislabels who a buyer's warranty is with.

## The rollout levers

| Lever | Effect on this page |
|---|---|
| `CANONICAL_READS` | `off` and `shadow` are both a 404; `on` serves |
| `CANONICAL_READ_COHORTS` | the cohort check, with the PRODUCT in hand |
| `CANONICAL_OFFER_COMPARISON` | decides the offers half alone (withheld branch) |

**This page adds no lever of its own.** The MOUNT is behind
`CANONICAL_PUBLIC_ROUTES_ENABLED`, the same blunt lever `/canonical-products`
sits behind — a deployment that has withdrawn the public canonical surface must
not keep answering here — and the mode gate lives in the HANDLER rather than in
`requireCanonicalReads`, for #70's reason: `shadow` means compute the
canonical answer AND the listing-first one and record the comparison, which a
middleware that returns first can never do. `services/backfill/read-mode.ts`
named this page as the second surface that would do it, and
`services/product-page/shadow.ts` is that module.

**The cohort check runs HERE and this is the first handler that does.**
`read-mode.ts` splits mode from cohort deliberately: the middleware cannot
answer a cohort question because it has not loaded the object. A product with no
category is refused while cohorts are non-empty, which is the documented
fail-closed direction.

### What the shadow comparison measures

The count of ELIGIBLE OFFERS the canonical page would have served, against the
count of ACTIVE NATIVE LISTINGS attached to the product's configurations. The
second comes from `native_listing_links` — a DIFFERENT route from the `offers`
rows the page serves — because a shadow comparison measuring the same table
twice would be a check that cannot fail.

Overlap is deliberately NOT measured, for the reason #70's shadow gives about
the same join: a listing reaches a canonical product by two unbatched routes
that are not the same set, and a number computed the cheap way would be worse
than none because a rollout decision would rest on it. The two counts are not
the same kind of thing either — one listing can produce several offers — so the
load-bearing signal is the ZERO agreement: which of the two found nothing.

## Analytics

The controller emits `product_page_view` (after the 404 guard, the
`listings.controller.ts` rule) and one `offer_impression` per SERVED offer
carrying `rankingPolicyVersion`, exactly as `offer-comparison.controller.ts`
does.

It emits none of `variant_selected`, `offer_expanded`, `offer_selected`,
`external_outbound_click`, `save_action`, `alert_action` or `sell_yours_entry`.
Every one is a fact only a browser knows — a control was pressed, a row was
expanded, somebody navigated away — and **the storefront has no analytics
client**. Deriving them server-side would be fabrication: a variant-scoped READ
is a deep link as often as it is a selection, and counting one as the other
makes `variant_selected` a number nobody can act on. They belong to #111 with
#107's and #109's client facts.

## Accessibility

- The variant selector and the intent picker are RADIO GROUPS with `checked`
  state, so a screen reader announces "2 of 5, selected" rather than five
  unrelated buttons (#71 UX rule 2).
  Named configurations and catalog axes use Bloom's `RadioGroup variant="chip"`:
  one tab stop, mirrored arrow navigation, Home/End, disabled-option skipping
  and non-toggle Space/Enter activation. Availability remains visible text.
  Bloom owns those interactions; the page retains selection in its URL without
  pushing a history entry or remounting its gallery.
  The listing gallery prepends the selected variant's assigned photos, retains
  common product photos, and excludes photos assigned to other configurations.
  Only `source: 'variant'` establishes an assignment; a `listing_fallback` does
  not claim every product photo. The shared variant-resolution contract remains
  unchanged. Browser checks cover retained gallery identity at 390px and 1440px.
- Every badge is text on neutral chrome — never colour alone (#71 UX rule 4,
  #90 policy rule 3), and never a colour scale, which would additionally read as
  a quality verdict on a correctly-labelled for-parts item.
- An unavailable external action is a DISABLED control with
  `accessibilityState`, whose label names the destination host, so the
  transition out of Mercaria is announced before it could happen (#71 UX rule 3
  — and today it cannot happen at all).
- Each group renders `COLLAPSED_ROWS` rows behind an explicit "show all" with
  `accessibilityState.expanded`. #74's comparison is ONE ranked page with no
  cursor — that is its contract, not an oversight — so there is nothing further
  to paginate to; what this bounds is how much of the page is built before
  somebody asks for it.

## Price history

`PriceHistoryPanel` renders #78's own accessible summary and the gap/uncovered
ranges, in ONE named condition segment. A visual chart is deferred deliberately
rather than approximated: a connecting line IS an interpolation claim, and #78
returns gaps as ranges precisely so a renderer must decide what to do with them
rather than inferring one from a missing x value.

An error renders nothing at all, and so does a range that is entirely
`uncovered` — the ordinary answer in a currency `PRICE_HISTORY_SERIES_CURRENCIES`
does not list. That is a fact about Mercaria's rebuild queue, not about the
product, and an error box or a "not built" line would advertise a chart nobody
built.

## Links that are NAMED rather than followed

The brand and the product family are rendered as TEXT. There is no
`/product-families/:id` route in the storefront yet (#84 owns that page), and
#71 asks to link an identity "to its public page **when available**".
`/brands/[handle]` DOES resolve now that #72 shipped it, and the page still does
not link there — its `brand` is a vendor LABEL (the store or seller name), not
the canonical brand entity, so linking needs a canonical brand handle on the
product projection rather than a route swap.

A MERCHANT is linked, as of #252. `/merchants/[idOrSlug]` shipped with #73, so
the one reason these identities were named rather than followed expired for
merchants — and the page already linked every other seller kind
(`/stores/:handle`, `/sellers/:oxyUserId`), which left an external merchant as
the only seller a shopper could not navigate to. Both places the page names a
merchant follow it: the offer row's seller line and each of a brand's verified
channels. The handle is the `slug` rather than the id, because `merchants.slug`
is `not null` and unique FOREVER and a merged tombstone keeps its slug and
redirects (ADR 0002 D12), so a link taken today survives a merge tomorrow. The
verified-channel standing does NOT travel with the link: the merchant page
re-derives what #55 currently holds, rather than asserting a badge from a
caller's word.

A dead link used to be worse than the name, because nothing caught it:
`typedRoutes` was ON but inert, so `router.push('/merchants/apple')`
type-checked, shipped, and failed under a shopper's thumb as "This screen does
not exist". This issue proved it — a "Report a problem" control shipped pointing
at `/settings/support`, which is not a screen. **#330 closed the mechanism**:
`.expo/types/router.d.ts` is generated inside every app's `typecheck`, so the
compiler now rejects a route that does not exist.

**#456 measured that closure and found it PARTIAL.** The compiler answers
completely for the OBJECT form — a wrong `{ pathname }` is `TS2820`. For a
TEMPLATE LITERAL it answers only when no dynamic route sits above the mistyped
segment: `` router.push(`/products/wizrd/${draft.id}`) `` exits 0, because
`/products/[id]` contributes `` `/products/${SingleRoutePart<T>}` `` and that
type's multi-segment exclusion cannot discharge against the unresolved
`${string}` a template contributes. Since the common typo is a deeper segment of
an otherwise-real path, the retirement below leaned on a guarantee weaker than
it was read as. `scripts/validate-route-targets.mjs` (`validate:route-targets`,
named in `ci.yml`) now resolves every target's static skeleton against the real
route tree in all three apps, which is what restores the cover WALL 6 gave up.

WALL 6 used to be that gate — it walked the real `app/` tree and resolved every
literal `router.push`/`replace` target from this issue's files. #330 retired the
resolution half: generating `.expo/types/router.d.ts` before `tsc` makes the
COMPILER answer route existence, across all three apps rather than this page's
twenty files, and without a resolver of our own to get wrong (WALL 6's own two
bugs both failed permissive — a `buildHref` helper was invisible to it, and an
interpolated query string read as a wildcard). What the compiler cannot check is
that it was given the union, which is
`src/__tests__/typed-routes-armed.test.ts`. WALL 6 keeps the question that was
never about route existence: whether the page LINKS a merchant at all (#252).

Reporting the PRODUCT DATA goes to feedback rather than to abuse reporting, and
the vocabulary is the reason: `ABUSE_REPORTED_TYPES` is
`listing | review | seller | store` and has no `product` member. A canonical
product is Mercaria's own catalogue record — a wrong specification is a data
correction (#59's queue), not somebody's content to be moderated. Reporting a
LISTING is on that listing's own page, where `POST /reports` has a type for it.
The listing's **More actions → Report product** menu uses Bloom's dropdown and
the shared abuse-report dialog with `reportedType: 'listing'` and the displayed
listing id. It is available in the desktop merchant header and beside the
mobile Save/Share controls, including secondhand listings. Guests see the
existing Oxy sign-in action; no report is submitted without authentication.
Store policies and **Report store** remain in the store page's own menu.
**Contact store**, also available from the store menu, reads the store's public locations from `/public/v1`, then
uses the official GoWay SDK to show each place's published phone, email,
website and formatted address in the shared Bloom marketplace sheet. Opening
it refreshes both reads and checks the current active place's trusted
`commerce.mercaria.store` backlink against the location ID. A revoked link
shows no contact facts; failures offer retry, not stale contact details.
Phone/email links and copy controls use the published values. Neither a
private admin profile nor an Oxy account is a contact source. Stores without
published locations and person-to-person listings have no contact entry.
The browser regression varies only public location/GoWay response metadata;
product images continue through actual Oxy delivery. This is not evidence of
a production merchant's place publication or contact-edit workflow.

## Specifications on a listing

The listing detail route also returns `catalogIdentityByVariant` for exact active
native-to-catalog attachments. It omits revoked or superseded links, foreign
native variants, and catalog products or configurations outside the shared
shopper-visible status set. This detail-only projection carries public IDs and
the category, never matching evidence. A product-level barcode match alone
cannot establish which configuration's specifications belong to an option.

`/products/[id]` uses that mapping for its Specifications accordion, sharing the
attribute registry queries and `SpecificationGroups` with the canonical page.
The section starts collapsed, matching Shop's public product accordion.
Selecting another option changes the value query keys without remounting the
gallery. Loading and failed reads hide the previous option's facts; retry uses
the current identity. An unmapped option or a successful empty result omits the
section. Product and configuration scopes remain separate, and unavailable
definitions retain the existing label fallback notice.

The real PostgreSQL product-page suite checks the anonymous listing route and
attachment visibility. Browser coverage at 390 and 1440 pixels checks delayed
reads, failure/retry, unmapped options and a retained gallery element using
isolated attribute data; it does not demonstrate imported product images.

## Reaching the page

`/products/:id` — the listing page — gains ONE control: "Compare all offers",
shown only when that listing resolves to a canonical product. A link on an
unmatched P2P listing would lead to a page that does not exist for it, and the
listing page itself is otherwise untouched (#71 acceptance 7). #75 owns the full
public-route migration; this is what makes the comparison reachable in the
meantime.

That one link is checked by the COMPILER like every other, and by WALL 6 for
the separate question of whether the page links a merchant at all (#252) — and
by NOTHING else in the gate: putting a file this issue does not own through the
other five walls is how a gate starts firing at whoever edits it next, and a
gate that cries wolf is the one somebody deletes.

## Four requirements answered by a statement rather than a control

- **Language.** The page resolves a MARKET (`?market=`) and a display CURRENCY
  (a signed-in buyer's stored preference, else `?currency=`), and it resolves no
  language: each offer carries its own `language` from the source that published
  it, and the page's copy comes from the app's i18n. Filtering offers by
  language would remove a perfectly buyable offer for being described in another
  one, which is not what "resolve language consistently" can honestly mean here.
- **Merged status.** A merged product's page is never rendered — its handle
  resolves to the winner and the URL is replaced — so there is no merge notice
  to show. The redirect IS the statement.
- **Merchant rating.** #71 offer row 7 asks for "merchant rating OR relationship
  badge with clear meaning", and the badge is what this page renders: a rating on
  an external merchant would need a #76 aggregate the merchant does not have,
  and a NATIVE offer names no merchant at all until #84 links native stores to
  them (#74 records the same gap for its own signal).
- **Sharing.** #71 actions 6 asks that the canonical product URL be shared
  rather than an ephemeral offer URL, and that holds by construction: the page's
  own address is the canonical one and a redirect replaces it before anybody can
  copy the old one. There is deliberately no decorative share button.

## Seams left to their owners

Each is a named contract that fails closed, not a stub that lies:

- **#41** — "Sell yours" and nearby/pickup offers. #93 publishes collection
  points now, and `best_nearby_pickup` is still never awarded because this page
  accepts no viewer coordinate to measure from, so the group would always be
  empty; the control is ABSENT rather than rendered as a button that opens
  nothing.
- **#79 (epic #39) — CLOSED.** Price alerts shipped and closed #80's
  `ProductSavePriceAlert` seam: it is now always `supported: true`, so the
  saved-list affordance exists. This
  page still has no "watch this price" control of its own — that entry point is
  #71's own seam, not #79's.
- **#80 — CLOSED.** The canonical page reads the existing authenticated
  `GET /product-saves/:canonicalProductId` endpoint and toggles explicit save/
  remove operations. Its query key includes the Oxy account id. A pending read
  disables the action; a failed read offers Retry instead of assuming unsaved.
  Successful writes refresh the product and listing contexts and Saved list.
  Guests open Oxy sign-in without issuing a save request.
- **#75** — public route migration, the HTTP 301, `rel=canonical`, structured
  data and the sitemap. `/products/:id` (the listing page) is untouched, which is
  #71 acceptance 7.
- **#111** — the storefront analytics client and the six client-fact events.
- **#73** — the brand page. This page links to `/brands/:id`; whoever builds that
  route owns it.
- **#95 / #96** — natural-language intent and grounded comparison.

### Review preview availability

Review previews distinguish a pending request, a failed request and a confirmed
empty result. The shared summary exposes loading and retry states in its own
locale bundles. Listing, canonical-product and 3D-product pages pass their own
query state and retry callback; product and listing feedback remain independent.
A failed background refresh retains the cached rating and preview cards with an
error notice. An initial failure never claims that the product has no reviews.

### Merchant return-policy reader

The listing page's mobile merchant header uses Bloom `Screen.header` so it stays
visible while the product scrolls. This follows the sticky merchant bar in Shop's
captured public product module. Bloom measures the header: document mode reserves
the web inset, and the existing native scroller reserves `useScreen().topInset`.
The desktop merchant header remains in the buy column. The `Screen` stays mounted
across breakpoint changes so the gallery and selected variant keep their identity.
Browser acceptance covers 390px English/Arabic, 820px English, keyboard navigation
after scrolling and a 1440→390→1440 resize with the same gallery node. On Pixel8a
in English/dark mode, the merchant name and Visit store action retain identical
bounds after two full swipes; tapping the pinned action opens the real store.
The product detail region also reserves
Shop's 32px mobile / 64px desktop bottom spacing before related sections.

The merchant menu's internal pages use incoming push/pop transitions measured
from Shop's public merchant bundle: 40% of the page width over 300ms with
`cubic-bezier(.32,.72,0,1)`, and a 150ms initial fade. `StoreMenuTransition`
uses Reanimated's bounded progress, mirrors direction in RTL, and skips motion
for reduced-motion users. The Dialog and header stay mounted. Its public
`useDialogFrame` API declares page changes so Bloom also morphs the mobile
bottom sheet's natural height; Mercaria does not measure or resize the panel.
Browser acceptance covers both directions, retained dialog identity, bounded
movement, mobile height interpolation, Escape focus restoration and reduced
motion at desktop English and mobile Arabic. On Pixel8a, the combined slide/fade
initially hid review contents inside nested ScrollViews. The three menu pages now
render ordinary Views: Bloom Dialog owns scrolling and natural-height measurement.
The complete animation reveals reviews on the device and the list scrolls to its
pagination controls. The cold-start body disappearance was traced to Reanimated's
settled-style synchronization: a delayed JS collection could restore the initial
height and opacity. The official 4.3.4 patch, with a rebuilt Android binary,
retains the body after cold starts in English and Arabic. Bloom's size morph and
Mercaria's slide/fade remain enabled. See [native animation runtime](native-animation-runtime.mdx)
for the isolated reproduction, compatibility exception and device evidence.
Close/Back and Follow/Share use Bloom's public
`header.left`/`header.right` slots, with stable memoized nodes. The navigation bar
stays fixed while the dialog scrolls policies and reviews; browser tests cover
desktop English and mobile Arabic with wheel input, and Pixel8a bounds are
unchanged from the first review to the pagination controls. Native
reduced-motion timing acceptance remains pending.

A selected connected-store offer exposes its published return policy through a
40px Bloom button and an opaque `MarketplaceSheet`, matching the policy action
in Shop's public product bundle. The complete authored body uses the existing
safe rich-text parser/renderer; plain text retains its line breaks. Empty
policies, person-to-person offers and Mercaria-retail offers do not inherit a
store policy. No return-window or free-return claim is inferred from prose.
Shipping remains hidden under the logistics boundary.

### Bundle navigation

Bundle navigation uses app-owned Expo links supplied to the shared UI. Included
components target the canonical product and exact configuration; recommended
packs target the listing and exact variant. Images, titles and the configurable
pack action expose real web anchors, including keyboard and new-tab navigation.
The add-to-cart action remains a button. A stale canonical selection removes
the component destination until the current configuration is confirmed, so an
old pack cannot be opened through a modified click while its new data loads.

### Related category discovery

Below the same-store shelf, “You might also like” uses the category's existing
`new` discovery signal and its server-serialized product cards. This is a
category-based selection, not personalized ranking. The current listing is
excluded; ratings, saved state, money and Oxy media come from that projection.
Missing categories and confirmed empty results add no section. Later pages keep
the first cards mounted, and a failed read offers retry without implying an
empty catalog or replacing the category with global results.

The shared `FeedGrid` auto-column option measures its container: two columns
and 16px gaps on mobile, fitting 220px-minimum columns with 32px gaps on desktop.
It works through native flex layout and leaves existing class-sized grids
unchanged. Live browser checks cover Oxy image delivery, navigation, exclusion
and responsive geometry in English/Arabic; pagination tests vary only read
responses built from the real local category DTO.

Product-card typography belongs to each text component. Do not place an absolute
`leading-[16px]` on the wrapping Pressable: native inherited line-height treats
that value as a multiplier, making 12dp text occupy 192dp before font padding.
Removing that inherited override retains each child's `text-xs` typography.
On Pixel8a, the title's measured bounds shrink from 504px to 48px; keyboard and
new-tab navigation also pass at 390px and 1440px in the browser.
