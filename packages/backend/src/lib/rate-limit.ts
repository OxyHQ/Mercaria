/**
 * Rate limiting.
 *
 * Wraps the SDK's `createOxyRateLimit` (per-user for authenticated callers,
 * per-IP for anonymous) with a Redis-backed store when `REDIS_URL` is set, so
 * limits are shared across all ECS tasks behind the ALB. Without Redis it falls
 * back to the SDK's in-memory store (per-instance).
 *
 * Each scope MUST use a unique `rl:<scope>:` Redis prefix — sharing one Redis
 * client across limiters without distinct prefixes makes them increment the
 * same key and halves the effective budget (ERR_ERL_DOUBLE_COUNT).
 */

import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createOxyRateLimit, type OxyRateLimitOptions } from '@oxyhq/core/server';
import { oxyClient } from '../middleware/auth.js';
import { actorRateKey } from '../services/commerce-actor.js';
import { getRedisClient } from './redis.js';
import { log } from './logger.js';

export type RateLimitScope =
  | 'general'
  | 'feedback'
  | 'listings'
  | 'feed'
  | 'stores'
  // The PUBLIC P2P seller profile (#92, privacy rule 5). Its own bucket
  // (`rl:sellers:`) rather than sharing `'stores'`, because the risk is
  // different in kind: this route is keyed on an Oxy ACCOUNT ID, so an
  // unmetered surface is a way to walk the id space and learn which Oxy
  // accounts sell here and what they sell. Sharing the shop page's budget would
  // mean a crawler either exhausts shopping for everyone or is not bounded.
  | 'sellers'
  | 'cart'
  | 'checkout'
  | 'orders'
  | 'reviews'
  | 'admin'
  | 'search'
  | 'rates'
  | 'channels'
  | 'reports'
  | 'payments'
  // ADR 0003 D3/T10: guest-session ISSUANCE has its own bucket
  // (`rl:guest-issue:`) — per IP, since the caller is anonymous by definition
  // — so a farmer exhausts this budget, not the general one.
  | 'guest-issue'
  // The rest of the guest-session surface (inspect/rotate/revoke).
  | 'guest'
  // Guest order RECOVERY (#108 recovery rule 2) — the NETWORK axis of the three
  // the issue names, and the only one a per-IP bucket can serve. Its own bucket
  // (`rl:guest-recover:`) and a tight one: the endpoint always answers 202, so
  // there is no failure a legitimate client retries, and the two durable axes
  // (per inbox, per order reference) live in Postgres because "how often has
  // THIS INBOX been asked for, across every ECS task" is not a question a
  // per-process counter can answer.
  | 'guest-recover'
  // The authenticated guest PORTAL — the exchange, the reads and the two
  // mutations. Separate from `'guest'` because the credentials are different
  // and so is the risk: a portal token reaches a placed order's detail, while a
  // guest session reaches a cart.
  | 'guest-portal'
  // Claiming a checkout group into an Oxy account (#109). Its own bucket
  // (`rl:guest-claim:`) and a small one: a claim is a once-per-group act
  // requiring BOTH a verified Oxy session and a verified portal credential, so
  // a caller hammering it is retrying a refusal or probing for a group somebody
  // else holds — and neither should spend the budget the portal's ordinary
  // reads need.
  | 'guest-claim'
  // Buyer post-purchase requests — cancellations, returns and support (#110).
  // Its own bucket (`rl:buyer-requests:`) rather than sharing `'guest-portal'`,
  // because the two are reached by the same credential and exhausting one must
  // not lock somebody out of the other: a person who filed three cancellations
  // in a minute should still be able to READ the order they are worried about.
  | 'buyer-requests'
  // Merchant claiming (#83, security control 1) — the NETWORK axis of the four
  // the issue names. Its own bucket (`rl:merchant-claims:`) so a claim-farming
  // burst exhausts this budget and not the general one; the per-user,
  // per-merchant and per-domain axes are durable counts in Postgres, because
  // "how often may this DOMAIN be challenged, across every claimant and every
  // ECS task" is not a question a per-IP bucket can answer.
  | 'merchant-claims'
  // The guest→Oxy cart merge (#104). Its own bucket, and a small one: a merge
  // is a once-per-session act, so a caller hammering it is retrying a failure
  // or probing, and neither should share the ordinary cart budget.
  | 'cart-merge'
  // Client analytics ingestion (#77). Its own bucket (`rl:analytics-ingest:`)
  // and deliberately a GENEROUS one: an impression batch is the highest-volume
  // legitimate request this API takes, and metering it on the general budget
  // would make a shopper who scrolls a long results page spend the allowance
  // they need to check out with. Nothing behind it writes commerce state, and
  // the handler refuses every server-only event type before any database
  // access, so the budget bounds cost rather than risk.
  | 'analytics-ingest'
  // The merchant product-feed surface (#63 security 7). Its own bucket
  // (`rl:feed-import:`) so a merchant iterating on a mapping does not spend the
  // allowance they need to run their shop.
  | 'feed-import'
  // The two feed routes that FETCH — preview, validate, upload and sync — on a
  // much smaller budget (`rl:feed-import-fetch:`). Each causes an outbound
  // request to a host the MERCHANT chose, so an unmetered surface is a way to
  // make Mercaria hammer a third party, or to make it download a gigabyte on
  // demand, repeatedly.
  | 'feed-import-fetch'
  // A merchant's own competitiveness analysis (#82). Its own bucket
  // (`rl:merchant-competitiveness:`) because the COST profile is unlike anything
  // else here: one request examines a page of the merchant's own subjects, and
  // each subject costs a comparison read plus a price-history derivation. Sharing
  // the `'admin'` budget would let a merchant refreshing a dashboard exhaust the
  // allowance they need to run their shop.
  | 'merchantCompetitiveness'
  // Natural-language intent parsing (#95 safety rule 8). Its own bucket
  // (`rl:search-intent:`) and a small one, because a parse is the one read on
  // this API that may call an outbound MODEL: sharing the `'listings'` budget
  // would let a parse flood exhaust the allowance a shopper needs to browse,
  // and would make the model's cost bounded by the number that bounds a
  // category page. Keyed on the ACTOR, so a guest is bucketed per SESSION
  // rather than per IP — one NAT is not one shopper.
  | 'search-intent'
  // The public routing and SEO surface (#75). Its own bucket (`rl:seo:`) and a
  // GENEROUS one, for the reason `analytics-ingest` has its own: the caller is
  // the Cloudflare Worker on behalf of a crawler, one request per page view,
  // and metering it on the general budget would make a crawl spend the
  // allowance shoppers need. Everything behind it is a public read that writes
  // nothing, so the budget bounds cost rather than risk.
  | 'seo'
  // Merchant demand analytics (#86). Its own bucket (`rl:merchant-demand:`) for
  // two reasons at once: a read builds a reporting SNAPSHOT when there is none
  // for the window, which is several aggregate scans rather than an indexed
  // lookup, and the PREVIEW half is unauthenticated and keyed on a merchant id,
  // so an unmetered surface is a way to walk the merchant id space and learn
  // roughly how much demand Mercaria carries for each of them.
  | 'merchant-demand';

