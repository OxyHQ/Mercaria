# Script coverage: every text fold is measured against every shipped script (#833)

`packages/backend/src/__tests__/script-coverage-census.test.ts` is the gate,
`script-corpus.ts` is the shared corpus, and
`text-fold-script-behaviour.test.ts` is what most folds are measured by.

## The blind spot it closes

Three defects shipped in one week, in three domains, all invisible to a
Latin-script test:

| Defect | Mechanism |
|---|---|
| `normalizeEntityName` (#830, fixed #834) | `[^\p{L}\p{N}]+` → space; Indic matras are `Mn`/`Mc`, not letters, so Hindi *bicycle* and *bicycles* collapsed onto one string — **in the space #53 generates merge candidates in** |
| `listings.search_vector` (fixed #826) | generated AND queried as `'english'`, so a listing found by its English title was not found by its French one |
| `redactSupplierOrderMessage` (#832) | the address pattern starts `[A-Z]` — ASCII uppercase only — so Devanagari and Cyrillic addresses are not redacted at all |

The census behind #833 counted 22 test files for normalizers, tokenizers, slugs,
aliases, matchers, redactors and folds: **21 held no non-Latin character at
all**, while `hi.json`, `bn.json`, `ja.json`, `ru.json`, `ar.json` and
`zh-Hans.json` ship in `@mercaria/ui`.

## Both populations are derived

**Required scripts, from the shipped locale bundles.** `packages/ui/src/i18n/locales/`
is what the product claims to serve, so adding `ko.json` demands Hangul with no
edit anywhere. Every letter in every bundle is classified and a **residual** is
reported: a script the classifier cannot name fails the gate rather than being
skipped. `Script=Common` letters (`ー` U+30FC, `ـ` U+0640) are neutral — treating
them as unknown fails on day one for no reason. A family is required at ≥2% of
one bundle's letters; measured, the smallest real family is Katakana at 6.97% of
`ja.json` and the largest artefact is 0.00%.

Today that is **Latin, Arabic, Bengali, Cyrillic, Devanagari, Han, Hiragana,
Katakana**. Note what it excludes: **Greek** appears in 14 modules (`Σ`, `µ` in
money and matching prose) and ships in no bundle — a hand-written list drawn by
eye would have demanded Greek and missed Hiragana, which is the script almost
nothing covered.

**Modules, from a source walk for fold OPERATIONS.** Not for file names, not a
path list.

## Why the detector is the operation, not the character class

#833 proposed scanning for `\p{L}`, `\p{N}`, `[A-Z]`, `[a-z]` and `\w`. Measured
on `99cd1369`, that set does not describe the defects it was drawn from:

- `listings.search_vector` (#826) contains **no JavaScript character class at
  all** — it is `to_tsvector('english', …)` in a generated column.
- `services/search/normalize.ts` and `services/taxonomy/alias-normalization.ts`,
  both named in #833's own census, contain none of the five either.

So the unit is a **content fold** — an operation whose output depends on the
script of its input and which rewrites text rather than refusing it. Five kinds:
`unicode_normalize`, `property_class`, `ascii_alphabet_rewrite`,
`codepoint_range`, `text_search_config`. Surface: **45 modules**.

Deliberately excluded, each with its reason in the file: **collation** (changes
order, not content — a different failure class, and it would add 27 modules) and
**an ASCII alphabet in a validating position** (`.test(`, a zod `.regex(`, a SQL
`check()` refuse loudly where `.replace()` corrupts silently — including them
takes the surface from 45 to 126, all currency codes, ISO codes and slug
policies).

## What counts as coverage

The module's own source plus every test that **directly** imports it, comments
stripped, plus the shared corpus when a covering test drives it.

- **The module counts** — `graph-benchmark/folding.ts` carries its non-Latin
  corpus in the module, and a test-file-only census scores it zero.
- **Comments are stripped** — `canonical/normalization.ts` reads as covered on
  raw source and empty once stripped; every one of those characters is a docblock
  example.
- **Direct import, not the closure** — at depth 2 `lib/logger.ts` is "covered" by
  225 transitive tests. That is coverage by proximity.
- **Workspace imports resolve by SYMBOL**, so a backend test importing
  `normalizeSourceConditionLabel` from `@mercaria/shared-types` credits the module
  that declares it and not all 120 in the package.

The stated limit: no character census can tell a fixture that is asserted on from
one that is not. It raises the cost of an empty fixture; the reviewer reads the
diff.

## The exemption register

Not every fold needs every script, and the judgement turns on **where the folded
value came from** — which is not statically derivable. The evidence:
`utils/slug.ts` and `services/referrals/rewards/forbidden-funding.ts` carry
nearly the same regex (`[^a-z0-9]` → replace) over a seller's product title and a
funding-code identifier respectively. No scan tells those apart.

Four things keep the register from becoming an off switch:

1. **Exact in both directions** — an exemption for a module that is no longer a
   fold fails, rather than lingering.
2. **A closed reason vocabulary**, not free text: `machine_alphabet`,
   `latin_only_corpus`, `runner_cannot_reach`, `canonical_composition_only`.
3. **Each entry pins the construct it was judged about**, and the gate asserts
   that fragment is still in the file — so an exemption cannot outlive its
   evidence. (`fixture-date-census.test.ts`'s staleness check, pointed at the
   construct rather than the file.)
4. **Two of the four reasons are CHECKED, not asserted**, and that is the shape to
   imitate. `runner_cannot_reach` is verified against the package's own vitest
   `include` globs, so widening them retires the exemption.
   `canonical_composition_only` is verified to be NFC and nothing else — NFKC and
   NFKD are compatibility mappings and lossy, and NFD is the first half of two of
   the three defects above.

`runner_cannot_reach` earned its place by catching its author: the first draft
excused a dashboard screen as "the package ships no test runner", the check
refuted it (`@mercaria/dashboard` runs `vitest`), and the real reason turned out
to be narrower and checkable — the runner is `lib/**`-only with no renderer
(#469).

## What the gate found on its first run — filed as #838, FIXED

Three **live** instances of the #830 mark-eating mechanism, in three domains
#830 never touched. Fixed in #838; the register in
`text-fold-script-behaviour.test.ts` is now empty and all three sit in
`MARK_PRESERVING_FOLDS`, which asserts two properties of every member: two words
differing only in marks stay distinct, AND a mark-bearing input still carries a
mark on the way out.

| Module | Fold | Measured before the fix |
|---|---|---|
| `shared-types/src/condition.ts` | `normalizeSourceConditionLabel` | `साइकिल` and `साइकिलें` both → `"स इक ल"`; `नया` → `"नय"` |
| `services/analytics/redact-query.ts` | `normalizeQueryTokens` | `साइकिल` → `["स","इक","ल"]`, colliding with `साइकिलें` |
| `services/catalog-external-mappings/transform-rules.ts` | `strip_diacritics` | `साइकिल`/`साइकिलें` → `"सइकल"`; hiragana `じてんしゃ` → `してんしゃ`; and, not in the original report, Cyrillic `красный` → `красныи` and `ёлка` → `елка` |

### No backfill migration, and the reason is different at each site

#833 recorded all three as needing one, because all three were believed to write
a stored lookup key. Measured against a real migrated database, that is true of
two of them and the third writes nothing — and neither of the two can be
back-filled:

| Site | Stored column | `is_generated` | UNIQUE | Backfill |
|---|---|---|---|---|
| condition label | `condition_source_mappings.source_label_normalized` (NOT `condition_mapping_rules`, which does not exist) | `NEVER` | **yes**, with `ruleset_id` | **Impossible.** `condition_source_mappings_frozen` raises on any UPDATE of a row whose ruleset is not `draft`. The schema's own answer to a changed fold is to publish a new ruleset version. |
| query tokens | `analytics_search_queries.normalized_tokens`, and `analytics_query_aggregates.normalized_query` rolled up from it | `NEVER` | tokens no; `normalized_query` **yes**, with `(bucket_date, market)` | **Wrong to attempt.** An aggregate row is a historical count for one DAY, so re-keying it rewrites history; and `redacted_text` is nulled at `text_expires_at`, so for anything past 30 days the input no longer exists. Production collection is `off`. |
| `strip_diacritics` | none | — | — | **Nothing to back-fill.** `applyExternalTransform`'s output is returned to the caller and never inserted; `catalog_external_token_observations` stores `observed_raw_value`, the RAW value. The only `*_normalized` column in that domain is `external_key_normalized`, `GENERATED ALWAYS AS lower(btrim(external_key))`, which no JavaScript fold feeds. |

The fold change can only ever SPLIT a key and never merge two, so no UNIQUE
index can start refusing a write: adding `\p{M}` to the kept class removes
separators, which makes the new key a refinement of the old one.
`condition-taxonomy.test.ts` asserts that over a fixture set with a counted floor
of colliding pairs. The one exception is bounded and harmless —
`normalizeQueryTokens` drops a token longer than `MAX_TOKEN_LENGTH`, and a token
that is now whole may exceed it where its fragments did not, on a table with no
unique index over it.

So the trade is #834's, in the safe direction: an **invisible precision failure**
(a wrong condition key on an offer, two Hindi searches counted as one) for a
**visible recall failure** (a pre-existing mapping rule stops matching its label
until an operator republishes the ruleset; a mapping citing the retired
`strip_diacritics:1` answers `transform_refused` and routes to review).

Two more, a different class — total loss rather than mark loss, recorded because
"empty" is not "mostly right":

- `utils/slug.ts` `slugify` returns **`""`** for every non-Latin script, so a
  Hindi store handle or category slug is empty.
- `services/ingestion/seller-identity.ts` returns the constant `"seller"`, so
  every non-Latin seller on one marketplace shares a segment.
- `services/feed-import/upload.ts` **refuses** a non-Latin filename — the same
  ASCII class failing the safe way round, loudly.

And one inconsistency worth knowing: half-width katakana (`ｼﾞﾃﾝｼｬ`) is unified
with the full-width form by the three NFKC folds and not by the three NFD or
pass-through ones, which decides whether a Japanese buyer's query matches a
Japanese seller's title.

## Adding a locale, or a fold

- **A new locale bundle** demands its script automatically. Add a sample to
  `SCRIPT_CORPUS` — the gate fails naming the script until you do — with a gloss,
  and a `variant` differing only in marks where the script has one.
- **A new text fold** joins the surface automatically. Give it a case in
  `text-fold-script-behaviour.test.ts` if it is pure, or a fixture in a test that
  imports it directly. If it genuinely needs no script coverage, add a register
  entry with one of the four reasons and pin its construct.
