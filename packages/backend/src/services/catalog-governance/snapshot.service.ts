/**
 * Export, snapshot and restore for catalog DEFINITIONS (#367 Workstream 12).
 *
 * Definitions only. No order, payment, refund, buyer or listing row is read by
 * any query here, no column on `catalog_governance_definition_snapshots` could
 * hold one, and `catalog-governance-isolation.test.ts` walks a REAL emitted
 * document as well as scanning this file — because the document is jsonb and a
 * schema cannot constrain what a composer puts in one.
 *
 * ## Restore is INSERT-ONLY and reports divergence rather than correcting it
 *
 * The vocabulary is `seed-verticals`' — `create`, `present`, `divergent` — and
 * so is the ruling behind it: a divergent entity is REPORTED and never
 * corrected. Overwriting one would silently undo whatever an operator changed
 * since the snapshot was taken, which is exactly the state somebody reaching
 * for a restore is trying to understand. "Restore" here means "put back what is
 * missing", not "make the database look like this file".
 *
 * That also keeps the house rule intact: the only writer a restore drives is
 * `taxonomyRepository.insertCategory`, which is the taxonomy's own chokepoint.
 * There is deliberately no restore path for attribute definitions, product-type
 * versions or navigation trees — see `RESTORE_UNSUPPORTED_SCOPES` for why each
 * is refused rather than half-built.
 *
 * ## The digest is over a CANONICALIZED document
 *
 * Two exports of an unchanged catalogue must produce one digest, and JSON key
 * order is insertion order, which for a row projection is column order and for
 * an array is query order. Every query here carries an explicit `order by`, and
 * `canonicalize` sorts object keys before serializing — so a digest comparison
 * answers "did the definitions change", never "did the planner reorder".
 */

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type {
  CatalogGovernanceRestoreReport,
  CatalogGovernanceRestoreStep,
  CatalogGovernanceSnapshotScope,
} from '@mercaria/shared-types';
import { conflict, notFound } from '../../lib/errors/error-codes.js';
import { getDb, type Database, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findDefinitionSnapshot,
  insertDefinitionSnapshot,
  listDefinitionSnapshots,
  type CatalogGovernanceSnapshotRow,
} from '../../db/catalogGovernance/snapshotRepository.js';
import { recordAuditEvent } from '../../db/catalogGovernance/auditRepository.js';
import { findCategoryByKey, insertCategory } from '../../db/taxonomy/taxonomyRepository.js';
import { requireGovernanceRole } from './role.service.js';
import type { CatalogGovernanceActor } from './actor.js';

/** One exported category. Keys and slugs, never ids: an id is per-deployment. */
type ExportedCategory = {
  readonly key: string;
  readonly name: string;
  readonly slug: string;
  readonly parentKey: string | null;
  readonly lifecycle: string;
  readonly selectable: boolean;
  readonly position: number;
};

type ExportedProductType = {
  readonly key: string;
  readonly version: number;
  readonly name: string;
  readonly lifecycle: string;
  readonly categoryKeys: readonly string[];
  readonly fields: readonly { attributeKey: string; scope: string; flow: string; requirement: string }[];
}

type ExportedAttribute = {
  readonly key: string;
  readonly version: number;
  readonly label: string;
  readonly valueType: string;
  readonly lifecycleState: string;
  readonly enumValues: readonly { value: string; label: string }[];
}

type ExportedLocalization = {
  readonly entity: string;
  readonly entityKey: string;
  readonly locale: string;
  readonly status: string;
  readonly name: string | null;
};

type ExportedNavigationTree = {
  readonly key: string;
  readonly version: number;
  readonly market: string;
  readonly locale: string;
  readonly surface: string;
  readonly lifecycle: string;
  readonly nodeCount: number;
};

/** The document. Nothing else is in it and nothing else may be added. */
export interface DefinitionDocument {
  readonly scope: CatalogGovernanceSnapshotScope;
  readonly categories: readonly ExportedCategory[];
  readonly productTypes: readonly ExportedProductType[];
  readonly attributes: readonly ExportedAttribute[];
  readonly localizations: readonly ExportedLocalization[];
  readonly navigationTrees: readonly ExportedNavigationTree[];
}

