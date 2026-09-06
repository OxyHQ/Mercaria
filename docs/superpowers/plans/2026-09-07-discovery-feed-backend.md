# Discovery Feed — Backend Implementation Plan (Plan A of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `GET /discovery/feed?scope=` serving the explore, category and deals feeds from Postgres, with the sales/views aggregation that two of its five signals need.

**Architecture:** One feed contract with three scopes. Three of the five orderings read `listings` directly and need no new storage; `best-selling` and `most-viewed` read `discovery_signals`, a bounded table replaced per run by a leased sweep modelled on `services/analytics/rollup.ts`. An isolation gate keeps the popularity counts out of the offer-ranking domain, where they are forbidden inputs.

**Tech Stack:** TypeScript, Express, drizzle-orm + `@oxyhq/db`, PostgreSQL 17, vitest (including `*.realdb.test.ts` against a real server), bun.

**Spec:** `docs/superpowers/specs/2026-09-07-discovery-feed-design.md`

**Plans B (UI kit) and C (screens) depend on Task 1 of this plan** — the shared-types DTOs — and on nothing else here.

## Global Constraints

- `bun` / `bunx` only, from the repo root. Postgres must be up: `docker compose -f docker-compose.postgres.yml up -d` (port 5435).
- **`bun run build:shared-types` BEFORE `bun run --cwd packages/backend db:generate`, always.** drizzle-kit renders every closed-value-set CHECK from the BUILT `@mercaria/shared-types`; a stale `dist/` emits `DROP`/`ADD CONSTRAINT` pairs that narrow a sibling branch's tuple back.
- Every generated `.sql` needs **exactly one** `-- oxy:deploy-phase=pre` or `=post` marker. Regeneration DROPS it along with every hand-written statement. After any regeneration, READ the file and verify the marker count is 1.
- `src/db/migrate.ts` is the only thing that applies migrations. Never `drizzle-kit migrate`.
- Never hand-rename a migration, hand-edit `meta/_journal.json`, or hand-write a snapshot.
- **Do not convert `*.realdb.test.ts` suites to mocks.**
- **The test database is SHARED across parallel files.** Scope every aggregate to ids your file owns; floor every count equality; never delete rows your file did not create.
- Column naming: camelCase in TypeScript, snake_case in SQL, derived by drizzle. Do not pass an explicit column name.
- Never `as any`, `@ts-ignore`, `any` params/returns, `!` assertions, `console.log`, TODO/FIXME/HACK, `catch {}`, or hardcoded magic numbers.
- In `sql` templates: qualify every correlated column reference with `qualified()` from `@oxyhq/db`. A bare drizzle column in a SELECTION position of a single-table statement renders unqualified and silently returns nothing.
- Every new `*_id` column with no `.references()` needs an entry in `ID_COLUMNS_WITHOUT_FOREIGN_KEY` in `src/db/deferredForeignKeys.ts`, or `db/__tests__/schema-conventions.test.ts` fails the build.

---

## File Structure

**`packages/shared-types/src/`**
- Create `discovery.ts` — the closed vocabularies (`DISCOVERY_SIGNALS`, `DISCOVERY_WINDOWS`, `DISCOVERY_SUBJECT_TYPES`, `DISCOVERY_COUNTED_ORDER_STATUSES`, `DISCOVERY_SECTION_KINDS`) and the feed DTOs. One file: these types are read together and change together.
- Modify `index.ts` — re-export it.

**`packages/backend/src/db/`**
- Create `schema/discovery.ts` — `discoverySignals`, `discoverySweepCursors`.
- Modify `schema/index.ts` — re-export.
- Modify `deferredForeignKeys.ts` — classify `subject_id` and `category_id`.
- Create `discovery/discoverySignalRepository.ts` — the WRITE side: the per-window replace. Its only caller is the sweep.
- Create `discovery/discoveryReadRepository.ts` — the READ side: one query per signal, plus the store and discount reads. Split from the writer because the reader is on the request path and the writer is not, and they share no statement.

**`packages/backend/src/services/discovery/`**
- Create `sweep.ts` — the lease, the tick, the two counting passes.
- Create `feed.service.ts` — scope → sections.

**`packages/backend/src/`**
- Create `controllers/discovery.controller.ts` (thin), `controllers/discovery-operator.controller.ts` (thin).
- Create `routes/discovery.ts` (public), `routes/internal-discovery.ts` (operator).
- Modify `app.ts` — mount both. Modify `index.ts` — start/stop the sweep. Modify `config/index.ts` — `DiscoveryConfig`.

**Docs:** create `docs/discovery.md`; modify `docs/index.mdx` and `docs/house-invariants.md`.

---

### Task 1: The shared vocabularies and DTOs

Everything downstream — this plan's CHECKs, Plan B's component props, Plan C's screens — reads these names. Nothing else can start until they exist.

**Files:**
- Create: `packages/shared-types/src/discovery.ts`
- Modify: `packages/shared-types/src/index.ts`
- Test: `packages/shared-types/src/__tests__/discovery.test.ts`

**Interfaces:**
- Consumes: `ProductSummary`, `StoreSummary`, `CategoryTile` from `./product`; `Money` from `./money`.
- Produces: `DISCOVERY_SIGNALS`, `DiscoverySignal`, `DISCOVERY_WINDOWS`, `DiscoveryWindow`, `DISCOVERY_SUBJECT_TYPES`, `DiscoverySubjectType`, `DISCOVERY_COUNTED_ORDER_STATUSES`, `DISCOVERY_SECTION_KINDS`, `DiscoverySectionKind`, `HeroCard`, `DiscountSummary`, `DiscoverySection`, `DiscoveryFeed`, `DiscoveryScope`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared-types/src/__tests__/discovery.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_COUNTED_ORDER_STATUSES,
  DISCOVERY_SIGNALS,
  DISCOVERY_SIGNALS_FROM_LISTINGS,
  DISCOVERY_SIGNALS_FROM_COUNTS,
  DISCOVERY_WINDOWS,
} from '../discovery';
import { ORDER_STATUSES } from '../order';

