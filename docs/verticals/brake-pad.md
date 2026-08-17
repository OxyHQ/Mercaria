# The automotive brake-pad reference vertical

`packages/backend/src/scripts/seed-verticals/brake-pad.ts` ·
`__tests__/verticals-brake-pad.realdb.test.ts`

One sentence: **a part that fits many vehicles is ONE buyable thing.**

The failure this package is written against is the one every parts catalogue
that grew out of a clothing catalogue commits — modelling fitment as a variant
axis. It looks reasonable for a week. Then a pad that fits four hundred vehicles
is four hundred variants; the variant selector is a vehicle picker wearing the
wrong control; the same physical part has four hundred SKUs, four hundred stock
counts and four hundred price rows; and merging two of them is impossible
because they were never the same row.

## The numbers, and why both are asserted

| | |
|---|---|
| Canonical variants | **2** — one per product |
| Declared variant axes | **0** |
| Vehicle configurations | **13** across 3 makes, 4 models, 6 generations |
| Fitment statements | **11** |

"One SKU fits many vehicles" passes trivially against a fixture holding one
vehicle. So every case asserts the variant count AND the vehicle count, and
`verticals-package-controls.test.ts` carries the mutation that reduces the
fixture to a single vehicle and shows the vehicle count notices.

## All four verdicts, from eleven statements

The test resolves `answerFitment` for **every one of the thirteen
configurations** and tallies:

| Verdict | Count | Which |
|---|---|---|
| `applies` | 10 | Everything the pad fits |
| `partially_applies` | 1 | `golf_mk7_gti` — the Performance Pack carries a larger front disc |
| `does_not_apply` | 1 | `f30_320d_us` — the North American car ships a different caliper |
| `unknown` | 1 | `g22_430i_us` — nobody said, and that is a different answer from "no" |

A fixture that only ever produced `applies` would prove the join and nothing
about the precedence rule.

## The exclusion is an ordinary row

There is no exclusions table and no `is_exclusion` boolean. An exclusion is an
`automotive_fitments` row at a narrower `scope` with
`applicability: 'does_not_apply'`, and `resolveFitment`'s narrowest-scope-wins
rule is the whole mechanism. The test asserts the verdict came back
`decidedAtScope: 'vehicle_configuration'` over TWO statements — the
generation-wide `applies` is genuinely in the answer and genuinely lost.

**And it is stored as a `candidate`, deliberately.** `answerFitment` publishes a
POSITIVE fit only from `POSITIVE_VERIFICATIONS` (`verified` alone) and a
NEGATIVE one from `NEGATIVE_VERIFICATIONS` (`verified`, `candidate`,
`disputed`). An unverified claim that a pad FITS is withheld; an unverified
claim that it does NOT fit bites immediately. The package exercises that
asymmetry rather than describing it.

The control: the EU sibling of the excluded car still resolves `applies` at
`vehicle_generation`, so the exclusion is about one configuration and not about
the generation.

## Overlapping generations, regional configurations, ambiguous engines

**Overlapping generations.** BMW's F30 runs 2012–2019 and the G20 2018–2026;
VW's Mk7 2012–2020 and the Mk8 2019–2026 — two makes, so the case is not one
fixture's accident. A model year alone therefore cannot select a generation,
which is why a year is a property of a CONFIGURATION and never a variant option.
The test drives `listVehicleConfigurations(generationId, 2019)` against both
generations, gets rows from each, and drives the control (`2013` narrows the Mk8
to zero and leaves the Mk7 populated) to show the year filter does something.

**Regional configurations.** The F30 320d exists as a DE car and a US car — two
configurations of one nameplate, told apart by `market` AND `engine_code`, which
is the fact a `320d` string cannot carry.

**Ambiguous engine names.** Two `compatibility_claims` rows carry a supplier's
own words — `fits BMW 320d` and `fits Golf 2019` — and stay `unresolved` with
`ambiguous_target`, resolving to no relation and no fitment. Both are genuinely
ambiguous against this fixture, and the test proves it: it counts the `320d`
configurations (more than one) and the Golf generations covering 2019 (more than
one). Without that control, "ambiguous" is a label somebody typed.

`mercaria_compatibility_claims_raw_freeze` refuses an UPDATE to the raw words
and refuses DELETE outright, so the evidence survives whatever a reviewer later
decides — asserted.

## What stops a vehicle becoming an axis or a facet

The package declares `fitment_reference` at **`scope: 'compatibility'`**, and
`product_type_fields_variant_axis_check` requires `scope = 'variant'` for
`variant_capable` — so that field can never become an axis whatever it is
called. That is the wall that covers an attribute nobody thought to forbid,
where the exact-match forbidden-key list does not. The test drives the real
UPDATE and it is refused.

`filterable` is left at the registry's default of TRUE on that field,
deliberately: the facet domain then suppresses it for its SCOPE
(`compatibility_scope`) rather than for being unfilterable, which is the wall
worth proving. Marking it unfilterable would suppress it for the boring reason
and leave the scope wall untested. The part's OWN properties still filter —
`brake_pad_material = ceramic` narrows from two products to one.

## The part's own facts

- **`pad_dimensions`** — one declaration, three rows, `[height, width, depth]`
  in the declared order, all in `mm`, with the trailing unit applied to the two
  components that carried none and each component's own source text preserved.
- **`brake_pad_material`** observed as `Cerámica` — a Spanish alias — stored
  with `source_display_value = 'Cerámica'` and `normalized_text = 'ceramic'`.
- **Identifiers**: an MPN and a GTIN on the one variant. The GTIN normalizes to
  a 14-digit canonical value (one comparison space, so a UPC and the EAN that
  pads to the same number cannot name two variants); the MPN has no canonical
  form, because it is unique only within a manufacturer.

## Acceptance scenarios

| Workstream 14 asks | Status |
|---|---|
| Seed automotive/braking/brake-pad category and product type | Done |
| Model brand, MPN/GTIN, dimensions, material, axle/position, pack count | Done |
| Model vehicle make/model/generation/configuration and fitment | Done — 3/4/6/13 and 11 statements |
| Prove one SKU fits many vehicles without many variants | Done — 2 variants, 13 configurations, all four verdicts, plus a fixture-reduction control |
| Prove vehicle selector and reverse fitment display | Done. #543 published `/compatibility` — the four picker rungs, `/fitments` and `/fitments/verdict` — and `CompatibilityPanel.tsx` renders the reverse list partitioned by applicability in twelve locales. The walk is proven here and end to end in `vertical-automotive-fitment.e2e.realdb.test.ts`. **The one thing still absent is a shopper-facing PICKER in the UI**: nothing in the storefront calls a `/vehicles/...` rung or the verdict, and `docs/compatibility.md` files that as a seam belonging to the storefront work |
| Preserve source evidence and ambiguous fitment review | Done — two unresolved claims, frozen raw text, with the ambiguity itself measured |
