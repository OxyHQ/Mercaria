/**
 * The five parsers, against the shapes real feeds actually have (#63
 * acceptance 3: "CSV quoting, XML namespaces, JSON Lines and gzip fixtures are
 * covered").
 *
 * Every case here is a bug somebody has shipped: a quoted field containing the
 * delimiter, a description containing a newline, a BOM on the first header cell,
 * a Google feed's `g:` prefix, a `<!DOCTYPE` a generator emitted, a repeated
 * `additional_image_link`. The fixtures are small on purpose — the multi-gigabyte
 * property is `feed-memory.test.ts`'s, and this file is about correctness.
 */

import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { decodeText, decompressBytes, type FeedByteMeter } from '../bytes.js';
import { FeedImportRefusal } from '../errors.js';
import { streamFeedRecords, type FeedParseOptions } from '../parse/index.js';

const LIMITS = {
  maxDownloadBytes: 10 * 1024 * 1024,
  maxDecompressedBytes: 50 * 1024 * 1024,
  maxCompressionRatio: 200,
};

function options(overrides: Partial<FeedParseOptions>): FeedParseOptions {
  return {
    format: 'csv',
    delimiter: ',',
    quoteChar: '"',
    hasHeaderRow: true,
    recordPath: null,
    listSeparator: ',',
    maxRecordBytes: 64 * 1024,
    maxRecords: 100_000,
    ...overrides,
  };
}

/** Feed text through the parser in SMALL chunks, so boundaries are exercised. */
async function* chunked(text: string, size = 7): AsyncGenerator<string> {
  for (let offset = 0; offset < text.length; offset += size) {
    yield text.slice(offset, offset + size);
  }
}

async function collect(
  text: AsyncIterable<string>,
  parseOptions: FeedParseOptions,
): Promise<{ index: number; fields: Record<string, string> }[]> {
  const out: { index: number; fields: Record<string, string> }[] = [];
  for await (const record of streamFeedRecords(text, parseOptions)) {
    out.push({ index: record.index, fields: Object.fromEntries(record.fields) });
  }
  return out;
}

describe('CSV quoting', () => {
  it('keeps a delimiter, a newline and a doubled quote inside a quoted field', async () => {
    const csv = [
      'id,title,description',
      '1,"Widget, large","Line one\nLine two"',
      '2,"He said ""hi""",plain',
    ].join('\n');
    const records = await collect(chunked(csv), options({}));
    expect(records).toHaveLength(2);
    expect(records[0]?.fields.title).toBe('Widget, large');
    expect(records[0]?.fields.description).toBe('Line one\nLine two');
    expect(records[1]?.fields.title).toBe('He said "hi"');
  });

  it('reads a stray quote inside an UNQUOTED field as a literal', async () => {
    // `12" monitor` is published unquoted every day. Treating that quote as an
    // opening one swallows the rest of the file into a single field.
    const csv = 'id,title\n1,12" monitor\n2,ordinary\n';
    const records = await collect(chunked(csv), options({}));
    expect(records).toHaveLength(2);
    expect(records[0]?.fields.title).toBe('12" monitor');
  });

  it('parses CRLF and a missing trailing newline identically to LF', async () => {
    const crlf = 'id,title\r\n1,First\r\n2,Second';
    const records = await collect(chunked(crlf), options({}));
    expect(records.map((record) => record.fields.title)).toEqual(['First', 'Second']);
  });

  it('drops a leading BOM so the first header cell is named what it looks like', async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('id,title\n1,A\n')]);
    async function* source(): AsyncGenerator<Uint8Array> {
      yield bytes;
    }
    const records = await collect(decodeText(source(), 'utf-8'), options({}));
    expect(Object.keys(records[0]?.fields ?? {})).toContain('id');
  });

  it('gives a duplicate header a suffix rather than losing a column', async () => {
    const csv = 'id,price,price\n1,10,20\n';
    const records = await collect(chunked(csv), options({}));
    expect(records[0]?.fields.price).toBe('10');
    expect(records[0]?.fields.price_2).toBe('20');
  });

  it('skips blank lines and reads a TSV with the same machine', async () => {
    const tsv = 'id\ttitle\n\n1\tTabbed\n\n';
    const records = await collect(chunked(tsv), options({ format: 'tsv', delimiter: '\t' }));
    expect(records).toHaveLength(1);
    expect(records[0]?.fields.title).toBe('Tabbed');
  });

  it('refuses a record past the size cap instead of truncating it', async () => {
    const csv = `id,title\n1,"${'x'.repeat(500)}\n`;
    await expect(collect(chunked(csv), options({ maxRecordBytes: 100 }))).rejects.toThrow(
      FeedImportRefusal,
    );
  });
});

