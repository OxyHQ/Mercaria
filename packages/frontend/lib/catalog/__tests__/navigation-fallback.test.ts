/**
 * The storefront's navigation fallback, executed — ADR 0007 D12's rollback as it
 * reaches a shopper.
 *
 * ## The claim this file exists to defend
 *
 * `docs/runbooks/catalog-rollout-rollback.md` says turning
 * `CATALOG_TAXONOMY_V2_ENABLED` off restores the v1 category tree in the
 * storefront. Until this file, that was the least-defended claim in the runbook:
 * the mechanism was real and lived inside a `queryFn` closure inside a `useQuery`,
 * where nothing could reach it, and an audit confirmed with a positive control
 * that `useCatalogNavigation`, `navigationFromCategoryTree` and
 * `category_tree_fallback` appeared in no test in the repository.
 *
 * It matters more than an ordinary fallback because of WHERE it sits. The server
 * half of the rollback is gated by `routes/__tests__/catalog-rollout.realdb.test.ts`;
 * this is the half that lives in the package with two test files and no isolation
 * gate, and the failure mode is a menu-shaped error on the first request of every
 * session, on the deploy that rolled back.
 *
 * ## Three failures, one answer, and that is the point
 *
 * The lever off is a REJECTED promise (404). An unconfigured market is a RESOLVED
 * `{trees: []}`. An unreachable API is a rejection of a different kind. A shopper
 * gets the same menu in all three, and each is asserted separately — a single case
 * would pass against an implementation that handled only the one it was written
 * for, which is exactly what a `catch` around the whole thing would do while
 * silently also swallowing the case below.
 *
 * ## What is deliberately NOT swallowed
 *
 * If `GET /categories` also fails there is no answer left, and the resolver
 * rejects rather than returning an empty menu. An empty menu is a statement about
 * the shop; a rejection is a statement about Mercaria, and only one of them is
 * true. That case is asserted too, because it is the one an over-broad `catch`
 * would turn into a silent empty storefront.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CategoryNode, NavigationResponse } from '@mercaria/shared-types';
import { resolveCatalogNavigation } from '../navigation';

const LIB_CATALOG = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A category tree with one root, which is what the v1 read returns. */
const CATEGORY_TREE: readonly CategoryNode[] = [
  {
    id: 'cat-root',
    name: 'Electronics',
    slug: 'electronics',
    handle: 'electronics',
    children: [],
  } as unknown as CategoryNode,
];

/** One published navigation tree, which is what taxonomy v2 returns. */
const TREES: NavigationResponse = {
  trees: [{ key: 'primary', surface: 'header', nodes: [], withheldNodeCount: 0 }],
  withheldNodeCount: 0,
} as unknown as NavigationResponse;

function readers(overrides: {
  trees?: () => Promise<NavigationResponse>;
  categories?: () => Promise<readonly CategoryNode[]>;
}) {
  let treeCalls = 0;
  let categoryCalls = 0;
  return {
    treeCalls: () => treeCalls,
    categoryCalls: () => categoryCalls,
    readTrees: () => {
      treeCalls += 1;
      return (overrides.trees ?? (() => Promise.resolve(TREES)))();
    },
    readCategoryTree: () => {
      categoryCalls += 1;
      return (overrides.categories ?? (() => Promise.resolve(CATEGORY_TREE)))();
    },
  };
}

describe('taxonomy v2 answers when it has something to say', () => {
  it('uses the published trees and reports `navigation_trees`', async () => {
    const io = readers({});
    const navigation = await resolveCatalogNavigation({
      market: 'ES',
      locale: 'es',
      surface: undefined,
      readTrees: io.readTrees,
      readCategoryTree: io.readCategoryTree,
    });
    expect(navigation.source).toBe('navigation_trees');
    // POSITIVE CONTROL for every fallback case below: the v2 read is genuinely
    // attempted and genuinely preferred. Without this, an implementation that
    // ALWAYS fell back would satisfy all four fallback assertions.
    expect(io.treeCalls()).toBe(1);
    expect(io.categoryCalls()).toBe(0);
  });
});

