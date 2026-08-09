/**
 * Telling a person from a crawler, a preview fetcher, an email scanner and our
 * own traffic (#77 identity rule 10, acceptance 2, data-lifecycle rule 6).
 *
 * ## Classified separately, never dropped
 *
 * A bot's request is a fact about the system and is recorded as one. What
 * acceptance 2 requires is that previews do not INFLATE offer impressions and
 * affiliate CTR — a property of a metric's DENOMINATOR, which
 * `humanOnly: true` and the rollup's `traffic_class` filter deliver. Dropping
 * the row instead would make "how much of our traffic is automated" a question
 * with no answer, which is the question a coverage or freshness investigation
 * opens with.
 *
 * ## The signal is the user agent, and the OUTPUT is a class — never the string
 *
 * A user agent is a device characteristic. ADR 0003 I2 forbids using one as an
 * authorization or identity input, and #77 forbids storing a device
 * fingerprint. This module therefore takes the header, decides one of seven
 * bounded values, and the header itself never leaves the function: there is no
 * `user_agent` column anywhere in the analytics schema for it to arrive in.
 *
 * The same is true of the internal-traffic signal. It is a shared HEADER value
 * an internal client sets, compared in constant time — not an IP allow-list,
 * because an IP is the other identifier the issue names, and a CIDR list would
 * have needed the address recorded somewhere to be debuggable.
 */

import { timingSafeEqual } from 'node:crypto';
import type { AnalyticsTrafficClass } from '@mercaria/shared-types';
import { config } from '../../config/index.js';

/** The header an internal client sets to declare itself. */
export const ANALYTICS_INTERNAL_HEADER = 'x-mercaria-internal-traffic';

/**
 * Substrings that name a crawler.
 *
 * Lower-cased, matched as substrings, and deliberately not anchored: a crawler
 * announces itself in the middle of a long string, and every attempt to parse a
 * user agent precisely has been a mistake for thirty years.
 */
const CRAWLER_MARKERS = [
  'bot',
  'crawler',
  'spider',
  'slurp',
  'googlebot',
  'bingbot',
  'duckduckbot',
  'baiduspider',
  'yandex',
  'applebot',
  'ahrefs',
  'semrush',
  'mj12',
  'petalbot',
  'gptbot',
  'ccbot',
  'claudebot',
  'perplexitybot',
] as const;

/**
 * Substrings that name a LINK PREVIEW fetcher.
 *
 * Separated from crawlers on purpose, and this is the distinction acceptance 2
 * actually turns on: a preview fetch is triggered by a HUMAN pasting a link, so
 * it correlates with real interest and arrives in bursts around real activity —
 * which is exactly what makes it inflate an impression count in a way a
 * steady-rate crawler does not.
 */
const PREVIEW_MARKERS = [
  'facebookexternalhit',
  'twitterbot',
  'slackbot',
  'discordbot',
  'whatsapp',
  'telegrambot',
  'linkedinbot',
  'skypeuripreview',
  'embedly',
  'quora link preview',
  'redditbot',
  'pinterest',
  'vkshare',
  'iframely',
] as const;

/** Substrings that name a mailbox provider's link scanner. */
const EMAIL_SCANNER_MARKERS = [
  'googleimageproxy',
  'yahoomailproxy',
  'microsoft office',
  'outlook-ios',
  'barracuda',
  'proofpoint',
  'mimecast',
  'symanteclinkprotection',
  'safelinks',
] as const;

/** Substrings that name a scripted client rather than a browser or our apps. */
const AUTOMATED_CLIENT_MARKERS = [
  'curl/',
  'wget/',
  'python-requests',
  'python-httpx',
  'axios/',
  'go-http-client',
  'okhttp',
  'java/',
  'headlesschrome',
  'phantomjs',
  'playwright',
  'puppeteer',
  'selenium',
] as const;

/**
 * Classify one request.
 *
 * @param userAgent The `User-Agent` header, if any. Read and discarded.
 * @param internalHeader The declared internal-traffic token, if any.
 *
 * Order is load-bearing: internal first (our own smoke test may well set a
 * browser user agent), then email scanners and previews (several of them
 * contain `bot` and would otherwise be classified as crawlers), then crawlers,
 * then scripted clients. A missing user agent is `unknown`, never `human` —
 * defaulting an unidentifiable client into the cohort every quality metric is
 * computed over is how a bot problem becomes invisible.
 */
export function classifyTraffic(input: {
  userAgent?: string;
  internalHeader?: string;
}): AnalyticsTrafficClass {
  if (isInternalTraffic(input.internalHeader)) return 'internal';

  const agent = input.userAgent?.toLowerCase().trim();
  if (agent === undefined || agent === '') return 'unknown';

  if (EMAIL_SCANNER_MARKERS.some((marker) => agent.includes(marker))) return 'email_scanner';
  if (PREVIEW_MARKERS.some((marker) => agent.includes(marker))) return 'link_preview';
  if (CRAWLER_MARKERS.some((marker) => agent.includes(marker))) return 'crawler';
  if (AUTOMATED_CLIENT_MARKERS.some((marker) => agent.includes(marker))) return 'automated_client';

  return 'human';
}

/**
 * Whether the declared internal token matches the configured one.
 *
 * Constant-time, and refusing when nothing is configured. `verifySecret`'s rule
 * from `@oxyhq/core/server` applied locally: this token decides whether traffic
 * is excluded from every quality metric, so a `===` here is a way to discover
 * the value one character at a time and then hide arbitrary traffic from every
 * dashboard.
 */
function isInternalTraffic(declared: string | undefined): boolean {
  const expected = config.analytics.internalTrafficToken;
  if (expected === '' || declared === undefined || declared === '') return false;
  const a = Buffer.from(declared);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Every marker list, so a test can assert none of them is empty. */
export const TRAFFIC_MARKER_LISTS = {
  crawler: CRAWLER_MARKERS,
  linkPreview: PREVIEW_MARKERS,
  emailScanner: EMAIL_SCANNER_MARKERS,
  automatedClient: AUTOMATED_CLIENT_MARKERS,
} as const;
