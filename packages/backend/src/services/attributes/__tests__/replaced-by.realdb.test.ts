/**
 * "Use X instead" on an attribute definition — #367 line 237.
 *
 * ## What this measures that the schema alone does not
 *
 * A column nothing can write is a column nothing can write. So these cases drive
 * the real service (`deprecateAttributeDefinition`), not an `INSERT`, and the
 * two CHECKs are exercised by attempting the writes they exist to refuse — a
 * CHECK asserted only in a schema file is a comment.
 *
 * ## The two directions, per case
 *
 * Every refusal case is paired with the write that must SUCCEED, because a
 * constraint that refused everything would satisfy the refusals alone. And the
 * `deprecate with no successor` case is what stops the lifecycle CHECK being
 * written as a biconditional later: it is the shape that would go red.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { isCheckViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { attributeDefinitions } from '../../../db/schema/attributeRegistry.js';
import {
  deprecateAttributeDefinition,
  draftAttributeDefinition,
  publishAttributeDefinition,
} from '../definition-registry.service.js';

const RUN = uuidv7().slice(-10).replace(/-/g, '');
const OPERATOR = `op-237-${RUN}`;

let db: Database;
const keys: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  // THREE steps, and the order is load-bearing — measured on this file's first
  // run, where two of them were missing.
  //
  // 1. Clear the pointers. The self-FK is RESTRICT, so a predecessor naming a
  //    successor pins it.
  // 2. Demote to `draft`. `mercaria_attribute_definition_immutable` refuses
  //    DELETE on any row that is not a draft — "stored values cite this
  //    version" — so a published definition cannot be removed at all. That IS
  //    the trigger working; the same demote-first teardown is in
  //    `attribute-registry.realdb.test.ts` and `canonical-catalog.realdb.test.ts`.
  // 3. Delete.
  //
  // 1 must precede 2: demoting to `draft` while a pointer is still set violates
  // `attribute_definitions_replaced_by_lifecycle_check`, which permits one only
  // on a deprecated or retired row.
  if (keys.length > 0) {
    await db
      .update(attributeDefinitions)
      .set({ replacedByDefinitionId: null })
      .where(inArray(attributeDefinitions.key, keys));
    await db
      .update(attributeDefinitions)
      .set({ lifecycleState: 'draft', publishedAt: null, deprecatedAt: null })
      .where(inArray(attributeDefinitions.key, keys));
    await db.delete(attributeDefinitions).where(inArray(attributeDefinitions.key, keys));
  }
  await closePostgres();
});

/** An ACTIVE definition under a key this file owns. */
async function activeDefinition(label: string): Promise<{ key: string; id: string }> {
  const key = `l237_${label}_${RUN}`;
  keys.push(key);
  const drafted = await draftAttributeDefinition({
    key,
    label: `Line 237 ${label}`,
    valueType: 'string',
    actorOxyUserId: OPERATOR,
  });
  const published = await publishAttributeDefinition(key, drafted.version, OPERATOR);
  return { key, id: published.id };
}

describe('"use X instead" is representable on a deprecation', () => {
  it('records the replacement, and it survives to the DTO', async () => {
    const successor = await activeDefinition('successor');
    const predecessor = await activeDefinition('predecessor');

    const deprecated = await deprecateAttributeDefinition(
      predecessor.key,
      1,
      successor.id,
    );

    expect(deprecated.lifecycleState).toBe('deprecated');
    expect(deprecated.replacedByDefinitionId).toBe(successor.id);

    // …and it is on the ROW, not merely on the projection.
    const rows = await db
      .select({ replacedBy: attributeDefinitions.replacedByDefinitionId })
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, predecessor.id));
    expect(rows[0]?.replacedBy).toBe(successor.id);
  });

  it('deprecates with NO successor, and the DTO omits the field', async () => {
    // The case that fails if the lifecycle CHECK is ever tightened into a
    // biconditional. "We stopped using this" is a complete decision, and a
    // deprecation that REQUIRED a successor would make it unrepresentable.
    const solo = await activeDefinition('solo');

    const deprecated = await deprecateAttributeDefinition(solo.key, 1);

    expect(deprecated.lifecycleState).toBe('deprecated');
    expect('replacedByDefinitionId' in deprecated).toBe(false);
  });

  it('refuses a successor that does not exist, naming what was missing', async () => {
    const orphan = await activeDefinition('orphan');
    const absent = uuidv7();

    await expect(deprecateAttributeDefinition(orphan.key, 1, absent)).rejects.toThrow(
      new RegExp(absent),
    );

    // The refusal left the version ACTIVE — the whole transition rolled back
    // rather than half-applying, which is what makes the service check safe to
    // sit in front of the foreign key rather than beside it.
    const rows = await db
      .select({ state: attributeDefinitions.lifecycleState })
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, orphan.id));
    expect(rows[0]?.state).toBe('active');
  });
});