describe('the fallback — three different failures, one answer', () => {
  it('falls back when the lever is OFF and `/navigation` REJECTS (a 404)', async () => {
    const io = readers({ trees: () => Promise.reject(new Error('Request failed with status 404')) });
    const navigation = await resolveCatalogNavigation({
      market: 'ES',
      locale: 'es',
      surface: undefined,
      readTrees: io.readTrees,
      readCategoryTree: io.readCategoryTree,
    });
    expect(navigation.source).toBe('category_tree_fallback');
    expect(navigation.trees).toHaveLength(1);
    expect(io.categoryCalls()).toBe(1);
  });

  it('falls back on a RESOLVED but EMPTY tree list — an unconfigured market', async () => {
    // ADR 0007 D13's parity condition: rendering `{trees: []}` as an empty menu
    // would withdraw navigation on the deploy that ENABLED the flag, which is the
    // opposite of a rollout. This is the case a rejection-only `catch` misses.
    const io = readers({ trees: () => Promise.resolve({ trees: [], withheldNodeCount: 0 } as unknown as NavigationResponse) });
    const navigation = await resolveCatalogNavigation({
      market: 'ZZ',
      locale: 'es',
      surface: undefined,
      readTrees: io.readTrees,
      readCategoryTree: io.readCategoryTree,
    });
    expect(navigation.source).toBe('category_tree_fallback');
    expect(io.treeCalls()).toBe(1);
    expect(io.categoryCalls()).toBe(1);
  });

  it('falls back when the API is unreachable', async () => {
    const io = readers({ trees: () => Promise.reject(new TypeError('fetch failed')) });
    const navigation = await resolveCatalogNavigation({
      market: 'ES',
      locale: 'es',
      surface: undefined,
      readTrees: io.readTrees,
      readCategoryTree: io.readCategoryTree,
    });
    expect(navigation.source).toBe('category_tree_fallback');
  });

  it('does not even ASK for trees when there is no market, and still answers', async () => {
    // A market is required to compose the request, so with none there is nothing
    // to ask. Asserted on the CALL COUNT rather than on the answer, because the
    // answer is the same either way and only the count distinguishes "did not ask"
    // from "asked and was refused".
    const io = readers({});
    const navigation = await resolveCatalogNavigation({
      market: undefined,
      locale: 'es',
      surface: undefined,
      readTrees: io.readTrees,
      readCategoryTree: io.readCategoryTree,
    });
    expect(navigation.source).toBe('category_tree_fallback');
    expect(io.treeCalls()).toBe(0);
    expect(io.categoryCalls()).toBe(1);
  });
});

describe('the fallback\'s own failure is NOT swallowed', () => {
  it('REJECTS when the v1 read fails too, rather than returning an empty menu', async () => {
    // The case an over-broad `catch` would turn into a silent empty storefront.
    const io = readers({
      trees: () => Promise.reject(new Error('404')),
      categories: () => Promise.reject(new Error('500')),
    });
    await expect(
      resolveCatalogNavigation({
        market: 'ES',
        locale: 'es',
        surface: undefined,
        readTrees: io.readTrees,
        readCategoryTree: io.readCategoryTree,
      }),
    ).rejects.toThrow('500');
  });
});

describe('the hook actually calls it — a mechanism can be green and inert', () => {
  /**
   * The resolver above is only the storefront's behaviour if the hook uses it.
   * Extracting a decision out of a closure and leaving the closure in place is the
   * shape this repository keeps recording: tested, correct, and reached by
   * nothing. `use-navigation.ts` is in `lib/catalog/`, inside this runner's own
   * `include`, so its source is readable here without a renderer.
   */
  const hookSource = readFileSync(join(LIB_CATALOG, 'use-navigation.ts'), 'utf8');

  it('`use-navigation.ts` calls `resolveCatalogNavigation`', () => {
    expect(hookSource).toContain('resolveCatalogNavigation(');
  });

  it('and hands it the REAL readers, not a stub', () => {
    expect(hookSource).toContain('readTrees: fetchNavigationTrees');
    expect(hookSource).toContain('readCategoryTree: fetchCategoryTree');
  });

  it('holds no second copy of the decision', () => {
    // The extraction removed a private `readNavigationTrees` from the hook. If it
    // comes back, there are two fallbacks and this file tests the wrong one.
    expect(hookSource).not.toContain('function readNavigationTrees');
    expect(hookSource).not.toContain('navigationFromCategoryTree');
  });

  it('keeps `retry: false`, so a deliberately-unmounted route is asked once', () => {
    // Not cosmetic: without it React Query retries the 404 the lever produces
    // three times on the first request of every session, and the fallback below
    // it makes every one of those retries pure cost.
    expect(hookSource).toContain('retry: false');
  });

  it('POSITIVE CONTROL — the source really was read', () => {
    // Without this, a typo in the path would make every assertion above pass
    // against an empty string, and `not.toContain` would pass loudest of all.
    expect(hookSource.length).toBeGreaterThan(1_000);
    expect(hookSource).toContain('useCatalogNavigation');
  });
});
