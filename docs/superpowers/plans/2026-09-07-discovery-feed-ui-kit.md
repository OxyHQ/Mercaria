# Discovery Feed — UI Kit Implementation Plan (Plan B of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add to `@mercaria/ui` the nine components the discovery feed's eight section kinds need, rendering pixel-for-pixel like the captured Shop reference, with Bloom's colours.

**Architecture:** Presentational only. Every component takes props and renders; none fetches, none knows a scope, none imports from `packages/backend`. The section→component mapping happens in Plan C's screens, not here.

**Tech Stack:** React Native + Expo, NativeWind (Tailwind class names compiled for RN), `expo-image`, `expo-linear-gradient`, `lucide-react-native`, TypeScript.

**Spec:** `docs/superpowers/specs/2026-09-07-discovery-feed-design.md`
**Token appendix — the exact classes, measured from the capture:** `docs/superpowers/specs/2026-09-07-discovery-feed-component-tokens.md`

Plan A (backend) is complete: `GET /discovery/feed?scope=` serves all three scopes and the DTOs this plan's props are typed from are in `@mercaria/shared-types`.

---

## Global Constraints

### The verification story is different here, and you must not "fix" it

**`@mercaria/ui` has no test runner and must not gain one.** Its `package.json` carries `"test": "echo \"No tests specified\" && exit 0"`, and there is not a single `*.test.tsx` anywhere in the repository. The frontend's own runner is scoped to `lib/**` with a node environment and no jsdom.

This is deliberate, and `packages/backend/src/__tests__/client-test-runners.test.ts` enforces it from the other side: **a package that declares a real `test` script must be named by a CI step.** Adding vitest to `@mercaria/ui` turns that gate red and leaves the new tests running on nobody's machine. Plan A hit exactly this and had to revert it.

So there is no TDD cycle in this plan. What replaces it:

| Gate | Command | What it catches |
| --- | --- | --- |
| Types | `bun run --filter @mercaria/ui typecheck` | props and imports |
| The three Expo apps | `bun run --filter @mercaria/{frontend,dashboard,pos} typecheck` | a shared-component change that breaks a consumer. **A build is not a substitute — Babel strips types, so `expo export` bundles code `tsc` rejects.** |
| Direction | `bun run validate:rtl-classes` | a physical `ml-2`/`left-4` that half-mirrors Arabic with every build green |
| Copy | `bun run validate:i18n-strings` | hardcoded strings, missing keys, locale parity |
| Eyes | Plan C, running the app | whether it looks like the reference |

Every task below ends with the first four. The fifth arrives in Plan C, and until then "done" means "typechecks and passes the gates", not "looks right" — say so in your report rather than implying more.

### Direction: logical utilities only

`scripts/validate-rtl-logical-classes.mjs` fails the build on `pl-`/`pr-`, `ml-`/`mr-`, `left-`/`right-`, `border-l`/`border-r`, `text-left`/`text-right` and the `rounded-l`/`rounded-r` corner variants.

The captured reference uses physical classes throughout. Translate as you copy: `pl-` → `ps-`, `pr-` → `pe-`, `left-` → `start-`, `right-` → `end-`, `-left-` → `-start-`.

Two exceptions the repo has measured and recorded in `AGENTS.md`: `border-s-*` and `text-start` do **not** survive react-native-css/RN 0.85 and stay physical, with a `KNOWN_EXCEPTIONS` entry naming the file and the count. Do not add an exception for anything else without measuring it first.

### What React Native cannot copy literally

| Reference | Here |
| --- | --- |
| `line-clamp-N`, `truncate` | `numberOfLines={N}` |
| `object-cover` | `expo-image` `contentFit="cover"` |
| `hover:`, `group-hover:`, `backdrop-blur-*`, `transition-*` | prefix with `web:` |
| `snap-x snap-mandatory` | `ScrollView` `snapToInterval` |
| `srcset` / `sizes` | one sized URL |
| a CSS gradient | `expo-linear-gradient` |
| an inline `aspect-ratio` | the `style` prop |

### Everything else

