/**
 * `native_listing_attribute_claims` and `native_variant_attribute_claims` are
 * INSERTED by `db/variantAxes/attributeClaimRepository.ts` alone, and written by
 * it plus one named settlement exception (#367 step 4, ADR 0007 D7).
 *
 * ## What this protects, and why no runtime test can
 *
 * A claim is what a party SAID, and every guarantee that makes it useful lives
 * in the repository rather than in the row: the insert is `ON CONFLICT DO
 * NOTHING` so a repeat is a genuine no-op, the resolution defaults to
 * `unresolved` on BOTH halves so a writer that knows nothing cannot accidentally
 * settle one, and `settleVariantAttributeClaim` takes no raw text so a
 * settlement that rewrote somebody's assertion is not expressible.
 *
 * A second writer would get exactly those wrong, and the failure is silent in
 * every direction that matters. `DO UPDATE` with identical values still moves
 * `updated_at` and `xmin` (measured on `moderation_outboxes`, pinned there by a
 * test), so a "converging" second writer would churn tuples under the review
 * queue's own index. A writer that omitted `provenance` cannot exist — the
 * column is NOT NULL — but one that passed `merchant_declared` for a connector
 * import would attribute an assertion to a person who never made it, and every
 * CHECK on the table would accept it.
 *
 * So the durable half of the property is a CENSUS. A third production writer
 * fails this test until somebody decides what it does about convergence and
 * provenance — which is the point. A gate that skips what is missing from its own
 * map is not a gate, so every hit must be the owner or a named exception with a
 * stated disposition; being in neither fails.
 *
 * ## Two things it deliberately does not do
 *
 * It does NOT strip comments, following `listing-publication-chokepoint.test.ts`
 * and `store-teardown-census.test.ts`: the failure direction of scanning raw
 * source is a false POSITIVE, corrected in one line, while comment stripping
 * truncates at a `//` inside a string literal and can HIDE a real call. The
 * probe is therefore assembled from the table identifiers rather than written
 * out, so this file cannot become the offender it looks for.
 *
 * It scans PRODUCTION source only. `variant-axes.realdb.test.ts` writes both
 * tables directly and is supposed to — it exercises the CHECKs and the freeze
 * triggers against rows the repository would never compose, which is the whole
 * reason it is a real-server file.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The drizzle bindings whose writers are counted, assembled from rather than quoted. */
const TABLES = ['nativeListingAttributeClaims', 'nativeVariantAttributeClaims'] as const;

/** The physical names, for the raw-SQL branches. */
const RELATIONS = ['native_listing_attribute_claims', 'native_variant_attribute_claims'] as const;

/**
 * A write against either table, in the four spellings this repository actually
 * uses.
 *
 * `\s*` throughout because the house style puts `.update(...)` and its `.set` on
 * separate lines wherever the statement runs long, and a line-based scan reads
 * that as clean. The raw branches are here because `db.execute` bypasses the
 * query builder entirely — a scan for the builder alone reports clean on the one
 * shape that also bypasses the column mappers — and the INTERPOLATED branch
 * (`insert into ${nativeVariantAttributeClaims}`) is the one a table-name scan
 * cannot see at all, because the name never appears as text.
 */
const CLAIM_WRITE = new RegExp(
  [
    ...TABLES.flatMap((table) => [
      `\\.\\s*insert\\s*\\(\\s*${table}\\s*\\)`,
      `\\.\\s*update\\s*\\(\\s*${table}\\s*\\)`,
      `\\.\\s*delete\\s*\\(\\s*${table}\\s*\\)`,
      `(?:insert\\s+into|update|delete\\s+from)\\s+\\$\\{\\s*${table}\\s*\\}`,
    ]),
    ...RELATIONS.map(
      (relation) => `(?:insert\\s+into|update|delete\\s+from)\\s+"?${relation}"?`,
    ),
  ].join('|'),
  'iu',
);

/**
 * Every production file that may write a claim, and what it does about the two
 * properties the row cannot hold: convergence, and honest provenance.
 *
 * Named rather than pattern-matched — an exact array cannot be widened by
 * accident, where a directory rule would quietly cover a second file nobody
 * looked at.
 */
const PERMITTED_WRITERS: readonly { readonly path: string; readonly disposition: string }[] = [
  {
    path: join('db', 'variantAxes', 'attributeClaimRepository.ts'),
    disposition:
      'the OWNER — `recordListingAttributeClaim` and `recordVariantAttributeClaim` insert `ON CONFLICT DO NOTHING` on the identity key (so a repeat writes no tuple version and no timestamp), `resolutionValues` defaults BOTH halves to `unresolved`, and the two `settle*` functions take no raw text so a settlement cannot rewrite an assertion',
  },
  {
    path: join('db', 'catalogProposals', 'backfillRepository.ts'),
    disposition:
      'SETTLES, never inserts — `resolveListingClaimToControlledValue` is #367 step 6 applying an accepted proposal to the claim that asked for it. It touches no raw text, no subject and no provenance (the freeze trigger refuses all three anyway), and it is a CAS on the value half still being `unresolved`, so a claim an operator settled by hand is left as they settled it. That CAS is the reason it is not `settleListingAttributeClaim`, which keys on the id alone and would overwrite one — a real divergence between two settlement spellings for one table, recorded here rather than papered over; consolidating them belongs to whoever owns step 6',
  },
];

