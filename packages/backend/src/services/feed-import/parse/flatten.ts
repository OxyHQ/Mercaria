/**
 * One JSON value → the flat `name → value` map every mapping reads.
 *
 * A feed's records are not flat and a mapping's `source_field` is one name, so
 * something has to reconcile the two. Dotted paths do it without inventing a
 * query language: `{"shipping":{"country":"ES"}}` is reachable as
 * `shipping.country`, which is a NAME a merchant can type into a mapping form,
 * where `$.shipping[0].country` would be an expression and this importer
 * evaluates none.
 *
 * ## Everything becomes a string, on purpose
 *
 * A feed's `"price": 19.99` and `"price": "19.99"` must map identically, and
 * every downstream validator already parses text (a CSV has nothing else). So a
 * number, a boolean and a string all arrive at the mapping layer as the same
 * kind of thing, and `19.99` is rendered by `String(...)` rather than
 * reformatted — a locale-aware render here would turn a price into `19,99` and
 * the money parser would refuse it.
 *
 * ## `null` is ABSENCE, not the string "null"
 *
 * A JSON null is a publisher saying "no value", which is exactly the state the
 * framework stores as absence (#62: "unknown is stored as absence, never
 * zero"). Rendering it would produce the four-character brand name `null` on
 * every unbranded product in the feed.
 */

import { addRawField, MAX_FLATTEN_DEPTH, type FeedParseOptions } from './types.js';

/**
 * Flatten one record value into the parser's field map.
 *
 * An ARRAY of primitives becomes a joined list under its own name, which is the
 * same representation a repeated XML element produces — so `split_list` reads
 * both without knowing which format it came from. An array of OBJECTS keeps its
 * index in the path (`variants.0.sku`), because those are genuinely different
 * things and joining them would produce a value nothing can use.
 */
export function flattenJsonRecord(
  value: unknown,
  options: Pick<FeedParseOptions, 'listSeparator'>,
): Map<string, string> {
  const fields = new Map<string, string>();
  visit(value, '', fields, options.listSeparator, 0);
  return fields;
}

function visit(
  value: unknown,
  path: string,
  fields: Map<string, string>,
  listSeparator: string,
  depth: number,
): void {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    const primitives = value.filter(isPrimitive);
    if (primitives.length === value.length) {
      if (value.length > 0 && path !== '') {
        addRawField(fields, path, primitives.map(renderPrimitive).join(listSeparator), listSeparator);
      }
      return;
    }
    if (depth >= MAX_FLATTEN_DEPTH) return;
    for (let position = 0; position < value.length; position += 1) {
      visit(value[position], path === '' ? String(position) : `${path}.${position}`, fields, listSeparator, depth + 1);
    }
    return;
  }

  if (typeof value === 'object') {
    if (depth >= MAX_FLATTEN_DEPTH) return;
    // `Object.entries` rather than `for…in`: it reads OWN enumerable keys only,
    // so a record whose publisher wrote `"__proto__"` contributes a field named
    // `__proto__` and changes nothing about any object in this process.
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      visit(child, path === '' ? key : `${path}.${key}`, fields, listSeparator, depth + 1);
    }
    return;
  }

  if (path !== '') addRawField(fields, path, renderPrimitive(value), listSeparator);
}

function isPrimitive(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function renderPrimitive(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}
