# Discovery Feed — Screens Implementation Plan (Plan C of 3)

> **EXECUTED — merged in #1004 (`main`, 2026-09-07).** The unticked boxes below
> are the plan as it was written, not work outstanding; read the merged code and
> `docs/discovery.md` for what actually shipped.
>
> **One step never ran: Task 5 Step 4**, the comparison against the three
> captured references in `~/Downloads/`. It is the only appearance check in
> all three plans, so nothing else covers it and no gate can.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `GET /discovery/feed` into the three storefront screens the user asked for — explore, a category landing, and deals — plus the paginated signal route their headings link to.

**Architecture:** One renderer maps `DiscoverySection` to the Plan B components; four screens choose a scope and render it. No screen knows a section kind; no renderer knows a scope. The existing SEO surface (`useCatalogSeo`, `CatalogBreadcrumbs`, the JSON-LD) is preserved rather than replaced.

**Tech Stack:** Expo Router with `typedRoutes` armed, React Query, NativeWind, `@mercaria/ui`.

**Spec:** `docs/superpowers/specs/2026-09-07-discovery-feed-design.md`
**Token appendix:** `docs/superpowers/specs/2026-09-07-discovery-feed-component-tokens.md`

**Depends on:** Plan A (complete — the API serves all three scopes) and **Plan B (the nine components). Do not start this plan until Plan B's exports exist.**

---

## Global Constraints

### `typedRoutes` is armed, and it checks one form completely and the other barely

`generate-router-types.mjs` runs inside each app's `typecheck`, and `typed-routes-armed.test.ts` fails the build if it stops. It checks the OBJECT form COMPLETELY — a wrong `{ pathname }` is TS2820.

