/**
 * The `to_tsvector('simple', name)` columns on the canonical graph index every
 * script the product ships copy in, and the candidate search finds them (#833).
 *
 * ## Why this file exists
 *
 * #826 was a generated column built as `to_tsvector('english', …)`: a listing
 * found by its English title was not found by its French one. The fix covered
 * `listings` and `listing_localizations`, which are the columns that carry a
 * LOCALE. The other six search vectors in this schema — canonical products and
 * families, merchants and storefronts, organizations and brands — carry no
 * locale at all and are built as `'simple'` for that reason (ADR 0002 D21:
 * proper nouns must not be stemmed).
 *
 * `'simple'` is the RIGHT choice and it was never measured against a non-Latin
 * name. #833's census is why: every fixture that reached these tables was
 * written in Latin, so "a Bengali brand is indexed and findable" was an
 * assumption with nothing behind it. This file is the measurement.
 *
 * ## What it asserts, and what it deliberately does not
 *
 * That each name reaches its vector as a lexeme, and that
 * `searchProductIdsByLexicalRank` — the real reader, not a re-spelled query —
 * returns the product. NOT that search works WELL: `simple` cannot segment Han
 * or Kana, which are written without spaces, so a whole CJK run becomes one
 * lexeme and only a whole-run query matches it. That is a known property of the
 * configuration rather than a defect, it is the same property the katakana case
 * in `listing-localization.realdb.test.ts` records, and pretending otherwise
 * here would be inventing a guarantee.
 *
 * ## A PRIVATE database, deliberately
 *
 * `canonical_products` is the table `AGENTS.md` names as the shared-database
 * teardown hazard: a sibling file's matcher runs a trigram scan over every row
 * and can mint a `match_decisions` row citing THIS file's fixtures, both citing
 * columns being `on delete restrict`. A private database has no such sibling,
 * needs no scoped teardown, and lets the assertions below be exact.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDatabase, uuidv7 } from '@oxyhq/db';
import type postgres from 'postgres';
import type { Database } from '../postgres.js';
import * as schema from '../schema/index.js';
import { createMercariaTestDatabase, dropMercariaTestDatabase } from '../testDatabase.js';
import { canonicalProductFamilies, canonicalProducts } from '../schema/canonicalCatalog.js';
import { merchants, storefronts } from '../schema/merchants.js';
import { brands, organizations } from '../schema/organizations.js';
import { searchProductIdsByLexicalRank } from '../search/searchCandidateRepository.js';
import { SCRIPT_CORPUS, scriptSample } from '../../__tests__/script-corpus.js';

const ADMIN_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_dev';

let databaseUrl: string;
let client: postgres.Sql;
let db: Database;

/** Distinctive per run, so a failure message names the fixture. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '').toLowerCase();

/** A slug is ASCII by policy, so it is derived from the script name, not the word. */
const slugFor = (script: string, kind: string): string =>
  `${kind}-${script.toLowerCase()}-${RUN}`;

beforeAll(async () => {
  databaseUrl = await createMercariaTestDatabase(ADMIN_URL);
  const instance = createDatabase({
    databaseUrl,
    schema,
    client: { max: 4, onnotice: () => undefined },
  });
  client = instance.client;
  db = instance.db;
}, 300_000);

afterAll(async () => {
  await client.end({ timeout: 5 });
  await dropMercariaTestDatabase(databaseUrl);
});

