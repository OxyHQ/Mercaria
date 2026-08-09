/**
 * The FIXTURE adapter — issue #62 acceptance 1's "fake/test provider", and the
 * subject of the reusable contract suite.
 *
 * It is a real {@link CatalogSourceAdapter} against an in-memory feed, which is
 * what makes it worth shipping rather than mocking: the contract suite runs the
 * same thirteen cases against it that #63, #65 and #66 will run against theirs,
 * and the end-to-end realdb test drives a whole ingestion through it into
 * PostgreSQL observations and matched external offers. A mock would have proved
 * that the pipeline calls a function.
 *
 * ## It is NOT registered anywhere
 *
 * `registry.ts` registers nothing by default and this file adds no side effect.
 * A test-only provider auto-registered in production is exactly the kind of
 * thing that ends up ingesting into a live catalogue, and the cost of the tests
 * calling `registerCatalogSourceAdapter` themselves is one line each.
 *
 * ## It obeys the rules it is used to test
 *
 * It imports no repository, no database handle and no service — the isolation
 * gate scans this directory and would fail the build otherwise. It is therefore
 * also the worked example an adapter author copies: everything a provider
 * module is allowed to do is visible here, and everything it is not is absent
 * because it could not compile.
 */

import { CATALOG_REFRESH_MODES, type CatalogRefreshMode, type CatalogSourceKind } from '@mercaria/shared-types';
import {
  CatalogSourceFetchError,
  type AdapterFetchPage,
  type AdapterFetchRequest,
  type AdapterRecord,
  type AdapterRemoval,
  type CatalogSourceAdapter,
} from '../adapter.js';

/** What the fixture feed should do when asked for a page. */
export interface FixtureBehaviour {
  /** Fail this page with a classified error instead of answering. */
  readonly failWith?: CatalogSourceFetchError;
  /** Report this many rate-limit answers for the page. */
  readonly rateLimitHits?: number;
  /** Report the page as the last of a COMPLETE enumeration. */
  readonly complete?: boolean;
  /** Objects the source EXPLICITLY declares gone during this page (#68). */
  readonly removals?: readonly AdapterRemoval[];
}

export interface FixtureAdapterOptions {
  readonly provider: string;
  readonly kind?: CatalogSourceKind;
  readonly extraction?: boolean;
  /**
   * Which refresh modes this fixture declares (#68).
   *
   * Defaults to ALL of them, because most tests are about something else and a
   * fixture that refused three quarters of the scheduler's requests would make
   * every one of them assert the wrong thing. A test about capability says so
   * explicitly — which is the fixture rule the module docblock already states,
   * applied to the one field where "everything" is the convenient default and
   * "nothing" is the safe one.
   */
  readonly refreshModes?: readonly CatalogRefreshMode[];
  /** Pages, in order. The cursor is the index of the NEXT one. */
  readonly pages: readonly (readonly AdapterRecord[])[];
  /** Per-page behaviour, keyed by page index. */
  readonly behaviour?: Readonly<Record<number, FixtureBehaviour>>;
  /**
   * Whether the LAST page reports a complete enumeration. Default true.
   *
   * The one knob every retirement test needs: a feed that never claims
   * completeness must never retire anything, whatever else went right.
   */
  readonly completeOnLastPage?: boolean;
}

/** A fixture adapter plus the record of how it was called. */
export interface FixtureAdapter extends CatalogSourceAdapter {
  /** Every request the framework made, in order — the pagination assertions read it. */
  readonly requests: readonly AdapterFetchRequest[];
}

/**
 * Build an adapter over a fixed list of pages.
 *
 * The cursor is the decimal index of the next page and is deliberately opaque
 * to the framework, which stores and returns it without looking — that is the
 * contract, and a fixture whose cursor the framework understood would not test
 * it.
 */
export function createFixtureAdapter(options: FixtureAdapterOptions): FixtureAdapter {
  const requests: AdapterFetchRequest[] = [];
  const completeOnLastPage = options.completeOnLastPage ?? true;

  return {
    provider: options.provider,
    kind: options.kind ?? 'feed',
    extraction: options.extraction ?? false,
    refreshModes: options.refreshModes ?? CATALOG_REFRESH_MODES,
    requests,
    async fetchPage(request: AdapterFetchRequest): Promise<AdapterFetchPage> {
      requests.push(request);

      const index = request.cursor === null ? 0 : Number.parseInt(request.cursor, 10);
      if (!Number.isInteger(index) || index < 0 || index >= options.pages.length) {
        // An out-of-range cursor is a SCHEMA problem, not an outage: the
        // framework handed back something this feed cannot resolve, and
        // retrying it forever would be the wrong answer.
        throw new CatalogSourceFetchError('schema_drift', `Unknown cursor '${request.cursor}'`);
      }

      const behaviour = options.behaviour?.[index];
      if (behaviour?.failWith !== undefined) throw behaviour.failWith;

      const records = (options.pages[index] ?? []).slice(0, request.pageSize);
      const isLast = index === options.pages.length - 1;

      return {
        records,
        ...(behaviour?.removals === undefined ? {} : { removals: behaviour.removals }),
        nextCursor: isLast ? null : String(index + 1),
        complete: behaviour?.complete ?? (isLast && completeOnLastPage),
        fetchDurationMs: 1,
        rateLimitHits: behaviour?.rateLimitHits ?? 0,
      };
    },
  };
}

/**
 * A minimal well-formed record, for tests that care about one field.
 *
 * Every optional group is absent by default rather than zero-filled, which is
 * the fixture rule `~/Oxy/AGENTS.md` (E) states: a suite whose fixtures all sit
 * on the same side of a distinction cannot tell the strict reading from the
 * loose one. A caller that wants a price says so.
 */
export function fixtureRecord(
  overrides: Partial<AdapterRecord> & { externalId: string; title: string },
): AdapterRecord {
  const { externalId, title, ...rest } = overrides;
  return {
    externalType: 'offer',
    externalId,
    observedAt: new Date('2026-08-09T10:00:00.000Z'),
    raw: { id: externalId, name: title },
    normalized: {
      title,
      identifiers: [],
      options: [],
      media: [],
    },
    ...rest,
  };
}
