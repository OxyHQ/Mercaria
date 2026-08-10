# The canonical "Sell yours" flow (#91)

Letting somebody start from a product Mercaria already knows about — or identify
their item once — and publish a trustworthy P2P listing without retyping the
brand, the model or the specifications.

Code: `services/sell-yours/` (7 modules), `db/sellYours/` (3 repositories),
`db/schema/sellYours.ts` (4 tables), `middleware/sell-yours-schemas.ts`,
`controllers/sell-yours.controller.ts`, the `/seller/drafts*` half of
`routes/seller.ts`, and the storefront's `app/(app)/sell/` plus
`components/sell/`. Schema decisions: `db/schema/CONVENTIONS.md` §"The 'Sell
yours' seller draft (#91)".

## The failure mode this is shaped around

It is #58's, arriving through a button rather than through a crawler: **the false
merge**. A "Sell yours" flow is the most direct way to cause one — a person can
attach their listing to whatever product page they navigated from, and a
marketplace that took that on trust would let anybody put a counterfeit on a
flagship product's page with one tap. It looks exactly like a correct match, it
contaminates every price comparison downstream, and the person who finds it is a
customer.

The second failure mode is quieter and is the reason for half the vocabulary: a
saving that turns into **Mercaria asserting things on the seller's behalf**. The
catalogue knows the model has 256 GB and a Retina display; it knows nothing about
whether THIS one charges, what is in the box, or whether it is genuine. A flow
that prefills the first and lets it blur into the second has published a
specification as if a person had vouched for it.

## A seller's declaration is EVIDENCE, not a verdict

`services/sell-yours/match-gate.ts` runs at PUBLICATION, against the variant the
publication transaction has just created, and compares the seller's declared
canonical variant against the same pair-level facts #58's own scorer compares:
the listing's own validated identifiers, the brand, the pack count, the bundle
relation, the category, and any pair an operator has already rejected. A
disagreement REFUSES the attachment.

- **The refusing set is derived by SUBTRACTION from `MATCH_BLOCKERS`**, so a
  blocker #58 adds later refuses by default. The safe failure for a fact nobody
  has considered is to send the pair to a person.
