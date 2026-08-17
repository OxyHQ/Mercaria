import type { SeoJsonLdNode } from '@mercaria/shared-types';

/**
 * Rendering the SEO registry's own JSON-LD (#367 workstream 9: "add structured
 * data mappings based on normalized facts, not arbitrary seller text").
 *
 * ## The mapping is the SERVER's and this is only its embedding
 *
 * `SeoDocument.structuredData` is composed by `services/seo/document.ts` from
 * the facts the page actually displays, and #75's own contract states it is
 * EMPTY whenever `indexable` is false — so "a page policy has withdrawn cannot
 * become an indexing signal" is already true before this function is reached.
 * Composing a node here from a listing title or a seller's description would be
 * exactly the arbitrary seller text the criterion excludes, and there is no
 * parameter through which one could arrive: the input is the document's own
 * array.
 *
 * ## The escaping is load-bearing, and `JSON.stringify` does not do it
 *
 * A JSON-LD payload is embedded in a `<script>` element and carries catalogue
 * text Mercaria did not author. `JSON.stringify` escapes neither `<` nor `>`,
 * so a category named `</script><script>…` would close this tag and open one of
 * its own. Escaping the three characters that can terminate a script element
 * into their `\uXXXX` forms produces byte-identical JSON to a parser and inert
 * text to an HTML tokenizer, which is the standard safe embedding — and it is
 * the same escaping `app/(app)/brands/[handle].tsx` already performs, for the
 * same reason.
 */
export function renderJsonLd(nodes: readonly SeoJsonLdNode[]): string | undefined {
  if (nodes.length === 0) return undefined;
  // A single node stays a single object rather than a one-element array: both
  // are valid JSON-LD and the object form is what every consumer's examples
  // show, so it is the one less likely to be mishandled.
  const body = nodes.length === 1 ? nodes[0] : nodes;
  return JSON.stringify(body)
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/&/gu, '\\u0026');
}
