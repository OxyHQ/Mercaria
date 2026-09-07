# Discovery feed — component tokens, read off the reference

Appendix to `2026-09-07-discovery-feed-design.md`. Every value here was read out
of the captured Shop markup, not estimated. It exists so the nine new components
can be written without going back to a 2.1 MB HTML dump, and so a reviewer can
check a class against a source rather than against taste.

## How to read the tables

**Reference** is the class as Shop ships it. **Here** is what to write in
`@mercaria/ui`, and it differs in exactly two situations:

1. **Direction.** `validate:rtl-classes` fails the build on `pl-`/`pr-`,
   `ml-`/`mr-`, `left-`/`right-`, `border-l`/`border-r`, `text-left`/`text-right`
   and the `rounded-l`/`rounded-r` corner variants. Physical becomes logical:
   `pl-` → `ps-`, `pr-` → `pe-`, `left-` → `start-`, `right-` → `end-`. The
   exceptions `AGENTS.md` records — `border-s-*` and `text-start` do not survive
   react-native-css/RN 0.85 — stay physical with a `KNOWN_EXCEPTIONS` entry.
2. **React Native has no equivalent.** `line-clamp-N`/`truncate` →
   `numberOfLines`; `object-cover` → expo-image `contentFit="cover"`;
   `hover:`/`group-hover:`/`backdrop-blur-*` → the `web:` prefix; `snap-x` →
   `ScrollView` `snapToInterval`; `srcset`/`sizes` → one sized URL.

A blank **Here** cell means the reference class is written verbatim.

## Preset gaps

These four groups are used below and are absent from
`packages/ui/src/theme/tailwind.preset.js`. They are the first change of Plan B,
because every component that follows needs them.

| Token | Value | Why this value |
| --- | --- | --- |
| `borderRadius.radius-24` | `24px` | The browse-category tile. The scale already has 8/12/16/20/28 and skips 24. |
| `fontSize.posterXS` + `fontWeight.posterXS` | `40px` / `44px` line / `700` | The category page's `h1` from `md` up. |
| `colors.bg-fill-tertiary` | `var(--muted)` | The tile-image placeholder behind a loading cover. |
| `colors.overlay-fixed-dark-04` | `rgba(0,0,0,0.04)` | The `SectionCard` chevron disc. |
| `colors.overlay-fixed-dark-10` | `rgba(0,0,0,0.10)` | The tile hover wash. |
| `colors.overlay-fixed-light-20` | `rgba(255,255,255,0.20)` | The hero card's arrow disc. |
| `colors.overlay-fixed-light-40` | `rgba(255,255,255,0.40)` | An inactive pagination dot. |
| `colors.overlay-fixed-light-75` | `rgba(255,255,255,0.75)` | The active pagination dot. |
| `boxShadow.s` / `.m` / `.l` | `0 1px 2px rgba(0,0,0,.06)` / `0 2px 8px rgba(0,0,0,.10)` / `0 8px 24px rgba(0,0,0,.14)` | Components reach for `web:shadow-md`/`lg` today; the reference names `shadow-s`/`shadow-m`. |

The `fixed` and `overlay` families are theme-independent constants by design —
that is already what those prefixes mean in the preset. Everything else points at
a Bloom variable.

## 1. `ActionHeroCard` — `feed-action-card-hero`

Explore §1; category §2 and §9.

| Part | Reference | Here |
| --- | --- | --- |
| root | `group relative w-full overflow-hidden rounded-radius-28 min-h-[140px]` | + `style={{ aspectRatio: 2.35 }}` |
| image | `absolute inset-0 size-full object-cover transition-transform group-hover:scale-105` | `web:transition-transform web:group-hover:scale-105`, `contentFit="cover"` |
| scrim | `absolute inset-0` with `background: linear-gradient(rgba(0,0,0,0) 0%, rgba(0,0,0,0.314) 85%)` | `expo-linear-gradient`, `colors={['transparent','rgba(0,0,0,0.314)']}`, `locations={[0, 0.85]}` |
| content row | `absolute inset-x-0 bottom-0 flex items-end justify-between p-space-20` | |
| text column | `flex min-w-0 flex-1 flex-col gap-space-4` | |
| title | `font-subtitle text-subtitle truncate text-text-fixed-light` | `numberOfLines={1}` |
| subtitle | `font-caption text-caption truncate text-text-fixed-light` | `numberOfLines={1}` |
| arrow disc | `flex size-space-32 shrink-0 items-center justify-center rounded-full bg-bg-overlay-fixed-light-20` | |
| arrow icon | 16×16, `text-text-fixed-light` | lucide `ArrowRight`, `size={16}` |

