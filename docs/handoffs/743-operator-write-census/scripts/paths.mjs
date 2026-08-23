/**
 * Repo-relative paths, resolved from this file's own location.
 *
 * The scripts these serve were written against one agent's worktree and had its
 * absolute path baked in. Resolving from `import.meta.url` is the only change
 * made to them on the way into the repository; every recorded number below was
 * re-measured after the change and is unchanged.
 */
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

export const REPO = resolve(fileURLToPath(import.meta.url), '../../../../..');
export const SRC = join(REPO, 'packages/backend/src');
export const ROUTES = join(SRC, 'routes');
