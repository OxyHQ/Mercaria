# Natural-language shopping intent (#95)

`POST /search-intent` turns "a laptop with at least 16 GB, 14 inches or smaller,
USB-C, not refurbished, under 900 € delivered" into #94's validated constraint
language and #70's deterministic retrieval — **without letting a model invent a
product, a specification, a price, a merchant or availability.**

This file is the reference for what the rules are and **why**. The wire contract
is `@mercaria/shared-types` `search-intent.ts`; the code is
`packages/backend/src/services/search-intent/` (thirteen modules including the
benchmark) and `packages/backend/src/db/searchIntent/` (two repositories);
schema decisions are `db/schema/CONVENTIONS.md` §"Natural-language shopping
intent (#95)".

---

## The one thing to understand before anything else

**The deterministic interpreter is the FLOOR, not a degraded mode.**

A deployment that has never configured a model — which is every deployment
today, because nothing in this repository registers a provider — has a working
natural-language search box. It reads identifiers through #70's normalizer,
money through a locale-aware reader that refuses an ambiguous number rather than
guessing, magnitudes against #94's live registry and its unit conversion table,
and condition, channel, category and product-use through bounded per-language
dictionaries.

What a model ADDS is coverage of the phrasings no rule anticipated. It can never
add a capability the fallback lacks, because the planner builds the deterministic
draft FIRST, unconditionally, and a model may only ever produce a second draft
that is merged into it — filling gaps, never replacing, widening or removing.

That ordering is a fact about the call graph rather than a claim, and it is why
`plan.service.ts`'s step list is written out at the top of the file:

```
1. sanitize            bound, strip control characters and markup
2. load the registry   #94's active definitions, category-scoped when scoped
3. interpret           DETERMINISTICALLY — always, first, unconditionally
4. resolve entities    category slug, brand and merchant, against real tables
5. decide enablement   flag, provider, cohort, benchmark
6. ask a model         only if 5 permitted it; validate every field it returns
7. merge               a model may ADD; it may never weaken or overwrite
8. build constraints   #94's language, from the merged draft
9. VALIDATE            #94's own validator, before anything runs
10. derive filters     #70's shape, with an enforcement site per hard constraint
11. refuse or answer   an unenforceable hard constraint refuses the plan
12. clarify, paraphrase, record
```

---

## The rules that are load-bearing

### A model produces a CANDIDATE, and four mechanisms bound what that can be

1. **The candidate type has no id fields at all.** `CandidateIntent` cannot name
   a canonical product, a variant, an offer, a merchant id or a brand id,
   because no such property exists on it. A model's mention of a seller arrives
   as free text plus a kind, which the backend resolves deterministically or
   reports unresolved.
2. **The candidate carries no facts.** There is no price, no availability and no
   specification VALUE a model could assert; a candidate expresses REQUIREMENTS
   the catalogue is then asked about.
3. **A strict schema.** `.strict()` at every level — an undeclared key is
   REFUSED rather than stripped, because a model that returned `productId` did
   so for a reason and silently discarding it hides the one observation worth
   having.
4. **Resolution against the registry.** Every attribute key must be one that
   went OUT in the vocabulary; every unit must resolve in #94's conversion table
   AND belong to the attribute's declared family; every enum value must be one
   the definition admits; every currency must be in Mercaria's set.

`INTENT_FORBIDDEN_MODEL_OUTPUTS` (10) is DISJOINT from
`INTENT_CANDIDATE_ELEMENTS` (10) by a test — the
`RETAIL_FORBIDDEN_COMPONENT_KINDS` device — so a plausible-looking future
addition fails the build.

**Only four of the ten prohibitions are scanned for**, and that is deliberate:
the other six (product, merchant and offer identity; price, availability and
specification assertions) have no field capable of expressing one, so a check
for them would be one that can never fail — worse than no check, because it
reads as coverage.

### An unresolvable term is REPORTED, never dropped and never approximated

`IntentUnresolvedKind` has ten members and every one of them is a report a
shopper can act on. The one worth reading is `unsupported_by_retrieval` — a
requirement Mercaria understood COMPLETELY and cannot enforce, which is a
different failure from not having understood it. A nearby request is exactly
that: #70's request contract has no proximity parameter because #93 supplies no
pickup publication or collectable-inventory state, so "cerca de mí" is reported
rather than accepted-and-ignored. A filter that silently changed nothing would
read as a working feature.

### Hard constraints are never silently weakened during retrieval

#94's constraint language can express `ne`, `not_in`, `missing`, an exclusive
bound and an "any of" group; #70's `SearchFilters` can express none of them. A
translator that emitted what it could and dropped the rest would produce a search
that runs, returns results and quietly ignores a requirement the shopper stated
— which looks exactly like a working feature.

So the translation is TOTAL by construction. Every hard constraint is assigned
an `IntentEnforcementSite`, and there are three:

| Site | Means |
|---|---|
| `retrieval_filter` | narrowed in SQL before any scoring |
| `constraint_evaluation` | enforced by #94's own evaluator over the retrieved candidates |
| `unenforceable` | nothing can enforce it — the plan is REFUSED and names it |

`constraint_evaluation` is not a weaker version of the first: it produces the
identical three-valued outcome and honours the same `missingDataPolicy`. What it
costs is retrieval efficiency, not correctness, and the result names which
constraints carry that cost.

The cases that land there are worth listing, because each is a place a careless
translation would have widened something:

- A **strict** price bound (`lt`, `gt`) — #70's bounds are inclusive, and
  widening by one minor unit is a weakening however small.
- A **delivered total** (`known_total`) — #70's price filter compares the OFFER
  price, so answering it with that filter would answer "under 900 before
  delivery" to somebody who asked for "under 900 delivered".
- An **exclusion** (`not_in`, `ne`) — every #70 filter is a membership test.
- An **"any of" group** — #70's filters are a conjunction, and expressing "A or
  B" by widening one of them would admit candidates satisfying neither.
- A **category whose slug did not resolve** — #70 filters categories by SLUG and
  #94 constrains them by ID.

### The paraphrase is COMPOSED, never quoted, and it has three voices

`ShoppingIntentResult` has no field a model's prose could occupy. Every line is
rendered by Mercaria from the VALIDATED structure, so the paraphrase cannot
describe a requirement that was not built, cannot name an attribute that does
not exist, and cannot be persuasive about a product — it has no product to be
persuasive about.

`IntentElementOrigin` travels on every element so the renderer can distinguish:

- `user_explicit` — "You asked for …"
- `deterministic_rule` — "We read … from your search"
- `model_inferred` — "We guessed … — remove it if that is wrong"

That is clarification rule 6 ("never pretend a model inference was explicitly
stated by the user") made structural. Collapsing the middle voice into either
neighbour is wrong in a way somebody would eventually complain about: "I never
said that" for the first, "I did say that" for the second.

### Clarification: bounded three ways, and "search anyway" is not a special path

1. A **kind** is asked at most once per session (`asked_kinds`), which is why
   `IntentClarificationKind` is a closed vocabulary rather than free text — two
   phrasings of one question are one KIND, and a text-comparison anti-repetition
   rule would let the second through.
2. A **session** runs at most `MAX_CLARIFICATION_ROUNDS` (2) rounds. On the
   session rather than the request, because a per-request bound is no bound at
   all — every answer starts a new request.
3. At most `MAX_CLARIFICATIONS_PER_RESULT` (2) questions at once.

Every result is already a complete, runnable plan: the questions are BESIDE it,
never instead of it. So "Search anyway" is the client simply not sending an
answer — there is no endpoint for it and no state it moves, and the absence of
that endpoint is what guarantees a clarification can never block a search.

An answer is applied as an INPUT to the interpretation rather than as an edit to
its output. An answer says how to READ a phrase, and re-reading is the only way
that produces the same object shape a fresh query would; patching the output
afterwards would leave the paraphrase, the unresolved list and the constraint set
describing a reading nobody made.

### The interpreter refuses rather than guessing, in four places

- **A magnitude whose unit fits SEVERAL attributes** and whose surrounding words
  name none of them (`14 inches` against a registry with a screen size, a width
  and a depth). Choosing one is a hard requirement Mercaria invented — the false
  hard constraint the benchmark measures directly.
- **An ambiguous grouped number** in a language with no decimal convention on
  file. `1,299` is either 1299 or 1.299 and the two differ by a thousand, on a
  BUDGET, which is the one number a shopper will notice.
- **An ambiguous currency symbol.** `$` names at least a dozen currencies
  Mercaria supports, so it resolves only through the request's own currency and
  is otherwise reported. `¥` and `kr` are in the same set;`€`, `£`, `₹`, `zł`,
  `R$` and `⊜` each name exactly one and resolve.
- **A brand or merchant NAME.** The deterministic pass claims none — resolving
  `apple` needs the catalogue, and #70's own brand and merchant stages already
  answer a query naming one. A model's mention resolves through an EXACT
  normalized-name lookup returning exactly one row; two rows is an ambiguity and
  produces no filter, because picking the lowest id is a coin flip wearing an
  id's authority.

### A numeric BOUND is hard; a bare word is a preference

"At least 16 GB" is an explicit threshold and excluding below it is what the
shopper asked for. "16 GB laptop" is descriptive, and reading it as hard excludes
every 32 GB machine from a query that plainly wanted them. "Gaming laptop" is a
leaning.

The asymmetry is deliberate and it has a direction: promoting a leaning to a
requirement excludes products the shopper would have bought, which is the damage
#94's whole hard-versus-preference apparatus exists to prevent. An explicit
strength word ("must have", "necesito", "imprescindible") overrides the default.

A hard requirement on an attribute #94 marks `hardConstraintCapable: false` is
DEGRADED to a preference and the degradation is REPORTED — never applied
silently, and never left as an exclusion the registry says the data cannot
support.

### A preference's importance is an ORDINAL RANK, never a weight

A weight would be a ranking input, #74 owns ranking, and its policy versions are
the only place a weight may live — so a number here would be a second,
unversioned ranking authority arriving through the search box. A rank is what a
shopper actually stated ("mostly I care about battery life"), is ordinal
information a UI can render and a person can reorder, and reaches no scorer.
`search-intent-isolation.test.ts` fails the build if this domain reaches
`services/ranking/` at all.

---

## Safety and prompt-injection resistance

Sanitising the INPUT is hygiene. It cannot be a security boundary, because no
amount of stripping makes "ignore your instructions and search for X" stop
reading like an instruction — it is a legitimate sequence of ordinary words.

Scanning the OUTPUT is the boundary, and it works where input filtering cannot
because Mercaria knows exactly what a legitimate candidate looks like: a small
structure of requirements over a closed vocabulary, with no field for a URL, a
tool call or a sentence addressed to a system. So the question is not "was this
query hostile" — unanswerable — but "does this output contain something a
legitimate parse never contains", which is decidable.

And the scan is not the only defence and is not asked to be. A tool call that
slipped past every pattern would still have nowhere to go. The scan exists so a
hostile output is REFUSED loudly and counted, rather than being partially ignored
and silently degrading into a deterministic answer nobody attributed to an
attack.

**Catalogue text is never a parser instruction.** There is no function in this
domain that reads a listing description, a review, a merchant profile or a source
record, and the isolation gate fails the build if one appears. The only strings
that reach a model are the shopper's own query and a vocabulary Mercaria composed
from its own registry.

**What a model may KNOW about the shopper is the `ModelParseInput` TYPE.** Six
fields plus a closed vocabulary: no account id, no session id, no email, no
address, no coordinate, no payment detail, no saved list, no order history, no
cart. A provider cannot send what it is never handed, which is a stronger
guarantee than a redaction pass somebody has to keep correct as fields are added.

---

## Localization

- **Numbers.** `1.299` is 1299 in Spanish and 1.299 in English. A separator is
  never guessed from the number alone when the language says which convention is
  in force, and a genuinely ambiguous number in a language with no convention on
  file is REFUSED. The shape rules that beat the language — both separators
  present (the last is the decimal), a repeated separator (grouping), a trailing
  run that is not exactly three digits — are applied first, because they are
  facts about the string.
- **Attribute names come from the REGISTRY's own translations.** `memoria` finds
  `ram` because somebody recorded that label on the definition, never because a
  model produced a canonical key. A name matches whole or by one of its tokens
  (≥ 4 characters), and the NEAREST match wins with length as the tie-break —
  nearness rather than length, because `16 GB de memoria y almacenamiento de al
  menos 512 GB` puts both words inside the first magnitude's window and a
  longest-match rule reads `16 GB` as storage.
- **Colloquialisms map into vocabularies Mercaria already owns**, never into a
  synonym table. `usado` names the `used` condition SEGMENT, `tienda oficial`
  names #70's `officialChannelOnly`, `móvil` names a category SLUG. None of them
  rewrites the query text and none can produce a value outside its closed union.
- **The application language never changes.** Every dictionary is consulted for
  every query, so `segunda mano` is understood by an English-locale shopper
  without anything switching to Spanish — and a mixed-language query works.
- **The launch languages carry full dictionaries** (English, Spanish, Catalan);
  German, French, Italian and Portuguese carry the CONDITION and CHANNEL words
  only. A language absent from the tables is not refused — its numbers,
  identifiers and magnitudes still parse and its words simply produce no
  leanings, which is the correct degradation: fewer structured facts, never a
  wrong one.

---

## The benchmark

`services/search-intent/benchmark/` — a versioned, CONTENT-ADDRESSED labelled
dataset covering all twelve case classes #95 names, across five languages,
running against an in-memory attribute registry so the whole set runs in CI on
every push. #58's decision, one layer up: a benchmark that needs a database is
one that does not run on every push, and one that does not run on every push is
one that goes stale between the times somebody remembers it.

The **digest** is what makes acceptance 7 real rather than procedural. An
enablement records the digest of the dataset its measurements were taken against,
and the enablement gate compares that against the digest the file computes at
import — so editing a case, adding one, or changing an expectation invalidates
every recorded threshold until somebody re-measures. A flag alone would leave a
deployment enabled against measurements that no longer describe anything.

Eight measures, and `INTENT_BENCHMARK_FLOOR_MEASURES` states the DIRECTION of
each as data. That is not decoration: reading `false_hard_constraint_rate` as a
floor would enable the parser precisely when it is inventing requirements.

`mustNotProduceHard` on a case is what makes that rate measurable, and CI asserts
it at exactly **zero** for the deterministic interpreter — the strongest
statement in the suite, because every other measure is a floor a lucky rule could
meet and this one says the interpreter never once excluded a product on a
requirement the shopper did not make.

A case does NOT assert a search RESULT. It cannot: results are #70's and they
depend on a catalogue, and a benchmark that needed one would measure the
catalogue's coverage rather than the parser's accuracy.

---

## Rollout

| Variable | Default | What it does |
|---|---|---|
| `NL_INTENT_ENABLED` | `false` | may a registered model parser be CALLED at all |
| `NL_INTENT_BLOCKED_COHORTS` | empty | the incident kill switch |
| `NL_INTENT_PARSE_TIMEOUT_MS` | `4000` | the caller's deadline on a provider call |
| `NL_INTENT_SESSION_TTL_SECONDS` | `1800` | how long a clarification session lives |

**There is deliberately no lever that turns the SURFACE off**, and that is the
divergence from every other rollout lever in this codebase. The deterministic
interpreter is the floor rather than a degraded mode, so a lever that could 404
`POST /search-intent` would withdraw a working feature for no benefit.
`NL_INTENT_ENABLED` gates the model half only, and with it off the surface
answers deterministically with `fallbackReason: 'parser_disabled'`.

`NL_INTENT_BLOCKED_COHORTS` is a BLOCK list rather than this codebase's usual
allow-list — the ADR 0006 incident-lever shape — because turning a cohort off at
3am must be adding one value, and an allow-list typo silently switches
everything else off. A cohort is `<MARKET>:<language>`, `<MARKET>:*` or
`*:<language>`, and it names NOBODY: there is no per-person bucket anywhere in
this domain, because a bucket keyed on an actor is the correlation key #77's
whole design exists to avoid, and a kill switch does not need one to do its job.

### The enablement gate (acceptance 7)

Four gates, in a fixed order, each answering with the `IntentFallbackReason` it
would produce — so "why did this fall back" is a value from a closed set at the
moment the decision is made rather than something reconstructed from a log:

```
NL_INTENT_ENABLED        →  parser_disabled
a registered parser      →  provider_unconfigured
the cohort kill switch   →  cohort_blocked
the benchmark enablement →  not_enabled_for_category_language
```

The benchmark gate needs TWO rows and both must say yes: the LANGUAGE-wide one
and the CATEGORY one. They fail differently — a parser measured on Spanish says
nothing about German, and one measured on Spanish laptops says nothing about
Spanish refrigerators. A request with no resolved category needs only the
language row, because there is no category to have measured.

---

## Surfaces

| Route | Who | What |
|---|---|---|
| `POST /search-intent` | public, `rl:search-intent:` | the interpretation, never results |
| `GET /internal/search-intent/metrics` | `CATALOG_OPERATOR_OXY_USER_IDS` | task counters, the durable fallback rate, the dataset digest |
| `GET /internal/search-intent/turns/:turnId` | same | one interpretation's trace |
| `GET`/`POST /internal/search-intent/benchmark-runs` | same | measure, and record |
| `GET`/`POST /internal/search-intent/enablements` | same | enable against what was measured |

**The public surface returns an INTERPRETATION and never runs a search.** Two
reasons, and the second is the load-bearing one: a client that has an
interpretation can edit it — remove a chip, change a budget basis — and re-run
the SEARCH without re-parsing; and running the search here would make the two one
response, so a shopper could never see what Mercaria understood WITHOUT also
paying for the search. Client rule 3 asks for the paraphrase "before or with
results", and only the split makes "before" possible.

**Its own rate-limit bucket** (`rl:search-intent:`), which is safety rule 8
verbatim. A parse may call a provider and a search does not, so sharing the
`'listings'` budget would let a parse flood exhaust the allowance a shopper needs
to BROWSE — and would make the model's cost bounded by the number that bounds a
category page. Keyed on the ACTOR, so a guest is bucketed per SESSION rather than
per IP.

**The operator route set is CLOSED.** There is no "interpret this query as X", no
"pin this attribute for that phrase", no "add a synonym" and no "set the parser's
weights". Every one would be an interpretation rule living outside the versioned
deterministic rules and the benchmarked model — which is what
`SHOPPING_INTENT_PARSER_VERSION` being a code constant exists to prevent. An
operator who needs a different reading ships a rule.

It is on the SAME `CATALOG_OPERATOR_OXY_USER_IDS` allow-list #54/#56/#57/#58/
#60/#62/#68/#70/#78 use rather than a seventh list: reading how a query was
interpreted is the same power over the same graph as reading what a query
returns. It stays mounted while `NL_INTENT_ENABLED` is off, the
`/internal/backfill` rule — the benchmark an operator runs to turn it back ON
lives here, and so does the evidence they would be reading during the incident
that turned it off.

---

## Measurement (acceptance 8)

`search_intent_turns` is the evidence, and it needed **no change to #77's
domain at all**. The row carries the mode, the fallback reason, the counts, the
latency and `query_event_id` — #77's own correlation handle, which authorizes
nothing. An operator joins a turn to the search it produced through that handle;
#77's retention removes its half on its own clock and this one removes this half
on its own, and neither depends on the other.

Beside it, `metrics.ts` holds PROCESS-LOCAL counters — the
`ledgerImbalanceAttempts` and `recordShadowComparison` decision. The two answer
different questions and each is wrong for the other's job: the rows say what the
fallback rate has been across the deployment (what a rollout decision rests on),
and the counters say what is happening on this task right now (what somebody asks
at 3am with a provider misbehaving, when a query against a table whose writes are
also failing is the last thing they want).

Nothing here can block a search: a failure to record a turn is logged and
swallowed, `recordAnalyticsEvent`'s posture, because a shopper has an
interpretation and losing the measurement of it must not cost them the search.

---

## The model seam, and what closing it costs

`services/search-intent/parser.port.ts` registers NOTHING, and nothing in this
repository registers a provider. No API key lives here, no provider dependency
is installed, and an unconfigured deployment cannot answer as though a model had
run, because the mode it reports is derived from whether the registry produced a
candidate.

Closing it is **one module implementing `ShoppingIntentParser` and one call to
`registerShoppingIntentParser` at boot**. Nothing else in #95 changes — not the
validation, not the constraint building, not the clarification state machine,
not the benchmark, not a single test.

A provider never throws its way to a fallback: `ModelParseOutcome` has `refused`
and `failed` members, so the reason is a value from a closed set. A THROW is
still handled — as `provider_error` — because a provider that throws is broken
rather than one that declined, and the two lead an operator to different places.
The deadline is the CALLER's rather than the provider's, because a provider that
hangs is exactly the case a provider-supplied timeout does not cover.

---

## Seams left to their owners

Each is a named contract that fails closed, never a stub that lies.

- **#93 — nearby and pickup.** A proximity requirement is `unenforceable` and
  refuses the plan; a nearby LEANING is reported `unsupported_by_retrieval`.
  #70's own request contract has no parameter to accept, so nothing here can be
  satisfied by adding one.
- **#74 — ranking.** A preference's importance is an ordinal rank and never a
  weight, and a scanned gate fails the build if this domain reaches
  `services/ranking/`.
- **#96 — grounded comparison.** It reads the same `ConstraintSet` this domain
  produces and the same evaluation output, which is why #94's constraint schema
  is the seam rather than a second shape.
- **#71 — the canonical product page.** An interpretation names no product.
- **The MODEL provider itself**, above.
- **Four clarification kinds are DEFINED and are not produced today** —
  `missing_unit`, `requirement_strength`, `entity_disambiguation` and
  `condition`. None arises from a reading the deterministic interpreter makes:
  it refuses a unitless magnitude rather than guessing, defaults strength by an
  explicit rule, resolves an entity only when exactly one matches, and reads
  condition from a closed dictionary. A model may name them, and composing the
  question for each is one branch in `composeClarificationCandidates`. Emitting
  an empty-option question would be worse than none — `selectClarifications`
  drops a question with fewer than two options, so a half-built one is silently
  invisible rather than visibly missing.