Carousel slot: `--carousel-items` 1.3 → 2 (sm) → 3 (md+); gap 8px, 16px from sm.

## 2. `CategorySampleTile` — `feed-action-card-tile-with-samples`

Explore §2, "Browse categories". Background colour is per-category and derived
from the id against a fixed palette — there is no colour column and no operator
surface to fill one.

| Part | Reference | Here |
| --- | --- | --- |
| root | `group relative overflow-hidden flex flex-col gap-space-16 rounded-radius-24 p-space-16` + inline `background-color` | colour from the palette helper |
| hover wash | `pointer-events-none absolute inset-0 bg-bg-overlay-fixed-dark-10 opacity-0 transition-opacity group-hover:opacity-100` | `web:` prefixes |
| label | `font-bodyTitleLarge text-bodyTitleLarge relative text-left text-text-inverse` | `text-left` stays physical — `KNOWN_EXCEPTIONS` |
| samples row | `relative flex flex-row gap-space-12` | |
| sample cell | `aspect-square flex-1 overflow-hidden rounded-radius-16 border-[0.5px] border-border-secondary` | |
| sample image | `size-full object-cover transition-transform group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100` | `web:` prefixes, `contentFit="cover"` |

Exactly two samples. Grid slot: `px-space-4 md:px-space-8 w-1/2 sm:w-1/3 md:w-1/4 lg:w-1/5`.

## 3. `CategoryImageTile` — `tile-image`

Category §4 and §7.

| Part | Reference | Here |
| --- | --- | --- |
| root | `relative flex flex-1 overflow-hidden h-[72px] rounded-radius-16 md:h-[84px] lg:h-[100px] xl:h-[112px]` | |
| group | `group relative flex flex-1` | |
| placeholder | `flex flex-1 bg-bg-fill-tertiary` | rendered when `imageUrl` is absent — it is an absent field, never `''` |
| image wrapper | `absolute inset-0 transition-transform group-hover:scale-105` | `web:` prefixes |
| image | `z-0 size-full object-cover` | `contentFit="cover"` |
| scrim | `absolute inset-0 bg-bg-overlay-fixed-dark-20` | |
| label box | `absolute inset-0 z-10 flex items-center justify-center p-space-8 text-center` | |
| label, small | `font-bodyTitleSmall text-bodyTitleSmall text-text-fixed-light text-center md:hidden` | |
| label, large | `font-bodyTitleLarge text-bodyTitleLarge text-text-fixed-light text-center hidden md:block` | `hidden md:flex` — see below |

The reference renders BOTH labels and hides one per breakpoint. Keep that — it is
how the type ramp changes without a JS media query.

**`md:block` becomes `md:flex`, and it is not a style choice.** React Native's
`display` accepts only `none` and `flex`; `block` is not a value it has, so
`md:block` resolves to nothing and the large label never reappears. The repo
already spells this pattern `md:flex` for the same reason — `CartLineItem.tsx:106`.
Measured and applied by the implementer of Plan B Task 2, not by the capture.

Grid slot: `px-space-4 md:px-space-8 w-1/2 md:w-1/3 lg:w-1/4`.

## 4. `CategoryPill` — `feed-action-card-pill`

Category §1.

| Part | Reference | Here |
| --- | --- | --- |
| root | `text-buttonMedium font-buttonMedium rounded-radius-max transition active:scale-[0.99] min-w-0 p-space-12 pb-space-4 pl-space-4 pt-space-4 relative` | `ps-space-4`, not `pl-space-4` |
| shadow | `rgba(255,255,255,0.2) 0 1px 0 0 inset, rgba(0,0,0,0.12) 0 0 1px 0, rgba(0,0,0,0.12) 0 4px 8px 0` | `style={{ boxShadow }}` — the same technique `IncentiveHalo` already uses |
| row | `flex flex-row items-center gap-space-8` | |
| image | `size-space-32 shrink-0 rounded-full border-[0.5px] border-border-image object-cover` | `contentFit="cover"` |
| label | `font-buttonMedium text-buttonMedium` | |

Carousel gap: 4px, 8px from sm — tighter than every other row.

## 5. `SectionCard` — `container-section-card`

Category §3. A bordered card wrapping a titled mini-shelf, two per row on wide
screens.

