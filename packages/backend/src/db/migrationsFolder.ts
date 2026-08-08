/**
 * Where the SQL migrations live — ONE constant, because two things read it.
 *
 * `db/migrate.ts` applies the folder; `db/postgres.ts` reads the same folder's
 * journal to decide whether a task is allowed to serve traffic (`/health/ready`).
 * If those two ever disagreed, readiness would assert against a journal the
 * migrator does not apply — and it would pass, because a journal nobody applies
 * has nothing pending. A gate that cannot fail is worse than no gate, so the path
 * is stated once here rather than copied.
 *
 * It cannot simply be imported from `migrate.ts`: that module runs `main()` at
 * load, so importing it to borrow a constant would run a migration.
 *
 * Resolved from this module's own location so it is correct whether the caller
 * runs as `src/db/…` (bun, dev and the test harness) or as `dist/db/…` (node,
 * the production image) — both sit exactly two directories below the package
 * root.
 *
 * NOTE for the deploy phase: the runtime image copies `packages/backend/dist`
 * and nothing else, so the ECS task needs `drizzle/` copied in beside it — for
 * the one-shot migration task AND, now, for every serving task, since readiness
 * reads the journal from here.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_FOLDER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'drizzle',
);
