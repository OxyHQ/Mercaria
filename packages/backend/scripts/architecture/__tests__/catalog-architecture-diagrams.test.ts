/**
 * THE GATE over the catalogue architecture diagrams.
 *
 * Two documents are held here and they are held differently, because they are
 * different kinds of artefact:
 *
 * - `docs/catalog-architecture-diagrams.md` is GENERATED. The gate re-renders
 *   it from the derived model and byte-compares, so it cannot disagree with the
 *   schema at all — a hand edit is a red build with the exact command to fix it.
 * - `docs/catalog-glossary.md` carries a hand-drawn, hand-annotated SUBSET. It
 *   is worth keeping: the annotations ("search-time, never a name", "cites an
 *   attribute VERSION") are the reason a newcomer reads it first, and a
 *   generator cannot write them. So it is GATED instead — every edge in it must
 *   be a real foreign key carrying exactly the cardinality the schema proves.
 *
 * ## Why a diagram earns a gate at all
 *
 * `docs/catalog-table-ownership.md` records four figures that silently rotted
 * before #857 removed them. A diagram is a worse home for that kind of fact
 * than a sentence: a wrong arrow reads as a design decision rather than as an
 * error, so it is argued with instead of corrected. That is not a prediction
 * here — the glossary diagram carried eight edges claiming a mandatory parent
 * for a nullable foreign key when this gate was first run, including one that
 * said every listing has a category.
 *
 * ## What a gate over a diagram can and cannot prove
 *
 * It proves an edge is a real foreign key with the right markers, and that
 * every table in the population appears. It cannot prove the LABEL is true, and
 * it cannot prove the diagram is the right diagram to have drawn. So the things
 * it does trust are bound to things that exist and are checked: every writer
 * directory names files the walk actually read, every anchor table resolves
 * through the drizzle barrel, and the two detectors are driven against mutated
 * inputs in both directions before they are trusted against the real ones.
 */

import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DIAGRAM_DOC,
  FIRST_EPIC_MIGRATION_IDX,
  OWNERSHIP_DOC,
  REPO_ROOT,
  buildModel,
  censusCreatedTables,
  productionSources,
  stripComments,
  tableNameBySymbol,
  tablesByName,
} from '../model.js';
import {
  CHILD_LEFT,
  CHILD_RIGHT,
  PARENT_LEFT,
  PARENT_RIGHT,
  type ParsedRelationship,
  parseEntities,
  parseRelationships,
  relationshipAgrees,
} from '../mermaid.js';
import { renderDocument } from '../render.js';
import type { CardinalityEdge } from '../model.js';

const GLOSSARY_DOC = join(REPO_ROOT, 'docs', 'catalog-glossary.md');

const model = buildModel();
const population = new Set(model.population.keys());
const diagramDoc = readFileSync(DIAGRAM_DOC, 'utf8');
const glossaryDoc = readFileSync(GLOSSARY_DOC, 'utf8');
const created = censusCreatedTables();

/**
 * The comparison, factored out of every assertion that makes it, so the
 * mutation self-tests can drive the SAME function against text held in memory.
 * A self-test that exercised a second copy of the logic would prove that copy
 * works.
 */
function unknownEntities(entities: ReadonlySet<string>): readonly string[] {
  return [...entities].filter((name) => !tablesByName.has(name)).sort();
}

function missingFromDiagram(entities: ReadonlySet<string>): readonly string[] {
  return [...population].filter((table) => !entities.has(table)).sort();
}

/** Every parsed relationship that is not a real foreign key with those markers. */
function disagreeingRelationships(
  parsed: readonly ParsedRelationship[],
  edges: readonly CardinalityEdge[],
): readonly string[] {
  const problems: string[] = [];
  for (const relationship of parsed) {
    const between = edges.filter(
      (edge) =>
        (edge.parent === relationship.left && edge.child === relationship.right) ||
        (edge.child === relationship.left && edge.parent === relationship.right),
    );
    if (between.length === 0) {
      problems.push(
        `no foreign key joins these tables: "${relationship.source}" — the diagram asserts a ` +
          'relationship the schema does not have',
      );
      continue;
    }
    if (between.some((edge) => relationshipAgrees(relationship, edge))) continue;
    const truth = between
      .map((edge) =>
        edge.parent === relationship.left
          ? `${edge.parent} ${PARENT_LEFT[edge.parentSide]}--${CHILD_RIGHT[edge.childSide]} ${edge.child} [${edge.columns.join(' + ')}]`
          : `${edge.child} ${CHILD_LEFT[edge.childSide]}--${PARENT_RIGHT[edge.parentSide]} ${edge.parent} [${edge.columns.join(' + ')}]`,
      )
      .join('  OR  ');
    problems.push(`"${relationship.source}" — the schema proves ${truth}`);
  }
  return problems;
}

