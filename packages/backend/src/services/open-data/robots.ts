/**
 * `robots.txt`, read the way RFC 9309 says a crawler must.
 *
 * An EXTRACTION provider (one that reads a site rather than an API offered for
 * reuse) runs only under a `robots_respecting` policy, and this is what makes
 * that word true: before it reads a path, it asks the site's own robots file.
 *
 * The rules, as RFC 9309 states them:
 * - the group whose `user-agent` matches the crawler's product token applies,
 *   else the `*` group, else everything is allowed;
 * - within the group, the LONGEST matching `allow`/`disallow` path wins, and
 *   `allow` wins a tie;
 * - `*` matches any run of characters and a trailing `$` anchors the end.
 */

interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
}

interface RobotsGroup {
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
}

function parseGroups(robotsTxt: string): RobotsGroup[] {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | undefined;
  let lastWasAgent = false;
  for (const rawLine of robotsTxt.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*$/u, '').trim();
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      // Consecutive user-agent lines open ONE group.
      if (current === undefined || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === undefined) continue;
    if (field === 'allow' || field === 'disallow') {
      // An empty `disallow` allows everything; it is not a rule.
      if (value === '') continue;
      current.rules.push({ allow: field === 'allow', pattern: value });
    }
  }
  return groups;
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*');
  return new RegExp(`^${regex}${anchored ? '$' : ''}`, 'u').test(path);
}

/**
 * May a crawler identifying as `productToken` fetch `path` (with its query)?
 * A site with no robots file (`null`) allows everything, per RFC 9309.
 */
export function robotsAllows(robotsTxt: string | null, productToken: string, path: string): boolean {
  if (robotsTxt === null) return true;
  const groups = parseGroups(robotsTxt);
  const token = productToken.toLowerCase();
  const group =
    groups.find((candidate) => candidate.agents.some((agent) => agent !== '*' && token.startsWith(agent))) ??
    groups.find((candidate) => candidate.agents.includes('*'));
  if (group === undefined) return true;

  let best: RobotsRule | undefined;
  for (const rule of group.rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    if (
      best === undefined ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best === undefined || best.allow;
}
