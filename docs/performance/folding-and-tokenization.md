# Folding and tokenization, measured

#367 Workstream 5 asks for two things — *"define language-aware
tokenization/folding behavior **and benchmark it**"*. The definition existed and
was good. Nothing measured it, and the reason the absence was invisible is the
point of this file.

Code: `services/graph-benchmark/folding.ts` (the corpus and its floors) ·
`db/__tests__/folding-benchmark.realdb.test.ts` (the CI gate) ·
`scripts/folding-index-benchmark.ts` (the opt-in cost measurement). The
behaviour under measurement belongs to `services/canonical/normalization.ts`,
`@mercaria/shared-types` `catalog-search-configuration.ts` and
`db/catalog/listingRepository.ts`; **this work changed none of it.**

## The gap

Mercaria folds catalogue text three different ways, each matched write-side to
read-side, each unit-tested:

| space | write side | read side | fold |
|---|---|---|---|
| `normalized_name` | `normalizeEntityName` | the same function on the query | accents, case, punctuation, trailing legal suffixes |
| `normalized_alias` | GENERATED `lower(btrim(alias))` | `normalizeAliasLookup` | case only, deliberately |
| `search_vector` | `to_tsvector(<config>, …)` | `websearch_to_tsquery(<config>, …)` | language-specific stemming |

#61's harness is the only place in this repository that measures catalogue
reads. It builds every name from a table of thirty ASCII syllables and twelve
ASCII nouns, so **no shape it has ever run fed a single accented or non-Latin
character to any of the three folds.** `kavor m7k2 headset` normalizes to itself
in all three, which means an ASCII corpus cannot tell an accent-folding space
from the identity function — a fold that stopped folding would have left every
shape green.

### The claim, stated the way it survives measurement

It is tempting to say "the harness contains no non-ASCII". That is **false**, and
saying it would be the kind of imprecision this directory exists to avoid: the
six harness files hold 161 characters above U+007F between them. Every one of
them is **prose** — em-dashes and curly apostrophes inside comments and inside
the `title` and `provenance` strings the report prints, plus ellipses in the
generator's progress log.

The claim that is true, and that is the one the benchmark rests on, is narrower
and stronger: **no non-ASCII character reaches the seeded catalogue text or any
shape's query literal.** Measured at the seed inputs rather than at the files:

| what a generated name is built from | entries | non-ASCII |
|---|---|---|
| `SYLLABLES` | 30 | **0** |
| `NOUNS` | 12 | **0** |
| every `text:` literal any shape sends | 1 (`'bicycle'`) | **0** |

Positive control, so those zeroes are real zeroes rather than an instrument that
cannot read UTF-8: the same scan counts **42** em-dashes (U+2014) in
`dataset.ts` and 52 in `workload.ts`.

## Finding 1 — the three spaces disagree, and the disagreement is the answer

Every cell below was measured against PostgreSQL 17.5 on
`postgis/postgis:17-3.5`, end to end: a real `listings` row, a real
`listing_localizations` row whose generated column analyses the text, read back
through `searchListingsPage` — the function `GET /listings` calls.

| the two spellings differ by | `normalized_name` | `normalized_alias` | `search_vector` |
|---|---|---|---|
| case only | finds it | finds it | finds it |
| an accent (French, Spanish, Portuguese) | **finds it** | misses it | **misses it** |
| an accent (German, Arabic) | finds it | misses it | **finds it** |
| an inflection (plural, case ending) | misses it | misses it | **finds it** |

Three spaces, three different answers, and each is right for its own question.
The two consequences worth stating in plain terms:

- **A French shopper typing `bicyclette en bon etat` finds the BRAND and not the
  LISTING.** The canonical name space folds the accent away; the full-text space
  does not.
- **Only the full-text space crosses a plural.** `bicyclette` does not find
  `bicyclettes` in either normalization space, because those compare strings and
  a plural is a different string.

### The exception nobody would guess

`docs/catalog-search-configurations.md` states, without qualification, that
**accents are not folded**. That is true of `french`, `spanish` and
`portuguese`. It is **false for two of the ten configurations in the map**:

- **German** — the Snowball stemmer folds umlauts while stemming, so `grüner`
  and `gruner` both become `grun` and an unaccented query matches.
- **Arabic** — the stemmer normalizes the taa marbuta away, so `دراجة` and
  `دراجه` both reach `دراج`.

Arabic additionally inverts the whole table: `normalizeEntityName` does **not**
unify those two spellings, so for Arabic the full-text space folds *more* than
the name space — the exact reverse of French. This is a property of the
stemmers, not a defect in anything Mercaria wrote, and it is pinned by
`folding-benchmark.realdb.test.ts` so it cannot be edited away in prose without
a red build.

