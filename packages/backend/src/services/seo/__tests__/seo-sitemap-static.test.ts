/**
 * The STATIC `sitemap.xml` — the flag-off floor, gated like `robots.txt` (#371).
 *
 * The storefront ships two crawl artefacts for the `SEO_ROUTES_ENABLED=false`
 * state, because that is what a crawler gets when the worker's proxy cannot
 * answer. `seo-robots.test.ts` gates one of them; this file gates the other,
 * which until #371 had no gate at all and was written by a build step.
 *
 * ## The bug this exists to keep out
 *
 * `packages/frontend/scripts/generate-sitemap.ts` ran from a `prebuild` hook on
 * every `bun run build:frontend` and stamped `new Date()` into the TRACKED
 * file, so a clean checkout could not stay clean through a build. Nothing was
 * wrong with the resulting diff, which is the danger: an agent or a script that
 * builds and then `git add -A` sweeps it into an unrelated commit, and every
 * gate stays green because the change is unintended rather than incorrect.
 *
 * So this file fails in three directions:
 *
 *  1. The artefact stops agreeing with the public route registry — the floor
 *     advertising a page that does not exist, or one `robots.txt` forbids.
 *  2. The modification date becomes unreadable, impossible or in the future.
 *  3. A build step starts regenerating it again. That is the REGRESSION gate,
 *     and it is the only one of the three that could have caught #371: the
 *     artefact was always well-formed and always agreed with the registry.
 *
 * Direction 3 reads another package's manifest, which is the same cross-package
 * reach `seo-robots.test.ts` already makes into `public/robots.txt` and for the
 * same reason — the storefront has no test runner, so a gate on a storefront
 * artefact has to live where one exists.
 *
 * Note what is deliberately NOT asserted: that the date is not TODAY. It would
 * fail on the one day somebody legitimately edits the file, and a gate whose
 * cheapest green is "wait until tomorrow" teaches people to skip it. Direction
 * 3 states the real property structurally instead.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEO_ROBOTS_DISALLOWED_PATHS } from '@mercaria/shared-types';
import { buildRoutePath, routeIsLive } from '../routes.js';

/** `packages/backend/src`, from `packages/backend/src/services/seo/__tests__`. */
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACKAGES_ROOT = join(SRC_ROOT, '..', '..');
const STATIC_SITEMAP = join(PACKAGES_ROOT, 'frontend', 'public', 'sitemap.xml');
const FRONTEND_MANIFEST = join(PACKAGES_ROOT, 'frontend', 'package.json');
const ORIGIN = 'https://mercaria.co';

interface SitemapEntry {
  readonly loc: string;
  readonly lastmod?: string;
}

/**
 * The URLs one sitemap advertises.
 *
 * Comments are stripped FIRST, and that is load-bearing rather than tidy: the
 * artefact this parses carries a long explanatory header, so a parser that read
 * the raw bytes would count whatever an author quoted there. `~/Oxy/AGENTS.md`
 * names the class — a census over source that does not exclude comments is
 * inflated by the prose written to explain it, most dangerously when that prose
 * is correcting somebody.
 */
function sitemapEntries(source: string): SitemapEntry[] {
  const body = source.replace(/<!--[\s\S]*?-->/gu, '');
  const entries: SitemapEntry[] = [];
  for (const block of body.matchAll(/<url>([\s\S]*?)<\/url>/gu)) {
    const inner = block[1] ?? '';
    const loc = /<loc>([\s\S]*?)<\/loc>/u.exec(inner)?.[1]?.trim();
    // A `<url>` with no `<loc>` is malformed, and skipping it would make the
    // "exactly one URL" assertion below pass by not seeing the second one.
    if (loc === undefined) throw new Error('a <url> block states no location');
    const lastmod = /<lastmod>([\s\S]*?)<\/lastmod>/u.exec(inner)?.[1]?.trim();
    entries.push(lastmod === undefined ? { loc } : { loc, lastmod });
  }
  return entries;
}

/**
 * One `YYYY-MM-DD` day, or `undefined` when the text does not spell a real one.
 *
 * The round trip is the check: `new Date('2026-02-31')` is happily 3 March, so
 * a shape test alone accepts a day that does not exist.
 */
function parseIsoDay(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10) === value ? parsed : undefined;
}

