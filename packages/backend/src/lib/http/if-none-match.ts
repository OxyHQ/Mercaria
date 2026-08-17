/**
 * `If-None-Match` comparison — HTTP syntax, owned in one place.
 *
 * This module exists because `services/catalog-authoring/etag.ts` said it should,
 * and named the exact condition:
 *
 * > These six lines also exist as `navigationEtagMatches`, and the duplication is
 * > deliberate rather than an oversight: an `If-None-Match` comparison is HTTP
 * > syntax, not a fact about either domain … If a THIRD surface needs it, it
 * > stops being HTTP syntax two files happen to spell and becomes a helper
 * > somebody owns — that is the point at which to consolidate, and not before.
 *
 * `/taxonomy` (#367 Workstream 1's HTTP surface) is that third surface, so the
 * two domain copies are GONE — a clean cut, not an alias and not a re-export.
 * `authoringEtagMatches` and `navigationEtagMatches` no longer exist and their
 * callers import this instead.
 *
 * What stays in each domain is what is actually domain knowledge: which
 * dimensions key a composition, and what its tag is prefixed with. Only the
 * comparison moved.
 *
 * ## What the comparison has to get right
 *
 * A client that received a STRONG tag and echoes it back WEAKLY is still telling
 * us it holds this exact content, so `W/` is stripped from the candidate before
 * comparing. Answering 200 to it would resend the whole payload on every
 * revalidation, which is a cache that has stopped working while reporting
 * success — and no test of the tag itself would notice.
 *
 * The list form and `*` are both RFC 9110 spellings a real client sends.
 * `undefined` is FALSE rather than a match: a request with no validator is asking
 * for the content.
 */

/** Whether an `If-None-Match` header matches the ETag we would serve. */
export function ifNoneMatchMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  const candidates = ifNoneMatch.split(',').map((value) => value.trim());
  if (candidates.includes('*')) return true;
  const strip = (value: string): string => (value.startsWith('W/') ? value.slice(2) : value);
  return candidates.some((candidate) => strip(candidate) === strip(etag));
}