| Part | Reference | Here |
| --- | --- | --- |
| root | `flex flex-col rounded-radius-28 border-[0.5px] border-border-image p-space-24 pb-space-0 shadow-s hover:shadow-m` | `web:hover:shadow-m` |
| header link | `mb-space-16 flex items-center justify-between gap-space-16 md:mb-space-24` | |
| title | `font-headerBold text-headerBold text-text` | |
| header link | `mb-space-16 flex items-center justify-between gap-space-16 md:mb-space-24` | add `flex-row` — same RN default as `FeedGrid`'s row |
| chevron disc | `flex size-space-36 shrink-0 items-center justify-center rounded-radius-max bg-bg-overlay-fixed-dark-04` | `bg-overlay-fixed-dark-04` — ONE `bg-`, see below |
| chevron icon | not specified by the capture | `colors.foreground`, following `SectionHeader.tsx:54` — the same family, an icon over a theme surface. NOT `ActionHeroCard`'s fixed white, which is white because its disc sits over a photograph. |

**`bg-bg-overlay-*` is wrong everywhere and always was.** Under Tailwind v4 a
colour comes from a `--color-<name>` variable in `@theme`, and
`--color-overlay-fixed-dark-04` generates `.bg-overlay-fixed-dark-04` — one
`bg-`. The JS preset's key would generate the same single form. Nothing emits the
doubled class, so it renders no background at all.

The trap is the sibling family: `--color-bg-fill-secondary` DOES generate
`bg-bg-fill-secondary`, because there the `bg-` is part of the token's own name.
For `overlay-*` it is not. `ReviewSummaryCard.tsx`'s `bg-overlay-inverse-06` is
the one pre-existing correct use; **six components, all added on this branch**,
had the doubled form and rendered nothing.

`ProductCard.tsx` is NOT one of them, though a grep says otherwise: the string
`bg-bg-overlay-inverse-04` appears there only inside a COMMENT naming Shop's own
class, while the live class one line below is `bg-black/[0.04]` — which works and
is the same 4% wash. I claimed it was a seventh broken instance from a grep that
did not check whether the match sat inside a `className`, and the Task fixer
checked and pushed back rather than editing a component that was never wrong.

Found by the Task 3 reviewer, who compiled a synthetic stylesheet through the
repo's installed `@tailwindcss/postcss` rather than reasoning about it.

Grid slot: `px-space-4 md:px-space-8 w-full min-[1025px]:w-1/2`, row gap
`gap-y-space-40`. The nested shelf is 1.3 → 2 → 3 items.

## 6. `StoreProductCard` — `product-focused-merchant-card`

Explore §8–§15. The one genuinely new card: a square cross-fading product
carousel with pagination dots, over a store row.

| Part | Reference | Here |
| --- | --- | --- |
| root | `flex flex-col gap-space-8` | |
| image area | `relative aspect-square w-full overflow-hidden rounded-radius-20 shadow-s` | |
| slide | `carousel-slide absolute inset-0 transition-opacity` | active `z-10 opacity-100`; inactive `pointer-events-none opacity-0` |
| dots box | `absolute bottom-space-16 z-10 flex w-full transform-gpu justify-center` | |
| dots row | `flex gap-space-2` | |
| dot | `size-space-6 rounded-full transition-all` | active `bg-bg-overlay-fixed-light-75`; inactive `bg-bg-overlay-fixed-light-40` |
| inset border | `pointer-events-none absolute inset-0 border rounded-radius-20 border-border-image` | |
| store row | `flex items-start gap-space-8 px-space-4 lg:items-center` | |
| logo box | `relative flex items-center overflow-hidden w-space-32 h-space-32 rounded-radius-max` | |
| name, wide | `font-bodyTitleSmall text-bodyTitleSmall line-clamp-2 break-words max-lg:hidden` | `numberOfLines={2}` |
| name, narrow | `font-captionBold text-captionBold line-clamp-2 break-words lg:hidden` | `numberOfLines={2}` |
| rating | `font-bodyTitleSmall text-bodyTitleSmall flex items-center gap-space-2 text-text` | star icon after the number |

The inactive slides carry `inert` on web. On native they are simply not rendered
as pressable. The store row is a SIBLING link to the product links, never a
parent — the same no-nested-interactives rule `MerchantCard` already follows.

Grid slot: `px-space-4 md:px-space-8 w-1/2 sm:w-1/3 md:w-1/4 lg:w-1/6`.

## 7. `DiscountBadge` — `shop-cash-badge`

Over `StoreProductCard`'s image, and on the deals shelves.