describe("every canonical `simple` search vector indexes every shipped script", () => {
  it('canonical products and families keep the name as a lexeme', async () => {
    for (const sample of SCRIPT_CORPUS) {
      const [family] = await db
        .insert(canonicalProductFamilies)
        .values({
          slug: slugFor(sample.script, 'family'),
          name: sample.noun,
          normalizedName: sample.noun,
        })
        .returning({ id: canonicalProductFamilies.id });
      const [product] = await db
        .insert(canonicalProducts)
        .values({
          slug: slugFor(sample.script, 'product'),
          name: sample.noun,
          normalizedName: sample.noun,
          familyId: family.id,
        })
        .returning({ id: canonicalProducts.id });

      // Read through `db.execute` rather than a builder over two different
      // tables: the two `.from()` calls have different row types and unifying
      // them needs a cast, which is exactly the kind of assertion this
      // repository does not allow.
      const vectors = await db.execute<{ label: string; vector: string }>(sql`
        select 'family' as label, search_vector::text as vector
          from canonical_product_families where id = ${family.id}
        union all
        select 'product', search_vector::text
          from canonical_products where id = ${product.id}
      `);
      expect(vectors, `${sample.script} produced no rows at all`).toHaveLength(2);
      for (const row of vectors) {
        expect(
          row.vector,
          `${sample.script} ${row.label} (${sample.nounGloss}) is not in its own search vector`,
        ).toContain(`'${sample.noun}'`);
      }
    }
  });

  it('merchants, storefronts, organizations and brands do too', async () => {
    for (const sample of SCRIPT_CORPUS) {
      const [merchant] = await db
        .insert(merchants)
        .values({ name: sample.noun, slug: slugFor(sample.script, 'merchant') })
        .returning({ id: merchants.id });
      const [storefront] = await db
        .insert(storefronts)
        .values({
          merchantId: merchant.id,
          name: sample.noun,
          slug: slugFor(sample.script, 'storefront'),
          channelKind: 'marketplace',
        })
        .returning({ id: storefronts.id });
      const [organization] = await db
        .insert(organizations)
        .values({
          slug: slugFor(sample.script, 'org'),
          name: sample.noun,
          normalizedName: sample.noun,
        })
        .returning({ id: organizations.id });
      const [brand] = await db
        .insert(brands)
        .values({
          slug: slugFor(sample.script, 'brand'),
          name: sample.noun,
          normalizedName: sample.noun,
        })
        .returning({ id: brands.id });

      const vectors = await db.execute<{ label: string; vector: string }>(sql`
        select 'merchant' as label, search_vector::text as vector from merchants where id = ${merchant.id}
        union all
        select 'storefront', search_vector::text from storefronts where id = ${storefront.id}
        union all
        select 'organization', search_vector::text from organizations where id = ${organization.id}
        union all
        select 'brand', search_vector::text from brands where id = ${brand.id}
      `);
      expect(vectors, `${sample.script} produced no rows at all`).toHaveLength(4);
      for (const row of vectors) {
        expect(
          row.vector,
          `${sample.script} ${row.label} (${sample.nounGloss}) is not in its own search vector`,
        ).toContain(`'${sample.noun}'`);
      }
    }
  });

  it('the reader itself finds a product by its non-Latin name', async () => {
    // Through `searchProductIdsByLexicalRank`, which is what `services/search/`
    // calls. A re-spelled query here would measure the re-spelling: #61 records
    // that mistake and its cost, and the same rule applies to a fixture.
    for (const sample of SCRIPT_CORPUS) {
      const [product] = await db
        .insert(canonicalProducts)
        .values({
          slug: slugFor(sample.script, 'findable'),
          name: sample.noun,
          normalizedName: sample.noun,
        })
        .returning({ id: canonicalProducts.id });

      const found = await searchProductIdsByLexicalRank(db, sample.noun, 50);
      expect(
        found.map((candidate) => candidate.id),
        `${sample.script} "${sample.noun}" (${sample.nounGloss}) is indexed but unfindable`,
      ).toContain(product.id);
    }
  });

  it('a query in one script does not return another script — the control', async () => {
    // Without this, "found" above is satisfied by a reader that returns every
    // product for every term.
    const arabic = scriptSample('Arabic');
    const bengali = scriptSample('Bengali');
    const found = await searchProductIdsByLexicalRank(db, arabic.noun, 50);
    const bengaliRows = await db
      .select({ id: canonicalProducts.id })
      .from(canonicalProducts)
      .where(eq(canonicalProducts.name, bengali.noun));
    expect(bengaliRows.length, 'the Bengali fixtures were never inserted').toBeGreaterThan(0);
    for (const row of bengaliRows) {
      expect(found.map((candidate) => candidate.id)).not.toContain(row.id);
    }
  });
});
