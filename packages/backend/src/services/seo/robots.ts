/**
 * `robots.txt` (#75 sitemap rules 4 and 5) — rendered from ONE list.
 *
 * ## Two artefacts, one authority
 *
 * The served file is composed here from `SEO_ROBOTS_DISALLOWED_PATHS`. The
 * storefront also ships a STATIC `public/robots.txt`, which is what a browser
 * gets when `SEO_ROUTES_ENABLED` is off and the worker's lookup fails — the
 * flag-off floor. Two files is one more than anybody wants, and the answer is
 * not to delete one but to gate them: `seo-robots.test.ts` reads the static
 * asset and fails when its `Disallow` set differs from this module's, so they
 * cannot drift.
 *
 * ## What is disallowed, and why each one
 *
 * The list itself is in `@mercaria/shared-types` with a reason beside every
 * entry. The three that matter most:
 *
 *  - **`/out/`** — #37's affiliate redirect. A crawler following one spends
 *    Mercaria's crawl budget on somebody else's site and books an affiliate
 *    click nobody made. #75 sitemap rule 5 asks that affiliate links be marked
 *    per current guidance; `Disallow` plus `rel="sponsored nofollow"` on the
 *    link itself is that guidance, and the second half is #37's to add when the
 *    route exists — there is no outbound link on any page today.
 *  - **`/search`** — internal search results. Infinite, thin, and a duplicate
 *    of the browse pages by construction.
 *  - **`/internal/`** — operator surfaces. Behind an allow-list already; a
 *    crawler has no business learning that they exist.
 *
 * ## `Disallow` is not `noindex`
 *
 * A disallowed URL can still be indexed from an external link, without its
 * content. That is acceptable for the funnel and the operator paths — nobody
 * links to them — and it is the reason the indexability policy exists
 * separately: the pages that must not be indexed say so in their own `<head>`,
 * which requires the crawler to be ALLOWED to fetch them.
 */

import { SEO_ROBOTS_DISALLOWED_PATHS } from '@mercaria/shared-types';

/**
 * Crawlers Mercaria refuses outright.
 *
 * Commercial SEO scrapers, not search engines: they crawl aggressively, index
 * nothing a shopper will ever see, and their traffic is indistinguishable from
 * a competitor mirroring the catalogue.
 */
const REFUSED_USER_AGENTS: readonly string[] = [
  'AhrefsBot',
  'SemrushBot',
  'MJ12bot',
  'DotBot',
  'BLEXBot',
];

/**
 * Render `robots.txt`.
 *
 * `origin` is the public web origin — the `Sitemap:` line must be an absolute
 * URL, and it is the only place in the file one appears.
 */
export function renderRobotsTxt(origin: string): string {
  const lines: string[] = [
    '# Mercaria by Oxy',
    '# Served by the API (#75). The storefront ships a static copy for the',
    '# SEO_ROUTES_ENABLED=false state; a test keeps the two in step.',
    '',
  ];

  for (const agent of REFUSED_USER_AGENTS) lines.push(`User-agent: ${agent}`);
  lines.push('Disallow: /', '');

  lines.push('User-agent: *');
  lines.push('Allow: /');
  for (const path of SEO_ROBOTS_DISALLOWED_PATHS) lines.push(`Disallow: ${path}`);
  lines.push('');

  lines.push(`Sitemap: ${new URL('/sitemap.xml', origin).toString()}`);
  lines.push('');
  return lines.join('\n');
}
