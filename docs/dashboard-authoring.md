# The dashboard product wizard (#367 step 10, ADR 0007 D10)

The merchant-facing half of the authoring epic: a schema-driven, resumable form
that composes **nothing**. `services/catalog-authoring/` decides which fields
exist, what they accept, what they are called and in what order; this package
renders that answer and sends typed values back.

| Piece | Path |
| --- | --- |
| Transport | `packages/dashboard/lib/authoring/api.ts` |
| React Query bindings | `packages/dashboard/lib/authoring/hooks.ts` |
| Form state, patch, completeness | `packages/dashboard/lib/authoring/wizard-state.ts` |
| The ONE answer composer | `packages/dashboard/lib/authoring/answers.ts` |
| Visibility rules (client mirror) | `packages/dashboard/lib/authoring/visibility.ts` |
| Inline checks | `packages/dashboard/lib/authoring/inline-validation.ts` |
| Variant matrix | `packages/dashboard/lib/authoring/matrix.ts` |
| Finding paths and message keys | `packages/dashboard/lib/authoring/findings.ts` |
| Autosave, concurrency, publish | `packages/dashboard/lib/authoring/use-draft-wizard.ts` |
| Market resolution | `packages/dashboard/lib/authoring/market.ts` |
| Components | `packages/dashboard/components/catalog-authoring/` (11) |
| Routes | `app/(app)/products/wizard/index.tsx`, `app/(app)/products/wizard/[draftId].tsx` |
| The gate | `scripts/validate-authoring-schema-driven.mjs` + its self-test |

**No new backend surface, no schema change and no migration.** Every endpoint
this consumes shipped with #367 step 5.

## Availability is the SERVER's answer, not a client flag

`CATALOG_AUTHORING_ENABLED` (ADR 0007 D12, default false) gates the MOUNT, so an
unconfigured deployment answers 404 to every authoring route. `probeAuthoringAvailability`
reads that 404 as "off" and **anything else is rethrown** — reporting an outage
as "unavailable" would silently send every merchant back to the legacy form and
nobody would find out.

There is deliberately no `EXPO_PUBLIC_` flag beside it. A second answer to "is
the wizard available" is one that can disagree with the server, and the way it
disagrees is a merchant filling in a form whose publish route does not exist.

**The legacy `/products/new` is untouched and stays the destination wherever the
wizard is unavailable.** `/products` derives which one "Add product" opens.
Retiring the old form is a separate decision, and the flag it is behind already
exists.

## The steps, and why they are not the server's list

`AuthoringStepKind` is the ordered list of DOMAINS a surface walks. The wizard's
own screens are `classification · details · variants · pricing · listing ·
review`, and the difference is one join: `offer` and `inventory` both hang off a
variant row, so rendering them apart would show the same rows twice with two of
their columns each, and an author setting a price for a size they have none of
would have to hold both in their head.

Every step is reachable at any time. A wizard that locks you out of step four
until step three is perfect is one you cannot use to find out what step four is
going to ask for. Completeness is SHOWN (`answered/total` per step, derived from
the schema and the entries, never stored) and the publish is what enforces.

## What is decided here, and what is only rendered

| Question | Decided by |
| --- | --- |
| Which fields exist, in which groups, in what order | the composed `AuthoringSchema` |
| What a field accepts | `AuthoringFieldValidation`, restated by the server |
| Which values a controlled field admits | `AuthoringField.controlledValues` |
| What anything is CALLED | `AuthoringSchemaText`, keyed by stable id |
| Which attributes can define variants | `AuthoringField.variantCapable` |
| Which combinations exist | the author, from the axes they switched on |
| Whether it may publish | the server, at `validate` and again at `publish` |

`SchemaField.tsx` branches only on `validation.valueType`, `cardinality`,
`valuePolicy` and `requirement`. There is no branch anywhere on which attribute,
category or product type this is — which is the acceptance criterion the whole
epic is arranged around, and the thing the gate below refuses.

## Identity, never a label

Every draft answer is composed in ONE place, `composeFieldPayload` in
`answers.ts`, from an `AuthoringField`. The entry union has no member that
carries a label, and `DraftAnswerPayload` has no property a translated string
could go in — so "the wizard submits `attributeKey` + a typed value or an
`enumValueId`" is a property of the types rather than a rule somebody follows.