- `bun`/`bunx` only, from the repo root.
- An absent image is an **absent optional field**, never `''`. Every renderer branches and draws the placeholder — `packages/shared-types/src/product.ts` carries the reason on every `imageUrl?` field, and a blank card shipped once already because `<Image source={{ uri: '' }} />` typechecks.
- **No nested interactives.** A card's root is a plain `View`; each link is a sibling. `MerchantCard` and `CategoryCard` already follow this — read them. On web an `<a>` inside an `<a>` is invalid and the inner one stops working.
- `@mercaria/ui` is **not built to `dist`**. Apps consume it through Metro `watchFolders`, the `@mercaria/ui/theme/tailwind.preset` preset and a `tsconfig.paths` alias. Do not add a build step.
- **`@mercaria/ui`'s own copy lives in ITS bundles** under the reserved `ui` namespace, read through `SharedUiTranslationProvider`. Module-scope data holds KEYS, never sentences.
- NEVER: `as any`, `@ts-ignore`, `@ts-expect-error`, `any` params/returns, `!` assertions, `console.log`, `var`, `catch {}`, TODO/FIXME/HACK, inline RN styles where a NativeWind class exists, hardcoded colours outside the documented `fixed`/`overlay` constants.
- **React Compiler is on.** Never read external mutable state in a memoized position.
- Commit trailers: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_0121G2nyf5Q1DD7TKx3q2fb8`.

---

## File Structure

**`packages/ui/src/theme/tailwind.preset.js`** — the four token groups the capture uses and the preset lacks.

**`packages/ui/src/components/marketplace/`** — nine new files, one component each, beside the existing `MerchantCard`, `ProductCard`, `Carousel`, `SectionHeader`:
`ActionHeroCard.tsx`, `CategorySampleTile.tsx`, `CategoryImageTile.tsx`, `CategoryPill.tsx`, `SectionCard.tsx`, `StoreProductCard.tsx`, `StoreOfferHeader.tsx`, `DiscountBadge.tsx`, `FeedGrid.tsx`.

**`packages/ui/src/lib/category-palette.ts`** — the deterministic id→colour helper the browse-category tiles need. Its own file because it is the only piece of logic in this plan and the only thing another surface might reuse.

**Modified:** `packages/ui/src/components/marketplace/SectionHeader.tsx` (the chevron disc), `packages/ui/src/index.ts` (exports), `packages/ui/src/i18n/` bundles (this kit's own strings).

---

### Task 1: The preset gaps

Everything after this needs them, and a missing token silently renders as no style rather than as an error — NativeWind drops a class it does not recognise.

**Files:** Modify `packages/ui/src/theme/tailwind.preset.js`

**Produces:** `rounded-radius-24`; `text-posterXS` + `font-posterXS`; `bg-bg-fill-tertiary`, `bg-bg-overlay-fixed-dark-04`, `bg-bg-overlay-fixed-dark-10`, `bg-bg-overlay-fixed-light-20`, `bg-bg-overlay-fixed-light-40`, `bg-bg-overlay-fixed-light-75`; `shadow-s`, `shadow-m`, `shadow-l`.

- [ ] **Step 1: Add the tokens**

In `borderRadius`, beside the existing `radius-20` / `radius-28`:

```js
"radius-24": "24px",
```

In `fontSize` and `fontWeight`, beside `header` / `headerBold`:

```js
// fontSize
posterXS: ["40px", { lineHeight: "44px", fontWeight: "700" }],
// fontWeight
posterXS: "700",
```

In `colors`, beside the existing `overlay-*` block:

```js
"bg-fill-tertiary": "var(--muted)",
"overlay-fixed-dark-04": "rgba(0,0,0,0.04)",
"overlay-fixed-dark-10": "rgba(0,0,0,0.10)",
"overlay-fixed-light-20": "rgba(255,255,255,0.20)",
"overlay-fixed-light-40": "rgba(255,255,255,0.40)",
"overlay-fixed-light-75": "rgba(255,255,255,0.75)",
```

Add a `boxShadow` block inside `theme.extend`:

```js
boxShadow: {
  // The reference names `shadow-s`/`shadow-m`; components here reach for
  // Tailwind's own `shadow-md`/`shadow-lg` today, which is a different ramp.
  s: "0 1px 2px rgba(0,0,0,.06)",
  m: "0 2px 8px rgba(0,0,0,.10)",
  l: "0 8px 24px rgba(0,0,0,.14)",
},
```

Keep the file's existing comment style: each block already explains WHY the token set exists and that it is additive. Say the same for these — in particular that the `fixed`/`overlay` families are theme-independent constants by design, which is already what those prefixes mean in that file.

- [ ] **Step 2: Verify the tokens resolve**

```bash
bun run --filter @mercaria/ui typecheck
bun run --filter @mercaria/frontend typecheck
```

Expected: both exit 0. A preset error surfaces here as a Tailwind config parse failure, not as a type error, so also confirm the file still parses:

```bash
node -e "const p=require('./packages/ui/src/theme/tailwind.preset.js'); const t=p.theme.extend; console.log(t.borderRadius['radius-24'], t.fontSize.posterXS[0], t.colors['overlay-fixed-light-75'], t.boxShadow.s)"
```

Expected: `24px 40px rgba(255,255,255,0.75) 0 1px 2px rgba(0,0,0,.06)`.

The path is `src/theme/`, not `theme/` — apps reach it through the package export
`"./theme/tailwind.preset": "./src/theme/tailwind.preset.js"`, so the import
specifier and the file path differ. Run this before your change too: all four
print `undefined` today, which is what makes the after-value evidence rather
than decoration.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/theme/tailwind.preset.js
git commit -m "feat(ui): the four token groups the discovery capture uses and the preset lacked

Measured from the reference markup rather than chosen: radius-24 is the
browse-category tile, posterXS the category page's h1 from md up, the six
overlay/fill colours are scrim and pagination-dot values, and shadow-s/m/l
are the ramp the reference names where components here reach for Tailwind's
own shadow-md/lg.

Additive throughout — no existing token changes meaning."
```

