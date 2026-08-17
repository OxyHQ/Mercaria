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
