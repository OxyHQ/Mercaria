# Private watchlists and currency-safe basket tracking (#81)

The reference for Mercaria's watchlist domain. The schema decisions are in
`packages/backend/src/db/schema/CONVENTIONS.md` §"Private watchlists (#81)";
this document is the behaviour.

## The problem, stated once

A buyer planning a PC build is not saving eight products. They are watching ONE
thing — what the build costs — and the number they care about does not exist
anywhere until somebody adds eight prices together. The moment you do that, four
ways to be wrong open at once:

1. the eight offers are priced in four currencies, and adding their minor units
   produces a number in no currency at all;
2. two of them publish no delivery cost, and treating that as zero produces a
   total nobody can buy at;
3. one of them has no eligible offer today, and dropping it quietly produces a
   SMALLER total that looks like good news;
4. the sum of eight independently-cheapest offers is not the cheapest way to buy
   eight things, and a page that implies it is has made a promise nobody
   computed.

Every rule below exists for one of those four.

## What a watchlist is, and what it is not

| | Watchlist (#81) | Product save (#80) |
|---|---|---|
| Table | `watchlists` + `watchlist_items` | `product_saves` |
| Means | "these things, in these amounts, together" | "I want this product, from whoever sells it best" |
| Answers | what the SET costs right now, and how that moved | is this saved, and by how many people |
| Counted | never — there is no aggregate | `product_save_aggregates`, with a disclosure floor |

They share no row, no counter and no aggregate, and
`watchlist-isolation.test.ts` fails the build if a module in this domain reaches
the save domain. A watchlist is a GROUPING WITH A PURPOSE, never a second answer
to "did this buyer save this product".

## The basket

### Every amount is converted before it is added

An item is priced through #74's `rankOfferComparison`, under the `cheapest`
intent, in the LIST's display currency. #74 returns amounts already converted,
each carrying the `FxRateSnapshot` that converted it, so this domain never sees a
native minor unit and never adds one. `composeWatchlistTotal` REFUSES a line
denominated in anything but the display currency rather than skipping it —
skipping is the quiet exclusion this issue exists to prevent, wearing a
defensive check's clothing.

The intent is `cheapest` and that is a decision rather than a default: a
watchlist tracks COST, so the selection key has to be cost. Ranking under
`balanced` would put a number on the page that no ordering of the offers
explains.

### One basis, for the whole total

`delivered_total` when EVERY contributing line knows its delivery cost;
`item_price` otherwise, and then delivery is excluded from all of them. The
alternative — delivered where known, bare price where not — is a figure that is
neither, and it is the one a buyer would most easily mistake for what they will
actually pay. The basis travels with the total and is part of the label the
storefront renders.

### Three completeness states, and none of them is a zero

`complete` (every item contributed), `partial` (some did not, and they are
listed separately with a reason), `unknown` (nothing could be priced, so there
is no figure at all). The unknown branch of `WatchlistBasketTotal` carries no
amount, so a surface cannot render a zero by forgetting a check.

### An item that could not be priced is REPORTED

Nine reasons, each a fact the evaluation actually read:

| Reason | Means | The buyer's next action |
|---|---|---|
| `ambiguous_after_split` | a split divided the product | answer the split |
| `preferred_variant_retired` | the pinned configuration is gone | pick another |
| `product_merged_into_existing_item` | a merge collapsed it into a sibling entry | remove the duplicate |
| `product_unavailable` | the product no longer resolves | remove it |
| `no_offers_recorded` | nobody has ever sold it here | look elsewhere |
| `all_offers_retired` | every offer lapsed | wait |
| `no_eligible_offer` | their own filters exclude everything | widen them |
| `price_not_convertible` | no offer carries a price this comparison can express | nothing |
| `evaluation_failed` | pricing this item raised | nothing |

`no_eligible_offer` and `price_not_convertible` are computed from two DIFFERENT
filters and are never collapsed: the first is the buyer's own narrowing and the
second is not, so reporting the second as the first sends somebody to loosen a
filter that was never the problem.

### The three derived states, and why they are derived

`product_unavailable`, `product_merged_into_existing_item` and
`preferred_variant_retired` are computed at evaluation time from
`canonical_products` and `canonical_variants` — tables this domain does not own.
That is the `deriveNativeCheckoutEligibility` divergence from the one-stored-
verdict rule, and it is what makes a merge or a suppression bite with no sweep
having run. Only `ambiguous_after_split` is STORED, because it is a decision a
curation job took at a moment and the two candidates exist as a pair only in
that job.

### Nothing here claims a multi-store optimum

`WatchlistBasketOptimization` has ONE branch and it is the unperformed one, so
no client can read an "optimized" flag out of a response.
`WATCHLIST_FORBIDDEN_CLAIMS` names the six sentences a surface may never render
and the gate scans the backend AND the storefront screens in RAW source —
comments included, because a claim written in a comment is a sentence somebody
pastes into a screen next week. #42 owns the optimization that would justify the
sentence; this is a sum of INDEPENDENT per-item minima and says so.

## Editing a list

### The list is the concurrency unit

`watchlists.version` is a compare-and-swap on every mutation of the list OR of
one of its items, in ONE statement — there is no read-then-write anywhere in the
domain, because a read-then-write is exactly what the second client defeats. A
mismatch is `WATCHLIST_VERSION_CONFLICT` (409), whose remedy is mechanical:
re-read, re-apply, retry.

The unit is the LIST rather than the item because a client holds and renders a
whole list: a per-item token would let a reorder computed against one membership
be applied to another, which is the case a token exists to catch and the one a
per-item token cannot see.

### One entry per product per list

`watchlist_items_watchlist_id_canonical_product_id_key`. A repeated add
converges on the existing row and changes NOTHING — not the quantity, not the
note, not `added_at`, which is a tiebreaker in the list's own order. It is also
what a product merge rehomes against.

### A reorder is total or it is refused

`PUT .../items/order` takes the complete membership. "These three go first" is
ambiguous the moment two of the rest share a position, and the ambiguity is
invisible — the list simply comes back in an order nobody asked for.

### Limits

`WATCHLIST_MAX_LISTS_PER_OWNER` (50), `WATCHLIST_MAX_ITEMS_PER_LIST` (200),
`WATCHLIST_MAX_ITEM_QUANTITY` (999), plus name, description, icon and note
lengths. They live in `@mercaria/shared-types` because the client needs them to
refuse before a round trip, and two copies of a limit disagree the first time one
is raised. Every refusal names the limit and its value.

## Merge, split, retirement, expiry

| Event | What happens |
|---|---|
| Product MERGE | the entry is repointed (`repoint_if_absent`, guarded on `watchlist_id`); a list holding BOTH sides keeps the loser-side row on the tombstone and the evaluation reports `product_merged_into_existing_item`, so the basket counts the product ONCE |
| Product SPLIT | every RESOLVED entry of the source is marked `ambiguous_after_split`, naming the job, in the curation `saves` phase beside #80's saves |
| Variant retirement | the item falls back to the product-level UNRESOLVED state and NEVER to another variant |
| Offer expiry | the next evaluation simply selects again; #74's eligibility has already dropped the expired one |
| History | a snapshot line keeps the offer id, the amounts and the quote it used, with NO foreign key onto `offers` — that table CASCADEs from `listings`, so an FK would delete the history the rule exists to keep |

Merging two entries' QUANTITIES was refused: a merge changing how many of
something somebody asked for is a decision about their money that no automatic
rule may make.

### The buyer's three answers to a split

`keep_source`, `move_to_target`, `keep_both` — #80's three, for its reason:
`keep_both` is the honest reading of a split ("these were always two things and I
want both"), which a `move: true|false` contract cannot express.
`move_to_target` onto a product the list already holds REMOVES the ambiguous
entry rather than violating the unique, and clears any pinned variant, because a
configuration pinned on the source cannot be assumed to exist on the target.

## Snapshots

### Evaluating is a read; recording is a write

`GET /watchlists/:id/basket` evaluates and stores nothing. `POST
/watchlists/:id/snapshots` records one. A GET that wrote would make "when was
this list last measured" answer "whenever somebody last looked at it".

### An unchanged evaluation writes NO row

The dedupe compares a `content_digest` against the LATEST snapshot under a `FOR
UPDATE` lock on the list. The digest covers the LINES, not only the total,
because two items moving by equal and opposite amounts leave the total exactly
where it was — and a history that deduplicated that would show one flat line
through the week both prices moved. A dedupe is a SUCCESS
(`outcome: 'deduplicated'`) and still stamps `last_evaluated_at`.

### The counters are a vacuity floor

`item_count = priced_item_count + unresolved_item_count`, by CHECK, with
equality rather than `<=`. `insertWatchlistSnapshot` additionally refuses a set
of lines shorter than the list, and derives the counters from the lines rather
than accepting them. A snapshot that measured fewer items than the list holds
reads exactly like a clean one, and arithmetic is the only thing that can tell
them apart.

### Material changes, and what they may not be read as

A stored snapshot differs from its predecessor by construction, so
`material_changes` is never empty (`cardinality(...) >= 1`, never
`array_length`, which is NULL on `{}` and would admit the row it refuses). Eleven
kinds, and `policy_version_changed` is the one to read: a different #74 policy
can select a different offer at unchanged prices, so a total that moved across
one is NOT attributable to the items.

### The diff refuses more often than it explains

"Which items drove a change" is DERIVED from two stored snapshots, never stored
beside them. It refuses across a currency change, a basis change or a policy
change — each by name — because a movement attributed to an item that did not
move is worse than no explanation: a buyer shown "this went up €40" acts on it,
and the seller of that item did nothing.

### Retention

`retention_expires_at` is stamped at write time (400 days, matching #78's query
span so a year-ago comparison still resolves) and swept by the shared expiry
sweeper. A snapshot is APPEND-ONLY against UPDATE and DELETE is deliberately
PERMITTED — the `analytics_events` / `offer_price_snapshots` posture, because a
trigger refusing DELETE would make the sweep fail silently on every row it was
meant to remove.

## Privacy

- **Private, with no other setting.** `WatchlistVisibility` has one member and
  `WATCHLIST_FORBIDDEN_VISIBILITIES` names the five somebody would reach for,
  disjoint and gated. `shared_link` is named explicitly: a list reachable by URL
  is public to everyone the URL reaches, however unguessable it is.
- **No merchant surface, and therefore no demand aggregate.** #81 privacy rule 2
  bounds what a merchant may receive; the enforcement here is that there is
  nothing to receive. Counting how many private lists hold a product is the
  question `product_save_aggregates` already answers at a different grain, with a
  disclosure floor, and a second counter would be a second answer and a second
  floor to keep in step.
- **A private note never travels.** `watchlist_items.note` is in
  `PROTECTED_COLUMNS`, so the evaluation — which reads items whole and writes
  snapshot rows from what it read — cannot carry one into a durable table. The
  owner's own list projection names the column explicitly, which is the one read
  that legitimately returns it.
- **No analytics.** The domain emits no event at all, which is a stronger
  statement than a redaction: #77's schema is an allow-list of typed columns with
  no property bag, and this domain does not reach it.
- **One account id, on one table.** Only `watchlists` carries `oxy_user_id`;
  items, snapshots and lines reach their owner through the list. An erasure is
  one scoped DELETE.
- **No operator surface and no seventh allow-list.** None of the six existing
  ones should be able to read a private list or a private note, and every repair
  this domain could need is an idempotent path the owner already drives.

## HTTP surface

Buyer (`authenticateToken`, `rl:listings:`, mounted under `WATCHLISTS_ENABLED`):

| Route | Does |
|---|---|
| `GET /watchlists` | every list this account owns |
| `POST /watchlists` | create one, optionally from a template |
| `GET /watchlists/templates` | the starting shapes a create screen may offer |
| `GET /watchlists/pending` | how many entries await a split answer |
| `GET /watchlists/:id` | the list and its items. Prices NOTHING |
| `PATCH /watchlists/:id` | rename, re-describe, change the currency or market |
| `DELETE /watchlists/:id` | remove it, its items and its history |
| `POST /watchlists/:id/duplicate` | copy it, without its history |
| `POST /watchlists/:id/items` | add one product (idempotent) |
| `PATCH /watchlists/:id/items/:itemId` | quantity, preferences, target, note |
| `DELETE /watchlists/:id/items/:itemId` | remove one entry |
| `PUT /watchlists/:id/items/order` | the COMPLETE ordering |
| `POST /watchlists/:id/items/:itemId/resolve-split` | answer a split |
| `GET /watchlists/:id/basket` | evaluate; record nothing |
| `POST /watchlists/:id/snapshots` | record one evaluation, deduplicated |
| `GET /watchlists/:id/snapshots` | the recorded history |
| `GET /watchlists/:id/snapshots/:snapshotId` | one evaluation with its lines |
| `GET /watchlists/:id/snapshots/:snapshotId/diff` | which items drove the change |

Every mutation carries `expectedVersion` and returns the version it produced.

## Environment

```
WATCHLISTS_ENABLED=false             # mounts /watchlists; never gates the rows
WATCHLIST_SNAPSHOT_PAGE_SIZE=50
WATCHLIST_EVALUATION_CONCURRENCY=6   # offer comparisons per basket, at a time
```

ONE flag, and it gates the MOUNT. There is no read mode to roll back to (there
was no watchlist surface before this issue) and no migration to gate. It does not
gate the rows: a list already stored stays stored and comes back when the flag
does, because a rollback lever that cost buyers their lists is one nobody would
pull during the incident it exists for.

## Deferred, with named seams

| Owner | What |
|---|---|
| **#42** | the multi-store basket optimization. `WatchlistBasketOptimization` has one branch and it is the unperformed one, so nothing can claim it was run |
| **#79** | price alerts. `WatchlistItemPriceAlert` has ONE branch and it is the unsupported one, so no client can read a subscription id out of it and no schema carries a field to ask for one. The TARGET amount is the half that is representable today |
| **#94** | item-level template semantics ("a PC build needs exactly one CPU"), which need the category attribute registry to say what a CPU is |
| **#78** | the price CHART. This domain compares against its OWN snapshots, which are basis-matched (same currency, same policy, same preferences); #78 answers what an OFFER cost over time, which is a different question about a different subject |
| **#71** | the canonical product page each row links to |

## Production-readiness checklist

1. Deploy with `WATCHLISTS_ENABLED=false`. Confirm `/watchlists` 404s and
   nothing else moved.
2. Apply migration `0055` (`pre`, purely additive — four tables, two triggers).
3. Turn `WATCHLISTS_ENABLED=true` in a staging deployment and create a list of
   two products priced in different currencies. Confirm the basket names ONE
   currency, carries both quotes, and labels its basis.
4. Remove every offer for one of them and confirm the total goes `partial` with
   the item listed and a reason — not smaller and quiet.
5. Record two snapshots with no change between them and confirm the second is
   `deduplicated`.
6. Confirm `WATCHLIST_EVALUATION_CONCURRENCY` is set for the deployment's offer
   read budget before enabling for a cohort with long lists.
