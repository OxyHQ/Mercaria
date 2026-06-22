/**
 * Slug helpers.
 *
 * `slugify` produces a lowercase, hyphenated, URL-safe slug. `ensureUniqueSlug`
 * appends a numeric suffix (`-2`, `-3`, …) until an `exists` predicate reports
 * the candidate is free — used for store handles, category slugs, etc.
 */

/** First numeric suffix tried when the base slug is already taken. */
const FIRST_SUFFIX = 2;

/**
 * Convert arbitrary input to a URL-safe slug: lowercased, accents stripped,
 * non-alphanumeric runs collapsed to single hyphens, and leading/trailing
 * hyphens removed.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    // Strip combining diacritical marks left over from NFKD decomposition.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    // Any run of non-alphanumeric characters becomes a single hyphen.
    .replace(/[^a-z0-9]+/g, '-')
    // Collapse repeated hyphens (defensive; the run-collapse above mostly covers this).
    .replace(/-{2,}/g, '-')
    // Trim leading/trailing hyphens.
    .replace(/^-+|-+$/g, '');
}

/**
 * Return a unique slug derived from `base`. Calls `exists(candidate)` to test
 * availability, appending `-2`, `-3`, … until it returns `false`. The base
 * itself is tried first.
 */
export async function ensureUniqueSlug(
  base: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const root = slugify(base);

  if (!(await exists(root))) {
    return root;
  }

  for (let suffix = FIRST_SUFFIX; ; suffix += 1) {
    const candidate = `${root}-${suffix}`;
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
}