---

### Task 2: The four flat presentational cards

Batched deliberately: four files of the same shape — props in, absolutely-positioned image, a label, one press target — differing only in measurements the token appendix already gives verbatim. One review of the four together is a better use of a reviewer than four reviews of one.

**Files:** Create `ActionHeroCard.tsx`, `CategorySampleTile.tsx`, `CategoryImageTile.tsx`, `CategoryPill.tsx` in `packages/ui/src/components/marketplace/`; create `packages/ui/src/lib/category-palette.ts`.

**Interfaces produced:**
```ts
ActionHeroCard({ card, onPress }: { card: HeroCard; onPress?: (card: HeroCard) => void })
CategorySampleTile({ tile, samples, onPress }: { tile: CategoryTile; samples: readonly string[]; onPress?: (tile: CategoryTile) => void })
CategoryImageTile({ tile, onPress }: { tile: CategoryTile; onPress?: (tile: CategoryTile) => void })
CategoryPill({ tile, onPress }: { tile: CategoryTile; onPress?: (tile: CategoryTile) => void })
categoryPaletteColor(categoryId: string): string
```

- [ ] **Step 1: Read the sources**

§1–§4 of the token appendix give every class for these four, with a "Here" column naming the exceptions. Read `CategoryCard.tsx` in the same directory first: it already solves the absolutely-filled `expo-image` over a sized parent, the sibling-link rule, and the white-label-over-any-image problem.

- [ ] **Step 2: Write `category-palette.ts`**

The browse-category tiles carry a per-category background colour. `categories` has no colour column and this plan adds none: there is no operator surface to set one, so a column would be a field nobody can fill.

Derive it deterministically from the category id against a fixed palette. Requirements: the same id always yields the same colour; the palette is a module-scope `const` of documented values; every colour has enough contrast for `text-text-inverse` on top, because the label is always inverse. State in the docblock that it is derived rather than stored, and why.

- [ ] **Step 3: Write the four components**

