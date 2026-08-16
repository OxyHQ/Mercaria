# Grounded comparison and multi-merchant basket optimization (#96)

Comparing real canonical products, and working out the best way to actually buy
a set of them — with every specification, price, merchant, availability
statement and tradeoff grounded in a Mercaria record, and every claim a shopper
reads checkable against one.

Code: `services/comparison/` (18 modules), `POST /comparison`,
`POST /comparison/basket`, `POST /comparison/basket/revalidate`,
`@mercaria/shared-types` `comparison-basket.ts`, and `@mercaria/ui`'s
`ComparisonTableView`, `ComparisonExplanationBlock`, `BasketPlanCard` and
`lib/comparison-labels.ts` (the copy).

Binding dependencies: #44's money and FX, #57's offer model, #74's eligibility,
ranking and currency-safe conversion, #78's price history, #90's condition
taxonomy, #94's attribute registry and constraint language.

**NO new tables and NO migration.** That is the finding, not an omission — see
§"Why this domain owns no table".

---

## The separation that shapes everything

**The deterministic answer is computed first and unconditionally; a language
model may summarize it and may add nothing to it.**

Written the other way round — ask the model, fall back on error — the fallback
is a `catch` block, and a `catch` block is exercised by nothing. Here the
templated explanation is on the NORMAL path and a generated one is the
exception, so "the deterministic comparison and solver still work when model
services are unavailable" (acceptance 7) is the behaviour of every deployment
that has not registered a provider, which today is all of them.

Three consequences follow from putting it in that order:

- `ComparisonTableView` takes no explanation prop, so a page cannot make the
  table conditional on a model having answered.
- `explainComparison` never throws. A provider that rejects its promise becomes
  a `provider_error` rejection carried on a templated result.
- The templates are asserted to PASS the validator, so the fallback and the
  generated path agree on what a grounded sentence is. A change to one that
  breaks the other is a red build rather than a paragraph nobody can explain.

## Opaque record references, and why they are per comparison

Every fact in the grounded input, every table cell, every plan line and every
generated sentence cites a `ComparisonRecordRef` — `p1`, `o7`, `a23` — minted
for THIS comparison from the record's position, never from its id.

Two reasons, and only the first is obvious:

1. **A model package carries no ids.** `ComparisonRecordRef` has a `recordId`
   and a `canonicalPath`; the `ExplanationPackage` handed to a provider carries
   NEITHER, only the ref and a short label. A generated sentence cannot contain
   a canonical product id, a merchant id or a URL because the provider never saw
   one.
2. **An invented citation cannot accidentally resolve.** If refs were ids, a
   hallucinated plausible id would produce a citation that LOOKS valid and
   points at an unrelated record. A per-comparison handle has a domain of a few
   dozen values that exist only inside one response.

The index is idempotent on `(kind, recordId)` and emits in a sorted order, so
two runs over the same catalogue produce byte-identical reference tables.

## The four cell states, and the one most easily collapsed

`source_backed` · `inferred` · `conflicting` · `unknown` · `not_applicable`.

