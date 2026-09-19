# API compatibility: what a v1 wire contract is, and what retires one

Epic #367 line 437 — *"Add API compatibility policy before deprecating the
current product-creation route."*

The policy is not new. It is mechanically enforced today by
`packages/backend/src/__tests__/v1-wire-contracts.ts` (the registry),
`v1-wire-contract-census.test.ts` (the gate) and
`services/__tests__/v1-wire-contract-serving.test.ts` (the proofs). What was
missing is this file: the rules written where somebody deciding to turn a route
off can read them.

The answer to 437's own clause is at the bottom, and it is not the answer the
line's phrasing suggests:

> **Deprecating the route retires nothing, because the route and the contract
> are different objects.**

## The rule

`docs/house-invariants.md` states it in two sentences: **a versioned wire
contract, never a `@deprecated` alias.** A shipped mobile build cannot be
recalled, so the old spelling keeps being served beside the new one, and what
records that decision is a `retiresWhen` condition plus a registry entry.

`~/AGENTS.md` forbids the annotation for the reason this whole mechanism exists:
an annotation is advice to whoever compiles next, and the clients that matter
here have already shipped.

**Measured rather than asserted**: `@deprecated` appears in four files under
`packages/`. Three are prose stating the prohibition (`v1-wire-contracts.ts:14`,
`condition-input.ts:7`, `condition.ts:284`). **One is a live annotation** —
`packages/ui/src/components/ui/dialog.tsx:56`, `/** @deprecated Use
showCloseButton instead */` — on a component prop rather than a wire contract,
so it is outside anything the census can see. It is recorded here rather than
left to make the sentence above false.

**And it is the distinction this whole file exists for.** A wire contract cannot
be recalled from a shipped client, so the old spelling keeps being served and a
`retiresWhen` records the condition. **A source-consumed component prop can be
renamed in the same commit** — `@mercaria/ui` is consumed from source with no
dist and no external client — so the rule that applies there is `~/AGENTS.md`'s
clean cut: delete the old identifier, update every call site. No
versioned-contract reasoning applies, which is exactly why that annotation
should not exist.

## What makes a field a v1 contract

**The field's own docblock, containing `v1` as a whole word.** That is the
entire definition, and it is DERIVED rather than declared — the census walks
`packages/shared-types/src` with the TypeScript compiler, recovers every
property signature whose own JSDoc carries the token, and asserts the registry
covers exactly that set.

The consequence worth knowing before you write a docblock: **mentioning `v1` in
a property's docblock enrols it.** An added contract appears in the census
without anybody editing the registry, which is the direction a hand list is
blind in — `docs/isolation-gates.md` measures what that blindness cost across
twenty-seven gates. Over-collection is the safe direction: a field that talks
about v1 without being one is dispositioned `successor`, which somebody writes
down.

**And the derivation is over PROSE.** A field held open for an old client whose
docblock never says so is invisible to it. That limit is stated in the
registry rather than papered over;
`scripts/validate-catalog-identity-contracts.mjs` is an independent net over the
ambiguous-string subset that needs no prose at all. Neither net is complete and
they have different holes.

## What an entry declares

Five facts the compiler cannot recover, so all five are written by hand and
three of them are checked against the tree:

| field | meaning | checked |
| --- | --- | --- |
| `direction` | `read` \| `write` \| `query` \| `successor` | a `successor` must carry no serving site; every contract must carry one |
| `supersededBy` | the typed field that replaces it, or `null` | — |
| `servedBy` | the production module and exported symbol that serves or accepts it | the symbol is really exported, and the module has a PRODUCTION importer |
| `provenBy` | the test whose FAILURE is the evidence | the title really exists in the named file |
| `why` | why it is open | — |

`direction` is four values because they fail differently. A `read` contract
fails by serving a wrong value to a client that cannot be recalled; a `write`
fails by refusing a body that build still sends; a `query` fails by returning
the wrong ROWS, **which looks like an empty catalogue rather than an error.**

## `retiresWhen` is a CONDITION, never a date

It lives beside the type, not in the registry — `LEGACY_CONDITION_CONTRACT`
(`shared-types/src/condition.ts`), `LEGACY_LISTING_CATEGORY_CONTRACT`
(`category.ts`) — and its own docblock states the policy:

> *"`retiresWhen` is prose on purpose. The condition is observable (no supported
> client version still sends or reads the binary field) and the decision to act
> on it is a release decision, not something a constant can make."*

So a `retiresWhen` names something a person can go and measure. A date is not
that: it expresses a hope about client upgrades, it passes silently when the hope
is wrong, and nothing in the repository could ever fail because of it.

## What may not happen while a contract is open

1. **The old spelling keeps being SERVED, correctly** — not merely accepted.
   Three of the four contracts #367 line 74 is about could have started serving
   a constant with the whole backend suite green — the registry records the
   mutation table and the positive control that makes it mean anything, and that
   measurement is what created the registry.