/** Whether a scope covers a section. `all` covers everything. */
function covers(scope: CatalogGovernanceSnapshotScope, section: CatalogGovernanceSnapshotScope): boolean {
  return scope === 'all' || scope === section;
}

/**
 * Sort object keys recursively so two structurally equal documents serialize
 * identically. Arrays keep their order — every query below sorts explicitly.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [key, inner] of entries) out[key] = canonicalize(inner);
    return out;
  }
  return value;
}

/** sha-256 of the canonicalized document. */
export function documentDigest(document: DefinitionDocument): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(document))).digest('hex');
}

/** Read the definitions in scope. */
export async function composeDefinitionDocument(
  scope: CatalogGovernanceSnapshotScope,
  db: DatabaseOrTransaction = getDb(),
): Promise<DefinitionDocument> {
  const categories = covers(scope, 'taxonomy')
    ? await db.execute<ExportedCategory>(sql`
        select c.key, c.name, c.slug, p.key as "parentKey",
               c.lifecycle, c.selectable, c.position
          from categories c
          left join categories p on p.id = c.parent_id
         order by c.key
      `)
    : [];

  const productTypes = covers(scope, 'product_types')
    ? await db.execute<ExportedProductType>(sql`
        select d.key, d.version, d.name, d.lifecycle,
               coalesce(
                 (select array_agg(c.key order by c.key)
                    from product_type_category_scopes s
                    join categories c on c.id = s.category_id
                   where s.product_type_definition_id = d.id),
                 '{}'::text[]
               ) as "categoryKeys",
               coalesce(
                 (select jsonb_agg(
                           jsonb_build_object(
                             'attributeKey', f.attribute_key,
                             'scope', f.scope,
                             'flow', f.flow,
                             'requirement', f.requirement
                           )
                           order by f.flow, f.scope, f.attribute_key
                         )
                    from product_type_fields f
                   where f.product_type_definition_id = d.id),
                 '[]'::jsonb
               ) as fields
          from product_type_definitions d
         order by d.key, d.version
      `)
    : [];

  const attributes = covers(scope, 'attributes')
    ? await db.execute<ExportedAttribute>(sql`
        select a.key, a.version, a.label, a.value_type as "valueType",
               a.lifecycle_state as "lifecycleState",
               coalesce(
                 (select jsonb_agg(
                           jsonb_build_object('value', v.value, 'label', v.label)
                           order by v.value
                         )
                    from attribute_enum_values v
                   where v.attribute_definition_id = a.id),
                 '[]'::jsonb
               ) as "enumValues"
          from attribute_definitions a
         order by a.key, a.version
      `)
    : [];

  const localizations = covers(scope, 'localization')
    ? await db.execute<ExportedLocalization>(sql`
        select 'category' as entity, c.key as "entityKey", l.locale, l.status, l.name
          from category_localizations l
          join categories c on c.id = l.category_id
         union all
        select 'product_type' as entity, d.key as "entityKey", pl.locale, pl.status, pl.name
          from product_type_localizations pl
          join product_type_definitions d on d.id = pl.product_type_definition_id
         order by 1, 2, 3
      `)
    : [];

  const navigationTrees = covers(scope, 'navigation')
    ? await db.execute<ExportedNavigationTree>(sql`
        select t.key, t.version, t.market, t.locale, t.surface, t.lifecycle,
               (select count(*) from navigation_nodes n where n.tree_id = t.id)::int as "nodeCount"
          from navigation_trees t
         order by t.key, t.market, t.locale, t.version
      `)
    : [];

  return {
    scope,
    categories: [...categories],
    productTypes: [...productTypes],
    attributes: [...attributes],
    localizations: [...localizations],
    navigationTrees: [...navigationTrees],
  };
}