/** The shared, prefixed Redis store for a scope, or `undefined` without Redis. */
function scopeStore(scope: RateLimitScope): RedisStore | undefined {
  const redis = getRedisClient();
  if (!redis) {
    log.general.info({ scope }, 'Rate limiter using in-memory store (REDIS_URL not set)');
    return undefined;
  }
  return new RedisStore({
    prefix: `rl:${scope}:`,
    sendCommand: (command: string, ...args: string[]) =>
      redis.call(command, ...args) as Promise<number | string>,
  });
}

/**
 * Build a rate-limit middleware for a scope. The scope drives a unique
 * `rl:<scope>:` Redis key prefix so limiters never share counters.
 */
export function makeRateLimiter(
  scope: RateLimitScope,
  options: Omit<OxyRateLimitOptions, 'store'> = {},
): RequestHandler {
  const store = scopeStore(scope);
  return createOxyRateLimit(oxyClient, { ...options, ...(store ? { store } : {}) });
}

/** Tunables for {@link makeActorRateLimiter}, mirroring the SDK's own names. */
export interface ActorRateLimitOptions {
  /** Budget for an identified actor — Oxy account or guest session. */
  identifiedMax?: number;
  /** Budget for an anonymous caller, keyed per IP. */
  anonymousMax?: number;
  /** Window in milliseconds. */
  windowMs?: number;
}

/** The SDK's own defaults, so an actor-aware scope is not quietly stricter. */
const DEFAULT_IDENTIFIED_MAX = 5_000;
const DEFAULT_ANONYMOUS_MAX = 600;
const DEFAULT_WINDOW_MS = 15 * 60 * 1_000;

/**
 * A rate limiter keyed on the resolved `CommerceActor` (#104 route requirement
 * 6, ADR 0003 D1).
 *
 * `createOxyRateLimit` keys per Oxy user or, failing that, per IP — which is
 * exactly wrong for guests: every guest behind one NAT or one mobile carrier
 * would share a single bucket, so a busy coffee shop rate-limits itself while a
 * farmer with a rotating address is barely touched. `actorRateKey` keys the
 * guest by their SESSION instead, which is both the fairer and the tighter
 * bound, and falls back to the IP only for callers with no identity at all.
 *
 * MUST be mounted AFTER `resolveCommerceActor`; without it every request looks
 * anonymous and the limiter silently degrades to per-IP. The key function fails
 * closed on that (it uses the anonymous branch) rather than throwing, because a
 * limiter that 500s is worse than one that is coarse.
 *
 * The anonymous branch runs its address through `ipKeyGenerator` FIRST, which
 * collapses an IPv6 address to its /64 prefix. Without it a v6 client bypasses
 * a per-IP budget by walking its own subnet — every consumer address gets at
 * least a /64, so "one address, one bucket" is a v4 assumption that does not
 * survive the move. express-rate-limit's own validator flags the raw form,
 * which is how this was caught rather than shipped.
 *
 * The ids inside a key are internal row/account ids and never leave the
 * backend — they are hashed into a Redis key and appear in no response and no
 * log line. The guest TOKEN is not among them; the resolver never puts it on
 * the request.
 */
export function makeActorRateLimiter(
  scope: RateLimitScope,
  options: ActorRateLimitOptions = {},
): RequestHandler {
  const store = scopeStore(scope);
  const identifiedMax = options.identifiedMax ?? DEFAULT_IDENTIFIED_MAX;
  const anonymousMax = options.anonymousMax ?? DEFAULT_ANONYMOUS_MAX;

  return rateLimit({
    windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
    limit: (req: Request) => (req.commerceActor?.kind === 'anonymous' ? anonymousMax : identifiedMax),
    keyGenerator: (req: Request) =>
      actorRateKey(req.commerceActor ?? { kind: 'anonymous' }, ipKeyGenerator(req.ip ?? 'unknown')),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, error: 'RATE_LIMITED', message: 'Too many requests' },
    ...(store ? { store } : {}),
  });
}
