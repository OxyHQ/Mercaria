/**
 * "Use X instead" between controlled values — #367 line 280.
 *
 * ## What shaped the design, and what these cases have to prove
 *
 * `mercaria_attribute_enum_frozen` refuses INSERT, UPDATE *and* DELETE on
 * `attribute_enum_values` for any definition that has left `draft`. That single
 * fact decided the direction: a retired value's row belongs to a PUBLISHED
 * version and can never be written again, so the pointer lives on the SUCCESSOR
 * and is set at draft time. `refuses to write a redirect onto a published value`
 * is the case that proves the freeze really does refuse it — without it, the
 * backward direction reads as an arbitrary preference rather than the only
 * option.
 *
 * The second thing worth proving is that the version route works at all: a value
 * dropped from N+1 disappears from ACTIVE resolution while its row survives for
 * the assignments that cite it. That is the half I got wrong in #899 before
 * measuring it, so it is pinned here rather than asserted in prose.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { isCheckViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import {
  attributeDefinitions,
  attributeEnumValues,
} from '../../../db/schema/attributeRegistry.js';
import {
  draftAttributeDefinition,
  publishAttributeDefinition,
  resolveActiveDefinition,
} from '../definition-registry.service.js';

const RUN = uuidv7().slice(-10).replace(/-/g, '');
const OPERATOR = `op-280-${RUN}`;

let db: Database;
const keys: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  if (keys.length === 0) {
    await closePostgres();
    return;
  }
  const ids = (
    await db
      .select({ id: attributeDefinitions.id })
      .from(attributeDefinitions)
      .where(inArray(attributeDefinitions.key, keys))
  ).map((row) => row.id);

  if (ids.length > 0) {
    // Demote FIRST. `mercaria_attribute_enum_frozen` refuses to delete an enum
    // value while its parent is published, and
    // `mercaria_attribute_definition_immutable` refuses to delete the parent
    // itself — the same demote-then-delete teardown
    // `attribute-registry.realdb.test.ts` uses, and both refusals ARE those
    // triggers working.
    await db
      .update(attributeDefinitions)
      .set({ lifecycleState: 'draft', publishedAt: null, deprecatedAt: null })
      .where(inArray(attributeDefinitions.id, ids));
    // Then clear the redirects: the self-FK is RESTRICT, so a successor naming a
    // predecessor pins it and the delete below would fail on 23503.
    await db
      .update(attributeEnumValues)
      .set({ replacesEnumValueId: null })
      .where(inArray(attributeEnumValues.attributeDefinitionId, ids));
    await db.delete(attributeEnumValues).where(inArray(attributeEnumValues.attributeDefinitionId, ids));
    await db.delete(attributeDefinitions).where(inArray(attributeDefinitions.id, ids));
  }
  await closePostgres();
});

/** One ACTIVE enum definition carrying the named values. */
async function publishedEnum(
  label: string,
  values: readonly { value: string; label: string; replacesEnumValueId?: string }[],
): Promise<{
  key: string;
  version: number;
  byValue: Map<string, string>;
  dto: Awaited<ReturnType<typeof publishAttributeDefinition>>;
}> {
  const key = `l280_${label}_${RUN}`;
  if (!keys.includes(key)) keys.push(key);
  const drafted = await draftAttributeDefinition({
    key,
    label: `Line 280 ${label}`,
    valueType: 'enum',
    enumValues: values.map((entry) => ({ ...entry })),
    actorOxyUserId: OPERATOR,
  });
  const published = await publishAttributeDefinition(key, drafted.version, OPERATOR);
  return {
    key,
    version: published.version,
    byValue: new Map(published.enumValues.map((entry) => [entry.value, entry.id])),
    dto: published,
  };
}

