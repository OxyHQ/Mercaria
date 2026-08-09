/**
 * Streaming CSV / TSV — RFC 4180, and the four places real feeds are not
 * RFC 4180 (#63 acceptance 3).
 *
 * A character state machine over decoded text CHUNKS, holding at most one
 * partial record. There is no `split('\n')` anywhere, and that is the whole
 * design: a quoted field may contain a newline, so splitting on lines is
 * correct for the fixture in the pull request and wrong for the merchant's real
 * file, where a product description contains a line break inside quotes and
 * every row after it is shifted by one column — silently, with the mapping
 * still "working".
 *
 * ## The four accommodations, each deliberate
 *
 * 1. **A quote that is not at the start of a field is a literal.** RFC 4180
 *    says a field is quoted entirely or not at all, and real feeds publish
 *    `12" monitor` unquoted every day. Treating that quote as an opening one
 *    swallows the rest of the file into a single field.
 * 2. **`""` inside a quoted field is one quote**, and the decision is deferred
 *    across a CHUNK boundary rather than peeked at, because the second quote
 *    can be the first character of the next chunk.
 * 3. **A bare `\r` outside quotes is dropped**, so CRLF and LF files parse
 *    identically without a mode.
 * 4. **A blank line is not a record.** A trailing newline is universal and a
 *    row of one empty field is not a product.
 *
 * ## Duplicate headers get a suffix rather than colliding
 *
 * Two columns named `price` is a real thing merchants export. Last-one-wins
 * would silently map the wrong column; joining them would make a price a list.
 * The second becomes `price_2`, which is visible in the preview and mappable.
 */

import { FeedImportRefusal } from '../errors.js';
import { addRawField, type FeedParseOptions, type FeedRawRecord } from './types.js';

/**
 * Parse a delimited feed into records.
 *
 * `maxRecordBytes` is measured in decoded CHARACTERS of the record as it
 * accumulates, which is the quantity that actually bounds this function's
 * memory. It refuses rather than truncating: a truncated row is a row with the
 * wrong number of columns, which maps cleanly onto the wrong roles.
 */
export async function* parseDelimitedFeed(
  text: AsyncIterable<string>,
  options: FeedParseOptions,
): AsyncGenerator<FeedRawRecord> {
  const delimiter = options.delimiter;
  const quote = options.quoteChar;

  let header: string[] | null = null;
  let index = 0;
  let emitted = 0;

  let field = '';
  let row: string[] = [];
  let rowChars = 0;
  let inQuotes = false;
  /** A quote seen inside a quoted field whose meaning needs the NEXT character. */
  let pendingQuote = false;
  /** True until the first character of the current field — where a quote may open. */
  let atFieldStart = true;

  function finishField(): void {
    row.push(field);
    field = '';
    atFieldStart = true;
  }

  function takeRow(): string[] | null {
    finishField();
    const completed = row;
    row = [];
    rowChars = 0;
    // A blank line: one empty field and nothing else.
    if (completed.length === 1 && completed[0] === '') return null;
    return completed;
  }

  function toRecord(values: readonly string[]): FeedRawRecord | null {
    if (header === null) {
      if (options.hasHeaderRow) {
        header = buildHeader(values);
        return null;
      }
      header = values.map((_value, position) => `column_${position + 1}`);
    }
    const names = header;
    const fields = new Map<string, string>();
    for (let position = 0; position < values.length; position += 1) {
      const value = values[position] ?? '';
      if (value === '') continue;
      // A row with MORE cells than the header keeps them under positional
      // names rather than dropping them: a mapping can then point at the real
      // column, and the preview shows the merchant what happened.
      const name = names[position] ?? `column_${position + 1}`;
      addRawField(fields, name, value, options.listSeparator);
    }
    const record: FeedRawRecord = { index, fields };
    index += 1;
    return record;
  }

  for await (const chunk of text) {
    for (const character of chunk) {
      rowChars += 1;
      if (rowChars > options.maxRecordBytes) {
        throw new FeedImportRefusal(
          'record_too_large',
          `A record exceeded the ${options.maxRecordBytes}-character limit. An unterminated ` +
            'quote is the usual cause: the parser is still inside a field that never closed.',
        );
      }

      if (pendingQuote) {
        pendingQuote = false;
        if (character === quote) {
          field += quote;
          continue;
        }
        inQuotes = false;
        // Fall through and reprocess this character outside quotes.
      } else if (inQuotes) {
        if (character === quote) {
          pendingQuote = true;
        } else {
          field += character;
        }
        continue;
      }

      if (character === quote && atFieldStart) {
        inQuotes = true;
        atFieldStart = false;
        continue;
      }
      atFieldStart = false;

      if (character === delimiter) {
        finishField();
        continue;
      }
      if (character === '\n') {
        const values = takeRow();
        if (values !== null) {
          const record = toRecord(values);
          if (record !== null) {
            emitted += 1;
            if (emitted > options.maxRecords) {
              throw new FeedImportRefusal(
                'too_many_records',
                `The feed exceeded the ${options.maxRecords}-record limit and was refused ` +
                  'rather than truncated.',
              );
            }
            yield record;
          }
        }
        continue;
      }
      if (character === '\r') continue;
      field += character;
    }
  }

  // A file with no trailing newline still ends with a record.
  if (pendingQuote) inQuotes = false;
  if (field !== '' || row.length > 0) {
    const values = takeRow();
    if (values !== null) {
      const record = toRecord(values);
      if (record !== null) {
        emitted += 1;
        if (emitted > options.maxRecords) {
          throw new FeedImportRefusal(
            'too_many_records',
            `The feed exceeded the ${options.maxRecords}-record limit and was refused rather ` +
              'than truncated.',
          );
        }
        yield record;
      }
    }
  }
}

/**
 * Header names: trimmed, and de-duplicated with a numeric suffix.
 *
 * An empty header cell becomes its positional name, so a trailing comma in the
 * header row does not produce an unnameable column a mapping cannot reference.
 */
function buildHeader(values: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return values.map((raw, position) => {
    const trimmed = raw.trim();
    const base = trimmed === '' ? `column_${position + 1}` : trimmed;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}
