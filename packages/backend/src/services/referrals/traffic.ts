/**
 * Traffic classification for the referral edge (#143 link rule 4).
 *
 * "Classify bots, link previews and scanners without granting attribution to
 * them." This module is that classifier, and the first thing to say about it is
 * what it is NOT: it is not a fingerprint, it cannot become one, and ADR 0005
 * D17 puts it outside attribution by name — "HTTP-edge rate limiting is abuse
 * control on requests and contributes nothing to attribution or identity."
 *
 * ## What it reads, exhaustively
 *
 * Three self-declared request headers and nothing else:
 *
 *  1. `User-Agent` — matched, lowercased, against a closed list of substrings
 *     that automated clients put there ON PURPOSE so servers can tell.
 *  2. The fetch-metadata purpose headers — `Sec-Purpose`, `Purpose`,
 *     `X-Purpose`, `X-Moz` — which a browser sets when it is prefetching or
 *     rendering a preview rather than navigating.
 *  3. `ANALYTICS_INTERNAL_TRAFFIC_TOKEN`, the marker that already exists for
 *     #77 and authorizes nothing — reused rather than duplicated, because two
 *     ways to say "this is us" would eventually disagree about staff traffic.
 *
 * ## What it deliberately CANNOT see
 *
 * No IP address, no reverse DNS, no TLS or JA3 fingerprint, no `Accept-Language`,
 * no `Accept`, no screen metric, no cookie, no per-client counter and no stored
 * state of any kind. `classifyReferralTraffic` takes a plain record of headers
 * and returns a value; there is no database handle in the signature and no
 * module-level mutable state in the file, so "the classifier is not a
 * fingerprint" is a property of its shape rather than a promise.
 *
 * ## The failure direction, stated rather than hidden
 *
 * A crawler that lies about its `User-Agent` is classified `organic`. That is
 * accepted and it is the SAFE direction: the alternative — inferring
 * automation from behaviour — is the device fingerprint ADR 0005 A2 forbids,
 * and it would misclassify real shoppers on shared networks. The answer to a
 * lying crawler is D17's velocity thresholds and the per-code ceilings (#148),
 * which read Mercaria's own commerce facts rather than the request.
 *
 * The reverse direction is bounded too: a misclassified human loses their
 * referral attribution and NOTHING else — they still reach the destination,
 * because the redirect never varies on the classification. A classifier that
 * changed where somebody was sent would be a cloaking mechanism.
 */

import type { ReferralTrafficClass } from '@mercaria/shared-types';

/**
 * Substrings that identify an automated client, matched case-insensitively
 * against `User-Agent`.
 *
 * Every entry is a token a well-behaved crawler, monitor or link-unfurler puts
 * in its own `User-Agent` so that servers can recognise it. That is the whole
 * basis of this list — it detects declarations, not behaviour.
 *
 * `bot` covers the overwhelming majority (`Googlebot`, `bingbot`, `Twitterbot`,
 * `facebookexternalhit` is separate, `Applebot`, …). The remainder are named
 * because they do not carry it.
 */
const AUTOMATED_USER_AGENT_TOKENS: readonly string[] = [
  'bot',
  'crawler',
  'spider',
  'crawling',
  'facebookexternalhit',
  'slackbot',
  'discordbot',
  'telegrambot',
  'whatsapp',
  'linkedinbot',
  'pinterest',
  'redditbot',
  'embedly',
  'quora link preview',
  'showyoubot',
  'outbrain',
  'vkshare',
  'w3c_validator',
  'skypeuripreview',
  'nuzzel',
  'bitlybot',
  'curl/',
  'wget/',
  'python-requests',
  'python-httpx',
  'go-http-client',
  'java/',
  'okhttp',
  'axios/',
  'node-fetch',
  'headlesschrome',
  'phantomjs',
  'puppeteer',
  'playwright',
  'lighthouse',
  'pingdom',
  'uptimerobot',
  'statuscake',
  'newrelicpinger',
  'datadog',
  'ahrefsbot',
  'semrushbot',
  'mj12bot',
  'dotbot',
  'petalbot',
  'bytespider',
  'gptbot',
  'claudebot',
  'ccbot',
  'perplexitybot',
];

/**
 * Substrings that identify a PREVIEW or PREFETCH rather than a navigation.
 *
 * Kept apart from the bot list because they are a different fact and route
 * differently in the operator trace: a link-unfurler fetching a card is a
 * person about to click, while a crawler is not. Neither is attributable —
 * nobody arrived — but "somebody pasted this link into a chat" and "a search
 * engine indexed it" are answers to different partner-support questions.
 */
const PREVIEW_USER_AGENT_TOKENS: readonly string[] = [
  'facebookexternalhit',
  'slackbot-linkexpanding',
  'twitterbot',
  'whatsapp',
  'skypeuripreview',
  'discordbot',
  'telegrambot',
  'linkedinbot',
  'embedly',
  'quora link preview',
  'iframely',
  'developers.google.com/+/web/snippet',
];

