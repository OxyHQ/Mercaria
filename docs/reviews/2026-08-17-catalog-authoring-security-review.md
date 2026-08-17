# Catalog authoring: the security review (#367, ADR 0007)

- **Date:** 2026-08-17
- **Reviewed revision:** `8f99997e` (`origin/main` at the time of review), plus
  the two fixes recorded in §2 which landed on top of it.
- **Scope:** ADR 0007 (`docs/adr/0007-universal-catalog-taxonomy-and-authoring.md`)
  as implemented by #367 steps 1–6 and the surfaces they publish —
  `/catalog-authoring/*`, `/stores/:storeId/product-drafts/*`,
  `/catalog-proposals/*`, and the taxonomy and governance operator surfaces that
  own aliases, redirects and slugs.
- **Why this document exists.** ADR 0007 gates the epic on
  `CATALOG_AUTHORING_ENABLED` and `CATALOG_PROPOSALS_ENABLED`, both default
  false, and there was no recorded review of what happens when they are true. A
  read-only audit found two real gaps in code already merged to `main`; the more
  serious of the two is exactly the kind of omission a threat-model pass over
  this surface would have been positioned to catch, because the question it
  answers — *which lifecycle or status may an unprivileged caller read* — is
  asked once and answered separately in SEVEN places on this one surface, of which
  two got it wrong (§3D and §5.1) and one was correct but pinned by nothing until
  this review's own test (§4).
- **Outcome: three findings RESOLVED (1, 2 and 7); six recorded and NOT fixed.**
  §2 lists all nine, and §5 states each open one plainly with what would close it.
  **None of the six is a blocker** — they are Low and Informational, each in a
  domain this review does not own — so nothing here argues against flipping the
  flags; what it argues is that the flags should not be flipped without a record,
  and this is the record. The one to read is #7, because it was Finding 1's shape
  repeating one function over, it was closed in this same change, and it is the
  reason §6 has a third lesson.
- Nothing here is a sign-off on a launch gate; ADR 0007 defines none, unlike
  ADR 0003 M8.

---

## 1. How to read this

Every claim is tagged, and the distinction is the point rather than decoration.

| Tag | Meaning |
|---|---|
| **MEASURED** | I ran something and read its output. The command is stated. |
| **READ** | I read the code or a constraint and am reporting what it says. Reading a docblock is not verifying its claim — Finding 1 IS the gap between the two, and it is worth noticing that the false claim was in a docblock somebody wrote in good faith. |
| **INFERRED** | A conclusion drawn from the above, stated as such so a later reader can re-derive it rather than trust it. |

**For each attack class below I name the mechanism that stops it and the gate
that proves the mechanism is still there.** Where there is no mechanism I say so;
a document saying "we considered poisoning" is worth nothing, and the honest gaps
in §5 are the part of this review most likely to be useful.

**An absence claim carries the control that proves the instrument could see the
thing it reports missing.** A grep that found nothing and a grep that ran against
the wrong path are the same output.

**Reachability, stated once because it modulates every severity below.** The
whole authoring surface is mounted only when `config.catalogAuthoring.enabled`
(`app.ts:258`) and the proposal surface only when
`config.catalogProposals.enabled` (`app.ts:274`), both `boolEnv(..., false)`
(`config/index.ts:4388,4395`) — **READ**. So every finding here is live code on
`main` and reachable in a deployment that has turned the flag on. **Whether any
deployed environment has it on is not answerable from this repository**; the
answer lives in `oxy-infra`'s SSM parameters under `/oxy/mercaria/`. I did not
check, and a review that assumed either way would be guessing about production.

---

## 2. Findings

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | **High** | `GET /catalog-authoring/schemas/:productTypeKey?version=N` served a `draft` or `review` product-type version to any authenticated account | **FIXED** — §3D |
| 2 | **Medium** | No sanitization of seller-authored free text entering the authoring and proposal surfaces | **FIXED** — §3C |
| 3 | Low | The brand half of `/catalog-authoring/canonical-search` admits `inactive` and `suppressed` brands, where the product half deliberately admits only `active` | **OPEN** — §5.1 |
| 4 | Low | `categories.slug` has no shape CHECK and no reserved-word list, and arrives verbatim (untrimmed) from an operator parameter | **OPEN** — §5.2 |
| 5 | Low | `listings.handle` is user-settable with no length and no shape bound; it reaches no URL today | **OPEN** — §5.3 |
| 6 | Low | No route-level allow-list test on the four `/internal/catalog-*` surfaces that carry the redirect, merge and alias-minting powers | **OPEN** — §5.4 |
| 7 | Low | `listSelectableCategories` was a correct positive allow-list pinned by NOTHING — deleting either clause left every test green | **FIXED** — §4 |
| 8 | Informational | The localized-slug supersede chain has no cycle guard and no depth cap, where `category_redirects` has both | **OPEN** — §5.5 |
| 9 | Informational | `strip_html`'s decode-after-strip order can manufacture markup from an entity-encoded feed value | **OPEN, scoped out** — §5.6 |

