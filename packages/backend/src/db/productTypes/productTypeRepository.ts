/**
 * `product_type_definitions` — the version rows themselves (#367, ADR 0007 D5).
 *
 * ## Every lifecycle write is a compare-and-swap
 *
 * Publication and deprecation CAS on the CURRENT lifecycle (`CONVENTIONS.md`: a
 * conditional write stays ONE statement), so two operators racing the same
 * button produce exactly one publication. Publication also DEPRECATES the
 * previous published version of the same key inside the same transaction and
 * BEFORE the new one flips — `product_type_definitions_one_published_per_key`
 * refuses any ordering that would leave two current schemas for one product
 * type, so the sequence is load-bearing rather than stylistic. It is the
 * `feeScheduleRepository` sequence, and it is copied deliberately.
 *
 * The database triggers (`product_type_definitions_immutable_once_published`,
 * `product_type_fields_citation`) are the enforcement that survives callers that
 * never reach this file; this repository is merely the polite writer.
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type {
  ProductTypeLifecycle,
  ProductTypePendingProposalPolicy,
} from '@mercaria/shared-types';
import { PRODUCT_TYPE_EDITABLE_LIFECYCLES } from '@mercaria/shared-types';
import { productTypeDefinitions } from '../schema/productTypes.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** One row of `product_type_definitions`. */
export type ProductTypeDefinitionRow = typeof productTypeDefinitions.$inferSelect;

/** A new DRAFT version, as the operator surface supplies it. */
export interface NewProductTypeDefinition {
  key: string;
  version: number;
  name: string;
  description?: string;
  pendingProposalPolicy?: ProductTypePendingProposalPolicy;
  createdByOxyUserId?: string;
}

/** Insert one draft version. The CHECKs and unique indexes do the arguing. */
export async function insertProductTypeDefinition(
  db: DatabaseOrTransaction,
  input: NewProductTypeDefinition,
): Promise<ProductTypeDefinitionRow> {
  const [row] = await db
    .insert(productTypeDefinitions)
    .values({
      key: input.key,
      version: input.version,
      name: input.name,
      lifecycle: 'draft',
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.pendingProposalPolicy === undefined
        ? {}
        : { pendingProposalPolicy: input.pendingProposalPolicy }),
      ...(input.createdByOxyUserId === undefined
        ? {}
        : { createdByOxyUserId: input.createdByOxyUserId }),
    })
    .returning();
  return row;
}

/** One version by its opaque id. */
export async function findProductTypeDefinitionById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ProductTypeDefinitionRow | null> {
  const [row] = await db
    .select()
    .from(productTypeDefinitions)
    .where(eq(productTypeDefinitions.id, id))
    .limit(1);
  return row ?? null;
}

/** One EXACT version, the way an authored record cites it (ADR 0007 D5). */
export async function findProductTypeDefinitionByKeyVersion(
  db: DatabaseOrTransaction,
  key: string,
  version: number,
): Promise<ProductTypeDefinitionRow | null> {
  const [row] = await db
    .select()
    .from(productTypeDefinitions)
    .where(and(eq(productTypeDefinitions.key, key), eq(productTypeDefinitions.version, version)))
    .limit(1);
  return row ?? null;
}

/**
 * THE current schema for a product type, or none.
 *
 * A single row by construction: `product_type_definitions_one_published_per_key`
 * is what makes this a lookup rather than "the newest of the published ones",
 * which is a query with a bug in it whenever two rows exist.
 */
export async function findPublishedProductTypeDefinition(
  db: DatabaseOrTransaction,
  key: string,
): Promise<ProductTypeDefinitionRow | null> {
  const [row] = await db
    .select()
    .from(productTypeDefinitions)
    .where(
      and(eq(productTypeDefinitions.key, key), eq(productTypeDefinitions.lifecycle, 'published')),
    )
    .limit(1);
  return row ?? null;
}

/** Every version of one key, newest first — the operator's history view. */
export async function listProductTypeVersions(
  db: DatabaseOrTransaction,
  key: string,
): Promise<ProductTypeDefinitionRow[]> {
  return db
    .select()
    .from(productTypeDefinitions)
    .where(eq(productTypeDefinitions.key, key))
    .orderBy(desc(productTypeDefinitions.version));
}

/** Every currently published type, by key. */
export async function listPublishedProductTypeDefinitions(
  db: DatabaseOrTransaction,
): Promise<ProductTypeDefinitionRow[]> {
  return db
    .select()
    .from(productTypeDefinitions)
    .where(eq(productTypeDefinitions.lifecycle, 'published'))
    .orderBy(asc(productTypeDefinitions.key));
}

/**
 * Edit a version that is still editable.
 *
 * The `inArray(... EDITABLE)` predicate is a CAS, not a nicety: without it a
 * concurrent publication would be overwritten by an edit that read the row a
 * moment earlier, and the trigger would then refuse the NEXT write rather than
 * this one. `key` and `version` are absent from the input type because the
 * trigger freezes them from insert (ADR 0007 D1 rule 2) — a parameter that can
 * only ever raise is not an option, it is a trap.
 */
export async function updateEditableProductTypeDefinition(
  db: DatabaseOrTransaction,
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    pendingProposalPolicy?: ProductTypePendingProposalPolicy;
  },
): Promise<ProductTypeDefinitionRow | null> {
  const [row] = await db
    .update(productTypeDefinitions)
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.pendingProposalPolicy === undefined
        ? {}
        : { pendingProposalPolicy: patch.pendingProposalPolicy }),
    })
    .where(
      and(
        eq(productTypeDefinitions.id, id),
        inArray(productTypeDefinitions.lifecycle, [...PRODUCT_TYPE_EDITABLE_LIFECYCLES]),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Move a version between lifecycle states, conditional on the state it is in.
 *
 * The empty result set IS the "somebody got there first" answer — a read, a
 * branch and a write would be three statements where one will do, and the two
 * extra ones are where the race lives.
 */
export async function setProductTypeLifecycleIfIn(
  db: DatabaseOrTransaction,
  id: string,
  from: readonly ProductTypeLifecycle[],
  to: ProductTypeLifecycle,
  audit?: { publishedByOxyUserId?: string; publishedAt?: Date; deprecatedAt?: Date },
): Promise<ProductTypeDefinitionRow | null> {
  const [row] = await db
    .update(productTypeDefinitions)
    .set({
      lifecycle: to,
      ...(audit?.publishedByOxyUserId === undefined
        ? {}
        : { publishedByOxyUserId: audit.publishedByOxyUserId }),
      ...(audit?.publishedAt === undefined ? {} : { publishedAt: audit.publishedAt }),
      ...(audit?.deprecatedAt === undefined ? {} : { deprecatedAt: audit.deprecatedAt }),
    })
    .where(
      and(eq(productTypeDefinitions.id, id), inArray(productTypeDefinitions.lifecycle, [...from])),
    )
    .returning();
  return row ?? null;
}