describe('the generated architecture diagrams cannot disagree with the schema', () => {
  it('is not vacuous: every input the model reads is large', () => {
    /**
     * Six independent floors, because six independent things can silently
     * return nothing here — and every assertion below passes against an empty
     * pair of sets. Floors, never equalities: the population grows without
     * anybody editing this file, which is the point.
     */
    expect(created.length, 'the migration chain parsed to no tables at all').toBeGreaterThanOrEqual(400);
    expect(population.size, 'the derived population is empty or tiny').toBeGreaterThanOrEqual(54);
    expect(tablesByName.size, 'the drizzle barrel exported no tables').toBeGreaterThanOrEqual(400);
    expect(model.modules.length, 'no module row was parsed out of the ownership map').toBeGreaterThanOrEqual(12);
    expect(
      model.edges.filter((edge) => population.has(edge.child)).length,
      'no foreign key was reflected out of the epic tables',
    ).toBeGreaterThanOrEqual(120);
    expect(model.writers.size, 'the write census found no writer for any epic table').toBeGreaterThanOrEqual(50);
  });

  it('THE INVERSE FLOOR: the detectors report something when the subject is PRESENT', () => {
    /**
     * The floors above ask what happens when a thing is absent. This asks the
     * other question, which is the one nobody writes: a detector that can only
     * ever answer "clean" satisfies every assertion in this file. Both are
     * driven against inputs built here, so neither can be satisfied by the real
     * documents happening to be correct.
     */
    expect(unknownEntities(new Set(['category_aliases', 'a_table_that_was_never_created']))).toEqual([
      'a_table_that_was_never_created',
    ]);

    // The dropped member is NAMED rather than recovered by re-sorting. The
    // population's insertion order is `localeCompare`d and `Array.sort()` is
    // by UTF-16 code unit; the two disagree about `_` against a letter, so the
    // obvious spelling — drop index 0, expect `[...population].sort()[0]` — is
    // a test that could go red for a reason with nothing to do with diagrams,
    // as soon as a table name lands in the wrong place. They agree today.
    const [dropped, ...rest] = [...population];
    expect(missingFromDiagram(new Set(rest))).toEqual([dropped]);

    const invented: ParsedRelationship = {
      left: 'categories',
      leftMarker: '||',
      rightMarker: 'o{',
      right: 'payments',
      label: 'invented',
      source: 'categories ||--o{ payments : "invented"',
    };
    expect(disagreeingRelationships([invented], model.edges)).toHaveLength(1);
  });

  it('the checked-in document is EXACTLY what the generator produces', () => {
    /**
     * The whole of "it cannot rot", in one assertion. The generator is a pure
     * function of the model — no clock, no environment — so this is a stable
     * comparison rather than a diff of the interesting parts.
     */
    expect(
      renderDocument(model) === diagramDoc,
      'docs/catalog-architecture-diagrams.md is out of date with the schema it describes. It is ' +
        'GENERATED: run `bun run --cwd packages/backend architecture:diagrams` and commit the ' +
        'result. Do not hand-edit it — the prose lives in ' +
        'packages/backend/scripts/architecture/render.ts.',
    ).toBe(true);
  });

  it('POSITIVE CONTROL: every entity in the generated diagrams is a real drizzle table', () => {
    /**
     * What catches a renderer that started emitting a keyword, a label or regex
     * debris as an entity: the failure in which the diagram is large, the names
     * are plausible and none of them is a table.
     */
    const entities = parseEntities(diagramDoc);
    expect(entities.size, 'no entity was parsed out of the generated document').toBeGreaterThanOrEqual(60);
    expect(unknownEntities(entities), 'these appear as entities and no drizzle table has that name').toEqual([]);
  });

  it('every table in the derived population appears as a node', () => {
    const entities = parseEntities(diagramDoc);
    expect(
      missingFromDiagram(entities),
      `these tables were created by a migration at or after ${FIRST_EPIC_MIGRATION_IDX} and no ` +
        'diagram names them. A table absent from the map is the one that acquires a second writer ' +
        'nobody argues about.',
    ).toEqual([]);
  });

  it('every relationship drawn is a real foreign key with the cardinality the schema proves', () => {
    const parsed = parseRelationships(diagramDoc);
    expect(parsed.length, 'no relationship was parsed; the comparison below compares nothing').toBeGreaterThanOrEqual(
      120,
    );
    expect(disagreeingRelationships(parsed, model.edges)).toEqual([]);
  });

  it('every foreign key out of an epic table is DRAWN, not just the ones drawn correctly', () => {
    /**
     * The direction the check above cannot make. It asks whether each drawn
     * edge is true; this asks whether each true edge is drawn. A renderer that
     * dropped half the foreign keys would pass the first and fail here.
     */
    const parsed = parseRelationships(diagramDoc);
    const drawn = new Set(
      parsed.flatMap((relationship) => [
        `${relationship.left}->${relationship.right}`,
        `${relationship.right}->${relationship.left}`,
      ]),
    );
    const undrawn = model.edges
      .filter((edge) => population.has(edge.child))
      .filter((edge) => !drawn.has(`${edge.parent}->${edge.child}`))
      .map((edge) => `${edge.parent} -> ${edge.child} [${edge.columns.join(' + ')}]`)
      .sort();
    expect(undrawn, 'these foreign keys exist in the schema and no diagram draws them').toEqual([]);
  });

  it('MUTATION SELF-TEST: a removed node is named, and an invented one is named', () => {
    /**
     * Both directions, against copies in memory, and each mutation is asserted
     * to have APPLIED before the detector is run on it — a mutation that never
     * landed is indistinguishable from one the detector survived.
     */
    const victim = 'catalog_governance_role_grants';
    expect(population.has(victim), 'the mutation victim is not in the population to begin with').toBe(true);

    const withoutVictim = diagramDoc
      .split('\n')
      .filter((line) => !line.includes(victim))
      .join('\n');
    const afterRemoval = parseEntities(withoutVictim);
    expect(afterRemoval.has(victim), 'the mutation did not apply; what follows proves nothing').toBe(false);
    expect(missingFromDiagram(afterRemoval)).toEqual([victim]);

    const invented = 'catalog_tables_nobody_created';
    expect(tablesByName.has(invented), 'the invented name accidentally exists').toBe(false);
    const withInvented = diagramDoc.replace('erDiagram\n', `erDiagram\n    ${invented} {\n    }\n`);
    expect(withInvented === diagramDoc, 'the injection did not apply').toBe(false);
    const afterInjection = parseEntities(withInvented);
    expect(afterInjection.has(invented), 'the injected entity did not parse').toBe(true);
    expect(unknownEntities(afterInjection)).toEqual([invented]);

    // And the pair: with the real document, the same two functions answer
    // empty. A detector wired to an empty read would answer empty here too,
    // which is why the two mutations above are what carry the proof.
    const real = parseEntities(diagramDoc);
    expect(unknownEntities(real)).toEqual([]);
    expect(missingFromDiagram(real)).toEqual([]);
  });
});