/**
 * Values of the purpose headers that mean "this is not a navigation".
 *
 * `Sec-Purpose: prefetch` is the standardised form; `Purpose: prefetch`,
 * `X-Purpose: preview` and `X-Moz: prefetch` are the older ones several
 * browsers still send. A speculative fetch that recorded a touch would let a
 * browser's optimiser spend a partner's click ceiling on a link nobody chose.
 */
const NON_NAVIGATION_PURPOSES: readonly string[] = ['prefetch', 'prerender', 'preview', 'prefresh'];

/** The header names a purpose declaration may arrive under. */
const PURPOSE_HEADERS: readonly string[] = ['sec-purpose', 'purpose', 'x-purpose', 'x-moz'];

/**
 * The header the #77 internal-traffic token arrives on. It authorizes NOTHING
 * — #164 states that outright — and here it does exactly one thing: keeps
 * staff and test traffic out of attribution (#143 web rule 9).
 */
export const INTERNAL_TRAFFIC_HEADER = 'x-mercaria-internal-traffic';

/** The narrow slice of a request this classifier is allowed to see. */
export interface ReferralTrafficSignals {
  /** The raw `User-Agent`, or `undefined` when the client sent none. */
  userAgent?: string;
  /** The purpose headers, keyed by lowercase name. */
  purposeHeaders?: Readonly<Record<string, string | undefined>>;
  /** The presented internal-traffic token, if any. */
  internalTrafficToken?: string;
}

/** The classification, plus the ONE signal that produced it, for the trace. */
export interface ReferralTrafficVerdict {
  trafficClass: ReferralTrafficClass;
  /**
   * Which rule fired, in a bounded vocabulary. Never the header VALUE — a
   * `User-Agent` is a string a stranger controls and copying it into a log
   * line or a row is how an unbounded blob enters this domain.
   */
  signal:
    | 'internal_token'
    | 'purpose_header'
    | 'preview_user_agent'
    | 'automated_user_agent'
    | 'no_automation_signal';
}

/**
 * Classify one request.
 *
 * Order is deliberate and each step is a narrowing:
 *
 *  1. INTERNAL first. Mercaria's own monitors carry automated user agents, and
 *     classifying them `bot` would hide staff traffic in the same bucket as
 *     strangers' crawlers — #143 web rule 9 asks for staff to be excluded
 *     through an EXPLICIT mechanism, which is what the token is.
 *  2. A declared non-navigation PURPOSE next, because a real browser
 *     prefetching carries an ordinary `User-Agent` and would otherwise pass.
 *  3. PREVIEW before the general bot list, since several unfurlers match both
 *     and the more specific fact is the useful one.
 *  4. Everything else falls through to `organic`, which is the safe direction.
 */
export function classifyReferralTraffic(
  signals: ReferralTrafficSignals,
  internalTrafficToken: string | undefined,
): ReferralTrafficVerdict {
  const presented = signals.internalTrafficToken?.trim() ?? '';
  const expected = internalTrafficToken?.trim() ?? '';
  // An UNCONFIGURED deployment must not treat an empty presented token as a
  // match: `'' === ''` would classify every request internal and switch
  // attribution off marketplace-wide, silently.
  if (expected.length > 0 && presented === expected) {
    return { trafficClass: 'internal', signal: 'internal_token' };
  }

  const purposes = signals.purposeHeaders ?? {};
  for (const header of PURPOSE_HEADERS) {
    const value = purposes[header]?.toLowerCase() ?? '';
    if (value.length === 0) continue;
    if (NON_NAVIGATION_PURPOSES.some((purpose) => value.includes(purpose))) {
      return { trafficClass: 'preview', signal: 'purpose_header' };
    }
  }

  const agent = signals.userAgent?.toLowerCase() ?? '';
  if (agent.length === 0) {
    // No `User-Agent` at all is what a script sends. Every real browser sends
    // one, so the absence is itself a declaration.
    return { trafficClass: 'bot', signal: 'automated_user_agent' };
  }
  if (PREVIEW_USER_AGENT_TOKENS.some((token) => agent.includes(token))) {
    return { trafficClass: 'preview', signal: 'preview_user_agent' };
  }
  if (AUTOMATED_USER_AGENT_TOKENS.some((token) => agent.includes(token))) {
    return { trafficClass: 'bot', signal: 'automated_user_agent' };
  }
  return { trafficClass: 'organic', signal: 'no_automation_signal' };
}

/**
 * Whether a classification may produce attribution evidence.
 *
 * One function, one caller-visible answer, so no path can reach a different
 * reading of "organic". `attribution.service.ts` (#142) independently refuses a
 * non-organic touch, so this is the FIRST of two gates rather than the only
 * one — the touch is never written at all, and even if one were, it could not
 * win.
 */
export function trafficMayAttribute(trafficClass: ReferralTrafficClass): boolean {
  return trafficClass === 'organic';
}