---

## 3. The four attack classes

### 3A. Catalog poisoning via aliases and redirects

The fear: a merchant, a feed or a low-privilege account gets a value into the
taxonomy's alternate-name or redirect machinery, and from then on a category
lookup, a search, or a URL resolves somewhere it was not meant to. It is a good
attack because nothing looks broken afterwards.

**Mechanism 1 — an alias has no way to claim to be the name, and the enforcement
is an ABSENCE.** `category_aliases` (`db/schema/taxonomy.ts:70`) carries
`category_id`, `locale`, `alias`, `normalized_alias`, `kind` and timestamps and
**no `is_primary`, `is_display` or `preferred` column** — **READ**, and the
schema's own comment states the intent. The public name is `categories.name` and,
from step 2, the localization family. There is no column an alias could be
promoted through.

**Mechanism 2 — no code path exists by which a seller-supplied value becomes a
category alias.** **MEASURED** — `grep -rn "insertCategoryAlias|attributeValueAliases|insertAttributeValueAlias"` over
`controllers/`, `routes/` and `services/` (excluding `__tests__`) returns exactly
three call sites, none of them a merchant surface:
`services/catalog-proposals/review.service.ts:194` (an operator approval, §below),
`services/attributes/definition-registry.service.ts:173` (#94's operator registry)
and `services/catalog-governance/impact-plan.ts` (a READ of the column, for the
impact estimate). The taxonomy's own `insertCategoryAlias`
(`db/taxonomy/taxonomyRepository.ts:351`) is called from
`scripts/seed-verticals/apply.ts:382` — an operator-run script, not an HTTP
surface. *Control for the instrument:* the same grep DOES find the three
legitimate call sites, so it is not reporting absence because it read nothing.

**Mechanism 3 — the ONE merchant-influenced path into the catalogue vocabulary is
narrow, and its identity half belongs to the operator.**
`CATALOG_PROPOSAL_MINTABLE_TYPES` has one member, `controlled_value`
(`packages/shared-types/src/catalog-proposal.ts:82`) — **READ**. In
`mintForProposal` (`services/catalog-proposals/review.service.ts:135-214`) the
KEY comes from `approval.key` (the operator's), is shape-checked against
`^[a-z0-9][a-z0-9_.-]*$` before any write, and a collision is a `conflict` telling
the operator to merge rather than an overwrite. The merchant's verbatim spelling
becomes an alias only when the operator sets
`recordSubmittedSpellingAsAlias === true`, and that insert is
`ON CONFLICT DO NOTHING`, so it can never repoint an alias that already names
another value.

The LABEL, though, defaults to the merchant's own `proposedLabel`. That is the
sentence that connects this class to §3C: **before Finding 2 was fixed, a
merchant-supplied `<script>` could become a controlled value's public label on
approval.** It is now sanitized at the boundary, so the value that reaches the
operator's review screen and the value that gets minted are both already clean.

**Mechanism 4 — a redirect cannot be edited, cannot cycle, and cannot fork.**
`category_redirects` (`db/schema/taxonomy.ts:137`) — **READ**:

- `mercaria_category_redirects_append_only` refuses UPDATE and DELETE. A
  correction is a new row extending the chain, so the mistake stays visible.
- `mercaria_category_redirect_cycle_guard`
  (`drizzle/0088_redundant_korvac.sql:388-424`, `BEFORE INSERT`) refuses a cycle
  at write time, absolutely, and caps the walk at `hops > 8` (`:407`). Its hop
  bound is deliberately weaker than the cycle refusal — it sees only the chain
  ahead of the new target — so tail extension, which IS the documented correction
  pattern, can build a chain past it. `resolveCategoryRedirect` bounds its own
  walk at `MAX_REDIRECT_HOPS = 8` (`db/taxonomy/taxonomyRepository.ts:85,595`)
  and answers `chain_exhausted` carrying no category rather than looping. The
  weaker bound is not an oversight; it is what lets the correction pattern work
  at all.
- `mercaria_category_hierarchy_guard`
  (`drizzle/0088_redundant_korvac.sql:253-320`) caps the `parent_id` and
  merge-target walks at `depth > 64` (`:292,313`), and two CHECKs refuse
  self-parenting and merging into oneself.
- Two PARTIAL unique indexes (`category_redirects_subject_category_key`,
  `category_redirects_subject_slug_key`) permit exactly one redirect per subject.
  Partial because Postgres treats NULLs as distinct and a plain unique over the
  nullable subject columns would admit any number of rows.
- Three separate biconditional CHECKs on the subject shape rather than one over
  their conjunction — the single-CHECK spelling is satisfied by a `category_id`
  row carrying a locale and no slug, because both sides evaluate false.
- Both foreign keys are `restrict`, and `category_redirects_not_self_check`
  refuses a self-redirect.

**Mechanism 5 — one writer, and the durable half of that is a census.**
`db/__tests__/taxonomy-write-chokepoint.test.ts` asserts that `categories` and
its three satellite tables are written by `db/taxonomy/taxonomyRepository.ts` and
two named exceptions and by nothing else. Its own header states why a runtime test
cannot do this job: `is_active`, `ancestor_ids` and `ancestor_slugs` are
DERIVATIONS, so a second writer does not fail — it writes an ordinary-looking row
and the disagreement surfaces months later as a category that is live and
invisible. It deliberately does not strip comments (false positives are corrected
in one line; a `//` inside a string literal can hide a real call) and assembles
its probe from table NAMES so it cannot become the offender it looks for.

**The gates that prove the mechanisms are still there.**
`db/__tests__/taxonomy.realdb.test.ts` drives every one of the above against a
real server — **READ**, test names quoted from the file: *"refuses a redirect
cycle, so the resolver's walk always terminates"* (`:512`), *"is append-only
against UPDATE and DELETE"* (`:491`), *"permits one redirect per subject and no
more"* (`:530`), *"reports a chain it cannot follow to the end, and names no
category for it"* (`:451`), *"refuses merging into a descendant"* (`:273`),
*"permits one alias under several categories and refuses a duplicate under one"*
(`:620`), *"refuses an empty alias"* (`:651`). The census is
`taxonomy-write-chokepoint.test.ts:136`, *"finds ONLY the repository and its two
named exceptions writing the taxonomy"*.

**The gate on the write SURFACE.** The only HTTP path that writes a redirect is
`/internal/catalog-governance`, which mounts `authenticateToken` then
`requireCatalogOperator` (`routes/internal-catalog-governance.ts:108-109`) against
`CATALOG_OPERATOR_OXY_USER_IDS`, and is mounted at all only when
`config.catalog.graphOperatorSurfaceEnabled` (`app.ts:1007`) — an empty list means
404 rather than 401. `requireCatalogOperator`
(`middleware/catalog-operator-authz.ts:29-48`) is two layers: a 404 if the surface
is disabled ("defence in depth against a future mount that forgets the config
check") then a 403 on the allow-list, and it reads nothing from the request beyond
the verified caller. **READ.**

**Verdict: covered.** Every mechanism in this class is a schema property, an
absence, or a source census — none is a service-level convention somebody could
refactor past in good faith. The residual is §5.4: the 404-when-empty behaviour of
THIS surface is asserted only by analogy on two sibling surfaces.

### 3B. SEO abuse via slug and handle collision

The fear: a seller lands a slug that steals a category's URL, or two listings
fight over a handle, or a crafted slug shadows a route.

**Mechanism 1 — #367's write path mints no slug and no handle at all.**
**MEASURED** — `grep -rn "handle" packages/backend/src/services/catalog-authoring/*.ts packages/backend/src/middleware/catalog-authoring-schemas.ts`
returns nothing outside comments. The publish path
(`services/catalog-authoring/publish.service.ts`) creates the listing through
`createStoreProductWithin`, which is `createStoreProduct`'s own body, and passes
no handle; `catalog-write.service.ts:670-672`'s comment records that the P2P
create writes `handle` null and no other statement sets the column. A handle is
settable only through `updateListing`'s patch
(`catalog-write.service.ts:1111`) and the connector rails. **INFERRED:** handle
collision is not reachable from the authoring surface, and a #367-authored
listing has no handle-derived URL to collide with anything.

**Mechanism 2 — a handle is unique per STORE, and a collision is named rather
than silently suffixed.** `listings_store_id_handle_key`, with
`asNamedHandleCollision` (`catalog-write.service.ts:687`) turning the unique
violation into a message that names the incumbent — and, when the incumbent
cannot be read back, says only what was observed rather than inventing one.
**READ.** Per-store rather than global is correct: two shops may both sell a
"blue-widget", and a global unique would make the second shop unable to name its
own product.

**Mechanism 3 — the LOCALIZED slug family is defended in depth, and the
load-bearing part is that its unique covers RETIRED rows.**
`category_localized_slugs` (`db/schema/catalogLocalization.ts:258+`) — **READ**:
`category_localized_slugs_locale_slug_key` on `(locale, slug)` **including
superseded rows**, whose own comment says it is "the one that stops a redirect
quietly resolving to somebody else's category"; a current-slug partial unique on
`(category_id, locale) WHERE superseded_at is null`; a shape CHECK
`^[a-z0-9]+(-[a-z0-9]+)*$`; a not-the-base-locale CHECK; supersede and
self-supersede CHECKs; the freeze trigger
`mercaria_category_localized_slug_frozen` refusing an UPDATE of `category_id`,
`locale` or `slug`; and a named refusal before the index in
`db/catalogLocalization/categoryLocalizedSlugRepository.ts:126-131`. ADR 0007 D4
makes a slug change a new row plus a redirect rather than an UPDATE that breaks a
link. Gated by `db/__tests__/catalog-localization.realdb.test.ts` — *"refuses a
slug another category holds, current or retired"*, *"refuses a slug shape a URL
cannot carry"*, *"freezes a slug row's identity against an UPDATE"*, *"refuses two
current slugs for one category and locale"*.

**The base `categories.slug` is a different story and is defended by uniqueness
ALONE.** **MEASURED** — a grep for a slug CHECK across every file in
`packages/backend/drizzle/*.sql` returns only `category_redirects_*` and
`category_localized_slugs_*` constraints; there is no CHECK on `categories.slug`
at all. *Control:* the same grep DOES find
`category_localized_slugs_shape_check` (`0091_slimy_the_fury.sql:86`), so it is
not reporting absence because it read nothing. `categories_key_format_check`
constrains `key`, not `slug`. The value is operator-supplied verbatim through
`optionalParam` (`services/catalog-governance/apply.ts:117-121`), which rejects
only a non-string and a whitespace-only string and does not trim, over a
`z.record(z.string().max(64), z.unknown())` parameters bag
(`middleware/catalog-governance-schemas.ts:64-69`) whose own comment says shape
is all it enforces. §5.2.

**Mechanism 4 — a submitter cannot send identity, and that is a gate with its own
positive control.** `catalog-proposal-isolation.test.ts:198` slices
`submitCatalogProposalSchema` out of the middleware source and asserts it declares
no `key:` and no `slug:` — then asserts that `approveCatalogProposalSchema` DOES
carry a `key`, so a slice that captured the wrong region fails. That second half
is what makes the first half mean something.

**One thing this class does NOT cover, found while checking it: `listings.handle`
is user-settable with no length and no shape bound.** **MEASURED** —
`middleware/schemas.ts:174` (`updateListingSchema`) and `:230`
(`createStoreProductSchema`) both declare
`handle: z.string().trim().min(1).optional()`: no `.max()`, no pattern, and
nothing routes it through `utils/slug.ts`'s `slugify`. It is outside #367 (the
authoring path passes no handle at all, mechanism 1) and it reaches no URL today —
**MEASURED**, a grep for handle-derived route building finds STORE handles
(`services/seo/visible-facts.ts:403`, `/m/:handle` → `/stores/:handle` in
`services/seo/redirects.ts:7`), canonical product handles (`/p/[handle]`) and
category handles, and no path built from `listings.handle`. §5.3.

**Verdict: covered for this epic's write path**, which mints neither a slug nor a
handle. Two residuals recorded in §5.2 and §5.3, both reachable only by an
operator or by a merchant on their own store's namespace.

### 3C. Unsafe rich text — Finding 2

**What was wrong.** `title`, `description`, free-text (`kind: 'text'`) draft
answers, `proposedLabel`, `proposedDescription` and `submitterNote` were plain
`z.string().trim().max(N)` with no tag stripping, and on publish `description`
reached the `listings` row untransformed
(`catalog-write.service.ts:480,773,1068`).

**What actually protected it, precisely.** Two consumers, both correct, and it
matters that the list is short:

1. React's default JSX escaping on the storefront path that renders a description
   (`packages/frontend/app/(app)/products/[id].tsx:774`) — **READ**.
2. `services/seo/head.ts`, which renders descriptions into raw server-side HTML
   and escapes them: `escapeHtml` for every text and attribute value,
   `escapeJsonLd` for JSON-LD, which neutralises `<` specifically so a
   `</script>` inside a description cannot close the block — **READ**. This is
   the one non-React consumer that exists today and it got it right.

So the audit's "any non-React consumer is unprotected" is about consumers that do
not exist YET plus anything that reads the column directly. That is still the
problem: the protection has to be remembered once per reader, and the first reader
who forgets is the vulnerability.

**The fix, and where it is applied.** `lib/authored-text.ts`'s
`sanitizeAuthoredText`, called from the zod schemas at the boundary
(`middleware/catalog-authoring-schemas.ts`,
`middleware/catalog-proposal-schemas.ts`), so the STORED value is clean and there
is nothing for a later reader to remember. Sanitizing at render would have left
the raw value in the column.

Four decisions in it are load-bearing:

- **It reuses the repository's ONE tag pattern and ONE entity table**, imported
  from their owner (`services/feed-import/transforms.ts`, where `stripHtml` was
  split into the exported `stripHtmlTags` and `decodeHtmlEntities` with
  `stripHtml` recomposed byte-identically). A second tag regex is a second thing
  to tighten, and the time it is not tightened is the time somebody trusts it.
- **It does NOT reuse the ORDER.** `stripHtml` strips tags and then decodes, so
  `&lt;script&gt;` comes out as `<script>` — decoding after stripping can
  MANUFACTURE the markup the strip removed. Fine for a cosmetic feed transform,
  disqualifying for a security control. `sanitizeAuthoredText` decodes first.
- **Line breaks survive.** `stripHtml` collapses all whitespace, which on a
  20,000-character description is one line where there were paragraphs — a
  visible product regression on exactly the field the fix exists for, since the
  storefront renders it in an RN `<Text>` that honours `\n`.
- **`proposedLabel` checks its `.min(1)` twice**, and the second is not the
  first's spelling: `<b></b>` clears the raw floor and sanitizes to the empty
  string, and what walks through becomes a controlled value's label on approval
  (§3A). Every `.max()` stays on the RAW input and the transform only shortens,
  so markup cannot buy length.

**The gate.** `lib/__tests__/authored-text-sanitization.test.ts` — **MEASURED**,
28 tests. Every schema case calls `.parse()` on the exported zod object the route
mounts, not on the transform, so removing a `.transform()` from a field goes red;
a test that called the function directly would stay green. "The output contains no
tag" is asserted as `stripHtmlTags(out) === out` — the owner's own pattern applied
a second time — rather than by writing the pattern out again, because a second copy
can disagree with the one under test in the direction where the test keeps passing.
It carries two vacuity controls (a clean value passes through unchanged; a clean
proposal parses) and one contrast assertion pinning the feed transform's order, so
nobody "unifies" the two by pointing the authoring path at `stripHtml`.

**MEASURED — mutation, twice, each landed then reverted.** Dropping
`authoredDescription`'s transform: red with
`expected 'Great phone.\n\n Ships fast.' to be 'Great phone.\n\n<img src=x onerror=…'`
— the raw tag surviving into the parsed value. Dropping the post-sanitize floor on
`proposedLabel`: red with `expected [Function] to throw an error`. 27 of 28 stayed
green each time, so the file is not simply broken.

**What stays RAW, deliberately, with the consumer that escapes it:**

- **Feed and connector text** — `catalog_source_objects`, and a listing
  description a connector wrote. An operator reviewing what a source CLAIMED has
  to see what the source actually said, and #63's own `strip_html` transform
  covers the column where a merchant configured one. Escaped by the two consumers
  above.
- **`abuse_reports` reporter text and evidence** — quoted to a CrowdSource jury
  for the same reason.

**Verdict: covered at the boundary for this epic's surfaces.** §5.6 records the
one thing this fix deliberately did not change.

### 3D. Unlaunched schema disclosure — Finding 1

**What was wrong.** `GET /catalog-authoring/schemas/:productTypeKey?version=N`
runs `authenticateToken` and `makeRateLimiter('listings')` and nothing else
(`routes/catalog-authoring.ts:35,41`) — no store permission, no operator
allow-list. That is correct and documented for a published schema: the answer does
not vary by store, and the permission projection inside it comes from
`req.storeMembership`, which is absent here, so the surface composes read-only.

With `?version=` supplied the read resolved through `findProductTypeVersion`
(`db/catalogAuthoring/schemaSourceRepository.ts:231`), which filtered on `key` and
`version` and **not on lifecycle** — where its sibling
`findPublishedVersionForKey` eleven lines above filters
`lifecycle = 'published'`. `composeForDefinition` re-checked nothing. So any
authenticated Oxy account, buyer or seller, with no store membership, could read
the complete field, attribute, grouping, requirement and value-policy structure of
an unlaunched product type by naming a key and a small integer. Keys follow ADR
0007 D1's documented namespace convention, so guessing is cheap.

**MEASURED — the exposure reproduced.** With the fix's check removed, the two
editable cases in
`services/catalog-authoring/__tests__/schema-version-lifecycle-exposure.realdb.test.ts`
fail with `expected 'composed' to be 'refused'`: a `draft` and a `review` version
composed in full, over real rows, through the real service.

**The fix.** `RETRIEVABLE_AUTHORING_LIFECYCLES` in `composeAuthoringSchema`
(`services/catalog-authoring/schema.service.ts`), applied unconditionally after
the version resolves. Four decisions in it:

- **The service, not the repository.** `findProductTypeVersion` promises the row
  at `(key, version)`, which is what its name says. It has exactly one caller
  today, so a filter inside it would be safe now — and would answer a later
  operator-preview or upgrade path with `null`, indistinguishable from "no such
  version", sending whoever hit it looking for a missing row rather than a refused
  one. `composeAuthoringSchema` is the one place a caller NAMES a version.
- **`composeForDefinition` is deliberately not gated.** It serves a PINNED
  definition id that a draft, a validation and a publish already hold and did not
  choose, and `deprecated` must keep composing because records pin it — the same
  reason `productTypeIsScopedToCategory` does not filter on `published`.
  `createDraft` already refuses a non-published version, so nothing in this
  repository composes an editable version through that entry.
- **A positive allow-list, not "not editable".** The two fail in opposite
  directions: a fifth lifecycle nobody classified is refused here and would have
  been served by a deny-list. The test asserts the tuple is exactly the complement
  of `PRODUCT_TYPE_EDITABLE_LIFECYCLES` over `PRODUCT_TYPE_LIFECYCLES`, so adding
  a lifecycle fails the build until somebody decides which side it is on rather
  than landing on the permissive side in silence.
- **The refusal is indistinguishable from a nonexistent version**, in both the
  code (`product_type_not_found`) and the sentence. A refusal saying "that version
  is a draft" is an oracle enumerating the unlaunched verticals, which is most of
  what the exposure was worth. Both directions are asserted, so they cannot drift
  apart later.

**Verdict: fixed, and §6 is about why it survived.**

---

## 4. What got it right, and why the contrast matters

Three of the four reads on the same unprivileged router were correct, and it is
worth recording them precisely — because that is the reason the fourth looked
fine. **READ**, all four:

- `listSelectableCategories`
  (`db/catalogAuthoring/schemaSourceRepository.ts:180`) requires
  `selectable = true AND lifecycle = 'published'`, and its comment states that the
  two are different facts: a grouping root is published and not selectable, a
  connector holding pen is selectable and suppressed. Offering either would let a
  product land somewhere ADR 0007 D2 says it may not. **And until this change it
  was pinned by nothing** — **MEASURED** at review time, no test file referenced
  `listSelectableCategories` or its one caller `listAuthoringCategories`;
  *control:* the same grep found `composeAuthoringSchema` in three test files. The
  nearest backstop was a different mechanism at a different layer, the trigger
  `mercaria_category_assignment_selectable` (`taxonomy.realdb.test.ts:580`), which
  refuses the ASSIGNMENT and says nothing about what the picker OFFERS. So
  **deleting the `lifecycle = 'published'` half of this function left every test in
  the repository green while offering suppressed nodes in the authoring picker** —
  the same shape as Finding 1, one function over, and in the function this review
  had cited as the contrast that gets it right.

  **Closed here** (finding 7).
  `schema-version-lifecycle-exposure.realdb.test.ts` now carries three picker
  cases plus a fixture vacuity control, under a parent the file owns so an exact
  equality is safe on the shared database. TWO cases rather than one, because a
  single case is satisfied by either clause alone: the suppressed fixture is
  `selectable` on purpose and the grouping fixture is `published` on purpose, so
  each exclusion can only be performed by the clause its case is named for.
  **MEASURED — mutation, independently per clause, each landed then reverted:**
  removing the lifecycle clause reddens *"excludes a SUPPRESSED category, which is
  selectable"* and leaves the non-selectable case GREEN; removing the selectable
  clause reddens *"excludes a NON-SELECTABLE category, which is published"* and
  leaves the suppressed case GREEN. Each also takes the exact-equality case, which
  is expected. That each mutation leaves the OTHER case green is what shows the two
  cases measure two clauses rather than one clause twice.
- `listPublishedProductTypesForCategory` filters `d.lifecycle = 'published'` in
  the SQL, and deliberately does not copy #94's "empty scope applies everywhere"
  disjunct — an unscoped draft schema would otherwise be offered under every
  category.
- `/catalog-authoring/canonical-search` restricts to
  `SELECTABLE_STATUS = eq(canonicalProducts.status, 'active')`
  (`db/catalogAuthoring/canonicalSearchRepository.ts:63`) on BOTH the identifier
  and the name read, with a comment naming what each excluded status means; the
  variant read filters `status = 'active'`.
- `SERVABLE_LOCALIZATION_STATUSES` is a positive allow-list —
  `['machine_translated', 'reviewed', 'approved', 'stale']` — excluding `missing`
  and `deprecated`, consumed as a `Set` in
  `services/catalog-localization/resolve.ts:53` and pinned by
  `db/__tests__/catalog-localization.test.ts:106-113`, which asserts the two
  exclusions BY NAME and that the servable set is strictly smaller than the full
  one. That last assertion is the one to copy: it fails if somebody widens the
  allow-list to everything.

**INFERRED, and it is the lesson of this review:** seven reads on this one surface
answer "which lifecycle or status may an unprivileged caller see", and five answer
it correctly in five separate places, each with its own careful comment. The two
that do not (§3D, §5.1) are not wrong ANSWERS, they are **missing questions** —
and a missing question is invisible to every gate this epic has, because a gate
that scans for a forbidden import cannot notice a filter that was never written.
One of the five that ARE right is itself pinned by nothing, so it can become a
sixth at any time. §6.

---

## 5. Residual gaps — open, not fixed

### 5.1 The brand picker admits a suppressed brand (Low)

`searchBrandsByName` (`db/catalogAuthoring/canonicalSearchRepository.ts:277`)
filters `isNull(brands.mergedIntoId)` and nothing else. **READ.**
`brands.status` exists and carries `CANONICAL_ENTITY_STATUSES` —
`active | inactive | merged | suppressed`
(`packages/shared-types/src/organization.ts:29`) — with
`brands_status_check` and a biconditional tying `merged` to the pointer. So the
pointer filter is exactly `status <> 'merged'` and **`inactive` and `suppressed`
brands are offered to an author as selectable**, where the product half of the
same endpoint deliberately admits only `active` and its comment explains why
("Offering any of them would let an explicit human selection land on a row the
catalogue has already decided against — the one thing D10 says must never be
overruled, overruled in advance").

The function's own comment explains the MECHANISM choice — the two lifecycle
column shapes differ and only the pointer is common to both — which is a true
statement that does not address the exclusion of `suppressed`.

Not fixed here: adding a status filter changes what an author mid-flow sees, and
the brand and canonical-catalogue vocabulary belongs to the taxonomy and
product-type workstreams rather than to a security fix. Consequence if left: a
draft can be attached to a brand the catalogue has decided to stop showing, and a
suppressed brand's name is disclosed to any authenticated author.

### 5.2 `categories.slug` has no shape CHECK and no reserved-word list (Low)

Two measurements, stated separately because they are different gaps:

**No shape CHECK at all** on `categories.slug` — **MEASURED** in §3B, with the
control. `category_localized_slugs.slug` has one; the base column does not. The
value arrives verbatim from an operator's `taxonomy_rename` parameter through
`optionalParam`, which does not even trim it. So `Admin`, `../etc`, a value with
spaces or a 4,000-character string are all storable in a globally-unique column
whose ancestry array (`ancestor_slugs`, the v1 read contract five services still
filter on per ADR 0007 D13) is composed from it.

**No reserved-word list** on either column — **MEASURED**, `grep -inE "reserved"`
over `db/schema/catalog.ts` and `db/schema/catalogLocalization.ts` returns
nothing; *control:* the same grep for `slug` returns 35 hits in the second file,
so the instrument works. So `admin`, `api` or a segment matching a live route is
mintable as a category slug.

Both left open: every writer is behind `CATALOG_OPERATOR_OXY_USER_IDS`
(§3A mechanism 5's census plus §3A's surface gate), so this is an operator footgun
rather than an abuse vector, and the taxonomy workstream owns the column. The fix
for the first is the same CHECK the localized table already carries, rendered
once; for the second, a tuple in shared-types with the CHECK rendered from it —
the `ALL_CURRENCY_CODES` device applied to route names. Note that adding either is
a `post`-phase migration, because each breaks a write the previously serving image
performs.

### 5.3 `listings.handle` is user-settable with no length or shape bound (Low)

**MEASURED** in §3B. `updateListingSchema` and `createStoreProductSchema` both
accept `handle: z.string().trim().min(1).optional()` — a merchant with
`products:write` can store an arbitrarily long handle containing any characters,
including `/` and `..`, in their own store's namespace. `utils/slug.ts`'s
`slugify` exists and is not called on this path.

Not an SEO vector today, and the reason is worth stating rather than assuming: no
route or SEO path builds a URL from `listings.handle` — **MEASURED**, the greps
find store, canonical-product and category handles only. It becomes one the moment
a listing route by handle is added, which is exactly when nobody will re-check the
input schema. Outside #367 (the authoring publish path passes no handle), so left
to whoever owns `listings.handle`; the cheap fix is a `.max()` plus the same shape
regex the localized slug carries.

### 5.4 No route-level allow-list test on the four surfaces that carry the powers (Low)

**MEASURED** — `packages/backend/src/routes/__tests__/` contains
`internal-catalog-attributes.test.ts` and `internal-catalog-metrics.test.ts` for
this family (each asserting *"an EMPTY allow-list means the surface is not mounted
at all — 404, never 401"* and, on the attributes one, that a PAYMENTS operator does
not open it), and **no** `internal-catalog-governance.test.ts`,
`internal-catalog-proposals.test.ts`, `internal-navigation.test.ts` or
`internal-catalog-condition.test.ts`.

So the 404-when-empty behaviour of the surfaces that mint aliases, apply merges and
write redirects is asserted **by analogy on two siblings**. All four mount the same
`requireCatalogOperator` inside the same `graphOperatorSurfaceEnabled` guard, so
the property is very likely true — and "very likely true by analogy" is what this
review is meant to convert into a measurement. Cheap to close: the two existing
files are the template.

### 5.5 The localized-slug supersede chain has no cycle guard or depth cap (Informational)

`category_localized_slugs.superseded_by_slug_id` is self-referencing with
`category_localized_slugs_self_supersede_check` and the freeze trigger and
**nothing bounding a longer cycle** — no trigger and no resolver hop cap, unlike
`category_redirects`, which has both. Currently unexploitable because nothing walks
the chain: `resolve.ts` never returns a retired slug, and
`issueCategoryLocalizedSlug`
(`db/catalogLocalization/categoryLocalizedSlugRepository.ts:106`) — the writer of
the chain — has no route or service caller at all. Recorded because "unexploitable
because nothing calls it" expires the day something does, and the guard the
redirect table has is the model.

### 5.6 `strip_html` can manufacture markup from an entity-encoded feed value (Informational, scoped out)

`applyFeedTransform(value, 'strip_html')` strips tags and THEN decodes entities,
so `&lt;script&gt;` in a feed column becomes the literal `<script>` in the value
stored on the listing row. **MEASURED** — asserted in
`lib/__tests__/authored-text-sanitization.test.ts` as the CONTRAST case, so the
behaviour is pinned rather than assumed.

Deliberately not changed. It is a cosmetic transform a merchant configured on a
feed column, its output is a stored description for every advertiser using it, and
both consumers that render one escape correctly (§3C). Changing the order is a
behavioural change to the feed-import domain with its own tests and its own owner.
Recorded here so the next person to read that function knows it was seen.

---

## 6. Why Finding 1 survived, and what would have caught it

This epic is unusually well gated. It has scanned import walls with vacuity
floors, positive controls and per-detector mutation self-tests
(`catalog-authoring-isolation.test.ts`, `catalog-proposal-isolation.test.ts`), a
source census over every writer of the taxonomy tables
(`taxonomy-write-chokepoint.test.ts`), CHECKs and triggers driven against a real
server, and a slice-based gate with its own positive control on submitter-supplied
identity. **None of them could have caught Finding 1**, and that is not a
criticism of any of them:

- An import wall detects a module reaching somewhere it may not. The exposure was
  a filter that was never written; no import moved.
- A write chokepoint detects a second writer. This was a READ.
- A CHECK or a trigger constrains a row. Every row involved was entirely valid —
  a `draft` product-type version is a legitimate, expected row.
- The composition had **no test on the `?version=` path in either direction**, so
  this was an absent assertion rather than a weakened one, and an absent assertion
  has no red state to notice.

**What did point at it, and was not read as a claim:**
`checkSchemaVersionAvailability`
(`services/catalog-observability/integrity.service.ts:552-579`) already documented
the exact rule — "`composeAuthoringSchema` refuses a definition whose lifecycle is
neither `published` nor `deprecated`" — and derived its own half of the partition
from `PRODUCT_TYPE_EDITABLE_LIFECYCLES` "rather than restating the composition's
condition: one tuple, so the day a fifth lifecycle lands the answer moves in both
places at once". A correct, careful docblock **describing behaviour that did not
exist**. The fix makes that sentence true.

**And it was not a one-off — finding 7 was the same shape, in the function this
review had cited as the contrast that gets it right.**
`listSelectableCategories` filters `selectable AND lifecycle = 'published'`
correctly, documents why both halves are needed, and was referenced by no test at
all (§4, measured with a control). Deleting the lifecycle half offered suppressed
categories in the authoring picker with every suite green. It is closed in this
same change, but the inversion is the finding: **two instances of one failure mode
in one epic — one of them in the example held up as correct — is a pattern rather
than an accident. This codebase gates IMPORTS and ROWS thoroughly and does not
systematically gate FILTERS.**

Three things to carry forward:

1. **A docblock asserting another module's behaviour is a claim, not a
   verification** — the distinction §1's tag table exists for. Where one module's
   correctness depends on another's rule, the cheap gate is a test that drives
   both, which is what the complement assertion in
   `schema-version-lifecycle-exposure.realdb.test.ts` now is.
2. **For any question answered separately by several reads, write the question
   down and check every reader against it.** "Which lifecycle or status may an
   unprivileged authoring caller see" has SEVEN readers on this surface —
   `listSelectableCategories`, `listPublishedProductTypesForCategory`, the
   canonical-search reads by name, by identifier and by variant,
   `searchBrandsByName`, and the by-version composition — and **two of the seven
   are wrong**: §3D (fixed) and §5.1 (open). The failure mode is not a wrong
   answer, it is a reader nobody asked — and a positive allow-list is what turns
   the next unasked reader into a build failure instead of a disclosure.
3. **A lifecycle or status filter in a READ path deserves a test the way a write
   chokepoint does, and asserting one requires ROWS IN THE STATES IT EXCLUDES.**
   That is the whole reason this class survives: a test written without those rows
   passes against the filter's absence, so writing one is not optional diligence,
   it is the only version that measures anything. **One case per CLAUSE, not per
   function** — §4's two picker cases exist separately because a single case is
   satisfied by either clause alone, and a mutation that reddens one case while
   leaving the other green is the only evidence that both clauses are covered.
   `SERVABLE_LOCALIZATION_STATUSES`' vacuity floor
   (`catalog-localization.test.ts:113`, asserting the servable set is strictly
   smaller than the full one) is the complementary pattern, because it fails if
   somebody widens the allow-list to everything — which is the direction a filter
   erodes.