describe('retiring a controlled value, and saying what replaces it', () => {
  it('drops a value from the ACTIVE version while its row survives for stored assignments', async () => {
    // The half I asserted wrongly in #899 before measuring it. A value is
    // retired by drafting N+1 that carries everything except it; the old row is
    // not deleted, and could not be.
    const first = await publishedEnum('retire', [
      { value: 'gray', label: 'Gray' },
      { value: 'blue', label: 'Blue' },
    ]);
    const grayId = first.byValue.get('gray');
    expect(grayId, 'the fixture must actually contain gray').toBeDefined();

    const second = await draftAttributeDefinition({
      key: first.key,
      label: `Line 280 retire`,
      valueType: 'enum',
      enumValues: [{ value: 'blue', label: 'Blue' }],
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(first.key, second.version, OPERATOR);

    // Gone from what new authoring is offered…
    const active = await resolveActiveDefinition(db, first.key);
    expect(active?.enumValues.map((entry) => entry.value).sort()).toEqual(['blue']);

    // …and the row itself is still there, which is what keeps every assignment
    // recorded under version 1 resolvable.
    const survivor = await db
      .select({ id: attributeEnumValues.id })
      .from(attributeEnumValues)
      .where(eq(attributeEnumValues.id, grayId ?? ''));
    expect(survivor).toHaveLength(1);
  });

  it('records the redirect on the successor, and publishes it', async () => {
    const first = await publishedEnum('redirect', [{ value: 'gray', label: 'Gray' }]);
    const grayId = first.byValue.get('gray');

    const second = await draftAttributeDefinition({
      key: first.key,
      label: 'Line 280 redirect',
      valueType: 'enum',
      enumValues: [{ value: 'grey', label: 'Grey', replacesEnumValueId: grayId }],
      actorOxyUserId: OPERATOR,
    });
    const published = await publishAttributeDefinition(first.key, second.version, OPERATOR);

    const grey = published.enumValues.find((entry) => entry.value === 'grey');
    expect(grey?.replacesEnumValueId).toBe(grayId);
    // The id is published too, or the pointer names something no consumer of
    // this shape could resolve.
    expect(grey?.id).toBeDefined();
  });

  it('omits the field entirely when a value replaces nothing', async () => {
    // The ordinary case, and the one that would go red if the column were ever
    // made NOT NULL or defaulted: most values replace nothing.
    const only = await publishedEnum('plain', [{ value: 'red', label: 'Red' }]);
    expect(only.dto.enumValues).toHaveLength(1);
    expect('replacesEnumValueId' in only.dto.enumValues[0]!).toBe(false);
  });
});

describe('the freeze is what forced the direction', () => {
  it('refuses to write a redirect onto a PUBLISHED value — the reason this points backward', async () => {
    // If this ever stops refusing, the forward direction becomes available and
    // this whole design should be revisited. That is why it is a test and not a
    // sentence in the docblock.
    const first = await publishedEnum('frozen', [{ value: 'alpha', label: 'Alpha' }]);
    const second = await publishedEnum('frozen_target', [{ value: 'beta', label: 'Beta' }]);
    const alphaId = first.byValue.get('alpha');
    const betaId = second.byValue.get('beta');

    let thrown: unknown;
    try {
      await db
        .update(attributeEnumValues)
        .set({ replacesEnumValueId: betaId })
        .where(eq(attributeEnumValues.id, alphaId ?? ''));
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown, 'expected the freeze to refuse the write, but it succeeded').toBeDefined();
    // `restrict_violation` (23001) is the trigger, and naming the SQLSTATE is
    // what stops a different refusal passing for this one.
    const code = (thrown as { cause?: { code?: string } })?.cause?.code;
    expect(code, `expected 23001 from the freeze, got ${String(code)}`).toBe('23001');
  });
});

describe('the two constraints', () => {
  it('refuses a value that replaces ITSELF', async () => {
    const seeded = await publishedEnum('selfref', [{ value: 'solo', label: 'Solo' }]);
    const soloId = seeded.byValue.get('solo');

    // Demoted to draft first, so the FREEZE is not what refuses this — the
    // CHECK is. Without that, this case would pass on the wrong constraint.
    await db
      .update(attributeDefinitions)
      .set({ lifecycleState: 'draft', publishedAt: null, deprecatedAt: null })
      .where(eq(attributeDefinitions.key, seeded.key));

    let thrown: unknown;
    try {
      await db
        .update(attributeEnumValues)
        .set({ replacesEnumValueId: soloId })
        .where(eq(attributeEnumValues.id, soloId ?? ''));
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown, 'expected a check violation, but the write succeeded').toBeDefined();
    expect(isCheckViolation(thrown), `expected a check violation, got: ${String(thrown)}`).toBe(
      true,
    );
  });

  it('refuses TWO successors claiming the same predecessor', async () => {
    // "Use X instead" has to be unambiguous. Two rows replacing `gray` is a
    // question with no answer.
    const first = await publishedEnum('dup', [{ value: 'old', label: 'Old' }]);
    const oldId = first.byValue.get('old');

    // The DRAFT is what must fail: both rows are inserted inside
    // `draftAttributeDefinition`'s own transaction, so the partial unique
    // refuses the second one there and publish is never reached.
    await expect(
      draftAttributeDefinition({
        key: first.key,
        label: 'Line 280 dup',
        valueType: 'enum',
        enumValues: [
          { value: 'new_a', label: 'New A', replacesEnumValueId: oldId },
          { value: 'new_b', label: 'New B', replacesEnumValueId: oldId },
        ],
        actorOxyUserId: OPERATOR,
      }),
    ).rejects.toThrow();
  });
});
