# Isolation gates: populations, floors, and censusing them

An isolation gate asserts that some domain **cannot reach** something — a
ranking surface, a payment rail, a contact value. Every one of them is a scan
over a POPULATION of files, and the population is where they go wrong.

This doc is about that half. The org-wide manual for writing a check that can
actually fail is `~/Oxy/docs/gate-writing.md`; the rules that generalise beyond
this repo are in `~/Oxy/AGENTS.md` §Gates. What is here is what was MEASURED in
this repository during #460, including an instrument that failed and why.

## The defect #460 was about

A gate's population was a hand-written array. Two failure shapes, and only one
of them is visible:

- a list asserting a string is **absent** goes **silently green** forever once
  the content moves out of the files it names;
- a list asserting a string is **present** goes **red**, and its loudness makes
  deleting the line the cheapest green.

Measured conversions, all of which WIDENED the population:

| gate | hand list | walked |
|---|---|---|
| `referral-attribution` | 13 | 94 |
| `referral-enrollment` | 15 | 94 |
| `merchant-plan` (a ranking copy) | 19 | 42 |
| `offers` (cart/checkout half) | 7 | 15 |
| `matching` | 22 | 26 |
| `curation` (ranking half) | 14 | 42 |
| `condition` (ranking half) | 4 | 42 |
| `curation` (domain half) | 17 | **17** |

## `expect(scanned).toBe(LIST.length)` cannot fail

It appeared at the end of nearly every scan loop, seven times in one file. It
compares the loop's own counter to the list the loop just iterated, so it holds
for **any** list including an empty one. It catches a broken loop and never a
wrong population.

Replace it with floors **per SHAPE** — never one total, because the sources
break independently and one number lets a walk collapse to zero while the others
carry it — each set to today's count, plus a `statSync` on every path so a
`readdirSync` returning a cached or empty result goes red.

## An assertion loop over an INLINE list is that list's only reader