/** The frontend package's declared scripts. */
function frontendScripts(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(FRONTEND_MANIFEST, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return manifest.scripts ?? {};
}

describe('the parser measures something — the mutation self-tests', () => {
  it('reads every URL, so "exactly one" is a real count', () => {
    const two = sitemapEntries(
      '<urlset><url><loc>https://a.example/</loc></url>' +
        '<url><loc>https://b.example/</loc><lastmod>2026-01-02</lastmod></url></urlset>',
    );
    expect(two).toEqual([
      { loc: 'https://a.example/' },
      { loc: 'https://b.example/', lastmod: '2026-01-02' },
    ]);
  });

  it('reports an EMPTY document as empty rather than as agreement', () => {
    // The usual way a sitemap check fails: it passes against a file with
    // nothing in it. Every assertion below rests on this returning [] here.
    expect(sitemapEntries('')).toEqual([]);
    expect(sitemapEntries('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>')).toEqual(
      [],
    );
  });

  it('does not read a URL out of a comment', () => {
    expect(sitemapEntries('<!-- <url><loc>https://ghost.example/</loc></url> --><urlset></urlset>')).toEqual(
      [],
    );
  });

  it('refuses a `<url>` that states no location', () => {
    expect(() => sitemapEntries('<urlset><url><lastmod>2026-01-02</lastmod></url></urlset>')).toThrow();
  });

  it('accepts only days that exist', () => {
    // The impossible days are pinned to a deliberately OLD year, and that is
    // not tidiness: `fixture-date-census.test.ts` (#253) compares date literals
    // LEXICALLY, so a month-13 day in the CURRENT year sorts after today and
    // reads to it as a fixture the clock is moving toward. An out-of-range
    // month proves the same thing in a year long past and trips nothing. Do
    // not "refresh" these to the current year — and do not quote a flagged
    // literal in a comment here either, because that census reads comments too.
    expect(parseIsoDay('2020-07-07')).toBeInstanceOf(Date);
    expect(parseIsoDay('2020-02-31')).toBeUndefined();
    expect(parseIsoDay('2020-13-01')).toBeUndefined();
    expect(parseIsoDay('7 July 2020')).toBeUndefined();
    expect(parseIsoDay('')).toBeUndefined();
  });
});

describe('DIRECTION 1: the floor advertises what the registry says it may', () => {
  const source = readFileSync(STATIC_SITEMAP, 'utf8');
  const entries = sitemapEntries(source);

  it('reads a real artefact — the vacuity floor', () => {
    // A moved, emptied or unparsed file must fail HERE rather than make every
    // assertion below pass against an empty list.
    expect(source.length, 'the static sitemap is empty or missing').toBeGreaterThan(200);
    expect(source).toContain('<urlset');
    expect(entries.length, 'the static sitemap advertises no URL at all').toBeGreaterThanOrEqual(1);
  });

  it('advertises exactly the home page', () => {
    // The floor deliberately does not enumerate the catalogue: a build-time
    // listing would be a second sitemap authority that cannot apply the
    // indexability policy. The API's index is the one that lists collections.
    expect(entries.map((entry) => entry.loc)).toEqual([`${ORIGIN}${buildRoutePath('home')}`]);
  });

  it('advertises a route a screen actually serves', () => {
    // A sitemap URL for a `planned` route is a crawl budget spent on "This
    // screen does not exist".
    expect(routeIsLive('home')).toBe(true);
  });

  it('never advertises a path `robots.txt` forbids fetching', () => {
    // The contradiction `seo-robots.test.ts` guards on the rendered side, held
    // here for the static floor — the two artefacts ship together and a crawler
    // that cannot reach the API reads both of them.
    expect(SEO_ROBOTS_DISALLOWED_PATHS.length).toBeGreaterThanOrEqual(10);
    for (const entry of entries) {
      const path = entry.loc.slice(ORIGIN.length);
      for (const disallowed of SEO_ROBOTS_DISALLOWED_PATHS) {
        expect(
          path.startsWith(disallowed),
          `the sitemap advertises ${path}, which robots.txt disallows`,
        ).toBe(false);
      }
    }
  });
});

describe('DIRECTION 2: the modification date is a fixed, possible day', () => {
  const entries = sitemapEntries(readFileSync(STATIC_SITEMAP, 'utf8'));

  it('states one readable day per URL', () => {
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const entry of entries) {
      const stated = entry.lastmod;
      expect(stated, `${entry.loc} states no modification date`).toBeDefined();
      expect(parseIsoDay(stated ?? ''), `${entry.loc} states '${stated}', which is not a day`).toBeInstanceOf(
        Date,
      );
    }
  });

  it('never claims a day that has not happened', () => {
    // A future date is what a clock-skewed or hand-fumbled edit produces, and a
    // crawler reading one has no reason to believe any date in the file.
    const now = Date.now();
    for (const entry of entries) {
      const day = parseIsoDay(entry.lastmod ?? '');
      expect(day?.getTime() ?? 0, `${entry.loc} states a date in the future`).toBeLessThanOrEqual(now);
    }
  });
});

describe('DIRECTION 3: no build step regenerates the tracked artefact', () => {
  const scripts = frontendScripts();

  it('reads the real manifest — the vacuity floor', () => {
    // A renamed or moved package.json must fail HERE rather than make the two
    // assertions below pass against an empty script map.
    expect(Object.keys(scripts).length, 'the frontend manifest declares no scripts').toBeGreaterThanOrEqual(
      5,
    );
    expect(scripts.build, 'the frontend manifest declares no build script').toBeDefined();
  });

  it('hangs no lifecycle hook off the build', () => {
    // bun runs `prebuild` and `postbuild` around `bun run build`, so a script
    // under either name writes into the source tree on every build and every
    // CI job, invisibly. #371 was exactly this. A native `expo prebuild` wants
    // a name that is not a hook — `prebuild:native` — or it fires on export.
    expect(scripts.prebuild, 'a `prebuild` hook runs before every build').toBeUndefined();
    expect(scripts.postbuild, 'a `postbuild` hook runs after every build').toBeUndefined();
  });

  it('declares no script that writes the sitemap', () => {
    const writers = Object.entries(scripts).filter(
      ([name, command]) => /sitemap/iu.test(name) || /sitemap/iu.test(command),
    );
    expect(writers, 'a package script regenerates the tracked sitemap').toEqual([]);
  });
});