## Finding 2 — what the per-locale analyser buys, isolated

The cleanest form the question takes: **identical stored text, identical query,
two locales.**

| probe | locale | configuration | stored | query | result |
|---|---|---|---|---|---|
| `analyser-french` | `fr` | `french` | `guitars` | `guitar` | **finds it** |
| `analyser-simple` | `ja` | `simple` | `guitars` | `guitar` | misses it |

Nothing but the configuration differs, so the difference is attributable to the
map rather than to the words. `findFoldingVacuityViolations` has a floor
requiring such a pair to exist, because without one a claim that a locale's
analyser beats `simple` rests on the words being convenient.

Stemming is not magic, and the corpus says so rather than implying otherwise:
**`ca-inflection` is a measured negative.** The Catalan stemmer takes
`bicicletes` to `biciclet` and `bicicleta` to `bicicl`, so it does **not** unify
a real singular/plural pair. A matrix in which every analysed locale succeeded
would suggest a guarantee none of them gives.

## Finding 3 — what the localized index costs, and what it buys

### What it costs to maintain

`scripts/folding-index-benchmark.ts`, 20,000 rows, interleaved trials per arm
(8 for runs 1 and 2, 10 for run 3), against tables cloned with
`LIKE listing_localizations INCLUDING GENERATED` so the expression under test is
the deployed one.

**Three independent runs.** Absolute milliseconds, because the ratios are not
reproducible enough to publish — see below, which is a finding rather than a
caveat.

| operation | arm | run 1 | run 2 | run 3 |
|---|---|---|---|---|
| INSERT | plain row write | 21.1 ms | 26.0 ms | 20.3 ms |
| | + generating the `tsvector` | 222.9 ms | 222.4 ms | 215.4 ms |
| | + the GIN index | 288.5 ms | 303.9 ms | 298.2 ms |
| UPDATE | plain row write | 26.3 ms | 25.2 ms | 25.0 ms |
| | + generating the `tsvector` | 234.2 ms | 235.0 ms | 229.2 ms |
| | + the GIN index | 330.7 ms | 332.8 ms | 317.7 ms |

The two statements that survive all three runs:

- **Generating the `tsvector` costs ~195–210 ms per 20,000 rows**, against a
  bare row write of ~20–26 ms — an order of magnitude, whichever run you take.
- **The GIN index adds 66–98 ms on top of that.**

Worst inter-quartile range across the arms was 27.2 ms against effects of 66 to
210 ms, so every arm is resolved rather than asserted.

#### The ratios are NOT reproducible, and the third run is how I know

This began as a single run reporting `+956% / +791%` for generation and
`+29.4% / +41.2%` for the index. A second run moved the generation figure by two
hundred percentage points, so those were replaced with bands. **A third run then
fell outside the bands too** — `+38.5%` on insert against a published `+29–37%`,
and `+38.6%` on update against a published `+41–42%`.

Nothing is unstable about the instrument, and that is the point:

| | spread across three runs |
|---|---|
| absolute GIN cost | 66 → 98 ms |
| absolute vector cost | 195 → 210 ms |
| **GIN cost as a percentage** | **+29% → +39%** |
| **vector cost as a percentage** | **+756% → +960%** |

The **absolute** figures move by a few percent; the **ratios** move by a third,
because the denominator is a ~20 ms baseline and a few milliseconds of drift
there swings anything computed against it.

**A ratio over a small baseline is less reproducible than either of its terms,
and a single run's percentage looks exactly as authoritative as a stable one.**
It took three runs to stop publishing one, and the band that had to be widened
twice is left visible above rather than quietly replaced by the final numbers.

**The headline is the ~200 ms, not the 66–98 ms.** The expensive part of a
localized listing write is building the `tsvector`, and that is the GENERATED
COLUMN — paid whether or not any index exists. The index is a minority of a cost
already committed to. Compare #61, whose offer sort index costs +19% on an
upsert and +70% on a price update: that one indexes cheap scalar columns, so the
index IS the cost there and is not here.

### What it buys on the read side

20,000 localization rows, of which **20** carry the probe term (0.1%). Plan facts
from one instrumented `EXPLAIN`; latency from twelve uninstrumented interleaved
executions per arm — **two clocks, never averaged.**

| | plan over `listing_localizations` | rows discarded | p50 |
|---|---|---|---|
| with the index | `Bitmap Index Scan on listing_localizations_search_vector_idx`, `Index Cond: search_vector @@ …` | 0 | **10.30 ms** |
| index dropped | `Bitmap Index Scan on listing_localizations_locale_key`, the term applied as a `Filter` | **19,980** | 14.57 ms |