Everything above is about a list a scan runs OVER. This is the smaller sibling,
with nothing to walk (#706):

```ts
for (const foreign of ['services/supplier-orders/submission.service.ts']) {
  expect(population, `${foreign} belongs to another domain`).not.toContain(foreign);
}
```

Replace the array with `[]` and the body never runs, so the clause asserts
nothing and nothing goes red — the array is the thing being defended and the loop
is its only reader, so **both shrink together**. It is
`expect(scanned).toBe(LIST.length)` in a different costume, and **#691 shipped
one**: emptying its array left all 26 tests in that file green.

**An inline array literal cannot be floored where it is written**, because it has
no identifier to assert a `.length` on. That is why the remedy is a helper rather
than a convention — `assertEachOf(list, floor, fn)` in
`src/__tests__/assert-each-of.ts`, the generic form of what #697 did for
`assertDirectoriesAreFlat` — and why the floor is a required POSITIONAL argument
sitting immediately after the entries it counts.

Two properties do the work, and each closes a way the fix could be neutered:

- **The floor is MANDATORY.** An optional one reproduces the defect one layer up,
  because a caller who omitted it looks identical to one that had nothing to
  floor.
- **The floor may not be ZERO.** `[].length >= 0` holds, so a zero floor admits
  precisely the empty array this exists to refuse — the original defect two
  tokens from the fix's own spelling.

Set it to today's COUNT. Unlike `OutsidePopulationOptions.sweepFloor` this is not
a pin wearing a floor's name: that warning is about a DERIVED sweep, whose count
grows on its own. Nothing grows a hand list except a person editing those very
lines, and an addition passes a `>=` floor freely. What the number buys is that
REMOVING a member now moves it in the same diff, so a narrowing that was
invisible becomes one somebody has to justify.

A too-LOW floor is the one thing the suite cannot see — the helper refuses a
floor ABOVE the length and a floor below it passes silently — so a conversion
needs a SECOND instrument that re-parses each call site and compares the literal
to the entry count.

### A floor is owed where the list is the SOLE defence

Ask what else fails when the list is emptied. Nothing ⇒ it is a population
wearing an assertion's clothes. Something independent still fires ⇒ its value is
in NAMING the module rather than in catching the regression, and a floor buys
little.

Measured on `supplier-preflight-isolation.test.ts`, which holds one of each — so
**bucket per LOOP, never per file**. Both rows reproduced on `4bff6ef3`:

| the list asserts | emptied alone | emptied AND the regression introduced |
|---|---|---|
| modules IN the population (`widening`) | 17/17 green | **RED** — the per-shape sweep floor, and the whole-tree assertion names the module |
| SIBLING-DOMAIN modules OUT (`foreign`) | 17/17 green | **nothing fires** |

Both empty silently, so that is not the discriminator. The discriminator is
whether the REGRESSION the list exists to catch is caught elsewhere, and the
reason the second one is not is worth stating on its own:

> `assertNothingOutsideDomainPopulation`'s `FOREIGN_CONTROL_MODULES` is the
> commerce core, foreign to EVERY domain. That is what makes it shareable, and it
> is also its limit: **the shared control catches a population that swallowed the
> TREE and cannot catch one that swallowed a NEIGHBOUR.**

### The shortlist instrument is blind to the NAMED spelling

`for (const x of [` anchors on the inline form. A list declared a few lines up as
`const NAMED = [ … ]` and iterated by name is the SAME defect — the loop is still
its only reader — and that pattern cannot see it.

**The certain part needs no number: `widening` above is in the blind set.** The
very list this section's triage table is measured on is one the shortlist could
not report, so #706 reasoned about a site its own instrument could not see.

**The count is a shortlist and two spellings of its floor detector disagree by
15.** Over the named lists (derived spreads excluded, on `b3d860c7`), asking
"does this list have a length assertion anywhere in the file" gives **52** when
the detector requires `NAME.length` to be followed immediately by `)`, and **37**
when it allows the message argument the real spelling carries:

```ts
expect(PURE_MODULES.length, 'the pure-module set changed size').toBe(9);
```

The first misses that as a floor and over-reports; the second, anchored on
`expect(`, stops matching a bare `NAME.length)` elsewhere in the file and finds
**two sites the first had wrongly excused**. Wrong in OPPOSITE directions, with
no syntactic rule between them — §"When a census cannot be made correct by a
better pattern" reproduced, and the free assertion there (*a fix that repairs a
truncation can only ADD; if the count also drops, there is a second bug*) is what
surfaced it. Reading the 37 then finds more still defended: one by a `toEqual`
against a derivation rather than by any length assertion, one declared `= []` on
purpose. **So neither number is a defect count.**

`assertEachOf` takes a named list unchanged, but a named list can also be floored
where it is declared, and which of the two reads better is a judgement per site
rather than a mechanical pass.

## A complete population is not a defended one

`curation`'s domain list was 17 and the walk found the same 17. Every probe that
would normally justify a conversion reported nothing: deleting a listed module
makes `readFileSync` throw, so even the hand list went red; the byte floor was
met; the counter agreed.

**The direction a hand list is blind to is an ADDED module**, and it is invisible
to every number the gate asserts. So prove a conversion with a file that does not
exist yet:

1. confirm the seed qualifies under the gate's **own detector** first — a
   mutation whose input the wall does not classify produces no finding, which is
   indistinguishable from a fix that works;
2. place a plausible new module in the shared flat directory with a real
   violation in it;
3. run **both** gate versions against the same tree.

Measured: `facets` and `merchant-demand` (both "already complete") passed
**2 files / 30 tests green** with two new violating modules on disk.

## Exemptions

An exemption is only safe while it is still TRUE, so each carries a probe that
it still fires — and the probe must be checked in both directions:

- **does it still fire?** neutering one `services/referrals/earnings/` ledger
  import turns the gate red as *"a module that stopped posting is still being
  excused"*;
- **could it EVER fire?** pointing an exemption at a path the walk does not
  produce must fail. Measured elsewhere in this repo: three of six exemptions in
  another guard were **structurally unmatchable** — a camelCase segment against
  a lowercase-only pattern — and a reconciliation reports zero for those exactly
  as it does for a legitimately removed subject.

