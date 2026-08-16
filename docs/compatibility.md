# Compatibility and automotive fitment (#367 step 8)

> Binding decision: **ADR 0007 D8**, constrained by D1 (identity is an opaque id
> plus a stable machine key, never a label), D6 (an axis is an attribute, and a
> compatibility target is refused as one), D7 (a source's claim and a canonical
> fact are different rows) and D13 (nothing existing is re-modelled).
> Schema decisions: `packages/backend/src/db/schema/CONVENTIONS.md`.

"Does this fit?" is a relationship between two catalogue identities. This domain
answers it for accessories, replacement parts, consumables and software, and for
vehicles — which is the hard case, and the one every decision below is shaped
around.

## The sentence the whole domain exists to hold

**A year range, a make or a model may never be stored as a variant option.**

A mid-range brake pad fits on the order of a thousand vehicle configurations.
Expressed as variant options that is one SKU with a thousand variants: a thousand
rows of stock nobody counts, a thousand canonical variant signatures that
describe a car rather than a part, a thousand offers to compare against each
other, and a variant matrix the authoring wizard (D10) would try to render. The
part did not change. Only the question did.

Two independent walls hold it, in opposite directions, and neither is a rule
somebody follows:

- **No module of this domain can write an option row.** Not by policy — by the
  import graph. Nothing under `services/compatibility/` or `db/compatibility/`
  names `listing_options`, `product_variant_option_values`, their drizzle
  constants, or the two repositories that write them.
- **No option-writing module can reach this domain**, so a vehicle fact cannot
  arrive at those tables through the front door either.

`services/compatibility/__tests__/compatibility-isolation.test.ts` scans both,
plus a third census over the real drizzle columns of both option tables. That
third one is deliberately a COLUMN census and nothing more: the option tables
store their axis in a free-text `name`, and no static gate can see a VALUE. The
value-level guarantee is the first wall; the census catches the other shape of
the same mistake — somebody adding `listing_options.vehicle_generation_id`
because it seemed like the tidy place for it.

D6's axis CHECK (refusing a compatibility target as an axis) is the other half
and belongs to merge-order step 4. The two are independent walls around one hole.

## Unknown is not false

`CompatibilityApplicability` has FOUR members and `does_not_apply` is a different
value from `unknown`, not a nullable boolean's two faces.

| Value | Means |
|---|---|
| `applies` | It fits, on the terms this row states. |
| `partially_applies` | It fits some of what the target names, and the row says which through its conditions. |
| `does_not_apply` | A POSITIVE statement that it does not fit. Somebody established this. |
| `unknown` | Nobody has established anything. |

A shopper told "does not fit" ACTS on it — they buy something else, or they
return the part they already bought. So reporting an absence of data as a refusal
is a wrong answer with a consequence, and reporting a refusal as an absence sells
somebody a part that will not go on their car. A nullable boolean can express
three of these and conflates the two that matter most.

`resolveApplicability` is the severity rule that keeps them apart:
`does_not_apply` beats `unknown` beats `partially_applies` beats `applies`, so a
set of claims about one pairing can only ever resolve UPWARD in caution. An empty
set is `unknown`, never `does_not_apply`.

## An exclusion is an ordinary row

`FITMENT_TARGET_SCOPES` is a ladder — make, model, generation, configuration —
ordered broadest first, and `resolveFitment` lets the NARROWEST scope that said
anything decide. That single ordering is why exclusions need no separate table
and no `is_exclusion` boolean:

- "Fits the 2012–2019 Golf" is a generation-scoped `applies`.
- "But not the GTI" is a configuration-scoped `does_not_apply`.
- "Does not fit the Focus, EXCEPT the 2019 facelift" is a model-scoped
  `does_not_apply` with a configuration-scoped `applies` under it — and the
  specificity rule works in that direction too, which is what makes it a
  specificity rule rather than a pessimism rule.

Within one scope, `resolveApplicability` decides, so two sources contradicting
each other at the same specificity resolve to the more cautious answer rather
than to whichever row was written last.

A make-scoped fitment is rare and legitimate — a universal wiper connector, a
manufacturer-wide diagnostic tool — and having the scope means such a claim does
not have to be exploded into ten thousand configuration rows that then rot
independently.

## A claim and a selected fact are different rows (D7)

`compatibility_claims` keeps what a source SAID, verbatim, including a target
Mercaria could not resolve. `generic_compatibility_relations` and
`automotive_fitments` hold the canonical answer.

- **A claim never becomes canonical by being stored.** `recordCompatibilityClaim`
  creates no relation, whatever the claim says and whoever made it; its return
  type has no relation id to hand back. A feed asserting a million fitments
  produces a million claims and zero published facts.