A TEMPLATE LITERAL is checked **only when no dynamic route sits above the mistyped segment**. `` `/products/wizrd/${id}` `` exits 0, absorbed by `/products/[id]` (#456). That is exactly the shape this plan is full of.

**Every dynamic destination in this plan is spelled in the object form:**

```ts
router.push({ pathname: '/categories/[handle]/s/[signal]', params: { handle, signal } })
```

`bun run validate:route-targets` resolves each against the real route tree and is the wall #330 retired.

### Direction, copy, and the gates

- `bun run validate:rtl-classes` gates all four client packages. Logical utilities only: `ps-`, `pe-`, `start-`, `end-`, `ms-`, `me-`, `rounded-s-`. `border-s-*` and `text-start` stay physical with a `KNOWN_EXCEPTIONS` entry — that is measured, not preference.
- `bun run validate:i18n-strings` gates hardcoded strings, key parity across the 12 locales, and unreferenced keys, in all three apps.
- **Shelf titles are resolved on the CLIENT.** The server sends a `signal` and a `categoryHandle`, never a sentence — `discovery.shelf.topRated` → `"Lo mejor valorado en %{category}"`. A sentence assembled server-side cannot be translated, and Plan A's feed service has a test pinning that no section carries a composed title.
- App copy lives in the app's own bundles; `@mercaria/ui`'s copy lives in ITS bundles under the reserved `ui` namespace, for the locales that app SHIPS — never the union, or the dashboard gains an `ar` it cannot mirror.

### Everything else

- `bun`/`bunx` only. Avoid `useEffect` — derived state, event handlers, `useMemo`, React Query.
- **React Compiler is on.** Never read external mutable state in a memoized position.
- CI typechecks all three Expo apps and **a build is not a substitute**: Babel strips types, so `expo export` bundles code `tsc` rejects.
- An absent image is an absent optional field, never `''`.
- NEVER: `as any`, `@ts-ignore`, `@ts-expect-error`, `any` params/returns, `!` assertions, `console.log`, `var`, `catch {}`, TODO/FIXME/HACK, inline RN styles where NativeWind exists, hardcoded URLs or magic numbers.
- Commit trailers: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_0121G2nyf5Q1DD7TKx3q2fb8`.

### What "verified" means here

The frontend's runner is scoped to `lib/**` with a node environment and no jsdom, so **the data layer is testable and the screens are not**. Tasks 1 and 5 have real tests; Tasks 2–4 are verified by typecheck, the route and direction gates, and by running the app. Do not add a component runner to close that gap — `client-test-runners.test.ts` fails the build for a package whose test script no CI step names, and Plan A already had to revert one.

---

## File Structure

**`packages/frontend/lib/`**
- Create `api/discovery.ts` — one fetcher per scope, unwrapping the envelope, mirroring `api/feed.ts`.
- Create `hooks/use-discovery-feed.ts` — the React Query hook.
- Modify `hooks/query-keys.ts` — the `discovery` key namespace.
- Create `discovery/section-title.ts` — `signal` + category name → i18n key and params. Its own file because it is pure logic in a `lib/` tree that HAS a runner, which is what makes it the one piece of screen behaviour this plan can actually test.

**`packages/frontend/components/discovery/`**
- Create `DiscoveryFeed.tsx` — the renderer: `DiscoverySection[]` in, Plan B components out. The only file that knows the eight section kinds.
- Create `SignalGrid.tsx` — the paginated grid for the signal route.

**`packages/frontend/app/(app)/`**
- Modify `categories/index.tsx` (explore), `index.tsx` (the home trim).
- **Move `categories/[handle].tsx` → `categories/[handle]/index.tsx`** — see the note below; this must happen before the signal route can exist.
- Create `categories/[handle]/s/[signal].tsx`, `deals.tsx`.

#### A move this plan requires, and why it comes first

`categories/[handle].tsx` is a FILE today. The signal route needs
`categories/[handle]/s/[signal].tsx`, which requires `[handle]` to be a
DIRECTORY, and a file and a directory cannot share that segment name.

So Task 4 begins by moving the landing page to `categories/[handle]/index.tsx`.
Use `git mv` so the history follows the file, and make it its own commit before
any content change — a move mixed with an edit is a diff nobody can review.

The route it serves is unchanged (`/categories/:handle` either way), so
`PublicRouteId`'s `category_browse` registration, every `router.push` targeting
it, and `validate:route-targets` all keep working. **Verify that rather than
assuming it:** run `bun run validate:route-targets` and the frontend typecheck
immediately after the move and before writing anything new. If the move alone
breaks a target, you want to know that while the diff is one rename.

**Modified:** `components/shell/nav-items.ts`, the app's `lib/i18n/locales/*.json` (12 files).

---

### Task 1: The data layer

The only part of this plan with a real test cycle. Do it first so the screens have something honest to consume.

**Files:** Create `lib/api/discovery.ts`, `lib/hooks/use-discovery-feed.ts`, `lib/discovery/section-title.ts`; modify `lib/hooks/query-keys.ts`; test `lib/discovery/__tests__/section-title.test.ts`.

**Interfaces produced:**
```ts
fetchDiscoveryFeed(scope: DiscoveryScope): Promise<DiscoveryFeed>
useDiscoveryFeed(scope: DiscoveryScope): UseQueryResult<DiscoveryFeed>
sectionTitleKey(signal: DiscoverySignal): string
sectionTitleParams(categoryName: string): { category: string }
```

- [ ] **Step 1: Write the failing test for `section-title.ts`**

This is the piece worth testing: the server sends a signal, the client owns the sentence, and a missing case must fail loudly rather than render a key.

```ts
import { describe, expect, it } from 'vitest';
import { DISCOVERY_SIGNALS } from '@mercaria/shared-types';
import { sectionTitleKey } from '../section-title';

describe('sectionTitleKey', () => {
  it('maps every signal in the closed set to a key', () => {
    // The set is closed and rendered into a database CHECK. A signal with no
    // key would render as raw `discovery.shelf.undefined` on a live shelf.
    for (const signal of DISCOVERY_SIGNALS) {
      expect(sectionTitleKey(signal)).toMatch(/^discovery\.shelf\./);
    }
  });

  it('gives each signal a DISTINCT key', () => {
    // Two signals sharing a key is how "Top rated" ends up over the
    // best-selling shelf — visible only to someone reading both at once.
    const keys = DISCOVERY_SIGNALS.map(sectionTitleKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/frontend test -- section-title
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the three modules**

`api/discovery.ts` mirrors `api/feed.ts` exactly: typed against the shared contract, unwrapping `ApiResponse`, throwing on `!success`. It serializes the scope into the query string the route parses — `root`, `category:<handle>`, `deals`.

`use-discovery-feed.ts` mirrors `use-feed.ts`: public, no auth gate, a stale time, `retry: 2`. Key it per scope so the three screens do not share a cache entry.

`section-title.ts` maps each `DiscoverySignal` to its key. Use a `Record<DiscoverySignal, string>` rather than a `switch` with a default — the exhaustiveness is then the compiler's job, and adding a sixth signal fails to compile instead of silently rendering a key.

- [ ] **Step 4: Pass, then verify the whole layer**

```bash
bun run --cwd packages/frontend test -- section-title
bun run --filter @mercaria/frontend typecheck
```

- [ ] **Step 5: Commit** — subject: `feat(storefront): the discovery feed's data layer and its title mapping`.

---

### Task 2: The renderer

**Files:** Create `components/discovery/DiscoveryFeed.tsx`.

**Interfaces produced:** `DiscoveryFeed({ sections, onPress... }: { sections: DiscoverySection[]; ... })`

- [ ] **Step 1: Map the eight kinds**

| kind | renders |
| --- | --- |
| `hero` | `Carousel` of `ActionHeroCard` |
| `category-tiles` | `FeedGrid` of `CategorySampleTile`, slot `w-1/2 sm:w-1/3 md:w-1/4 lg:w-1/5` |
| `category-images` | `FeedGrid` of `CategoryImageTile`, slot `w-1/2 md:w-1/3 lg:w-1/4` |
| `pills` | `Carousel` of `CategoryPill`, gap 4px / 8px from sm |
| `products` | `SectionHeader` + `ProductCarousel` |
| `stores` | `variant: 'large'` → `Carousel` of `MerchantCard`; `'compact'` → `FeedGrid` of `StoreProductCard`, slot `w-1/2 sm:w-1/3 md:w-1/4 lg:w-1/6` |
| `store-offer` | `StoreOfferHeader` + `ProductCarousel` |
| `card-group` | `FeedGrid` of `SectionCard`, slot `w-full min-[1025px]:w-1/2`, row gap `gap-y-space-40`, each wrapping a nested `products` shelf |

Switch on `kind` with no `default` branch, so a ninth kind fails to compile rather than rendering nothing.

- [ ] **Step 2: Titles and destinations**

A section's heading comes from `sectionTitleKey(section.signal)` with the category name — never from a `title` the server sent, which Plan A's tests prove it does not send for signal sections.

Every heading and hero card navigates in the OBJECT form:

```ts
router.push({ pathname: '/categories/[handle]/s/[signal]', params: { handle, signal } })
```

- [ ] **Step 3: Verify**

```bash
bun run --filter @mercaria/frontend typecheck
bun run validate:route-targets
bun run validate:rtl-classes
```

- [ ] **Step 4: Commit** — subject: `feat(storefront): one renderer for the discovery feed's eight section kinds`.

---

### Task 3: Explore and the category landing

**Files:** Modify `app/(app)/categories/index.tsx` and the category landing (`categories/[handle].tsx` until Task 4 moves it to `categories/[handle]/index.tsx` — if you are running Tasks 3 and 4 out of order, do that move first).

- [ ] **Step 1: `/categories` — keep the SEO, change the body**

Read the file's existing docblock first: it explains why this route earns a `PublicRouteId` of its own and why it renders the PUBLISHED navigation rather than a second taxonomy.

Keep `Head`, the canonical URL, the `hreflang` alternates, the JSON-LD, the breadcrumbs and the `category_index` registration. Replace the body — the `NavigationMenu` text trees — with `<DiscoveryFeed sections={...} />` at `scope: 'root'`.

**The SEO position is unchanged and your report should say so plainly:** this page's value to a crawler is that it is a page of links to category pages, and after the redesign it still is — the tiles and section headers ARE those links. The markup changes; the link graph does not.

- [ ] **Step 2: `/categories/[handle]` — add the header, keep the grid's job**

Add the reference's `text-feed-header`: an `h1` at `text-header md:text-posterXS` plus breadcrumbs, both of which `CatalogBreadcrumbs` and `useCatalogSeo` already provide. Below it, the feed at `scope: category:<handle>`.

The existing `CategoryListingCard` grid becomes one `products` section rather than the whole page. **The facet rail stays absent** — `lib/catalog/facet-consumption.ts` gates it on the grid's own query type being able to act on a selection (#637), and nothing here changes that.

- [ ] **Step 3: Verify** — typecheck, `validate:route-targets`, `validate:rtl-classes`, `validate:i18n-strings`.

- [ ] **Step 4: Commit** — subject: `feat(storefront): explore and the category landing render the discovery feed`.

---

### Task 4: The signal route and `/deals`

**Files:** Create `app/(app)/categories/[handle]/s/[signal].tsx`, `app/(app)/deals.tsx`, `components/discovery/SignalGrid.tsx`; modify `components/shell/nav-items.ts`.

- [ ] **Step 0: Move the landing page, as its own commit**

```bash
mkdir -p "packages/frontend/app/(app)/categories/[handle]"
git mv "packages/frontend/app/(app)/categories/[handle].tsx" "packages/frontend/app/(app)/categories/[handle]/index.tsx"
bun run --filter @mercaria/frontend typecheck
bun run validate:route-targets
```

Both must exit 0 before you write a line of the signal route. `/categories/:handle` is the same address either way, so nothing that targets it should move — this step exists to prove that while the diff is still one rename.

Commit it alone: `refactor(storefront): make the category landing a directory so it can hold children`.

- [ ] **Step 1: The signal route**

One signal, one scope, paginated. Validate `signal` against `DISCOVERY_SIGNALS` and render a not-found for anything else rather than defaulting — the same reasoning the API's 400 has.

**Report the page depth honestly.** `best-selling` and `most-viewed` page only as deep as the sweep counted (`pageDepth: 'capped'`); `top-rated`, `new` and `on-sale` are `'complete'`. The screen must not offer a "next" that walks past the end of the data. Say which it is in the UI rather than letting the shopper discover it.

- [ ] **Step 2: `/deals`**

`scope: 'deals'` — one `store-offer` section per store. Then in `nav-items.ts`, the `deals` item moves from `available: false` to:

```ts
{ key: "deals", labelKey: "nav.deals", icon: Tag, href: "/deals", available: true },
```

That is precisely the shape `NavItem` asks for — the union has no `href` on the unavailable branch, so the compiler requests it once you flip the flag.

- [ ] **Step 3: Verify** — typecheck all three apps, `validate:route-targets` (this task adds two routes, so it is the one that matters most here), `validate:rtl-classes`, `validate:i18n-strings`.

- [ ] **Step 4: Commit** — subject: `feat(storefront): the signal route and the deals page`.

---

### Task 5: The home trim and the copy

**Files:** Modify `app/(app)/index.tsx`; modify `packages/frontend/lib/i18n/locales/*.json` (12 files).

- [ ] **Step 1: Trim the home**

The spec's §"What the home becomes": `/` stays a feed but a PERSONAL one — cart, saved, the shopper's own categories, what is new since they last came. Discovery is the explore page's job now, so the home's sections that duplicate it (`shop-by-category`, `worth-the-hype`) move out.

This is the most visible change to an existing user in the whole three plans. Do only what the spec names: remove those two sections' rendering from the home screen. **Do not change `GET /feed`** — the backend still serves them, and other consumers may exist. Removing a section from a screen and removing it from an API are different decisions and only the first is in scope.

- [ ] **Step 2: The copy, in all 12 locales**

Every new key in `packages/frontend/lib/i18n/locales/`. `validate:i18n-strings` enforces parity, so a key added to `en.json` alone fails the build — which is the point.

The shelf titles take a parameter: `discovery.shelf.topRated` → `"Lo mejor valorado en %{category}"`, and the equivalents for `new`, `onSale`, `bestSelling`, `mostViewed`. Also the page titles, the deals heading, the signal route's "see all" and its capped-depth notice.

- [ ] **Step 3: Verify — the whole gate set, since this is the last task**

```bash
bun run --filter @mercaria/frontend typecheck
bun run --filter @mercaria/dashboard typecheck
bun run --filter @mercaria/pos typecheck
bun run --filter @mercaria/ui typecheck
bun run validate:route-targets
bun run validate:rtl-classes
bun run validate:i18n-strings
bun run --cwd packages/frontend test
```

- [ ] **Step 4: See it**

Start the backend and the storefront, seed if needed, and open `/categories`, a category, `/deals` and a signal route. **Compare each against the captured reference** — `/home/nate/Downloads/explore.txt`, `category.txt`, `offers.txt` — and the token appendix, which is a measurement of those files. Report what differs. This is the first and only appearance check in all three plans; treating it as a formality wastes the only one there is.

- [ ] **Step 5: Commit** — subject: `feat(storefront): give the home its personal job back and land the copy`.

---

## Plan self-review

**Spec coverage.** §"The screens" names four surfaces and the home trim: Task 3 covers `/categories` and `/categories/:handle`, Task 4 covers `/categories/:handle/s/:signal` and `/deals` plus the nav item, Task 5 covers the home trim and §"i18n". §"Typed routes" is a constraint on every task and is called out where dynamic destinations are written.

**Type consistency.** `DiscoveryScope`, `DiscoverySection`, `DiscoverySignal`, `DISCOVERY_SIGNALS` all come from `@mercaria/shared-types` (Plan A Task 1). `sectionTitleKey` is defined in Task 1 and consumed in Task 2. The nine components come from Plan B and this plan does not restate their props.

**The honest gap, twice over.** No task here proves a screen renders correctly — the frontend's runner is `lib/**` only, which is why Task 1 holds the only real test cycle and Tasks 2–4 lean on typecheck and the route/direction gates. And Task 5 Step 4 is a human comparison against three captured HTML files; it is the only step in three plans that can answer "does it look like what was asked for", and no automated gate substitutes for it.