Each is presentational, takes an `onPress` and renders one press target. `ActionHeroCard` uses `expo-linear-gradient` for the scrim (`transparent` → `rgba(0,0,0,0.314)`, `locations={[0, 0.85]}`) and `style={{ aspectRatio: 2.35 }}`. `CategoryImageTile` renders BOTH labels and hides one per breakpoint, exactly as the reference does — that is how the type ramp changes without a JS media query. `CategoryPill` carries its multi-stop shadow through `style={{ boxShadow }}`, the technique `IncentiveHalo` already uses.

Every image branches on absence and draws the placeholder.

- [ ] **Step 4: Verify**

```bash
bun run --filter @mercaria/ui typecheck
bun run --filter @mercaria/frontend typecheck
bun run --filter @mercaria/dashboard typecheck
bun run --filter @mercaria/pos typecheck
bun run validate:rtl-classes
```

Expected: all exit 0. If `validate:rtl-classes` fails, it will name the file and the physical class — translate it rather than adding an exception.

- [ ] **Step 5: Commit**

Subject: `feat(ui): the four flat cards the discovery feed's tile and hero rows need`.

---

### Task 3: The grid, the container card, and the header change

**Files:** Create `FeedGrid.tsx`, `SectionCard.tsx`; modify `SectionHeader.tsx`.

**Interfaces produced:**
```ts
FeedGrid<T>({ items, keyExtractor, renderItem, slotClassName, rowGapClassName }: {...})
SectionCard({ title, onPress, children }: { title: string; onPress?: () => void; children: ReactNode })
```

- [ ] **Step 1: `FeedGrid`**

Everything in `@mercaria/ui` today is a carousel; this is the wrapping grid the reference calls `ListSection`. Items row: `flex flex-wrap -mx-space-4 md:-mx-space-8` plus a row-gap class the caller supplies (`gap-y-space-8 md:gap-y-space-16` normally, `gap-y-space-40` for the card-group). The negative horizontal margin cancels each slot's own `px-space-4` so the row's outer edge aligns with the page gutter.

Slot widths are a PROP, not knowledge the grid holds — the per-component values are in the appendix and differ per card family. Mirror `Carousel`'s existing defences: tolerate an undefined `items`, and drop duplicate keys keeping the first.

- [ ] **Step 2: `SectionCard`**

The bordered container holding a titled mini-shelf, two per row on wide screens. Classes in appendix §5. Its header is one link; `children` is whatever shelf the caller nests.

- [ ] **Step 3: The `SectionHeader` change**

Its trailing chevron is currently `h-8 w-8 rounded-full border border-border`. The reference is a FILLED disc with no border:

```
flex aspect-square items-center justify-center overflow-hidden rounded-radius-max bg-bg-fill-secondary
```

with a 20px chevron. `MerchantCarousel`, `ProductShelf` and every other current consumer inherits this, which is intended — they are the same shelf header. Check each consumer still typechecks and note in your report which ones changed appearance.

- [ ] **Step 4: Verify** — the five commands from Task 2 Step 4.

- [ ] **Step 5: Commit** — subject: `feat(ui): a wrapping grid, a container card, and the header disc the reference uses`.

---

### Task 4: `StoreProductCard` and `DiscountBadge`

The one genuinely new card: a square cross-fading product carousel with pagination dots over a store row. Appendix §6 and §7.

**Files:** Create `StoreProductCard.tsx`, `DiscountBadge.tsx`.

**Interfaces produced:**
```ts
StoreProductCard({ store, discount, onPressStore, onPressProduct }: {
  store: StoreSummary; discount?: DiscountSummary;
  onPressStore?: (handle: string) => void; onPressProduct?: (id: string) => void;
})
DiscountBadge({ discount }: { discount: DiscountSummary })
```

- [ ] **Step 1: The carousel behaviour**

The reference cross-fades absolutely-positioned slides — active `z-10 opacity-100`, inactive `pointer-events-none opacity-0` — with pagination dots, and marks inactive slides `inert` on web. On native, do not render an inactive slide as pressable; `inert` has no RN equivalent and a hidden-but-pressable slide is a real bug, not a cosmetic gap.

