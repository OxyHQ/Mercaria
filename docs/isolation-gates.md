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