**1.4×, resolved** (delta 4.27 ms against a worst IQR of 2.55 ms). The absolute
win is modest because the outer `listings` scan dominates at this size; what the
plan shows and the clock does not is the part that grows — without the index the
localization scan is O(rows in that locale) and reads all 20,000 to return 20,
while with it the work is proportional to the matches.

#### The first fixture could not have shown this, and it passed its floor

The first attempt seeded 20,000 rows all carrying the *same* French text, so the
probe term matched **100%** of them. A sequential scan was then the correct plan,
the index "bought" 1.1×, and the vacuity floor — *the predicate must match rows*
— **passed**. It was the wrong floor: a fixture can be non-empty and still be
structurally unable to show an index winning. The floor is now two-sided (match
some rows, and match far fewer than all), which is the same lesson as an
`ORDER BY` fixture that has to be adverse against every plan, wearing a new
costume.

#### And `EXPLAIN ANALYZE`'s own `Execution Time` reversed the verdict

Worth recording because it is the rule's sharpest illustration in this
repository. The instrumented runs reported **31.778 ms** indexed and **18.390 ms**
unindexed — the *opposite* order to the twelve uninstrumented runs above (10.30
vs 14.57). Quoting those would have concluded that the index makes the read
slower. `EXPLAIN ANALYZE` really executes and its timing carries the cost of
measuring plus whatever the buffer cache happened to be doing (the indexed plan's
own `Buffers` line shows `read=154 written=108` — the index had just been
created). **Never quote `Execution Time` as the latency.**

### And what it costs on a REAL localization write: not resolvable, and here is why

Against the real `listing_localizations` table, 20,000 rows, 10 interleaved
trials, the index's effect stayed **inside the noise** (delta ≈ 78 ms, IQR ≈
138 ms). Rather than report a percentage from that, the cause was measured:

| component of a real 20k-row localization insert | measured |
|---|---|
| total, as shipped | ≈ 2,460 ms |
| of which the per-row revision trigger | **1,798 ms (73%)** |
| remainder (row write + tsvector + index + FK + three other indexes) | ≈ 662 ms |

`mercaria_listing_localization_revision` fires `AFTER INSERT OR UPDATE FOR EACH
ROW` and writes **two** `catalog_localization_revisions` rows per localization
row — one per localized field — verified by counting: 40,000 revisions for
20,000 rows with the trigger on, 0 with it off.

So the honest statement is three separate measurements and no arithmetic joining
them into a fourth: the index costs ~30–40% of a *vector-generating* write; a
*real* localization write is dominated by the revision trail; and the index's
share of the real write could not be resolved by this instrument. **A first
attempt at this reported "+1.2% on insert, −1.5% on update" from three blocked
trials — both numbers were noise, and a null result and a blind instrument look
identical.** That is why every figure above is printed beside the spread it had
to clear, and why `compare()` prints `NOT RESOLVED` instead of a percentage when
it cannot.

## Finding 4 — `normalizeEntityName` corrupts four of the twelve catalogue languages

**This is a defect. It is recorded, not fixed** — this work was a measurement
task and changing a fold is a separate, deliberate change.

`normalizeEntityName` was designed for Latin diacritics and is applied to every
canonical entity name regardless of script. Measured:

| language | input | `normalizeEntityName` returns | |
|---|---|---|---|
| French | `état` | `etat` | preserved — the fold doing its job |
| Arabic | `دراجة` | `دراجة` | preserved |
| Chinese | `自転車` | `自転車` | preserved |
| **Hindi** | `साइकिल` | `स इक ल` | **corrupted** |
| **Bengali** | `সাইকেল` | `স ইক ল` | **corrupted** |
| **Japanese** | `ジャンク` | `シ ャンク` | **corrupted** |
| **Russian** | `красный` | `красныи` | **corrupted** |

Two independent mechanisms, which compound in Japanese:

1. **The punctuation collapse eats Unicode Marks.**
   `replace(/[^\p{L}\p{N}]+/gu, ' ')` keeps Letters and Numbers and turns
   everything else into a space. Indic vowel signs (matras) are category **M**,
   not L — so each becomes a space and the word is returned as fragments with
   its vowels removed. Attributed step by step: NFD and the `U+0300–U+036F`
   strip both leave `साइकिल` intact; the loss happens at the collapse.
2. **The NFD strip changes LETTERS, not accents.** Cyrillic `й` decomposes to
   `и` + U+0306 and Katakana `ジ` to `シ` + U+3099. Dropping the mark yields a
   *different letter*: `красный` → `красныи`, and `ジ` → `シ` — then mechanism 1
   turns the orphaned U+3099 into a space, so `ジャンク` (*janku*) reads
   `シ ャンク` (*shi anku*).

