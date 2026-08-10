/**
 * The no-JavaScript render check (#75 validation rule 2, rendered-metadata rule
 * 7: "no client-only metadata dependency for indexable pages").
 *
 * ## What makes this a real check rather than a nominal one
 *
 * It imports the STOREFRONT WORKER's own `injectSeoHead` — the exact function
 * Cloudflare runs — and drives it over the exact `<head>` fragment the API
 * produces, against a shell built from the storefront's own `app/+html.tsx`.
 * Nothing is executed: the assertions read the resulting HTML as TEXT, which is
 * what a crawler that runs no JavaScript sees.
 *
 * Importing a plain `.js` file from another package into a backend test is the
 * #92 precedent applied one step further: the storefront has no test runner, so
 * the gate lives where one exists. `product-page-isolation.test.ts` already
 * SCANS storefront files from here; this one runs one, because a scan cannot
 * tell whether a string operation produces valid markup.
 *
 * ## The shell fixture
 *
 * Built from the real `+html.tsx` rather than hand-written, so a tag added
 * there — a second description, another `og:` property, a new JSON-LD block —
 * appears in this fixture on the next run and has to be handled. A hand-written
 * fixture would go on passing while the real shell grew a competing title.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SeoIndexability, SeoVisibleFacts } from '@mercaria/shared-types';
// The storefront's Cloudflare Worker, imported as the module it is.
import { injectSeoHead, isDocumentRequest } from '../../../../../frontend/public/_worker.js';
import { composeDocument } from '../document.js';
import { renderSeoHead } from '../head.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STOREFRONT_ROOT = join(SRC_ROOT, '..', '..', 'frontend');
const HTML_COMPONENT = join(STOREFRONT_ROOT, 'app', '+html.tsx');

const ORIGIN = 'https://mercaria.co';
const INDEXABLE: SeoIndexability = { outcome: 'indexable' };

/**
 * The head tags the real `+html.tsx` emits, extracted from its source.
 *
 * A crude extraction on purpose: what matters is that the COMPETING tags —
 * `meta name="description"`, every `og:`/`twitter:` property, the shell's own
 * JSON-LD — arrive in the fixture, and every one of those is written as a
 * single-line JSX attribute pair or a recognisable block. The counts asserted
 * below are the floor that stops a failed extraction reading as a clean run.
 */
function shellHead(): string {
  const source = readFileSync(HTML_COMPONENT, 'utf8');
  const tags: string[] = ['<title>Mercaria</title>'];

  for (const match of source.matchAll(/<meta\s+([\s\S]*?)\/>/gu)) {
    const attributes = (match[1] ?? '')
      .replace(/\{['"]([^'"]*)['"]\}/gu, '"$1"')
      .replace(/\s+/gu, ' ')
      .trim();
    tags.push(`<meta ${attributes}>`);
  }
  for (const match of source.matchAll(/<link\s+([\s\S]*?)\/>/gu)) {
    const attributes = (match[1] ?? '').replace(/\s+/gu, ' ').trim();
    tags.push(`<link ${attributes}>`);
  }
  // The shell's own WebApplication node, as the browser receives it.
  tags.push(
    '<script type="application/ld+json">' +
      JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebApplication', name: 'Mercaria' }) +
      '</script>',
  );
  return tags.join('\n    ');
}

/** The whole document Cloudflare's asset pipeline serves for a navigation. */
function shellDocument(): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '  <head>',
    `    ${shellHead()}`,
    '  </head>',
    '  <body><div id="root"></div><script src="/_expo/static/js/web/entry-abc.js" defer></script></body>',
    '</html>',
  ].join('\n');
}

function productDocument() {
  const facts: SeoVisibleFacts = {
    title: 'iPhone 16 Pro',
    entityName: 'iPhone 16 Pro',
    description: 'The 2026 flagship, in titanium, with the best camera Apple has shipped.',
    imageUrls: ['https://cdn.example/a.jpg'],
    breadcrumbs: [
      { name: 'Home', path: '/' },
      { name: 'iPhone 16 Pro', path: '/p/iphone-16-pro' },
    ],
    brandName: 'Apple',
    gtins: ['00190199000000'],
    offers: [
      {
        offerId: 'offer-native',
        checkout: { kind: 'mercaria', url: '/p/iphone-16-pro?variant=cv-1' },
        price: { known: true, amount: 129_900, currency: 'EUR' },
        availability: { known: true, schema: 'https://schema.org/InStock' },
        sellerName: 'Acme Electronics',
        conditionKey: 'new',
      },
    ],
    offerCurrency: 'EUR',
    variantNames: [],
  };
  return composeDocument({
    routeId: 'canonical_product',
    facts,
    canonicalUrl: `${ORIGIN}/p/iphone-16-pro`,
    origin: ORIGIN,
    indexability: INDEXABLE,
  });
}

