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
 * ## Resolved by finding the PACKAGE ROOT, not by counting directories
 *
 * A fixed `'..', '..'` from this module's own location is wrong in production,
 * and silently so. It is correct under bun (`src/db/migrationsFolder.ts`, two
 * below the package root), but the production build is an esbuild BUNDLE: every
 * module including this one is inlined into `dist/index.js`, so `import.meta.url`
 * is the bundle's path — one level below the package root, not two. Measured on
 * the real artefact: the fixed form resolved `/app/packages/drizzle`, a directory
 * that does not exist, while the migrations sit in `/app/packages/backend`.
 * `readJournal` runs at module load, so that is a crash at container start rather
 * than a wrong answer later.
 *
 * Walking up to the nearest `package.json` is depth-independent, so it is right
 * for the bundle, for `src/` under bun and the test harness, and for any future
 * build that emits `dist/db/`. It throws rather than guessing, because a silent
 * fallback here is exactly the failure it exists to prevent.
 *
 * NOTE for the deploy phase: the runtime image copies `packages/backend/dist` and
 * nothing else, so the image must also copy `drizzle/` to
 * `packages/backend/drizzle` — for the one-shot migration task AND for every
 * serving task, since readiness reads the journal from here. The `Dockerfile`
 * does that beside the `dist` COPY.
 */

import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The nearest ancestor of `from` (inclusive) holding a `package.json`. */
function findPackageRoot(from: string): string {
  const { root } = parse(from);
  let dir = from;
  while (!existsSync(join(dir, 'package.json'))) {
    if (dir === root) {
      throw new Error(
        `Could not locate the @mercaria/backend package root above ${from}, so the ` +
          `drizzle migrations folder cannot be resolved. The runtime image must ship ` +
          `packages/backend/package.json beside dist/.`,
      );
    }
    dir = dirname(dir);
  }
  return dir;
}

export const MIGRATIONS_FOLDER = join(
  findPackageRoot(dirname(fileURLToPath(import.meta.url))),
  'drizzle',
);