/** `{relative path → source}` for every production `.ts` under `src/`. */
function productionSources(): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const rel = relative(SRC_ROOT, path);
      if (rel.split(sep).includes('__tests__')) continue;
      sources.set(rel, readFileSync(path, 'utf8'));
    }
  };
  walk(SRC_ROOT);
  return sources;
}

describe('the attribute-claim write census', () => {
  it('finds ONLY the owner and its ONE named settlement exception', () => {
    const sources = productionSources();

    // The vacuity floor. A broken walk, a moved directory or an extension filter
    // that stopped matching all report the same clean zero as a correct scan, and
    // the identity assertion below would pass on every one of them.
    expect(sources.size, 'the walk read almost nothing — did the layout move?').toBeGreaterThan(
      400,
    );
    console.log(`[census] production modules scanned: ${sources.size}`);

    const writers = [...sources]
      .filter(([, source]) => CLAIM_WRITE.test(source))
      .map(([path]) => path)
      .sort();
    console.log(`[census] claim writers found: ${writers.length} (${writers.join(', ')})`);

    // Exact identity, never containment. It is also its own positive control —
    // it can only pass by having FOUND the real writer, so a scan that read
    // nothing, or a probe that matched nothing, fails here instead of reporting a
    // tidy zero.
    expect(
      writers,
      'a new module writes an attribute claim directly. Convergence and provenance are now its problem too — route it through attributeClaimRepository, or add it here with a disposition (#367 step 4, ADR 0007 D7)',
    ).toEqual([...PERMITTED_WRITERS].map((writer) => writer.path).sort());
  });

  it('names a writer path the walk actually read, and an exact number of them', () => {
    const sources = productionSources();
    for (const { path } of PERMITTED_WRITERS) {
      // A stale path — a rename, a moved directory — permits nothing and reads
      // exactly like a correct run, leaving the assertion above comparing two
      // lists that agree about a file neither of them found.
      expect(sources.has(path), `permitted writer path is stale: ${path}`).toBe(true);
    }
    // The exact count beside the floor the list excuses. A list that only ever
    // grows is the same erosion as a decremented floor in a different shape.
    expect(PERMITTED_WRITERS).toHaveLength(2);
  });

  it('finds all FOUR of the owner’s write statements', () => {
    const owner = productionSources().get(join('db', 'variantAxes', 'attributeClaimRepository.ts'));
    expect(owner, 'the owner path is stale').toBeDefined();

    // A floor on what was FOUND, not on what was absent. Without it, a probe
    // that had stopped matching the builder spelling would make the census above
    // pass by finding nothing anywhere — including in the file that certainly
    // does write these tables. Four: two inserts and two settlements.
    const statements = owner.match(new RegExp(CLAIM_WRITE.source, 'giu')) ?? [];
    console.log(`[census] owner write statements: ${statements.length}`);
    expect(
      statements.length,
      'the owner should carry two inserts and two settlements',
    ).toBeGreaterThanOrEqual(4);
  });

  it('MUTATION SELF-TEST — each branch of the probe catches its own spelling', () => {
    // Against text held in memory, and each case names WHICH branch it exercises,
    // because a self-test that only proved "some branch fires" would pass with
    // three of the four deleted.
    const builder = 'await tx.insert(nativeVariantAttributeClaims).values({});';
    const update = 'await db\n  .update(nativeListingAttributeClaims)\n  .set({ x: 1 });';
    const raw = "await db.execute(sql`insert into native_variant_attribute_claims (id) values (1)`);";
    const interpolated = 'await db.execute(sql`update ${nativeListingAttributeClaims} set x = 1`);';
    for (const [name, probe] of Object.entries({ builder, update, raw, interpolated })) {
      expect(CLAIM_WRITE.test(probe), `the ${name} branch does not fire`).toBe(true);
    }

    // …and the interpolated branch is genuinely a FOURTH one rather than a second
    // spelling of the raw one: the physical name never appears in it.
    expect(
      new RegExp(`(?:insert\\s+into|update)\\s+"?${RELATIONS[0]}"?`, 'iu').test(interpolated),
    ).toBe(false);

    // The negative control. A READ must not be a hit, or the census would name
    // every reader in the tree and the allow-list would have to grow to cover
    // them — which is how a gate switches itself off.
    expect(CLAIM_WRITE.test('select from ${nativeVariantAttributeClaims}')).toBe(false);
    expect(CLAIM_WRITE.test('.select().from(nativeListingAttributeClaims)')).toBe(false);
  });
});