Prefer **excusing a named module with a probe** over **narrowing a detector**.
Narrowing is the permissive direction: a detector loosened for one legitimate
reader admits the violation somebody adds beside it. The one time narrowing was
right, the detector was plainly wrong — `OUTBOUND_FETCH` matched `axios`,
`undici` and `node-fetch` as bare words, so `traffic.ts`'s **bot user-agent
list** made the module whose job is to *detect* crawlers read as one.

Beware the probe that reds for the wrong reason. Removing
`services/curation/impact.ts` to test its exemption fails the run at **import**
(the gate imports `split.service.js`, which imports it), so the red is a module
resolution error and proves nothing. Drive the real stale state instead — point
the exemption at a renamed path.

## Censusing gates: what works and what does not

### Ranking populations: content-keyed, and it works

There is ONE shared derivation (`src/__tests__/ranking-surface.ts`), so a copy
can be found by CONTENT: score every path array in every gate by how many
entries land inside the derived surface. This found the **twelfth** copy
(spelled `RANKING_SURFACE_PATHS`) and the **fourteenth** (spelled
`DISCOVERY_PATHS`) after a name-keyed sweep for `RANKING_PATHS` had ended eleven
and missed both.

**A name-keyed search cannot find a copy that does not carry the name.**

### A barrel is where a census goes blind, in both directions

**The file that names nothing is the file everything resolves through**, so it is
simultaneously invisible to a name-based census and useless to a symbol-based one.
Two instances, both measured:

**A directory-keyed import detector cannot see a barrel re-export.** The house
shape is `from\s+['"](?:[^'"]*\/)?(?:<domain>)\/[^'"]*['"]` — it requires a
directory SEGMENT before the module. A barrel writes `export * from './compatibility'`:
relative, extensionless, no directory segment, so the pattern that correctly
matches `'../compatibility/claim.service.js'` and
`'../../services/payments/redact.js'` matches neither `'./compatibility'` nor
`'./payments'` nor `'./compatibility.js'`. `db/schema/index.ts` alone holds 79
lines of exactly that shape. So a reachability gate can be green while the domain
it forbids is re-exported through a barrel the population includes.

**And a symbol-keyed search cannot see THROUGH one.** Grepping
`shared-types/dist/index.d.ts` for a symbol returns 0 whether the build is stale
or perfectly fresh, because `index.d.ts` holds only the `export *` line — the
symbol lives in `dist/compatibility.d.ts`. That zero was read as proof of a stale
`dist` and happened to be right for an unrelated reason (the mtime comparison was
the real evidence). **A probe aimed at a barrel answers 0 for two causes at once**,
and one of them is "everything is fine".

The pair is the general form of the ranking finding above. A name-keyed search
cannot find a copy that does not carry the name; a barrel is the case where
NOTHING carries the name and every consumer still gets the thing. Aim a census at
the modules, never at the barrel — and when a probe over a barrel returns zero,
that is not a measurement yet.

#### How it was closed (#556), and why not by widening the detectors

Measured: **fourteen** gates are fooled by `db/schema/index.ts`, and ten modules
already imported it — so the bypass was wired open around every wall that names a
schema module. Demonstrated rather than argued: planting
`import { referralAttributions } from '../schema/referrals.js'` in
`db/retailReconciliation/adjustmentRepository.ts` turns
`retail-reconciliation-isolation.test.ts` red on its referral wall, and the SAME
symbol in the SAME file spelled `'../schema/index.js'` passes **30/30 green**.

It was a hole and not a live violation: every symbol those ten modules pulled
resolves to an owning module no wall forbids.

**Widening the detectors is wrong, and so is the obvious two-hop version.**
Teaching a detector to match `schema/index.js` fires on all ten legitimate
importers. So does "a guarded module imports a barrel that re-exports a forbidden
module" — `export *` re-exports everything, so importing the barrel always
"reaches" everything, and no path-level predicate can separate a legitimate
importer from a violating one. The only false-positive-free predicate is
**symbol-level** (resolve each named import through the barrel to its owner), and
it has to be adopted by each of the fourteen gates separately.

So the bypass was removed instead, at the chokepoint:
`src/__tests__/barrel-import-chokepoint.test.ts`. Every path-based wall becomes
barrel-proof by construction — including walls in gates nobody has written yet —
and no detector is widened, so no gate acquires an allow-list.

