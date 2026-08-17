/**
 * `canonical_attribute_values` — the SELECTED fact — is written by one
 * repository and two named exceptions, and by nothing else.
 *
 * ADR 0007 D7: a merchant or a connector asserts a value in
 * `native_listing_attribute_claims` / `native_variant_attribute_claims`, with
 * its source and its raw value; `canonical_attribute_values` is what the graph
 * DECIDED. "A claim never becomes a canonical fact without passing through the
 * existing selection and provenance machinery" is the invariant, and until this
 * file it was held by nobody: the claim tables are frozen by trigger, the
 * authoring domain's isolation gate exists — and its cross-domain write pattern
 * names `canonical_products`, `canonical_variants` and `product_identifiers`
 * and omits this table. So an authoring module promoting a claim straight into
 * the selected fact shipped green.
 *
 * ## Why a census rather than a runtime test
 *
 * A runtime test drives the writers that exist. The property here is about the
 * writer nobody has written yet, and it fails in the quiet direction: a
 * promoted claim IS a plausible canonical value, it renders on every surface,
 * and what is lost is the provenance row saying which source said it and the
 * selection state saying what it beat. Nothing errors. It is discovered when
 * somebody asks why a product page says the RAM is 8 GB and no source agrees.
 *
 * ## Shape
 *
 * `listing-publication-chokepoint.test.ts`'s, deliberately — same walk, same
 * four write spellings, same exact-identity comparison, same per-shape floors.
 * Two censuses of one kind should not be two designs.
 *
 * It does NOT strip comments: the failure direction of raw source is a false
 * POSITIVE, corrected in one line, while comment stripping truncates at a `//`
 * inside a string literal and can hide a real call. The probe is assembled from
 * the table's binding NAME rather than written out, so this file cannot become
 * the offender it looks for.
 *
 * It scans PRODUCTION source only. Fixtures write this table directly across
 * the realdb suite and are supposed to.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The drizzle binding whose writers are being counted, assembled from rather than quoted. */
const BINDING = 'canonical' + 'AttributeValues';
/** Its SQL identifier, for the two raw spellings. */
const TABLE = 'canonical_attribute' + '_values';

/**
 * A drizzle write against it, newline-tolerant, in all four spellings.
 *
 * The interpolated raw form is the one a census is most blind to — the table
 * name never appears as text, so a scan for `update "canonical_attribute_values"`
 * alone matches nothing at all and reads as clean. That branch cost the listings
 * census a real miss (#427), which is why it is here before anybody writes one.
 */
const SELECTED_FACT_WRITE = new RegExp(
  [
    `\\.\\s*insert\\s*\\(\\s*${BINDING}\\s*\\)`,
    `\\.\\s*update\\s*\\(\\s*${BINDING}\\s*\\)`,
    `\\.\\s*delete\\s*\\(\\s*${BINDING}\\s*\\)`,
    `(?:insert\\s+into|update|delete\\s+from)\\s+"?${TABLE}"?`,
    `(?:insert\\s+into|update|delete\\s+from)\\s+\\$\\{\\s*${BINDING}\\s*\\}`,
  ].join('|'),
  'iu',
);

/**
 * Every production file that may write the selected fact, and what it does.
 *
 * Named exactly rather than by directory rule: a rule could quietly cover a
 * fourth file nobody looked at, which is the failure mode this census exists to
 * refuse.
 */
const PERMITTED_WRITERS: readonly { readonly path: string; readonly disposition: string }[] = [
  {
    path: join('db', 'canonical', 'attributeRepository.ts'),
    disposition:
      'the OWNER — `upsertAttributeValue` is the only INSERT, and the four updates (`clearAttributeValueSelection`, `setAttributeValueSelectionState`, `markAttributeValuesConflicting`, `setAttributeValueVerification`) move selection and verification state on rows it already wrote',
  },
  {
    path: join('services', 'curation', 'correction.service.ts'),
    disposition:
      '#59’s operator correction, behind the catalog operator allow-list and four eyes. It flips `selection_state` between rows that already exist — demoting the incumbent before promoting the candidate, because the partial unique holds at most one selected value per slot — and writes no value, no provenance and no normalized magnitude. It changes WHICH stored candidate is selected, never what a value IS.',
  },
  {
    path: join('services', 'graph-benchmark', 'dataset.ts'),
    disposition:
      'not applicable — the opt-in benchmark seed (`GRAPH_BENCHMARK=1` plus a `bench` database, which it TRUNCATES), which states the distribution the measured plans need',
  },
];

/**
 * The domains that produce CLAIMS, which is what makes this invariant a pair.
 *
 * A claim path appearing in the census above would already fail it. This names
 * the three modules the invariant is actually about, so the failure says which
 * rule was broken rather than only that the list changed — and so the assertion
 * survives somebody adding a legitimate fourth writer elsewhere.
 */