Advance on press of the edge zones, as the reference does. Keep the index in component state; **do not read it in a memoized position** — React Compiler is on.

- [ ] **Step 2: The store row and the badge**

Store row: logo (32px here, against 44px on `StoreOfferHeader`), name at two type ramps hidden per breakpoint, rating with the star AFTER the number. The store row is a SIBLING link to the product links, never a parent — `MerchantCard` already follows this rule and says why.

`DiscountBadge` renders an `sr-only` full sentence beside the abbreviated visible text, as the reference does ("Save €25 with your offer" / "Save €25"). Keep that split: the visible string is a fragment and a screen reader needs the whole claim. Both strings come from the `ui` namespace with a parameter — never composed here.

Wrap the logo in the existing `IncentiveHalo` when `discount.exclusive` is true.

- [ ] **Step 3: Verify** — the five commands, plus `bun run validate:i18n-strings` since this task adds copy.

- [ ] **Step 4: Commit** — subject: `feat(ui): the square store card the explore grids are made of`.

---

### Task 5: `StoreOfferHeader`, the exports, and the copy

**Files:** Create `StoreOfferHeader.tsx`; modify `packages/ui/src/index.ts` and the `packages/ui/src/i18n/` bundles.

- [ ] **Step 1: `StoreOfferHeader`**

Appendix §8. One per store on the deals page: logo at 44px (inside `IncentiveHalo` when the offer is exclusive), the store name, and the offer line as TWO spans — the saving in `text-text-brand`, the threshold that qualifies it in `text-text-tertiary`. A percentage discount renders only the first.

Both halves are i18n keys with parameters. `DiscountSummary` carries `percentOff` XOR `amountOff` plus an optional `minimumSubtotal`; the money halves format through `formatMoney`/`PriceDisplay` from this same package — never a local copy, which `AGENTS.md` names explicitly.

- [ ] **Step 2: Export the nine components**

From `packages/ui/src/index.ts`, in the existing style. No barrel re-export from a second location — apps import from `@mercaria/ui`.

- [ ] **Step 3: The copy**

Every string this kit renders goes in `@mercaria/ui`'s OWN bundles under the reserved `ui` namespace, for the locales each app ships — **never the union**, or the dashboard gains an `ar` it cannot mirror. Read `packages/ui/src/i18n/` for the existing shape.

- [ ] **Step 4: Verify** — the five commands plus `validate:i18n-strings`.

- [ ] **Step 5: Commit** — subject: `feat(ui): the deals header, the exports, and this kit's own copy`.

---

## Plan self-review

**Spec coverage.** The spec's §Components names nine new components plus the `SectionHeader` change and the preset gaps: Task 1 the preset; Task 2 `ActionHeroCard`, `CategorySampleTile`, `CategoryImageTile`, `CategoryPill`; Task 3 `FeedGrid`, `SectionCard`, `SectionHeader`; Task 4 `StoreProductCard`, `DiscountBadge`; Task 5 `StoreOfferHeader`. Reused unchanged, per the spec: `MerchantCard` (already the reference's large merchant card, measured identical), `ProductCard`, `ProductCarousel`, `ProductShelf`, `Carousel`, `ReviewStars`, `RatingLine`, `IncentiveHalo`.

**Not in this plan, by design:** the section→component mapping, the three screens, the `/s/:signal` route, the nav item and the home trim. Those are Plan C, which depends on every export here.

**Type consistency.** `HeroCard`, `CategoryTile`, `StoreSummary`, `DiscountSummary` are all from `@mercaria/shared-types` and were landed by Plan A Task 1. `categoryPaletteColor` is defined in Task 2 and consumed only there.

**The honest gap.** No task in this plan proves a component RENDERS correctly, because this repository has no component-test infrastructure and deliberately so. Every task's verification is types plus the direction and copy gates. The first real check on appearance is Plan C, running the app against the live `GET /discovery/feed` — and a reviewer of this plan's tasks should judge the classes against the token appendix, which is a measurement of the reference, rather than against how the result looks in their head.