describe("the glossary's hand-drawn diagram is gated against the same derivation", () => {
  const parsed = parseRelationships(glossaryDoc);

  it('is not vacuous: the curated diagram still has edges in it', () => {
    expect(
      parsed.length,
      'no relationship was parsed out of docs/catalog-glossary.md — the diagram was removed, or ' +
        'the parse stopped matching, and either way the assertions below compare nothing',
    ).toBeGreaterThanOrEqual(25);
    expect(
      new Set(parsed.flatMap((relationship) => [relationship.left, relationship.right])).size,
      'the curated diagram names too few distinct tables to be the one this gate is about',
    ).toBeGreaterThanOrEqual(15);
  });

  it('every curated edge is a real foreign key with the cardinality the schema proves', () => {
    expect(
      disagreeingRelationships(parsed, model.edges),
      'docs/catalog-glossary.md draws a relationship the schema does not have, or draws one with ' +
        'the wrong cardinality. `||` on the parent side means the foreign-key column is NOT NULL; ' +
        'if it is nullable the marker is `|o`. This gate exists because eight edges there once ' +
        'claimed a mandatory parent for a nullable column, and nothing could notice.',
    ).toEqual([]);
  });

  it('MUTATION SELF-TEST: a flipped marker and an invented edge are both caught', () => {
    const target = 'listings }o--o| categories';
    expect(glossaryDoc.includes(target), 'the mutation target is not in the glossary as written').toBe(true);

    // The exact regression this gate was built for: the optional parent read as
    // mandatory. It must be named, not merely counted.
    const flipped = glossaryDoc.replace(target, 'listings }o--|| categories');
    expect(flipped === glossaryDoc, 'the marker mutation did not apply').toBe(false);
    const afterFlip = disagreeingRelationships(parseRelationships(flipped), model.edges);
    expect(afterFlip).toHaveLength(1);
    expect(afterFlip[0]).toContain('listings }o--|| categories');

    // And an edge between two tables no foreign key joins.
    const withInvented = glossaryDoc.replace(
      'erDiagram\n',
      'erDiagram\n    categories ||--o{ payments : "invented"\n',
    );
    expect(withInvented === glossaryDoc, 'the edge injection did not apply').toBe(false);
    const afterInjection = disagreeingRelationships(parseRelationships(withInvented), model.edges);
    expect(afterInjection).toHaveLength(1);
    expect(afterInjection[0]).toContain('no foreign key joins these tables');

    // The pair, for the same reason as above.
    expect(disagreeingRelationships(parsed, model.edges)).toEqual([]);
  });
});