describe('XML', () => {
  const GOOGLE = `<?xml version="1.0"?>
<rss xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <item>
      <g:id>SKU-1</g:id>
      <title>Blue widget</title>
      <g:price>19.99 EUR</g:price>
      <g:image_link>https://cdn.example/a.jpg</g:image_link>
      <g:additional_image_link>https://cdn.example/b.jpg</g:additional_image_link>
      <g:additional_image_link>https://cdn.example/c.jpg</g:additional_image_link>
      <g:shipping><g:country>ES</g:country><g:price>4.90 EUR</g:price></g:shipping>
      <description><![CDATA[<b>Bold</b> &amp; brave]]></description>
    </item>
    <item>
      <g:id>SKU-2</g:id>
      <title>Red widget</title>
    </item>
  </channel>
</rss>`;

  it('strips the namespace prefix and flattens nested children', async () => {
    const records = await collect(chunked(GOOGLE), options({ format: 'xml', recordPath: 'item' }));
    expect(records).toHaveLength(2);
    expect(records[0]?.fields.id).toBe('SKU-1');
    expect(records[0]?.fields.price).toBe('19.99 EUR');
    expect(records[0]?.fields['shipping.country']).toBe('ES');
    expect(records[0]?.fields['shipping.price']).toBe('4.90 EUR');
  });

  it('JOINS a repeated child rather than keeping only the last', async () => {
    const records = await collect(chunked(GOOGLE), options({ format: 'xml', recordPath: 'item' }));
    expect(records[0]?.fields.additional_image_link).toBe(
      'https://cdn.example/b.jpg,https://cdn.example/c.jpg',
    );
  });

  it('reads CDATA verbatim and decodes the predefined entities outside it', async () => {
    const records = await collect(chunked(GOOGLE), options({ format: 'xml', recordPath: 'item' }));
    expect(records[0]?.fields.description).toBe('<b>Bold</b> &amp; brave');
  });

  it('matches a record path written as a full path or as the leaf name', async () => {
    const byPath = await collect(
      chunked(GOOGLE),
      options({ format: 'xml', recordPath: 'rss/channel/item' }),
    );
    expect(byPath).toHaveLength(2);
  });

  it('REFUSES a document declaration before reading it (XXE)', async () => {
    const hostile = `<?xml version="1.0"?>
<!DOCTYPE feed [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<feed><item><id>1</id><title>&xxe;</title></item></feed>`;
    await expect(
      collect(chunked(hostile), options({ format: 'xml', recordPath: 'item' })),
    ).rejects.toThrow(/declaration/u);
  });

  it('does not expand an undeclared entity — it leaves the text as written', async () => {
    const xml = '<feed><item><id>1</id><title>A &unknown; B</title></item></feed>';
    const records = await collect(chunked(xml), options({ format: 'xml', recordPath: 'item' }));
    expect(records[0]?.fields.title).toBe('A &unknown; B');
  });

  it('refuses a record path that matches nothing rather than reporting an empty feed', async () => {
    await expect(
      collect(chunked(GOOGLE), options({ format: 'xml', recordPath: 'product' })),
    ).rejects.toThrow(/record path/u);
  });

  it('reads a self-closing record element as a record of its attributes', async () => {
    const xml = '<feed><item id="7" title="Attr widget"/></feed>';
    const records = await collect(chunked(xml), options({ format: 'xml', recordPath: 'item' }));
    expect(records).toHaveLength(1);
    expect(records[0]?.fields['@id']).toBe('7');
  });
});