The pair that must not blend is the last two. Telling a shopper that a desk
chair's battery life is *unrecorded* invites them to go and look for it; "this
question does not apply here" is a different sentence, comes from a different
fact (the attribute's category scope), and must not be reachable from an absent
value.

`conflicting` is #94's SELECTION state surfacing rather than being flattened:
two sources disagreeing is not a fact Mercaria is willing to state, and the
shopper is shown both candidates instead of one chosen by a rule nobody wrote.

An INFERRED cell names its basis. Today the only inference performed is a unit
conversion, and that is stated rather than left as an empty extension point: an
inference kind nobody implements is a claim nobody can audit.

## A larger number is not always better, and `not_comparable` is the DEFAULT

Product-comparison rule 6 is not a caveat to handle — it is the normal case.
#94's registry records what an attribute MEANS and deliberately records nothing
about which direction a shopper prefers, because that is a property of the
CATEGORY: a lower weight is better for a laptop and worse for a dumbbell.

So a direction is DECLARED, per attribute key, in `policy.ts`'s
`COMPARISON_DIRECTION_RULES`, and only where it is genuinely
category-independent. Every entry carries the reason it is safe to declare
globally, and the `because` field is the review artefact rather than decoration:
an entry whose justification does not survive being written down does not belong
in the table.

Everything else compares fine and refuses to call either value better:

- A row with a declared direction that differs produces a **tradeoff** naming
  the better and worse subject.
- A row without one that differs produces a **difference** carrying both values
  and no better/worse claim.
- A RANGE is never a tradeoff. "6.1 to 6.7 in" is not one point on a scale, and
  picking an end or a midpoint to order by would be an inference the cell never
  declared.

The seam is named: a per-CATEGORY direction is a column on #94's
`attribute_definitions`, and whoever adds it replaces
`resolveComparisonDirection`'s body.

## Constraint outcomes: four lists, and the verdict is #94's

`buildConstraintColumn` partitions #94's outcomes into satisfied / failed /
unknown / not-applicable, and derives the fourth from the subject's category
scope.

**The reclassification never touches the verdict.** `verdict` is taken verbatim
from `ConstraintEvaluation.verdict`, which #94 derived under each constraint's
own named missing-data policy — so a hard requirement #94 turned into a failure
because the fact was missing STAYS a failure, whatever this domain thinks of the
category scope. Reclassifying it would be exactly the quiet downgrade of a hard
constraint acceptance 5 forbids, arriving through a display concern rather than
through the solver. Only an `unknown` outcome is ever moved.

## The explanation adapter: strict output, five checks, total refusal

A provider returns a STRUCTURED `ExplanationDraft`, never prose: a free-text
completion would have to be parsed before it could be checked, and every parse
is a place a citation goes missing.

`validation.ts` refuses five different ways for a summary to stop being one:

| Check | What it catches |
|---|---|
| Schema and size | A draft that cannot be checked at all |
| Citations resolve | A reference the package does not contain |
| Every factual sentence cites | A claim with nothing behind it |
| No new numbers | A computed difference, a converted currency, an averaged figure |
| Echoes and topics | A changed constraint result; affiliate economics, merchant plans or a payment rail |

**"Introduced a number" is decidable, not a judgement.** Every rendered value in
the package is collected into one flat set of numeric TOKENS by the same
extractor the validator uses, and the rule is membership. That is why
`render.ts` is the one place a value is rendered: a second spelling of one
amount is a false rejection, and a looser one is a false acceptance.

**Refusal is total.** A draft with one bad sentence is rejected WHOLE and the
templates render instead. Stripping the offending sentence would leave a
paragraph whose argument depends on a claim that is no longer there, and would
make the failure invisible — the rejections list is what an operator reads to
find out a provider is inventing figures.

`ExplanationProvenance` records the provider, its own prompt version, the schema
version and the comparison policy version. The prompt version is the PROVIDER's
to declare: a deployment variable holding one could only ever disagree with the
prompt actually sent, which is the `CROWDSOURCE_APP_ID` mistake.

## The basket problem, stated

Given lines `L`, each wanting a quantity of one product, and candidate offers
`C` each belonging to a merchant `m(c)`, choose one candidate per covered line
minimising

```
Σ_{l ∈ covered} price(c_l) · qty(l)  +  Σ_{m ∈ used} delivery(m, lines_m)
```

subject to `|used| ≤ maxMerchants`, the channel policy, the excluded merchants
and each line's own condition and merchant requirements.

This is **uncapacitated facility location with per-facility setup costs** —
NP-hard, and NOT solvable by picking each line's cheapest offer, because the
delivery term COUPLES the lines: three cheapest offers from three merchants can
cost more delivered than three slightly dearer ones from one. That coupling is
what a shopper feels at three checkouts, and it is the whole reason a solver
exists rather than a `Math.min`.

### Complexity boundaries, and what happens at each

The exact algorithm enumerates merchant SUBSETS: for a fixed set `S` the problem
decouples, so the optimum over all `S` is the global optimum. `O(2^M · L · C̄)`.

| Condition | Behaviour | Reported as |
|---|---|---|
| `M ≤ 14` | Exact enumeration | `proven_optimal` |
| `M > 14` | Deterministic greedy + bounded consolidation | `approximate` / `merchant_limit_reached` |
| Clock past 750 ms | Best plan found so far | `approximate` / `time_limit_reached` |
| A candidate cap was hit | Exact over a truncated set | `approximate` / `candidate_limit_reached` |

The last row is the one worth reading. An exact enumeration over a truncated
candidate set is an exact answer to the wrong question, and reporting it
`proven_optimal` would be the most misleading output this domain can produce —
so the cap is checked FIRST, independently of the search.

An approximate answer carries a `lowerBound`: the sum of each line's globally
cheapest known unit price times its quantity, which bounds the delivered total
too since deliveries are non-negative.

### Nothing depends on ingestion order

Subsets are enumerated over a SORTED merchant list; a line's best candidate is
chosen by a comparator whose last resort is #74's
`sha256(policyVersion + ':' + offerId)`; and two plans of equal objective value
are separated by their CONTENT digests. Every comparator chain is total, so
`Array.prototype.sort`'s stability can never leak the input order into the
answer (solver design rule 5). A property test shuffles the candidates and
asserts the plan digest is unchanged.

### Pruning that never removes a distinct option

Dominance is computed only inside one bucket:
`(merchant, condition group, channel, verified standing, whether delivery is known)`.
Across buckets nothing is pruned, ever — a refurbished unit from an official
store at twice the price of an unknown-condition marketplace listing is not
dominated by it.

Inside a bucket there are **four** axes — item price, delivery cost, the quoted
window, freshness — and each is gated in the same shape: `left` may not be
WORSE on it. Only then is "better on at least one" asked. The count is stated
because the gate that went missing is the one nobody notices: item price
appeared only in the better-on-one test, so a marginally cheaper DELIVERY bought
a dominance the offer had not earned, and X at 100.00 + 0.10 deleted Y at
50.00 + 0.11 before the solver ever ran. Every objective then read the survivor,
so the corruption was silent and total. `solver.test.ts` carries the pair that
varies price and delivery in opposite directions.

`dominates` checks the bucket ITSELF rather than trusting its caller, because it
is exported and the next caller is somebody who has not read `removeDominated`.
An unquoted delivery WINDOW is incomparable in both directions; an unknown
delivery COST is a different bucket. Every one of those decisions errs toward
keeping a candidate, which costs search time and cannot cost a shopper an
option.

### The merchant ceiling is SATISFIED, not merely reported

`maxMerchants` is a hard constraint the shopper set (solver requirement 10), and
both search paths honour it. The exact enumeration does so by construction —
only masks within the cap are explored. The greedy path, taken past
`MAX_SOLVER_MERCHANTS`, chooses its merchants up front with a deterministic
greedy SET COVER: repeatedly take the merchant covering the most lines nothing
chosen yet can serve, breaking ties on the cheaper total and then on the
merchant key.

That ordering matters — a merchant serving three lines is worth more than three
serving one each when only one may be kept — and it is why the choice is not
simply the first `cap` keys. Lines the surviving merchants cannot serve become
`unresolved` with `merchant_limit_would_be_exceeded`.

The alternative was to return a plan that exceeded the cap and label it
`approximate`, which reads as "could not prove optimal" when the truth is
"ignored your limit". Those are different sentences and only one of them is
honest.

### What a merchant charges for two items — the hardest decision here

#57 records delivery PER OFFER: a cost, and optionally the basket value above
which that merchant ships free. It does not record whether a merchant combines
two items into one parcel, and no feed Mercaria reads publishes it.

Three ways to answer, two of them wrong:

- **Sum the per-offer costs.** Overstates every merchant that combines shipping,
  which is most of them, and makes consolidating look worse than splitting.
- **Take the cheapest or the maximum.** Understates or overstates depending on
  the merchant, and either way invents a shipping policy Mercaria has not
  observed.
- **Answer UNKNOWN unless the observations agree.** Which is what `plan.ts`
  does.

So a merchant serving ONE line ships for what that offer quoted; a merchant
serving several ships for the quoted amount only when every one of those offers
quotes the SAME cost and the SAME threshold. Two disagreeing quotes from one
merchant means Mercaria has observed two shipping policies and does not know
which applies to a combined order.

The threshold is applied to that merchant's own ITEM SUBTOTAL and never to the
whole plan: a threshold met by adding another merchant's items is a discount
nobody offered.

### `cheapest_known_total` is the hardest result to earn, deliberately

Produced only when all three hold: every line covered, every merchant's delivery
known, and the plan's combined tax inclusion `inclusive`.

**The third is refused on every real basket today.** #74's
`resolveOfferTaxInclusion` is a named seam that always answers `unknown` —
`offers` has no tax column and no adapter publishes one, and guessing from the
market is how a 21% error enters a total. So in production this result is
refused with `tax_inclusion_unknown`, and `cheapest_known_item_prices` is what a
shopper gets, under a name that says exactly what it compared.

That is not a gap to work around. Acceptance 4 says an unknown cost must prevent
a "cheapest known total" claim, and a tax treatment nobody recorded is an
unknown cost. The seam closes when an offer-side tax column lands, and neither
the solver nor the totals nor `results.ts` changes when it does.

### The eight named results

| Kind | Produced when | Refused with |
|---|---|---|
| `cheapest_known_item_prices` | Anything at all was covered | `no_eligible_offer` |
| `cheapest_known_total` | Complete coverage, known delivery, inclusive tax | `delivery_cost_unknown`, `tax_inclusion_unknown`, `objective_requires_complete_costs` |
| `fewest_merchants` | Anything at all was covered | `no_eligible_offer` |
| `best_native_plan` | Every covered line is native | `objective_requires_native_offer` |
| `official_channel_plan` | Every covered line carries a VERIFIED official standing | `objective_requires_official_channel` |
| `best_nearby_pickup` | Never | `pickup_data_unavailable` |
| `used_or_refurbished_value` | Every covered line is used or refurbished | `objective_requires_used_offer` |
| `partial_coverage` | The best plan leaves something out | — |

An `authorized_reseller` is deliberately not enough for the official plan: #55
keeps the two kinds, badges and lists apart, and folding them here would publish
a distinction the relationship layer refuses to make.

`best_native_plan` covering SOME lines is produced with the shortfall in
`unresolved` and in its reason codes rather than refused — "you can buy one of
these two here" is useful, and hiding it would be worse than saying it. It is
refused only when nothing at all is natively buyable.

`partial_coverage` carries the SAME plan the cheapest result carries. The
difference is the NAME, which is the point: those are the same rows read two
ways, and a shopper needs the second reading before acting on the first.

## Mixed plans are two transactions, structurally

`BasketPlanActions` has ONE optional native cart action and a LIST of external
merchant actions, and no member that could mean "check this whole thing out". A
mixed plan therefore cannot be rendered as one transaction, because there is no
field a client could read to do it.

That absence answers two requirements at once: solver design rule 8 (separate
actions rather than one false checkout) and UX rule 7 (Mercaria must not imply
it guarantees an external merchant's final total).

The external side hands over a HOST and never a URL — #71's decision, for its
reason: a raw link asserts at RENDER time what only a click can establish, and
composing a tracked destination is #37's and is not built.

## Revalidation, and why a price that went DOWN also blocks

`revalidateBasketPlan` re-reads through #74 and diffs against the SNAPSHOT —
never against the plan, which is a projection, and re-deriving eligibility from
it would mean this domain deciding what "still eligible" means.

**It compares a TERMS fingerprint, not a price.** `renderCandidateTerms` joins
the item price, the delivery cost and the free-shipping threshold, and the
snapshot stores it per offer. All three move a plan's numbers: the figure a
shopper is shown for an incomplete plan is "at least X, plus delivery from N
merchants", so a merchant raising its delivery fee moves exactly the part they
read, and lifting a free-over above the basket flips delivery from zero to
charged with neither published amount changing. A check watching only the item
price answered `unchanged` and `mayProceed: true` for both.

The fingerprint is computed by ONE function from a candidate built by ONE
`toCandidate`, in `basket/candidate-source.ts` — the same construction the solve
used, and the only module in the domain that resolves FX rates. A second
reading of an offer's terms would answer about a slightly different offer every
time the two spellings drifted.

`mayProceed` is derived and refuses on ANY movement. A cheaper basket is still a
different basket: the shopper is about to act on a plan whose totals no longer
describe what they would pay. The remedy is one button — recalculate — which is
UX rule 9 arriving as behaviour rather than as copy.

## Why this domain owns no table

`BasketInputSnapshot` is RETURNED, never stored. UX rule 9 forbids presenting a
stale plan as current, and a stored plan served later is precisely that. The
client hands the snapshot back to revalidate; saving a result for later is #81's
watchlist, where a saved thing is explicitly a saved thing.

The digest is a sha-256 over a canonically ordered serialization of the request,
the four policy versions, the candidate set with its prices and the rates.
`evaluatedAt` is deliberately NOT in it: a snapshot taken a second later over an
unchanged catalogue is the same input, and folding the clock in would make every
digest unique and the whole mechanism decorative.

Everything else this domain answers is derived at request time from tables #56,
#57, #74, #78, #90 and #94 already own — which is also #70's and #71's finding
at the same scale, and #61's measurement is what makes it affordable.

## The walls

`comparison-isolation.test.ts`, each with a vacuity floor and a mutation
self-test:

1. **No module reaches commercial standing** — fees, referrals, retail pricing,
   the ledger, a plan, a commission.
2. **No module names a currency.** The one exemption is
   `explanation/validation.ts`'s `FORBIDDEN_TOPIC`, which must contain the
   spellings in order to refuse them — and the carve-out is narrowed to that
   declaration plus its docblock, so a second mention anywhere else in the file
   still fails.
3. **No module reaches the REVIEW domain.** A star rating is a legitimate
   ranking signal one domain over; what it may never become is a row in a
   specification table (product-comparison rule 7).
4. **The allowed and forbidden recommendation-input vocabularies are DISJOINT.**
5. **A real emitted `ExplanationPackage` carries no id, path, host or forbidden
   key** — a runtime walk, not only a declaration check.
6. **Money is rendered and re-quoted in ONE place.** No `Intl.NumberFormat`, no
   second conversion; `basket.service.ts` is the single named exception, for the
   one rate map a solve needs.

## Environment

**None.** This domain adds no variable, and that is deliberate: it owns no
table, writes no row and runs no loop, so a lever could only gate a read two
existing levers already gate.

- `CANONICAL_PUBLIC_ROUTES_ENABLED` gates the MOUNT, with the other canonical
  surfaces.
- `CANONICAL_OFFER_COMPARISON` gates the offers HALF, inside the handler. With
  it off a comparison still answers — every subject reports
  `offer_comparison_withheld` rather than rendering as a product nobody sells,
  and every commerce cell is `unknown` rather than zero.
- `PRICE_HISTORY_PUBLIC_READS_ENABLED` (#78's own) decides whether price signals
  enter the grounded input at all.

Both are resolved in the controller and passed IN as booleans, so a service
reading `config` is never a second place a rollout is decided.

## The benchmark

`services/comparison/__tests__/benchmark.test.ts` covers all twelve scenarios
the issue names, by number, and measures what its Evaluation section asks for:
constraint accuracy (1, 2), arithmetic accuracy (4, 5, 6), grounding and
citation validity (12), solver objective and completeness (6, 7, 8, 10),
approximation status and latency (11), and fallback behaviour (12).

Scenarios 3 and 9 are the two whose honest answer is a REFUSAL, and both are
asserted as refusals with their reason codes rather than skipped. Scenario 5 is
the arithmetic one worth reading: crossing a merchant's free-shipping threshold
makes the plan with the DEARER items the cheapest delivered, and the two results
are named separately so neither claim is the other's.

## #95's intent is CONSUMED through #94's language, with no adapter

There is no search-intent port, no registry and no translation layer, and that
is not an omission: #95's `ShoppingInterpretation.constraints` is a #94
`ConstraintSet`, and `POST /comparison` accepts exactly that language and
validates it through #94's OWN `validateConstraintSet`. The two meet in
`constraint.ts`, on `main`, which is why neither domain imports the other. A
client wires `/search-intent` → `/comparison` by passing
`interpretation.constraints.constraints` and the `categoryId` beside it.

`ValidatedConstraintSet`'s brand is unexported and unforgeable, so a client
cannot send a pre-validated set and this surface cannot skip the validator.
That is deliberate: an HTTP caller able to assert "already validated" would be
the one path by which an unchecked constraint reaches an evaluation.

**The basket takes its condition filter ONCE, at the request.**
`IntentCommercePreferences.conditionGroups` is one value for a whole query, and
a contract that only accepted it per line would make every caller fan it across
forty lines — differently each time. A line that names its own segments keeps
them exactly: this is a DEFAULT, never an intersection, because narrowing a
line's stated filter further would be a second filter the shopper cannot see.

`pruneBasketCandidates` resolves it, and it is the ONE authority — the only
thing in the domain that applies a condition filter at all. `gatherCandidates`
also narrows the #74 read by a line's own segments, and that is an OPTIMISATION
which may only ever be WIDER: a wider read returns candidates the pruner then
refuses with a reason code, while a narrower one would be a second filter with
none. The benchmark caught this the first time the resolution lived one layer
up, where a pure composition silently ignored it.

## #81's watchlist is CONSUMED, not ported around

`POST /comparison/basket` takes `lines` or a `watchlistId`, exactly one, and the
watchlist branch calls #81's own `readWatchlist` directly. There is deliberately
no port and no registry: #81 is on `main`, and a fail-closed seam for a
dependency that exists is a stub that lies.

`readWatchlist` answers ONE indistinguishable 404 for "no such list" and "not
yours", which is #81's privacy rule honoured by calling it rather than by
re-deriving ownership here. A guest gets a 400 and no branch: a watchlist is
private to an Oxy account.

**An `ambiguous_after_split` item becomes a line that cannot be planned, never a
dropped one.** A catalogue split can leave an item pointing at two products, and
#81 records that rather than guessing. Planning it would put the wrong product
in a basket; dropping it would make a basket of four items silently plan three
and report success. So it stays a LINE, counts toward coverage, contributes no
candidates — asking #74 about a product the shopper may not have meant is how
the wrong one ends up in a plan — and carries `watchlist_item_unresolved`, which
is the only answer they can act on.

`SolveBasketRequest.callerRefusals` is the general shape of that: reasons a
CALLER already knows, merged after the pruner's own so they survive the offers
lever being off.

## Seams left to their owners

Each is a named contract that fails closed, not a stub that lies:

- **#93 (pickup and distance)** — `BasketPickupPreference` is `{ requested:
  true }` and carries no coordinates and no radius. Not because #93 publishes
  none — it has shipped — but because a basket has no ORIGIN to measure from: a
  plan is composed from a saved list, not from where the shopper is standing.
  `best_nearby_pickup` is refused whether or not the shopper asked, so "we
  cannot do this" stays distinguishable from "you did not ask".
- **An offer-side TAX-INCLUSION column** — #74's `resolveOfferTaxInclusion` is
  one function body, and `cheapest_known_total` becomes reachable the day it is
  replaced.
- **#37/#67 (the outbound redirect)** — a plan discloses a destination HOST and
  composes no tracked URL. Until the redirect exists, opening an external
  merchant reaches their own host and nothing Mercaria assembled.
- **An explanation PROVIDER** — nothing is registered, so every deployment
  renders the deterministic templates. Closing it is one module implementing
  `ExplanationProvider` plus one `registerExplanationProvider` call; the
  validator is what makes doing so safe.
- **#77 (analytics)** — no event is emitted. A comparison view and a plan
  selection are facts a browser knows, the storefront still has no analytics
  client (#71's finding), and deriving them server-side would be fabrication.

## Known omissions

Stated rather than left to be discovered:

- **The compare screen has no entry point wired into search or a product page.**
  A comparison needs two or more products, so the natural entries are a
  multi-select in #70's search results and #81's watchlist — both of which are
  those surfaces' own screens. `/compare?p=a&p=b` and `/compare?watchlist=…` are
  the contract they will use, and the screen works today from either.
- **No operator surface.** Every read here is public and derived, there is no
  row to trace and no idempotent path to drive, so a seventh allow-list would
  gate nothing. A trace of why one comparison came out as it did is the
  response itself: it carries the policy versions, the record table, every
  rejection and every reason code.