Nothing in it is a hand list. Barrels are derived by walking for re-export
density, and one is GUARDED only if it actually defeats a detector belonging to a
real gate — which is why `lib/errors/index.ts` and
`services/feed-import/parse/index.ts` (measured: they defeat nothing) stay
unguarded, leaving `parse/index.ts`'s documented reuse by #66's Awin adapter
alone. A barrel added tomorrow, or a detector added tomorrow that an existing
barrel defeats, brings itself under the gate with no edit.

**And the instrument failed twice on the way, both times in the quiet
direction.** A `grep -viE "schema|contracts"` written to cut noise removed
`db/schema/index.ts` — the only barrel in the tree — and the search then reported
its own emptiness as a clean result. Then a specifier regex spelled `[^;\n]*?`
could not cross a newline, so every multi-line `import {\n  a,\n  b,\n} from …`
was invisible and it counted four barrel importers where there were seven. **A
smaller number is indistinguishable from a cleaner tree**, so the gate carries a
positive control on that exact multi-line shape.

#### A PACKAGE barrel gets no chokepoint, so it gets the resolver (#582)

`@mercaria/shared-types` (114 re-exports, 1,464 non-test importers) and
`@mercaria/ui` (95, 166) dwarf the schema barrel, and **#581's chokepoint can
never cover them.** It works for `db/schema/index.ts` because that barrel is
reached by a RELATIVE path and has two legitimate consumers. A package entry
point is imported BY NAME, and importing it is how a package is consumed — there
is no allow-list, no conversion, and no "import from the owner" alternative that
is not a deep import into another package's internals.

So these two get the predicate #556 identified and set aside: **symbol-level**.
`src/__tests__/package-barrel-symbols.ts` resolves each named import through the
barrel to its owning module, and a wall then applies to that owner.

    import { ReferralProgramStatus } from '@mercaria/shared-types';
      -> packages/shared-types/src/referral.ts   -> a referral wall refuses
    import { CURRENCY_PRECISION }    from '@mercaria/shared-types';
      -> packages/shared-types/src/money.ts      -> that same wall allows

Nothing in it is a hand list either: packages are derived by walking `packages/*`
for a `src/index.ts` with re-export density, so `packages/backend/src/index.ts`
drops out on its shape, and the symbol map is a scan of what each re-exported
module declares. Measured: **3,752 shared-types symbols over 114 owner modules,
329 ui symbols over 95, and zero unresolved re-exports.**

**Twelve gates carry a detector this defeats today** — the issue as filed
expected none, because it looked for a wall naming a path INSIDE those packages
and there is still no such wall. The live form is the reverse and commoner: a
detector like `/from\s+['"][^'"]*(referral|affiliate)[^'"]*['"]/` matches the
SPECIFIER, and the specifier of a package import is `@mercaria/shared-types`,
which contains neither word. **Demonstrated, not argued** — planted in
`services/retail-reconciliation/adjustment.service.ts` against
`retail-reconciliation-isolation.test.ts`:

| planted line | wall |
|---|---|
| `import { ReferralProgramStatus } from '@mercaria/shared-types';`, resolver ON | **RED**, names the file |
| the same line, resolver OFF | **30/30 GREEN** |
| `… from '../../../../shared-types/src/referral.js';`, resolver OFF | **RED**, names the file |

The third row is what makes the second one blindness rather than a
non-violation: the planted symbol genuinely qualifies as what the wall detects.

**A wall is widened to a package module only where reaching that module IS the
thing forbidden**, which is why exactly one wall was converted rather than all
twelve gates' worth. Classified by measurement — does the walled domain ALREADY
import the module the widening would forbid:

| | gates |
|---|---|
| widening would **break** the domain | **5** — `navigation` (already imports `offer-ranking.ts`), `pickup` (`analytics.ts`), `compatibility`, `awin` and `feed-import` (their own contract modules) |
| a tightening is genuinely available | **7** — `product-save`, `referral-pilot`, `referral-earnings`, `reward-funding`, `retail-pilot`, `retail-reconciliation`, `watchlist` |