/** Take a snapshot. Refuses an empty export — see `insertDefinitionSnapshot`. */
export async function exportDefinitions(
  db: Database,
  actor: CatalogGovernanceActor,
  input: { readonly scope: CatalogGovernanceSnapshotScope; readonly reason: string },
): Promise<CatalogGovernanceSnapshotRow> {
  requireGovernanceRole(actor, 'view');

  const document = await composeDefinitionDocument(input.scope, db);
  const digest = documentDigest(document);

  return db.transaction(async (tx) => {
    const row = await insertDefinitionSnapshot(tx, {
      scope: input.scope,
      contentDigest: digest,
      document,
      counts: {
        categoryCount: document.categories.length,
        productTypeCount: document.productTypes.length,
        attributeCount: document.attributes.length,
        localizationCount: document.localizations.length,
        navigationTreeCount: document.navigationTrees.length,
      },
      createdByOxyUserId: actor.oxyUserId,
      reason: input.reason,
    });

    await recordAuditEvent(tx, {
      domain: 'governance',
      action: 'snapshot_exported',
      subjectKind: 'definition_snapshot',
      subjectId: row.id,
      actorKind: 'operator',
      actorOxyUserId: actor.oxyUserId,
      reason: input.reason,
      source: 'operator_console',
      changeRequestId: null,
      before: null,
      after: { scope: input.scope, contentDigest: digest, entityCount: row.entityCount },
      at: new Date(),
    });

    return row;
  });
}

/**
 * The scopes a restore refuses, each with the reason it is refused rather than
 * half-built.
 *
 * Named as data so the refusal message can quote it and a test can reconcile it
 * against `CATALOG_GOVERNANCE_SNAPSHOT_SCOPES` in both directions — an
 * unsupported scope missing from this map would be one the restore silently
 * treats as a no-op and reports as a clean run.
 */
export const RESTORE_UNSUPPORTED_SCOPES: Record<
  Exclude<CatalogGovernanceSnapshotScope, 'taxonomy' | 'all'>,
  string
> = {
  product_types:
    'A product-type version is immutable once published and its children are frozen with it, so restoring one means minting a NEW version — which is a publication decision with its own diff and its own approval, not a restore.',
  attributes:
    'An attribute definition version is immutable once active and `mercaria_attribute_enum_frozen` refuses a controlled value on a live one, so a restore could only ever create a new draft. Draft it through /internal/catalog-attributes instead.',
  localization:
    'A translation carries a provenance, a reviewer and a source revision. Writing one back from a snapshot would attribute somebody`s review to a restore, and the machine-write guard refuses it anyway.',
  navigation:
    'A navigation tree is published against a market/locale/surface window that a restore cannot re-take safely — two live trees on one surface is the state the exclusion constraint exists to prevent.',
};

/**
 * Plan or apply a restore.
 *
 * `apply: false` is the plan and it still READS the database, so the report is a
 * statement about this deployment rather than about the document — the
 * `seed-verticals` posture, and the reason a dry run there is the default.
 */
