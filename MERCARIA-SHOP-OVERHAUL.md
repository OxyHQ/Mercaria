# Mercaria — Shop.app‑style UI overhaul: full context & rationale

This document explains **everything** that was done to bring Mercaria's home/marketplace
UI to a Shop.app‑style layout, **why** each decision was made, the dead‑ends we hit, and
the RN‑web/NativeWind gotchas behind them. It's written so anyone (or any agent) picking
this up later has the complete picture.

> Mercaria = Oxy's buy/sell marketplace (eBay/Wallapop‑style: new items from shops +
> secondhand from people). Expo SDK 56 (RN 0.85.3), NativeWind 5 (Tailwind v4), Bloom
> theme, expo‑router, TanStack Query, Oxy SDK. Monorepo `packages/{frontend,backend,shared-types}`.

---

## 0. Session context (how we got here)

Before the UI work, this app went through, in order:

1. **Rename Marketplace → Mercaria** and go live: domain **mercaria.co** (web, CF Pages)
   + **api.mercaria.co** (backend, AWS ECS Fargate). OIDC deploy, terraform in
   `oxy-infra/terraform-uswest2`, secrets, CF DNS, registered Oxy SSO `clientId`.
   (Allo also moved to **allo.you** in the same period — additive, `allo.oxy.so` preserved.)
2. **Branding:** new app icon (IconKitchen output), **blue** default Bloom theme (not
   yellow), brand storefront logo (SVG) in sidebar + splash.
3. **`packages/` structure** standardized to match Mention (`frontend`/`backend`/`shared-types`).

The rest of this doc is the **Shop.app‑style home UI** built on top of that.

---

## 1. Goal

Rebuild Mercaria's home to look and behave like **shop.app**:

- Left **icon nav rail** (~76px) + hero wordmark + big search bar + a **rounded floating
  content panel** + footer.
- Feed = category **pill chips**, **category 2×2** cards, **merchant** hero cards
  ("Worth the hype"), **product** shelves ("New arrivals", "On sale").
- **Real data path**: the frontend reads from the backend `/feed` (mock data is fine, but
  it must go through the API — no hardcoded frontend arrays).
- **Always Bloom theming** via NativeWind tokens (`bg-background`, `bg-card`,
  `text-foreground`, `border-border`, `bg-primary`, …). No hardcoded hex.
- **Pure Tailwind/NativeWind** — no custom JS for scroll or width (this became the
  central constraint; see §6).

Reference: shop.app's live DOM (captured and mapped node‑for‑node in
`/tmp/mercaria-shop-shell.md`).

---

## 2. Backend mock feed (real data path)

- `packages/backend/src/lib/mock-products.ts` + a **public** `GET /feed` endpoint (no auth)
  returns a discriminated `Feed.sections[]`: `{ kind: 'products' | 'merchants' | 'categories' | 'category-pills', … }`.
- Frontend `useFeed()` (TanStack Query) → `app/(app)/index.tsx` maps the sections.
- Shared DTOs in `packages/shared-types` (`ProductSummary`, `MerchantSummary`,
  `ProductThumbnail`, `Category`, `CategoryTile`, `Money`, `Shelf`, `Feed`).

### Why the images kept showing blank — and the fix
The first mock used **picsum.photos**. On this machine picsum **times out** (`curl`:
"Operation timed out after 10002ms"), so merchant thumbnails and category tiles rendered
empty even though the data was present. We swapped the **entire** mock to **real Shopify
CDN URLs** (`cdn.shopify.com` / `shopify-assets.shopifycdn.com`) — 5 real merchants
(Paloma Wool, Nili Lotan, JW PEI, Telfar, AG Jeans) each with cover + white wordmark logo
+ 3 real product thumbnails, 7 categories × 4 real tile images, real pill images, real
product‑shelf images. Catalog of URLs: `/tmp/mercaria-real-mock.md`.

**Lesson:** an "empty card" is often a dead image URL, not a data/mapping bug. Verify the
URL actually resolves (curl it) before touching the component.

---

## 3. Components (all Bloom‑themed, NativeWind)

Under `packages/frontend/components/marketplace/` and `components/shell/`:

- **ProductCard** — image (`aspect-square rounded-2xl`), favorite heart overlay, brand,
  title, `ReviewStars` + count, price (+ strikethrough compare price + sale badge).
  Bug fixed: it was a `<button>` nested in a `<button>` on web (outer Pressable +
  inner favorite Pressable). Fix: outer is a `View`; the image link, the text link, and
  the favorite button are **sibling** interactive zones — never nested.