describe('the shell fixture is the real one — the vacuity floor', () => {
  it('extracts the competing tags from the storefront’s own +html.tsx', () => {
    const head = shellHead();
    // Floors on both counts. A failed extraction would make every removal
    // assertion below pass against a document that never had the tag.
    expect((head.match(/<meta /gu) ?? []).length).toBeGreaterThanOrEqual(15);
    expect((head.match(/<link /gu) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(head).toContain('name="description"');
    expect(head).toContain('property="og:title"');
    expect(head).toContain('property="twitter:title"');
    expect(head).toContain('application/ld+json');
    expect(shellDocument()).toContain('</head>');
  });
});

describe('rendering one product page without JavaScript', () => {
  const rendered = injectSeoHead(shellDocument(), renderSeoHead(productDocument()));

  it('carries the page’s own title, and only it', () => {
    const titles = rendered.match(/<title>([\s\S]*?)<\/title>/gu) ?? [];
    expect(titles).toHaveLength(1);
    expect(titles[0]).toBe('<title>iPhone 16 Pro — Mercaria</title>');
  });

  it('carries exactly one description, and it is the product’s', () => {
    const descriptions = [...rendered.matchAll(/<meta name="description" content="([^"]*)"/gu)];
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]?.[1]).toContain('The 2026 flagship');
  });

  it('carries exactly one canonical link, pointing at the product', () => {
    const canonicals = [...rendered.matchAll(/<link rel="canonical" href="([^"]*)"/gu)];
    expect(canonicals).toHaveLength(1);
    expect(canonicals[0]?.[1]).toBe('https://mercaria.co/p/iphone-16-pro');
  });

  it('carries the robots directive', () => {
    expect(rendered).toContain('<meta name="robots" content="index,follow,max-image-preview:large">');
  });

  it('carries the page’s Open Graph facts and none of the shell’s', () => {
    const ogTitles = [...rendered.matchAll(/<meta property="og:title" content="([^"]*)"/gu)];
    expect(ogTitles).toHaveLength(1);
    expect(ogTitles[0]?.[1]).toBe('iPhone 16 Pro — Mercaria');
    const ogUrls = [...rendered.matchAll(/<meta property="og:url" content="([^"]*)"/gu)];
    expect(ogUrls).toHaveLength(1);
    expect(ogUrls[0]?.[1]).toBe('https://mercaria.co/p/iphone-16-pro');
    // The shell's generic sharing card must be gone, not merely outnumbered.
    expect(rendered).not.toContain('content="https://mercaria.co/"');
  });

  it('carries exactly the structured data the document composed', () => {
    const blocks = [
      ...rendered.matchAll(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu,
      ),
    ];
    expect(blocks).toHaveLength(productDocument().structuredData.length);
    const types = blocks.map((block) => JSON.parse(block[1] ?? '{}')['@type']);
    expect(types).toEqual(['Product', 'BreadcrumbList']);
    // The shell's own WebApplication node is REPLACED, not appended to.
    expect(rendered).not.toContain('WebApplication');
  });

  it('the structured data parses and states the price', () => {
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u.exec(rendered);
    const product = JSON.parse(block?.[1] ?? '{}');
    expect(product.name).toBe('iPhone 16 Pro');
    expect(product.offers.price).toBe('1299.00');
    expect(product.offers.priceCurrency).toBe('EUR');
  });

  it('leaves the shell’s non-metadata head intact', () => {
    // The viewport, the manifest and the icons are the app's, not this
    // domain's, and a splice that removed them would break the PWA.
    expect(rendered).toContain('name="viewport"');
    expect(rendered).toContain('rel="manifest"');
    expect(rendered).toContain('rel="apple-touch-icon"');
    expect(rendered).toContain('charSet="utf-8"');
  });

  it('leaves the body untouched', () => {
    expect(rendered).toContain('<div id="root"></div>');
    expect(rendered).toContain('/_expo/static/js/web/entry-abc.js');
  });

  it('adds no script other than the structured-data blocks', () => {
    const added = (rendered.match(/<script/gu) ?? []).length;
    const original = (shellDocument().match(/<script/gu) ?? []).length;
    // Two ld+json blocks in, one shell ld+json block out.
    expect(added).toBe(original + 1);
  });
});

describe('a noindex page renders without an indexing signal', () => {
  it('says noindex and carries no structured data at all', () => {
    const document = composeDocument({
      routeId: 'canonical_product',
      facts: {
        title: 'Stub',
        entityName: 'Stub',
        imageUrls: [],
        breadcrumbs: [],
        gtins: [],
        offers: [],
        variantNames: [],
      },
      canonicalUrl: `${ORIGIN}/p/stub`,
      origin: ORIGIN,
      indexability: { outcome: 'refused', reason: 'thin_content' },
    });
    const rendered = injectSeoHead(shellDocument(), renderSeoHead(document));
    expect(rendered).toContain('<meta name="robots" content="noindex,follow">');
    expect(rendered).not.toContain('application/ld+json');
  });
});

describe('the injector FAILS OPEN', () => {
  it('returns the document unchanged when there is no </head>', () => {
    const fragment = '<div>not a document</div>';
    expect(injectSeoHead(fragment, '<title>x</title>')).toBe(fragment);
  });

  it('returns the document unchanged for an empty or absent head fragment', () => {
    const shell = shellDocument();
    expect(injectSeoHead(shell, '')).toBe(shell);
    expect(injectSeoHead(shell, undefined)).toBe(shell);
  });

  it('is idempotent — a second injection produces the same document', () => {
    const head = renderSeoHead(productDocument());
    const once = injectSeoHead(shellDocument(), head);
    expect(injectSeoHead(once, head)).toBe(once);
  });
});

describe('which requests the worker pays for a lookup on', () => {
  const htmlRequest = (path: string, init: RequestInit = {}): Request =>
    new Request(`https://mercaria.co${path}`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
      ...init,
    });

  it('accepts a navigation', () => {
    expect(isDocumentRequest(htmlRequest('/p/iphone'), '/p/iphone')).toBe(true);
  });

  it('refuses an API call from the app itself', () => {
    const request = new Request('https://mercaria.co/p/iphone', {
      headers: { accept: 'application/json' },
    });
    expect(isDocumentRequest(request, '/p/iphone')).toBe(false);
  });

  it('refuses a static asset and a non-GET method', () => {
    expect(isDocumentRequest(htmlRequest('/_expo/static/js/web/a.js'), '/_expo/static/js/web/a.js')).toBe(
      false,
    );
    expect(isDocumentRequest(htmlRequest('/p/x', { method: 'POST' }), '/p/x')).toBe(false);
  });
});