describe('discovery vocabularies', () => {
  it('splits the signals into exactly the two storage sources, with no overlap and no orphan', () => {
    // The split is the whole design: three signals read `listings`, two read
    // `discovery_signals`. A signal in neither has no query behind it; a signal
    // in both has two that can disagree.
    const union = [...DISCOVERY_SIGNALS_FROM_LISTINGS, ...DISCOVERY_SIGNALS_FROM_COUNTS];
    expect([...union].sort()).toEqual([...DISCOVERY_SIGNALS].sort());
    expect(new Set(union).size).toBe(union.length);
  });

  it('counts exactly the five order statuses that are sales', () => {
    expect([...DISCOVERY_COUNTED_ORDER_STATUSES].sort()).toEqual([
      'delivered',
      'paid',
      'partially_refunded',
      'processing',
      'shipped',
    ]);
  });

  it('excludes the three statuses that are not sales, naming each', () => {
    // Asserted as an EXCLUSION rather than by the count above, because a set
    // that silently gained `cancelled` would still have five members if one of
    // the real five were dropped in the same edit.
    for (const status of ['pending_payment', 'cancelled', 'refunded'] as const) {
      expect(DISCOVERY_COUNTED_ORDER_STATUSES).not.toContain(status);
    }
  });

  it('names only real order statuses', () => {
    for (const status of DISCOVERY_COUNTED_ORDER_STATUSES) {
      expect(ORDER_STATUSES).toContain(status);
    }
  });

  it('has exactly one window, so a row cannot claim one nothing reads', () => {
    expect(DISCOVERY_WINDOWS).toEqual(['30d']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/shared-types test -- discovery
```

Expected: FAIL — `Cannot find module '../discovery'`.

If `ORDER_STATUSES` does not exist as a runtime value in `src/order.ts` (only the `OrderStatus` type does), add it there in this task, beside the type, spelled as `export const ORDER_STATUSES: readonly OrderStatus[] = [...]` with all eight members. The test above depends on it and so does Task 2's CHECK.

- [ ] **Step 3: Write `discovery.ts`**

```ts
/**
 * Discovery — the explore, category and deals feed.
 *
 * One contract with three SCOPES rather than three feeds: Shop's own explore,
 * category and offers pages are one section machine with one card set, and the
 * only thing that differs between them is which sections the server put in the
 * response.
 *
 * Not named `feed`: that word already carries the home feed and the supplier
 * product-feed importer. It IS the same concept as analytics'
 * `ANALYTICS_DISCOVERY_EVENT_TYPES` — browsing and finding — and the events
 * that vocabulary names are emitted BY these surfaces. Related on purpose.
 */

import type { OrderStatus } from './order';
import type { CategoryTile, ProductSummary, StoreSummary } from './product';
import type { Money } from './money';

/**
 * An ordering a shelf can be built on. A "curation" here is one of these
 * applied to a scope — there is no editorial curation model, and no admin
 * surface behind these pages, so a shelf title names the ordering it used.
 */
export type DiscoverySignal =
  | 'top-rated'
  | 'new'
  | 'on-sale'
  | 'best-selling'
  | 'most-viewed';

/** {@link DiscoverySignal}. Renders the CHECK on any column holding one. */
export const DISCOVERY_SIGNALS: readonly DiscoverySignal[] = [
  'top-rated',
  'new',
  'on-sale',
  'best-selling',
  'most-viewed',
];

/**
 * The signals answered from `listings` alone — rating, publication date and a
 * discounted variant are all durable columns with an index already on them.
 * These page to the full result set.
 */
export const DISCOVERY_SIGNALS_FROM_LISTINGS: readonly DiscoverySignal[] = [
  'top-rated',
  'new',
  'on-sale',
];

/**
 * The signals answered from `discovery_signals`. These page only as deep as the
 * sweep counted — see `DiscoverySectionPageDepth`.
 */
export const DISCOVERY_SIGNALS_FROM_COUNTS: readonly DiscoverySignal[] = [
  'best-selling',
  'most-viewed',
];

/**
 * The counting window. ONE member: nothing on any of the three screens asks for
 * a second, and a value set with a member nobody reads is one nobody can trust.
 * The column exists anyway so a row says which window it is; adding `7d` is a
 * shared-types change plus an additive migration.
 */
export type DiscoveryWindow = '30d';

/** {@link DiscoveryWindow}. */
export const DISCOVERY_WINDOWS: readonly DiscoveryWindow[] = ['30d'];

/** What a counted row is about. Polymorphic, so `subject_id` carries no FK. */
export type DiscoverySubjectType = 'listing' | 'store';

/** {@link DiscoverySubjectType}. */
export const DISCOVERY_SUBJECT_TYPES: readonly DiscoverySubjectType[] = ['listing', 'store'];

/**
 * The order statuses that ARE a sale.
 *
 * `pending_payment` is a stock reservation awaiting payment, not a sale.
 * `cancelled` and `refunded` are exits. Stated as a value set rather than
 * inlined in the sweep's `WHERE` so the decision is reviewable and testable —
 * excluding a status and forgetting one look identical inside a query.
 */
export const DISCOVERY_COUNTED_ORDER_STATUSES: readonly OrderStatus[] = [
  'paid',
  'processing',
  'shipped',
  'delivered',
  'partially_refunded',
];

/** How deep a section's "see all" can page. */
export type DiscoverySectionPageDepth =
  /** The whole result set — the signal reads `listings`. */
  | 'complete'
  /** Only what the sweep stored. Reported rather than implied. */
  | 'capped';

/** A card family. One member per card in the reference capture. */
export type DiscoverySectionKind =
  | 'hero'
  | 'category-tiles'
  | 'category-images'
  | 'pills'
  | 'products'
  | 'stores'
  | 'store-offer'
  | 'card-group';

/** {@link DiscoverySectionKind}. */
export const DISCOVERY_SECTION_KINDS: readonly DiscoverySectionKind[] = [
  'hero',
  'category-tiles',
  'category-images',
  'pills',
  'products',
  'stores',
  'store-offer',
  'card-group',
];

/** Which feed to build. */
export type DiscoveryScope =
  | { kind: 'root' }
  | { kind: 'category'; handle: string }
  | { kind: 'deals' };

/** A 2.35:1 action card: image, title, subtitle, destination. */
export interface HeroCard {
  id: string;
  title: string;
  /** One line under the title. Absent when nothing true can be said. */
  subtitle?: string;
  /**
   * Resolvable image URL, ABSENT when the subject has no image. Optional
   * rather than `''`: an empty string is an absent value wearing the type of a
   * present one, and it shipped a blank card once already.
   */
  imageUrl?: string;
  /** The scope+signal this card opens. */
  categoryHandle: string;
  signal: DiscoverySignal;
}

/**
 * A store's live automatic discount, resolved for display.
 *
 * `method: 'code'` discounts are never projected into one: a shelf advertising
 * a saving the shopper cannot get without a code they do not have is a false
 * price.
 */
export interface DiscountSummary {
  id: string;
  /** Percentage discounts carry this; fixed-amount ones carry `amountOff`. */
  percentOff?: number;
  /** Fixed-amount discounts carry this. */
  amountOff?: Money;
  /** The cart subtotal the discount needs, when it has a threshold. */
  minimumSubtotal?: Money;
  /** True when eligibility is narrower than everyone — drives the halo. */
  exclusive: boolean;
}

/** Fields every section carries. */
interface DiscoverySectionBase {
  id: string;
  /** The heading. Absent on sections the reference renders headless. */
  title?: string;
  /** Where the heading links. */
  categoryHandle?: string;
  signal?: DiscoverySignal;
  layout: 'carousel' | 'grid';
}

export interface HeroSection extends DiscoverySectionBase {
  kind: 'hero';
  cards: HeroCard[];
}

export interface CategoryTilesSection extends DiscoverySectionBase {
  kind: 'category-tiles';
  tiles: CategoryTile[];
}

export interface CategoryImagesSection extends DiscoverySectionBase {
  kind: 'category-images';
  tiles: CategoryTile[];
}

export interface PillsSection extends DiscoverySectionBase {
  kind: 'pills';
  tiles: CategoryTile[];
}

export interface ProductsSection extends DiscoverySectionBase {
  kind: 'products';
  products: ProductSummary[];
  pageDepth: DiscoverySectionPageDepth;
}

export interface StoresSection extends DiscoverySectionBase {
  kind: 'stores';
  stores: StoreSummary[];
  variant: 'large' | 'compact';
}

export interface StoreOfferSection extends DiscoverySectionBase {
  kind: 'store-offer';
  store: StoreSummary;
  discount: DiscountSummary;
  products: ProductSummary[];
}

export interface CardGroupSection extends DiscoverySectionBase {
  kind: 'card-group';
  /** Each renders inside its own bordered card, two per row. */
  cards: ProductsSection[];
}

/** One section, discriminated by `kind`. */
export type DiscoverySection =
  | HeroSection
  | CategoryTilesSection
  | CategoryImagesSection
  | PillsSection
  | ProductsSection
  | StoresSection
  | StoreOfferSection
  | CardGroupSection;

/** The feed: ordered sections, rendered top to bottom. */
export interface DiscoveryFeed {
  sections: DiscoverySection[];
}
```

- [ ] **Step 4: Re-export from the index**

In `packages/shared-types/src/index.ts`, after the `export * from './discount';` line:

```ts
// Discovery feed DTOs — the explore, category and deals surfaces (one contract,
// three scopes). Follows `./discount`, whose `DiscountSummary` counterpart it
// projects, and `./product`, whose ProductSummary/StoreSummary it carries.
export * from './discovery';
```

- [ ] **Step 5: Run the tests**

```bash
bun run --cwd packages/shared-types test -- discovery
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Build and typecheck the consumers**

```bash
bun run build:shared-types
bun run --cwd packages/backend typecheck
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/shared-types/src/discovery.ts \
        packages/shared-types/src/index.ts \
        packages/shared-types/src/order.ts \
        packages/shared-types/src/__tests__/discovery.test.ts
git commit -m "feat(discovery): the signal, window and section vocabularies

A curation is a signal applied to a scope, not a row: the reference's
\"Top rated\"/\"What's new\"/\"Bestsellers\" cards are derived orderings
wearing a uuid, and there is no admin surface behind these pages.

The signal set is split by STORAGE — three read \`listings\`, two read the
counts a sweep writes — because that split decides which shelves can page
to the end and which report a cap. A test asserts the two halves partition
the whole, so a signal with no query behind it cannot be added.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121G2nyf5Q1DD7TKx3q2fb8"
```

---

### Task 2: The tables and the migration

**Files:**
- Create: `packages/backend/src/db/schema/discovery.ts`
- Modify: `packages/backend/src/db/schema/index.ts` — re-export
- Modify: `packages/backend/src/db/deferredForeignKeys.ts`
- Create: a generated migration under `packages/backend/drizzle/`
- Test: `packages/backend/src/db/__tests__/discovery-schema.realdb.test.ts`

**Interfaces:**
- Consumes: Task 1's `DISCOVERY_SIGNALS`, `DISCOVERY_WINDOWS`, `DISCOVERY_SUBJECT_TYPES`.
- Produces: `discoverySignals`, `discoverySweepCursors` drizzle tables; `DiscoverySignalRow`, `DiscoverySweepCursorRow` row types.

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/db/__tests__/discovery-schema.realdb.test.ts`:

```ts
/**
 * The discovery tables against a REAL server. Every assertion here is about
 * something no mock has a counterpart for: a CHECK, a unique index, and the
 * lease pair.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { discoverySignals, discoverySweepCursors } from '../schema/discovery.js';

let db: Database;

/** Category scopes this file invented. The database is SHARED — never widen. */
const ownedCategoryIds: string[] = [];
const ownedCursorIds: string[] = [];

function makeCategoryId(): string {
  const id = `realdb-discovery-cat-${uuidv7()}`;
  ownedCategoryIds.push(id);
  return id;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  if (ownedCategoryIds.length > 0) {
    await db.delete(discoverySignals).where(inArray(discoverySignals.categoryId, ownedCategoryIds));
    ownedCategoryIds.length = 0;
  }
  if (ownedCursorIds.length > 0) {
    await db.delete(discoverySweepCursors).where(inArray(discoverySweepCursors.id, ownedCursorIds));
    ownedCursorIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('discovery_signals', () => {
  it('accepts a counted row', async () => {
    const categoryId = makeCategoryId();
    const [row] = await db
      .insert(discoverySignals)
      .values({
        subjectType: 'listing',
        subjectId: `listing-${uuidv7()}`,
        categoryId,
        window: '30d',
        unitsSold: 12,
        orderCount: 9,
        viewCount: 400,
        computedAt: new Date(),
      })
      .returning({ id: discoverySignals.id, unitsSold: discoverySignals.unitsSold });
    expect(row.unitsSold).toBe(12);
  });

  it('refuses a subject type outside the vocabulary', async () => {
    const categoryId = makeCategoryId();
    await expect(
      db.insert(discoverySignals).values({
        // @ts-expect-error — the CHECK is what is under test, not the type
        subjectType: 'merchant',
        subjectId: `x-${uuidv7()}`,
        categoryId,
        window: '30d',
        computedAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a window outside the vocabulary', async () => {
    const categoryId = makeCategoryId();
    await expect(
      db.insert(discoverySignals).values({
        subjectType: 'listing',
        subjectId: `x-${uuidv7()}`,
        categoryId,
        // @ts-expect-error — the CHECK is under test
        window: '7d',
        computedAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('refuses a negative count', async () => {
    const categoryId = makeCategoryId();
    await expect(
      db.insert(discoverySignals).values({
        subjectType: 'listing',
        subjectId: `x-${uuidv7()}`,
        categoryId,
        window: '30d',
        unitsSold: -1,
        computedAt: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('holds one row per subject per scope per window', async () => {
    const categoryId = makeCategoryId();
    const subjectId = `listing-${uuidv7()}`;
    const values = {
      subjectType: 'listing' as const,
      subjectId,
      categoryId,
      window: '30d' as const,
      computedAt: new Date(),
    };
    await db.insert(discoverySignals).values(values);
    await expect(db.insert(discoverySignals).values(values)).rejects.toSatisfy(isUniqueViolation);
  });

  it('lets one subject be counted under several scopes — the ancestor chain', async () => {
    // The sweep writes a subject once per category on its ancestor chain, so a
    // shelf at any depth is one indexed read. Two rows for one subject is the
    // DESIGN, and a unique index written without `category_id` would refuse it.
    const leaf = makeCategoryId();
    const parent = makeCategoryId();
    const subjectId = `listing-${uuidv7()}`;
    await db.insert(discoverySignals).values([
      { subjectType: 'listing', subjectId, categoryId: leaf, window: '30d', computedAt: new Date() },
      { subjectType: 'listing', subjectId, categoryId: parent, window: '30d', computedAt: new Date() },
    ]);
    const rows = await db
      .select({ id: discoverySignals.id })
      .from(discoverySignals)
      .where(eq(discoverySignals.subjectId, subjectId));
    expect(rows).toHaveLength(2);
  });

  it('accepts the root scope, which is the empty string and not NULL', async () => {
    // A NULLable dimension breaks the unique index — Postgres treats NULLs as
    // distinct — and would let a row be written that belongs to no scope.
    const subjectId = `listing-${uuidv7()}`;
    await db.insert(discoverySignals).values({
      subjectType: 'listing',
      subjectId,
      categoryId: '',
      window: '30d',
      computedAt: new Date(),
    });
    await db.delete(discoverySignals).where(eq(discoverySignals.subjectId, subjectId));
  });
});

describe('discovery_sweep_cursors', () => {
  it('refuses a lease owner with no deadline', async () => {
    // An owner with no deadline can never be reclaimed; a deadline with no
    // owner names nobody. The pair is the invariant, not either half.
    const id = `realdb-discovery-job-${uuidv7()}`;
    ownedCursorIds.push(id);
    await expect(
      db.insert(discoverySweepCursors).values({ id, leaseOwner: 'someone', leaseExpiresAt: null }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('accepts an unleased cursor and a fully leased one', async () => {
    const idle = `realdb-discovery-job-${uuidv7()}`;
    const leased = `realdb-discovery-job-${uuidv7()}`;
    ownedCursorIds.push(idle, leased);
    await db.insert(discoverySweepCursors).values([
      { id: idle },
      { id: leased, leaseOwner: 'owner', leaseExpiresAt: new Date(Date.now() + 60_000) },
    ]);
    const rows = await db
      .select({ id: discoverySweepCursors.id })
      .from(discoverySweepCursors)
      .where(inArray(discoverySweepCursors.id, [idle, leased]));
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/backend test -- discovery-schema
```

Expected: FAIL — `Cannot find module '../schema/discovery.js'`.

- [ ] **Step 3: Write the schema**

Create `packages/backend/src/db/schema/discovery.ts`:

```ts
/**
 * Discovery — `discovery_signals` and `discovery_sweep_cursors`.
 *
 * Two of the five discovery signals cannot be answered from a durable column.
 * `best-selling` is a sum over `order_items`; `most-viewed` is a count over
 * `analytics_events`, whose rows are swept by retention. Counted at request
 * time, a view count would SHRINK on its own as rows expire, with nothing on
 * the page to explain it — so it is written down, before the rows it came from
 * expire, which is the same argument `services/analytics/rollup.ts` makes for
 * its own numbers (data-lifecycle rule 2).
 *
 * ## Only counts. No score, and no rating
 *
 * There is no `score` column. Each shelf orders by ONE column and its title
 * names that column, which is how the reference behaves and what makes two
 * shelves disagreeing readable rather than mysterious. A composite weight would
 * be a ranking nobody can review.
 *
 * `rating` and `review_count` are NOT copied here. `review_aggregates` is "the
 * ONE authority for a scoped rating" and `listings.rating` is already its
 * projection; a third copy is a third place to disagree.
 *
 * ## One row per ANCESTOR
 *
 * `listings.category_id` is a leaf, but shelves are written at every depth
 * ("Bestsellers in Beauty"). The sweep writes a subject once per category on
 * its ancestor chain, so a shelf at any depth is one indexed read instead of a
 * recursive walk joined to a count — and a parent's figure IS its subtree's by
 * construction, rather than by a second query agreeing with the first.
 *
 * The root scope is `''`. Not NULL, for the reason `analytics_rollups` states
 * for the same convention: Postgres treats NULLs as distinct, so a NULLable
 * dimension breaks the bucket unique and lets a row exist that belongs to no
 * scope at all.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  DISCOVERY_SUBJECT_TYPES,
  DISCOVERY_WINDOWS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';

/** A counted subject, in one scope, over one window. Replaced whole per run. */
export const discoverySignals = pgTable(
  'discovery_signals',
  {
    id: generatedId(),
    subjectType: text({ enum: asEnumValues(DISCOVERY_SUBJECT_TYPES) }).notNull(),
    /** A listing id or a store id — polymorphic, so no foreign key. */
    subjectId: text().notNull(),
    /** An ancestor of the subject's category, or `''` for the root scope. */
    categoryId: text().notNull(),
    window: text({ enum: asEnumValues(DISCOVERY_WINDOWS) }).notNull(),
    unitsSold: integer().notNull().default(0),
    orderCount: integer().notNull().default(0),
    viewCount: integer().notNull().default(0),
    /** When the run that wrote this row started. */
    computedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('discovery_signals_subject_type_check', t.subjectType, DISCOVERY_SUBJECT_TYPES),
    checkOneOf('discovery_signals_window_check', t.window, DISCOVERY_WINDOWS),
    // A negative count is not a small number, it is a broken sum.
    check(
      'discovery_signals_counts_check',
      sql`${t.unitsSold} >= 0 and ${t.orderCount} >= 0 and ${t.viewCount} >= 0`,
    ),
    uniqueIndex('discovery_signals_subject_scope_key').on(
      t.subjectType,
      t.subjectId,
      t.categoryId,
      t.window,
    ),
    // One index per shelf, because each shelf sorts by one column.
    index('discovery_signals_units_sold_idx').on(t.categoryId, t.window, t.unitsSold),
    index('discovery_signals_view_count_idx').on(t.categoryId, t.window, t.viewCount),
  ],
);

/**
 * The sweep's lease. One row per job, `analytics_rollup_cursors`' shape.
 *
 * No `last_completed_date`: the window is ROLLING, so a run recomputes the
 * whole of it rather than advancing a day. There is nothing to resume.
 */
export const discoverySweepCursors = pgTable(
  'discovery_sweep_cursors',
  {
    /** The job name. Caller-supplied, so there is exactly one row per job. */
    id: text().primaryKey(),
    leaseOwner: text(),
    leaseExpiresAt: timestamptz(),
    lastRunAt: timestamptz(),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'discovery_sweep_cursors_lease_check',
      sql`num_nonnulls(${t.leaseOwner}, ${t.leaseExpiresAt}) in (0, 2)`,
    ),
  ],
);

/** A row of {@link discoverySignals}, as drizzle returns it. */
export type DiscoverySignalRow = typeof discoverySignals.$inferSelect;

/** A row of {@link discoverySweepCursors}. */
export type DiscoverySweepCursorRow = typeof discoverySweepCursors.$inferSelect;
```

- [ ] **Step 4: Re-export from the schema index**

In `packages/backend/src/db/schema/index.ts`, add alongside the other domain re-exports:

```ts
export * from './discovery';
```

- [ ] **Step 5: Classify the two id columns**

In `packages/backend/src/db/deferredForeignKeys.ts`, add to `ID_COLUMNS_WITHOUT_FOREIGN_KEY`:

```ts
  // ── Discovery counts ──────────────────────────────────────────────────────
  {
    column: 'discovery_signals.subject_id',
    reason:
      'POLYMORPHIC: a listing id or a store id, discriminated by subject_type. ' +
      'No single table to reference, and two nullable columns with a CHECK ' +
      'would double the index surface for a row nothing joins from — the sweep ' +
      'writes it and one indexed read consumes it.',
  },
  {
    column: 'discovery_signals.category_id',
    reason:
      'The ROOT scope is the empty string, which is not a category id, so no ' +
      'foreign key can cover this column. `analytics_rollups` uses the same ' +
      'sentinel for the same reason: a NULLable dimension breaks the bucket ' +
      'unique because Postgres treats NULLs as distinct.',
  },
```

- [ ] **Step 6: Generate the migration**

```bash
bun run build:shared-types
bun run --cwd packages/backend db:generate
```

- [ ] **Step 7: Add the deploy-phase marker and verify the diff**

Open the newly generated `.sql` under `packages/backend/drizzle/`. Add as its first line:

```sql
-- oxy:deploy-phase=pre
```

`pre` because every statement is additive — two `CREATE TABLE`s and their indexes, nothing dropped, renamed or narrowed.

Then verify:

```bash
grep -c 'oxy:deploy-phase' packages/backend/drizzle/<file>.sql   # must print exactly 1
grep -nE 'DROP|ALTER .* DROP|RENAME' packages/backend/drizzle/<file>.sql
```

Expected: the marker count is `1`, and the second grep prints nothing. **If it prints a `DROP CONSTRAINT`/`ADD CONSTRAINT` pair for a table you did not touch, the shared-types `dist/` was stale — rebuild it and regenerate.**

- [ ] **Step 8: Apply and run the tests**

```bash
docker compose -f docker-compose.postgres.yml up -d
bun run --cwd packages/backend test -- discovery-schema
```

Expected: PASS, 9 tests.

- [ ] **Step 9: Run the convention gates**

```bash
bun run --cwd packages/backend test -- schema-conventions
```

Expected: PASS. It fails if either id column above is unclassified.

- [ ] **Step 10: Commit**

```bash
git add packages/backend/src/db/schema/discovery.ts \
        packages/backend/src/db/schema/index.ts \
        packages/backend/src/db/deferredForeignKeys.ts \
        packages/backend/drizzle/ \
        packages/backend/src/db/__tests__/discovery-schema.realdb.test.ts
git commit -m "feat(discovery): count sales and views into a table, not a query

\`analytics_events\` is retention-swept, so a view count computed at request
time shrinks on its own with nothing on the page to explain it. Writing it
down before the rows expire is the argument \`analytics/rollup.ts\` already
makes for its own numbers.

One row per ANCESTOR category, so a shelf at any depth is one indexed read
and a parent's figure is its subtree's by construction. The root scope is
\`''\` rather than NULL, for the reason \`analytics_rollups\` states: Postgres
treats NULLs as distinct and a NULLable dimension breaks the bucket unique.

No score column and no rating column. Each shelf orders by one column and
its title names it; \`review_aggregates\` stays the only rating authority.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121G2nyf5Q1DD7TKx3q2fb8"
```

---

### Task 3: The write repository — replacing a window

**Files:**
- Create: `packages/backend/src/db/discovery/discoverySignalRepository.ts`
- Test: `packages/backend/src/db/__tests__/discovery-signal-repository.realdb.test.ts`

**Interfaces:**
- Consumes: Task 2's `discoverySignals`; `DiscoveryWindow`, `DiscoverySubjectType` from shared-types.
- Produces:
  - `replaceWindow(input: { window: DiscoveryWindow; rows: DiscoverySignalInput[]; computedAt: Date }): Promise<number>` — returns rows inserted.
  - `interface DiscoverySignalInput { subjectType: DiscoverySubjectType; subjectId: string; categoryId: string; unitsSold: number; orderCount: number; viewCount: number }`

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/db/__tests__/discovery-signal-repository.realdb.test.ts`:

```ts
/**
 * The per-window replace, against a real server.
 *
 * The property under test is ATOMICITY plus SCOPE: the replace must remove the
 * previous run's rows for the window it owns and nothing else, in one
 * transaction, so a reader never sees a half-written window.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { discoverySignals } from '../schema/discovery.js';
import {
  replaceWindow,
  type DiscoverySignalInput,
} from '../discovery/discoverySignalRepository.js';

let db: Database;
const ownedCategoryIds: string[] = [];

function makeCategoryId(): string {
  const id = `realdb-discovery-repo-${uuidv7()}`;
  ownedCategoryIds.push(id);
  return id;
}

function row(categoryId: string, subjectId: string, unitsSold: number): DiscoverySignalInput {
  return { subjectType: 'listing', subjectId, categoryId, unitsSold, orderCount: 1, viewCount: 0 };
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  if (ownedCategoryIds.length > 0) {
    await db.delete(discoverySignals).where(inArray(discoverySignals.categoryId, ownedCategoryIds));
    ownedCategoryIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('replaceWindow', () => {
  it('writes the rows it is given', async () => {
    const categoryId = makeCategoryId();
    const written = await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      scopeCategoryIds: [categoryId],
      rows: [row(categoryId, 'listing-a', 5), row(categoryId, 'listing-b', 3)],
    });
    expect(written).toBe(2);
  });

  it('REPLACES rather than accumulates — a subject that fell out is gone', async () => {
    // The failure this catches is an UPSERT-only sweep: `listing-b` stops
    // selling, is no longer in the input, and would otherwise sit on the shelf
    // forever carrying last month's number.
    const categoryId = makeCategoryId();
    await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      scopeCategoryIds: [categoryId],
      rows: [row(categoryId, 'listing-a', 5), row(categoryId, 'listing-b', 3)],
    });
    await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      scopeCategoryIds: [categoryId],
      rows: [row(categoryId, 'listing-a', 9)],
    });

    const remaining = await db
      .select({ subjectId: discoverySignals.subjectId, unitsSold: discoverySignals.unitsSold })
      .from(discoverySignals)
      .where(eq(discoverySignals.categoryId, categoryId));

    expect(remaining).toEqual([{ subjectId: 'listing-a', unitsSold: 9 }]);
  });

  it('touches no scope outside the ones it was given', async () => {
    // The shared test database makes this load-bearing, and so does production:
    // a replace written as `delete where window = $1` takes every category with
    // it, which no single-category assertion would notice.
    const mine = makeCategoryId();
    const neighbour = makeCategoryId();
    await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      scopeCategoryIds: [neighbour],
      rows: [row(neighbour, 'listing-n', 7)],
    });
    await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      scopeCategoryIds: [mine],
      rows: [row(mine, 'listing-m', 1)],
    });

    const survivors = await db
      .select({ subjectId: discoverySignals.subjectId })
      .from(discoverySignals)
      .where(
        and(eq(discoverySignals.categoryId, neighbour), eq(discoverySignals.window, '30d')),
      );
    expect(survivors).toEqual([{ subjectId: 'listing-n' }]);
  });

  it('an empty input clears the scope rather than being a no-op', async () => {
    // A category whose last listing was archived must EMPTY, not freeze. An
    // early `if (rows.length === 0) return 0` is the bug this pins.
    const categoryId = makeCategoryId();
    await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      scopeCategoryIds: [categoryId],
      rows: [row(categoryId, 'listing-a', 5)],
    });
    await replaceWindow({
      window: '30d',
      computedAt: new Date(),
      scopeCategoryIds: [categoryId],
      rows: [],
    });
    const remaining = await db
      .select({ subjectId: discoverySignals.subjectId })
      .from(discoverySignals)
      .where(eq(discoverySignals.categoryId, categoryId));
    expect(remaining).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/backend test -- discovery-signal-repository
```

Expected: FAIL — `Cannot find module '../discovery/discoverySignalRepository.js'`.

- [ ] **Step 3: Write the repository**

Create `packages/backend/src/db/discovery/discoverySignalRepository.ts`:

```ts
/**
 * `discovery_signals` — the WRITE side. Its only caller is the sweep.
 *
 * Split from the read repository because they share no statement and sit on
 * different paths: this one runs on a timer and rewrites whole scopes, the
 * reader runs on every request and reads one indexed slice.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { DiscoverySubjectType, DiscoveryWindow } from '@mercaria/shared-types';
import { getDb } from '../postgres.js';
import { discoverySignals } from '../schema/discovery.js';

/** One counted subject in one scope. The window and timestamp are per run. */
export interface DiscoverySignalInput {
  subjectType: DiscoverySubjectType;
  subjectId: string;
  categoryId: string;
  unitsSold: number;
  orderCount: number;
  viewCount: number;
}

export interface ReplaceWindowInput {
  window: DiscoveryWindow;
  /**
   * The scopes this call OWNS. Every existing row in these scopes is removed
   * and replaced by `rows`; every other scope is untouched.
   *
   * Explicit rather than derived from `rows`, because a scope whose subjects
   * have all gone must end up EMPTY, and a scope derived from an empty input
   * is no scope at all.
   */
  scopeCategoryIds: string[];
  rows: DiscoverySignalInput[];
  computedAt: Date;
}

/**
 * Replace the given scopes' rows for one window, atomically.
 *
 * DELETE + INSERT in one transaction rather than an upsert plus a cleanup:
 * Postgres MVCC makes the pair invisible to readers until it commits, so no
 * request ever sees a half-written window, and a subject that stopped selling
 * disappears instead of keeping last month's figure forever.
 *
 * @returns how many rows were inserted.
 */
export async function replaceWindow(input: ReplaceWindowInput): Promise<number> {
  const db = getDb();
  if (input.scopeCategoryIds.length === 0) {
    return 0;
  }

  return db.transaction(async (tx) => {
    await tx
      .delete(discoverySignals)
      .where(
        and(
          eq(discoverySignals.window, input.window),
          inArray(discoverySignals.categoryId, input.scopeCategoryIds),
        ),
      );

    if (input.rows.length === 0) {
      return 0;
    }

    const inserted = await tx
      .insert(discoverySignals)
      .values(
        input.rows.map((row) => ({
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          categoryId: row.categoryId,
          window: input.window,
          unitsSold: row.unitsSold,
          orderCount: row.orderCount,
          viewCount: row.viewCount,
          computedAt: input.computedAt,
        })),
      )
      .returning({ id: discoverySignals.id });

    return inserted.length;
  });
}
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/backend test -- discovery-signal-repository
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/db/discovery/discoverySignalRepository.ts \
        packages/backend/src/db/__tests__/discovery-signal-repository.realdb.test.ts
git commit -m "feat(discovery): replace a window atomically, scoped to what it owns

DELETE + INSERT in one transaction, not an upsert: a subject that stopped
selling must LEAVE the shelf, and an upsert-only sweep leaves it there
carrying last month's number forever. MVCC keeps the pair invisible until
it commits, so no request sees a half-written window.

The scopes are a parameter rather than derived from the rows, because a
category whose listings have all gone must end up empty, and a scope
derived from an empty input is no scope at all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121G2nyf5Q1DD7TKx3q2fb8"
```

---

### Task 4: The counting passes and the sweep

**Files:**
- Create: `packages/backend/src/services/discovery/sweep.ts`
- Create: `packages/backend/src/db/discovery/discoveryCountRepository.ts`
- Modify: `packages/backend/src/config/index.ts`
- Modify: `packages/backend/src/index.ts`
- Test: `packages/backend/src/services/__tests__/discovery-sweep.realdb.test.ts`

**Interfaces:**
- Consumes: Task 3's `replaceWindow` / `DiscoverySignalInput`; `DISCOVERY_COUNTED_ORDER_STATUSES`.
- Produces:
  - `countListingSales(since: Date): Promise<{ listingId: string; unitsSold: number; orderCount: number }[]>`
  - `countListingViews(since: Date): Promise<{ listingId: string; viewCount: number }[]>`
  - `runDiscoverySweepOnce(): Promise<{ rowsWritten: number } | undefined>` — `undefined` when another task holds the lease.
  - `startDiscoverySweep(): void`, `stopDiscoverySweep(): void`
  - `config.discovery`: `{ sweepIntervalMs, leaseMs, windowDays, topNPerCategory, topRatedMinReviews, shelfSize }`

- [ ] **Step 1: Add the config block**

In `packages/backend/src/config/index.ts`, beside `FeedConfig`:

```ts
export interface DiscoveryConfig {
  /** How often a task attempts the sweep. Every task ticks; one wins the lease. */
  readonly sweepIntervalMs: number;
  /** How long a sweep run may hold the lease before another task may reclaim it. */
  readonly leaseMs: number;
  /** The rolling window, in days. Must agree with `DISCOVERY_WINDOWS`' member. */
  readonly windowDays: number;
  /**
   * How many subjects are stored per category per window. This is also the
   * paging depth of `best-selling` and `most-viewed`: nothing below it was
   * counted, so nothing below it can be shown.
   */
  readonly topNPerCategory: number;
  /**
   * The review count a listing needs before `top-rated` will consider it. A
   * single five-star review must not outrank four thousand.
   */
  readonly topRatedMinReviews: number;
  /** How many cards a shelf carries in the feed. */
  readonly shelfSize: number;
}
```

Register it on the root config interface (`readonly discovery: DiscoveryConfig;`) and populate it where the other blocks are built, reading env vars with the same helper the neighbouring blocks use. Defaults: `sweepIntervalMs` 15 minutes, `leaseMs` 10 minutes, `windowDays` 30, `topNPerCategory` 60, `topRatedMinReviews` 5, `shelfSize` 12.

- [ ] **Step 2: Write the failing test**

Create `packages/backend/src/services/__tests__/discovery-sweep.realdb.test.ts`:

```ts
/**
 * The counting passes, against a real server.
 *
 * The arithmetic is the whole point: excluding a status and forgetting one look
 * identical inside a `WHERE`, so each is asserted by a fixture that would move
 * the number if it were wrong.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { listings } from '../../db/schema/catalog.js';
import { orderItems, orders } from '../../db/schema/orders.js';
import { analyticsEvents } from '../../db/schema/analytics.js';
import {
  countListingSales,
  countListingViews,
} from '../../db/discovery/discoveryCountRepository.js';

let db: Database;
const ownedListingIds: string[] = [];
const ownedOrderIds: string[] = [];
const ownedEventIds: string[] = [];

/** Yesterday — inside any window this suite asks for. */
function recently(): Date {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

async function makeListing(): Promise<string> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'user',
      oxyUserId: `realdb-discovery-seller-${uuidv7()}`,
      title: 'Realdb counted thing',
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
    })
    .returning({ id: listings.id });
  ownedListingIds.push(listing.id);
  return listing.id;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  if (ownedEventIds.length > 0) {
    await db.delete(analyticsEvents).where(inArray(analyticsEvents.id, ownedEventIds));
    ownedEventIds.length = 0;
  }
  if (ownedOrderIds.length > 0) {
    await db.delete(orders).where(inArray(orders.id, ownedOrderIds));
    ownedOrderIds.length = 0;
  }
  if (ownedListingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, ownedListingIds));
    ownedListingIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('countListingSales', () => {
  it('counts a paid order and ignores a pending one', async () => {
    const listingId = await makeListing();
    // Build one order per status via the existing order fixture helper in this
    // suite's neighbours; each carries one line of quantity 1 for `listingId`.
    // ... fixture construction, registering ids in ownedOrderIds ...

    const counted = await countListingSales(recently());
    const mine = counted.find((row) => row.listingId === listingId);
    expect(mine?.unitsSold).toBe(1);
  });

  it('moves the number for exactly the five counted statuses', async () => {
    // One order per status, all for one listing, each of quantity 1. Five of
    // the eight statuses are sales, so the sum is 5 — and dropping one of the
    // real five OR admitting `cancelled` both break this, which a
    // single-status test would not.
    const listingId = await makeListing();
    // ... one order per ORDER_STATUSES member ...

    const counted = await countListingSales(recently());
    const mine = counted.find((row) => row.listingId === listingId);
    expect(mine?.unitsSold).toBe(5);
    expect(mine?.orderCount).toBe(5);
  });

  it('ignores an order older than the window', async () => {
    const listingId = await makeListing();
    // ... one paid order dated 90 days ago ...
    const counted = await countListingSales(recently());
    expect(counted.find((row) => row.listingId === listingId)).toBeUndefined();
  });
});

describe('countListingViews', () => {
  it('counts product_page_view events and nothing else', async () => {
    const listingId = await makeListing();
    // Two `product_page_view` rows and one `offer_impression` row, all naming
    // this listing. A pass that forgot its event-type filter reads 3.
    // ... event construction, registering ids in ownedEventIds ...

    const counted = await countListingViews(recently());
    expect(counted.find((row) => row.listingId === listingId)?.viewCount).toBe(2);
  });
});
```

> **Note for the implementer:** the fixture bodies are elided above because the
> order-construction helper differs by suite. Before writing them, read
> `packages/backend/src/db/__tests__/orders.realdb.test.ts` (or the nearest
> order-writing realdb suite) and reuse its helper rather than hand-rolling a
> `DualMoney` insert — `dualMoney()` expands to four columns per amount and a
> hand-written insert will miss one. Every fixture id must be registered in the
> `owned*` arrays: the database is shared.

- [ ] **Step 3: Run it and watch it fail**

```bash
bun run --cwd packages/backend test -- discovery-sweep
```

Expected: FAIL — `Cannot find module '../../db/discovery/discoveryCountRepository.js'`.

- [ ] **Step 4: Write the counting repository**

Create `packages/backend/src/db/discovery/discoveryCountRepository.ts`. Both functions are plain drizzle aggregates — a `GROUP BY` per listing with the window as a `WHERE` bound:

```ts
/**
 * The two counting passes the sweep runs. Read-only, and read ONCE per run.
 *
 * Deliberately not correlated subqueries in a selection position: a drizzle
 * column interpolated there renders bare in a single-table statement and
 * resolves against the subquery's own table, returning 0 for every row with no
 * error at all (CONVENTIONS.md, #313). Two grouped scans joined in memory are
 * both cheaper and impossible to get wrong that way.
 */

import { and, count, eq, gte, inArray, sum } from 'drizzle-orm';
import { DISCOVERY_COUNTED_ORDER_STATUSES } from '@mercaria/shared-types';
import { getDb } from '../postgres.js';
import { orderItems, orders } from '../schema/orders.js';
import { analyticsEvents } from '../schema/analytics.js';

export interface ListingSalesCount {
  listingId: string;
  unitsSold: number;
  orderCount: number;
}

/** Units and orders per listing, over orders placed at or after `since`. */
export async function countListingSales(since: Date): Promise<ListingSalesCount[]> {
  const db = getDb();
  const rows = await db
    .select({
      listingId: orderItems.listingId,
      unitsSold: sum(orderItems.quantity),
      orderCount: count(),
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        gte(orders.createdAt, since),
        inArray(orders.status, [...DISCOVERY_COUNTED_ORDER_STATUSES]),
      ),
    )
    .groupBy(orderItems.listingId);

  // `sum()` comes back as a string from Postgres — a numeric aggregate is
  // arbitrary-precision and the driver will not narrow it for us.
  return rows.map((row) => ({
    listingId: row.listingId,
    unitsSold: Number(row.unitsSold ?? 0),
    orderCount: row.orderCount,
  }));
}

export interface ListingViewCount {
  listingId: string;
  viewCount: number;
}

/** Product-page views per listing, at or after `since`. */
export async function countListingViews(since: Date): Promise<ListingViewCount[]> {
  const db = getDb();
  const rows = await db
    .select({ listingId: analyticsEvents.listingId, viewCount: count() })
    .from(analyticsEvents)
    .where(
      and(
        eq(analyticsEvents.eventType, 'product_page_view'),
        gte(analyticsEvents.occurredAt, since),
      ),
    )
    .groupBy(analyticsEvents.listingId);

  // A view event with no listing id is a page view of something else.
  return rows.flatMap((row) =>
    row.listingId === null ? [] : [{ listingId: row.listingId, viewCount: row.viewCount }],
  );
}
```

- [ ] **Step 5: Run the counting tests**

```bash
bun run --cwd packages/backend test -- discovery-sweep
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Commit the counting passes**

```bash
git add packages/backend/src/db/discovery/discoveryCountRepository.ts \
        packages/backend/src/services/__tests__/discovery-sweep.realdb.test.ts \
        packages/backend/src/config/index.ts
git commit -m "feat(discovery): count sales and views, with the status set as a value

The five counted order statuses live in shared-types rather than inside a
WHERE, because excluding a status and forgetting one look identical in a
query. The test builds one order per status and asserts the sum is five, so
either mistake moves the number.

Two grouped scans rather than correlated subqueries: a drizzle column in a
selection position of a single-table statement renders bare and silently
returns zero (CONVENTIONS.md, #313).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121G2nyf5Q1DD7TKx3q2fb8"
```

- [ ] **Step 7: Write the sweep**

Create `packages/backend/src/services/discovery/sweep.ts`, modelled on
`packages/backend/src/services/analytics/rollup.ts` — read that file first and
follow its lease claim/complete shape exactly. The tick:

1. Claim the lease on the `discovery:signals` cursor row; return `undefined` if another task holds it.
2. `since = new Date(Date.now() - config.discovery.windowDays * 86_400_000)`.
3. Run `countListingSales(since)` and `countListingViews(since)`, and merge them by listing id into one map.
4. Load each counted listing's `categoryId`, and expand it to its ancestor chain plus `''` using the existing category tree read in `db/catalog/categoryRepository.ts`.
5. For each `(categoryId, window)` scope, keep the top `config.discovery.topNPerCategory` by `unitsSold` and, separately, by `viewCount`; the union is what is stored.
6. Roll the listing rows up one level into `subjectType: 'store'` rows per `(storeId, categoryId)`.
7. `replaceWindow({ window: '30d', scopeCategoryIds, rows, computedAt })`.
8. Complete the lease, stamping `lastRunAt`; on a throw, release the lease and record `lastError` — the next tick recomputes the whole rolling window anyway, so there is nothing to resume.

- [ ] **Step 8: Start it from `index.ts`**

In `packages/backend/src/index.ts`, beside the analytics rollup start:

```ts
      // Recount the discovery signals. Leased per RUN like the analytics
      // rollup, so N tasks share it — and for the same reason: the numbers are
      // written before the analytics rows they came from expire.
      import('./services/discovery/sweep.js')
        .then(({ startDiscoverySweep }) => startDiscoverySweep())
        .catch((err) => log.general.error({ err }, 'Discovery sweep import failed'));
```

and in the shutdown path, beside `stopAnalyticsRollup`:

```ts
        const { stopDiscoverySweep } = await import('./services/discovery/sweep.js');
        stopDiscoverySweep();
```

- [ ] **Step 9: Add the sweep's own test**

Append to `discovery-sweep.realdb.test.ts`:

```ts
describe('runDiscoverySweepOnce', () => {
  it('writes a row for every ancestor of the listing category, and for the root', async () => {
    // A three-level chain: root '' + grandparent + parent + leaf = four rows
    // for one listing. A sweep that wrote only the leaf passes every
    // single-category assertion and fails exactly this one.
    // ... build a 3-deep category chain, a listing on the leaf, one paid order ...
    await runDiscoverySweepOnce();

    const rows = await db
      .select({ categoryId: discoverySignals.categoryId })
      .from(discoverySignals)
      .where(eq(discoverySignals.subjectId, listingId));
    expect(rows.map((r) => r.categoryId).sort()).toEqual(
      ['', grandparentId, parentId, leafId].sort(),
    );
  });

  it('returns undefined while another task holds the lease', async () => {
    // Take the lease out from under it by hand, then tick.
    // ... write a cursor row with a future leaseExpiresAt and a foreign owner ...
    expect(await runDiscoverySweepOnce()).toBeUndefined();
  });
});
```

- [ ] **Step 10: Run everything and commit**

```bash
bun run --cwd packages/backend test -- discovery
bun run --cwd packages/backend typecheck
git add packages/backend/src/services/discovery/sweep.ts packages/backend/src/index.ts \
        packages/backend/src/services/__tests__/discovery-sweep.realdb.test.ts
git commit -m "feat(discovery): the leased sweep, writing one row per ancestor

Leased per run like the analytics rollup, so N tasks share it and a lost
lease costs a duplicate computation and nothing else — the sweep moves no
money and no state.

No cursor to advance: the window is rolling, so a run recomputes the whole
of it. A failed run therefore has nothing to resume; it releases the lease
and the next tick starts over.

The ancestor test is the one that matters: a sweep writing only the leaf
passes every single-category assertion.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121G2nyf5Q1DD7TKx3q2fb8"
```

---

### Task 5: The isolation gate

Written BEFORE the read side and the service, so the wall exists before there is anything to lean on it.

**Files:**
- Create: `packages/backend/src/services/__tests__/discovery-isolation.test.ts`

**Interfaces:**
- Consumes: `assertNothingOutsideDomainPopulation`, `namedInSharedDirectories`, `readSrcDirectory`, `walkOwnedDirectory` from `src/__tests__/domain-population.ts`; `assertEachOf` from `src/__tests__/assert-each-of.ts`.
- Produces: nothing importable.

- [ ] **Step 1: Read the pattern**

Read `packages/backend/src/services/__tests__/navigation-isolation.test.ts` end to end. It carries the three house defences this gate needs: a **vacuity floor** (a moved file must fail rather than silently shrink the scan), **comment stripping** (these modules document what they refuse to do, in the detectors' own vocabulary), and a **mutation self-test** (a rotted regex must not pass by matching nothing).

- [ ] **Step 2: Write the gate**

Create `packages/backend/src/services/__tests__/discovery-isolation.test.ts` asserting:

1. **No file under `services/offer*`, `services/ranking*`, `db/offers/` or `db/ranking/` imports `db/discovery/` or `services/discovery/`.** `merchant_popularity` and `brand_popularity` are in `OFFER_FORBIDDEN_RANKING_SIGNALS`, and `db/schema/ranking.ts` makes the prohibition structural by having no column to hold one. Merchandising may use popularity; the buy box may not. This is the gate that keeps the second true of modules nobody has written yet.
2. **The reverse direction too:** no file under `services/discovery/` or `db/discovery/` imports `db/offers/`, `services/offer*` or `db/schema/ranking.js`. A shelf one join from a weighted ordering is a sponsored-placement surface nobody decided to build.
3. **`discovery_signals` carries no `score`, `weight` or `rank` column** — walked from `getTableColumns(discoverySignals)`, not read out of the file. One column per shelf, named by the shelf.
4. **`discovery_signals` carries no `rating` or `review_count` column** — `review_aggregates` is the single rating authority and `listings.rating` is already its projection.
5. **The vacuity floor:** `services/discovery` and `db/discovery` each contain at least one scanned file, so a rename that empties the scan fails instead of passing.

- [ ] **Step 3: Prove the gate can fail — the positive control**

Temporarily add to `packages/backend/src/services/offers/` (or the nearest real file matched by rule 1):

```ts
import { replaceWindow } from '../../db/discovery/discoverySignalRepository.js';
```

Run:

```bash
bun run --cwd packages/backend test -- discovery-isolation
```

Expected: **FAIL**, naming that file and that import. A gate that has never failed has not been measured. Then revert the line and re-run — expected PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/services/__tests__/discovery-isolation.test.ts
git commit -m "test(discovery): wall the popularity counts off from offer ranking

merchant_popularity and brand_popularity are forbidden inputs to organic
offer rank (#74), and legitimate inputs to merchandising. The difference
cannot be a comment: this gate fails the build if the offer or ranking
domains reach the discovery counts, or the reverse.

Measured, not assumed — a positive control import was added, the gate went
red naming it, and the line was reverted.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121G2nyf5Q1DD7TKx3q2fb8"
```

---

### Task 6: The read repository — one query per signal

**Files:**
- Create: `packages/backend/src/db/discovery/discoveryReadRepository.ts`
- Test: `packages/backend/src/db/__tests__/discovery-read-repository.realdb.test.ts`

**Interfaces:**
- Consumes: `listings`, `discoverySignals`, `discounts`, `stores`; `config.discovery`.
- Produces:
  - `findListingsBySignal(input: { signal: DiscoverySignal; categoryIds: string[]; limit: number; offset: number }): Promise<ListingRecord[]>`
  - `findStoresBySignal(input: { categoryId: string; limit: number }): Promise<string[]>` — store ids, most sold first.
  - `findStoresWithLiveDiscounts(limit: number): Promise<{ storeId: string; discount: DiscountRow }[]>`

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/db/__tests__/discovery-read-repository.realdb.test.ts`. It must cover, each with a fixture that would move if the query were wrong:

```ts
describe('findListingsBySignal', () => {
  it('top-rated excludes a listing below the review floor', async () => {
    // Two listings in one category: rating 5.0 with 1 review, rating 4.2 with
    // 400. Without the floor the one-review listing wins, which is the whole
    // reason the floor exists.
    // ... fixtures ...
    const found = await findListingsBySignal({
      signal: 'top-rated', categoryIds: [categoryId], limit: 10, offset: 0,
    });
    expect(found.map((l) => l.id)).toEqual([manyReviewsId]);
  });

  it('new orders by published_at and not by row creation', async () => {
    // `listings.published_at` is the FIRST activation, never the row's
    // birthday. Two listings created in the reverse order they were published
    // — a query ordering by `created_at` passes every same-order fixture.
    // ... fixtures ...
    expect(found.map((l) => l.id)).toEqual([publishedLaterId, publishedEarlierId]);
  });

  it('best-selling reads the counted rows and honours the scope', async () => {
    // ... two discovery_signals rows in this category, one in a sibling ...
  });

  it('best-selling returns nothing when nothing was counted', async () => {
    // The vacuity floor's counterpart: an empty signals table must produce an
    // empty shelf, not every listing in the category via a bad join.
  });
});
```

Plus, for `findStoresWithLiveDiscounts`:

```ts
it('lists a store with a live automatic discount', async () => { /* ... */ });

it('excludes a code discount', async () => {
  // A shelf advertising a saving that needs a code the shopper does not have
  // is a false price.
});

it('excludes a discount whose window has closed', async () => {
  // `ends_at` in the past. A query filtering only on `is_active` passes every
  // fixture whose window is open.
});

it('excludes an inactive discount whose window is open', async () => {
  // The converse. Neither assertion catches the other's bug.
});
```

- [ ] **Step 2–5: Fail, implement, pass, commit**

```bash
bun run --cwd packages/backend test -- discovery-read-repository
```

Implement `discoveryReadRepository.ts` with one exported function per bullet in the Interfaces block above. `top-rated` filters `listings.reviewCount >= config.discovery.topRatedMinReviews`; `new` orders by `listings.publishedAt` desc; `on-sale` delegates to the existing `findOnSaleListings`; `best-selling` and `most-viewed` join `discovery_signals` on `subjectId = listings.id` filtered to `subjectType = 'listing'` and the scope, ordering by the one column each names. `findStoresWithLiveDiscounts` filters `discounts.method = 'automatic'`, `is_active`, and `starts_at <= now() <= coalesce(ends_at, 'infinity')` — the shape `discounts_store_id_method_window_idx` was built for.

Commit message subject: `feat(discovery): one query per signal, each ordered by the column it names`.

---

### Task 7: The feed service

**Files:**
- Create: `packages/backend/src/services/discovery/feed.service.ts`
- Test: `packages/backend/src/services/__tests__/discovery-feed.realdb.test.ts`

**Interfaces:**
- Consumes: Task 6's reads; `toProductSummaries` / `toStoreSummary` from `services/catalog-hydration.service.js`; `findActiveCategories`.
- Produces: `getDiscoveryFeed(scope: DiscoveryScope, viewerId?: string): Promise<DiscoveryFeed>`

- [ ] **Step 1: Write the failing test**

Assert the SHAPE of each scope, not its exact contents:

```ts
it('root leads with a hero row and browse-category tiles', async () => {
  const feed = await getDiscoveryFeed({ kind: 'root' });
  expect(feed.sections[0]?.kind).toBe('hero');
  expect(feed.sections[1]?.kind).toBe('category-tiles');
});

it('a category scope carries pills, then a card group, then shelves', async () => {
  const feed = await getDiscoveryFeed({ kind: 'category', handle: someSlug });
  expect(feed.sections.map((s) => s.kind)).toContain('pills');
  expect(feed.sections.map((s) => s.kind)).toContain('card-group');
});

it('deals carries one store-offer section per discounted store and nothing else', async () => {
  const feed = await getDiscoveryFeed({ kind: 'deals' });
  expect(new Set(feed.sections.map((s) => s.kind))).toEqual(new Set(['store-offer']));
});

it('reports the page depth honestly per section', async () => {
  // `best-selling` is capped at what the sweep stored; `new` is complete.
  // A section that claimed `complete` for a capped signal would send the
  // paginated route past the end of the data.
  const feed = await getDiscoveryFeed({ kind: 'category', handle: someSlug });
  const bestSelling = feed.sections.find(
    (s): s is ProductsSection => s.kind === 'products' && s.signal === 'best-selling',
  );
  expect(bestSelling?.pageDepth).toBe('capped');
});

it('emits no empty section', async () => {
  // A heading over an empty row is worse than no heading. Every renderer
  // guards, but the server must not send one either — the reference never
  // does, and a grid with a title and no cards reads as a broken page.
  const feed = await getDiscoveryFeed({ kind: 'root' });
  for (const section of feed.sections) {
    expect(sectionItemCount(section)).toBeGreaterThan(0);
  }
});

it('sends a signal and a scope, never a composed sentence', async () => {
  // Titles are resolved on the client from a key plus a parameter. A sentence
  // assembled here is a sentence that cannot be translated.
  const feed = await getDiscoveryFeed({ kind: 'category', handle: someSlug });
  for (const section of feed.sections) {
    if (section.signal !== undefined) {
      expect(section.title).toBeUndefined();
    }
  }
});
```

- [ ] **Step 2–5: Fail, implement, pass, commit**

The service maps a scope to an ordered section list, hydrating through the existing
`catalog-hydration.service`. Cache the assembled feed in Redis with
`config.feed.cacheTtlSeconds`, keyed per scope and viewer, exactly as
`feed.service.ts` does — including its failure discipline: a Redis error is
logged and the feed is built from the database, never thrown.

Commit subject: `feat(discovery): assemble the three scopes from one section vocabulary`.

---

### Task 8: The public route

**Files:**
- Create: `packages/backend/src/routes/discovery.ts`, `packages/backend/src/controllers/discovery.controller.ts`
- Modify: `packages/backend/src/app.ts`
- Modify: `packages/backend/src/lib/rate-limit.ts` — `RateLimitScope` is a CLOSED union; add `'discovery'` or `makeRateLimiter('discovery')` does not compile. Its own bucket rather than sharing `'feed'`: this surface is three pages plus a paginated signal route, and sharing the home feed's budget would mean a crawler on `/deals` exhausts the home for everyone.
- Test: `packages/backend/src/routes/__tests__/discovery-route.realdb.test.ts`

**Interfaces:**
- Consumes: `getDiscoveryFeed`.
- Produces: `GET /discovery/feed?scope=root|category:<handle>|deals`.

- [ ] **Step 1: Write the failing test**

```ts
it('serves the root feed to an anonymous caller', async () => {
  const res = await request(app).get('/discovery/feed?scope=root');
  expect(res.status).toBe(200);
  expect(res.body.data.sections).toBeInstanceOf(Array);
});

it('rejects a scope outside the vocabulary rather than defaulting to root', async () => {
  // A silent default would serve the wrong page for a typo, with a 200.
  const res = await request(app).get('/discovery/feed?scope=everything');
  expect(res.status).toBe(400);
});

it('rejects a missing scope', async () => {
  const res = await request(app).get('/discovery/feed');
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2–5: Fail, implement, pass, commit**

Route file mirrors `routes/feed.ts`: `makeRateLimiter('discovery')` plus `optionalAuth`
(public — browsing is anonymous; the viewer only drives `saved`). Controller is
thin, delegating to the service and using `sendSuccess` / `respondWithError`.
Parse and validate the `scope` parameter with the middleware-schema helper the
neighbouring routes use — never a hand-rolled `split(':')` that accepts anything.
Mount in `app.ts` beside `app.use('/feed', feedRouter)`.

Commit subject: `feat(discovery): GET /discovery/feed, one route for three scopes`.

---

### Task 9: The operator surface and the docs

**Files:**
- Create: `packages/backend/src/routes/internal-discovery.ts`, `packages/backend/src/controllers/discovery-operator.controller.ts`
- Modify: `packages/backend/src/app.ts`
- Create: `docs/discovery.md`
- Modify: `docs/index.mdx`, `docs/house-invariants.md`
- Test: `packages/backend/src/routes/__tests__/internal-discovery.realdb.test.ts`

- [ ] **Step 1: Write the failing test**

Read `packages/backend/src/routes/__tests__/` for the nearest `internal-*` suite and copy its shape. Assert:

```ts
it('is NOT MOUNTED when the allow-list is empty — 404, never 401', async () => {
  // A 401 advertises that the surface exists. The whole allow-list design
  // turns on this distinction.
  const res = await request(appWithEmptyAllowList).post('/internal/discovery/sweep');
  expect(res.status).toBe(404);
});

it('refuses an authenticated caller who is not on the list', async () => {
  expect(res.status).toBe(403);
});

it('runs a sweep for a caller on the list', async () => {
  expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Implement, reusing the analytics allow-list**

`routes/internal-discovery.ts` mirrors `routes/internal-analytics.ts`:
`authenticateToken` FIRST, then `requireAnalyticsOperator` — the gate reads the
verified caller, and an allow-list consulted before authentication compares
against whatever a client claimed. `ANALYTICS_OPERATOR_OXY_USER_IDS` already
gates `/internal/analytics/*` **and** the merchant-demand acquisition pipeline,
which is the precedent for a second surface joining one list; forcing a
recomputation of counts derived from analytics events is the power that list
already holds. Do NOT add a sixth allow-list.

One endpoint: `POST /sweep` → `runDiscoverySweepOnce()`.

- [ ] **Step 3: Update `docs/house-invariants.md`**

In the internal-surface table, extend the `ANALYTICS_OPERATOR_OXY_USER_IDS` row:

```
| `ANALYTICS_OPERATOR_OXY_USER_IDS` | `/internal/analytics/*`, `/internal/discovery/*`, and the merchant-demand acquisition pipeline |
```

- [ ] **Step 4: Write `docs/discovery.md`**

The domain doc: the three scopes, the signal table above, why curations are
signals rather than rows, the ancestor-row decision, the `''` root sentinel, the
isolation gate and what it defends, and the `/offers` vs `/deals` naming. Point
at the spec for the reasoning behind each; do not restate it.

- [ ] **Step 5: Register it in `docs/index.mdx`**

Add the entry alongside the other domain files, in that file's existing order.

- [ ] **Step 6: Run the whole backend suite**

```bash
bun run --cwd packages/backend test
bun run --cwd packages/backend typecheck
bun run --filter @mercaria/backend lint
bun run validate:agents-md
```

Expected: all four exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/backend/src/routes/internal-discovery.ts \
        packages/backend/src/controllers/discovery-operator.controller.ts \
        packages/backend/src/app.ts \
        packages/backend/src/routes/__tests__/internal-discovery.realdb.test.ts \
        docs/discovery.md docs/index.mdx docs/house-invariants.md
git commit -m "feat(discovery): the operator sweep trigger, on an existing allow-list

/internal/discovery joins ANALYTICS_OPERATOR_OXY_USER_IDS rather than
creating a sixth list: forcing a recomputation of counts derived from
analytics events is the power that list already holds, and it already
covers a second surface for the same reason. Empty means NOT MOUNTED —
404, never a 401 that would advertise the surface.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121G2nyf5Q1DD7TKx3q2fb8"
```

---

## Plan self-review

**Spec coverage.** Every §"Delivery" item 2, 3 and 4 has a task: shared-types → Task 1; table + migration → Task 2; sweep + `/internal` + gate → Tasks 3–5 and 9; service + route → Tasks 6–8. `docs/discovery.md` and the `docs/index.mdx` / `docs/house-invariants.md` edits the spec asks to land "with change 3" are in Task 9 instead, so the doc describes a surface that exists — a doc written before the route is a doc describing an intention.

Spec sections with NO task here, by design, because they belong to Plans B and C: the preset gaps, all nine components, the `SectionHeader` change, the three screens, `/categories/:handle/s/:signal`, the nav item, the i18n keys and the home trim.

**Type consistency.** `DiscoverySignalInput` (Task 3) is consumed by the sweep (Task 4) under that name. `replaceWindow` takes `scopeCategoryIds` in both its definition and both call sites. `countListingSales` / `countListingViews` return `listingId`-keyed rows in Task 4's definition and its test. `getDiscoveryFeed(scope, viewerId?)` is spelled identically in Tasks 7 and 8. `pageDepth` is `'complete' | 'capped'` in Task 1 and asserted with those literals in Task 7.

**Known elisions, and why they are not placeholders.** Task 4's order fixtures and Task 6's `describe` bodies name the property, the fixture that would move if the query were wrong, and the bug each catches — but not the literal insert, because a `DualMoney` insert is four columns per amount and the correct helper differs per suite. Both steps say which existing file to read for it. Writing a plausible-looking hand-rolled insert here would be worse than saying where the real one lives.