So a script that widened every fooled detector would turn five domains red on
their own legitimate contracts. **Widening a deliberately narrow wall is the
census that pushes you toward the hazard**, and "the detector's substring
happens to match a module name" is not evidence that reaching that module is
what the wall forbids. Note the second row is an OPPORTUNITY and not a defect
list: none of those seven is violated today.

The trap in classifying them is that a plausible reason is not a measurement.
The first draft of this section justified leaving the FX wall alone by saying
the domain legitimately reads `FxRateSnapshot` from `shared-types/src/fx.ts`.
It does read `FxRateSnapshot` — from `money.ts`. `shared-types/src/fx.ts`
exports exactly one type, and widening that wall would have broken nothing. **A
guess with a rationale attached, sitting beside measured facts, is the shape an
error takes here.**

**Validate the resolver against every symbol the workspace actually imports.**
It is free, exactly on-distribution, and it found a real defect on the first run:
`import { A as B }` requests `A` while `export { A as B }` publishes `B`, and
taking the local alias left 22 symbols (`Listing as ListingDTO`,
`ORDER_SELLER_TYPES as SHARED_ORDER_SELLER_TYPES`, …) resolving to nothing. **An
unresolved symbol is one a wall reads as reaching nothing**, so `null` is
reported as UNKNOWN and asserted at zero rather than passed over. The #556
newline trap recurs here at ten times the scale — **1,051 files in this workspace
carry a multi-line barrel import**, and a `[^;\n]*?` specifier regex drops the
importer count from 1,809 to 934 while every wall stays green.

**An edge the resolver cannot read must FAIL, never be skipped.** This is the
part that decides whether a symbol resolver is worth anything: it will meet
syntax it cannot follow, and **if an unreadable edge is skipped, the barrel
problem has been rebuilt one level up** — the gate reports clean because it could
not see, which is indistinguishable from clean because there is nothing there.

So coverage is MEASURED rather than assumed. `unfollowedPackageReferences`
counts every occurrence of a guarded package specifier, subtracts everything a
followed clause consumed, and what remains is an edge the resolver cannot read.
The gate asserts that set is **empty across all 2,224 non-test modules**, so a
new syntax that defeats the resolver goes red naming the file instead of quietly
widening the hole. The four edges worth naming, and what each does here:

| edge | treatment |
|---|---|
| `import { a as b }` | resolved — `import` requests `a`, `export` publishes `b`, opposite directions |
| `import * as X` / bare `await import(pkg)` | reaches **every** module of that barrel; reporting "nothing" would be a one-line way around every wall |
| a deeper re-export chain | followed, with a `seen` set, because a barrel is exactly where a cycle is plausible |
| `import(pkg).Symbol` (inline import type) | resolved to that symbol |

The test-file exclusion is DERIVED (every gate here walks a `.ts` filter that
structurally omits `__tests__`) and **counted, not dropped** — the 21 unreadable
occurrences inside test files are gate probe STRINGS, and that number being
non-zero is the detector's own positive control.

Mutation-tested: removing dynamic-import handling turns the coverage assertion
red naming `services/payments/payment.service.ts` and
`packages/frontend/lib/hooks/use-watchlists.ts` — **two production modules** that
write `import('@mercaria/shared-types').FxRateSnapshot`. And one trap inside the
fix: `import(pkg).then(…)` is the runtime form with a Promise method attached,
not a property access, so reading `then` as a symbol makes it an unresolved name
and the file an unreadable edge. A following `(` is what tells them apart.

### Seed a mutation victim per SCANNED DIRECTORY, not one per gate

One synthetic probe proves the DETECTOR matches. It proves nothing about the
POPULATION. Measured elsewhere in this repo: a narrowing mutation turned exactly
**one** test red because the single seeded victim sat in the surviving half — so
the gate detected the bug it was written for in one direction and reported a
**pass** in the other, and one-red reads as complete. With victims derived per
scanned directory the same mutation turned **seventeen** red.

`retail-reconciliation-isolation.test.ts` now derives its victims from
`SCANNED_DIRS`, the same list `DOMAIN_FILES` is built from, plants the violation
into each victim's REAL source, and asserts the victim is clean beforehand so the
assertion measures the plant. Two clauses make it bite, both verified by
mutation:

- narrowing `SCANNED_DIRS` to one directory fails on the length floor
  (`expected 1 to be greater than or equal to 2`) — a floor derived from the list
  it defends could not catch this, so it is absolute;
- **a directory holding no `.ts` file fails loudly** rather than being
  self-tested by nothing (`../../db/migrations holds no .ts file to seed a victim
  in`).

**And a clause matcher must read `export … from` as well as `import`.** A
RE-EXPORT reaches the module exactly as an import does, and one exists:
`packages/ui/src/lib/format.ts` writes
`export type { ProductSummary } from '@mercaria/shared-types'`. Matching only
`import` reported that file as reaching nothing — this section's own failure one
level down, in the quiet direction, and found by grepping for the shape rather
than by any test. Note the `as` direction flips back on that side: a re-export's
REQUEST is still the name to the left of `as`, while its PUBLICATION is the name
to the right.

### Domain populations: no instrument decides this

There is no shared derivation to score against, and the difference between *the
domain population* and *a deliberately narrow subset* (`PURE_PATHS`,
`CROSSING_PATHS`, an exemption set) is **a claim in the docblock, not a shape in
the code**. An instrument can produce a SHORTLIST; only reading assigns the
bucket.

`scripts/isolation-gate-census.ts` is that shortlist generator. **Its failure
history is the reason it is documented rather than trusted:**

- the first draft reported `PURE_PATHS`, `CROSSING_PATHS` and an exemption list
  as *drifted populations needing a domain walk*. Acting on it would have
  **widened walls that are deliberately narrow** — a census that pushes you
  toward the hazard;
- the second, run against six populations whose answer was already known,
  classified **five of six wrong**, dumping three real drifts (22→26, 13→94,
  15→94) into the "legitimate hand list" bucket. Cause: the subset heuristic
  keyed partly on the spread operator, the commonest shape in this tree.

**Measured recall after fixing**, against six populations whose answer was
already known — run `bun packages/backend/scripts/isolation-gate-census.ts <path-to-an-older-src>`
to reproduce:

| control | truth | bucket |
|---|---|---|
| `matching` `MATCHING_DOMAIN_PATHS` | drifted 22→26 | A |
| `referral-attribution` `EDGE_PATHS` | drifted 13→94 | A |
| `referral-enrollment` `ENROLLMENT_PATHS` | drifted 15→94 | A |
| `offers` `CART_AND_CHECKOUT_PATHS` | drifted 7→15 | **C — missed** |
| `curation` `CURATION_DOMAIN_PATHS` | complete 17→17 | B |
| `facets` `BACKEND_FILES` | complete 3→3 | **C — missed** |

**Three of four known drifts surfaced; one escaped. One of two known complete
populations classified; one escaped.** The two escapes are shapes, not
accidents:

- a list **pushed into a collection** and read later, so it is never
  syntactically iterated (`BACKEND_FILES`);
- a list whose entries **all sit in flat directories**, so there is no owned
  directory to walk (`CART_AND_CHECKOUT_PATHS`).

So the third bucket is **"not classified"**, never "nothing to do". A
three-bucket table whose last bucket silently means *the heuristic gave up* is
read as coverage.

**Validate any new census against cases whose answer you already know, before
reporting a single row.** If you have just fixed N instances, those N are the
control set — free, and exactly on-distribution.

## When a census cannot be made correct by a better pattern

`scripts/isolation-gate-census.ts` above is a shortlist generator because the
bucket is a judgement. This section is the measured evidence for *why*, and it
cost six iterations to obtain.

Classifying the same **78** gate files by "does its scan population include a
hand-maintained file list", one definition, six instruments:

| # | instrument | count | what was wrong |
|---|---|---|---|
| 1 | regex `\[([^\]]*)\]` | 17 | terminates at a `]` **inside a string literal** — and every Expo dynamic route has one (`'frontend/app/(app)/merchants/[idOrSlug].tsx'`), so the array fell under a `>= 2` threshold and a whole gate vanished |
| 2 | regex `\[([\s\S]*?)\]\s*;` | 19 | an array not ending in `];` makes the non-greedy match **swallow the arrays that follow** |
| 3 | AST, `isArrayLiteralExpression` | 13 | `const X = [...] as const` is an **AsExpression**; testing only for a bare array literal drops every such list |
| 4 | AST + unwrap `as const`/`satisfies`/parens | 21 | required a `/` in an entry, dropping a repo-root `app.ts` |
| 5 | same, `/` no longer required | 24 | began counting `{file, field, why}` exemption pairs and a local `const controls = [{name, module}]` test FIXTURE as populations |
| 6 | — | — | stopped |

