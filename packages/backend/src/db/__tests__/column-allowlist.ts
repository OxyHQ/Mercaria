/**
 * The forbidden-column machinery a schema gate walks its tables with (#354).
 *
 * ## Why this module exists at all
 *
 * A drizzle traversal's `column.name` is the TypeScript PROPERTY name.
 * `@oxyhq/db` owns the casing authority (`DATABASE_CASING`) and drizzle
 * converts at query time, so a gate matching a `snake_case` prohibition against
 * `column.name` is comparing it to `camelCase` and **cannot fire** — while
 * staying green and reading as coverage.
 *
 * #77's analytics gate had it (three of eighteen tokens inert, #352).
 * `retail-logistics-isolation.test.ts` had it (two of eleven, #354).
 * That is the same defect landing three times in three domains, which is what
 * a shared traversal is for: `schemaTableColumns` is the only place any of
 * these gates learns a column's name, and it is `sqlColumnName`.
 *
 * ## Two layers, and they fail differently
 *
 * The ALLOW-LIST catches the column nobody anticipated — a name no pattern was
 * ever going to carry, arriving in a diff whose author was thinking about
 * something else. `tracking_number` on a retail fulfilment table matched not
 * one of that gate's eleven deny tokens.
 *
 * The DENY-LIST catches the column somebody appended to the allow-list without
 * thinking, under a name that looks like it belongs. So it runs over the
 * allow-list's OWN entries as well as over the real schema, and a forbidden
 * name cannot be admitted by being written down.
 *
 * Neither subsumes the other and both are cheap. The shape, the reasoning and
 * the posture on silence are #352's
 * (`services/analytics/__tests__/analytics-column-allowlist.ts`), which
 * predates this module and still carries its own copy — adopting this one there
 * is a follow-up in that domain's own diff, not a quiet edit inside somebody
 * else's change.
 *
 * ## Matching is by SEGMENT, never by substring
 *
 * A prohibition names one or more ADJACENT underscore-separated segments.
 * `ship_back_deadline_at` survives a prohibition on `shipping` because `ship`
 * is not `shipping`; `description` survives one on `ip` because `ip` is not a
 * segment of it. A substring pattern has to be either too loose (banning
 * `recipient` and `description` to ban `ip`) or too tight — `\b` matches
 * nothing inside a snake_case identifier, since `_` is a word character.
 */

import { getTableColumns, getTableName } from 'drizzle-orm';
import { sqlColumnName } from '@oxyhq/db';

/** One reason, and the columns it covers. */
export interface ColumnGroup {
  /** Why these columns may exist in a domain that refuses a whole category. */
  readonly reason: string;
  /** SQL identifiers, as `sqlColumnName` renders them. */
  readonly columns: readonly string[];
}

/** Every column one table may carry. */
export interface TableAllowance {
  readonly table: string;
  readonly groups: readonly ColumnGroup[];
}

/** What the drizzle traversal hands the auditor. */
export interface TableColumns {
  readonly table: string;
  readonly columns: readonly string[];
}

/** A prohibition, stated as a sequence of adjacent segments. */
export interface ColumnProhibition {
  /** Adjacent underscore-separated segments, in order. */
  readonly segments: readonly string[];
  /** What it is a prohibition ON — the message an offender is reported with. */
  readonly prohibition: string;
}

/** A column admitted DESPITE a prohibition, naming the one column and why. */
export interface ColumnExemption {
  /** Qualified `table.column`. Never a pattern: an exemption names ONE column. */
  readonly column: string;
  readonly reason: string;
}

export interface ColumnAudit {
  /** A real column no group lists. The inversion's whole point. */
  readonly unlisted: readonly string[];
  /** A listed column no table has — the list rotting into a stale permission. */
  readonly missing: readonly string[];
  /** A name a prohibition refuses, from either side. */
  readonly forbidden: readonly { column: string; prohibition: string }[];
  /** A real table with no allowance at all. */
  readonly unlistedTables: readonly string[];
  /** An allowance for a table that no longer exists. */
  readonly missingTables: readonly string[];
}

/* -------------------------------------------------------------------------- */

/**
 * Every drizzle table in a schema module, with its SQL column names.
 *
 * Enumerated from the MODULE rather than from a hand-written list, so a table
 * added later is walked automatically. A list would have to be remembered, and
 * the one thing a forbidden-column gate must not depend on is somebody
 * remembering.
 */