2. **The two spellings may not be sent together.** Both pairs answer 400 rather
   than applying a precedence rule — `resolveConditionInput:86` (*"Send either
   `condition` (v1) or `itemCondition`, not both — they can disagree"*) and
   `checkout/destination.ts:138` (*"Send either `destination` or the legacy
   `addressId`, not both."*). A precedence rule is a fact about the
   server nobody reading the client would know.
3. **Neither spelling may be stored twice.** The v1 value is DERIVED on every
   read (`Listing.condition` from `itemCondition.key`, `Listing.category` from
   the leaf of the materialized slug path), so there is no second value to keep
   in step.
4. **A contract without a `provenBy` moves an exact count.**
   `V1_CONTRACTS_WITHOUT_PROOF` is pinned in BOTH directions — a ceiling would
   let a closed proof be absorbed silently, a floor would let a new un-gated
   contract land.

## What the census refuses

Fourteen cases across three groups. Nine assertions:

- the walk cleared its floors — **per SHAPE**, three of them (files, property
  signatures, derived members), because one total lets a shape collapse to zero
  unnoticed
- no DUPLICATE derived path, so collapsing to a set below loses nothing
- the registry covers **exactly** the derived set, **in both directions**
- every entry names the file it is declared in
- the un-proven and successor counts pinned **exactly**, in both directions
- a `successor` carries no serving site and a contract always does
- **every serving site EXPORTS the symbol it names**, so a rename breaks the gate
- **every serving module is imported by a PRODUCTION caller, not only by tests**
- every proof names a test title that really exists in the file it names

And five self-tests proving the derivation can fail: the ADD direction, the
REMOVE direction, a sibling not inheriting its neighbour's docblock, a case that
**CAN produce a duplicate path — which is what stops the distinctness clause
being vacuous** — and the boundary class not swallowing `v1` beside a digit.

The last two pairs are the parts worth copying elsewhere. **A named thing must
resolve AND have a production caller**: an exported symbol nobody calls is a
mechanism with no caller, and a serving site imported only by tests is a gate
around dead code. **And a census must be able to fail**: a distinctness
assertion over a walk that cannot produce a duplicate is green forever.

## What the census cannot tell you

**Whether a `provenBy` test asserts anything.** A census proves a member exists
and was classified; it can never prove the classification is TRUE. It checks the
named title is really in the named file — which catches a rename, a deletion and
a typo — and the body is what review is for.

## Before deprecating `POST /admin/stores/:storeId/products`

That is the route line 437 names: `routes/admin/stores.ts:84` mounts
`routes/admin/products.ts`, whose `:45` is the create, behind `products:write`
and `createStoreProductSchema` → `controllers/admin/products-admin.controller.ts:135`
→ `catalog-write.service.createStoreProduct`. The replacement is the authoring
set — `/catalog-authoring`, `/stores/:storeId/product-drafts`,
`/catalog-proposals`. (`POST /seller/listings` is the P2P sibling and is not
what 437 is about, though everything below applies to it too.)

### The route and the contract are different objects

`catalog-authoring/publish.service.ts:271` calls `createStoreProductWithin` —
**the same funnel** — and `buildStoreProductInput` (`:419`) composes its input
including `category: categorySlug` at `:499`, derived from the draft's pinned
`category_id`. It passes `itemCondition` (`:507`) and not `condition`.

So the new route already speaks the successor for condition and **still speaks
v1 for category**, internally, because that is the only spelling the funnel
accepts. Turning the old route off changes which bodies arrive from clients. It
does not touch what the funnel takes, which is where the contract lives.

**A compatibility policy is therefore about the funnel, not the route.** The
question to answer before deprecating anything is *what still speaks v1 after we
do*, and the registry's `servedBy` column is the list.

### Its two contracts, and why the asymmetry is the finding

| contract | successor a client can send | `provenBy` |
| --- | --- | --- |
| `CreateStoreProductInput.condition` | **yes** — `itemCondition`, same input, optional | `condition-taxonomy.test.ts` |
| `CreateStoreProductInput.category` | **no** | `null` |

```
packages/shared-types/src/listing.ts

  CreateStoreProductInput.category        string   REQUIRED
  CreateStoreProductInput.condition?      optional
  CreateStoreProductInput.itemCondition?  optional
  'categoryId'   0 occurrences in the file     (control: 'category' 8)
```

`category` is required, so a client cannot even decline to send it, and
`supersededBy` names `categoryId`, which no create input declares. Their
`retiresWhen` conditions say the same thing in different shapes: condition's has
ONE clause and it is purely about clients; category's has a second — *"and the
typed category identity is on the wire"* — which is about the SERVER and is
measurably false.

> **The category contract is not open because nobody got round to closing it. It
> is open because the successor does not exist.**

### What would close it

**`categoryId` on the wire**: accepted on `CreateStoreProductInput` and
`CreateP2PListingInput` beside the slug, with the pair-refusal rule above, and
published on the `Listing` DTO — `listings.category_id` already exists and is
named by `LEGACY_LISTING_CATEGORY_CONTRACT.supersededBy` as *"not published on
any DTO yet"*. Only then does the first clause of `retiresWhen` become a
question about clients rather than about us.

### What is owed, and why it is one thing rather than two

Four contracts have no proof; **two of them are the category writes, one per
creation route.** One un-proven field is an oversight. The same field un-proven
on both routes is a pattern, and the registry's own `why` says what it is: the
28 create call sites across 8 test files all pass `category:` as fixture input,
and whether any asserts the SLUG resolved to the right `category_id` is not a
question grep can settle.

Closing both is ONE realdb case against a provisioned taxonomy that creates with
a slug and reads the resolved identity back — a different harness from the read
proofs, which is why it was counted rather than hidden. **The proof is missing
for the same reason the contract is open**: nothing on the wire names the
identity the assertion would have to check.

The other two un-proven contracts are `TaxonomyCategory.ancestorSlugs` and
`PrimaryClassification.ancestorSlugs` (ADR 0007 D13), ungated in the READ
direction while the column maintenance is well tested — which is the misleading
part, because column coverage reads as coverage for the projection.

## What this policy deliberately does not contain

**No deprecation schedule, no sunset-header convention and no version
negotiation.** None of the three exists in this repository, line 437 asks for a
policy *before* deprecating rather than for a deprecation, and a policy nobody
implemented is worse than an unresolved reading — it reads as a decision when it
is a wish.

What replaces a schedule is the `retiresWhen` condition plus the registry: the
condition names what to measure, the census makes an un-gated addition fail the
build, and the decision to act is a release decision a person makes.
