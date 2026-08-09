/**
 * Streaming JSON — the elements of ONE array, found by path, without ever
 * holding the document (#63 §"Supported inputs" 3, acceptance 1).
 *
 * `JSON.parse` on a two-gigabyte feed is a two-gigabyte string plus the object
 * graph it produces, so it is not an option however tempting the one-liner is.
 * What this file does instead is scan characters, maintain the container stack
 * so it knows WHERE it is, and — once the stack's key path equals the
 * configured record path and that container is an array — buffer exactly one
 * element at a time and hand it to `JSON.parse`. The largest thing in memory is
 * one product.
 *
 * ## The path is a path of KEYS, and arrays contribute nothing to it
 *
 * `{"data":{"items":[…]}}` is `data.items`. An array in the middle of the path
 * would make the path ambiguous (which element?) and every real feed puts its
 * records in exactly one array, so the scanner looks for the array whose own key
 * path matches and ignores array indices entirely. A path that never matches is
 * `record_path_not_found` rather than an empty successful pass — an empty pass
 * over a snapshot feed retires the catalogue.
 *
 * ## The string state is tracked once and shared
 *
 * A `{` inside a string is not a container, and a `"` preceded by a backslash is
 * not a string boundary. Both facts are handled in ONE place below rather than
 * separately in the outer scanner and the element capture, because two
 * implementations of "am I inside a string" is exactly the shape that reads a
 * product description containing `","` as the end of a record.
 */

import { FeedImportRefusal } from '../errors.js';
import { flattenJsonRecord } from './flatten.js';
import { type FeedParseOptions, type FeedRawRecord } from './types.js';

/** A frame of the container stack. `key` is `null` for an array's elements. */
interface JsonFrame {
  readonly kind: 'object' | 'array';
  readonly key: string | null;
}