- **`promoteClaimToRelation` / `promoteClaimToFitment` are the other half** — an
  explicit act that opens the canonical row and marks the claim as the one it was
  selected from, in ONE transaction.
- **An unresolved claim is a first-class outcome.** There is deliberately no code
  path that DROPS a claim Mercaria could not read: the class of claims that
  resolve to nothing is the one an operator most needs, because it is the only
  evidence of what a feed was trying to say, and a feed whose format changed
  produces thousands of them at once — which is a signal, and an empty table is
  not. `countUnresolvedBySource` reports the breakdown BY REASON, because
  `unknown_target` at scale means the vehicle tree is missing rows somebody can
  import while `unparsed_target` at the same scale means no amount of reference
  data will help.
- **The raw text is frozen by trigger** and DELETE is refused outright. The edit
  that would actually happen is not malice — it is a re-import that finds the row
  and updates every column, quietly replacing the raw text an operator was about
  to read.

## A title can never establish a fit

`COMPATIBILITY_VERIFICATION_METHODS` has no `title_similarity`, `name_match` or
`category_match` member, so "verified because the names looked alike" has no
value to be stored as. `COMPATIBILITY_FORBIDDEN_VERIFICATION_METHODS` names seven
prohibitions as VALUES and a test asserts the two unions are disjoint.

The reason is sharper here than in #55: two products whose titles match to four
decimal places are routinely a 2016 part and a 2017 part that do not interchange.

`disputed` is the sixth verification state and the divergence from #55's five
that earns this domain its own tuple. A brand relationship has one truth and a
rival claimant is a dispute about who holds it; a compatibility claim can have
two well-sourced parties flatly contradicting each other about one pairing — the
manufacturer's catalogue and an aftermarket supplier's, routinely — and that has
to be storable without either being called `rejected`. A `disputed` relation
publishes `unknown`, never a side.

## The publication policy, and its asymmetry

`services/compatibility/compatibility.service.ts` and `fitment.service.ts` both
publish a positive claim only from `verified`, and a NEGATIVE one from
`verified`, `candidate` and `disputed`.

An unreviewed claim that a part FITS is a guess somebody would spend money on. An
unreviewed claim that it does NOT is a reason to check, and suppressing it sells
the part anyway. "We are not sure this fits" is the cheapest possible thing to be
wrong about.

## The seven tables

| Table | Holds |
|---|---|
| `generic_compatibility_relations` | The selected canonical answer for a non-vehicle pairing. |
| `compatibility_claims` | What a source said, for BOTH halves of the domain. |
| `vehicle_makes` | A manufacturer, as vehicle reference data. |
| `vehicle_models` | One model line of one make. |
| `vehicle_generations` | One production run of a model. |
| `vehicle_configurations` | One buildable specification within a generation. |
| `automotive_fitments` | One statement that a part does (or does not) go on a class of vehicle. |

Design notes worth reading before editing any of them:

- **`vehicle_makes` is deliberately NOT `brands`.** A brand (#54/#55) is a
  commercial identity that can be owned, claimed, verified and badged; a make is
  a classification node in a fitment tree, and a fitment claiming "fits
  Volkswagen" asserts nothing about Volkswagen the organization. Collapsing them
  would let a vehicle-data import mint rows in the table #55's badges are keyed
  on — and, in reverse, would make a brand merge rehome fitments.
- **`UNIQUE(make_id, key)` on models, not a global unique on `key`.** `golf` is
  Volkswagen's and nobody else's, but `focus`, `civic` and `500` recur across
  manufacturers, and a global unique would make the SECOND importer of a
  colliding name unable to store a real model. That is `product_variants.sku`'s
  finding (#296) asked of a different column: what does a legitimate second row
  look like?
- **A generation's production span and a configuration's availability span are
  different facts.** A generation ran 2012–2019; the 2.0 TDI within it was
  offered 2012–2016 and the facelift engine 2017–2019. Storing one and deriving
  the other puts every configuration on a span nobody offered it for.
- **Every discriminating column on a configuration is nullable**, and that is the
  design. A configuration imported from a feed that publishes engine and body but
  not transmission is a real, useful row, and defaulting the missing one would
  put a fabricated fact into a column a shopper filters on.
- **There is no evidence table.** #55 has one because a brand relationship's
  proof is a document with a digest that outlives the claim. A compatibility
  claim's evidence IS the claim: what a source said, where, when, and with what
  raw text.
- **No labels beyond `name`.** Localized display belongs to the localization
  family (D4), which is merge-order step 2 and a different module. A typed
  compatibility target carries a namespaced KEY (`connector.usb_c`) and no
  display string at all — a label here would be a second name for the concept,
  unlocalized and unversioned.
- **No VIN, plate, buyer, order or price column exists anywhere.** A VIN
  identifies one physical car with an owner and a service history attached.
  `COMPATIBILITY_FORBIDDEN_SUBJECT_FACTS` names six such facts and a column
  census walks all seven tables against it, with the three ATTRIBUTION columns
  (`verified_by_oxy_user_id`, `revoked_by_oxy_user_id`,
  `reviewed_by_oxy_user_id`) exempted by an exact-count list that also asserts
  each exempted column really exists.

## Reverse lookup is an index, not a second row

`COMPATIBILITY_DIRECTIONS` has two members, not three: "B fits A" is the row
"A fits B" with its endpoints swapped, and admitting both spellings means one
fact has two rows that can be verified separately, expire separately and
eventually contradict each other. `mutual` exists because `works_with` genuinely
is symmetric and forcing a direction onto it would make the choice of subject
arbitrary — and an arbitrary choice is one a second source makes differently.

D8 requires "accessories compatible with this product" to be an indexed read.
Four target-side partial indexes serve it, one per target kind, each leading with
the target id and carrying the kind and the verification state. Two subject-side
indexes serve the forward question. Six indexes on one table is a lot, and it is
the cost of a relation genuinely read from both ends.

`listFitmentsForVehicle` is the one to read before editing: it takes a vehicle
ANCESTRY and returns every fitment attached at ANY of the four levels, in one
statement, with each branch pairing the SCOPE with the id. The pairing is
load-bearing — `vehicle_model_id` is set on model-, generation- AND
configuration-scoped rows, so a bare `vehicle_model_id = $1` would return every
generation-specific fitment to a shopper who only told us the model.

## What is enforced by the database

`compatibility.realdb.test.ts` drives all of it against a real server. The two
worth naming:

- **`cardinality`, never `array_length`.** On an empty array `array_length` is
  NULL and a CHECK rejects only FALSE, so `array_length(col,1) >= 1` ADMITS `{}`
  — the exact row it exists to refuse. This schema has hit that twice (#68). The
  suite asserts the arithmetic itself, and the mutation was measured: swapping
  the spelling turns the `partially_applies` case red.
- **Two implications, because the claim states partition THREE ways.**
  `unresolved` must point at nothing, `selected`/`corroborating`/`conflicting` at
  exactly one row, and `rejected`/`superseded` at either — a claim rejected
  before anybody attached it never had a target. A biconditional expresses two
  groups, so the tempting single constraint
  `(state = 'unresolved') = (num_nonnulls(...) = 0)` refuses exactly the
  rejection an operator makes on an unparseable claim. Also measured: it turns
  the rejection case red.

Six triggers, all in `db/schema/compatibility.pending.sql` until the migration
slot lands:

| Trigger | Refuses |
|---|---|
| `mercaria_vehicle_makes_key_freeze` (and three siblings) | Renaming a vehicle record's stable key. A wrong key is corrected by a MERGE, never a rename — to every seed and mapping that cited the old key, a rename is indistinguishable from the concept having been deleted. |
| `mercaria_automotive_fitment_ancestry` | A fitment whose denormalized `vehicle_make_id` disagrees with its narrower target. A Ford part claiming a Volkswagen generation would render perfectly and answer the picker under both. |
| `mercaria_compatibility_claims_raw_freeze` | Editing what a source said, and deleting a claim at all. |

Two generated columns, `relation_key` and `fitment_key`, carry the
duplicate-prevention uniques. The raw columns cannot: Postgres treats NULLs as
distinct, and three of the four target pointers are NULL on a make-scoped row.
`position` is IN the fitment key and the qualifiers are not — one part
legitimately has a front and a rear fitment on one car, while two rows differing
only by qualifier are one fact stated twice.

Both keys are re-rendered in TypeScript (`relationKeyOf`, `fitmentKeyOf`) so a
conflicting row can be read back, and the realdb suite compares each against the
value Postgres actually stored. A second spelling of a generated expression is a
thing that can disagree.

## Seams, each named rather than stubbed

- **The merge plan (#59).** Nine columns of this domain reference a mergeable
  canonical entity and each needs a disposition in `services/curation/merge-plan.ts`
  before the census will pass. They are listed in the PR that lands this domain.
- **D6's axis CHECK** (merge-order step 4) — the other wall around the option
  tables.
- **The localization family** (merge-order step 2) — every display name for a
  vehicle record and a typed target.
- **Ranking (#74).** A scanned gate keeps this domain out of it: "fits your
  vehicle" is an eligibility fact a shopper asked for, not a weight.
- **The public and operator HTTP surfaces.** This issue ships the domain, its
  reads and its gates; the routes belong with the storefront work that renders
  them.
- **A vehicle picker's own reference-data import.** `upsertVehicleMake` and its
  three siblings key on the stable machine key and are ready for one; no adapter
  is registered, so nothing populates the tree today.