- **Six blockers are exempt and every one is a property of a SCORER's
  uncertainty**, not a fact about the pair: `missing_required_attributes` (the
  axis was CHOSEN, not absent — applying it would refuse nearly every
  declaration, which is #58's own reason for not gating the identifier stages),
  `category_gate_closed` (a benchmark measures how often the MATCHER is right;
  a human declaration has no error rate it could be about), and
  `no_deterministic_support` / `below_auto_threshold` / `ambiguous_candidates` /
  `unresolved_product`, which all say the scorer was not sure about something
  nobody scored.
- **A refusal publishes the listing UNMATCHED**, which #91 listing creation 7
  requires to be a fully valid state anyway, and records the blockers on an
  append-only assertion row. The seller is told to change or remove the match;
  the canonical product is untouched, because nothing in this domain writes to
  it and a scanned gate says so.
- **A seller-declared attachment is never overwritten by a score.**
  `applyMatchOutcome` leaves a `seller_declared` link in place and logs the
  disagreement rather than superseding it — #80's `save_intent` pin, one layer
  down: the strongest signal anybody can give must not lose to an automatic one.
  The matcher's own decision row still records what it would have chosen, so
  "the matcher disagrees with this seller" is answerable by comparing the two.

`seller_declared` is a new `NativeListingLinkMethod` with NULL confidence, like
every non-`matcher` method: a person saying "this is the phone I am selling" has
no score, and a number beside it could only be read as doubt about a fact nobody
scored. What makes it trustworthy is not a threshold, it is the gate.

### What the gate can actually SEE today, stated rather than overclaimed

The gate reads the facts the listing's own variant carries, and a P2P listing
carries few of them: `listings.vendor` is NULL on every P2P listing,
`product_variants.barcode` is set only on store and connector variants, and a
P2P draft collects no structured attributes. So for a P2P declaration the
blockers that can actually fire today are **`blocked_pair`** (an operator
rejected exactly this subject and target), **`category_mismatch`** (the
listing's category and the product's disagree) and the relation blockers
(`bundle_mismatch`, `multipack_mismatch`, `accessory_mismatch`,
`replacement_part_mismatch`), which `detectRelation` derives from the seller's
own TITLE. `conflicting_identifier`, `brand_mismatch` and
`variant_attribute_mismatch` are wired and correct and will fire the moment a
variant carries the fact they read — which is true of every non-P2P subject the
same gate would be pointed at.

A scanned identifier is deliberately NOT written onto the listing as a claim: it
is used to FIND the candidate, and the flow cannot tell whether the box somebody
scanned matches what is inside it. Turning a scan into an assertion on the
listing is a decision about evidence, not a wiring gap, and it would need to be
made explicitly — the prefilled identifiers are `origin: 'canonical'`,
`confirmed: false` for exactly that reason.

### Where it sits in #80's confidence classification

`CONFIDENT_LINK_METHODS` is derived by SUBTRACTION, so adding a method makes it
confident — which meant the classification had to be re-read rather than left
alone. The answer is that `seller_declared` IS confident, for a reason that does
not apply to `matcher`: somebody named, who owns the item, agreed it, on a
surface that showed them the product, with the gate having refused it if any
deterministic fact disagreed. `matcher` lacks exactly that.
`sell-yours/__tests__/link-method-confidence.test.ts` pins the decision so it
cannot flip either way by accident, and `PRODUCT_SAVE_MIGRATION_VERSION` was
bumped because the rules changed — without the bump,
`UNIQUE(favorite_id, migration_version)` would stop a favorite an earlier run
skipped from ever being re-examined.

## Prefill is a provenance label

Every canonical value leaves `prefill.service.ts` inside a `SellerPrefillField`
carrying `origin: 'canonical'` and `confirmed: false`, and **the draft stores
none of it**: a read composes the prefill fresh from the live canonical rows and
puts whatever the seller typed on top. A copied title would survive a merge, a
rename and a correction, so a seller returning a week later would publish a
product name the catalogue no longer uses with nothing saying it was stale.

- `SELLER_PREFILLABLE_FIELDS` and `SELLER_OWNED_FIELDS` are **DISJOINT** tuples,
  gated by a test. Everything in the first is a statement about a MODEL — the
  class of fact that is identical for every copy of it in the world. Condition,
  evidence, photographs, accessories, price and fulfilment are in the second and
  can never join the first.
- The **reference image identifies the model and is never evidence**. It is
  carried as a bare `fileId` beside `SELLER_REFERENCE_IMAGE_NOTICE` — the
  `PRICE_HISTORY_DISPLAY_NOTICE` device, because the claim a stock photograph
  makes by accident is that it shows the item for sale, and the only place to
  refuse that claim is next to the picture. It is never copied into the draft
  gallery, and could not be: the trigger refuses a file id `canonical_images`
  claims.
- The storefront renders inherited facts through `InheritedFact`, muted, labelled
  "From the product — not a statement about your item", and the `origin` comes
  from the server rather than being computed client-side. A client that decided
  for itself would eventually decide that a value somebody scrolled past counts
  as confirmed.

## What the seller owns, and how #90 carries it

Condition, its disclosures, its acknowledgement and its photographs are #90's
vocabulary VERBATIM: `seller_draft_condition_details` holds the same kinds with
the same two shape rules `listing_condition_details` does, because these rows ARE
those rows one step before publication — the publish path hands them to
`resolveConditionInput` unchanged. A second vocabulary here would let a seller
disclose something on the draft that the listing has no way to record.

Three consequences worth stating:

- **A missing accessory is a `missing_accessory` disclosure, not an
  "accessories" field.** `included_accessories` holds what IS in the box; the
  absent parts go through #90's kind, which requires a written note and counts
  toward the disclosure gate. Two vocabularies would let a seller satisfy the
  gate by listing a missing remote as an inclusion.
- **A refurbished item names its refurbisher through a
  `repair_or_refurbishment` disclosure**, which #90 already requires to carry a
  note. No `refurbisher` column exists, so there is no second answer.
- **An acknowledgement covers what was disclosed WHEN it was given.** Adding a
  defect afterwards clears it. #90 stores an instant rather than a boolean
  precisely so "they agreed, to this" is answerable, and letting a later
  disclosure inherit an earlier consent would make the instant meaningless.

## Photographs must be the seller's own

`mercaria_seller_draft_reject_borrowed_photo` refuses two different things at
DRAFT time, one step earlier than #90's own trigger — because a draft's gallery
is what the publication copies into the listing, and catching it only at
publication would let somebody complete an entire flow and be refused at the
last step.

- A `file_id` any `canonical_images` row claims — the catalogue's own picture,
  which the provenance vocabulary cannot describe and therefore cannot stop.
- A `file_id` another ACCOUNT's `listing_images` row shows — the merchant-photo
  case #91 trust rule 2 names. **The seller's own listings are deliberately
  allowed**: a person relisting their own item is republishing their own
  photograph.

The service ALSO reads this and answers a field-level 400 naming the offending
file, so the seller is asked for a picture of their own rather than shown a
constraint name. The trigger is the authority; the read is the message.

## Price guidance cannot become a price

`SellerPriceGuidance` has no `suggestedPrice`, no `recommended`, no `autoFill`,
and each segment is a discriminated union whose `insufficient_data` branch
carries no figure at all — so a screen cannot render "we suggest 240" because
there is nothing to read, and cannot render a confident range from two
observations because the sample floor is applied in the service rather than left
to whoever draws the bar.

Four segments, four sources, each labelled:

| segment | source | floor |
|---|---|---|
| `current_same_condition` | live eligible offers, #57's own `listOffers` | 3 observations |
| `current_new` | live eligible offers, `new` group | 3 observations |
| `current_refurbished` | live eligible offers, `refurbished` group | 3 observations |
| `recent_sold_native` | paid P2P orders, #90's frozen line snapshot | 5 sales AND 3 distinct sellers |

- Reading the current segments through `listOffers` means a stale, retired or
  moderation-restricted offer cannot appear in guidance for the same reason it
  cannot appear in a comparison — with no second eligibility rule to keep in
  step.
- The sold segment matches on the ORDER LINE's condition snapshot, never the
  listing's current one: #90 froze what a buyer was shown and refuses every
  UPDATE to it, so reading the listing would let a later correction retroactively
  move an old sale between segments.
- **The sold segment's second floor is about people.** A range over five sales
  all made by one person is that person's sales history republished to whoever
  asks — #77's disclosure-floor reasoning on a different denominator. It is
  checked BEFORE the sample floor, because reporting `below_sample_floor` for a
  set that also failed the seller floor would disclose how many sales there were.
  `readRecentNativeSales` computes the distinct-seller COUNT in SQL, in a CTE, so
  no seller id ever leaves the database.
- An offer in a currency outside `ALL_CURRENCY_CODES` is EXCLUDED, exactly as #78
  excludes it from a series — comparing raw minor units would put 100 JPY beside
  100 EUR.
- **An extreme price WARNS and never blocks** (`SELLER_PRICE_EXTREME_FACTOR`,
  four times the same-condition range). Warnings and blocks are two lists rather
  than one severity scale, so a later "we should really stop them" cannot be
  expressed by nudging a number — #91 forbids blocking an unusual but valid price
  in the same sentence that asks for the warning.
- Guidance is **not** a ranking input and cannot become one: nothing here writes
  a row, and `sell-yours-isolation.test.ts` fails the build if a feed, search,
  catalogue or ranking module reaches this domain, or if this domain reaches the
  fee, referral, ranking or retail-pricing ones.

## Publication is exactly-once, in one transaction

Three mechanisms, none substituting for another:

1. `UNIQUE(oxy_user_id, client_draft_key)` — a retried "start selling" tap
   resumes the same draft rather than starting a second flow.
2. A row lock on the draft for the whole publication — two concurrent submits
   serialise, and the loser reads the winner's stamp instead of racing it.
3. The CAS in `stampPublication` plus the trigger refusing value→value — even a
   caller that ignored the lock cannot overwrite a stamped listing id.

The listing, its gallery, its condition evidence, its variant, its canonical
attachment and the stamp all commit **together**. That is what closes the window
the obvious implementation leaves open: create the listing, stamp the draft,
crash in between, and the retry creates a second listing because the draft still
says nothing was published. `insertP2PListingWithin` was extracted from
`createP2PListing` for exactly this, so the two paths share one body rather than
one being a copy that drifts.

`syncListingFacets` runs AFTER the commit. It enqueues the native-offer
convergence (#57) and the per-variant match request (#58), both durable outbox
rows whose whole point is surviving independently — enqueuing them inside would
tie a publication's success to a projection's.

## What is NOT built, and why

- **Serial numbers and proof of purchase are refused BY NAME** (#91 seller-owned
  field 10). `SELLER_PROOF_FIELD_KINDS` is in the vocabulary — so the gap is
  legible and enabling it later is not a schema change — and the API refuses each
  kind with the reason rather than "unrecognized key", the `role_email` (#83) and
  `replacement` (#110) device. The reason it is refused rather than stored: a
  protected identity-evidence store needs a READER, and the only legitimate one
  is a moderation review whose vocabulary CrowdSource owns (#90 made the same
  call about condition reason codes). A write-only encrypted column with no
  reviewer carries every risk of holding somebody's serial number and none of the
  benefit.
- **Collection is representable and refused** (`pickup_not_supported`). #93 owns
  pickup publication, freshness and collectable inventory, and #105's
  `assertPickupLocationEligible` already refuses every pickup at checkout against
  the same missing facts. Publishing a listing whose collection nothing honours
  would be worse than saying so.
- **#82's price signals are a named seam that fails closed.**
  `registerSellerPriceSignalProvider` is called by nothing, and the default
  reports NO signal rather than a neutral score — a screen cannot tell "the
  signal says this is fair" from "no signal exists", and only one of those is
  true.
- **Moderation reason codes for a wrong product match** belong to the CrowdSource
  plan, which owns that vocabulary (#90's precedent). What #91 supplies is the
  EVIDENCE a reviewer needs: the append-only assertion trail says who declared
  what, when, and what the gate said about it.
- **The canonical product page's `Sell yours` button** is #71's to place.
  `components/sell/SellYoursButton.tsx` exists so that placing it is one import
  rather than a decision about the flow's URL shape.

## Environment

```
SELL_YOURS_ENABLED=true                       # mounts /seller/drafts; never touches a stored draft
SELL_YOURS_GUIDANCE_OFFER_SAMPLE_SIZE=100
SELL_YOURS_GUIDANCE_SOLD_SAMPLE_SIZE=200
SELL_YOURS_DRAFT_LIST_LIMIT=25
SELL_YOURS_CANDIDATE_LIMIT=10
```

ONE lever, and it gates the MOUNT rather than a loop or a row. There is no
durable queue here for "gate the loop, never the record" to bite on — the
analogous mistake would be a flag that DELETED drafts, and nobody would pull that
lever either. **Deliberately absent: a flag that disables the match gate.** A
"just attach what the seller said" switch is the false merge with an off-switch,
and the incident it would be reached for during is precisely the one where it
must not be available.

## What is enforced by a test

- `sell-yours-isolation.test.ts` — the five walls above, each with a vacuity
  floor and a mutation self-test. Its own self-test caught a real gap in the
  commercial detector on the first run: the import pattern required a
  `services/` segment, which a SIBLING import (`'../fees/plan.js'`) does not
  have.
- `sell-yours.realdb.test.ts` — the exactly-once stamp (service CAS and database
  trigger separately), the append-only trail INCLUDING its cascade exception, the
  borrowed-photo refusal in both directions, the blocker-cardinality CHECK, the
  match-shape CHECK, an unmatched publication end to end, and the
  acknowledgement being cleared by a later disclosure. Its first run caught a
  real bug in the append-only trigger — an unconditional DELETE refusal made a
  draft undeletable — in the TEARDOWN rather than in an assertion.
- `link-method-confidence.test.ts` — the #80 classification decision, pinned in
  both directions plus the migration-version bump that came with it.
- `merge-plan-census.test.ts` (#59's) — refuses to build until each of the four
  new canonical references has a merge disposition with a reason.