describe('JSON and JSON Lines', () => {
  it('streams the elements of the array at the record path', async () => {
    const json = JSON.stringify({
      meta: { count: 2 },
      data: {
        items: [
          { id: 'a', title: 'A', price: 19.99 },
          { id: 'b', title: 'B', nested: { colour: 'red' } },
        ],
      },
    });
    const records = await collect(
      chunked(json, 5),
      options({ format: 'json', recordPath: 'data.items' }),
    );
    expect(records.map((record) => record.fields.id)).toEqual(['a', 'b']);
    expect(records[0]?.fields.price).toBe('19.99');
    expect(records[1]?.fields['nested.colour']).toBe('red');
  });

  it('is not confused by braces, brackets or commas INSIDE a string', async () => {
    const json = JSON.stringify({
      items: [
        { id: '1', title: 'A }, {"id": "forged"} B' },
        { id: '2', title: 'plain' },
      ],
    });
    const records = await collect(chunked(json, 3), options({ format: 'json', recordPath: 'items' }));
    expect(records.map((record) => record.fields.id)).toEqual(['1', '2']);
  });

  it('accepts `$.items`, `items` and `/items` as the same path', async () => {
    const json = JSON.stringify({ items: [{ id: '1', title: 'A' }] });
    for (const recordPath of ['$.items', 'items', '/items']) {
      const records = await collect(chunked(json), options({ format: 'json', recordPath }));
      expect(records).toHaveLength(1);
    }
  });

  it('refuses a record path that matches no array', async () => {
    const json = JSON.stringify({ items: [{ id: '1' }] });
    await expect(
      collect(chunked(json), options({ format: 'json', recordPath: 'products' })),
    ).rejects.toThrow(/record path/u);
  });

  it('isolates ONE bad JSON Lines record rather than failing the feed', async () => {
    const jsonl = ['{"id":"1","title":"A"}', 'not json at all', '{"id":"2","title":"B"}'].join('\n');
    const records = await collect(chunked(jsonl, 4), options({ format: 'jsonl' }));
    expect(records).toHaveLength(3);
    expect(records[1]?.fields.__malformed__).toBe('unparseable');
    expect(records[2]?.fields.id).toBe('2');
  });

  it('reads an array of primitives as a joined list', async () => {
    const jsonl = '{"id":"1","title":"A","images":["x.jpg","y.jpg"]}';
    const records = await collect(chunked(jsonl), options({ format: 'jsonl' }));
    expect(records[0]?.fields.images).toBe('x.jpg,y.jpg');
  });

  it('reads a JSON null as ABSENCE, never as the string "null"', async () => {
    const jsonl = '{"id":"1","title":"A","brand":null}';
    const records = await collect(chunked(jsonl), options({ format: 'jsonl' }));
    expect(records[0]?.fields.brand).toBeUndefined();
  });
});

describe('gzip', () => {
  it('reads a gzip-compressed CSV identically to the plain one', async () => {
    const csv = 'id,title\n1,Compressed\n2,Also compressed\n';
    const gz = gzipSync(Buffer.from(csv, 'utf8'));
    async function* source(): AsyncGenerator<Uint8Array> {
      // Two chunks, so the transform's own boundary handling is exercised.
      yield gz.subarray(0, Math.floor(gz.length / 2));
      yield gz.subarray(Math.floor(gz.length / 2));
    }
    const meter: FeedByteMeter = { compressedBytes: 0, decompressedBytes: 0 };
    const records = await collect(
      decodeText(decompressBytes(source(), 'gzip', LIMITS, meter), 'utf-8'),
      options({}),
    );
    expect(records.map((record) => record.fields.title)).toEqual([
      'Compressed',
      'Also compressed',
    ]);
    expect(meter.decompressedBytes).toBe(Buffer.byteLength(csv, 'utf8'));
  });

  it('reports a non-gzip stream declared as gzip as a malformed feed', async () => {
    async function* source(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('id,title\n1,A\n', 'utf8');
    }
    const meter: FeedByteMeter = { compressedBytes: 0, decompressedBytes: 0 };
    const iterator = decompressBytes(source(), 'gzip', LIMITS, meter);
    await expect(
      (async () => {
        // Draining is the point; the throw arrives from the transform.
        for await (const chunk of iterator) void chunk;
      })(),
    ).rejects.toThrow(FeedImportRefusal);
  });
});

describe('encoding', () => {
  it('decodes a multi-byte character split across a chunk boundary', async () => {
    const text = 'id,title\n1,Café Ñandú\n';
    const bytes = Buffer.from(text, 'utf8');
    async function* source(): AsyncGenerator<Uint8Array> {
      // Split INSIDE the two-byte `é`, which is byte 14 of the buffer.
      for (let index = 0; index < bytes.length; index += 1) {
        yield bytes.subarray(index, index + 1);
      }
    }
    const records = await collect(decodeText(source(), 'utf-8'), options({}));
    expect(records[0]?.fields.title).toBe('Café Ñandú');
  });

  it('decodes latin1 text that would be mojibake as utf-8', async () => {
    const bytes = Buffer.from('id,title\n1,Café\n', 'latin1');
    async function* source(): AsyncGenerator<Uint8Array> {
      yield bytes;
    }
    const records = await collect(decodeText(source(), 'latin1'), options({}));
    expect(records[0]?.fields.title).toBe('Café');
  });
});