export function schemaTableColumns(module: Record<string, unknown>): readonly TableColumns[] {
  const out: TableColumns[] = [];
  for (const value of Object.values(module)) {
    if (typeof value !== 'object' || value === null) continue;
    if (!(Symbol.for('drizzle:Name') in value)) continue;
    const table = value as Parameters<typeof getTableColumns>[0];
    out.push({
      table: getTableName(table),
      // `sqlColumnName`, never `column.name`. This line is the whole of #354.
      columns: Object.values(getTableColumns(table)).map((column) => sqlColumnName(column)),
    });
  }
  return out;
}

/** Does `segments` contain `needle` as a contiguous run? */
function containsRun(segments: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > segments.length) return false;
  for (let start = 0; start + needle.length <= segments.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (segments[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * The prohibition a qualified `table.column` falls under, or `null`.
 *
 * Pure and exported so a self-test can probe it with names that are not in the
 * schema — a detector proven only against the schema it passes on is proven
 * against nothing.
 */
export function columnProhibition(
  qualified: string,
  prohibitions: readonly ColumnProhibition[],
  exemptions: readonly ColumnExemption[] = [],
): string | null {
  if (exemptions.some((exemption) => exemption.column === qualified)) return null;
  const column = qualified.slice(qualified.indexOf('.') + 1);
  const segments = column.split('_');
  for (const entry of prohibitions) {
    if (containsRun(segments, entry.segments)) return entry.prohibition;
  }
  return null;
}

/**
 * Compare the real schema against the allow-list, in BOTH directions, and run
 * the deny-list over the union of what each side names.
 *
 * The union rather than either side alone: if the two disagree the equality
 * assertion is what fails, and the deny scan must still be able to say which of
 * the two names is the dangerous one.
 */
export function auditColumns(
  tables: readonly TableColumns[],
  allowList: readonly TableAllowance[],
  prohibitions: readonly ColumnProhibition[],
  exemptions: readonly ColumnExemption[] = [],
): ColumnAudit {
  const allowed = new Map<string, Set<string>>();
  for (const allowance of allowList) {
    const columns = new Set<string>();
    for (const group of allowance.groups) for (const column of group.columns) columns.add(column);
    allowed.set(allowance.table, columns);
  }

  const unlisted: string[] = [];
  const missing: string[] = [];
  const unlistedTables: string[] = [];
  const seenTables = new Set<string>();
  const union = new Set<string>();

  for (const { table, columns } of tables) {
    seenTables.add(table);
    const permitted = allowed.get(table);
    if (permitted === undefined) unlistedTables.push(table);
    for (const column of columns) {
      union.add(`${table}.${column}`);
      if (permitted !== undefined && !permitted.has(column)) unlisted.push(`${table}.${column}`);
    }
  }

  const missingTables: string[] = [];
  for (const [table, columns] of allowed) {
    if (!seenTables.has(table)) {
      missingTables.push(table);
      continue;
    }
    const actual = new Set(tables.find((entry) => entry.table === table)?.columns ?? []);
    for (const column of columns) {
      union.add(`${table}.${column}`);
      if (!actual.has(column)) missing.push(`${table}.${column}`);
    }
  }

  const forbidden: { column: string; prohibition: string }[] = [];
  for (const qualified of [...union].sort()) {
    const prohibition = columnProhibition(qualified, prohibitions, exemptions);
    if (prohibition !== null) forbidden.push({ column: qualified, prohibition });
  }

  return {
    unlisted: unlisted.sort(),
    missing: missing.sort(),
    forbidden,
    unlistedTables: unlistedTables.sort(),
    missingTables: missingTables.sort(),
  };
}

/** Every column the allow-list names. A vacuity floor reads it. */
export function allowListedColumnCount(allowList: readonly TableAllowance[]): number {
  return allowList.reduce(
    (total, allowance) =>
      total + allowance.groups.reduce((sum, group) => sum + group.columns.length, 0),
    0,
  );
}

/**
 * The column name a prohibition exists to refuse, rebuilt from its own
 * segments.
 *
 * This is what lets a self-test prove EVERY prohibition can fire, exhaustively
 * and by construction, rather than proving it for the handful somebody wrote
 * probes for. A token added later is covered the moment it is added.
 */
export function prohibitionProbeColumn(entry: ColumnProhibition): string {
  return entry.segments.join('_');
}
