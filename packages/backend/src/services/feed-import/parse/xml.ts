/**
 * Streaming XML — the record elements at a path, with namespaces stripped and
 * entity declarations REFUSED (#63 §"Supported inputs" 2, acceptance 3,
 * security 4).
 *
 * ## No XML parser was added to the dependency tree, and that is the security
 * decision
 *
 * A general XML parser is a large attack surface whose defaults are wrong for
 * this job: external entities, parameter entities, DTD-driven defaulting and
 * billion-laughs expansion are all FEATURES of XML that a product feed has no
 * use for and that a stranger's file is exactly the wrong place to enable.
 * This scanner implements the subset a feed needs — elements, attributes, text,
 * CDATA, the five predefined entities and numeric character references — and
 * REFUSES any `<!…>` declaration outright, so `<!DOCTYPE`, `<!ENTITY` and their
 * relatives are a `entity_declaration_refused` rather than something a flag
 * disables. A feed does not need a DTD; a merchant whose exporter emits one is
 * told so.
 *
 * ## Namespaces are stripped to LOCAL names
 *
 * A Google Merchant XML feed publishes `<g:price>` under
 * `xmlns:g="http://base.google.com/ns/1.0"`, and a merchant mapping it types
 * `price`. Prefixes are stripped and the URI is not resolved: this scanner has
 * no namespace-aware model at all, so two different `g:` bindings in one
 * document would collide — which no feed does, and which is a far smaller
 * hazard than the DTD machinery a namespace-aware parser drags in.
 *
 * ## A repeated child is a LIST
 *
 * Three `<g:additional_image_link>` elements produce one field joined by the
 * configuration's list separator, which is exactly what `split_list` reads
 * back. Last-one-wins would silently discard every image but the last.
 */

import { FeedImportRefusal } from '../errors.js';
import { addRawField, MAX_FLATTEN_DEPTH, type FeedParseOptions, type FeedRawRecord } from './types.js';

/** What the scanner emits. Elements, their attributes, and their text. */
type XmlEvent =
  | {
      readonly kind: 'start';
      readonly name: string;
      readonly attributes: ReadonlyMap<string, string>;
      readonly selfClosing: boolean;
    }
  | { readonly kind: 'end'; readonly name: string }
  | { readonly kind: 'text'; readonly value: string };

