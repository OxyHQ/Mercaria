/**
 * The `<head>` fragment (#75 rendered-metadata rule 7: "no client-only metadata
 * dependency for indexable pages").
 *
 * ## Why the BACKEND renders the markup
 *
 * The Cloudflare Worker is where the HTML is assembled, but it is plain
 * JavaScript with no type-checker and no test runner in this repository. Every
 * decision that can be got wrong — which tags, which order, what is escaped,
 * whether a `noindex` page carries structured data — is made here, where `tsc`
 * and vitest reach it, and the worker performs one string operation it is
 * scanned for.
 *
 * That also makes the no-JavaScript render check real rather than nominal:
 * `seo-no-js-render.test.ts` takes the storefront's own shell, runs the
 * worker's own injector over this module's own output, and reads the metadata
 * out of the result with no script having executed.
 *
 * ## Escaping
 *
 * Text and attribute values go through {@link escapeHtml}; JSON-LD goes through
 * {@link escapeJsonLd}, which neutralises `<` rather than escaping the whole
 * document — a `</script>` inside a product description would otherwise close
 * the block and turn the rest of the payload into markup. Both are exercised by
 * a test with a hostile fixture, because "we escape" is the kind of claim that
 * is true until somebody adds a tag.
 */

import type { SeoDocument } from '@mercaria/shared-types';

/** HTML-escape a value for use as text or inside a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/**
 * Serialise a JSON-LD node for embedding in a `<script type="application/ld+json">`.
 *
 * `<` becomes `<`, which JSON parsers read identically and an HTML parser
 * cannot mistake for a tag. Escaping the ampersands and quotes instead would
 * corrupt the JSON; escaping nothing would let a description containing
 * `</script>` end the block early.
 */
export function escapeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, '\\u003c');
}

function metaName(name: string, content: string): string {
  return `<meta name="${escapeHtml(name)}" content="${escapeHtml(content)}">`;
}

function metaProperty(property: string, content: string): string {
  return `<meta property="${escapeHtml(property)}" content="${escapeHtml(content)}">`;
}

/**
 * Render the complete `<head>` fragment for one document.
 *
 * Returns markup with no surrounding whitespace and no `<head>` element of its
 * own: the worker appends it to the shell's existing head after removing the
 * tags it replaces, so exactly one `<title>`, one canonical link and one
 * description survive.
 *
 * The ORDER is stable — title, description, robots, canonical, alternates,
 * Open Graph, Twitter, JSON-LD — because a diff of two renders should show what
 * changed rather than a reshuffle.
 */
export function renderSeoHead(document: SeoDocument): string {
  const parts: string[] = [`<title>${escapeHtml(document.title)}</title>`];

  if (document.description !== undefined) {
    parts.push(metaName('description', document.description));
  }
  parts.push(metaName('robots', document.robots));
  parts.push(`<link rel="canonical" href="${escapeHtml(document.canonicalUrl)}">`);

  for (const alternate of document.localeAlternates) {
    parts.push(
      `<link rel="alternate" hreflang="${escapeHtml(alternate.hreflang)}" ` +
        `href="${escapeHtml(alternate.href)}">`,
    );
  }

  const sharing = document.sharing;
  parts.push(metaProperty('og:type', sharing.type));
  parts.push(metaProperty('og:site_name', sharing.siteName));
  parts.push(metaProperty('og:title', sharing.title));
  if (sharing.description !== undefined) {
    parts.push(metaProperty('og:description', sharing.description));
  }
  parts.push(metaProperty('og:url', sharing.url));
  if (sharing.imageUrl !== undefined) parts.push(metaProperty('og:image', sharing.imageUrl));

  parts.push(
    metaName('twitter:card', sharing.imageUrl === undefined ? 'summary' : 'summary_large_image'),
  );
  parts.push(metaName('twitter:title', sharing.title));
  if (sharing.description !== undefined) {
    parts.push(metaName('twitter:description', sharing.description));
  }
  if (sharing.imageUrl !== undefined) parts.push(metaName('twitter:image', sharing.imageUrl));

  for (const node of document.structuredData) {
    parts.push(
      `<script type="application/ld+json">${escapeJsonLd(node)}</script>`,
    );
  }

  return parts.join('');
}
