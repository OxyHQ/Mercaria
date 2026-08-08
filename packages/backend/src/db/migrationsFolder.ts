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
 * NO fixed depth can be correct, because this module is inlined into two bundles
 * that sit at DIFFERENT depths. `build.ts` emits `dist/index.js` (one level below
 * the package root) and `dist/db/migrate.js` (two), and esbuild leaves
 * `import.meta.url` pointing at whichever bundle is running — not at this source
 * file. Both were measured against the real artefacts: with a fixed `'..', '..'`
 * the migrator works by coincidence and the SERVER resolves
 * `/app/packages/drizzle`, a directory that does not exist. `readJournal` runs at
 * module load, so that is a crash at container start rather than a wrong answer
 * later, and it would have been fixed by whoever hit it in a way that then broke
 * the migrator.
 *
 * Walking up to the nearest `package.json` is depth-independent, so it is right
 * for both bundles and for `src/` under bun and the test harness. It throws
 * rather than guessing, because a silent fallback here is exactly the failure it
 * exists to prevent.
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