export async function* parseXmlFeed(
  text: AsyncIterable<string>,
  options: FeedParseOptions,
): AsyncGenerator<FeedRawRecord> {
  const target = normalizeRecordPath(options.recordPath);
  if (target.length === 0) {
    throw new FeedImportRefusal(
      'configuration_incomplete',
      'An XML feed must state the record path naming the element each product is published in.',
    );
  }
  const recordName = target[target.length - 1] ?? '';

  const stack: string[] = [];
  let capturing = false;
  /** The path INSIDE the record element, so `<shipping><country>` is `shipping.country`. */
  const inner: string[] = [];
  let fields = new Map<string, string>();
  let textBuffer = '';
  let recordChars = 0;
  let index = 0;
  let emitted = 0;
  let found = false;

  function fieldPath(): string {
    return inner.join('.');
  }

  for await (const event of scanXml(text)) {
    if (event.kind === 'text') {
      if (capturing && inner.length > 0) {
        textBuffer += event.value;
        recordChars += event.value.length;
        if (recordChars > options.maxRecordBytes) {
          throw new FeedImportRefusal(
            'record_too_large',
            `An XML record exceeded the ${options.maxRecordBytes}-character limit.`,
          );
        }
      }
      continue;
    }

    if (event.kind === 'start') {
      if (!capturing) {
        stack.push(event.name);
        if (matchesTail(stack, target)) {
          found = true;
          capturing = true;
          inner.length = 0;
          fields = new Map<string, string>();
          textBuffer = '';
          recordChars = 0;
          addAttributes(fields, '', event.attributes, options.listSeparator);
          if (event.selfClosing) {
            // A record element with only attributes is a legitimate record.
            emitted += 1;
            assertRecordBudget(emitted, options);
            yield { index, fields };
            index += 1;
            capturing = false;
            stack.pop();
          }
        } else if (event.selfClosing) {
          stack.pop();
        }
        continue;
      }

      if (inner.length < MAX_FLATTEN_DEPTH) {
        inner.push(event.name);
        textBuffer = '';
        addAttributes(fields, fieldPath(), event.attributes, options.listSeparator);
        if (event.selfClosing) inner.pop();
      } else if (!event.selfClosing) {
        // Past the flatten depth the element is still TRACKED, so its close
        // does not pop somebody else's frame — it simply contributes no field.
        inner.push(event.name);
      }
      continue;
    }

    // ── end ────────────────────────────────────────────────────────────────
    if (!capturing) {
      if (stack.length > 0) stack.pop();
      continue;
    }

    if (inner.length === 0) {
      if (event.name === recordName) {
        emitted += 1;
        assertRecordBudget(emitted, options);
        yield { index, fields };
        index += 1;
        capturing = false;
        stack.pop();
      }
      continue;
    }

    const path = fieldPath();
    const value = textBuffer.trim();
    if (value !== '' && inner.length <= MAX_FLATTEN_DEPTH) {
      addRawField(fields, path, value, options.listSeparator);
    }
    textBuffer = '';
    inner.pop();
  }

  if (!found) {
    throw new FeedImportRefusal(
      'record_path_not_found',
      `No element was found at the record path '${target.join('/')}'. A pass that read the ` +
        'document and produced nothing would report a complete enumeration over an empty catalogue.',
    );
  }
}

function assertRecordBudget(emitted: number, options: FeedParseOptions): void {
  if (emitted > options.maxRecords) {
    throw new FeedImportRefusal(
      'too_many_records',
      `The feed exceeded the ${options.maxRecords}-record limit and was refused rather than truncated.`,
    );
  }
}

/** Attributes become `path@name`, or `@name` on the record element itself. */
function addAttributes(
  fields: Map<string, string>,
  path: string,
  attributes: ReadonlyMap<string, string>,
  listSeparator: string,
): void {
  for (const [name, value] of attributes) {
    if (value === '') continue;
    addRawField(fields, path === '' ? `@${name}` : `${path}@${name}`, value, listSeparator);
  }
}

/** Does the element stack END with the configured path? */
function matchesTail(stack: readonly string[], target: readonly string[]): boolean {
  if (stack.length < target.length) return false;
  for (let position = 0; position < target.length; position += 1) {
    if (stack[stack.length - target.length + position] !== target[position]) return false;
  }
  return true;
}

/**
 * `rss/channel/item`, `channel.item` and `item` all name the same element.
 *
 * A SUFFIX match rather than an absolute one, so `item` finds it wherever the
 * exporter put it. That is deliberate leniency in the one place a strict
 * reading buys nothing: a feed with two different `item` elements at different
 * depths does not exist, and a merchant who typed the short form and got
 * `record_path_not_found` on a visibly present element has no way to tell what
 * the parser wanted.
 */
function normalizeRecordPath(recordPath: string | null): string[] {
  if (recordPath === null) return [];
  return recordPath
    .split(/[./]/u)
    .map((segment) => localName(segment.trim()))
    .filter((segment) => segment !== '');
}