The one entry that keeps a display name (`canonical_reference`'s `refName`) is
presentation and has nowhere to go in a payload, by construction.

## The client-side visibility mirror, stated rather than hidden

`AuthoringField.visibilityRule` travels in the schema precisely so a form can
decide what to render before it submits anything, and there is no per-draft
"which fields are visible" endpoint. So `visibility.ts` is a SECOND
implementation of a pure function `services/product-types/visibility-rule.ts`
also owns.

What bounds a divergence is the direction of authority: the server re-evaluates
the identical rule at `validate` and inside the publish transaction. A
disagreement can only mean a field was shown that did not need answering, or one
was hidden and the server then reports `required_field_missing` against it —
both visible, neither silent. **Nothing this module decides can make a publish
succeed that the server would refuse.**

The rule vocabulary is imported from `@mercaria/shared-types` rather than
restated, so a member added upstream is a `tsc` error here rather than a branch
that silently falls through. The `unknown → hidden` policy is the server's,
quoted in one place: treating `unknown` as visible deadlocks the form, because
the author is told a field is required while the field whose answer would decide
that is not shown yet.

## Autosave, concurrency and the publish

- **Debounced on the form's CONTENT** (`formSignature`, which hashes the PATCH),
  so a space typed and deleted costs nothing and a burst of typing costs one
  request.
- **A save takes back the `version` and nothing else.** Applying the server's
  echo would move the cursor of anybody typing while a save is in flight, and
  the two copies agree by construction anyway.
- **`unsaved` is DERIVED from `dirty`**, not a state anything writes. The three
  that outrank it are the ones with their own remedy — `saving`, `failed`,
  `conflict`.
- **A 409 stops the clock.** The draft moved: another device saved it, or it was
  published, or it was discarded. Retrying would either lose what the other
  device wrote or hammer a draft that cannot be written at all. The author's
  edits stay on screen until they choose to re-read, so nothing is thrown away
  by the machine.
- **A transport failure does NOT retry on a timer** — the debounce is keyed on
  content, which has not changed. The badge is the retry, and the state
  persists so a slow save and a broken one are distinguishable.
- **Validate and publish SAVE first.** Validation runs against what is stored,
  so validating a dirty form would report findings against values the author has
  already fixed.
- **One idempotency key per wizard session.** A retry after a timeout has to
  converge on the listing the first attempt may already have created; a key
  minted per request would make the retry a second publication.
- **The browser's `beforeunload` is the only unsaved-change guard** and it fires
  only on web. Native needs none: a back gesture does not unload the app.

## The variant matrix

Generating the Cartesian product is a convenience; what is STORED is the enabled
rows. ADR 0007 D6 says matrices are sparse and nothing generates the full product
as rows, so a disabled combination has no payload at all — which is how
"impossible combinations can be disabled" and "sparse matrices" are one
mechanism rather than two. A disabled row stays on screen, so the author can see
what they excluded rather than wondering whether they forgot it.

**Duplicate detection is after normalization and independent of display order.**
`axisDedupeKey` sorts the `(attributeDefinitionId, normalizedValue)` pairs and
joins them, with the shared normalization (trim, collapse whitespace runs, fold
case) applied to the controlled value's own CANONICAL string — which is what the
server hashes. It is deliberately NOT the server's signature and is never sent:
`DraftVariantPayload` has no member to send it in, and the partial unique index
stays the authority. Reporting it here is what turns a `23505` nobody can
attribute into "this row duplicates an earlier one".

Regenerating after adding one value to one axis keeps every price, SKU and stock
level already typed, because rows are matched on that same dedupe key.

**Zero axes is a normal answer** — one configuration, one row — and it is the
fallback rather than an empty state. The generator is capped at 200 combinations
and REFUSES past it rather than truncating: a truncated matrix is missing
exactly the combinations nobody looked at.

## Errors

Every refusal is one of the server's `AuthoringValidationCode`s, rendered
through `findingMessageKey` — a total `Record` over the closed set, so a code
added upstream fails `tsc` rather than rendering nothing. The values are
translation KEYS; a sentence in that module would be an English string in module
scope, which `validate:i18n-strings` refuses.

`parseFindingPath` is the ONE place this app reads ADR 0007 D10's path spelling.
A path it cannot parse still appears in the summary, attached to the review step
rather than to a control — a publish that fails for a reason nobody is shown is
the failure the summary exists to prevent.

Errors and warnings appear in ONE list. That split is what makes `recommended` a
real requirement level: a recommended field left empty is reported, visibly, and
still publishes.

`inline-validation.ts` produces the same codes without a round trip. It is not
an authority and cannot be one; what it buys is latency, so an author typing a
fourteenth decimal place is told at the keystroke.

### The two proposal codes are live as of #367 step 6

`validateDraftRow` now produces `proposal_pending_blocks_publication` (path
`draft.pendingProposals`) and publishes `proposalNotPermittedFinding`, whose
documented path is `fields.<attributeKey>`. Both were previously in the closed
set and produced by nothing, so this is the first traffic through them.

Measured against the real modules rather than assumed: the first parses to a
`draft` target and lands on the REVIEW step — correct, because it is a fact
about the draft and names no control — and the second parses to a
`product_field` target and attaches to that field on the DETAILS step. Both
resolve a real sentence (`products.wizard.finding.proposalPending`,
`…proposalNotPermitted`), translated in all eleven bundles, rather than falling
through to a generic message.

## Accessibility and layout

Every control carries an `accessibilityLabel` (server-composed where the label
is the schema's), errors sit beside their control and in a summary whose heading
is `accessibilityRole="alert"`, the step rail is `role="tab"` with
`accessibilityState.selected`, and the value picker is a dialog with an
`accessibilityState.selected` per option.

**No desktop-only table.** The variant matrix is cards that stack, with columns
that wrap — a merchant creating a product is a critical action and half of that
happens on a phone.

Logical spacing utilities (`ms-`, `me-`, `ps-`, `pe-`) are used where they
occur. `text-right` and physical borders are used deliberately: `text-end` and
`border-s-*` are MEASURED not to survive react-native-css/RN 0.85 (a clean
compile and no effect on native), and the dashboard is not mirrored (#434).
`validate:rtl-classes` does not scan this package.

## The gate

`scripts/validate-authoring-schema-driven.mjs`, wired into CI as
`validate:authoring-schema`, with `test-validate-authoring-schema-driven.mjs`
mutation-testing it (24 cases). Four walls over `packages/dashboard`:

1. **No branch on a concept's identity** — a comparison or `switch` against a
   string literal (or an in-file constant bound to one), or a membership test
   against a list THIS TREE authored. Membership against a set built from the
   schema at runtime is the correct implementation and must not fire.
2. **No namespaced concept key in the wizard's own tree**, subtracting the app's
   `en.json` (a translation key has the identical shape) and D10's six published
   validation paths, whose exact count the self-test asserts.
3. **No hardcoded field or value identity in a payload.**
4. **No translated label in an identity property.**

Floors on both the whole tree and the authoring subtree, a positive control per
wall that asserts the mutation LANDED before asserting the guard fired, and
negative controls over the code the correct implementation actually writes.

**Stated residual:** wall 2 is scoped to the authoring subtree because a dotted
lowercase literal is also what an AsyncStorage key looks like — there is one in
`lib/themePersistence.ts` today — so repo-wide the shape rule cannot tell a
concept key from storage plumbing. A concept key parked outside the wizard's
tree and imported into it is caught by wall 1 the moment it is compared against
anything, which is the only way it does damage.

## What this could NOT do, and why

- **Media.** No upload path to Oxy's file service exists anywhere in this
  repository, so there is no picker. `imageFileIds` is deliberately never SENT —
  a patch leaves an unnamed field untouched — so a draft that has images does not
  lose them every time somebody types a title. A control that cannot finish would
  be worse than its absence.
- **Per-location stock.** `DraftVariantPayload` carries ONE available quantity
  per variant, which the publication hands to the same product-create path the
  rest of the dashboard uses. Splitting it across locations is `inventory_levels`'
  surface and already exists on the published product; inventing a client-side
  split would be a number this app could not store.
- **Condition.** `AuthoringStepKind` has no condition step and the draft carries
  no condition column. #90's taxonomy is a listing property set elsewhere.
- **A category on a canonical candidate.** `AuthoringCanonicalCandidate` is
  deliberately thin, so finding the exact product does not skip the
  classification step. The screen says so rather than leaving a merchant
  wondering.
- **A `canonical_product_family` reference.** `/catalog-authoring/canonical-search`
  takes `canonical_product` or `brand`; no read in this repository returns
  families by name, and guessing which product-search rows are families would be
  inventing a lookup.
- **Proposing a missing controlled value.** `permissions.canProposeValues` is
  `false` in every branch server-side, so no control is rendered. #367 step 6
  landed the domain and wired the two codes below, but the propose control is
  its client half: a form, the `/catalog-proposals` submission, an
  awaiting-review state on the field. Flipping the projection without them would
  tell a client a control exists that no screen renders, which is the reasoning
  `catalog-authoring.controller.ts` gives for the `false` in the first place.

## Seams left, each failing closed

- **#367 step 6's CLIENT half** (ADR 0007 D9 proposals): the domain landed and
  both codes now render (above); what is missing is the control that lets a
  merchant propose a value, and the projection stays `false` until it exists.
- **The upgrade preview**: `useDraftUpgradePreview` and `useApplyDraftUpgrade`
  are bound and no screen calls them. `schema_version_superseded` is surfaced as
  a warning by the validation path, which is what tells an author the rules
  moved; the preview UI is a screen this issue did not build.
- **The market**: derived from the device region with a merchant override,
  because `Store` carries no country. If stores grow one, `market.ts` is the one
  module that changes.