**Iterations 4 and 5 are wrong in OPPOSITE directions with no syntactic rule
between them, and that is the proof rather than a suggestion.**
`AGGREGATE_EXCLUSIONS` (an exclusion attached to a walked population) and
`LEGACY_BARE_IDENTITY_FIELDS` (an exemption of field-in-file pairs, not a
population at all) are **the same shape** — a readonly array of objects carrying
a file string and a reason. Nothing in the syntax separates them; only what the
docblock CLAIMS does. So a seventh pattern is not the remedy, and **re-running a
suspect census with a better regex is not the remedy either** — checking against
known answers obtained another way is.

**The free assertion available on every repair:**

> **A fix that repairs a TRUNCATION can only ADD. If the count also DROPS, there
> is a second bug.**

17 → 19 gained two and **lost one**, and that single dropped entry was the whole
evidence that the second regex had its own fault. Nothing else in the output said
so. It costs one comparison.

**And grep for the raw construct as an upper bound before quoting any census.**
A sibling instrument matched only a LITERAL argument (`walk\('[^']+'`) and
reported 27 where `grep -c 'walk('` gives **41** — fourteen gates hold the
directory list in a CONSTANT (`DIRS.flatMap(walk)`) and it saw none of them. The
missed form was the *more* hand-written one. The gap between "sites of the
construct" and "sites my pattern parsed" is the measurement.

**What all six share:** a pattern that matches one SPELLING of a thing reports
the count of that spelling and calls it the population, and none of them
announces a parse failure. The first apparent finding of the audit built on
these — a docblock reading *"The three files"* over what the counter read as two
entries — **was the counter being short, not the comment overclaiming.** Check
each apparent contradiction against the file before writing it down.

## A walked population whose DIRECTORY list is hand-written is still a hand list