const CLAIM_DOMAINS: readonly string[] = [
  join('services', 'catalog-authoring'),
  join('services', 'catalog-proposals'),
  join('services', 'variant-axes'),
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

describe('the canonical attribute value write census (ADR 0007 D7)', () => {
  it('finds ONLY the repository and its two named exceptions writing the selected fact', () => {
    const sources = productionSources();

    // The vacuity floor. A broken walk, a moved directory or an extension filter
    // that stopped matching all report the same clean zero as a correct scan, and
    // the offender assertion below would pass on every one of them.
    expect(sources.size, 'the walk read almost nothing — did the layout move?').toBeGreaterThan(400);

    const writers = [...sources]
      .filter(([, source]) => SELECTED_FACT_WRITE.test(source))
      .map(([path]) => path)
      .sort();

    // Exact identity, never containment. It is also its own positive control: it
    // can only pass by having FOUND the three real writers, so a scan that read
    // nothing, or a probe that matched nothing, fails here rather than reporting
    // a tidy zero.
    expect(
      writers,
      'a new module writes `canonical_attribute_values` directly. A claim becomes a canonical fact only through the selection and provenance machinery (ADR 0007 D7) — route it through db/canonical/attributeRepository.ts, or add it here with a disposition',
    ).toEqual([...PERMITTED_WRITERS].map((writer) => writer.path).sort());

    console.log(
      `[canonical-attribute-value] ${sources.size} production modules walked; ${writers.length} writers; ${PERMITTED_WRITERS.length} permitted.`,
    );
  });

  it('names three writers whose paths the walk actually read', () => {
    const sources = productionSources();

    // A stale path — a rename, a moved directory — permits nothing and reads
    // exactly like a correct run, leaving the assertion above comparing two lists
    // that agree about a file neither of them found.
    for (const { path } of PERMITTED_WRITERS) {
      expect(sources.has(path), `permitted writer path is stale: ${path}`).toBe(true);
    }

    // The exact count beside the list, so a fourth entry is a deliberate edit in
    // two places rather than one.
    expect(PERMITTED_WRITERS).toHaveLength(3);
    for (const { disposition } of PERMITTED_WRITERS) {
      expect(disposition.length).toBeGreaterThan(80);
    }
  });

  it('finds all five of the owner’s write statements', () => {
    const owner = productionSources().get(join('db', 'canonical', 'attributeRepository.ts'));
    expect(owner, 'the owner path is stale').toBeDefined();

    // The floor on what was FOUND, not on what was absent. Without it, a probe
    // that had stopped matching the builder spelling would make the census above
    // pass by finding nothing anywhere — including in the file that certainly
    // does write this table.
    const statements = (owner ?? '').match(
      new RegExp(`\\.\\s*(?:insert|update|delete)\\s*\\(\\s*${BINDING}\\s*\\)`, 'giu'),
    );
    expect(statements?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('no CLAIM domain writes the selected fact — and each named domain really exists', () => {
    const sources = productionSources();

    const offenders: string[] = [];
    const scanned = new Map<string, number>();
    for (const [path, source] of sources) {
      const domain = CLAIM_DOMAINS.find((prefix) => path.startsWith(prefix + sep));
      if (domain === undefined) continue;
      scanned.set(domain, (scanned.get(domain) ?? 0) + 1);
      if (SELECTED_FACT_WRITE.test(source)) offenders.push(path);
    }

    // Per-DOMAIN floors, never one total: the three populations move
    // independently, and one number lets a directory collapse to zero while the
    // others carry it.
    for (const domain of CLAIM_DOMAINS) {
      expect(scanned.get(domain) ?? 0, `${domain} produced no files — is the path stale?`).toBeGreaterThan(
        3,
      );
    }
    expect(offenders).toEqual([]);
    console.log(
      `[canonical-attribute-value] claim domains scanned: ${[...scanned].map(([d, n]) => `${d}=${n}`).join(', ')}.`,
    );
  });

  describe('mutation self-tests — every write spelling, against source the walk never produced', () => {
    it('fires on all five spellings', () => {
      for (const spelling of [
        `await tx.insert(${BINDING}).values(row);`,
        `await db\n  .update(${BINDING})\n  .set({ selectionState: 'selected' });`,
        `await db.delete(${BINDING}).where(x);`,
        `await db.execute(sql\`update "${TABLE}" set selection_state = 'selected'\`);`,
        `await db.execute(sql\`insert into \${${BINDING}} (id) values (1)\`);`,
      ]) {
        expect(SELECTED_FACT_WRITE.test(spelling), `not matched: ${spelling}`).toBe(true);
      }
    });

    it('does NOT fire on a read, or on the CLAIM tables it sits beside', () => {
      // A detector that cannot tell a legitimate value from its quarry gets
      // narrowed under pressure, and narrowing is the permissive direction.
      for (const clean of [
        `const rows = await db.select().from(${BINDING}).where(eq(${BINDING}.id, id));`,
        `await tx.insert(nativeListingAttributeClaims).values(row);`,
        `await tx.update(nativeVariantAttributeClaims).set({ resolution: 'ambiguous' });`,
        `await db.execute(sql\`select * from "${TABLE}"\`);`,
      ]) {
        expect(SELECTED_FACT_WRITE.test(clean), `wrongly matched: ${clean}`).toBe(false);
      }
    });
  });
});