/** `g:price` → `price`. The prefix is dropped; the URI is never resolved. */
function localName(name: string): string {
  const colon = name.lastIndexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * The character scanner: text, tags, comments and CDATA, one character at a
 * time.
 *
 * The `<!` decision is made at THREE characters — `<!-` is a comment, `<![` is
 * CDATA, anything else is a declaration and is refused — so the refusal happens
 * before a single byte of a DTD has been interpreted. That ordering is the
 * point: a scanner that read the declaration first to find out what it was
 * would already have done the thing it is refusing to do.
 */
async function* scanXml(text: AsyncIterable<string>): AsyncGenerator<XmlEvent> {
  type Mode = 'text' | 'markup' | 'comment' | 'cdata';
  let mode: Mode = 'text';
  let buffer = '';
  let quote: string | null = null;

  for await (const chunk of text) {
    for (const character of chunk) {
      if (mode === 'text') {
        if (character === '<') {
          if (buffer !== '') {
            yield { kind: 'text', value: decodeXmlEntities(buffer) };
            buffer = '';
          }
          mode = 'markup';
          buffer = '<';
          continue;
        }
        buffer += character;
        continue;
      }

      if (mode === 'comment') {
        buffer += character;
        if (buffer.endsWith('-->')) {
          mode = 'text';
          buffer = '';
        }
        continue;
      }

      if (mode === 'cdata') {
        buffer += character;
        if (buffer.endsWith(']]>')) {
          // CDATA is text verbatim: entities inside it are NOT references, which
          // is the whole reason a publisher used it for an HTML description.
          yield { kind: 'text', value: buffer.slice(0, -3) };
          mode = 'text';
          buffer = '';
        }
        continue;
      }

      // ── markup ───────────────────────────────────────────────────────────
      buffer += character;

      if (buffer.length === 3 && buffer.startsWith('<!')) {
        if (buffer === '<!-') {
          mode = 'comment';
          continue;
        }
        if (buffer !== '<![') {
          throw new FeedImportRefusal(
            'entity_declaration_refused',
            'The feed contains an XML declaration (`<!DOCTYPE`, `<!ENTITY` or similar). ' +
              'Declarations are refused before they are read: a product feed needs none, and ' +
              'processing them is how external-entity and expansion attacks work.',
          );
        }
        continue;
      }
      if (buffer === '<![CDATA[') {
        mode = 'cdata';
        buffer = '';
        continue;
      }
      if (buffer.startsWith('<![') && buffer.length < 9) continue;

      if (quote !== null) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character !== '>') continue;

      const tag = buffer;
      buffer = '';
      mode = 'text';

      if (tag.startsWith('<?')) continue;
      if (tag.startsWith('</')) {
        yield { kind: 'end', name: localName(tag.slice(2, -1).trim()) };
        continue;
      }
      yield readStartTag(tag);
    }
  }
}

/** `<g:item a="1" b='2'/>` → its local name, its attributes and its shape. */
function readStartTag(tag: string): XmlEvent {
  const body = tag.slice(1, -1).trim();
  const selfClosing = body.endsWith('/');
  const inner = selfClosing ? body.slice(0, -1).trim() : body;
  const space = inner.search(/\s/u);
  const rawName = space === -1 ? inner : inner.slice(0, space);
  const attributes = new Map<string, string>();
  if (space !== -1) {
    const attributePattern = /([A-Za-z_:][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/gu;
    let match = attributePattern.exec(inner.slice(space));
    while (match !== null) {
      const name = localName(match[1] ?? '');
      const value = match[3] ?? match[4] ?? '';
      if (name !== '' && !attributes.has(name)) {
        attributes.set(name, decodeXmlEntities(value));
      }
      match = attributePattern.exec(inner.slice(space));
    }
  }
  return { kind: 'start', name: localName(rawName), attributes, selfClosing };
}

/**
 * The five predefined entities and numeric character references, and nothing
 * else.
 *
 * There is no entity TABLE to extend, so a document that references `&foo;`
 * gets the literal text back rather than an expansion — because the only way to
 * define `foo` is a declaration, and declarations are refused above. A numeric
 * reference is bounded to a valid code point; anything outside is left as
 * written rather than becoming a replacement character that silently corrupts
 * the value.
 */
function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9A-Fa-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/gu, (match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        break;
    }
    const code = entity.startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) return match;
    return String.fromCodePoint(code);
  });
}
