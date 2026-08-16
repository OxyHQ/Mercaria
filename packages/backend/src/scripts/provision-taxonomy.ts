/**
 * Provision the marketplace taxonomy into a real database — categories ONLY.
 *
 * `categories` is a read-mostly table no request path writes: every listing
 * write resolves one slug through `findCategoryBySlug` to materialize
 * `listings.category_slugs`, the browse screens read the active tree, and the
 * connector refuses to import a product until `CONNECTOR_DEFAULT_CATEGORY_SLUG`
 * names a row that exists. A production database with an empty `categories`
 * table therefore serves a storefront with no shelves and blocks every connected
 * store's backfill, and nothing in the request path will ever fix it.
 *
 * ## Why this is not `seed.ts`
 *
 * `seed.ts` is a DEV seed. It opens with `clearMarketplace`, which deletes every
 * refund, review, draft order, order, listing, store, category and seller
 * profile in the database it is pointed at, and then writes mock stores, mock
 * products and mock orders. Pointing it at production would destroy the
 * marketplace in order to install a taxonomy. This script writes the taxonomy
 * and touches nothing else.
 *
 * The tree itself is NOT duplicated here — both scripts import `TAXONOMY` from
 * `./taxonomy.js`, because two lists of one taxonomy disagree the first time
 * somebody edits whichever file they happened to open.
 *
 * ## Idempotence is the safety property, and it is structural
 *
 * The only statement this script can issue against `categories` is an INSERT,
 * and it issues one only for a slug `findCategoryBySlug` reports absent. There
 * is no UPDATE and no DELETE anywhere in it — so a second run writes nothing, a
 * re-run after a partial failure completes the tree from wherever it stopped,
 * and `updated_at` on an existing row cannot move. That is what makes it safe to
 * run against production without a dry-run mode: the destructive version of this
 * script does not exist rather than being switched off.
 *
 * It therefore carries no `ALLOW_PROD_SEED`-style guard, deliberately. `seed.ts`
 * needs one because it deletes; a guard here would only stand between an
 * operator and the append-only write they came to make.
 *
 * ## A row that already exists but DISAGREES is reported, never corrected
 *
 * An existing slug whose name, parent, position or image differs from the
 * taxonomy means somebody or something has edited the tree. Rewriting it would
 * silently revert an intentional change; ignoring it would let this script
 * report success over a tree that is not the one it just claimed to install. So
 * a divergence is counted, named on stderr and exits non-zero, with every other
 * category still provisioned — the operator gets the whole picture in one run
 * and decides what the divergence means.
 *
 * Run from `packages/backend`:
 *   DATABASE_URL=… bun src/scripts/provision-taxonomy.ts
 */

import { closePostgres, connectPostgres } from '../db/postgres.js';
import {
  findCategoryBySlug,
  insertCategory,
  type CategoryRecord,
} from '../db/catalog/categoryRepository.js';
import { log } from '../lib/logger.js';
import { TAXONOMY, taxonomySize } from './taxonomy.js';

/** What this run did to the taxonomy. */
interface ProvisionCounts {
  /** Rows this run inserted. */
  created: number;
  /** Rows that were already present and match the taxonomy exactly. */
  unchanged: number;
  /** Rows that were already present and DISAGREE with the taxonomy. */
  divergent: number;
}

/** One existing row's disagreement with the taxonomy, for the operator's report. */
interface Divergence {
  slug: string;
  field: string;
  expected: string;
  actual: string;
}

/** The columns `insertCategory` writes, as this script intends them for one slug. */
interface DesiredCategory {
  name: string;
  slug: string;
  parentId: string | null;
  ancestorSlugs: string[];
  imageUrl: string | null;
  position: number;
  /** See `divergences` for why this is compared in ONE direction only. */
  isActive: boolean;
}

/**
 * Compare an existing row against what the taxonomy says it should be.
 *
 * ## `is_active` is compared in ONE direction, and the asymmetry is the point
 *
 * A category the taxonomy publishes (`shopper_facing`) may legitimately be
 * DEACTIVATED — taking Beauty off the storefront for a season is an operator's
 * decision, and reporting it here would make every later run of this script exit
 * non-zero over a state somebody chose. So that direction is not compared.
 *
 * The reverse is not symmetrical. An `internal_only` category that has been
 * ACTIVATED is on a shelf shoppers browse, which is the one thing its whole
 * reason for existing is to avoid — a third-party catalogue filed under
 * `imported` would become a public category. That is reported, and the run exits
 * non-zero, because it is exactly the "something looks wrong" this script stops
 * for.
 *
 * Nothing is REWRITTEN either way. The script's only statement against
 * `categories` remains an INSERT.
 */
