/**
 * #67's affiliate outbound redirect, against a REAL PostgreSQL server.
 *
 * ## The failure mode this file exists for
 *
 * **An open redirect wearing a marketplace's name.** `/out/:token` exists to
 * send a shopper to somebody else's site, so the whole of #67's security rests
 * on the set of places it can send them not being a function of anything a
 * caller supplies. Two of the three mechanisms that hold that are SHAPES a unit
 * test can read (the token has no destination member; the admission function
 * takes no request), and the third — the destination allow-list — is a table
 * with a CHECK, a partial unique index and an exact host comparison, none of
 * which exists under a mock. A mocked `insert` accepts `https://example.com/`
 * as a "hostname" and a mocked repository returns whatever a test hands it, so
 * the one thing a mock cannot tell you is whether the row an operator typed is
 * the row the redirect will compare against.
 *
 * The second failure mode is quieter and is why the click assertions are here
 * too: a refusal that stored nothing makes "why is this merchant's button dead"
 * unanswerable, and a bot counted as a human click makes a partner report wrong
 * in the direction nobody audits.
 *
 * ## Every proof, and why it needs a server
 *
 *  1. Not an open redirect — the allow-list is a ROW, so an un-approved host
 *     refuses and the SAME offer redirects once an operator approves it.
 *  2. The suffix attack, in BOTH directions. See that describe block: the two
 *     host shapes defeat different wrong implementations and only one of them
 *     catches `endsWith`.
 *  3. A native offer is refused BY NAME by the service, and carrying a
 *     destination at all is refused by `offers_kind_shape_check` — the
 *     structural half, which only a real server enforces.
 *  4. A click row on BOTH paths, plus the two rows
 *     `affiliate_outbound_clicks_outcome_shape_check` must refuse.
 *  5. The row is immutable by TRIGGER and deletable by design (the shared
 *     expiry sweep's only lever). Both directions, because a trigger that
 *     refused DELETE would make retention fail silently.
 *  6. Bots and previews are REDIRECTED and not attributed — a classification
 *     that changed the destination would be cloaking.
 *  7. A withdrawn `outbound_link` right refuses. This is the case #67 ADDED to
 *     #68's gate, and it is a LIVE read of the active policy version, so it
 *     needs a second published version to exist at all.
 *  8. A retired offer and a stale one refuse, through #68's gate.
 *  9. The token: tampered, foreign-prefixed and malformed all refuse
 *     identically and write NO row, and a token for A never resolves to B.
 * 10. The allow-list's own constraints — the host shape, the revocation
 *     biconditional, and the PARTIAL unique that lets a host be approved,
 *     revoked and approved again.
 * 11. The disclosure names the MERCHANT while the redirect hands over the
 *     NETWORK's redirector. Getting these backwards is a real deception, and
 *     it is invisible to any test that only reads one of the two.
 *
 * ## Scoping, because this database is SHARED
 *
 * Vitest runs files in parallel workers against one throwaway database, so
 * every name, slug, provider and host here carries a per-run suffix, every
 * assertion is scoped to ids this file created, and teardown deletes exactly
 * those. The one AGGREGATE read — `countAffiliateOutboundClicks`, which sums
 * over the whole table within a time window — is scoped by giving its offer a
 * run-unique `affiliate_network` and passing that as the counter's filter,
 * because a sibling seeding clicks would otherwise move a count this file
 * asserts. Every count equality is paired with a non-zero floor: "I found less"
 * and "there is less" look identical.
 *
 * Fixture instants are all relative to `now`. A hardcoded absolute date in a
 * committed fixture is a time bomb that detonates in a sibling file.
 *
 * ## Why this file does NOT take `acquireActivePolicySlot`
 *
 * That mutex guards `match_policy_versions_active_key`, which is GLOBAL — one
 * active matching policy in the whole database — and every claimant of it
 * reaches `runMatch`. This file never does: it calls `recordExternalOffer`
 * directly and drives no ingestion page, so no matching policy is read or
 * written. `catalog_source_policies_active_key` is a different index scoped to
 * ONE source, so publishing a second rights version (proof 7) contends with
 * nobody. Taking the global slot anyway would serialise this file behind four
 * others for no property.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import {
  AFFILIATE_OUTBOUND_TOKEN_PREFIX,
  OUTBOUND_REDIRECT_REFUSAL_REASONS,
} from '@mercaria/shared-types';
import type { OutboundRedirectDecision } from '../redirect.service.js';

/**
 * Every backend binding is loaded DYNAMICALLY in `beforeAll`, after the
 * environment below is set.
 *
 * `config/index.ts` reads `process.env` once at module load and freezes the
 * result, and two of this file's proofs depend on values it reads:
 * `OUTBOUND_TOKEN_SECRET` (without which `mintAffiliateOutboundToken` throws
 * rather than signing with an empty key) and `OUTBOUND_REDIRECT_ENABLED`
 * (without which `resolveOutboundDisclosure` returns `undefined`). A STATIC
 * import of anything reaching config would pull it before those exist, and the
 * failure would be a disclosure that is always absent — a green-looking file
 * measuring nothing. Every realdb file with an env dependency does this.
 */
let db: import('../../../db/postgres.js').Database;
let closePostgres: typeof import('../../../db/postgres.js').closePostgres;
let createApp: typeof import('../../../app.js').createApp;
let schema: typeof import('../../../db/schema/index.js');
let resolveOutboundRedirect: typeof import('../redirect.service.js').resolveOutboundRedirect;
let mintAffiliateOutboundToken: typeof import('../token.js').mintAffiliateOutboundToken;
let resolveOutboundDisclosure: typeof import('../disclosure.js').resolveOutboundDisclosure;
let approveOutboundHost: typeof import('../../../db/affiliateOutbound/hostRepository.js').approveOutboundHost;
let revokeOutboundHost: typeof import('../../../db/affiliateOutbound/hostRepository.js').revokeOutboundHost;
let listApprovedOutboundHosts: typeof import('../../../db/affiliateOutbound/hostRepository.js').listApprovedOutboundHosts;
let countAffiliateOutboundClicks: typeof import('../../../db/affiliateOutbound/clickRepository.js').countAffiliateOutboundClicks;
let listAffiliateOutboundClicksForOffer: typeof import('../../../db/affiliateOutbound/clickRepository.js').listAffiliateOutboundClicksForOffer;
let findAffiliateOutboundClickById: typeof import('../../../db/affiliateOutbound/clickRepository.js').findAffiliateOutboundClickById;
let findOfferById: typeof import('../../../db/offers/offerRepository.js').findOfferById;
let retireOffers: typeof import('../../../db/offers/offerRepository.js').retireOffers;
let recordExternalOffer: typeof import('../../offers/offer.service.js').recordExternalOffer;
let configureIngestionSource: typeof import('../../ingestion/source.service.js').configureIngestionSource;
let publishIngestionSourcePolicy: typeof import('../../ingestion/source.service.js').publishIngestionSourcePolicy;
let changeIngestionSourceStatus: typeof import('../../ingestion/source.service.js').changeIngestionSourceStatus;
let declaredOfferCondition: typeof import('../../condition/condition-mapping.service.js').declaredOfferCondition;
let deleteTestCanonicalRows: typeof import('../../../db/__tests__/canonical-teardown.js').deleteTestCanonicalRows;
let deleteTestStores: typeof import('../../../db/__tests__/store-teardown.js').deleteTestStores;
let withTriggerToggleLock: typeof import('../../../db/__tests__/trigger-toggle-lock.js').withTriggerToggleLock;

/** Unique to this run, so parallel files cannot collide on an id, a name or a host. */
const RUN = uuidv7().slice(-12);
const OPERATOR = `outbound-op-${RUN}`;

/**
 * The `affiliate_network` this file's traffic-counting offer carries.
 *
 * It is the scoping handle for the ONE aggregate read here:
 * `countAffiliateOutboundClicks` sums over the whole table within a window, and
 * a sibling writing clicks in the same second would move a number this file
 * asserts. Free text on both the offer and the click row, so a run-unique value
 * is legal, and unknown to `NETWORK_REDIRECTOR_HOSTS`, so the offer still goes
 * through the allow-list rather than the network-redirector branch.
 */
const TRAFFIC_NETWORK = `outbnet-${RUN}`;

/** An ordinary desktop browser: no automation token, no purpose header. */
const HUMAN_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
/** A crawler that declares itself, which is the only basis #143's classifier has. */
const BOT_USER_AGENT =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const createdSourceIds: string[] = [];
const createdMerchantIds: string[] = [];
const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];
const createdOfferIds: string[] = [];
/** Every HTTP server the response cases opened, closed in `afterAll`. */
const servers: Server[] = [];
const createdStoreIds: string[] = [];
const createdListingIds: string[] = [];

/** `inArray` on an empty list renders `false`; a sentinel keeps the SQL valid. */
function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

/**
 * Assert a write is refused, and report WHY — the whole cause chain.
 *
 * drizzle's own message is "Failed query: …" and the constraint name lives on
 * the `PostgresError` it carries as `cause`. A test matching only the outer
 * message would pass against ANY refusal, which is precisely the check that
 * cannot tell a CHECK from a typo — and every refusal asserted below names its
 * constraint, so a constraint that had been dropped would have to be replaced
 * by an identically-named one to keep this green.
 * `offer-freshness.realdb.test.ts`' helper, verbatim.
 */
async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
  throw new Error('expected the statement to be refused, and it was accepted');
}

