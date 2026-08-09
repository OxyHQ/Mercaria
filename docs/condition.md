# Item condition (#90)

The reference for the shared condition taxonomy, the evidence behind a stored
key, the versioned mapping of an external source's own words, and the two-phase
migration off the binary `new | used` field.

Schema decisions live in `packages/backend/src/db/schema/CONVENTIONS.md`
§"The condition taxonomy (#90)". The canonical entities this annotates are bound
by ADR 0002 (`docs/adr/0002-canonical-commerce-graph.md`); category-specific
condition facts belong to #94's registry (`docs/attributes.md`).

---

## What problem this solves

`new | used` could not say what a buyer needs to know, and its failure mode was
silent: two listings carrying the same label described a sealed retail box and a
cracked phone that will not charge. Neither the seller nor the buyer was lying;
the field had nowhere to put the difference.

Answering it needs four things the binary field had none of:

1. A **stable, shared vocabulary** wide enough to distinguish an open-box return
   from a manufacturer refurbishment from a salvage shell.
2. **Evidence** — a used listing describes ONE physical object, and a catalogue
   photograph says nothing about it.
3. A way to record an external source's own wording, **and to correct how it is
   read without rewriting what was already observed**.
4. A migration that **does not upgrade anybody's stock** on the way.

## The taxonomy

Nine keys, in `@mercaria/shared-types` `./condition`:

| Key | What the seller is stating |
|---|---|
| `new` | Unused and unopened, in the manufacturer's packaging |
| `open_box` | Never used, packaging opened — a return or display unit |
| `refurbished_manufacturer` | Restored and re-certified by the manufacturer |
| `refurbished_seller` | Restored by the seller or a third party, who is named |
| `used_like_new` | Used, no visible wear at normal viewing distance |
| `used_good` | Used, light wear that does not affect function |
| `used_fair` | Used, obvious wear or a disclosed minor fault |
| `used_poor` | Used, heavily worn or a disclosed fault that affects use |
| `for_parts` | Sold as non-functional — repair, salvage, components |

**Stored keys are stable; the copy is not.** Labels, explanations and segment
names live in `@mercaria/ui` `lib/condition.ts`, because #90's base taxonomy
says the exact wording is still to be finalized with localization and
marketplace-policy review. That is the #94 registry's rule, one domain over: a
stored value cites a key and never a label.

### Segments

Five `ConditionGroup`s — `new`, `open_box`, `refurbished`, `used`, `for_parts` —
and every filter, price-history segment and price alert operates on the GROUP.
`open_box` is its own segment rather than folded into either neighbour, because
folding it would make one of the two filters lie.

The taxonomy tuple's ORDER is the sale-quality order and
`compareConditionQuality` reads it, but it is deliberately not a score: nothing
multiplies, ranks or prices against a position. Ranking is #74's, and
`condition-isolation.test.ts` fails the build if a ranking module reaches this
domain.

## Evidence

`CONDITION_EVIDENCE_POLICIES` is a TABLE, one row per key — the
`claim-methods.ts` device from #83. Nothing in the evidence path ever asks "is
the condition used"; adding a key changes one table and no `if`.

| Key | Photos | Minimum | Acknowledge defects | Name the refurbisher |
|---|---|---|---|---|
| `new` | no | 0 | no | no |
| `open_box` | yes | 1 | yes | no |
| `refurbished_manufacturer` | yes | 1 | yes | **yes** |
| `refurbished_seller` | yes | 2 | yes | **yes** |
| `used_*`, `for_parts` | yes | 2 | yes | no |

The boundary is NOT "used": an open-box or refurbished unit is also one specific
physical object whose state a buyer cannot infer from the catalogue, which is
exactly what a stock photo cannot answer.

### A catalogue image can never be evidence (acceptance 4)

Three independent layers, and only the second one stops the real attack:

1. **The vocabulary.** `ConditionPhotoProvenance` has only seller-owned members,
   so there is no VALUE meaning "a catalogue image".
   `FORBIDDEN_CONDITION_PHOTO_PROVENANCES` names six that may never be added and
   a build gate asserts the two sets are disjoint.
