/**
 * `robots.txt` — TWO artefacts, ONE list (#75 sitemap rule 4).
 *
 * The API renders the served file from `SEO_ROBOTS_DISALLOWED_PATHS`; the
 * storefront ships a STATIC copy for the `SEO_ROUTES_ENABLED=false` state,
 * because that is what a crawler gets when the worker's proxy cannot answer.
 * Two files is one more than anybody wants, and the answer is not to delete one
 * but to gate them — this file parses the static asset and fails the build when
 * its `Disallow` set differs from the rendered one.
 *
 * `~/Oxy/AGENTS.md` names the class of bug: `docs/`, comments and static
 * artefacts are where a wrong statement survives forever, because nothing
 * recomputes them.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEO_ROBOTS_DISALLOWED_PATHS } from '@mercaria/shared-types';
import { renderRobotsTxt } from '../robots.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STATIC_ROBOTS = join(SRC_ROOT, '..', '..', 'frontend', 'public', 'robots.txt');
const ORIGIN = 'https://mercaria.co';

/**
 * The `Disallow` paths one `robots.txt` states for the `*` user agent.
 *
 * Parsed rather than grepped: a file with a `Disallow: /` under a scraper's
 * name and an open `*` group means the opposite of a file with them swapped,
 * and a flat grep for `Disallow:` cannot tell the two apart.
 */
function disallowedForEveryone(source: string): string[] {
  const paths: string[] = [];
  let inWildcardGroup = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const agent = /^user-agent:\s*(.+)$/i.exec(line);
    if (agent) {
      inWildcardGroup = (agent[1] ?? '').trim() === '*';
      continue;
    }
    const disallow = /^disallow:\s*(.*)$/i.exec(line);
    if (disallow && inWildcardGroup) paths.push((disallow[1] ?? '').trim());
  }
  return paths;
}

describe('the two artefacts agree', () => {
  it('the static asset states exactly the shared disallow list', () => {
    const source = readFileSync(STATIC_ROBOTS, 'utf8');
    // Vacuity floor: an empty or unparsed file must fail here rather than make
    // the comparison below pass against two empty lists.
    expect(source.length).toBeGreaterThan(200);
    expect(SEO_ROBOTS_DISALLOWED_PATHS.length).toBeGreaterThanOrEqual(10);

    expect(disallowedForEveryone(source)).toEqual([...SEO_ROBOTS_DISALLOWED_PATHS]);
  });

  it('the rendered file states exactly the shared disallow list', () => {
    expect(disallowedForEveryone(renderRobotsTxt(ORIGIN))).toEqual([
      ...SEO_ROBOTS_DISALLOWED_PATHS,
    ]);
  });

  it('the parser actually parses — the mutation self-test', () => {
    // A `Disallow` under another agent must NOT be read as a wildcard rule; a
    // parser that missed the grouping would report the scrapers' `/` here and
    // the comparison above would be measuring the wrong thing.
    expect(
      disallowedForEveryone('User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nDisallow: /cart\n'),
    ).toEqual(['/cart']);
    expect(disallowedForEveryone('User-agent: *\nAllow: /\n')).toEqual([]);
  });
});

describe('the rendered file', () => {
  const rendered = renderRobotsTxt(ORIGIN);

  it('refuses the commercial scrapers outright', () => {
    expect(rendered).toMatch(/User-agent: AhrefsBot[\s\S]*?Disallow: \/\n/u);
  });

  it('names one absolute sitemap URL', () => {
    const sitemaps = [...rendered.matchAll(/^Sitemap:\s*(.+)$/gmu)].map((match) => match[1]);
    expect(sitemaps).toEqual(['https://mercaria.co/sitemap.xml']);
  });

  it('allows the catalogue', () => {
    expect(rendered).toContain('User-agent: *\nAllow: /');
  });

  it('keeps the affiliate redirect and the operator surface out', () => {
    // #75 sitemap rule 5: a crawler following `/out/` spends Mercaria's crawl
    // budget on somebody else's site and books an affiliate click nobody made.
    expect(SEO_ROBOTS_DISALLOWED_PATHS).toContain('/out/');
    expect(SEO_ROBOTS_DISALLOWED_PATHS).toContain('/internal/');
    expect(SEO_ROBOTS_DISALLOWED_PATHS).toContain('/search');
  });

  it('never disallows a route the sitemap advertises', () => {
    // The contradiction that costs a crawl budget: a URL in a sitemap that
    // `robots.txt` forbids fetching.
    for (const path of SEO_ROBOTS_DISALLOWED_PATHS) {
      expect(['/p/', '/products/', '/stores/', '/brands/', '/merchants/']).not.toContain(path);
    }
  });
});