beforeAll(async () => {
  // BEFORE the imports below. See the binding block's docblock.
  process.env.OUTBOUND_TOKEN_SECRET = `outbound-realdb-secret-${RUN}`;
  process.env.OUTBOUND_REDIRECT_ENABLED = 'true';
  // Explicit, not assumed: a sibling in the same worker may have set it, and an
  // internal-traffic token that happened to match would classify every request
  // here `internal` and silently make proof 6's organic case unreachable.
  delete process.env.ANALYTICS_INTERNAL_TRAFFIC_TOKEN;

  const postgres = await import('../../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
  schema = await import('../../../db/schema/index.js');
  ({ resolveOutboundRedirect } = await import('../redirect.service.js'));
  ({ mintAffiliateOutboundToken } = await import('../token.js'));
  ({ resolveOutboundDisclosure } = await import('../disclosure.js'));
  ({ approveOutboundHost, revokeOutboundHost, listApprovedOutboundHosts } = await import(
    '../../../db/affiliateOutbound/hostRepository.js'
  ));
  ({
    countAffiliateOutboundClicks,
    listAffiliateOutboundClicksForOffer,
    findAffiliateOutboundClickById,
  } = await import('../../../db/affiliateOutbound/clickRepository.js'));
  ({ findOfferById, retireOffers } = await import('../../../db/offers/offerRepository.js'));
  ({ recordExternalOffer } = await import('../../offers/offer.service.js'));
  ({ configureIngestionSource, publishIngestionSourcePolicy, changeIngestionSourceStatus } =
    await import('../../ingestion/source.service.js'));
  ({ declaredOfferCondition } = await import('../../condition/condition-mapping.service.js'));
  ({ deleteTestCanonicalRows } = await import('../../../db/__tests__/canonical-teardown.js'));
  ({ deleteTestStores } = await import('../../../db/__tests__/store-teardown.js'));
  ({ withTriggerToggleLock } = await import('../../../db/__tests__/trigger-toggle-lock.js'));
  ({ createApp } = await import('../../../app.js'));
}, 120_000);

afterAll(async () => {
  // Before the database work: a listening socket holds the worker open, and a
  // suite that leaked one would hang the run rather than fail it.
  await Promise.all(
    servers.map(
      async (server) =>
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  // Children first: every intra-graph foreign key here is RESTRICT, so a wrong
  // order fails loudly rather than cascading something this file does not own.
  await db
    .delete(schema.affiliateOutboundClicks)
    .where(inArray(schema.affiliateOutboundClicks.offerId, safeIds(createdOfferIds)));
  // `affiliate_outbound_hosts.catalog_source_id` is RESTRICT, so the approvals
  // go before the sources they are scoped to.
  await db
    .delete(schema.affiliateOutboundHosts)
    .where(inArray(schema.affiliateOutboundHosts.catalogSourceId, safeIds(createdSourceIds)));
  // Deleting the offers takes their `offer_price_snapshots` with them
  // (CASCADE), which is what unblocks `source_records` below — a snapshot's
  // `source_record_id` is RESTRICT.
  await db.delete(schema.offers).where(inArray(schema.offers.id, safeIds(createdOfferIds)));
  // `listings.store_id` is RESTRICT — a listing outlives its store on purpose —
  // so the listings go first and take their product variants with them.
  await db.delete(schema.listings).where(inArray(schema.listings.id, safeIds(createdListingIds)));
  await deleteTestStores(db, safeIds(createdStoreIds));
  await db
    .delete(schema.sourceRecords)
    .where(inArray(schema.sourceRecords.sourceId, safeIds(createdSourceIds)));
  await db
    .delete(schema.catalogSourceConfigs)
    .where(inArray(schema.catalogSourceConfigs.sourceId, safeIds(createdSourceIds)));
  /**
   * A published rights version is frozen by trigger and cannot be deleted —
   * which is the point of the freeze — so the teardown has to switch it off.
   *
   * `alter table … disable trigger` is DATABASE-WIDE and this suite shares one
   * server, so the window is taken under the shared trigger-toggle lock: that
   * is what makes "disable, delete, enable" atomic with respect to the other
   * files doing the same, and it costs one round trip. ONE TABLE PER WINDOW
   * (#301) — the statement takes ShareRowExclusive, which conflicts with an
   * ordinary writer's RowExclusive, so holding one table's lock while acquiring
   * another's is a deadlock waiting for a writer that takes the pair the other
   * way round.
   */
  await withTriggerToggleLock(db, async (tx) => {
    await tx.execute(
      sql`alter table catalog_source_policies disable trigger catalog_source_policies_immutable`,
    );
    await tx
      .delete(schema.catalogSourcePolicies)
      .where(inArray(schema.catalogSourcePolicies.sourceId, safeIds(createdSourceIds)));
    await tx.execute(
      sql`alter table catalog_source_policies enable trigger catalog_source_policies_immutable`,
    );
  });
  await db
    .delete(schema.catalogSources)
    .where(inArray(schema.catalogSources.id, safeIds(createdSourceIds)));
  await deleteTestCanonicalRows(db, {
    variantIds: createdVariantIds,
    productIds: createdProductIds,
  });
  await db.delete(schema.merchants).where(inArray(schema.merchants.id, safeIds(createdMerchantIds)));
  await closePostgres();
});

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A sha-256-shaped digest; several CHECKs here refuse anything else. */
function digest(): string {
  return uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64);
}

async function mintMerchant(label: string): Promise<string> {
  const [row] = await db
    .insert(schema.merchants)
    .values({ name: `Outbound ${label} ${RUN}`, slug: `outbound-${label}-${RUN}` })
    .returning({ id: schema.merchants.id });
  if (!row) throw new Error('the merchant was not written');
  createdMerchantIds.push(row.id);
  return row.id;
}

/** One canonical product plus its one variant — what every offer attaches to. */
async function mintCanonicalVariant(label: string): Promise<string> {
  const [product] = await db
    .insert(schema.canonicalProducts)
    .values({
      name: `Outbound ${label} ${RUN}`,
      normalizedName: `outbound ${label} ${RUN}`,
      slug: `outbound-${label}-${RUN}`,
    })
    .returning({ id: schema.canonicalProducts.id });
  if (!product) throw new Error('the canonical product was not written');
  createdProductIds.push(product.id);

  const [variant] = await db
    .insert(schema.canonicalVariants)
    .values({ productId: product.id, signature: digest() })
    .returning({ id: schema.canonicalVariants.id });
  if (!variant) throw new Error('the canonical variant was not written');
  createdVariantIds.push(variant.id);
  return variant.id;
}

async function mintSourceRecord(sourceId: string, externalId: string): Promise<string> {
  const [record] = await db
    .insert(schema.sourceRecords)
    .values({
      sourceId,
      externalType: 'offer',
      externalId,
      contentHash: digest(),
      observedAt: new Date(),
      payload: { price: 1_999 },
    })
    .returning({ id: schema.sourceRecords.id });
  if (!record) throw new Error('the source record was not written');
  return record.id;
}

/** Rights granting everything, so a case is about the redirect and nothing else. */
const FULL_RIGHTS = {
  mayDisplay: true,
  mayStore: true,
  mayCache: true,
  cacheTtlSeconds: 86_400,
  mayDisplayPrice: true,
  mayDisplayMedia: true,
  mayLinkOut: true,
  mayAppendAffiliateParams: true,
  mayIndex: true,
  mayRefreshAutomatically: true,
  extractionMode: 'disallowed' as const,
  attributionRequired: true,
};

interface Source {
  readonly sourceId: string;
  readonly provider: string;
  readonly merchantId: string;
}

/**
 * Configure, permit and activate a source the way an operator would.
 *
 * The rights matter twice over here. `may_display` is the coarse projection
 * `catalog_sources` carries and the DEFERRABLE constraint trigger
 * `mercaria_catalog_source_rights_agree` refuses any COMMIT where it disagrees
 * with the active policy — so the projection is never set by hand in this file,
 * only ever through `publishIngestionSourcePolicy`, which reprojects in the
 * same transaction. And `may_link_out` is the right #67's gate now reads LIVE,
 * which is what proof 7 withdraws.
 */
async function bringUpSource(label: string): Promise<Source> {
  const provider = `outb-${label}-${RUN}`.toLowerCase().replace(/[^a-z0-9_-]/gu, '').slice(0, 64);
  const merchantId = await mintMerchant(label);
  const resolved = await configureIngestionSource({
    name: `Outbound source ${label} ${RUN}`,
    kind: 'feed',
    provider,
    merchantId,
    fetchCadenceSeconds: 3_600,
    freshnessTtlSeconds: 3_600,
    pageSize: 50,
  });
  const sourceId = resolved.source.config.sourceId;
  createdSourceIds.push(sourceId);
  await publishIngestionSourcePolicy({
    sourceId,
    reviewedByOxyUserId: OPERATOR,
    ...FULL_RIGHTS,
  });
  await changeIngestionSourceStatus({
    sourceId,
    status: 'active',
    actorOxyUserId: OPERATOR,
    reason: 'outbound redirect acceptance suite',
  });
  return { sourceId, provider, merchantId };
}

/**
 * One `affiliate` offer pointing at `destinationUrl`.
 *
 * A fresh canonical variant per offer, deliberately: `offers_commercial_key`'s
 * partial unique is one active offer per (canonical variant, seller, channel,
 * condition), so two offers of one source would otherwise collide on a
 * constraint that has nothing to do with what is under test.
 *
 * Instants are relative to `now` — `staleAt` an hour out, which with the
 * source's own 3600s freshness TTL makes the offer unambiguously CURRENT.
 * Proof 8 makes one stale by resolving with a FUTURE clock rather than by
 * back-dating the row, because `recordExternalOffer` stamps `last_seen_at` from
 * `max(now, observedAt)` and #68 runs its deadlines from the last CHECK rather
 * than the last CHANGE — back-dating `observed_at` alone would leave the offer
 * perfectly current and the case vacuous.
 */
async function seedOffer(
  source: Source,
  input: {
    readonly label: string;
    readonly destinationUrl: string;
    readonly network?: string;
    readonly trackingTemplate?: string;
    readonly country?: string;
  },
): Promise<string> {
  const variantId = await mintCanonicalVariant(input.label);
  const externalOfferId = `ext-${input.label}-${RUN}`;
  const sourceRecordId = await mintSourceRecord(source.sourceId, externalOfferId);
  const observedAt = new Date();
  const offerId = await recordExternalOffer(
    {
      kind: 'affiliate',
      canonicalVariantId: variantId,
      merchantId: source.merchantId,
      sourceRecordId,
      provider: source.provider,
      externalOfferId,
      destinationUrl: input.destinationUrl,
      price: { amount: 1_999, currency: 'EUR' },
      availability: 'in_stock',
      ...(input.country === undefined ? {} : { country: input.country }),
      ...(input.network === undefined
        ? {}
        : {
            affiliate: {
              network: input.network,
              ...(input.trackingTemplate === undefined
                ? {}
                : { trackingTemplate: input.trackingTemplate }),
            },
          }),
      observedAt,
      staleAt: new Date(observedAt.getTime() + 3_600_000),
    },
    observedAt,
    db,
  );
  createdOfferIds.push(offerId);
  return offerId;
}

/* -------------------------------------------------------------------------- */
/*  Driving the redirect                                                       */
/* -------------------------------------------------------------------------- */

interface DriveInput {
  readonly offerId?: string;
  readonly token?: string;
  readonly now?: Date;
  readonly userAgent?: string;
  readonly purposeHeaders?: Readonly<Record<string, string | undefined>>;
}

/**
 * One `/out/:token` resolution, with the HTTP left out.
 *
 * The default user agent is an ordinary browser, so a case that says nothing
 * about traffic is `organic` — which matters because `classifyReferralTraffic`
 * reads an ABSENT `User-Agent` as `bot`, and a file that never sent one would
 * have proven the bot path everywhere and the human path nowhere.
 */
async function drive(input: DriveInput): Promise<OutboundRedirectDecision> {
  const token =
    input.token ??
    mintAffiliateOutboundToken({ offerId: input.offerId ?? 'no-offer-id-supplied' });
  return resolveOutboundRedirect(
    {
      token,
      trafficSignals: {
        userAgent: input.userAgent ?? HUMAN_USER_AGENT,
        ...(input.purposeHeaders === undefined ? {} : { purposeHeaders: input.purposeHeaders }),
      },
      clientSurface: 'web',
      consentMode: 'granted',
    },
    input.now ?? new Date(),
    db,
  );
}

/**
 * Narrow to the redirect branch, or fail NAMING the refusal.
 *
 * A helper rather than an `expect`, because `expect()` is untyped: reading
 * `decision.url` after `expect(decision.outcome).toBe('redirect')` does not
 * narrow the union and `tsc` would reject every assertion that followed.
 */
function redirected(
  decision: OutboundRedirectDecision,
): Extract<OutboundRedirectDecision, { outcome: 'redirect' }> {
  if (decision.outcome !== 'redirect') {
    throw new Error(`expected a redirect, got a refusal: ${decision.reason}`);
  }
  return decision;
}

/** The mirror image, so a refusal case cannot pass by having redirected. */
function refused(
  decision: OutboundRedirectDecision,
): Extract<OutboundRedirectDecision, { outcome: 'refused' }> {
  if (decision.outcome !== 'refused') {
    throw new Error(`expected a refusal, got a redirect to ${decision.destinationHost}`);
  }
  return decision;
}

/* -------------------------------------------------------------------------- */
/*  Proof 1 — the redirect is not an open redirect (acceptance 1)              */
/* -------------------------------------------------------------------------- */

describe('acceptance 1 — a destination is admitted, never trusted', () => {
  it('refuses a host on no allow-list, and admits the SAME offer once an operator approves it', async () => {
    const source = await bringUpSource('allowlist');
    const host = `shop-allowlist-${RUN}.test`;
    const offerId = await seedOffer(source, {
      label: 'allowlist',
      destinationUrl: `https://${host}/item/1`,
    });

    /*
     * The offer is PERFECTLY HEALTHY at this point — active, current, its
     * source displaying and permitted to link out — so the only thing standing
     * between a visitor and that host is the allow-list. That is the whole
     * claim of acceptance 1, and it is why the approval below is the control:
     * without it a refusal here would be indistinguishable from a fixture that
     * was broken in some other way.
     */
    const before = refused(await drive({ offerId }));
    expect(before.reason).toBe('destination_host_not_allowlisted');

    const approved = await approveOutboundHost({
      catalogSourceId: source.sourceId,
      host,
      kind: 'merchant_site',
      reason: 'outbound realdb suite: the merchant this source sells',
      approvedByOxyUserId: OPERATOR,
    });
    expect(approved).toBeDefined();

    const after = redirected(await drive({ offerId }));
    expect(after.url).toBe(`https://${host}/item/1`);
    expect(after.destinationHost).toBe(host);
    expect(after.destinationKind).toBe('merchant_site');
  });

  it('refuses http, credentials in the authority, an unparseable value and a Mercaria host', async () => {
    const source = await bringUpSource('scheme');
    const host = `shop-scheme-${RUN}.test`;
    // Approved, so every refusal below is about the URL rather than about the
    // host being unknown — the vacuity control for this whole case.
    await approveOutboundHost({
      catalogSourceId: source.sourceId,
      host,
      kind: 'merchant_site',
      reason: 'outbound realdb suite: approved so the refusals below are not about admission',
      approvedByOxyUserId: OPERATOR,
    });

    const cases = [
      { label: 'http', url: `http://${host}/item`, reason: 'destination_scheme_not_https' },
      {
        label: 'credentials',
        url: `https://user:pass@${host}/item`,
        reason: 'destination_credentials_present',
      },
      { label: 'unparseable', url: 'not a url at all', reason: 'destination_unparseable' },
      {
        // Requirement 10's redirect loop, and it is checked BEFORE the
        // allow-list: an operator who approved a Mercaria host by mistake must
        // not thereby create one.
        label: 'mercaria',
        url: 'https://mercaria.co/out/anything',
        reason: 'destination_is_mercaria',
      },
    ] as const;

    for (const testCase of cases) {
      const offerId = await seedOffer(source, {
        label: testCase.label,
        destinationUrl: testCase.url,
      });
      const decision = refused(await drive({ offerId }));
      expect(decision.reason, `for the ${testCase.label} destination`).toBe(testCase.reason);
    }

    // The positive control for the loop above: the approved host on a
    // well-formed https URL still redirects, so the four refusals are not a
    // source that had quietly stopped permitting anything.
    const healthyOfferId = await seedOffer(source, {
      label: 'scheme-control',
      destinationUrl: `https://${host}/item/ok`,
    });
    expect(redirected(await drive({ offerId: healthyOfferId })).destinationHost).toBe(host);
  });
});

/* -------------------------------------------------------------------------- */
/*  Proof 2 — the suffix attack, in BOTH directions                            */
/* -------------------------------------------------------------------------- */

describe('acceptance 1 — an approved host admits that host and no neighbour of it', () => {
  /**
   * The single most important case in this file, and it needs TWO host shapes
   * because they defeat DIFFERENT wrong implementations.
   *
   * `example.com.evil.test` is the attacker appending to the approved name. It
   * defeats `startsWith` and `includes`, and it is the shape `destination.ts`'
   * own docblock names.
   *
   * `notexample.com` is the attacker PREPENDING to it, and it is the one that
   * matters for the check the module actually warns about: under
   * `host.endsWith(approved.host)` the FIRST shape is still refused — a string
   * ending in `.evil.test` does not end in `example.com` — so a file carrying
   * only that case would stay green against exactly the mutation the comment
   * says it is defending against. Both are asserted, and the second is what
   * the mutation test drives.
   */
  it('refuses both the appended and the prepended neighbour of an approved host', async () => {
    const source = await bringUpSource('suffix');
    const approvedHost = `example-${RUN}.test`;
    await approveOutboundHost({
      catalogSourceId: source.sourceId,
      host: approvedHost,
      kind: 'merchant_site',
      reason: 'outbound realdb suite: the one host this source may reach',
      approvedByOxyUserId: OPERATOR,
    });

    // The approved host itself redirects. Without this the two refusals below
    // would also be produced by an allow-list that admitted nothing at all.
    const exactOfferId = await seedOffer(source, {
      label: 'suffix-exact',
      destinationUrl: `https://${approvedHost}/x`,
    });
    expect(redirected(await drive({ offerId: exactOfferId })).destinationHost).toBe(approvedHost);

    const appendedOfferId = await seedOffer(source, {
      label: 'suffix-appended',
      destinationUrl: `https://${approvedHost}.evil.test/x`,
    });
    expect(refused(await drive({ offerId: appendedOfferId })).reason).toBe(
      'destination_host_not_allowlisted',
    );

    const prependedOfferId = await seedOffer(source, {
      label: 'suffix-prepended',
      destinationUrl: `https://not${approvedHost}/x`,
    });
    expect(refused(await drive({ offerId: prependedOfferId })).reason).toBe(
      'destination_host_not_allowlisted',
    );
  });

  it('an approval is scoped to ONE source and reaches no other', async () => {
    const owner = await bringUpSource('scope-owner');
    const stranger = await bringUpSource('scope-stranger');
    const host = `shared-${RUN}.test`;
    await approveOutboundHost({
      catalogSourceId: owner.sourceId,
      host,
      kind: 'merchant_site',
      reason: 'outbound realdb suite: approved for ONE source',
      approvedByOxyUserId: OPERATOR,
    });

    const ownerOfferId = await seedOffer(owner, {
      label: 'scope-owner',
      destinationUrl: `https://${host}/x`,
    });
    expect(redirected(await drive({ offerId: ownerOfferId })).destinationHost).toBe(host);

    // Same host, different source. Approving a host for one advertiser must not
    // approve it for the marketplace.
    const strangerOfferId = await seedOffer(stranger, {
      label: 'scope-stranger',
      destinationUrl: `https://${host}/x`,
    });
    expect(refused(await drive({ offerId: strangerOfferId })).reason).toBe(
      'destination_host_not_allowlisted',
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Proof 3 — a native offer never enters the outbound path (acceptance 6)     */
/* -------------------------------------------------------------------------- */

describe('acceptance 6 — a native offer never enters the outbound path', () => {
  /** A store, a listing and a product variant — what a native offer must point at. */
  async function mintNativeSubject(label: string): Promise<{
    canonicalVariantId: string;
    productVariantId: string;
    listingId: string;
  }> {
    const [store] = await db
      .insert(schema.stores)
      .values({
        handle: `outb-${label}-${RUN}`,
        name: `Outbound store ${label} ${RUN}`,
        description: '',
        brandColor: '#000000',
      })
      .returning({ id: schema.stores.id });
    if (!store) throw new Error('the store was not written');
    createdStoreIds.push(store.id);

    const [listing] = await db
      .insert(schema.listings)
      .values({
        ownerType: 'store',
        storeId: store.id,
        title: `Outbound listing ${label} ${RUN}`,
        description: 'a listing under test',
        condition: 'new',
        conditionAssertion: 'seller_declared',
        status: 'active',
      })
      .returning({ id: schema.listings.id });
    if (!listing) throw new Error('the listing was not written');
    createdListingIds.push(listing.id);

    const [variant] = await db
      .insert(schema.productVariants)
      .values({
        listingId: listing.id,
        title: 'Default Title',
        priceAmount: 119_900,
        priceCurrency: 'EUR',
        inventoryTracked: true,
        inventoryAvailable: 5,
      })
      .returning({ id: schema.productVariants.id });
    if (!variant) throw new Error('the product variant was not written');

    return {
      canonicalVariantId: await mintCanonicalVariant(label),
      productVariantId: variant.id,
      listingId: listing.id,
    };
  }

  it('the CHECK refuses a native offer carrying a destination at all — the structural half', async () => {
    const subject = await mintNativeSubject('native-check');
    const now = new Date();
    const base = {
      kind: 'native' as const,
      ...declaredOfferCondition('new'),
      canonicalVariantId: subject.canonicalVariantId,
      productVariantId: subject.productVariantId,
      listingId: subject.listingId,
      observedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      staleAt: new Date(now.getTime() + 86_400_000),
    };

    /*
     * This is the half of requirement 6 that no service can undo. There is no
     * id a native offer could carry that a redirect could resolve, because the
     * COLUMN cannot hold one — against every writer, `psql` included.
     */
    const message = await rejectionMessage(() =>
      db
        .insert(schema.offers)
        .values({ ...base, destinationUrl: `https://native-${RUN}.test/x` }),
    );
    expect(message).toContain('offers_kind_shape_check');

    // And the well-formed native offer is accepted, so the refusal above is not
    // a CHECK that refuses every native offer.
    const [written] = await db
      .insert(schema.offers)
      .values(base)
      .returning({ id: schema.offers.id, destinationUrl: schema.offers.destinationUrl });
    if (!written) throw new Error('the native offer was not written');
    createdOfferIds.push(written.id);
    expect(written.destinationUrl).toBeNull();
  });

  it('the service answers native_offer BY NAME, and records the click', async () => {
    const subject = await mintNativeSubject('native-service');
    const now = new Date();
    const [written] = await db
      .insert(schema.offers)
      .values({
        kind: 'native',
        ...declaredOfferCondition('new'),
        canonicalVariantId: subject.canonicalVariantId,
        productVariantId: subject.productVariantId,
        listingId: subject.listingId,
        observedAt: now,
        firstSeenAt: now,
        lastSeenAt: now,
        staleAt: new Date(now.getTime() + 86_400_000),
      })
      .returning({ id: schema.offers.id });
    if (!written) throw new Error('the native offer was not written');
    createdOfferIds.push(written.id);

    /*
     * `native_offer` and not `no_destination`, which is what #68's gate would
     * have said. They are different bugs with different fixes — "somebody
     * linked a native offer here" against "this offer has no destination" —
     * and the explicit branch exists to keep the operator trace able to tell
     * them apart.
     */
    const decision = refused(await drive({ offerId: written.id }));
    expect(decision.reason).toBe('native_offer');

    const clicks = await listAffiliateOutboundClicksForOffer({ offerId: written.id, limit: 10 }, db);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.refusalReason).toBe('native_offer');
    expect(clicks[0]?.destinationHost).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  Proof 4 — the click record, on both paths                                  */
/* -------------------------------------------------------------------------- */

describe('the click record is written on BOTH paths', () => {
  it('records a redirect with its destination and a refusal with its reason', async () => {
    const source = await bringUpSource('click');
    const host = `shop-click-${RUN}.test`;

    const refusedOfferId = await seedOffer(source, {
      label: 'click-refused',
      destinationUrl: `https://${host}/item`,
      country: 'ES',
    });
    const refusal = refused(await drive({ offerId: refusedOfferId }));
    expect(refusal.reason).toBe('destination_host_not_allowlisted');
    if (refusal.clickId === undefined) throw new Error('a refusal past the token must record a click');

    const refusalRow = await findAffiliateOutboundClickById(refusal.clickId, db);
    expect(refusalRow?.disposition).toBe('refused');
    expect(refusalRow?.refusalReason).toBe('destination_host_not_allowlisted');
    expect(refusalRow?.destinationHost).toBeNull();
    expect(refusalRow?.destinationKind).toBeNull();
    // From the OFFER, never from the caller: a header a client controls is not
    // a fact about where the offer is sold.
    expect(refusalRow?.market).toBe('ES');
    expect(refusalRow?.catalogSourceId).toBe(source.sourceId);
    expect(refusalRow?.merchantId).toBe(source.merchantId);
    expect(refusalRow?.trafficClass).toBe('organic');
    expect(refusalRow?.trafficSignal).toBe('no_automation_signal');
    expect(refusalRow?.consentMode).toBe('granted');

    await approveOutboundHost({
      catalogSourceId: source.sourceId,
      host,
      kind: 'merchant_site',
      reason: 'outbound realdb suite: the redirected half of the click record',
      approvedByOxyUserId: OPERATOR,
    });
    const redirectOfferId = await seedOffer(source, {
      label: 'click-redirected',
      destinationUrl: `https://${host}/item/2`,
      country: 'ES',
    });
    const success = redirected(await drive({ offerId: redirectOfferId }));
    const successRow = await findAffiliateOutboundClickById(success.clickId, db);
    expect(successRow?.disposition).toBe('redirected');
    expect(successRow?.refusalReason).toBeNull();
    expect(successRow?.destinationHost).toBe(host);
    expect(successRow?.destinationKind).toBe('merchant_site');
  });

  it('the outcome-shape CHECK refuses a redirect with a reason and a refusal with a destination', async () => {
    const source = await bringUpSource('outcome-shape');
    const offerId = await seedOffer(source, {
      label: 'outcome-shape',
      destinationUrl: `https://shop-outcome-${RUN}.test/x`,
    });
    const now = new Date();
    const base = {
      offerId,
      clientSurface: 'web' as const,
      trafficClass: 'organic' as const,
      trafficSignal: 'no_automation_signal',
      consentMode: 'granted' as const,
      occurredAt: now,
      retentionExpiresAt: new Date(now.getTime() + 86_400_000),
    };

    /*
     * TWO biconditionals rather than one over their conjunction. The obvious
     * single-predicate spelling is SATISFIED by a row that is neither — both
     * sides evaluate false — which admits exactly the row this refuses. The
     * two statements below are the two halves, and each must name the same
     * constraint.
     */
    const redirectWithReason = await rejectionMessage(() =>
      db.insert(schema.affiliateOutboundClicks).values({
        ...base,
        disposition: 'redirected',
        destinationHost: 'shop.example.test',
        destinationKind: 'merchant_site',
        refusalReason: 'offer_retired',
      }),
    );
    expect(redirectWithReason).toContain('affiliate_outbound_clicks_outcome_shape_check');

    const refusalWithHost = await rejectionMessage(() =>
      db.insert(schema.affiliateOutboundClicks).values({
        ...base,
        disposition: 'refused',
        refusalReason: 'offer_retired',
        destinationHost: 'shop.example.test',
      }),
    );
    expect(refusalWithHost).toContain('affiliate_outbound_clicks_outcome_shape_check');

    // Both well-formed shapes ARE accepted, so the CHECK is not one that
    // refuses every click row.
    const [okRedirect] = await db
      .insert(schema.affiliateOutboundClicks)
      .values({
        ...base,
        disposition: 'redirected',
        destinationHost: 'shop.example.test',
        destinationKind: 'merchant_site',
      })
      .returning({ id: schema.affiliateOutboundClicks.id });
    const [okRefusal] = await db
      .insert(schema.affiliateOutboundClicks)
      .values({ ...base, disposition: 'refused', refusalReason: 'offer_retired' })
      .returning({ id: schema.affiliateOutboundClicks.id });
    expect(okRedirect).toBeDefined();
    expect(okRefusal).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  Proof 5 — the click row is immutable, and deletable                        */
/* -------------------------------------------------------------------------- */

describe('the click row is immutable by trigger and deletable by design', () => {
  it('refuses an UPDATE and permits a DELETE', async () => {
    const source = await bringUpSource('immutable');
    const offerId = await seedOffer(source, {
      label: 'immutable',
      destinationUrl: `https://shop-immutable-${RUN}.test/x`,
    });
    const decision = refused(await drive({ offerId }));
    if (decision.clickId === undefined) throw new Error('the refusal recorded no click');
    const clickId = decision.clickId;

    /*
     * UPDATE raises. Nothing about a request that already happened can change,
     * and the trigger is what makes that true of a hand-written statement as
     * well as of the repository, which offers no update to call.
     */
    const message = await rejectionMessage(() =>
      db
        .update(schema.affiliateOutboundClicks)
        .set({ refusalReason: 'offer_retired' })
        .where(eq(schema.affiliateOutboundClicks.id, clickId)),
    );
    expect(message).toContain('affiliate_outbound_clicks is immutable');

    // Still exactly as written — a trigger that raised AFTER applying the row
    // would leave the same error and a changed row.
    const unchanged = await findAffiliateOutboundClickById(clickId, db);
    expect(unchanged?.refusalReason).toBe('destination_host_not_allowlisted');

    /*
     * DELETE succeeds, DELIBERATELY, and this half is the one worth asserting:
     * `affiliate_outbound_clicks` is registered in `EXPIRY_TARGETS`, so a
     * trigger extended to refuse DELETE would make the shared retention sweep
     * fail SILENTLY on every row it is obliged to remove — the
     * `analytics_events` posture, and the reason this table inverts the
     * append-only stance its two siblings take.
     */
    await db
      .delete(schema.affiliateOutboundClicks)
      .where(eq(schema.affiliateOutboundClicks.id, clickId));
    expect(await findAffiliateOutboundClickById(clickId, db)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  Proof 6 — bots are redirected and not attributed (acceptance 3)            */
/* -------------------------------------------------------------------------- */

describe('acceptance 3 — a classification decides whether a click COUNTS, never where it goes', () => {
  it('redirects a bot and a preview to the same place and excludes both from human counts', async () => {
    const source = await bringUpSource('traffic');
    const host = `shop-traffic-${RUN}.test`;
    await approveOutboundHost({
      catalogSourceId: source.sourceId,
      host,
      kind: 'merchant_site',
      reason: 'outbound realdb suite: traffic classification',
      approvedByOxyUserId: OPERATOR,
    });
    const destinationUrl = `https://${host}/item/traffic`;
    const offerId = await seedOffer(source, {
      label: 'traffic',
      destinationUrl,
      // The scoping handle for the aggregate below. See its constant.
      network: TRAFFIC_NETWORK,
      country: 'ES',
    });

    const at = new Date();
    const organic = redirected(await drive({ offerId, now: at }));
    const bot = redirected(await drive({ offerId, now: at, userAgent: BOT_USER_AGENT }));
    const preview = redirected(
      await drive({ offerId, now: at, purposeHeaders: { 'sec-purpose': 'prefetch' } }),
    );

    /*
     * All three REDIRECT, to the byte-identical URL. Varying the destination by
     * user agent is cloaking, and it is the one thing a classifier must never
     * be able to do — which is why #143's verdict is computed and then used
     * only to fill a column.
     */
    for (const decision of [organic, bot, preview]) {
      expect(decision.url).toBe(destinationUrl);
      expect(decision.destinationHost).toBe(host);
    }
    expect(organic.trafficClass).toBe('organic');
    expect(bot.trafficClass).toBe('bot');
    expect(preview.trafficClass).toBe('preview');

    // The stored class, not just the returned one — the column is what a
    // report reads.
    const stored = await listAffiliateOutboundClicksForOffer({ offerId, limit: 20 }, db);
    expect(stored).toHaveLength(3);
    expect(stored.map((row) => row.trafficClass).sort()).toEqual(['bot', 'organic', 'preview']);
    // A bounded signal enum and never the header that produced it: copying a
    // `User-Agent` into a row is how an unbounded identifying blob enters a
    // domain whose whole design is that it holds none.
    expect(stored.map((row) => row.trafficSignal).sort()).toEqual([
      'automated_user_agent',
      'no_automation_signal',
      'purpose_header',
    ]);
    for (const row of stored) {
      expect(row.trafficSignal).not.toContain('Googlebot');
      expect(row.trafficSignal).not.toContain('Mozilla');
    }

    /*
     * The one AGGREGATE in this file, scoped by the run-unique network. The
     * equality is paired with a floor, because `1 === 1` and `0 === 0` read the
     * same and a window that matched nothing would satisfy an equality against
     * zero.
     */
    const totals = await countAffiliateOutboundClicks(
      {
        from: new Date(at.getTime() - 60_000),
        to: new Date(at.getTime() + 60_000),
        affiliateNetwork: TRAFFIC_NETWORK,
      },
      db,
    );
    expect(totals.humanClicks).toBeGreaterThan(0);
    expect(totals.humanClicks).toBe(1);
    expect(totals.nonHumanClicks).toBe(2);
    expect(totals.refusedClicks).toBe(0);
    expect(totals.humanClicks + totals.nonHumanClicks).toBe(stored.length);
  });
});

/* -------------------------------------------------------------------------- */
/*  Proof 7 — a WITHDRAWN outbound_link right refuses (#67's live check)       */
/* -------------------------------------------------------------------------- */

describe("#67's live rights check — a withdrawn outbound_link right refuses", () => {
  /**
   * The case that did not exist before #67.
   *
   * The offer's KIND was derived from the `outbound_link` right at INGESTION
   * time, so a source that never granted it produces nothing to redirect to.
   * What that leaves uncovered is exactly this: a source that GRANTED the
   * right, produced `affiliate` offers with destinations, and then published a
   * new policy version WITHDRAWING it. Those rows keep their kind and their
   * destination until they are re-ingested, and before #67 the gate would have
   * handed a visitor to a merchant whose contract no longer permitted it.
   *
   * `may_display` deliberately stays TRUE across the withdrawal, so the refusal
   * cannot come from the coarse projection the gate already read. The right
   * being withdrawn is the narrow one, alone.
   */
  it('the same offer, unchanged, refuses once a new active policy withdraws may_link_out', async () => {
    const source = await bringUpSource('rights');
    const host = `shop-rights-${RUN}.test`;
    await approveOutboundHost({
      catalogSourceId: source.sourceId,
      host,
      kind: 'merchant_site',
      reason: 'outbound realdb suite: rights withdrawal',
      approvedByOxyUserId: OPERATOR,
    });
    const offerId = await seedOffer(source, {
      label: 'rights',
      destinationUrl: `https://${host}/item`,
    });

    // It redirects first. Without this the refusal below would be satisfied by
    // any fixture that never worked.
    expect(redirected(await drive({ offerId })).destinationHost).toBe(host);

    await publishIngestionSourcePolicy({
      sourceId: source.sourceId,
      reviewedByOxyUserId: OPERATOR,
      ...FULL_RIGHTS,
      mayLinkOut: false,
      // `mayAppendAffiliateParams` needs an outbound link to be appended to;
      // the service refuses the combination in words, and the CHECK refuses it
      // at the row.
      mayAppendAffiliateParams: false,
    });

    const decision = refused(await drive({ offerId }));
    expect(decision.reason).toBe('outbound_not_permitted');

    // The offer itself is untouched: still active, still carrying its
    // destination. The refusal is a fact about the SOURCE's live contract, and
    // reading it off a copy on the offer is exactly what this check replaces.
    const offer = await findOfferById(db, offerId);
    expect(offer?.status).toBe('active');
    expect(offer?.destinationUrl).toBe(`https://${host}/item`);
    // And `may_display` never moved, so the earlier coarse check cannot be what
    // refused.
    const [projection] = await db
      .select({ mayDisplay: schema.catalogSources.mayDisplay })
      .from(schema.catalogSources)
      .where(eq(schema.catalogSources.id, source.sourceId))
      .limit(1);
    expect(projection?.mayDisplay).toBe(true);
  });

  /*
   * The MIRROR of the case above, and it was the untested half.
   *
   * `assertOfferOutboundEligible` refuses on two independent branches that
   * share one reason code: the COARSE `may_display` projection ("may this offer
   * be shown at all") and the NARROW `outbound_link` right ("may Mercaria send
   * somebody to it"). Because the reason is the same string, a suite carrying
   * only one of them cannot distinguish a gate that reads both from a gate that
   * reads one and returns — the two cases have to isolate opposite halves.
   *
   * So this one withdraws `may_display` and leaves `may_link_out` GRANTED,
   * exactly inverting its sibling, which withdraws `may_link_out` and asserts
   * `may_display` never moved. Only `may_display_price` and `may_display_media`
   * come with it, because
   * `catalog_source_policies_display_implication_check` requires it — showing a
   * price or an image is a way of displaying. Nothing ties `may_link_out` to
   * `may_display`, which is what makes the isolation available at all.
   */
  it('the same offer, unchanged, refuses once a new active policy withdraws may_display', async () => {
    const source = await bringUpSource('display');
    const host = `shop-display-${RUN}.test`;
    await approveOutboundHost({
      catalogSourceId: source.sourceId,
      host,
      kind: 'merchant_site',
      reason: 'outbound realdb suite: display withdrawal',
      approvedByOxyUserId: OPERATOR,
    });
    const offerId = await seedOffer(source, {
      label: 'display',
      destinationUrl: `https://${host}/item`,
    });

    // The positive control. Without it the refusal below is satisfied by any
    // fixture that never redirected in the first place.
    expect(redirected(await drive({ offerId })).destinationHost).toBe(host);

    await publishIngestionSourcePolicy({
      sourceId: source.sourceId,
      reviewedByOxyUserId: OPERATOR,
      ...FULL_RIGHTS,
      mayDisplay: false,
      mayDisplayPrice: false,
      mayDisplayMedia: false,
    });

    expect(refused(await drive({ offerId })).reason).toBe('outbound_not_permitted');

    // `may_link_out` is still GRANTED, so the narrow branch cannot be what
    // refused — the coarse projection is, on its own.
    const [policy] = await db
      .select({ mayLinkOut: schema.catalogSourcePolicies.mayLinkOut })
      .from(schema.catalogSourcePolicies)
      .where(
        and(
          eq(schema.catalogSourcePolicies.sourceId, source.sourceId),
          eq(schema.catalogSourcePolicies.status, 'active'),
        ),
      )
      .limit(1);
    expect(policy?.mayLinkOut).toBe(true);

    // The offer is untouched — the refusal is a fact about the SOURCE's live
    // contract, re-read per click, with no sweep having run.
    const offer = await findOfferById(db, offerId);
    expect(offer?.status).toBe('active');
    expect(offer?.destinationUrl).toBe(`https://${host}/item`);
  });
});

/* -------------------------------------------------------------------------- */
/*  Proof 8 — #68's gate: a retired offer and a stale one                      */
/* -------------------------------------------------------------------------- */

describe("#68's gate — a retired or stale offer refuses before any destination is read", () => {
  it('a retired offer refuses offer_retired', async () => {
    const source = await bringUpSource('retired');
    const host = `shop-retired-${RUN}.test`;
    await approveOutboundHost({
      catalogSourceId: source.sourceId,
      host,
      kind: 'merchant_site',
      reason: 'outbound realdb suite: retirement',
      approvedByOxyUserId: OPERATOR,
    });
    const offerId = await seedOffer(source, {
      label: 'retired',
      destinationUrl: `https://${host}/item`,
    });
    expect(redirected(await drive({ offerId })).destinationHost).toBe(host);

    const retired = await retireOffers(db, [offerId], 'source_disappeared', new Date());
    expect(retired).toBe(1);

    expect(refused(await drive({ offerId })).reason).toBe('offer_retired');
  });

  it('a stale offer refuses offer_not_current', async () => {
    const source = await bringUpSource('stale');
    const host = `shop-stale-${RUN}.test`;
    await approveOutboundHost({
      catalogSourceId: source.sourceId,
      host,
      kind: 'merchant_site',
      reason: 'outbound realdb suite: staleness',
      approvedByOxyUserId: OPERATOR,
    });
    const offerId = await seedOffer(source, {
      label: 'stale',
      destinationUrl: `https://${host}/item`,
    });
    expect(redirected(await drive({ offerId })).destinationHost).toBe(host);

    /*
     * A FUTURE clock rather than a back-dated row.
     *
     * #68 runs its deadlines from the last CHECK (`last_seen_at`), not the last
     * CHANGE, and `recordExternalOffer` stamps `last_seen_at` from
     * `max(now, observedAt)` — so back-dating `observed_at` leaves the offer
     * perfectly current and would make this case measure nothing. The source's
     * freshness TTL is 3600s, so a click three hours later is unambiguously
     * past the lifetime, whichever of #68's four layers resolved it.
     *
     * The clock is passed only to this resolution, so nothing else in this file
     * or any sibling is measured against it.
     */
    const wayLater = new Date(Date.now() + 3 * 3_600_000);
    expect(refused(await drive({ offerId, now: wayLater })).reason).toBe('offer_not_current');
  });
});

/* -------------------------------------------------------------------------- */
/*  Proof 9 — the token                                                        */
/* -------------------------------------------------------------------------- */

describe('the token names an offer and cannot name anything else', () => {
  it('a tampered signature, a foreign prefix and a malformed token all refuse token_invalid and record NOTHING', async () => {
    const source = await bringUpSource('token');
    const host = `shop-token-${RUN}.test`;
    await approveOutboundHost({
      catalogSourceId: source.sourceId,
      host,
      kind: 'merchant_site',
      reason: 'outbound realdb suite: token verification',
      approvedByOxyUserId: OPERATOR,
    });
    const offerId = await seedOffer(source, {
      label: 'token',
      destinationUrl: `https://${host}/item`,
    });

    const valid = mintAffiliateOutboundToken({ offerId });
    expect(valid.startsWith(AFFILIATE_OUTBOUND_TOKEN_PREFIX)).toBe(true);
    expect(redirected(await drive({ offerId, token: valid })).destinationHost).toBe(host);

    const clicksBefore = await listAffiliateOutboundClicksForOffer({ offerId, limit: 50 }, db);
    expect(clicksBefore.length).toBeGreaterThan(0);

    const [payload, signature] = valid.slice(AFFILIATE_OUTBOUND_TOKEN_PREFIX.length).split('.');
    if (payload === undefined || signature === undefined) {
      throw new Error('a minted token is not `<payload>.<signature>`');
    }
    // One character, so the payload still decodes to a real offer id and the
    // ONLY thing wrong is the signature.
    const tamperedSignature = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;

    const bad = [
      {
        label: 'tampered signature',
        token: `${AFFILIATE_OUTBOUND_TOKEN_PREFIX}${payload}.${tamperedSignature}`,
      },
      // A `mgs_` cart credential presented here. #108's rule about keeping two
      // credential kinds structurally apart: it fails on its SPELLING, before
      // any hashing.
      { label: 'foreign prefix', token: `mgs_${payload}.${signature}` },
      { label: 'no separator', token: `${AFFILIATE_OUTBOUND_TOKEN_PREFIX}${payload}${signature}` },
      { label: 'empty payload', token: AFFILIATE_OUTBOUND_TOKEN_PREFIX },
    ] as const;

    for (const testCase of bad) {
      const decision = refused(await drive({ token: testCase.token }));
      /*
       * ONE reason for all four. Answering differently for "malformed" than for
       * "bad signature" tells somebody probing the route which half they got
       * right.
       */
      expect(decision.reason, `for the ${testCase.label}`).toBe('token_invalid');
      // And NO click row: there is no offer to attribute one to, so a bad token
      // must not be able to grow this table.
      expect(decision.clickId, `for the ${testCase.label}`).toBeUndefined();
    }

    const clicksAfter = await listAffiliateOutboundClicksForOffer({ offerId, limit: 50 }, db);
    expect(clicksAfter.length).toBe(clicksBefore.length);
  });

  it('a token minted for one offer never resolves to another', async () => {
    const source = await bringUpSource('token-cross');
    const hostA = `shop-a-${RUN}.test`;
    const hostB = `shop-b-${RUN}.test`;
    for (const host of [hostA, hostB]) {
      await approveOutboundHost({
        catalogSourceId: source.sourceId,
        host,
        kind: 'merchant_site',
        reason: 'outbound realdb suite: cross-offer token resolution',
        approvedByOxyUserId: OPERATOR,
      });
    }
    const offerA = await seedOffer(source, {
      label: 'token-a',
      destinationUrl: `https://${hostA}/item`,
    });
    const offerB = await seedOffer(source, {
      label: 'token-b',
      destinationUrl: `https://${hostB}/item`,
    });

    const decision = redirected(await drive({ offerId: offerA }));
    expect(decision.destinationHost).toBe(hostA);
    expect(decision.destinationHost).not.toBe(hostB);

    const row = await findAffiliateOutboundClickById(decision.clickId, db);
    expect(row?.offerId).toBe(offerA);
    // B was never touched — the token is the WHOLE of what selects an offer,
    // and it names exactly one.
    expect(await listAffiliateOutboundClicksForOffer({ offerId: offerB, limit: 10 }, db)).toHaveLength(
      0,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Proof 10 — the allow-list's own constraints                                */
/* -------------------------------------------------------------------------- */

describe('the allow-list is a bare hostname, attributably revoked, and re-approvable', () => {
  it('the shape CHECK refuses a scheme, an upper-case name, a wildcard and an empty host', async () => {
    const source = await bringUpSource('host-shape');
    const base = {
      catalogSourceId: source.sourceId,
      kind: 'merchant_site' as const,
      reason: 'outbound realdb suite: host shape',
      approvedByOxyUserId: OPERATOR,
    };

    /*
     * A stored `*.example.com` or `https://example.com/` would each require the
     * admission code to INTERPRET the row, and an allow-list that needs
     * interpreting is one whose meaning can drift from what the operator who
     * typed it believed.
     *
     * FOUR more shapes the constraint's own docblock claims are refused are NOT
     * asserted here, because they are MEASURED to be admitted. See the next
     * test, which is where they live until the defect is fixed.
     */
    const bad = [
      { label: 'scheme', host: `https://example-${RUN}.test` },
      { label: 'upper case', host: `Example-${RUN}.test` },
      { label: 'wildcard', host: `*.example-${RUN}.test` },
      { label: 'empty', host: '' },
    ] as const;

    for (const testCase of bad) {
      const message = await rejectionMessage(() =>
        db.insert(schema.affiliateOutboundHosts).values({ ...base, host: testCase.host }),
      );
      expect(message, `for the ${testCase.label} host`).toContain(
        'affiliate_outbound_hosts_shape_check',
      );
    }

    // The positive control: a bare lower-case hostname IS accepted, so the four
    // refusals above are not one CHECK refusing everything.
    const [good] = await db
      .insert(schema.affiliateOutboundHosts)
      .values({ ...base, host: `shop.example-${RUN}.test` })
      .returning({ id: schema.affiliateOutboundHosts.id });
    expect(good).toBeDefined();
  });

  /**
   * The shape CHECK refuses a path, a port, userinfo and a SINGLE LABEL.
   *
   * ## This test was a characterization test, and it did its job
   *
   * It shipped asserting the OPPOSITE — that all four shapes were ADMITTED —
   * because they were. `db/schema/affiliateOutbound.ts` wrote the predicate
   * inside a tagged TEMPLATE LITERAL as `(\.[a-z0-9]…)`, and `\.` is not a
   * recognised JavaScript escape, so the backslash was cooked away before
   * drizzle ever saw the string. What reached Postgres was `(.[a-z0-9]…)`,
   * where `.` matches ANY character.
   *
   * Nothing in the build could see it: `tsc` type-checks a template literal,
   * drizzle-kit renders whatever string it is handed, and the migration applies
   * cleanly. Only a real server, asked for a REFUSAL, could.
   *
   * Its stated retirement condition was "when the fix lands this goes RED".
   * It did, and this is the promotion: the four cases now assert the REFUSAL
   * they always belonged to.
   *
   * ## Why `localhost` is the one that mattered
   *
   * Three of the four were stored-but-dead: `admitOutboundDestination` compares
   * a parsed `URL.hostname`, which can never contain `/`, `:` or `@`, so such a
   * row matched nothing and the failure direction was closed — though an
   * operator typing `example.com:443` still got a row that LOOKED approved and
   * a button that stayed silently dead.
   *
   * `localhost` was REACHABLE. A single-label internal name — `localhost`, a
   * container name, an intranet host — could be approved and then matched
   * EXACTLY by a feed row pointing at `https://localhost/…`. That is the class
   * of destination the dot-separated-tail rule exists to make unrepresentable,
   * in a domain whose whole premise is that an open redirect is unrepresentable
   * rather than checked.
   *
   * ## The fix is `[.]`, not `\\.`
   *
   * Both are correct today. A character class cannot be re-broken by an
   * escaping layer at all, while `\\.` is one careless "simplification" away
   * from becoming `\.` again — the identical defect, returning silently, with
   * every gate still green.
   */
  it('the shape CHECK refuses a path, a port, userinfo and a single label', async () => {
    const source = await bringUpSource('host-shape-strict');
    const base = {
      catalogSourceId: source.sourceId,
      kind: 'merchant_site' as const,
      reason: 'outbound realdb suite: host shape',
      approvedByOxyUserId: OPERATOR,
    };

    // The predicate itself, read off the LIVE constraint rather than inferred
    // from the source — which is the only reading that could have caught the
    // original defect, since the source and the shipped SQL disagreed.
    const [definition] = await db.execute<{ def: string }>(
      sql`select pg_get_constraintdef(oid) as def from pg_constraint
          where conname = 'affiliate_outbound_hosts_shape_check'`,
    );
    /*
     * A positive control on the OTHER conjunct of the same CHECK.
     *
     * `length(host)` is independent of the regex under test, so it proves the
     * constraint was actually READ rather than an empty row returned — where
     * `host ~` would disappear along with the very thing being asserted.
     *
     * The floor is not decoration. The tempting spelling is the negative
     * assertion alone (`not.toContain('(.[a-z0-9]')`), and that goes GREEN on a
     * missing row: it would have reported the `localhost` defect fixed while it
     * was still shipping. "X is absent" is also what a scan that read nothing
     * reports.
     *
     * `pg_get_constraintdef` renders bare column names, so the table name never
     * appears in `def` — an earlier floor asserting it failed on every server.
     * That failure was in the SAFE direction; this one cannot fail either way.
     */
    expect(definition?.def).toContain('length(host)');
    expect(definition?.def).toContain('([.][a-z0-9]');
    // ...and the cooked-away spelling must be gone. Without this the character
    // class could be reverted and only the four cases below would notice.
    expect(definition?.def).not.toContain('(.[a-z0-9]');

    // And the behaviour. Each of these MUST be refused.
    const refused = [
      { label: 'path', host: `example-${RUN}.test/deals` },
      { label: 'port', host: `example-${RUN}.test:443` },
      { label: 'userinfo', host: `user:pass@example-${RUN}.test` },
      { label: 'single label', host: `localhost${RUN}` },
    ] as const;

    for (const testCase of refused) {
      const message = await rejectionMessage(() =>
        db.insert(schema.affiliateOutboundHosts).values({ ...base, host: testCase.host }),
      );
      expect(message, `the ${testCase.label} host must be refused`).toContain(
        'affiliate_outbound_hosts_shape_check',
      );
    }

    // The vacuity floor: a predicate refusing EVERYTHING would pass every
    // assertion above. A real host is still admitted.
    const [ok] = await db
      .insert(schema.affiliateOutboundHosts)
      .values({ ...base, host: `shop-${RUN}.example.test` })
      .returning({ host: schema.affiliateOutboundHosts.host });
    expect(ok?.host).toBe(`shop-${RUN}.example.test`);
  });

  it('the revocation biconditional refuses a half-filled revocation', async () => {
    const source = await bringUpSource('revocation-shape');
    const base = {
      catalogSourceId: source.sourceId,
      kind: 'merchant_site' as const,
      reason: 'outbound realdb suite: revocation shape',
      approvedByOxyUserId: OPERATOR,
    };

    // A revocation is attributable, dated and explained, or it is not one
    // anybody can audit — and a LIVE row carrying any of the three would read
    // as one.
    const halves = [
      { label: 'dated but unattributed', values: { revokedAt: new Date() } },
      {
        label: 'dated and attributed but unexplained',
        values: { revokedAt: new Date(), revokedByOxyUserId: OPERATOR },
      },
      { label: 'explained but not dated', values: { revokedReason: 'a reason with no date' } },
    ] as const;

    for (const half of halves) {
      const message = await rejectionMessage(() =>
        db
          .insert(schema.affiliateOutboundHosts)
          .values({ ...base, host: `half-${RUN}.test`, ...half.values }),
      );
      expect(message, `for a revocation ${half.label}`).toContain(
        'affiliate_outbound_hosts_revocation_check',
      );
    }

    // The complete revocation IS accepted — the control that stops the three
    // refusals above passing against a CHECK that refuses every revoked row.
    const [complete] = await db
      .insert(schema.affiliateOutboundHosts)
      .values({
        ...base,
        host: `complete-${RUN}.test`,
        revokedAt: new Date(),
        revokedByOxyUserId: OPERATOR,
        revokedReason: 'outbound realdb suite: a complete revocation',
      })
      .returning({ id: schema.affiliateOutboundHosts.id });
    expect(complete).toBeDefined();
  });

  it('a host can be approved, revoked and approved AGAIN — the partial unique', async () => {
    const source = await bringUpSource('reapproval');
    const host = `rotating-${RUN}.test`;
    const approval = {
      catalogSourceId: source.sourceId,
      host,
      kind: 'merchant_site' as const,
      reason: 'outbound realdb suite: re-approval',
      approvedByOxyUserId: OPERATOR,
    };

    const first = await approveOutboundHost(approval, db);
    if (first === undefined) throw new Error('the first approval wrote no row');

    // `ON CONFLICT DO NOTHING RETURNING` against the LIVE partial unique: two
    // operators approving the same host converge on one row and the empty
    // result IS the "already approved" answer.
    expect(await approveOutboundHost(approval, db)).toBeUndefined();
    expect(await listApprovedOutboundHosts(source.sourceId, db)).toHaveLength(1);

    const revoked = await revokeOutboundHost(
      {
        id: first.id,
        revokedByOxyUserId: OPERATOR,
        revokedReason: 'outbound realdb suite: withdrawn, then reinstated',
      },
      db,
    );
    expect(revoked?.id).toBe(first.id);
    expect(await listApprovedOutboundHosts(source.sourceId, db)).toHaveLength(0);
    // A repeat converges rather than raising — the same answer shape as the
    // approval.
    expect(
      await revokeOutboundHost(
        { id: first.id, revokedByOxyUserId: OPERATOR, revokedReason: 'again' },
        db,
      ),
    ).toBeUndefined();

    /*
     * And now the property the PARTIAL predicate exists for: the same host is
     * approvable again. A plain `UNIQUE(source, host)` would forbid this
     * forever — and would not even converge two concurrent operators, since
     * Postgres treats NULLs as distinct.
     */
    const second = await approveOutboundHost(approval, db);
    if (second === undefined) throw new Error('a revoked host could not be approved again');
    expect(second.id).not.toBe(first.id);
    const live = await listApprovedOutboundHosts(source.sourceId, db);
    expect(live).toHaveLength(1);
    expect(live[0]?.host).toBe(host);

    // The revoked row is KEPT: an approval that was withdrawn is history
    // somebody may need to read during the incident that withdrew it.
    const all = await db
      .select({ id: schema.affiliateOutboundHosts.id })
      .from(schema.affiliateOutboundHosts)
      .where(eq(schema.affiliateOutboundHosts.catalogSourceId, source.sourceId));
    expect(all).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/*  Proof 11 — the disclosure names the MERCHANT, not the network              */
/* -------------------------------------------------------------------------- */

describe('the disclosure names the merchant while the redirect hands over the network link', () => {
  /**
   * The one place the two deliberately differ, and getting it backwards is a
   * real deception rather than a bug.
   *
   * #67 outbound rule 5 asks a page to name "the REAL DESTINATION MERCHANT". On
   * an Awin offer the URL actually handed over is `www.awin1.com/cread.php?…`
   * — the network's redirector, which is a hop rather than a shop — so
   * disclosing THAT would tell a shopper they are going to an affiliate network
   * they have never heard of, when the page they will land on is the
   * retailer's.
   *
   * A test that read only one of the two would pass with them swapped, which is
   * why both are asserted here against one offer.
   */
  it('discloses the retailer host and redirects through awin1.com', async () => {
    const source = await bringUpSource('disclosure');
    const retailerHost = `retailer-${RUN}.test`;
    const trackingTemplate = `https://www.awin1.com/cread.php?awinmid=1234&awinaffid=5678&ued=https%3A%2F%2F${retailerHost}%2Fp%2F1`;
    const offerId = await seedOffer(source, {
      label: 'disclosure',
      destinationUrl: `https://${retailerHost}/p/1`,
      // `awin` and not a run-scoped name: this case is precisely about the
      // NETWORK REDIRECTOR branch, whose hosts are a code constant
      // (`AWIN_TRACKING_HOSTS`) keyed on the network id. Nothing here is
      // asserted by a count, so sharing the value with a sibling costs nothing.
      network: 'awin',
      trackingTemplate,
    });

    const offer = await findOfferById(db, offerId);
    if (offer === undefined) throw new Error('the seeded offer was not readable');

    const disclosure = resolveOutboundDisclosure(offer);
    if (disclosure === undefined) {
      throw new Error(
        'the disclosure was absent — OUTBOUND_REDIRECT_ENABLED must be set before config loads',
      );
    }
    // The MERCHANT, from `destination_url`.
    expect(disclosure.destinationHost).toBe(retailerHost);
    expect(disclosure.destinationHost).not.toContain('awin1.com');
    // A Mercaria path and never the merchant's address, so a crawler scraping
    // the page cannot follow the tracked destination with no click record
    // behind it.
    expect(disclosure.redirectPath.startsWith(`/out/${AFFILIATE_OUTBOUND_TOKEN_PREFIX}`)).toBe(true);
    expect(disclosure.redirectPath).not.toContain(retailerHost);
    expect(disclosure.rel).toBe('sponsored nofollow noopener');

    /*
     * And the redirect hands over the NETWORK's own already-attributed link,
     * admitted as a `network_redirector` against the code constant rather than
     * against the allow-list — this source has approved nothing, which is what
     * makes that branch the only one that could have admitted it.
     */
    expect(await listApprovedOutboundHosts(source.sourceId, db)).toHaveLength(0);
    const decision = redirected(await drive({ offerId }));
    expect(decision.url).toBe(trackingTemplate);
    expect(decision.destinationHost).toBe('www.awin1.com');
    expect(decision.destinationKind).toBe('network_redirector');

    // Handed over VERBATIM. #65 and #66 both forbid composing or mutating an
    // affiliate link: a rebuilt one is indistinguishable from a working one
    // until a month of revenue is missing.
    expect(decision.url).toContain('awinmid=1234');
    expect(decision.url).toContain('awinaffid=5678');

    // The click names the HOST and never the URL — the tracked address can
    // carry a publisher credential in its path, and this table is read whole by
    // an operator surface.
    const row = await findAffiliateOutboundClickById(decision.clickId, db);
    expect(row?.destinationHost).toBe('www.awin1.com');
    expect(row?.affiliateNetwork).toBe('awin');
    expect(JSON.stringify(row)).not.toContain('cread.php');
  });
});

/* -------------------------------------------------------------------------- */
/*  The HTTP layer — the half `drive()` leaves out                             */
/* -------------------------------------------------------------------------- */

/*
 * Every case above resolves the DECISION and stops. That is deliberate and it
 * left one thing unmeasured: the response itself.
 *
 * Four properties live only in the controller and nowhere in the decision, and
 * each fails silently if it regresses. `X-Robots-Tag: noindex, nofollow` is
 * requirement 8's only guarantee that exists TODAY — the storefront renders a
 * `Pressable` rather than an anchor, so the `rel` on the DTO reaches no crawler
 * and this header is what keeps a monetised hop out of an index. `no-store`
 * stops a cached 302 from turning a revalidated redirect into a permanent one,
 * which would make every check this file proves inert after the first click.
 * `no-referrer` stops the merchant learning the token. And the refusal must be
 * ONE indistinguishable answer, or the route reports which offer ids exist.
 */
describe('the response itself — headers and the safe unavailable page', () => {
  function listen(): Promise<string> {
    return new Promise((resolve) => {
      const server = createApp().listen(0, '127.0.0.1', () => {
        servers.push(server);
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      });
    });
  }

  /** Follow nothing: the 302 itself is what is under test. */
  async function get(base: string, token: string): Promise<Response> {
    return await fetch(`${base}/out/${encodeURIComponent(token)}`, {
      redirect: 'manual',
      headers: { 'user-agent': HUMAN_USER_AGENT },
    });
  }

  it('302s to the stored destination and answers noindex, no-store, no-referrer', async () => {
    const source = await bringUpSource('response');
    const host = `shop-response-${RUN}.test`;
    await approveOutboundHost({
      catalogSourceId: source.sourceId,
      host,
      kind: 'merchant_site',
      reason: 'outbound realdb suite: the HTTP layer',
      approvedByOxyUserId: OPERATOR,
    });
    const offerId = await seedOffer(source, {
      label: 'response',
      destinationUrl: `https://${host}/item`,
    });

    const base = await listen();
    const response = await get(base, mintAffiliateOutboundToken({ offerId }));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`https://${host}/item`);
    // A monetised hop must never be indexed, and this is the ONLY crawler-facing
    // guarantee that exists while the storefront renders no anchor.
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    // A cached 302 would stop every later click reaching the row that decides:
    // a retired offer, a withdrawn right and a revoked host would all keep
    // working, and the click record would stop counting.
    expect(response.headers.get('cache-control')).toContain('no-store');
    // The merchant must not learn the token from a Referer header.
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  /*
   * The indistinguishability property, and the reason it needs BOTH halves.
   *
   * A garbage token is refused before any database read; a well-formed token
   * naming an offer that does not exist is refused after one. If those answered
   * differently — a different status, a different body, a different header — the
   * route would be an oracle for which offer ids exist, and `/out/` is public
   * and unauthenticated. Asserting one of them alone cannot see that.
   */
  it('answers ONE safe page for a malformed token and for an unknown offer alike', async () => {
    const base = await listen();

    const malformed = await get(base, 'not-a-token');
    const wrongPrefix = await get(base, 'mgs_pretending-to-be-a-cart-credential');
    const unknownOffer = await get(
      base,
      mintAffiliateOutboundToken({ offerId: `00000000-0000-7000-8000-${RUN.slice(0, 12)}` }),
    );

    for (const response of [malformed, wrongPrefix, unknownOffer]) {
      expect(response.status).toBe(404);
      expect(response.headers.get('location')).toBeNull();
    }

    const bodies = await Promise.all(
      [malformed, wrongPrefix, unknownOffer].map(async (r) => await r.text()),
    );
    // Byte-identical, so the difference is not readable from the response at
    // all — not from a status, not from a length, not from a word.
    expect(new Set(bodies).size).toBe(1);

    /*
     * The page carries one fixed sentence and no MACHINE-READABLE fact. It does
     * contain the word "offer" — "This offer is no longer available." is the
     * copy — and that is the point of asserting the specific leaks rather than
     * the word: the twelve refusal reasons are an accurate description of what
     * the server concluded, and publishing one would tell somebody probing the
     * route whether their token was merely unsigned or named a real offer.
     */
    const body = bodies[0] ?? '';
    for (const reason of OUTBOUND_REDIRECT_REFUSAL_REASONS) {
      expect(body).not.toContain(reason);
    }
    expect(body).not.toContain(RUN);
    expect(body).not.toContain(AFFILIATE_OUTBOUND_TOKEN_PREFIX);
  });
});