describe('the model is anchored to things that exist', () => {
  it('BOUNDARY ANCHOR: 0088 is the epic\'s first migration, pinned to what it creates', () => {
    /**
     * The same anchor `catalog-table-ownership-census.test.ts` uses, applied
     * independently rather than imported from a test file. It is what stops the
     * boundary constant being raised to silence a failure: `0086` creates four
     * `referral_pilot_*` tables and sits immediately below a long run of
     * catalogue migrations, so it reads as the start of the run to anyone who
     * finds the boundary by scrolling.
     */
    const atBoundary = created
      .filter((entry) => entry.idx === FIRST_EPIC_MIGRATION_IDX)
      .map((entry) => entry.table)
      .sort();
    expect(atBoundary).toEqual(['category_aliases', 'category_external_mappings', 'category_redirects']);

    // And the constant agrees with the census that owns it, read out of that
    // file's source rather than imported from it.
    const censusSource = readFileSync(
      join(REPO_ROOT, 'packages', 'backend', 'src', 'db', '__tests__', 'catalog-table-ownership-census.test.ts'),
      'utf8',
    );
    expect(
      censusSource.includes(`const FIRST_EPIC_MIGRATION_IDX = ${FIRST_EPIC_MIGRATION_IDX};`),
      'this model and catalog-table-ownership-census.test.ts disagree about where the epic starts, ' +
        'so the diagram and the ownership map are censusing different populations',
    ).toBe(true);
  });

  it('every table is grouped under exactly one module, and the grouping covers the population', () => {
    const seen = new Map<string, string[]>();
    for (const assignment of model.modules) {
      for (const table of assignment.tables) seen.set(table, [...(seen.get(table) ?? []), assignment.module]);
    }
    expect(
      [...seen].filter(([, modules]) => modules.length > 1).map(([table, modules]) => `${table}: ${modules.join(', ')}`),
      'the ownership map names a table under more than one module, so the diagram would draw it twice',
    ).toEqual([]);
    expect(
      [...population].filter((table) => !seen.has(table)).sort(),
      'the ownership map does not name these, so they have no module to be drawn under. ' +
        'catalog-table-ownership-census.test.ts should have caught this first.',
    ).toEqual([]);
    expect(
      [...seen.keys()].filter((table) => !population.has(table)).sort(),
      'the module table names something outside the derived population',
    ).toEqual([]);
  });

  it('KNOWN ANSWER: the one relationship the schema proves is 1:1 is still detected', () => {
    /**
     * A baseline with an answer known independently of this code, because the
     * 1:1 derivation failed silently once already: index columns are
     * `IndexedColumn` rather than `Column`, so treating a non-`Column` as an
     * expression dropped EVERY unique index and turned this edge into a 1:N. No
     * error, no empty output — a diagram that was merely less true. Counting
     * would not have caught it either, since the count moved from one to zero.
     */
    const oneToOne = model.edges
      .filter((edge) => population.has(edge.child) && edge.childSide === 'atMostOne')
      .map((edge) => `${edge.parent} -> ${edge.child}`);
    expect(oneToOne).toContain('product_variants -> native_variant_signatures');

    // And repo-wide, so the derivation is exercised well past this one table.
    expect(
      model.edges.filter((edge) => edge.childSide === 'atMostOne').length,
      'the 1:1 derivation found almost nothing across 450+ tables, which is what it reports when ' +
        'unique indexes stop being read',
    ).toBeGreaterThanOrEqual(20);
  });

  it('KNOWN ANSWER: the write census reproduces the hand-written list in the ownership map', () => {
    /**
     * `catalog-table-ownership.md` names, by hand and in prose, the tables with
     * no application writer. This census derives that set independently, from
     * the source. The two agreeing is the strongest available evidence that the
     * scanner works — a scanner that matched nothing would report every table
     * as unwritten, and one that over-matched would report none.
     */
    const unwritten = [...population].filter((table) => !model.writers.has(table)).sort();
    expect(unwritten).toEqual([
      'canonical_product_family_localizations',
      'canonical_product_localizations',
      'catalog_localization_revisions',
      'product_type_aliases',
    ]);

    const ownership = readFileSync(OWNERSHIP_DOC, 'utf8');
    for (const table of unwritten) {
      expect(
        ownership.includes(`\`${table}\``),
        `the write census says nothing writes \`${table}\`, and the ownership map does not mention ` +
          'it at all. One of the two is wrong and neither can tell you which.',
      ).toBe(true);
    }
  });

  it('every writer entry names files the walk actually read, and a real drizzle table', () => {
    /**
     * A census proves a table was classified; it can never prove the
     * classification is true. So what it does claim is bound to what is
     * checkable: the file exists in the walk, and the table exists in the
     * barrel. A stale path permits nothing and reads exactly like a correct run.
     */
    const sources = productionSources();
    expect(sources.size, 'the production walk read almost nothing — did the layout move?').toBeGreaterThan(400);
    let checked = 0;
    for (const [table, writers] of model.writers) {
      expect(tablesByName.has(table), `the write census named \`${table}\` and no such table exists`).toBe(true);
      for (const writer of writers) {
        for (const file of writer.files) {
          checked += 1;
          expect(sources.has(file.split('/').join(sep)), `writer path is stale: ${file}`).toBe(true);
        }
        expect(writer.operations.length, `\`${table}\` has a writer with no operation recorded`).toBeGreaterThan(0);
      }
    }
    expect(checked, 'no writer file was checked; this test measured nothing').toBeGreaterThanOrEqual(50);
  });

  it('no schema symbol is imported under an alias, which the write census could not follow', () => {
    /**
     * Turning the scanner's one structural blind spot into a gate rather than a
     * caveat. `db.insert(ca)` after `import { categoryAliases as ca }` is
     * invisible to a scan keyed on the export name — and invisible in the
     * direction that reports a table as unwritten, which is the reading under
     * which a second writer gets added.
     *
     * It is a real gate rather than a comment because it can fail: the pattern
     * is driven against a synthetic import below.
     */
    const ALIASED_SCHEMA_IMPORT = /import\s*\{[^}]*?\b([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*[^}]*\}\s*from\s*['"][^'"]*schema\/[^'"]*['"]/gs;

    const offenders: string[] = [];
    for (const [file, source] of productionSources()) {
      for (const match of source.matchAll(ALIASED_SCHEMA_IMPORT)) {
        if (tableNameBySymbol.has(match[1])) offenders.push(`${file}: ${match[0].replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    expect(
      offenders,
      'a drizzle table is imported under an alias. The write census keys on the export name, so ' +
        'writes through the alias are invisible to it and the table reads as unwritten. Import it ' +
        'under its own name, or teach the census to resolve aliases.',
    ).toEqual([]);

    // The mutation self-test, because an absence assertion over a pattern that
    // matches nothing is the same clean green as one over a clean tree.
    const synthetic = stripComments(
      "import { categoryAliases as ca } from '../schema/taxonomy.js';\nconst x = ca;\n",
    );
    const matched = [...synthetic.matchAll(ALIASED_SCHEMA_IMPORT)].map((match) => match[1]);
    expect(matched, 'the aliased-import detector cannot match an aliased import').toEqual(['categoryAliases']);
    expect(tableNameBySymbol.has('categoryAliases')).toBe(true);
  });

  it('the comment stripper removes comments and keeps the template literals raw SQL lives in', () => {
    /**
     * Both halves, because they fail in opposite directions. Keeping comments
     * makes the census read prose — this repository documents what its modules
     * refuse to do in the same vocabulary they would use to do it. Dropping
     * literals makes the raw-SQL half of the census answer a clean zero.
     */
    const stripped = stripComments(
      ["// db.insert(commented)", "/* .update(alsoCommented) */", 'const q = sql`update category_aliases set x = 1`;'].join(
        '\n',
      ),
    );
    expect(stripped).not.toContain('commented');
    expect(stripped).toContain('update category_aliases');
  });
});