- **Carousel** (generic) — horizontal scroller shared by product/merchant/category rows,
  with web edge arrows. See §6 for the width refactor.
- **MerchantCard** ("Worth the hype") — cover image (bleed) + dark tint + centered white
  wordmark + name + star rating + a row of 3 product thumbnails.
- **CategoryCard** — `w-[330px]` square, inner `grid grid-cols-2 grid-rows-2` of 4 tiles,
  each tile image + label bottom‑left.
- **Category pills** — horizontal **chip** row: each chip `h-11 rounded-full border
  border-border bg-card` with a **32px round image** on the left + category name on the
  right. (Earlier wrong version rendered bare small circles — the user flagged it.)
- **NavRail** (`components/shell/NavRail.tsx`) — desktop icon rail (Home/Explore/Cart/
  Deals/Saved + auth avatar/sign‑in at bottom), web hover **tooltips**.
- **BottomTabBar** — mobile bottom bar (same nav items).
- **HeroSearch** — centered wordmark + large rounded search bar + `bg-primary` submit.
- **Footer** — logo + links + copyright.

---

## 4. The rounded floating panel + the "content bleeds out" problem

Shop's content sits in a **rounded panel** that floats on a gutter, and the content must
stay **inside** the rounded shape (it must not poke out past the rounded corners /
top / bottom while scrolling).

### How Shop actually does it (from its live DOM)
- A `content-wrapper-root` with `lg:p-space-8 lg:pl-0` (8px gutter, none on the left).
- A **sticky overlay frame** as the *first child*:
  ```
  pointer-events-none sticky left-0 top-space-8 z-30 mb-[calc(-100dvh+16px)]
  h-[calc(100dvh-16px)] w-full rounded-radius-28 border border-[#EBEBEB]
  style: box-shadow: 0 2px 8px rgba(0,0,0,.06), 0 -1px 30px #F2F4F5, 0 0 0 40px #FCFCFC;
         clip-path: inset(-12px);
  ```
- The actual content (`min-h-full w-full bg-bg-fill overflow-x-clip`) flows under it.

**The key trick:** the frame is *just a border*, but its box‑shadow has a **3rd layer
`0 0 0 40px #FCFCFC`** — a 40px ring of the **gutter color** that *paints over* anything
bleeding outside the rounded rectangle (the 8px gutter + the rounded corners). `clip-path:
inset(-12px)` contains that shadow to ~12px beyond the frame so it doesn't cover the rail.
`mb-[calc(-100dvh+16px)]` makes the frame take ~0 layout height (pure overlay).