function divergences(existing: CategoryRecord, desired: DesiredCategory): Divergence[] {
  const found: Divergence[] = [];
  const compare = (field: string, expected: string, actual: string): void => {
    if (expected !== actual) {
      found.push({ slug: desired.slug, field, expected, actual });
    }
  };

  compare('name', desired.name, existing.name);
  compare('parentId', desired.parentId ?? '(top level)', existing.parentId ?? '(top level)');
  compare('ancestorSlugs', desired.ancestorSlugs.join(','), existing.ancestorSlugs.join(','));
  compare('imageUrl', desired.imageUrl ?? '(none)', existing.imageUrl ?? '(none)');
  compare('position', String(desired.position), String(existing.position));

  if (!desired.isActive && existing.isActive) {
    compare('isActive', 'false (internal only)', 'true (visible to shoppers)');
  }
  return found;
}

/**
 * Ensure one category exists, and report which of the three things happened.
 *
 * Returns the row either way, because a child needs its parent's id whether this
 * run created the parent or found it already there.
 */
async function ensureCategory(
  desired: DesiredCategory,
  counts: ProvisionCounts,
  found: Divergence[],
): Promise<CategoryRecord> {
  const existing = await findCategoryBySlug(desired.slug);
  if (!existing) {
    const created = await insertCategory({
      name: desired.name,
      slug: desired.slug,
      parentId: desired.parentId,
      ancestorSlugs: desired.ancestorSlugs,
      imageUrl: desired.imageUrl,
      position: desired.position,
      isActive: desired.isActive,
    });
    counts.created += 1;
    log.general.info({ slug: desired.slug, id: created.id }, 'Created category');
    return created;
  }

  const disagreements = divergences(existing, desired);
  if (disagreements.length > 0) {
    counts.divergent += 1;
    found.push(...disagreements);
    log.general.warn(
      { slug: desired.slug, id: existing.id, disagreements },
      'Category exists and DISAGREES with the taxonomy — left exactly as it is',
    );
    return existing;
  }

  counts.unchanged += 1;
  return existing;
}

/** Walk the taxonomy parents-first, so every child has a parent id to point at. */
async function provisionTaxonomy(): Promise<{
  counts: ProvisionCounts;
  found: Divergence[];
}> {
  const counts: ProvisionCounts = { created: 0, unchanged: 0, divergent: 0 };
  const found: Divergence[] = [];

  for (const [topIndex, top] of TAXONOMY.entries()) {
    // An internal-only category is a top-level row with no imagery, no children
    // and `is_active = false`. The `switch` is the compiler forcing the two
    // shapes apart rather than a branch somebody could forget to add.
    if (top.listing === 'internal_only') {
      await ensureCategory(
        {
          name: top.name,
          slug: top.slug,
          parentId: null,
          ancestorSlugs: [],
          imageUrl: null,
          position: topIndex,
          isActive: false,
        },
        counts,
        found,
      );
      continue;
    }

    const parent = await ensureCategory(
      {
        name: top.name,
        slug: top.slug,
        parentId: null,
        ancestorSlugs: [],
        imageUrl: top.pillImage,
        position: topIndex,
        isActive: true,
      },
      counts,
      found,
    );

    for (const [childIndex, child] of top.children.entries()) {
      await ensureCategory(
        {
          name: child.name,
          slug: child.slug,
          parentId: parent.id,
          ancestorSlugs: [top.slug],
          imageUrl: child.image,
          position: childIndex,
          isActive: true,
        },
        counts,
        found,
      );
    }
  }

  return { counts, found };
}

async function main(): Promise<void> {
  await connectPostgres();
  const { counts, found } = await provisionTaxonomy();

  const expected = taxonomySize();
  const accounted = counts.created + counts.unchanged + counts.divergent;

  // The vacuity floor. "Every category is accounted for" is also what a walk
  // over an empty taxonomy reports, and an empty taxonomy is what a broken
  // import or a mis-edited data module produces — so the size is asserted
  // against the tree rather than against the counters alone.
  if (expected === 0) {
    throw new Error('The taxonomy describes no categories at all — refusing to report success.');
  }
  if (accounted !== expected) {
    throw new Error(
      `Provisioned ${accounted} categories but the taxonomy describes ${expected}. ` +
        'Every category must be created, unchanged or divergent.',
    );
  }

  log.general.info({ ...counts, expected }, 'Taxonomy provisioning complete');

  if (counts.divergent > 0) {
    throw new Error(
      `${counts.divergent} categor${counts.divergent === 1 ? 'y' : 'ies'} already exist and ` +
        'disagree with the taxonomy. Nothing was rewritten. Divergences: ' +
        found.map((d) => `${d.slug}.${d.field} is "${d.actual}", expected "${d.expected}"`).join('; '),
    );
  }
}

main()
  .then(async () => {
    await closePostgres();
    process.exit(0);
  })
  .catch(async (err) => {
    log.general.error({ err }, 'Taxonomy provisioning failed');
    try {
      await closePostgres();
    } catch (closeErr) {
      log.general.error(
        { err: closeErr },
        'Failed to close the Postgres pool after a provisioning error',
      );
    }
    process.exit(1);
  });
