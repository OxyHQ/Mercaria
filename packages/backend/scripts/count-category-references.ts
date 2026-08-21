/**
 * Count every foreign key pointing at `categories`, grouped by its `ON DELETE`.
 *
 * `services/catalog-governance/impact-plan.ts` states that split in prose above
 * `CATEGORY_REFERENCES`, and a count in prose is exactly the claim that rots
 * silently: it read "Fifteen `restrict` and five `cascade`" for twenty entries
 * when the truth was sixteen and four, and the error survived because the next
 * person to touch it would naturally do arithmetic on the existing sentence
 * rather than re-measure. Doing arithmetic on a wrong number produces a wrong
 * number that looks freshly checked.
 *
 * So this is the re-derivation, off the same drizzle metadata
 * `impact-plan-census.test.ts` walks — never off the plan's own array, which
 * would be circular (the plan is asserted to MATCH the schema, so counting the
 * plan tells you nothing the census has not already checked).
 *
 * Run it from `packages/backend`:
 *
 *     bun scripts/count-category-references.ts
 *
 * It is deliberately NOT a test. An exact-count assertion over the whole schema
 * conflicts on every parallel branch and neither side is right — the
 * `SCHEMA_TABLE_COUNT` problem — and the property that actually matters (the
 * plan covers exactly the schema's references) is already gated by the census.
 * What this adds is the ability to re-derive one sentence cheaply.
 */

import { getTableConfig, PgTable as PgTableClass } from 'drizzle-orm/pg-core';
import { getTableName, is } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';

interface Reference {
  readonly key: string;
  readonly onDelete: string;
}

function inboundCategoryReferences(): Reference[] {
  const found: Reference[] = [];

  for (const value of Object.values(schema)) {
    if (!is(value, PgTableClass)) continue;
    const table = value as PgTable;
    for (const foreignKey of getTableConfig(table).foreignKeys) {
      const reference = foreignKey.reference();
      if (getTableName(reference.foreignTable as PgTable) !== 'categories') continue;
      /**
       * `unspecified` rather than a default: drizzle omits `onDelete` when the
       * declaration did, and Postgres's own default is `NO ACTION`. Printing
       * `restrict` for an undeclared one would report a decision nobody made —
       * and CONVENTIONS.md requires every relation to declare one explicitly,
       * so a non-zero count here is itself a finding.
       */
      const onDelete = (foreignKey as unknown as { onDelete?: string }).onDelete ?? 'unspecified';
      for (const column of reference.columns) {
        found.push({ key: `${getTableName(table)}.${column.name}`, onDelete });
      }
    }
  }

  return found.sort((a, b) => a.key.localeCompare(b.key));
}

type PgTable = Parameters<typeof getTableConfig>[0];

const references = inboundCategoryReferences();
const byOnDelete = new Map<string, number>();
for (const reference of references) {
  byOnDelete.set(reference.onDelete, (byOnDelete.get(reference.onDelete) ?? 0) + 1);
}

console.log(`Inbound foreign keys into "categories": ${references.length}`);
for (const [onDelete, count] of [...byOnDelete].sort()) {
  console.log(`  ${onDelete}: ${count}`);
}
console.log('');
for (const reference of references) {
  console.log(`  ${reference.key} -> ${reference.onDelete}`);
}