describe('the two CHECKs refuse what the service never asks for', () => {
  it('refuses a definition that replaces ITSELF', async () => {
    const narcissist = await activeDefinition('self');
    await deprecateAttributeDefinition(narcissist.key, 1);

    // Straight at the table: the service has no parameter that could produce
    // this, which is exactly why the constraint has to hold without it.
    let thrown: unknown;
    try {
      await db
        .update(attributeDefinitions)
        .set({ replacedByDefinitionId: narcissist.id })
        .where(eq(attributeDefinitions.id, narcissist.id));
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown, 'expected a check violation, but the write succeeded').toBeDefined();
    expect(isCheckViolation(thrown), `expected a check violation, got: ${String(thrown)}`).toBe(
      true,
    );
  });

  it('refuses a replacement on an ACTIVE version, and permits one on a deprecated one', async () => {
    const successor = await activeDefinition('lifecycle_successor');
    const stillActive = await activeDefinition('still_active');

    // The refusal: an active definition has not been replaced by anything.
    let thrown: unknown;
    try {
      await db
        .update(attributeDefinitions)
        .set({ replacedByDefinitionId: successor.id })
        .where(eq(attributeDefinitions.id, stillActive.id));
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown, 'expected a check violation, but the write succeeded').toBeDefined();
    expect(isCheckViolation(thrown)).toBe(true);

    // The positive control on the SAME constraint: once deprecated, the very
    // same write is permitted. Without this the CHECK would be satisfied by one
    // that refused every replacement.
    await deprecateAttributeDefinition(stillActive.key, 1);
    await db
      .update(attributeDefinitions)
      .set({ replacedByDefinitionId: successor.id })
      .where(eq(attributeDefinitions.id, stillActive.id));

    const rows = await db
      .select({ replacedBy: attributeDefinitions.replacedByDefinitionId })
      .from(attributeDefinitions)
      .where(
        and(
          eq(attributeDefinitions.id, stillActive.id),
          eq(attributeDefinitions.lifecycleState, 'deprecated'),
        ),
      );
    expect(rows[0]?.replacedBy).toBe(successor.id);
  });

  it('refuses DELETING a definition something still points at — by the FK, not the trigger', async () => {
    // This case was a FALSE POSITIVE on its first draft and the fix is the
    // interesting part. It used a PUBLISHED successor and asserted only
    // `.rejects.toThrow()` — but `mercaria_attribute_definition_immutable`
    // refuses deleting ANY non-draft row outright, so it passed with the foreign
    // key never consulted. A refusal is not evidence that the constraint you
    // meant fired.
    //
    // So the successor here is left a DRAFT, which the trigger permits deleting,
    // leaving `ON DELETE restrict` as the only thing that can refuse — and the
    // SQLSTATE is asserted to say WHICH refused: `23503` is a foreign key,
    // `23001` is that trigger.
    const successorKey = `l237_fk_successor_${RUN}`;
    keys.push(successorKey);
    const draft = await draftAttributeDefinition({
      key: successorKey,
      label: 'Line 237 fk successor',
      valueType: 'string',
      actorOxyUserId: OPERATOR,
    });

    const pointer = await activeDefinition('fk_pointer');
    await deprecateAttributeDefinition(pointer.key, 1, draft.id);

    let thrown: unknown;
    try {
      await db.delete(attributeDefinitions).where(eq(attributeDefinitions.id, draft.id));
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown, 'expected the delete to be refused, but it succeeded').toBeDefined();
    // A drizzle error's SQLSTATE lives on `cause`, never on `error.code`.
    const code = (thrown as { cause?: { code?: string } })?.cause?.code;
    expect(code, `expected 23503 (foreign key), got ${String(code)}`).toBe('23503');

    // The positive control on the same delete: with the pointer cleared, the
    // draft goes. Without it, a constraint that refused every delete would pass.
    await db
      .update(attributeDefinitions)
      .set({ replacedByDefinitionId: null })
      .where(eq(attributeDefinitions.id, pointer.id));
    await db.delete(attributeDefinitions).where(eq(attributeDefinitions.id, draft.id));
    const left = await db
      .select({ id: attributeDefinitions.id })
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, draft.id));
    expect(left).toHaveLength(0);
  });
});