### Why this is worse than lost information

`normalized_name` is the space #53 generates **merge candidates** in. Measured:

```
normalizeEntityName('साइकिल')   === 'स इक ल'   // bicycle
normalizeEntityName('साइकिलें') === 'स इक ल'   // bicycles
```

Two different Hindi words collide on one normalized string. The positive control
is in the same test: `bicicleta` and `bicicletas` do **not** collide, so this is
a property of the fold meeting Devanagari and not of the two words being
similar.

Whether Indic-script or Japanese canonical names exist in the catalogue today is
a separate question this measurement does not answer. What it establishes is
that the fold cannot represent them, in an epic whose subject is a multilingual
catalogue and which ships `hi`, `bn`, `ja` and `ru` as catalogue locales.

`SCRIPT_INTEGRITY_SAMPLES` pins the current behaviour, defects included, so the
corruption is visible in a report instead of being discovered in a catalogue.
**Fixing the fold is expected to turn those rows red** — that is the signal, and
the fix updates the table in the same change.

## What makes this a benchmark rather than a demonstration

Every floor lives in `findFoldingVacuityViolations`, runs **before** a
connection is opened, and has a mutation self-test in `folding.test.ts` that
weakens the corpus in exactly the way the floor exists to catch:

| floor | what it refuses |
|---|---|
| every `accent` probe carries a non-ASCII character | an accent probe spelled in ASCII, which measures nothing while looking like the most relevant row |
| a **majority** of probes carry non-ASCII | drift back to the ASCII blindness this exists to remove |
| no space's expected column is constant | a column that cannot fail in either direction |
| every pair of spaces is separated by some probe | a corpus consistent with the three folds being one function |
| ≥5 configurations reached, `simple` among them | a corpus that cannot show the map discriminating |
| some probe shares its text across two configurations with opposite verdicts | a stemming win attributable to the words rather than the configuration |
| some probe where the tsvector space wins, and some where the name space does | a matrix that only ever shows one side winning |

The ASCII floor is a **proportion**, not a count. A count fitted to whatever the
corpus holds can never fail; a count with headroom is diluted by every ASCII
probe added afterwards. `folding.test.ts` proves the proportion has the property
a count lacks by padding the corpus with twenty ASCII probes and asserting it
goes red.

An unmet floor makes `renderFoldingReport` return `## THIS RUN MEASURED NOTHING`
and **no table at all** — `report.ts`'s early return, for its reason: a refusal
that still rendered a grid is one somebody reads a conclusion off.

## Where it runs

- **CI, every push:** `db/__tests__/folding-benchmark.realdb.test.ts`. Fourteen
  probes, seconds, its own throwaway database (forced: every localization insert
  fires the revision trigger and `catalog_localization_revisions` refuses
  DELETE, so the file cannot tear itself out of the shared one).
- **Opt-in:** `scripts/folding-index-benchmark.ts`, behind
  `FOLDING_BENCHMARK=1` **and** a database whose name contains `bench` — the two
  gates `graph-query-benchmark.ts` uses, because this script truncates scratch
  tables and drops and recreates a real index.

## What this deliberately does NOT do

- **It changes no fold.** Not `normalizeEntityName`, not the alias column, not
  the locale map, not the canonical entities' deliberate `'simple'` (ADR 0002
  D21). Finding 4 is reported and left.
- **It adds no shape to `WORKLOAD_SHAPES`**, and #61's own gates are why:
  `workload.test.ts` requires every shape's `workloadItem` to be one of #61's
  fourteen numbered entries (folding is #367's question and has none), and
  requires every shape to declare `minRowsReturned > 0` (half of what this
  measures is a read that correctly returns nothing, and relaxing that floor to
  admit these would disarm it for the fourteen shapes it was built for).
- **It seeds nothing into #61's dataset**, so no existing floor moves. Verified
  rather than assumed: the plan-regression suite was run before and after and
  reports 11 passed both times.
- **It does not install `unaccent`.** Worth recording precisely, because the
  claim in the tree is softer than it looks: `quality.service.ts` says `unaccent`
  is *"an extension this deployment may not have"*. Measured on
  `postgis/postgis:17-3.5` — the image CI and local development pin — it **is
  available** (`pg_available_extensions`, version 1.1) and simply not installed.
  What is unknown is the shared `oxy-postgres` RDS instance, which this
  measurement cannot reach. Installing it and wrapping **both** sides is a
  separate change, for the reason `catalog-search-configurations.md` gives.