2. **The database.** `mercaria_reject_canonical_condition_photo` refuses a
   `file_id` any `canonical_images` row already claims. The attack the
   vocabulary cannot see is a seller attaching the manufacturer's own product
   shot — a perfectly ordinary Oxy media id that no service-layer check can
   recognise. `canonical_images_file_id_idx` exists for this trigger.
3. **The gate.** Only photos in `EVIDENTIAL_CONDITION_PHOTO_STATES` (`pending`,
   `approved`) count, so a listing whose evidence was rejected stops meeting its
   own condition's requirement rather than keeping a pass it earned once.

Evidence is drawn from the listing's OWN gallery. There is deliberately no
second upload channel: the seller attaches images as they always have, the ones
that are theirs become evidence rows carrying who attached them and when, and
`photoAnnotations` only say which of them show which defect. Two places where a
photograph's ownership could be established could disagree about the one thing
this domain has to be sure of.

### Disclosures

`listing_condition_details` — seven kinds, a real table rather than a `jsonb`
bag. `CONDITION_DISCLOSURE_KINDS` (`cosmetic_wear`, `functional_defect`,
`missing_accessory`) is what the acknowledgement gate reads: a seller who added
only `original_packaging: present` has acknowledged nothing, and letting that
satisfy the gate would turn an affirmative disclosure into a checkbox.

`CONDITION_DETAIL_KINDS_REQUIRING_NOTE` demands a written description where a
bare flag says nothing — "there is a fault" is not a disclosure.

### What is NOT here

Battery health, activation/lock status and garment alterations —
`CONDITION_REGISTRY_DELEGATED_FACT_KEYS`. They are attributes of a CATEGORY and
belong to #94's versioned registry: `battery_health_percentage` means nothing on
a sofa, and a nullable top-level column for it would be an unversioned second
vocabulary beside a registry that already versions its meanings and records which
ruleset read each value. A build gate asserts no condition table grows a column
for one.

## Mapping an external source's words

`condition_mapping_rulesets` holds one VERSION of one provider's rules;
`condition_source_mappings` holds the rules. An offer records which version read
its label, so correcting a rule is publishing v2 — nothing re-reads an existing
observation, which is #90 migration rule 5.

`ConditionMappingState` is what makes acceptance 5 unrepresentable rather than
promised:

| State | Means | May carry a key |
|---|---|---|
| `declared` | A first-party declaration (a native listing's own key) | yes |
| `mapped` | A label resolved at or above `CONDITION_MAPPING_CONFIDENCE_FLOOR` | yes |
| `unmapped` | A label nothing matched, or none published | **no** |
| `review_pending` | A rule matched BELOW the floor | **no** |

Five `offers_condition_*_shape_check` constraints hold the combinations. There is
no state in which a guess carries a taxonomy key, so a mapper bug, a replay and a
manual `UPDATE` all fail rather than putting a maybe on a product page.

Sub-floor rules are RECORDED, not discarded: a rule below the floor is a
legitimate, reviewable statement that a source's wording probably means
something. What it may not do is reach an offer.

Absence, no rule and a weak rule are three different outcomes, and collapsing the
last two would lose the difference between a taxonomy gap and a calibration
problem.

## Corrections

`listing_condition_revisions` is append-only by trigger. UPDATE is refused
outright; DELETE is refused only while the listing still EXISTS, which is the
precise version this table needs — the foreign key already says `cascade`, so an
unconditional refusal would make a listing undeletable, while an unconditional
permission would let an operator delete one correction to hide it.

`actor_kind` is a discriminated union in TypeScript AND a CHECK in Postgres: a
person is named, a backfill is not, both directions. Recording a user id against
a migration is a lie in an audit table; an anonymous operator correction is an
unattributable one.

A condition cannot be corrected once the listing is `sold`. That is about the
LISTING, not the orders: an order line already snapshotted what the buyer was
shown and refuses UPDATE outright.

## Domain propagation

- **Listings** carry `condition`, `condition_assertion`, an optional
  `condition_source_label` and `condition_acknowledged_at`.
- **Offers** carry the normalized key, the source's verbatim wording, the mapping
  state, its confidence and the ruleset that produced it.
  `deriveOfferCondition` gives `group` EXACTLY when the key is known — a
  comparison bucketing by `condition.group` drops the unknown ones, which is
  correct, whereas `?? 'new'` would tell a shopper an unlabelled feed item is
  sealed.
- **Order items** snapshot `condition_key`, `condition_assertion` and flattened
  `condition_notes` at purchase. All three refuse UPDATE.
- **Search** takes `conditionKeys` and `conditionGroups`, unioned into ONE
  membership test — two ANDed `IN` lists would answer the empty set for exactly
  the requests that combine a segment and a key.
- **Reviews** already separate the questions: #76's `p2p_listing` scope carries
  `condition_accuracy`, so "did it match its description" never blends into the
  product's own quality rating. #90 adds nothing there.

## The v1 compatibility contract

This is the ONE compatibility surface #90 adds, and it exists for the reason
`checkout`'s `addressId` does: a shipped mobile build cannot be recalled. It is a
CONTRACT with a stated retirement condition (`LEGACY_CONDITION_CONTRACT`), not a
deprecated alias — nothing is marked `@deprecated`, and the projection is
COMPUTED rather than stored so there is no second value to keep in step.

- **Writing.** `condition: 'new' | 'used'` is accepted beside `itemCondition`,
  and sending BOTH is a 400 rather than a precedence rule nobody would remember.
  A v1 `used` lands on `used_good` and records `legacy_client_binary`, which the
  `listings_unrefined_condition_check` CHECK then restricts.
- **Reading.** `Listing.condition` is derived from `itemCondition.key` on every
  read: everything outside the `new` group reads `used`. A v1 client has no way
  to render `for_parts`, and telling it `new` would put a salvage shell in a
  "brand new" filter.
- **Filtering.** `?condition=used` selects every non-`new` GROUP — the honest
  reading of what a v1 client is asking for.

It retires when no supported client version still sends or reads the binary
field. That condition is observable; acting on it is a release decision, which is
why `retiresWhen` is prose rather than a date.

## The migration

Two phases, and the split is the deploy-phase rule working.

**The `pre` half (additive).** New tables and columns; both condition CHECKs
widened to a SUPERSET including the legacy `'used'`; every row backfilled; the
four trigger pairs; one `migration` revision per listing so a seller finds the
answer where every other condition change is recorded. New NOT NULL columns
carry defaults the previous image's inserts satisfy without knowing they exist.

**The `post` half (the clean cut).** Both CHECKs narrowed to the taxonomy;
both defaults dropped. Every statement breaks a write the previous image
performs, which is what makes it `post`.

The mapping is #90 migration rules 1 and 2: `new` → `new` exactly, `used` →
`used_good` — the conservative generic member, never `used_like_new`. That is
NOT left to the backfill's care: `listings_unrefined_condition_check` refuses any
other value beside a `migrated_binary` assertion, so a hand-written variant of
the UPDATE fails rather than silently upgrading a seller's stock.

Existing listings stay purchasable (acceptance 1). The evidence gate runs on
WRITE, so a migrated listing needs no photographs until its seller next states a
condition — which is exactly how "sellers may refine current active used
listings after migration" (migration rule 4) works: refining is sending
`itemCondition`, and `refined` is DERIVED from the assertion rather than stored
beside it.

The `pre` half carries hand-written statements drizzle-kit cannot model, in TWO
blocks with unambiguous anchors (`#90 BACKFILL`, `#90 TRIGGERS`). Regenerating
the file drops them; the header says where each goes and why the ordering is
load-bearing. Neither header names a migration INDEX — those shift every time
this work rebases behind another branch, and a header naming a number goes
stale silently.

## API

Public:

| Route | Answers |
|---|---|
| `GET /listings?conditionKeys=&conditionGroups=` | Filter by key or segment (#90 acceptance 2) |
| `GET /listings?condition=` | The v1 spelling; mutually exclusive with the two above |
| `GET /offers?conditions=` | The comparison read, filtered by key |
| `POST /seller/listings`, `PATCH /seller/listings/:id` | `itemCondition` (or the v1 `condition`) |

Operator — `/internal/catalog-condition`, behind `CATALOG_OPERATOR_OXY_USER_IDS`
(empty ⇒ not mounted, 404):

| Route | Does |
|---|---|
| `GET /mapping-rulesets/providers/:provider` | A provider's ruleset history |
| `POST /mapping-rulesets` | Open a DRAFT version |
| `GET /mapping-rulesets/:id` | One ruleset and its rules, sub-floor ones included |
| `PUT /mapping-rulesets/:id/mappings` | Replace a DRAFT's rules |
| `POST /mapping-rulesets/:id/publish` | Publish, superseding the incumbent |
| `PUT /category-policies` | Record or correct one category restriction |
| `GET /category-policies/:categoryId` | The restrictions on one category |
| `DELETE /category-policies/:categoryId/:conditionKey` | Lift one |
| `GET /listings/:listingId/history` | One listing's condition revisions |

There is deliberately no "set this listing's condition" and no bulk photo
approval: a condition is what a SELLER states about their own item, and listing
imagery is moderated by the CrowdSource path that already owns it.

## Category restrictions

`condition_category_policies` names what is FORBIDDEN; absence means allowed.
Default-allow is the honest direction and not a fail-open reflex: the taxonomy is
universal, a restriction is a statement somebody made about a specific category,
and a category with no rows means "nobody has restricted this" — which is true —
rather than "everything is forbidden until an operator enumerates nine
permissions per category", which would refuse the entire catalogue on the day
this ships.

The refusal quotes the operator's own recorded reason. A generic message would
be safe and useless: safety and legal restrictions are exactly the ones a seller
needs stated.

## UI

`ConditionBadge` in `@mercaria/ui` renders the label as TEXT in neutral chrome
(#90 policy rule 3), never a colour scale. The obvious green→amber→red design
fails twice: it is inaccessible, and it is a QUALITY VERDICT — a red `for_parts`
badge tells a shopper the listing is bad, when for-parts is a legitimate,
correctly-labelled thing to sell.

`CONDITION_DISCLAIMER` states #90 policy rule 7 in a sentence: the label is the
seller's statement, not Mercaria's verification of it.

The `refined` flag is deliberately not rendered on a product page. A migrated
listing is a real listing a buyer can buy; the prompt to refine belongs on the
seller's own dashboard, where it reads as an unfinished form rather than a defect
in the item.

## What this issue deliberately did NOT build, and who owns it

- **Ranking by condition (#74).** Nothing here scores a key for placement, and a
  build gate fails if a feed, search, collection or collection-rule module
  reaches this domain's evidence, disclosures or mapping rules. Filtering
  `listings.condition` — a column those modules already read — is #90
  propagation rule 4 and is a different thing.
- **The price-history TABLE and price alerts (#78).** `ConditionGroup` is the
  SEGMENT those must not mix (#90 propagation rule 5), and `conditionGroupFor`
  is the seam. The table is #78's.
- **Moderation reason codes for misleading condition or stock imagery
  (#90 policy rule 6).** The CrowdSource plan owns the reason-code vocabulary;
  Mercaria maps `recommendedActions` and does not invent findings. What #90
  supplies is the evidence a reviewer needs: photo provenance, upload time and
  moderation state on every row.
- **A seller-facing refinement UI.** `refined` is derived and served; the
  dashboard surface that prompts on it is not built here.
- **Bulk re-mapping of already-observed offers.** Publishing a ruleset version
  re-reads nothing, by design. A re-observation sweep is the ingestion path's
  (#37).
