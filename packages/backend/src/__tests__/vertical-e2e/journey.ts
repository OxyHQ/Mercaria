/**
 * Shared machinery for the #367 Workstream 18 end-to-end vertical journeys.
 *
 * Not a test file — no `describe`, no `it`, nothing that registers a suite when
 * a case imports it. (`importing-a-test-file-registers-its-suites` is a real
 * failure mode: a value exported FROM a `.test.ts` drags its whole suite into
 * every importer.)
 *
 * ## What lives here and what deliberately does not
 *
 * Only things that would otherwise be copied between the three journey files:
 * the permission context, the two schema fingerprints, an enum-value lookup and
 * the population report. Every ASSERTION stays in the file that makes it, and
 * nothing here re-implements a resolver, a filter or a signature — the journeys
 * drive the functions the API drives, because a test that re-implements the code
 * under test measures the re-implementation.
 *
 * ## The population report is a deliverable, not a debug aid
 *
 * `reportPopulation` prints on SUCCESS and refuses a total of zero. A journey
 * that silently ran against an empty catalogue produces the same green as one
 * that ran against a full one, and every per-entity comparison it makes is
 * `0 === 0`. The refusal is a separate verdict from any assertion in the caller
 * for the reason `census.ts` gives one domain over: "nothing ran" and "one count
 * is short" lead a reader to opposite actions.
 */

import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { AuthoringPermissionContext, AuthoringSchema } from '@mercaria/shared-types';

import type { Database, DatabaseOrTransaction } from '../../db/postgres.js';
import { nsKey, type VerticalNamespace } from '../../scripts/seed-verticals/apply.js';

/**
 * A merchant who may do everything the authoring surface offers.
 *
 * Every permission on, deliberately: these journeys measure the catalogue, and
 * a narrower context would make a refusal ambiguous between "the schema forbids
 * this" and "this operator may not". `catalog-authoring-isolation.test.ts`
 * already covers the permission fingerprint's own effect on composition.
 */
export const E2E_PERMISSIONS: AuthoringPermissionContext = {
  canEditDraft: true,
  canPublish: true,
  canProposeValues: true,
  canSelectCanonicalEntity: true,
};

/**
 * The id of one controlled value of one namespaced attribute.
 *
 * Throws rather than returning `undefined`: a draft answer built on a missing
 * enum id fails later as a validation finding about a field, which names the
 * wrong thing.
 */
export async function enumValueId(
  db: DatabaseOrTransaction,
  ns: VerticalNamespace,
  attributeKey: string,
  value: string,
): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    select v.id
    from attribute_enum_values v
    join attribute_definitions d on d.id = v.attribute_definition_id
    where d.key = ${nsKey(ns, attributeKey)} and v.value = ${value}
  `);
  const id = [...rows][0]?.id;
  if (id === undefined) {
    throw new Error(`no controlled value ${nsKey(ns, attributeKey)}=${value} in this namespace`);
  }
  return id;
}

/** One `count(*)::int`, or zero when the statement matched nothing. */
export async function countOne(
  db: DatabaseOrTransaction,
  statement: ReturnType<typeof sql>,
): Promise<number> {
  const rows = await db.execute<{ total: number }>(statement);
  return [...rows][0]?.total ?? 0;
}

/** How many listings a store holds, whatever their status. */
export async function countStoreListings(db: Database, storeId: string): Promise<number> {
  return countOne(db, sql`select count(*)::int as total from listings where store_id = ${storeId}`);
}

/**
 * Everything about a composed schema that a LOCALE may not move.
 *
 * `text`, `locale`, `market` and `etag` are excluded because those are exactly
 * what a locale (or a market) is allowed to change; everything else is a rule,
 * and #367's "support locale switching without changing stored product/category/
 * value identity" is the statement that this digest is stable across locales.
 *
 * `controlledValues` is INSIDE the digest and carries no label — an
 * `AuthoringControlledValue` is `{id, value, position}`, and its display string
 * lives in `text.values[id]`. That split is what makes this fingerprint able to
 * be locale-invariant at all.
 */
export function semanticFingerprint(schema: AuthoringSchema): string {
  return digest({
    contractVersion: schema.contractVersion,
    productType: schema.productType,
    categoryId: schema.categoryId,
    flow: schema.flow,
    permissions: schema.permissions,
    steps: schema.steps,
    groups: schema.groups,
    fields: schema.fields,
  });
}

/** Everything about a composed schema that a locale is SUPPOSED to move. */
export function textFingerprint(schema: AuthoringSchema): string {
  return digest(schema.text);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value), 'utf8').digest('hex');
}

/**
 * JSON with object keys sorted, so two structurally equal values digest equally.
 *
 * `JSON.stringify` preserves insertion order, and the composer builds
 * `text.fields` by iterating rows — so an unsorted digest would report a
 * difference between two locales that resolved the same fields in a different
 * order, which is not a difference in meaning.
 */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`;
}

/**
 * Print what a journey actually exercised, and refuse a vacuous run.
 *
 * Two refusals rather than one, for the reason the seed census gives: a total of
 * zero means nothing ran at all, while a single zero among positive siblings
 * means one step of the journey did nothing — and the second is the one that
 * hides, because every count it is compared against is also zero.
 */
export function reportPopulation(label: string, counts: Readonly<Record<string, number>>): void {
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    throw new Error(`reportPopulation('${label}'): no counts were supplied.`);
  }
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) {
    throw new Error(
      `reportPopulation('${label}'): every count is zero, so this journey measured NOTHING. ` +
        `A vacuous run reports the same green as a complete one.`,
    );
  }
  const empty = entries.filter(([, count]) => count === 0).map(([key]) => key);
  if (empty.length > 0) {
    throw new Error(
      `reportPopulation('${label}'): ${empty.join(', ')} came back zero, so that step of the ` +
        `journey did nothing. Counts: ${format(entries)}`,
    );
  }
  process.stdout.write(`\n[#367 e2e] ${label} — ${format(entries)}\n`);
}

function format(entries: readonly [string, number][]): string {
  return entries.map(([key, count]) => `${key}=${count}`).join(' ');
}