### Why it looked broken in Mercaria (and why Shop "gets away with it")
Shop is **light‑on‑light** (gutter `#FCFCFC` ≈ white panel), so even though content *does*
bleed into the thin gutter, **you can't see it**. Mercaria's default theme is **dark**, so
bright product images bleeding into the dark gutter at the top/bottom were glaringly
visible. Same structure, opposite contrast → the bleed shows. So we had to make the mask
**actually render** (Shop technically relies on it too; it's just invisible there).

### Why the mask wasn't rendering in RN‑web (the real bug)
The frame existed and was sticky, but its **computed `box-shadow` was fully transparent**
and **`clip-path` was `none`**. Two RN‑web facts caused this:
1. A NativeWind `shadow-*` utility (or an empty gutter color) produced a transparent
   shadow.
2. **`clipPath` is not a valid React Native style key** → RN‑web silently drops it from a
   `<View style={…}>`.

**Fix (verified by hand in the browser first):** on the web sticky frame, apply
- `box-shadow: 0 0 0 40px <gutter>` where `<gutter> = useTheme().colors.background`
  (a Bloom token, e.g. `rgb(6,14,19)` in dark) — via a NativeWind arbitrary web shadow
  class `web:shadow-[0px_0px_0px_40px_var(--background)]` **or** an inline web `style`
  with the resolved color; the computed value must **not** be transparent.
- `clip-path: inset(-12px)` via a NativeWind **arbitrary property class**
  `web:[clip-path:inset(-12px)]` (NOT in the RN `style` object — it's dropped).
- `z-30` so the frame paints **above** the content.

With those three applied, the content stays cleanly inside the rounded panel mid‑scroll,
corners rounded, no vertical bleed. **Verified live.**

---

## 5. Document scroll (scroll from anywhere) — the hardest part

The user's requirement: scroll must work from **anywhere** (over the rail, the gutter,
everywhere) and the rail + rounded frame stay put — exactly like Shop. Shop achieves this
with **document/body scroll** + `position: sticky` rail + the sticky overlay frame. **Pure
Tailwind, no JS.**

### Why this is hard in Expo/RN‑web
Expo Router web is **not** a plain React/Tailwind app. It ships the **react‑native‑web
recommended style reset**, which pins:
```
html, body { height: 100%; overflow: hidden; }
#root      { height: 100%; display: flex; }
```
That lock makes the document non‑scrollable, so RN apps scroll via an **inner ScrollView**
instead. Shop (plain React) has no such lock.

### Dead‑ends we (correctly) abandoned
- A `useDocumentScroll.web.ts` **hook** that mutated `document.body.style` at runtime —
  the user rejected this as a "tricky thing" / "custom code raro". Deleted.
- A `height:auto` override **without** `min-height`/`!important` — collapsed the flex root
  to 0 and **blanked the page**. Reverted.
- Removing only Expo Router's `<ScrollViewStyleReset/>` component from `+html.tsx` — **not
  enough**, because Expo **auto‑injects the RNW reset** into the served HTML independently
  of that component. (Confirmed by `curl`‑ing the served HTML: it still contained
  `<!-- react-native-web recommended style reset -->` with `overflow:hidden; height:100%`.)

### The correct, pure‑CSS fix (verified in the browser)
Override the framework‑injected reset in **`global.css`** with `!important` (plain CSS, no
JS, no hack):
```css
html, body {
  height: auto !important;
  min-height: 100%;
  overflow-x: hidden !important;
  overflow-y: visible !important;
}
#root {
  height: auto !important;
  min-height: 100vh;     /* prevents the flex root collapsing to 0 (the blank-page trap) */
  overflow: visible !important;
}
```
Applying exactly this made `document.scrollingElement` scroll (`docScroll` 0 → 1197),
content fully visible (sticky rail, rounded panel, mask, merchants all render), footer
reachable — **no inner scroller, no JS**. `+html.tsx` keeps `<ScrollViewStyleReset/>`
omitted; native is untouched (it still uses a normal ScrollView + bottom bar).

> Dev‑server caveat: `+html.tsx` is statically rendered, so the served document is cached
> until a dev‑server restart. The `global.css` override is the production‑correct fix and
> hot‑applies without needing the static doc to regenerate.

---

## 6. "Everything must use NativeWind correctly — no width/layout by JS"

The user was firm: **no JS for sizing or layout decisions**; use NativeWind responsive
classes like Shop. Two JS offenders were removed:

1. **Card width by JS → fixed Tailwind widths.** `Carousel.tsx` was measuring its own
   width (`useWindowDimensions()` + `onLayout` → `measuredWidth` state) and computing each
   card's width (`computeItemWidth`), set via `style={{ width }}`. Shop just uses fixed
   responsive classes. Fix: deleted `useWindowDimensions`, `measuredWidth`, the
   `itemWidth` function form and `computeItemWidth`; each slot is sized by a fixed
   `slotClassName` — **products/merchants `w-[154px] md:w-[192px]`**, **categories
   `w-[330px]`**, gap via `mr-3`. (Web arrow scroll distance may still read the scroller's
   own width from a ref *at press time* — that's scroll mechanics, not card sizing.)
   The only remaining `style={{width}}` are intrinsic primitive sizes (star icon size,
   merchant thumbnail square) — not layout sizing.

2. **Rail↔bottom‑bar switch by JS → NativeWind breakpoints.** `app/(app)/_layout.tsx`
   used `useWindowDimensions()` → `useRail = width >= 768` to choose desktop vs mobile.
   Fix: removed it; one responsive web tree toggled purely with `md:` (rail `hidden
   md:flex`, bottom‑bar `md:hidden`, shell `md:grid md:grid-cols-[4.75rem_1fr]`). The home
   rounded panel + mask are CSS‑gated (`max-md:hidden`, `md:rounded-3xl`). The **only**
   allowed `Platform.OS` use is `<Slot/>` (web) vs `<Stack/>` (native) — platform, not
   width.

### Why `<Slot/>` on web (not `<Stack/>`)
expo‑router's `<Stack>` wraps each screen in an **absolutely‑positioned animated scene
container** that clamps the screen to viewport height — which breaks document flow +
`position: sticky`. `<Slot/>` renders the matched route directly with no scene wrapper, so
the feed flows in the document and the sticky shell works. Native keeps `<Stack>` for real
push/pop transitions. (This is a platform branch, not a width calc — allowed.)

---

## 7. Other fixes

- **Double border** — the nav rail had its own right border AND the panel had a border.
  Shop's desktop rail is **transparent, no border/bg** (border+bg are mobile‑only). Fixed:
  single border lives only on the content panel.
- **NavRail tooltips clipped/painting under content** — not an overflow clip; RN‑web's
  transformed horizontal carousels create stacking contexts that beat any z‑index. Fix: a
  web‑only `RailTooltip` **portals to `document.body`** (`react-dom` `createPortal`),
  `position: fixed` from the item's `getBoundingClientRect()` (captured in `onHoverIn`, no
  `useEffect`), top z‑index, `pointer-events: none`. As a direct child of `<body>` it
  escapes every content stacking context. Native renders nothing.
- **Mobile bottom bar floated instead of staying pinned** — it was in normal flow after
  the content, so with document scroll it ended up at the end of the document. Fix: on web
  it's `fixed bottom-0 left-0 right-0 z-[60]` with `max-md:pb-[64px]` on the content so the
  last row isn't covered. Native keeps it in flex flow.
- **Gutter/panel contrast** — in dark, gutter (`background`) and panel (`card`) are close;
  gutter set one step darker than the panel + the frame shadow so the panel reads as
  floating. (Bloom tokens only; the dark palette is near the limit of separation without
  inventing hex — a heavier shadow or a Bloom dark‑preset token tweak are the clean knobs.)

---

## 8. Public (anonymous) browsing — fixed UPSTREAM in the SDK

A marketplace must be browsable signed‑out (sign‑in only to buy/sell). But the Oxy SDK's
terminal cold‑boot step `sso-bounce` unconditionally redirected anonymous web visitors to
`auth.<apex>/sso` (on localhost → 400, hijacking the home). There was **no opt‑out prop**.

Per project rules (fix shared behavior in the SDK, never patch the app), we traced it with
evidence (Mention only *tolerates* one bounce; no existing opt‑out anywhere) and added an
**additive, default‑false `disableAutoSso` prop** to `@oxyhq/services`' `OxyProvider`
(threads into `runColdBoot`, skips **only** the terminal bounce; callback‑consume / FedCM
/ stored‑session restore still run, so a returning user is silently restored).

- Published: **`@oxyhq/services@10.4.0`** (core unchanged 3.7.1). Later migrated to device-first `@oxyhq/services@19` (zero-cookie; legacy web auth package removed).
- Mercaria: bumped `@oxyhq/services ^10.4.0` and passed `disableAutoSso` in
  `app/_layout.tsx`. Superseded by the device-first cutover (no SSO bounce).

---

## 9. Meta‑lessons (RN‑web vs plain‑React Tailwind)

- **A static build looks correct while the runtime is wrong.** The bleed, the scroll lock,
  and the transparent shadow all passed tsc/build but were wrong at runtime. Always verify
  in a **real browser** (computed styles, `document.scrollingElement`, screenshots), not
  just the dist output.
- **RN‑web silently drops non‑RN style keys** (e.g. `clipPath`). Use NativeWind arbitrary
  classes (`web:[clip-path:…]`) for web‑only CSS that RN doesn't model.
- **Expo injects the RNW reset** regardless of `+html.tsx`. To get document scroll you
  override it in `global.css` with `!important` — `min-height:100vh` on `#root` is required
  to avoid the flex‑collapse blank page.
- **"Empty card" ≈ dead image URL**, not a data bug (picsum timeout incident).
- **Stacking contexts from transformed carousels** can't be beaten by z‑index; portal to
  `<body>` for overlays (tooltips).
- **Light‑on‑light hides a multitude of sins.** A technique that looks clean on Shop
  (content bleeding under a border) needs a real mask on a dark theme.

---

## 10. Status

**Done & browser‑verified:** components + real Shopify images; rounded panel + bleed mask
(`box-shadow 40px gutter` + `clip-path inset(-12px)` + `z-30`); sticky transparent rail
(single border); chip pills; fixed‑width cards (no JS); responsive rail↔bottom‑bar via
`md:`; fixed mobile bottom bar; portal tooltips; public browse via `disableAutoSso`
(SDK 10.4.0 published).

**Final pending item:** the `global.css` `!important` override for the Expo‑injected RNW
reset (so document scroll works on the served app, not just via hand‑applied CSS) — fix
identified and verified in‑browser, being applied.

**Not pushed.** Everything is in the working tree pending the user's visual sign‑off; SDK
packages were published as the upstream fix. Device-first migration (`@oxyhq/services@19`,
`@oxyhq/core@9`, legacy web auth package removed) completed separately.

**Reference files:** `/tmp/mercaria-shop-shell.md` (Shop shell mapped to NativeWind),
`/tmp/mercaria-real-mock.md` (real Shopify image catalog).
</content>
