# Typed variant axes and retained seller claims (#367 step 4)

ADR 0007 **D6** and **D7**. What a product varies along stops being display text
and becomes a reference into #94's versioned attribute registry — and what a
merchant, a connector or a legacy option row *said* is kept, verbatim, whether or
not anybody can ever type it.

The failure mode that shapes all of it is named in the ADR itself: **inventing a
normalization for `Tono` because it looks like `Color` is the false merge #58 is
shaped around.** It is silent, it looks exactly like a migration working, and it
is found by a seller whose blue shoes are listed under somebody's idea of black.

---

## The five tables

| Table | Answers |
|---|---|
| `native_listing_variant_axes` | which dimensions does THIS listing vary along? |
| `native_variant_axis_assignments` | what is this variant's value on each of them? |
| `native_variant_signatures` | which variant IS this, independent of entry order? |
| `native_listing_attribute_claims` | what did a party assert about this listing? |
| `native_variant_attribute_claims` | what did a party assert about this variant? |

Schema decisions: `packages/backend/src/db/schema/CONVENTIONS.md` §"Typed variant
axes and retained claims (#367 step 4)". Nothing here replaces `listing_options`
or `product_variant_option_values` — ADR 0007 D13 retains both and no module in
this domain can write either (a scanned gate).

### Why the signature is its own table

A variant's identity is a digest over its whole assignment SET, and a variant
with ZERO axes has no assignment rows. "Zero, one and many axes are all
supported" is not expressible any other way, and the zero-axis variant is the
commonest row in this catalogue — a listing with one default variant. It also
carries `UNIQUE(listing_id, signature)`, which is the collision gate: two
variants that vary along nothing are one variant, and the database says so.

---

## The rules that are load-bearing

- **An axis cites `attribute_definition_id` plus its version, never a string.**
  The `attribute_key` and `attribute_definition_version` columns beside it are a
  GUARDED denormalization — they exist so the forbidden-axis prohibition can be a
  CHECK (a CHECK admits no subquery) — and
  `mercaria_native_variant_axis_citation()` refuses any row whose citation
  disagrees with the definition its foreign key names. The
  `product_type_fields` device, one table over, for the same reason.

- **The prohibition is rendered from `PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS`,
  not copied.** Two tables, one list: #94 widening the reserved offer facts
  widens both. A price, a stock level, a seller's condition and every
  compatibility target are refused as axes at the native grain as well as the
  product-type one — one brake-pad SKU fits four hundred vehicles and stays ONE
  variant (ADR 0007 D8).

- **Permission is checked at TWO grains and only one of them needs a product
  type.** `attribute_definitions.variant_defining` is the registry's answer and
  is checked on every row; `product_type_fields.variant_capable` + `scope =
  'variant'` is the product type's narrower answer and is checked when a version
  is cited. `product_type_definition_id` is NULLABLE precisely because
  `listings` carries no product type until ADR 0007 D10's authoring workstream
  widens it — a NOT NULL citation would make this backfill unable to type a
  single axis, and a backfill that resolves nothing is not a safer backfill, it
  is a vacuous one.

- **The signature is order-independent by construction.** Sort the normalized
  `(attribute_definition_id, normalized_value)` pairs, join with ASCII control
  separators, hash. `position` is display order and is deliberately not an input.
  `TYPED_VARIANT_SIGNATURE_VERSION` is `t1` rather than `v1` so nothing reads it
  as comparable with #56's canonical signature, which hashes KEYS instead of
  versions and always produces a different digest.

- **Hashing the version has a stated consequence.** Publishing a new version of
  `color` and re-declaring a listing's axis under it changes every one of that
  listing's signatures. That is #94's posture applied to identity — a meaning
  change schedules a recompute rather than reinterpreting facts — and it is why
  the axis row is FROZEN: a version bump is a NEW axis, and the old one cascades
  its assignments away rather than leaving them normalized under a meaning nobody
  can name.

- **Matrices are sparse, structurally.** There is no function in the domain that
  takes an axis list and returns a set of combinations, and
  `variant-axis-isolation.test.ts` fails the build if one appears. A 4-colour ×
  5-size listing with three real SKUs writes three signatures and six
  assignments, not twenty.

- **A signature covers the assignments that exist, checked at COMMIT.**
  `mercaria_native_variant_signature_agrees` is a DEFERRABLE constraint trigger
  mounted on BOTH tables and on all three operations — the
  `mercaria_catalog_source_rights_agree` device. Writing a variant's axes touches
  two tables and one of them is always first, so no statement order makes every
  intermediate state consistent. What it catches is an assignment inserted or
  removed without the digest being recomputed, which otherwise leaves two
  distinct variants colliding or one failing to. What it does NOT catch is a
  digest over the right NUMBER of wrong values; the realdb suite covers that
  half.

- **A claim and a canonical fact are different rows, both retained (D7).** The
  claim tables reference no canonical, brand, organization or merchant table —
  asserted by a foreign-key walk with a vacuity floor —
  `NATIVE_CLAIM_FORBIDDEN_TARGETS` names the six prohibited identities as VALUES
  disjoint from `NATIVE_CLAIM_SUBJECTS`, and a scanned gate covers the whole
  directory so the wall holds for modules nobody has written yet. It is also why
  these five tables need no `services/curation/merge-plan.ts` entry: that census
  walks foreign keys onto MERGEABLE entities and every target here is a native
  listing, a native variant, an attribute definition, an enum value, a connection
  or a product type version.

- **Every "the typed columns are present" rule is a BICONDITIONAL.** A one-way
  `resolved ⇒ value present` still admits a BLOCKED claim carrying a normalized
  value, which is exactly "we could not tell, so we stored our best guess". The
  refusal pairs are written as TWO biconditionals and never one over their
  conjunction — the collapsed form is satisfied by a row where every side is
  false, which admits precisely the row the rule exists to refuse (measured twice
  already in this schema, both times by a real server).

- **A claim is FROZEN and undeletable while its subject lives.**
  `mercaria_native_*_claim_frozen` refuses any UPDATE that moves the raw text, the
  subject, the provenance or the assertion instant; only the resolution moves.
  `mercaria_native_claim_no_delete` refuses a DELETE **only while the parent row
  exists** — the #90 revision-trail device, and the precision is the point: a
  blanket refusal would fire during the cascade from `listings` and make a
  listing undeletable.

- **The backfill invents no provenance.** `legacy_option_migration` names exactly
  what is known — this text was preserved from the pre-typed option columns — and
  a CHECK refuses such a row carrying a claimant. The legacy rows record neither
  who asserted a value nor when, so a claim naming either would be a fact nobody
  observed. The assertion INSTANT comes from the legacy row's own `updated_at`,
  never the migration's clock.

- **A claim converges on the CONTENT, value included.** `<table>_identity_key`
  is `(subject, provenance, [kind,] raw_name_normalized, raw_value_key)`, both
  key columns GENERATED so the stored spelling and the lookup key cannot
  disagree. `ON CONFLICT DO NOTHING` makes a repeat a genuine no-op — no tuple
  version, no timestamp, no lock — because a repeat is ordinary. What must NOT
  converge is a party changing their mind: `Black` becoming `Jet Black` is a NEW
  assertion and D7 retains both.

- **The review queue is the claim rows, not a table.** A queue table would be a
  second representation of what the claim already says, and the two would
  disagree the moment a resolution changed without the queue row being updated —
  the failure mode of every cached verdict in this repository.
  `<table>_queue_idx` is a partial index the size of the real backlog, and
  `countQueuedClaims` reports it by CAUSE with every bucket of both vocabularies
  present whether or not anything is in it.

---

## The resolver: what it may consult, and in what order

`services/variant-axes/legacy-resolution.ts` is pure, opens no database and
contains no similarity metric of any kind.

**The NAME resolves by EXACT KEY and by nothing else.** ADR 0007 D1 makes a key
identity and a label presentation, so matching a legacy option name against
`attribute_labels` would be a name match — the basis D1 forbids and #55's
`verification_method` has no member for. `legacyOptionNameToKey` performs exactly
five mechanical folds (`LEGACY_OPTION_NAME_FOLDS`: trim, lowercase, whitespace →
`_`, hyphen → `_`, collapse repeats) and answers `null` for anything that does
not land on a legal key. `LEGACY_OPTION_FORBIDDEN_FOLDS` names ten transformations
it may never perform, disjoint from the five by a test.

So **`Tono` stays text. `Colour` stays text. `Tamaño` stays text.** That is the
intended outcome, not a gap.

**The VALUE resolves through the registry's own alias map**, which already folds
`attribute_enum_values.value` and `attribute_value_aliases` into ONE lookup (a
canonical value is its own alias there) — a human statement that this spelling
means that controlled value, evidence rather than a resemblance — and it resolves
only WITHIN the definition the name already settled. This domain does NOT
re-decide a canonical value against an alias that points elsewhere; #94's
hydration settles that in the canonical's favour and a second opinion here would
be a second authority. That ordering is the safety property: reversing it is what turns
`Marco: Negro` (a black FRAME) into a colour. An attribute with no controlled
values goes through #94's own `normalizeAttributeObservation`, so `256 GB` and
`0.25 TB` collide on a base-unit magnitude, and a value that module refuses is
refused here too.

### The refusal vocabularies, and which members the backfill can produce

| Attribute refusal | Reachable from the backfill? |
|---|---|
| `unmapped` | yes — no such key, or the name folds to nothing |
| `forbidden_as_axis` | yes — a price, a stock level, a compatibility target |
| `not_variant_defining` | yes — the registry says this attribute defines no variants |
| `ambiguous` | yes — two of ONE listing's option names folding to one key |
| `operator_refused` | **no** — only a person settling a claim |

| Value refusal | Reachable from the backfill? |
|---|---|
| `unmapped` | yes — no controlled value and no alias matches |
| `ambiguous` | yes, but only from a cardinality that splits one legacy value into several facts — NOT from the controlled-value path, which the registry's alias map settles |
| `not_controlled` | yes — the attribute has no controlled values to alias TO |
| `attribute_unresolved` | yes — the name half did not settle |
| `operator_refused` | **no** — only a person |

`not_controlled` is separate from `unmapped` on purpose: the first means an alias
could never exist, the second means one would fix it. Reporting the second as the
first sends somebody to write an alias for an attribute that has none.

---

## The backfill

`packages/backend/src/scripts/backfill-variant-axes.ts`, over
`services/variant-axes/backfill.service.ts`.

```bash
# From packages/backend. The default is a DRY RUN.
DATABASE_URL=… bun src/scripts/backfill-variant-axes.ts
DATABASE_URL=… bun src/scripts/backfill-variant-axes.ts --apply --limit=500
DATABASE_URL=… bun src/scripts/backfill-variant-axes.ts --apply --after=<listingId>
```

- **`--apply` is required to write anything**, and there is no environment
  variable for it. A migration that wrote because somebody forgot a flag is the
  one failure neither a report nor a rollback can undo
  (`PRODUCT_SAVE_MIGRATION_ENABLED`'s decision, one domain over).
- **A dry run is not a prediction.** Both modes run the identical code inside a
  transaction; a dry run rolls it back. So it exercises every trigger, CHECK and
  unique index the apply would, and a listing that would fail is reported as
  failing rather than as fine. A parallel "predict" path is a second
  implementation, and the two disagree precisely where a migration is dangerous.
- **One transaction per LISTING.** A variant's signature is compared against its
  siblings', so the listing is the unit of consistency.
- **Idempotent.** Claims and axes converge with `ON CONFLICT DO NOTHING`;
  assignments and signatures are re-derived every pass. A second run over
  unchanged data writes nothing and reports it as `alreadyPresent` /
  `alreadyDeclared` / `unchanged`.
- **Resumable.** `resumeAfterListingId` is a keyset cursor over listing ids. It
  is a convenience rather than a correctness requirement, because a re-run from
  zero is a no-op.

### The report

```json
{
  "mode": "dry_run",
  "scanned":     { "listings": 120, "listingOptions": 214, "variantOptionValues": 903,
                   "listingsWithLegacyOptionsTotal": 1180 },
  "axes":        { "declared": 88, "alreadyDeclared": 0, "unresolved": 126 },
  "assignments": { "written": 402, "alreadyWritten": 0, "unresolved": 495, "withheld": 6 },
  "claims":      { "written": 1117, "alreadyPresent": 0 },
  "signatures":  { "written": 190, "unchanged": 0 },
  "unresolved": {
    "total": 621,
    "byAttributeRefusal": { "unmapped": 104, "ambiguous": 2, "not_variant_defining": 14,
                            "forbidden_as_axis": 6, "operator_refused": 0 },
    "byValueRefusal":     { "unmapped": 61, "ambiguous": 3, "not_controlled": 12,
                            "attribute_unresolved": 419, "operator_refused": 0 }
  },
  "diagnostics": { "listingsWithIndistinguishableVariants": 2, "assignmentsRemoved": 0 },
  "resumeAfterListingId": "0195…",
  "hasMore": true
}
```

**`listingsWithLegacyOptionsTotal` is the pager's POSITIVE CONTROL**, and it is
there because the sum check below is not sufficient on its own: `listings: 0`
satisfies `0 = 0 + 0 + 0`, so a pass that read nothing prints exactly what a
clean pass over an empty catalogue prints — and `hasMore: false` then tells an
operator the migration is finished. A first-page pass that scanned nothing while
this figure is positive throws instead of reporting. This was found the first
time the script ran end to end: the fixture had silently not been seeded, and the
all-zero report looked perfect.

**The vacuity floor is enforced, not documented.** `axes.*` SUM to
`scanned.listingOptions` and `assignments.*` SUM to
`scanned.variantOptionValues`, by EQUALITY, and `assertReportSums` throws rather
than returning a report whose outcomes do not account for every row read —
`catalog_backfill_runs_counters_total_check`'s rule applied to a script, because
a pass that swallowed a record and a clean run otherwise produce the same output.

`withheld` is the fourth assignment outcome and it has to exist for the sum to
stay honest: the value RESOLVED and Mercaria declined to write it, because two of
that listing's variants would have folded to one signature. The claims are still
recorded — preserving what somebody said is unconditional — and the listing is
left entirely untyped rather than typed from whichever variant the pass reached
first.

**The backlog is the point.** ADR 0007's own consequences section: "Ambiguous
legacy values are **not** resolved. They stay text, in a queue, visible. This is
deliberate and it means the migration's output includes a backlog rather than a
clean number." The exit code says whether the pass completed, never whether the
backlog is empty.

### There is no run table, deliberately

#60's `catalog_backfill_runs` is the canonical-graph migration and its stages are
about canonical entities. A second run table here would be a second
representation of a fact the claim rows already carry, and "what could not be
resolved" is a QUERY over `attribute_refusal` / `value_refusal` that cannot go
stale — `attribute_coverage_runs`' absence, one domain over, for the same reason.

---

## Triggers

| Trigger | Table(s) | What it holds |
|---|---|---|
| `mercaria_native_variant_axis_citation` | axes | the citation agrees; the registry permits an axis; the product type version (when cited) declares a `variant_capable` variant-scope field |
| `mercaria_native_variant_axis_frozen` | axes | only `position` moves |
| `mercaria_native_variant_axis_assignment_scope` | assignments | the axis is the variant's listing's; the citation agrees; an enum value belongs to the definition; a cited claim is about the SAME variant |
| `mercaria_native_variant_signature_scope` | signatures | `listing_id` is the variant's own |
| `mercaria_native_variant_signature_agrees` | assignments + signatures | DEFERRED: the digest covers the assignments that exist |
| `mercaria_native_listing_claim_frozen` | listing claims | the assertion is immutable |
| `mercaria_native_variant_claim_frozen` | variant claims | the assertion is immutable |
| `mercaria_native_claim_no_delete` | both claim tables | no DELETE while the subject exists |

The two freeze triggers enumerate columns by hand, so
`variant-axis-schema.test.ts` holds them to a **declared partition**: every
column of the real table is either FROZEN (named in the body) or DECLARED MUTABLE
WITH A REASON, the union equal to the table's whole column set. A column added
later fails the build until somebody decides which it is. Both halves are
mutation self-tested, and the mutation is asserted to have LANDED before the
detector is asserted to fire.

---

## Seams, each named rather than stubbed

- **#367 step 5 (ADR 0007 D10, the authoring service)** owns
  `listings.product_type_definition_id`. When it lands, the owed change here is
  one clause in `mercaria_native_variant_axis_citation` asserting the axis's
  cited product type agrees with the listing's own. Until then the column is
  nullable and the registry-level `variant_defining` check is what holds.
  `native_listing_attribute_claims` with `kind = 'attribute_value'` has no writer
  today for the same reason — product-scope assertions are what the authoring
  service makes — and `recordListingAttributeClaim` is the function it calls.
- **A composite unique on `product_variants (id, listing_id)`** would let
  `native_variant_signatures.listing_id` and
  `native_variant_axis_assignments`' scope be a composite FOREIGN KEY rather than
  a trigger. Adding it means editing `db/schema/catalog.ts`, which #367 step 4
  may not; the trigger is what stands in, and this is the change that retires it.
- **#367 step 9 (search, facets, same-variant semantics)** reads
  `native_variant_axis_assignments_value_idx` — "which variants are 256 GB" — and
  the signature is what "same variant" means.
- **#58's matcher** is untouched. A native variant's canonical attachment is
  still `native_listing_links`, and nothing here writes one.
- **An operator surface** is deliberately absent. Settling a claim is a
  `settleVariantAttributeClaim` call and the queue is `countQueuedClaims`; when a
  route arrives it belongs on the existing `CATALOG_OPERATOR_OXY_USER_IDS`
  allow-list, not a seventh.

## What this issue adds no flag for

Nothing here gates a durable record, and there is no environment variable in the
domain at all. The backfill's mode is a command-line argument because it is an
operator's decision on the day; a rollback of the READS belongs to ADR 0007
D12's existing levers, and turning one off must leave every claim readable —
which is what "nothing in a rollback deletes catalog evidence" means.
