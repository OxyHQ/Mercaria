# Canonical product saves and the listing-save migration (#80)

The reference for Mercaria's save domain. The schema decisions are in
`packages/backend/src/db/schema/CONVENTIONS.md` §"Canonical product saves
(#80)"; this document is the behaviour.

## The problem, stated once

Before #80 a save was a `favorites` row: one Oxy account, one native LISTING.
That is exactly right for a hand-thrown mug and exactly wrong for a phone. A
buyer who saved "iPhone 15 Pro, 256 GB" saved one merchant's listing of it, so
when that merchant delisted, raised the price or went out of stock, the buyer's
save became a dead link to a thing they still wanted — and the forty other
sellers of the identical product were invisible to it.

#80 adds the save a buyer actually meant, without taking away the one they
sometimes mean instead.

## Two kinds of save, and they are never collapsed

| | Canonical product save | Listing save |
|---|---|---|
| Table | `product_saves` | `favorites` (pre-existing) |
| Names | `canonical_products.id` | `listings.id` |
| Means | "I want this product, from whoever sells it best" | "I want THIS one" |
| Survives | an offer expiring, a merchant leaving, a price change | nothing — it is about that listing |
| Right for | a phone, a book, a boxed appliance | a handmade piece, an unmatched P2P item, a used copy whose seller photographs are the reason |

The UI says which is which on every row and on every button (#80 listing rules).
A listing page with a confident canonical mapping shows BOTH `Save product` and
`Save this listing`; one without shows the listing button alone.

### `save_intent`, and why a pin is not just a favorite

`favorites.save_intent` is `listing_save | listing_pin`.

- `listing_save` is the honest reading of every row written before #80 and of
  every write from a v1 client: a listing was saved and nobody asked whether the
  buyer meant the exact copy or the model.
- `listing_pin` is the buyer answering — they pressed `Save this listing` while
  `Save product` sat beside it.

The migration reads the first and skips the second. An absent intent on a write
leaves an existing row's intent alone, so an old build's plain `POST
/favorites/:id` can never quietly downgrade a pin.

## The model

`product_saves` carries the Oxy account, the canonical product, three optional
preferences (a canonical VARIANT, a condition SEGMENT, a merchant), the source
context the save was made from, the visibility, the split-resolution state, and
one immutable reference price.

- **The preference is a condition GROUP, never one of #90's nine keys.** "I want
  a refurbished one" is a filter over a segment; pinning `refurbished_seller`
  would silently exclude `refurbished_manufacturer` from a buyer who meant both.
- **The reference price is ONE observation, written once at save time.** It is
  not a price history — #78 owns that table — and it exists so "cheaper than
  when you saved it" is answerable without one. Its currency is the OFFER's own
  (a plain string; ADR 0002 D18's documented exception), and a comparison across
  two different currencies is REFUSED rather than converted: running it through
  FX would report a rate movement as a price movement.
- **`visibility` has exactly one member.** #80 privacy rule 6 excludes a public
  saved-list profile from this issue, and the honest way to say that is to make
  one unrepresentable. `PRODUCT_SAVE_FORBIDDEN_VISIBILITIES` names the four
  somebody would otherwise reach for, disjoint from the permitted tuple and
  gated by a test.

## Idempotence

`product_saves_oxy_user_id_canonical_product_id_key` is #80 model rule 9 and
acceptance 1 in one line. Every write is a single statement whose outcome does
not depend on a prior read:

- the insert is `ON CONFLICT DO NOTHING`, so a repeated tap creates nothing AND
  changes nothing — not the source context, and not `created_at`, which is the
  saved list's ordering key;
- the delete reports whether a row went;
- the counter is DERIVED, so no path can move a number twice.

A read-then-write would satisfy the words of acceptance 5 and fail the two cases
that actually happen: a double tap, and a retry after a timeout the client never
saw the response of.

## The saved list

`GET /saved-items` returns product saves and listing saves in ONE
keyset-paginated stream, ordered `(created_at desc, id desc)` across both
tables. A response with two cursors is not a paginated list — a client cannot
interleave two of them by time without holding both and re-sorting, which breaks
the moment a page boundary falls between two items saved a second apart. Ids are
uuid v7 and are used purely as a TIEBREAKER; uuid v7 is not monotonic within a
millisecond, so nothing here reads id order as creation order.

Each product entry carries the current best offer — or a REASON there is none —
the price change against the reference, the disclosed save count, and the #78
price-alert seam.

### `PRODUCT_SAVE_READS` — the dual read and the rollback (#80 acceptance 8)

| Mode | The list contains | Use |
|---|---|---|
| `off` (default) | listing saves only | exactly what a deployment served before #80; the lever an incident pulls |
| `dual` | both kinds, with each listing saying whether a product save represents it | the comparison window |
| `on` | product saves, plus PINNED listing saves, plus listing saves no product save represents | the destination |

**`on` still returns listing saves, and that clause is load-bearing.** Dropping
the unrepresented ones would break #80 acceptance 3 ("unmatched P2P favorites
continue to work") on the deploy that finishes the rollout, which is the worst
possible moment to discover it.

Representation is DERIVED at read time — a `product_save_sources` record joined
back to a save that still EXISTS — and never stored. A buyer who un-saves the
product sees the listing reappear in the statement that removed it.

### No current offer (#80 acceptance 7)

`SavedProductOffer` is a discriminated union whose `none` branch carries a
reason:

- `no_offers_recorded` — nothing was ever observed for this product;
- `all_offers_retired` — offers exist and every one has lapsed or been withdrawn;
- `no_eligible_offer` — offers are live but the buyer's own preferences exclude
  all of them.

The third is why the preferences are applied in `best-offer.ts` rather than by
the caller: reported as `all_offers_retired` it would send a buyer looking for a
product that is on sale, when the answer is to widen their own filter.

## The migration from `favorites`

Operator-triggered, bounded, resumable: `POST /internal/product-saves/migrations`
with `{limit, cursor?, dryRun?}`. The cursor is `favorites.id`.

Per favorite, in this ORDER — and the order is load-bearing:

1. a `listing_pin` is `pin_preserved` and nothing else happens. A pin is
   answered before the mapping is even looked at, so a pinned listing with a
   perfect canonical attachment still stays a pin; reversing the two would make
   the strongest signal a buyer can give lose to an automatic match;
2. a favorite already read under this mapping version is `already_migrated`;
3. a listing with no CONFIDENT canonical attachment is `unmatched` — a SUCCESS,
   and #80 acceptance 3;
4. otherwise one `product_saves` row (`created`, or `converged` when the buyer
   already saves that product) plus one `product_save_sources` record.

**Confident excludes `matcher`.** #58 routes a heuristic attachment to #59's
review queue precisely because nobody has agreed it yet, and a save created from
an unreviewed guess is a false merge with a person's intent attached. A
`matcher` link an operator later confirms arrives as `operator`, and the buyer's
favorite is still there waiting for it.

**No preferred variant is written.** The favorited listing attaches to one
canonical configuration and recording it would narrow the buyer's save to it —
an inference, and an arbitrary one: two favorited listings of one product in two
colours would give whichever the migration reached first, silently, forever.

### What a replay cannot do (#80 migration rule 6, acceptance 6)

Duplicate a save (`product_saves`' unique), or double a counter (the counter is
derived). The `product_save_sources` unique converges the LOG on top of that,
which is a separate property and is stated separately — that record CASCADES
with the favorite it names, so a rule that depended on it would be silently
unenforced the first time a buyer un-saved a listing.

### The two parents of a migration record are treated differently

- the FAVORITE cascades: removing the listing save takes the record of it;
- the SAVE does not — `save_id` is `ON DELETE SET NULL`, so un-saving the
  product leaves the record standing and `productSaveSourceExists` then refuses
  to re-migrate that favorite. Cascading here would make a replay RESURRECT a
  save the buyer deliberately removed, which is worse than a duplicate: a
  duplicate is visible and a resurrection looks like the buyer's own doing.

A NEW mapping version can still re-examine the favorite, because the unique
spans the version — a new version is a new decision.

### Nothing is ever removed (#80 acceptance 2)

The migration issues no DELETE and no UPDATE against `favorites`, and
`product-save-isolation.test.ts` fails the build if a module in the domain
grows one.

### A dry run is the default posture

`PRODUCT_SAVE_MIGRATION_ENABLED=false` downgrades every request to a dry run
that reports exactly what it would do — the #60
`CANONICAL_WRITE_PUBLICATION_ENABLED` shape. A dry-run outcome may read
`created`, because in that mode an outcome is a PREDICTION and refusing to
report one would make the mode unable to answer the question it exists for.

## Merge and split (#80 acceptance 4)

### A merge rehomes saves automatically

`merge-plan.ts` declares three columns and the census enforces that they are
exactly the ones referencing a mergeable entity:

| Column | Disposition |
|---|---|
| `product_saves.canonical_product_id` | `repoint_if_absent`, guarded on `oxy_user_id` |
| `product_saves.preferred_canonical_variant_id` | `repoint` |
| `product_saves.preferred_merchant_id` | `repoint` |
| `product_save_aggregates.canonical_product_id` | `retained_by_tombstone` |

A buyer who saved BOTH sides already has a save on the winner, so their
loser-side row stays on the tombstone — and the saved-items read excludes a
merged product, which loses nothing precisely BECAUSE the twin exists. That is
the only reading under which the exclusion is safe, and a realdb case pins it.

The counters are re-derived for both sides in `rebuildEntityAggregates`, never
summed: adding the loser's count to the winner's would double-count every buyer
who saved both, and a count has no rows beside it to catch that with.

### A split marks saves rather than picking a child

`CATALOG_SPLIT_PHASES` gained a `saves` phase between `assignments` and
`redirects`. It marks every RESOLVED save of the source
`ambiguous_after_split`, naming the job — which is what makes both candidates
recoverable without a second table.

Deterministic migration was considered and refused. "Keep the save where it is"
would be deterministic and silently wrong for exactly the buyers whose interest
moved to the new entity, with no signal anywhere that a decision had been made
on their behalf; that is the "selecting a child silently" #80 migration rule 8
forbids, and moving them all is the same mistake pointed the other way.

The marking only touches `resolved` rows, so a resumed phase re-runs it as a
no-op AND a save already made ambiguous by an EARLIER split keeps naming that
earlier job — retargeting an unanswered question would destroy the pair of
candidates the buyer was asked about.

Only a canonical PRODUCT split marks anything. A variant split moves offers and
identifiers between two configurations of the SAME product, so a save's product
is unchanged and there is no question to ask.

### The buyer's three answers

`POST /product-saves/:saveId/resolve-split` takes `keep_source`,
`move_to_target` or `keep_both`. `keep_both` exists because the honest reading
of a split is often "these were always two things and I wanted both"; a
`move: true|false` contract cannot express it, and the affordance a client
builds from a boolean is the one that quietly loses half a buyer's interest.

`move_to_target` onto a product the buyer already saves removes the ambiguous
row rather than violating the unique — their saved list ends with exactly one
entry for the destination, which is what "move it there" means when they are
already there.

## Counters (#80 counter rules, acceptance 6)

`product_save_aggregates` is the ONE authority for how many people saved a
canonical product. Everything DERIVES and nothing increments — there is no
delta parameter anywhere in the domain — which is what makes a rebuild
idempotent, drift detectable, and the merge's rollup phase correct.

There is deliberately NO `canonical_products.save_count` projection beside it.
Reviews have one only because those columns predated the aggregate, and a second
writer of one number is the disagreement these tables exist to prevent.

`listings.favorite_count` stays scoped to exact listing saves (#80 counter rule
2) and is now REPAIRABLE: it is still moved incrementally in the hot path
(a save must not pay for a count) and `rebuildListingFavoriteCount` re-derives
it from `favorites` when something has gone wrong. The two figures are never
summed anywhere — a total across them would double-count every buyer whose
favorite the migration also turned into a product save.

### Detection and repair are separate acts

`GET /internal/product-saves/counters/drift` reports and changes nothing;
`POST /internal/product-saves/counters/rebuild` repairs. A sweep that silently
rewrote a wrong number would also silently hide whatever was writing it.

The rebuild page visits BOTH the aggregates (oldest-rebuilt first) and the
products that HAVE saves. Neither subsumes the other: the first repairs a number
that went wrong, the second creates one that was never written — which is
precisely the state a drift probe over `product_save_aggregates` alone can never
see.

## Privacy

- **The count never exposes who saved something** (#80 privacy rule 1). There is
  no actor column on `product_save_aggregates` at all — an absence, not a rule —
  and a gate asserts it.
- **A count below `PRODUCT_SAVE_COUNT_DISCLOSURE_FLOOR` (10) is WITHHELD as a
  state, never rounded** (#80 privacy rule 4). "Under 10" beside a timestamp is
  a person, and a rounded number is the same disclosure with a friendlier face.
  `discloseProductSaveCount` is the ONE policy function.
- **The domain stores an Oxy account id and nothing else about a person** (#80
  privacy rule 5). No name, handle, email, avatar or contact detail exists in
  any of the three tables, gated by a column scan with a vacuity floor and a
  mutation self-test. That is what makes "remove or anonymize" resolve to a
  single scoped DELETE: there is nothing left over to anonymize.
- **Saving subscribes to nothing** (#80 API rule 6). No module in the domain can
  reach an alert, a watch or a notification subscription, and
  `PRODUCT_SAVE_FORBIDDEN_SIDE_EFFECTS` names the five prohibitions as values.
- **A save is not a ranking input.** No feed, search or catalogue-read module
  can reach this domain — the `fee-ranking-isolation` wall pointed at
  popularity, which is the signal most likely to be reached for by accident.
  Whether measured popularity should affect an ordering is #74's decision to
  make deliberately, not one a feed inherits by importing a counter.

## Environment

```
PRODUCT_SAVES_ENABLED=false            # mounts /product-saves and /saved-items
PRODUCT_SAVE_READS=off                 # off | dual | on
PRODUCT_SAVE_MIGRATION_ENABLED=false   # may a migration page WRITE?
PRODUCT_SAVE_MIGRATION_BATCH_SIZE=200
PRODUCT_SAVE_COUNTER_SWEEP_BATCH_SIZE=500
```

The three levers are independent and the interaction matters:

- `PRODUCT_SAVES_ENABLED=false` is the full withdrawal. Both routes 404,
  `/favorites` is untouched, and a deployment behaves exactly as it did before
  #80. It does NOT gate the ROWS: saves already stored stay stored and come back
  when the flag does, because a rollback lever that cost buyers their list is not
  one anybody would pull.
- `PRODUCT_SAVE_READS` is the rollback INSIDE an enabled deployment.
- `PRODUCT_SAVE_MIGRATION_ENABLED` gates only the WRITE, so an operator can
  measure the migration before authorising it.

`/internal/product-saves/*` is deliberately NOT gated on
`PRODUCT_SAVES_ENABLED`: an operator must still be able to read counter drift,
rebuild a counter and erase an account's saves while the buyer surface is off —
gating it would hide the evidence during exactly the incident that turned the
buyer surface off (#60's reasoning for `/internal/backfill`).

## HTTP surface

Buyer (`authenticateToken`, `rl:listings:`):

| Route | Does |
|---|---|
| `GET /saved-items` | the merged list, keyset-paginated |
| `POST /product-saves` | save a product (idempotent) |
| `GET /product-saves/:canonicalProductId` | is it saved, and how |
| `PATCH /product-saves/:canonicalProductId` | change the preferences |
| `DELETE /product-saves/:canonicalProductId` | un-save (idempotent) |
| `POST /product-saves/:saveId/resolve-split` | answer a split ambiguity |
| `GET /product-saves/pending` | how many saves await an answer |
| `GET /product-saves/listings/:listingId` | the two-button context |
| `POST /favorites/:listingId` | save a listing; optional `{intent}` |

Operator (`CATALOG_OPERATOR_OXY_USER_IDS`, empty = not mounted, 404):

| Route | Does |
|---|---|
| `GET /internal/product-saves/counters/drift` | report, repair nothing |
| `POST /internal/product-saves/counters/rebuild` | one product, one listing, or a page |
| `POST /internal/product-saves/migrations` | run one migration page |
| `GET /internal/product-saves/trace/:canonicalProductId` | counts, never people |
| `DELETE /internal/product-saves/subjects/:oxyUserId` | erase one account's saves |

The trace opens from a canonical product id and nothing else. "Who saved this
product" is not a question this surface can be asked, and the reason it cannot is
that every value it returns is a count. The erasure is the one route that names a
person — it needs the subject by definition — and it returns two numbers.

## Deferred, with named seams

| Owner | What |
|---|---|
| **#78** | price alerts and the price-history table. `ProductSavePriceAlert` has ONE branch and it is the unsupported one, so no client can read a subscription id out of it. The client renders nothing rather than a greyed-out bell that claims an unbuilt feature exists. |
| **#74** | whether saves are a ranking signal. A scanned gate fails the build if a discovery module reaches this domain. |
| **#71** | the canonical product PAGE. `SavedItemCard` links a product entry at `/products/:slug`; the richer surface is #71's. |
| **#59** | the operator review of an ambiguous listing→product mapping. This domain refuses such a listing and never picks. |

## Production-readiness checklist

1. Set `CATALOG_OPERATOR_OXY_USER_IDS` — without it there is no way to read
   counter drift, rebuild a counter, run the migration or erase an account's
   saves.
2. Deploy with `PRODUCT_SAVES_ENABLED=false`. Confirm `/favorites` is unchanged
   and both new paths 404.
3. Run `POST /internal/product-saves/migrations` with `dryRun: true` over the
   whole catalogue and read the report. `unmatched` plus `pinPreserved` is the
   part of the catalogue the migration deliberately leaves as listing saves; if
   `created` is implausibly small, the canonical attachments (#58/#60) are the
   thing to check, not this domain.
4. Set `PRODUCT_SAVE_MIGRATION_ENABLED=true` and run the migration to
   completion, page by page, following the cursor.
5. Check `GET /internal/product-saves/counters/drift` reports nothing.
6. Set `PRODUCT_SAVES_ENABLED=true` with `PRODUCT_SAVE_READS=off`. The saved
   page then serves exactly the listing saves buyers already had.
7. Move to `dual`, compare, then to `on`. Rolling back is one variable and
   deletes nothing.