export async function restoreDefinitions(
  db: Database,
  actor: CatalogGovernanceActor,
  input: { readonly snapshotId: string; readonly apply: boolean; readonly reason: string },
): Promise<CatalogGovernanceRestoreReport> {
  requireGovernanceRole(actor, input.apply ? 'publish' : 'view');

  const snapshot = await findDefinitionSnapshot(db, input.snapshotId);
  if (!snapshot) throw notFound('Definition snapshot not found.');

  const document = snapshot.document as DefinitionDocument;
  if (snapshot.scope !== 'taxonomy' && snapshot.scope !== 'all') {
    throw conflict(RESTORE_UNSUPPORTED_SCOPES[snapshot.scope]);
  }

  const steps: CatalogGovernanceRestoreStep[] = [];

  // Parents before children: `insertCategory` derives ancestry FROM the parent,
  // so a child written first would carry an empty ancestor array and stay wrong
  // until somebody moved it. Sorting by ancestor depth is not enough — the
  // document holds keys, so depth is computed by walking parentKey.
  for (const category of orderByDepth(document.categories)) {
    const existing = await findCategoryByKey(category.key, db);
    if (existing) {
      const divergent =
        existing.name !== category.name ||
        existing.slug !== category.slug ||
        existing.lifecycle !== category.lifecycle;
      steps.push({
        entity: 'category',
        identity: category.key,
        outcome: divergent ? 'divergent' : 'present',
        detail: divergent
          ? 'This category exists and differs from the snapshot. It is reported and NOT overwritten — a restore that corrected it would undo whatever changed it.'
          : undefined,
      });
      continue;
    }

    if (!input.apply) {
      steps.push({ entity: 'category', identity: category.key, outcome: 'create' });
      continue;
    }

    const parent = category.parentKey === null ? null : await findCategoryByKey(category.parentKey, db);
    if (category.parentKey !== null && !parent) {
      steps.push({
        entity: 'category',
        identity: category.key,
        outcome: 'divergent',
        detail: `Its parent ${category.parentKey} is not in this deployment and was not created by this run.`,
      });
      continue;
    }

    // The taxonomy's OWN chokepoint. It derives both ancestry arrays and
    // `is_active`; nothing here writes `categories`.
    await insertCategory(
      {
        key: category.key,
        name: category.name,
        slug: category.slug,
        parentId: parent ? parent.id : null,
        lifecycle: category.lifecycle as ExportedCategory['lifecycle'] as never,
        selectable: category.selectable,
        position: category.position,
      },
      db,
    );
    steps.push({ entity: 'category', identity: category.key, outcome: 'create' });
  }

  const report: CatalogGovernanceRestoreReport = {
    snapshotId: snapshot.id,
    applied: input.apply,
    steps,
    created: steps.filter((step) => step.outcome === 'create').length,
    present: steps.filter((step) => step.outcome === 'present').length,
    divergent: steps.filter((step) => step.outcome === 'divergent').length,
  };

  if (input.apply) {
    await db.transaction(async (tx) => {
      await recordAuditEvent(tx, {
        domain: 'taxonomy',
        action: 'definition_snapshot_restore',
        subjectKind: 'definition_snapshot',
        subjectId: snapshot.id,
        actorKind: 'operator',
        actorOxyUserId: actor.oxyUserId,
        reason: input.reason,
        source: 'definition_snapshot',
        changeRequestId: null,
        before: null,
        after: {
          created: report.created,
          present: report.present,
          divergent: report.divergent,
          contentDigest: snapshot.contentDigest,
        },
        at: new Date(),
      });
    });
  }

  return report;
}

/**
 * Categories in an order where every parent precedes its children.
 *
 * Depth is computed by walking `parentKey` through the document itself rather
 * than trusting the export's order: a category whose parent is absent from the
 * document gets depth 0 and is attempted first, which is what surfaces it as
 * `divergent` with a message naming the missing parent instead of failing on a
 * foreign key.
 */
function orderByDepth(categories: readonly ExportedCategory[]): readonly ExportedCategory[] {
  const byKey = new Map(categories.map((category) => [category.key, category]));
  const depth = (category: ExportedCategory, seen: Set<string>): number => {
    if (category.parentKey === null) return 0;
    if (seen.has(category.key)) return 0;
    const parent = byKey.get(category.parentKey);
    if (!parent) return 0;
    seen.add(category.key);
    return depth(parent, seen) + 1;
  };
  return [...categories].sort((a, b) => {
    const delta = depth(a, new Set()) - depth(b, new Set());
    return delta !== 0 ? delta : a.key < b.key ? -1 : 1;
  });
}

/** The snapshot catalogue, without the documents. */
export async function readSnapshots(
  db: DatabaseOrTransaction,
  limit: number,
  offset: number,
): Promise<Omit<CatalogGovernanceSnapshotRow, 'document'>[]> {
  return listDefinitionSnapshots(db, limit, offset);
}

/** One snapshot's document, for an operator downloading an export. */
export async function readSnapshotDocument(
  db: DatabaseOrTransaction,
  snapshotId: string,
): Promise<CatalogGovernanceSnapshotRow> {
  const row = await findDefinitionSnapshot(db, snapshotId);
  if (!row) throw notFound('Definition snapshot not found.');
  return row;
}