| Part | Reference | Here |
| --- | --- | --- |
| position | `pointer-events-none absolute left-space-12 top-space-12 z-10 lg:left-space-16 lg:top-space-16` | `start-space-12`, `lg:start-space-16` |
| pill | `flex flex-row items-center justify-center gap-space-2 rounded-radius-max px-space-6 py-space-2 bg-bg-fill-brand` | |
| text | `font-badgeBold text-badgeBold text-text-fixed-light` | |

The reference also renders an `sr-only` full sentence beside the abbreviated
visible text ("Save €25 with your offer" / "Save €25"). **Keep the split; do not
keep the mechanism.**

`sr-only` is a CSS visually-hidden recipe — `position:absolute`, a 1px box,
`clip`, `white-space:nowrap`. React Native has neither `clip` nor `white-space`,
so on native the text is not hidden at all: the badge renders "Save €25" and
"Save €25 with your offer" stacked. It appears nowhere else in this repository,
and that absence is the tell — the mechanism here is `accessibilityLabel` on the
container, which `MerchantCard.tsx:108,155` shows and the whole package follows.

The split itself is right and is the reason this note exists: the visible string
is a fragment, and a screen reader needs the whole claim.

**Related, same component:** the reference marks inactive carousel slides
`inert`. Do not add it — but **not for the reason this note first gave.**

The mechanism here is that only the ACTIVE slide is ever wrapped in a
`Pressable`, so there is no always-mounted interactive element left to disable
on either platform. That is correct and is what ships.

What was wrong was the justification: this note claimed react-native-web's
forwarded-props whitelist excludes `inert`, so it never reaches the DOM. It does
not exclude it — `react-native-web@0.21.2`'s
`dist/modules/forwardedProps/index.js:58` carries `inert: true`, and the
re-reviewer of Plan B disproved the claim empirically rather than reading it.
`inert` would reach the DOM on web perfectly well; it is simply unnecessary here.

Recorded rather than quietly edited, because a false technical justification is
the kind of thing that gets cited as fact later — and this one had already been
repeated from an implementer's report into this document before anyone checked.

## 8. `StoreOfferHeader` — the deals section header

One per store on `/deals`.

| Part | Reference | Here |
| --- | --- | --- |
| container | `flex w-full` | |
| link | `flex w-full flex-1` | |
| halo wrapper | `-my-space-4 overflow-hidden rounded-radius-max p-space-2` | wraps the existing `IncentiveHalo`; rendered only when the discount is exclusive |
| logo | `w-[44px] h-[44px]` inside `rounded-radius-max` with a hairline border | 44px here, against 32px on `StoreProductCard` |
| title | `font-subtitle text-subtitle text-text md:text-sectionTitle` | |
| offer amount | `font-bodySmall text-bodySmall whitespace-nowrap text-text-brand` | |
| offer condition | `font-bodySmall text-bodySmall whitespace-nowrap text-text-tertiary` | |

Two spans, two colours, one line: the saving is brand-coloured, the threshold
that qualifies it is tertiary. A percentage discount renders only the first.

## 9. `FeedGrid` — `ListSection`

Everything in `@mercaria/ui` today is a carousel; this is the wrapping grid.

| Part | Reference | Here |
| --- | --- | --- |
| items | `flex flex-wrap -mx-space-4 md:-mx-space-8 gap-y-space-8 md:gap-y-space-16` | add `flex-row` — see below |
| items, card-group variant | same, with `gap-y-space-40` | add `flex-row` |

**`flex-row` is not in the reference and must be added, and this is the quietest
of the RN divergences.** CSS defaults `flex-direction` to `row`, so the capture
never needs to say it. React Native defaults it to `column`. Copied verbatim,
`flex flex-wrap` stacks every card vertically — a layout that is wrong in a way
that typechecks, passes every gate, and is only visible when somebody opens the
page. Every sibling flex-wrap row already in this repository spells `flex-row`.
Measured and applied by the implementer of Plan B Task 3.

The negative horizontal margin cancels each slot's own `px-space-4`, so the row's
outer edge aligns with the page gutter. Slot widths are the per-component values
in the tables above — the grid takes them as a prop rather than knowing its
children.

## 10. `SectionHeader` — the existing component changes

The trailing chevron currently renders as `h-8 w-8 rounded-full border
border-border`. The reference is a FILLED disc with no border:

```
flex aspect-square items-center justify-center overflow-hidden
rounded-radius-max bg-bg-fill-secondary
```

with a 20px chevron. `MerchantCarousel`, `ProductShelf` and every other current
consumer inherits the change, which is intended — they are the same shelf header.