Converting a gate from a list of modules to a walk moves the hand list up one
level, where it fails the same silent way. Measured (#590/#609): a gate's
shared-directory list carried `routes/admin` and not `controllers/admin`,
inherited from the census's own list, and the wall shipped over **28 of 29
modules** with no floor or count able to see it.

The remedy is the same rule applied one level up — **sweep the whole tree for
paths naming the domain and require each to be in the population or in a counted
exclusion.** Match the PATH, not the filename: a module inside a directory named
for the domain names it nowhere in its own name, and a filename sweep found 10 of
29.

**And the asymmetry to look for is inside a single file.** Measured across the
gates on `d46bef89`: **27 pair a RECURSIVE `walk()` with a ONE-LEVEL
`isFile()` domain-name sweep** over the shared flat directories, ten lines apart,
so the file reads as though it recurses throughout. `walk('controllers')` reaches
`controllers/admin/`; the name sweep beside it does not. It is live, not latent —
`merchant-activation-isolation.test.ts` sweeps with `entry.isFile()` while
`routes/admin/merchant-activation.ts` exists and is named nowhere in that gate.
Four more domain-named modules sit in those directories (`routes/admin/feeds.ts`,
`routes/admin/referral-partner.ts`, `controllers/admin/pickup-admin.controller.ts`,
and the analytics pair #609 fixed for one gate only). Most other domains are
complete purely by where their modules happen to live.

## An empty exclusion list needs a positive control, and sharing the comparison is not enough

`toEqual([])` is satisfied three ways: by a correct tree, by a sweep that reached
nothing, and by a population containing everything. A vacuity floor covers the
second. The third is the hard one, and **this section previously credited a
mechanism that does not close it.**

What it said, and what #609 measured, was this: with two spellings of the
population — the wall computing one and its control computing another — mutating
the wall's to contain everything left **all ten tests green**, so one comparison
was made to serve both.

**That was a real defect and the shared comparison is a real improvement, but it
does not close the case this section is named for.** Sharing the comparison
catches a population spelled `new Set(paths)` — the argument — and does **not**
catch one spelled `new Set(swept)`. Re-measured on `analytics-ranking-isolation.test.ts`,
which carries the shared comparison and quotes the sentence above:

    perl -0pi -e 's/const population = new Set\(analyticsDomainModules\(\)\);/const population = new Set(swept);/' \
      packages/backend/src/services/analytics/__tests__/analytics-ranking-isolation.test.ts
    # -> Tests  10 passed (10)

**The reason is structural, so every copy of the pattern inherits it.** The
planted module is not on disk. It is therefore outside a population derived from
the real sweep *exactly* as it is outside a correct one, and the control cannot
tell those apart — it reports `[planted]` either way. A control built on a
FINISHED ARRAY passes whatever the derivation does.

### What does close it: make the population a FUNCTION OF THE READER

The population has to be a `(readDir) => string[]`, and the control has to
re-derive it against the **seeded** reader. Then an over-broad derivation —
one that is the sweep, or that walks `src/` — ABSORBS the plant, the comparison
returns `[]`, and `toEqual([planted])` fires.

`src/__tests__/domain-population.ts`'s `assertNothingOutsideDomainPopulation` is
that shape. It arrives with **#638**, so until that lands this paragraph names a
file the tree does not have — measured against the helper on that branch, one
honest call and two mutated ones:

| population passed to the assertion | result |
|---|---|
| the domain's real derivation | passes |
| `(readDir) => sweepSrcTreeForDomain(pattern, readDir)` | **red** |
| `(readDir) => walkOwnedDirectory('', readDir)` | **red** |

Both reds land on the control, not on the wall — which is the point: the wall is
vacuous in both, and only the control says so.

### The weaker compensating control, for a gate not on the helper

A gate that still builds its population as an array can get most of the way with
a different clause: assert that modules which **exist** and belong to other
domains are NOT in the population, each with a `statSync` proving the exclusion
is not vacuous.

    for (const foreign of ['controllers/orders.controller.ts', 'db/schema/orders.ts']) {
      expect(POPULATION, `${foreign} belongs to another domain`).not.toContain(foreign);
      expect(statSync(join(SRC_ROOT, foreign)).isFile(),
        `${foreign} no longer exists, so excluding it proves nothing`).toBe(true);
    }

Mutation-tested both ways across eleven gates: adding `...walk('')` to a
population fails it naming `controllers/orders.controller.ts`, and without the
clause the same widening passes.

**It is strictly weaker and should not be read as an alternative.** It catches a
widening that swallows a real module — the realistic drift, and the one a
directory list acquires by accident — and it would NOT catch a wall whose
population expression was swapped for the sweep, because the named foreigns do
not name the domain and never enter the sweep. Prefer the helper; use this only
where the population cannot be expressed as a function of a reader, and say in
the file which one you have.

### And re-check the name pattern before believing an empty result

A whole-tree assertion reporting zero modules outside the population is either
complete or asking the wrong question, and **those look identical** — the vacuity
floor does not separate them, because the sweep did reach the modules the pattern
matches.

Measured: `guest-portal-isolation.test.ts` matched `guest-orders` while #106's
`services/orders/guest-order-portal.service.ts` — the portal view projection —
is spelled `guest-order` **singular**. One character. It matched nothing, the
assertion reported a clean empty set, every floor and count in the file was met,
and that module was named in **no isolation gate in the repository**.

The check is one line per gate: sweep for the domain's least-specific word and
subtract what the pattern already matches.

    find . -name '*.ts' -not -path '*/__tests__/*' | sed 's|^\./||' \
      | grep -iE '<bare word>' | grep -viE '<the pattern's alternatives>'

Most hits are other domains and triage takes seconds — `portal` minus
`guest-portal` returned the one real miss, while `claim` minus `guest-claim`
returned #83's merchant claims, `activation` minus `merchant-activation`
returned #66's Awin advertiser activation, and `buyer` minus `buyer-request`
returned the buyer domain. **Measure a candidate against the gate's own
detectors before adding it**: the one above was clean against all six of that
gate's walls, so it was a widening; one that trips a wall needs a counted
exclusion instead, or the conversion builds a false wall.