export async function* parseJsonFeed(
  text: AsyncIterable<string>,
  options: FeedParseOptions,
): AsyncGenerator<FeedRawRecord> {
  const targetPath = normalizeRecordPath(options.recordPath);

  const stack: JsonFrame[] = [];
  /** The key most recently read in the enclosing object, awaiting its value. */
  let pendingKey: string | null = null;
  /** The literal being read, when one is open. */
  let stringBuffer: string | null = null;
  let escaped = false;
  /** True between a key's closing quote and its `:`. */
  let awaitingColon = false;

  /** Set once the target array is entered; the stack depth of that array. */
  let captureDepth = -1;
  let element = '';
  let elementDepth = 0;
  let inElement = false;
  let elementString = false;
  let elementEscaped = false;

  let index = 0;
  let emitted = 0;
  let found = false;

  function currentPath(): string {
    return stack
      .map((frame) => frame.key)
      .filter((key): key is string => key !== null)
      .join('.');
  }

  const pending: FeedRawRecord[] = [];

  function completeElement(): void {
    const text = element.trim();
    element = '';
    inElement = false;
    elementDepth = 0;
    if (text === '') return;
    emitted += 1;
    if (emitted > options.maxRecords) {
      throw new FeedImportRefusal(
        'too_many_records',
        `The feed exceeded the ${options.maxRecords}-record limit and was refused rather than truncated.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      pending.push({ index, fields: new Map([['__malformed__', 'unparseable']]) });
      index += 1;
      return;
    }
    if (parsed === null || typeof parsed !== 'object') {
      pending.push({ index, fields: new Map([['__malformed__', 'not_an_object']]) });
      index += 1;
      return;
    }
    pending.push({ index, fields: flattenJsonRecord(parsed, options) });
    index += 1;
  }

  for await (const chunk of text) {
    for (const character of chunk) {
      // ── Inside the target array: capture one element at a time ────────────
      if (captureDepth !== -1 && stack.length === captureDepth) {
        if (!inElement) {
          if (character === ']') {
            captureDepth = -1;
            stack.pop();
            continue;
          }
          if (character === ',' || /\s/u.test(character)) continue;
          inElement = true;
          element = character;
          elementString = character === '"';
          elementEscaped = false;
          elementDepth = character === '{' || character === '[' ? 1 : 0;
          if (elementDepth === 0 && !elementString) {
            // A bare primitive element; it ends at the next comma or `]`.
            continue;
          }
          continue;
        }

        element += character;
        if (element.length > options.maxRecordBytes) {
          throw new FeedImportRefusal(
            'record_too_large',
            `A JSON record exceeded the ${options.maxRecordBytes}-character limit.`,
          );
        }
        if (elementString) {
          if (elementEscaped) elementEscaped = false;
          else if (character === '\\') elementEscaped = true;
          else if (character === '"') {
            elementString = false;
            if (elementDepth === 0) completeElement();
          }
          continue;
        }
        if (character === '"') {
          elementString = true;
          continue;
        }
        if (character === '{' || character === '[') {
          elementDepth += 1;
          continue;
        }
        if (character === '}' || character === ']') {
          elementDepth -= 1;
          if (elementDepth === 0) completeElement();
          continue;
        }
        if (elementDepth === 0 && (character === ',' || /\s/u.test(character))) {
          // A bare primitive ended. Drop the terminator before parsing.
          element = element.slice(0, -1);
          completeElement();
          continue;
        }
        continue;
      }

      // ── Outside the target array: track where we are ──────────────────────
      if (stringBuffer !== null) {
        if (escaped) {
          stringBuffer += character;
          escaped = false;
          continue;
        }
        if (character === '\\') {
          escaped = true;
          stringBuffer += character;
          continue;
        }
        if (character === '"') {
          const literal = safeParseString(`${stringBuffer}"`);
          stringBuffer = null;
          const enclosing = stack[stack.length - 1];
          if (enclosing?.kind === 'object' && pendingKey === null) {
            pendingKey = literal;
            awaitingColon = true;
          }
          continue;
        }
        stringBuffer += character;
        continue;
      }

      if (character === '"') {
        stringBuffer = '"';
        continue;
      }
      if (awaitingColon) {
        if (character === ':') awaitingColon = false;
        continue;
      }
      if (character === '{') {
        stack.push({ kind: 'object', key: keyForNewContainer(stack, pendingKey) });
        pendingKey = null;
        continue;
      }
      if (character === '[') {
        const key = keyForNewContainer(stack, pendingKey);
        stack.push({ kind: 'array', key });
        pendingKey = null;
        if (currentPath() === targetPath) {
          found = true;
          captureDepth = stack.length;
        }
        continue;
      }
      if (character === '}' || character === ']') {
        stack.pop();
        pendingKey = null;
        continue;
      }
      if (character === ',') {
        pendingKey = null;
        continue;
      }
    }

    while (pending.length > 0) {
      const record = pending.shift();
      if (record !== undefined) yield record;
    }
  }

  while (pending.length > 0) {
    const record = pending.shift();
    if (record !== undefined) yield record;
  }

  if (!found) {
    throw new FeedImportRefusal(
      'record_path_not_found',
      `No array was found at the record path '${targetPath}'. A pass that read the document and ` +
        'produced nothing would report a complete enumeration over an empty catalogue.',
    );
  }
}

/**
 * The path a mapping version stores, in the one spelling this scanner compares.
 *
 * `data.items`, `data/items` and `$.data.items` all name the same array, and a
 * merchant will type any of the three. Normalizing here rather than refusing
 * two of them is not leniency for its own sake — the alternative is a
 * `record_path_not_found` on a path that is visibly correct in the form.
 */
function normalizeRecordPath(recordPath: string | null): string {
  if (recordPath === null) return '';
  return recordPath
    .replace(/^\$\.?/u, '')
    .split(/[./]/u)
    .filter((segment) => segment !== '')
    .join('.');
}

/** An object's own key names its child; an array's elements have no key. */
function keyForNewContainer(stack: readonly JsonFrame[], pendingKey: string | null): string | null {
  const enclosing = stack[stack.length - 1];
  if (enclosing === undefined) return null;
  return enclosing.kind === 'object' ? pendingKey : null;
}

/**
 * Read one JSON string literal back.
 *
 * `JSON.parse` rather than a hand-rolled unescape, so `é` and `\"` are the
 * platform's reading of them. A literal that will not parse is a key nothing
 * can match, which is the correct outcome for a malformed document.
 */
function safeParseString(literal: string): string {
  try {
    const value: unknown = JSON.parse(literal);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}
