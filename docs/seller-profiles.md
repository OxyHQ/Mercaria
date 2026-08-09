# Public P2P seller profiles (#92)

The reference for Mercaria's public seller surface. Code lives in
`packages/backend/src/services/sellers/`, `packages/backend/src/routes/public-sellers.ts`
and the storefront's `app/(app)/sellers/[oxyUserId].tsx`; the wire contract is
`@mercaria/shared-types` `seller-profile.ts`.

## The problem, stated once

Mercaria sells two ways. A native **store** is a Mercaria-local row with its own
handle, brand and policies. A **P2P seller** is a person — an Oxy account —
with no Mercaria-local identity at all: `seller_profiles` holds their
marketplace aggregates and deliberately holds no name, no handle and no avatar,
because those belong to Oxy.

That difference is not cosmetic. It decides where the follow relationship lives,
what a profile page may disclose, and what happens to the page when the person
changes their privacy settings, gets a trust restriction, blocks the viewer, or
deletes their account.

## Identity: a seller is followed as `oxy.user`

| | native `Store` | P2P seller |
|---|---|---|
| What it is | a Mercaria row | an Oxy account |
| Oxy id | only inside `members[]` | `Seller.oxyUserId` — the whole identity |
| Listing | `ownerType: 'store'` | `ownerType: 'user'` |
| Follow kind | `mercaria.store` (#24) | **`oxy.user`** (#26, #92) |
| Follow URI | `https://mercaria.co/stores/<id>` | `https://oxy.so/users/<oxyUserId>` |
| Registered by Mercaria? | yes — Mercaria owns the namespace | **never** |

`oxy.user` is a PLATFORM kind, seeded by Oxy's own migration and owned by no
application. Mercaria neither claims the `oxy` namespace nor calls
`registerFollowKind` for it — Oxy's registry would refuse
(`namespace_not_owned`), and registering a person under a `mercaria.*` kind
instead would SUCCEED and be far worse.

**Why that is unrecoverable.** A `follow_targets` row carries ONE kind and
`ensureFollowTarget` is idempotent on the URI, so whoever registers a URI first
fixes its kind permanently. A person registered under `mercaria.*` at a
`mercaria.co` URI has their Mercaria followers split from the identity every
other Oxy application already follows, and "follow once, every app knows" dies
for them with no repair short of a data migration.

`ensureFollowTarget` is called with BOTH `uri` and `localUserId`. Oxy's registry
derives the id from the URI (`^https://oxy\.so/users/([^/?#]+)$`) and refuses a
`localUserId` that disagrees, so passing both is a consistency assertion rather
than a duplication: a wrong pairing fails loudly instead of minting a target
pointing at the wrong person. `localUserId` is the dedicated `follow_targets`
column only `oxy.user` targets populate, and it is what keeps Oxy's optimized
account graph authoritative for user-to-user queries.

**No `metadata` is sent.** A target's display snapshot is refreshed only for the
application that PROVIDES it, and Oxy provides this one. Mercaria pushing its
own idea of a person's name and avatar would be a marketplace overwriting an
account's identity for every other Oxy surface.

### Mercaria stores no follow state

There is no follow table, no follow endpoint and no follower field on any DTO.
Follow state, counts, pending requests to a private account, optimistic UI and
the idempotence of a repeated tap all belong to `FollowTargetButton` reading
Oxy's graph. That is *why* the profile page and the product-page seller card
always show the same state — one source, two readers — rather than because
anything synchronises them.

A follower LIST is doubly refused: Oxy decides its own reverse-lookup policy for
`oxy.user`, and `SELLER_PROFILE_FORBIDDEN_FIELDS` names `followers`,
`followerIds` and `followerIdentities` so a scan fails the build if one appears.
Publishing who follows a seller would publish shopping behaviour.

## Visibility: derived, never stored

`services/sellers/seller-visibility.ts` is a pure function over the Oxy account
and Oxy Trust's verdict. This is the #57 `deriveNativeCheckoutEligibility` shape
and the deliberate divergence from `provider_accounts`' one-stored-verdict rule,
for the same reason: the inputs live in systems this domain does not own, so a
stored verdict would be a fourth authority able to disagree with all three — and
the place that must not happen is a page that keeps rendering somebody who has
just made their account private.

| Outcome | Trigger | What is served |
|---|---|---|
| `visible` | ordinary account, ordinary tier | identity, marketplace block, `p2p_seller` aggregate, Oxy Trust, listings |
| `private` | `privacySettings.isPrivateAccount === true` or `profileVisibility === false` | the state and its reason, and NOTHING else — not even the name |
| `restricted` | Oxy Trust tier ∈ `SELLER_TRUST_RESTRICTED_TIERS` | identity only; no listings, no counts, no aggregate, no trust figure |
| **404** | deleted, unresolvable, hidden from this viewer by Oxy, or blocked by this viewer | one indistinguishable "Seller not found" |

**Order is load-bearing.** Privacy is checked before trust: reporting
`trust_restricted` for a private account would leak Oxy Trust's opinion of a
person who has asked that nobody be shown their profile at all.

**The 404 conflates four different facts on purpose.** A distinguishable
response would be an oracle — a blocked caller would learn they had been
blocked, and a probe would learn which Oxy account ids exist. A transient Oxy
failure lands there too, which is the honest trade: a profile page that 404s
during an outage is worse than one that renders, and it is the only outcome that
cannot show a person who has since been erased.

**An absent trust signal restricts nothing.** `trust` is `null` both for an
account Oxy Trust never scored and for a read that failed, and the two are
indistinguishable from here. Withholding on absence would turn a
reputation-service outage into a marketplace-wide delisting. Mercaria's own
enforcement lever — `listings.status = 'restricted'` from a CrowdSource decision
— stops sales independently and does not depend on Oxy Trust being reachable.

**The restriction policy is a named constant, not a heuristic.**
`SELLER_TRUST_RESTRICTED_TIERS` currently holds exactly `restricted`, Oxy
Trust's own high-abuse-signal tier. `new` is where every account starts, so
including it would delist every first-time seller. Changing the policy is
changing that tuple, in one place, deliberately — which is what #92 reputation
rule 6 means by "an explicit policy, not a client guess".

### The viewer's own credential asks the viewer's own questions

`services/sellers/viewer-oxy-client.ts` builds a SHORT-LIVED `OxyServices` bound
to the request's bearer for a signed-in read, and reuses the shared anonymous
client otherwise. Never `oxyClient.setTokens(...)`: the shared instance is a
module-level singleton, and mutating its token per request would leak one
caller's session into another's concurrent read.

- The BLOCK check is `getViewerGraph()` — one round trip, ids only, and Mercaria
  keeps a boolean rather than the list. It covers the direction a viewer's
  credential can observe (viewer → seller). The reverse is Oxy's to enforce on
  the profile read itself, which is why the read uses the viewer's bearer:
  whatever Oxy withholds from this caller, Mercaria withholds too, without
  modelling somebody else's block list.
- A viewer-graph failure fails OPEN (the viewer sees a public page they could
  have seen signed out); a profile read failure fails CLOSED (404).
- Oxy Trust is read with the SHARED client: the public summary is identical for
  every caller, so a viewer-scoped read would buy nothing and would discard the
  SDK cache on the field that changes least.

## What the projection may carry

`PublicSellerProfile` names every field. Nothing is spread from an Oxy `User`,
nothing from a `seller_profiles` row, and there is no property bag anywhere in
the shape — the `provider_accounts` status projection (#46) and
`services/payments/redact.ts`'s allow-list, applied to a person.

`SELLER_PROFILE_FORBIDDEN_FIELDS` names the prohibition as a value across three
families, each on the list for its own reason:

- **contact and location** — a P2P seller's home is where the goods are. Coarse
  location belongs to a LISTING that opted into local discovery, never to the
  person.
- **payment onboarding** — whether a seller finished Stripe onboarding is
  commercially and personally revealing, and it is already derivable where it
  legitimately matters (checkout's readiness gate).
- **follower identities and the viewer graph** — see above.

Two gates enforce it: a scanned static gate over the whole domain
(`seller-identity-isolation.test.ts`) and a RUNTIME walk of a real emitted
profile (`public-seller-profile.service.test.ts`), each with a vacuity floor and
a mutation self-test.

### Display name is the sanctioned coalesce

`name.displayName?.trim() || handle`, where the handle comes from
`getNormalizedUserHandle`. `displayName` is OPTIONAL on the Oxy contract, so
reading it straight through produces an empty name for exactly the accounts a
marketplace can least describe otherwise. Recomposing a name from
`name.first`/`last`/`full` is forbidden ecosystem-wide and has no code path.

This lives in ONE place — `toOxyProfile` in `services/oxy-user.service.ts` —
which every seller card, review author, order seller and cart line already comes
through.

## Three signals, three labels

A seller page carries three numbers that answer different questions and are
owned by different systems. They stay in three fields and are never merged;
there is deliberately no field for a combined figure.

| Signal | Source | Label |
|---|---|---|
| `transactionReviews` | #76 `p2p_seller` aggregate | "Seller reputation" |
| `trust` | Oxy Trust, canonical service | "Reputation from Oxy Trust" |
| `marketplace` | Mercaria's own rows | activity counts, no rating |

Only the `p2p_seller` scope appears. A `product` rating is about a model
whoever sells it, and a `p2p_listing` rating is about the condition of one used
copy; showing either here under this person's name would attribute a
manufacturer's defect or one item's scuff to them (#76 UI rule 5).

**Mercaria manufactures no trust score.** A listing count, a follower count and
a sales count are activity, not trustworthiness; a number derived from them
wearing the word "trust" would be Mercaria asserting something nobody measured.
Oxy Trust's own figure is passed through and, on a `restricted` profile,
withheld — rendering the number that caused the restriction would publish a
reputation verdict on a page that has just refused to show anything else.

## Listings: what is public, and stable paging

`activeSellerListingsWhere` is written once and shared by the page, the count and
the "seller since" read, so the three cannot disagree about what "public" means.
Three conjuncts:

- `owner_type = 'user'` — #92 acceptance 4. A seller page must never show a
  store's stock as a person's own inventory merely because that person operates
  the store. Not redundant beside the id match:
  `listings_owner_exclusivity_check` guarantees a store row has a NULL
  `oxy_user_id` *today*, and stating only the id would rely on a schema
  invariant a future widening could relax, in the one query where relaxing it
  discloses a shop's stock as somebody's second-hand goods.
- `oxy_user_id` — the seller.
- `status = 'active'` — sold, archived, restricted and draft are not public.
  `restricted` matters most: it is what a CrowdSource takedown writes, and a
  seller page reading any other status would keep a delisted item visible on the
  page most likely to be linked from a report.

Paging is KEYSET on `published_at desc nulls last, id desc nulls last`, served
end to end by the existing `listings_owner_user_status_published_at_id_idx` — so
this domain adds no index and no migration. The cursor is
`<publishedAt ISO or empty>|<id>`, opaque, and both NULL branches are written
out because a plain `(published_at, id) < (?, ?)` row comparison yields NULL
rather than true when a member is NULL, and would silently drop every undated
row.

`limit + 1` is fetched; the extra row is dropped and its existence IS the
cursor, so there is no second count query.

**The listings route runs the same access gate as the profile route.** That is
the point rather than an inefficiency: a client that skipped the profile call
and asked for the listings directly must not page through a private seller's
inventory. A withheld profile answers with an empty page and no cursor.

**"Seller since"** is the earliest publish across EVERY status, or absent. A
seller whose first three items all sold has not become newer, and a lazily
created `seller_profiles` row dates the moment somebody opened a screen — a fact
about their browsing, not their selling.

## Indexability

`indexable` is derived on the SERVER: fully visible AND at least one active
listing. A profile with nothing on it is a thin page about a named human being,
which is what a minimum-content policy exists to keep out of an index; a private
or restricted profile has no content to index at all. The storefront renders
`<meta name="robots" content="noindex">` when it is false, and defaults to
`noindex` while the profile is still resolving.

## Reporting a seller

The **Report** action posts `POST /reports` with `reportedType: 'seller'` — the
moderation flow, and the only destination. Mercaria's intake stores the row
durably; whether it also leaves for CrowdSource is decided server-side by the
subject-provider registry, and `seller` deliberately has no provider (a
`SellerProfile` carries no user-authored identity to pin into a case snapshot,
and a case naming an object only Oxy can act on would open in the wrong tenant).

That distinction is invisible in the UI on purpose: a reporter who learns a noun
is not wired to a jury has learned what is not watched. The confirmation says
the report was received and promises no outcome.

Reporting or blocking the PERSON (rather than their selling) belongs to Oxy's
own surfaces, which the account dialog reaches. Duplicating them here would
create a second place to block somebody that Oxy's graph does not know about.

## Surface

| Route | Auth | Meter |
|---|---|---|
| `GET /sellers/:oxyUserId` | `optionalAuth` | `rl:sellers:` |
| `GET /sellers/:oxyUserId/listings?limit=&cursor=` | `optionalAuth` | `rl:sellers:` |

`/sellers` (plural) is public; `/seller` (singular) is the authenticated
seller's own management surface. One letter apart and opposite in who may read
them, hence two routers with different middleware.

Its own rate-limit bucket, deliberately: the route is keyed on an Oxy ACCOUNT
ID, so an unmetered surface is a way to walk the id space and learn which Oxy
accounts sell on Mercaria and what they sell. Sharing the shop page's budget
would mean a crawler either exhausts shopping for everyone or is not bounded.

There is no write route and no follow route, and neither may be added.

## Storefront

- `app/(app)/sellers/[oxyUserId].tsx` — profile, signals, keyset listing grid,
  and the empty / private / restricted / not-available states.
- `components/seller/SellerFollowButton.tsx` — `FollowTargetButton` over the
  `oxy.user` target. A SEPARATE component from `StoreFollowButton`, and neither
  goes near `MerchantHeader`: `products/[id].tsx` resolves a single `identity`
  store-first-then-seller, so a follow control there would push a shop and a
  person through one code path and get the person's kind wrong (#26).
- `components/seller/SellerLinkCard.tsx` — the product-page link, rendered under
  `{listing.seller ? … : null}` beside the store card's own guard. The route is
  keyed on the Oxy account id, never a handle: a rename would 404 every inbound
  link, the same reason the follow URI is keyed on the id.
- `components/seller/ReportSellerDialog.tsx` — the report flow above.

## Deferred, and to whom

- **A seller's own public-profile preferences** (a bio, a banner, pinned
  listings). Nothing here stores user-authored identity, and adding it is a
  product decision plus a moderation surface, not a field.
- **Merchant responses to reviews** and an HTTP operator surface for reviews —
  #76's own deferred list, unchanged.
- **Ranking use of any signal on this page** — #74. `seller-identity-isolation`
  does not yet mirror `fee-ranking-isolation`'s ranking wall for this domain
  because there is no ranking module that could read it; the wall belongs with
  the ranking work.
- **A seller's coarse local-discovery hint** — it belongs to a LISTING that
  opted in (#92 privacy rule 3), and the listing surface owns it.
- **Blocking a seller from inside Mercaria** — Oxy owns the block graph and its
  own UI reaches it; a second block affordance here would not be in that graph.
