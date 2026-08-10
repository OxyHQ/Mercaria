/**
 * The Express application, built without listening.
 *
 * Split from `index.ts` so the app can be constructed in a test WITHOUT opening a
 * port, connecting to Postgres or starting the socket server. That is not a
 * cosmetic split: the CrowdSource webhook's guarantee is that no body parser runs
 * before it, and the only honest way to assert that is to send a real request
 * through the REAL middleware chain and observe `req.body` inside a route on that
 * path. A test that rebuilt an app-shaped object of its own would prove something
 * about the test, not about production.
 *
 * `index.ts` owns the HTTP server, the socket server, the Postgres pool and the
 * background workers; this file owns only the middleware chain and the routes.
 */

import express from 'express';
import cors from 'cors';
import { log } from './lib/logger.js';
// Routes
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import feedbackRouter from './routes/feedback.js';
import notificationsRouter from './routes/notifications.js';
import listingsRouter from './routes/listings.js';
import feedRouter from './routes/feed.js';
import categoriesRouter from './routes/categories.js';
import storesRouter from './routes/stores.js';
import favoritesRouter from './routes/favorites.js';
import productSavesRouter from './routes/product-saves.js';
import savedItemsRouter from './routes/saved-items.js';
import internalProductSavesRouter from './routes/internal-product-saves.js';
import cartRouter from './routes/cart.js';
import addressesRouter from './routes/addresses.js';
import checkoutRouter from './routes/checkout.js';
import ordersRouter from './routes/orders.js';
import reviewsRouter from './routes/reviews.js';
import sellerRouter from './routes/seller.js';
import publicSellersRouter from './routes/public-sellers.js';
import ratesRouter from './routes/rates.js';
import meRouter from './routes/me.js';
import adminRouter from './routes/admin/index.js';
import channelsOauthRouter from './routes/channels-oauth.js';
import channelsWebhooksRouter from './routes/channels-webhooks.js';
import channelsIngestRouter from './routes/channels-ingest.js';
import reportsRouter from './routes/reports.js';
import crowdSourceWebhookRouter from './routes/crowdsource-webhook.js';
import stripeWebhookRouter from './routes/stripe-webhook.js';
import supplierWebhookRouter from './routes/supplier-webhook.js';
import stripeOnboardingRouter from './routes/stripe-onboarding.js';
import internalPaymentsRouter from './routes/internal-payments.js';
import merchantsRouter from './routes/merchants.js';
import storefrontsRouter from './routes/storefronts.js';
import brandRelationshipsRouter from './routes/brand-relationships.js';
import internalCommerceGraphRouter from './routes/internal-commerce-graph.js';
import canonicalProductsRouter from './routes/canonical-products.js';
import productFamiliesRouter from './routes/product-families.js';
import internalCanonicalCatalogRouter from './routes/internal-canonical-catalog.js';
import offersRouter from './routes/offers.js';
import internalOffersRouter from './routes/internal-offers.js';
import searchRouter from './routes/search.js';
import internalSearchRouter from './routes/internal-search.js';
import productPageRouter from './routes/product-page.js';
import priceHistoryRouter from './routes/price-history.js';
import internalPriceHistoryRouter from './routes/internal-price-history.js';
import priceAlertsRouter from './routes/price-alerts.js';
import internalPriceAlertsRouter from './routes/internal-price-alerts.js';
import internalCatalogConditionRouter from './routes/internal-catalog-condition.js';
import catalogAttributesRouter from './routes/catalog-attributes.js';
import internalCatalogAttributesRouter from './routes/internal-catalog-attributes.js';
import internalMatchingRouter from './routes/internal-matching.js';
import internalBackfillRouter from './routes/internal-backfill.js';
import internalIngestionRouter from './routes/internal-ingestion.js';
import internalOfferFreshnessRouter from './routes/internal-offer-freshness.js';
import offerComparisonRouter from './routes/offer-comparison.js';
import internalRankingRouter from './routes/internal-ranking.js';
import internalFeedImportsRouter from './routes/internal-feed-imports.js';
import internalEbayRouter from './routes/internal-ebay.js';
import internalAwinRouter from './routes/internal-awin.js';
import merchantClaimsRouter from './routes/merchant-claims.js';
import storeLinkageRouter from './routes/store-linkage.js';
import internalGuestCommerceRouter from './routes/internal-guest-commerce.js';
import guestSessionRouter from './routes/guest-session.js';
import guestOrdersRouter from './routes/guest-orders.js';
import analyticsRouter from './routes/analytics.js';
import internalAnalyticsRouter from './routes/internal-analytics.js';
import internalRetailEligibilityRouter from './routes/internal-retail-eligibility.js';
import internalProcurementRouter from './routes/internal-procurement.js';
import internalSupplierPreflightRouter from './routes/internal-supplier-preflight.js';
import internalRetailPilotRouter from './routes/internal-retail-pilot.js';
import { config } from './config/index.js';
import {
  requireCanonicalReads,
  resolveCanonicalReadMode,
  resolveOfferComparisonMode,
} from './services/backfill/read-mode.js';
import { makeRateLimiter } from './lib/rate-limit.js';
import { ALLOWED_ORIGINS } from './lib/allowed-origins.js';

/**
 * Build the application.
 *
 * MOUNT ORDER IS LOAD-BEARING and is asserted by
 * `routes/__tests__/crowdsource-webhook.integration.test.ts` and
 * `routes/__tests__/stripe-webhook.integration.test.ts`: all three webhook
 * routers must be registered BEFORE `express.json()`, or the raw bytes their
 * signatures cover are consumed before they can be verified.
 */
export function createApp(): express.Express {
  const app = express();

  // CORS — restricted to known origins. The list lives in
  // `lib/allowed-origins.ts` because it is ALSO the guest CSRF gate's
  // authority (ADR 0003 D10): one list, nothing to drift.
  const allowedOrigins = ALLOWED_ORIGINS;

  app.use((req, res, next) => {
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);

        if (allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'X-Service-Name', 'X-Timestamp', 'X-Signature', 'X-Session-Id', 'X-Device-Info', 'X-Oxy-User-Id', 'X-Workspace-Id', 'X-Mercaria-Guest-Token', 'X-Mercaria-Guest-Transport', 'X-Mercaria-Guest-Client'],
      optionsSuccessStatus: 200,
    })(req, res, next);
  });

  // Allow cross-origin resource loading (fixes ERR_BLOCKED_BY_RESPONSE.NotSameOrigin)
  app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  });

  // Inbound connector webhooks (server-to-server). MUST be mounted BEFORE the
  // global express.json() so the RAW request body survives for HMAC verification
  // (the router mounts its own express.raw parser for that path).
  app.use('/channels/webhooks', channelsWebhooksRouter);

  // Inbound CrowdSource moderation webhooks. Same rule, stricter consequence: the
  // SDK handler reads the request STREAM and verifies the signature over the bytes
  // that arrived. If a parser consumed them first it REFUSES rather than verifying
  // a re-serialisation — so mounting this after express.json() does not weaken the
  // check, it breaks every delivery. Guarded by a test that asserts
  // `typeof req.body === 'undefined'` inside a route on this path.
  app.use('/webhooks/crowdsource', crowdSourceWebhookRouter);

  // Inbound Stripe webhooks — the platform and Connect endpoints (ADR 0001).
  // Same raw-body rule as the two above: Stripe signs the bytes it sent, so a
  // parser reaching the stream first breaks every delivery rather than weakening
  // the check. The router mounts its own express.raw on each path.
  //
  // The MOUNT is gated, not just the handler. A deployment with no Stripe
  // configuration answers 404 here, which is the truthful answer — and it stops
  // an endpoint being registered in the Stripe dashboard against a deployment
  // that has no secret and therefore could never tell a real delivery from a
  // forged one. There is nothing to park, unlike the outbox dispatchers, because
  // without a secret nothing could be verified to park in the first place.
  if (config.payments.stripe.enabled) {
    app.use('/webhooks/stripe', stripeWebhookRouter);
  }

  // Inbound SUPPLIER webhooks (#124). The FOURTH raw-body mount, and the same
  // rule: a supplier signs the bytes it sent, so a parser reaching the stream
  // first breaks every delivery. The router mounts its own express.raw.
  //
  // The mount is NOT gated on a flag, unlike Stripe's, and the difference is
  // real rather than an inconsistency: what makes a delivery verifiable here is
  // the ACCOUNT named in the path and the credential behind it, so an
  // unconfigured deployment already answers 401 to every delivery through the
  // handler's own gates. A flag would add a second, coarser way to say the same
  // thing — and one that could strand a supplier's events during an incident
  // where their configuration is exactly what somebody is fixing.
  app.use('/webhooks/suppliers', supplierWebhookRouter);

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Global rate limiter — per-user for authenticated callers, per-IP for anon.
  // (The SDK exempts health probes + CORS preflight internally.)
  app.use(makeRateLimiter('general'));

  // Routes
  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/feedback', feedbackRouter);
  app.use('/notifications', notificationsRouter);
  app.use('/listings', listingsRouter);
  app.use('/feed', feedRouter);
  app.use('/categories', categoriesRouter);
  app.use('/stores', storesRouter);
  app.use('/favorites', favoritesRouter);
  /**
   * Canonical product saves (#80). `/favorites` above is UNTOUCHED and stays
   * mounted whatever these flags say — #80 acceptance 2 is that no existing
   * favorite is dropped, and the surface a buyer's existing saves are served
   * through is the first place that has to hold.
   *
   * `PRODUCT_SAVES_ENABLED` gates the MOUNT, so a deployment that has not
   * adopted #80 404s both paths and behaves exactly as it did before. It does
   * NOT gate the rows: saves already stored stay stored and come back when the
   * flag does, because a rollback lever that cost buyers their list is not one
   * anybody would pull.
   */
  if (config.productSaves.enabled) {
    app.use('/product-saves', productSavesRouter);
    app.use('/saved-items', savedItemsRouter);
  }
  app.use('/cart', cartRouter);
  app.use('/addresses', addressesRouter);
  app.use('/checkout', checkoutRouter);
  // Guest sessions (ADR 0003, #103). The MOUNT is gated like the Stripe routes
  // above and for the same reason: a deployment without guest commerce answers
  // 404 — the truthful answer — rather than advertising a credential surface
  // it will refuse. The issuance KILL SWITCH is a different lever
  // (`GUEST_SESSION_ISSUANCE_ENABLED`): it stops only NEW sessions, inside the
  // router, so existing guests keep resolving during an incident.
  if (config.guest.enabled) {
    app.use('/guest/session', guestSessionRouter);
  }
  // The guest order PORTAL (#108) — mounted UNCONDITIONALLY, and the contrast
  // with the line above is the decision, not an oversight. ADR 0003 M8 gates
  // ISSUANCE and guest checkout on `GUEST_COMMERCE_ENABLED` and binds the
  // opposite for durable records: "existing portal grants and magic-link
  // recovery for already-placed guest orders keep working with the flag off".
  // #108 acceptance 10 says the same thing from the buyer's side. Gating this
  // mount would strand every person who had already paid the moment somebody
  // pulled the lever — which is exactly when they would be trying to find their
  // order.
  app.use('/guest/orders', guestOrdersRouter);
  app.use('/orders', ordersRouter);
  app.use('/reviews', reviewsRouter);
  // Abuse reports. Unrelated to the store SALES ANALYTICS at
  // /admin/stores/:storeId/reports/* — same word, different domain.
  app.use('/reports', reportsRouter);
  app.use('/seller', sellerRouter);
  // `/sellers` (PLURAL) is the PUBLIC P2P seller profile (#92); `/seller`
  // (singular, above) is the authenticated seller's own management surface.
  // One letter apart and opposite in who may read them — hence two routers.
  app.use('/sellers', publicSellersRouter);
  app.use('/rates', ratesRouter);
  app.use('/me', meRouter);
  app.use('/admin', adminRouter);
  // Public connector OAuth callback (server-to-server; no browser CORS, no session).
  app.use('/channels/oauth', channelsOauthRouter);
  // Token-free channel ingestion (external push client authenticated by a channel key).
  app.use('/channels/ingest', channelsIngestRouter);
  // Public Stripe hosted-onboarding round trip (browser redirects; no session,
  // authenticated by the signed state this API issued). Mounted HERE and not in
  // the pre-json block above: these carry query parameters, not a signed raw
  // body, so there is nothing a parser could consume before it is verified.
  //
  // Gated on the rail exactly as the webhook mount is, and for the same reason —
  // a deployment with no Stripe configuration cannot have issued a state, so 404
  // is the truthful answer rather than a route that can only ever refuse.
  if (config.payments.stripe.enabled) {
    app.use('/stripe/onboarding', stripeOnboardingRouter);
  }
  // The platform operator surface (#50). Mounted OUTSIDE `/admin` deliberately:
  // that whole tree is scoped to one store by `loadStore` + `requireStorePermission`,
  // and this reads across every store and every P2P seller — so there is no
  // store whose membership could authorize it, and putting it there would leave
  // a platform-wide read one forgotten permission check away from a merchant
  // session. Issue #50: operator tooling must not be reachable through the
  // merchant dashboard.
  //
  // The MOUNT is gated on the allow-list being non-empty, so a deployment with
  // no operators answers 404 rather than 401 — the same rule the Stripe routes
  // above follow, because a 401 would tell an unauthenticated caller that an
  // operator surface exists here.
  if (config.payments.operatorSurfaceEnabled) {
    app.use('/internal/payments', internalPaymentsRouter);
  }
  // Canonical commerce graph (#54, ADR 0002): public merchant/storefront
  // identity reads…
  app.use('/merchants', merchantsRouter);
  app.use('/storefronts', storefrontsRouter);
  // …the VERIFIED relationship reads (#55): official-store and
  // authorized-reseller status, scoped to a market and an instant. Public,
  // because a verified relationship is public catalogue identity; the evidence
  // behind it is not, and the projection has no field to carry it.
  app.use('/brand-relationships', brandRelationshipsRouter);
  // Merchant claiming (#83). Mounted OUTSIDE `/admin` deliberately: that tree
  // is reached through `loadStore`, which establishes a membership in ONE
  // store, and a claim is made by a person about a merchant that may have no
  // native store at all. Not gated on any flag — a merchant page that cannot
  // say "claim this" is a dead end for the one person entitled to fix it.
  app.use('/merchant-claims', merchantClaimsRouter);
  // Merchant → native store linkage (#84), where a verified claim ends. Also
  // outside `/admin`, and for a sharper reason than the claim surface has:
  // `loadStore` resolves `:storeId` from the PATH, while a linkage request
  // either has no store yet (`create_store`) or names one in a BODY beside a
  // claim — so the permission check belongs in the service, against the store
  // the request actually names. Not flag-gated, for the claim surface's reason.
  app.use('/store-linkage', storeLinkageRouter);
  // …and the graph's operator surface, gated exactly as /internal/payments is
  // (its own allow-list; empty = not mounted, 404 — see
  // middleware/catalog-operator-authz.ts).
  if (config.catalog.graphOperatorSurfaceEnabled) {
    app.use('/internal/commerce-graph', internalCommerceGraphRouter);
  }
  /**
   * The canonical PRODUCT layer (#56): public identity reads, behind #60's two
   * rollout levers.
   *
   * `CANONICAL_PUBLIC_ROUTES_ENABLED` gates the MOUNT — the blunt lever, for a
   * rollback that must not depend on every handler having remembered its gate —
   * and `CANONICAL_READS` gates the reads themselves in `off | shadow | on`.
   * Both default to today's behaviour, because these routes SHIPPED with #56 and
   * a lever that withdrew them on the deploy that added it would be an outage
   * rather than a rollout; see `services/backfill/read-mode.ts` for the full
   * argument and ADR 0002 D24 for the vocabulary.
   */
  if (config.canonicalRollout.publicRoutesEnabled) {
    app.use(
      '/canonical-products',
      requireCanonicalReads('canonical-products', resolveCanonicalReadMode),
      canonicalProductsRouter,
    );
    app.use(
      '/product-families',
      requireCanonicalReads('product-families', resolveCanonicalReadMode),
      productFamiliesRouter,
    );
  }
  // …and its own operator surface. A SEPARATE router from the graph's above,
  // sharing the ONE operator allow-list — the two surfaces belong to different
  // issues and move at different rates, but who may reshape the catalogue is a
  // single question with a single answer.
  if (config.catalog.graphOperatorSurfaceEnabled) {
    app.use('/internal/canonical-catalog', internalCanonicalCatalogRouter);
  }
  /**
   * The unified offer model (#57, ADR 0002 D18): what a canonical variant costs,
   * where, from whom, and how current that is — native and external offers
   * through ONE shape. Mounted after the canonical product layer because an
   * offer prices one of its variants.
   *
   * Behind its OWN read lever (`CANONICAL_OFFER_COMPARISON`), separate from
   * `CANONICAL_READS` because the two bound different blast radii: withdrawing
   * price comparison during an incident should not take the brand and product
   * identity pages down with it (#60 feature flags 2 and 3).
   */
  if (config.canonicalRollout.publicRoutesEnabled) {
    app.use('/offers', requireCanonicalReads('offers', resolveOfferComparisonMode), offersRouter);
    /**
     * The RANKED comparison (#74), behind the same canonical-read lever as
     * `/offers` and for the same reason: it is the same catalogue read, with a
     * policy applied on top. A deployment that has withdrawn offer comparison
     * must not keep serving a ranked version of it.
     */
    app.use(
      '/offer-comparison',
      requireCanonicalReads('offer-comparison', resolveOfferComparisonMode),
      offerComparisonRouter,
    );
  }
  /**
   * Canonical multi-entity product discovery (#70): products, brands, families,
   * merchants and storefronts through ONE ordered result set, with offers
   * attached as commercial context rather than as the search identity.
   *
   * Mounted UNCONDITIONALLY, and its rollout lever (`CANONICAL_SEARCH`, `off`
   * by default) lives inside the handler rather than in
   * `requireCanonicalReads` — `shadow` here means "compute the canonical answer
   * AND the listing-first one and record the comparison", which a middleware
   * that returns before the handler can never do. `off` and `shadow` are both a
   * 404, so the visible behaviour matches every other gated canonical surface.
   *
   * `GET /listings?q=` — the listing-first search this replaces — is UNTOUCHED
   * and keeps serving whatever this lever says, which is what makes #70
   * acceptance 8's rollback one environment variable.
   */
  app.use('/search', searchRouter);

  /**
   * The canonical product page (#71): one product's identity, its
   * configurations, every eligible way to acquire it and the verified channels
   * behind them — composed from #56, #74, #57, #68, #90 and #55 in ONE read.
   *
   * Behind the SAME blunt MOUNT lever as `/canonical-products` — this page
   * serves canonical identity, so a deployment that has withdrawn the public
   * canonical surface must not keep answering here — and gated inside the
   * HANDLER rather than by `requireCanonicalReads`, for the reason `/search`
   * is: `CANONICAL_READS=shadow` means "compute the canonical answer AND the
   * listing-first one and record the comparison", which a middleware that
   * returns first can never do. `off` and `shadow` are both a 404, so the
   * visible behaviour matches every other gated canonical surface, and
   * `services/backfill/read-mode.ts` named this page as the second surface that
   * would compare both answers.
   *
   * `GET /listings/:id` — the listing-first product experience — is UNTOUCHED
   * and keeps serving whatever this lever says (#71 acceptance 7), which is
   * what leaves #75 free to migrate the public routes on its own schedule.
   */
  if (config.canonicalRollout.publicRoutesEnabled) {
    app.use('/product-page', productPageRouter);
  }

  /**
   * Currency-safe price history (#78), behind its OWN read lever.
   *
   * `PRICE_HISTORY_PUBLIC_READS_ENABLED` gates the MOUNT and nothing durable:
   * observations are recorded on every offer write whatever it says, and the
   * operator surface below stays mounted while it is off. A chart is the one
   * part of this domain that can be WRONG in public — a line drawn through a
   * period nobody observed, a currency reinterpreted without saying so — so the
   * buyer-facing half is the half that gets a lever, exactly as `#80`'s
   * `PRODUCT_SAVES_ENABLED` gates a surface and never a row.
   */
  if (config.priceHistory.publicReadsEnabled) {
    app.use('/price-history', priceHistoryRouter);
  }
  /**
   * Price alerts (#79) — the buyer's own surface, gated by `PRICE_ALERTS_ENABLED`.
   *
   * The MOUNT and nothing else: alerts already stored keep being evaluated and
   * keep notifying while this is off, because a flag that stopped a buyer's
   * alert firing would make the rollback lever cost them the thing they were
   * waiting for. The two levers that DO stop work are the evaluation and
   * delivery loops, and neither gates a durable record either.
   */
  if (config.priceAlerts.enabled) {
    app.use('/price-alerts', priceAlertsRouter);
  }
  // The versioned attribute registry and the constraint language (#94): public
  // definition/facet reads and the pre-flight validation both search and #95's
  // interpreter run against…
  app.use('/catalog-attributes', catalogAttributesRouter);
  // …and their operator surfaces, on the SAME allow-list the ones above use:
  // who may reshape the catalogue, who may withdraw an offer from a comparison
  // and who may change what an attribute MEANS are the same power over the same
  // graph. Separate routers because the three move at their own rates.
  if (config.catalog.graphOperatorSurfaceEnabled) {
    app.use('/internal/offers', internalOffersRouter);
    // …and #70's, on the same list and mounted while the public search lever is
    // off: the shadow evidence a rollout is judged on has to be readable during
    // the incident that turned the surface off.
    app.use('/internal/search', internalSearchRouter);
    app.use('/internal/catalog-attributes', internalCatalogAttributesRouter);
    // The condition taxonomy (#90): versioned source-label mappings, category
    // restrictions, and one listing's condition history. Same allow-list, same
    // reason — what an external source's wording MEANS is a fact about this
    // graph.
    app.use('/internal/catalog-condition', internalCatalogConditionRouter);
    // Price history (#78): metrics, one offer's observation trail, and a
    // rebuild trigger. Mounted while `PRICE_HISTORY_ENABLED` is off, because
    // the evidence has to be readable during the incident that turned the loop
    // off — #62's and #68's rule for their own operator surfaces.
    app.use('/internal/price-history', internalPriceHistoryRouter);
  }

  /**
   * The matching operator surface (#58), on the SAME allow-list for the same
   * reason: deciding that two things are one thing is the same power over the
   * same graph as reshaping it. Empty list ⇒ never registered ⇒ 404, never a 401
   * that would advertise the surface.
   */
  if (config.catalog.graphOperatorSurfaceEnabled) {
    app.use('/internal/matching', internalMatchingRouter);
  }
  /**
   * The staged migration's operator surface (#60), on the SAME allow-list and
   * for the same reason as the four above: migrating the native catalogue into
   * the canonical graph is the same power over the same graph as reshaping it.
   *
   * Deliberately NOT gated on `CANONICAL_GRAPH_ENABLED`. That lever stops the
   * dispatcher LOOP, and an operator must still be able to open a run, read a
   * report and see the flags while it is off — gating the surface on it would
   * make "start the migration paused" impossible and would hide the evidence
   * during exactly the incident that turned the loop off.
   */
  if (config.catalog.graphOperatorSurfaceEnabled) {
    app.use('/internal/backfill', internalBackfillRouter);
  }
  /**
   * The product-save operator surface (#80), on the SAME allow-list and for the
   * same reason as the five above: a save points at a canonical product and its
   * counter is a canonical rollup.
   *
   * Deliberately NOT gated on `PRODUCT_SAVES_ENABLED`. That lever withdraws the
   * BUYER surface, and an operator must still be able to read counter drift,
   * rebuild a counter and erase an account's saves while it is off — gating this
   * on it would hide the evidence during exactly the incident that turned the
   * buyer surface off, which is #60's own reasoning for `/internal/backfill`.
   */
  if (config.catalog.graphOperatorSurfaceEnabled) {
    app.use('/internal/product-saves', internalProductSavesRouter);
  }
  /**
   * The price-alert operator surface (#79), on the SAME allow-list and mounted
   * regardless of `PRICE_ALERTS_ENABLED` — #80's reasoning exactly: an operator
   * has to be able to read the evaluation lag and trace an alert during the
   * incident that turned the buyer surface off.
   */
  if (config.catalog.graphOperatorSurfaceEnabled) {
    app.use('/internal/price-alerts', internalPriceAlertsRouter);
  }
  /**
   * The external ingestion framework's operator surface (#62), on the SAME
   * allow-list and mounted for the same reason the backfill's is: configuring a
   * source, reviewing its terms and draining it by hand is how a feed is
   * brought up BEFORE `CATALOG_INGESTION_ENABLED` is switched on, and the
   * evidence has to stay readable during the incident that turned the loop off.
   */
  if (config.catalog.graphOperatorSurfaceEnabled) {
    app.use('/internal/ingestion', internalIngestionRouter);
  }
  /**
   * Source-aware freshness, refresh scheduling and catalogue health (#68), on
   * the SAME allow-list as the ingestion surface above and mounted for the same
   * reason: publishing a source's freshness policy, reading its quarantine
   * board and draining it by hand is how a feed is brought up BEFORE
   * `OFFER_REFRESH_ENABLED` is switched on, and the evidence has to stay
   * readable during the incident that turned the loop off.
   */
  if (config.catalog.graphOperatorSurfaceEnabled) {
    app.use('/internal/offer-freshness', internalOfferFreshnessRouter);
  }
  /**
   * The ranking policy surface (#74), on the SAME allow-list and mounted whether
   * or not anything has been published: a deployment ranking under the BUILT-IN
   * policy is exactly when somebody needs to read what that policy is, and
   * gating this on having published one would make preparing the first
   * publication impossible.
   */
  if (config.catalog.graphOperatorSurfaceEnabled) {
    app.use('/internal/ranking', internalRankingRouter);
  }
  /**
   * The feed importer's operator surface (#63), on the SAME allow-list and
   * mounted while `FEED_IMPORT_ENABLED` is off — for `/internal/backfill`'s
   * reason: a merchant's mapping, their validation reports and the reason their
   * last pass failed are exactly the evidence somebody needs during the incident
   * that turned the importer off. It is read-only; every write belongs to the
   * store that owns the feed.
   */
  if (config.catalog.graphOperatorSurfaceEnabled) {
    app.use('/internal/feed-imports', internalFeedImportsRouter);
  }
  /**
   * The eBay Browse source's operator surface (#65), on the SAME allow-list and
   * for the same reason: deciding which eBay categories Mercaria ingests is the
   * same power over the same graph as deciding what any other external source
   * may do. It stays mounted while `EBAY_ENABLED` and `EBAY_FETCH_ENABLED` are
   * off — reading the call budget is exactly what somebody does after flipping
   * the fetch kill switch.
   */
  if (config.catalog.graphOperatorSurfaceEnabled) {
    app.use('/internal/ebay', internalEbayRouter);
  }
  /**
   * The Awin retailer-network operator surface (#66), on the SAME allow-list and
   * mounted while `AWIN_ENABLED` is off — for `/internal/ingestion`'s reason:
   * registering a publisher account, polling the feed list and reading what it
   * found is how a network is brought up BEFORE the adapter is switched on, and
   * the evidence has to stay readable during the incident that turned it off.
   */
  if (config.catalog.graphOperatorSurfaceEnabled) {
    app.use('/internal/awin', internalAwinRouter);
  }
  // Guest-commerce diagnostic (#104), gated on its OWN allow-list for the same
  // reason the two above have theirs: reading who merged which cart is a third
  // power, and one list for all three would grant whichever an operator was not
  // vetted for. Empty = not mounted, 404 — see middleware/guest-operator-authz.ts.
  if (config.guest.operatorSurfaceEnabled) {
    app.use('/internal/guest-commerce', internalGuestCommerceRouter);
  }
  // Client analytics ingestion (#77). Mounted UNCONDITIONALLY, unlike the guest
  // and Stripe routes above: a deployment that collects nothing answers 202 and
  // records nothing rather than 404, because the endpoint's existence is not a
  // secret and a client that got a 404 would retry it forever. The handler's own
  // `config.analytics.enabled` check is the gate.
  app.use('/analytics', analyticsRouter);
  // …and the analytics operator surface, on its OWN allow-list — a FOURTH list
  // beside payments, catalog and guest, for the fourth instance of the reason
  // those three are separate: reading what every market searched for is a
  // different power from repairing payments, rewiring the catalogue or
  // inspecting a cart merge. Empty = not mounted, 404 — see
  // middleware/analytics-operator-authz.ts.
  if (config.analytics.operatorSurfaceEnabled) {
    app.use('/internal/analytics', internalAnalyticsRouter);
  }
  // …and the retail compliance surface, on its OWN allow-list — a FIFTH list,
  // for the fifth instance of the same reason: approving a resale
  // authorization, verifying a product-safety certificate and LIFTING A RECALL
  // is a compliance power, and it is the only one of the five whose misuse puts
  // an unsafe product back on sale. Empty = not mounted, 404 — see
  // middleware/retail-operator-authz.ts.
  if (config.retailEligibility.operatorSurfaceEnabled) {
    app.use('/internal/retail-eligibility', internalRetailEligibilityRouter);
  }
  // …and the supply-operations surface, on its OWN allow-list — a SIXTH list,
  // for a power none of the other five holds: this one reads what Mercaria PAYS
  // its suppliers and flips the supplier and market kill switches. Empty = not
  // mounted, 404 — see middleware/procurement-operator-authz.ts.
  if (config.supplierPreflight.operatorSurfaceEnabled) {
    app.use('/internal/supplier-preflight', internalSupplierPreflightRouter);
    // The supplier-ORDER half of the same power, on the SAME sixth list (#124).
    // Deliberately not a seventh: reading what Mercaria pays a supplier and
    // acting on a supplier order are one power, and splitting them would create
    // a list to keep in sync with no distinction to justify it.
    app.use('/internal/procurement', internalProcurementRouter);
    // …and the bounded pilot (#125), on the SAME sixth list for the same
    // reason: publishing the bounds Mercaria buys under and pausing entry when
    // a threshold is crossed is the supply-operations power, not a seventh one.
    app.use('/internal/retail-pilot', internalRetailPilotRouter);
  }
  // (Inbound connector webhooks are mounted above, before express.json.)

  // Root route
  app.get('/', (_req, res) => {
    res.json({
      message: 'Mercaria API',
      version: '1.0.0',
      endpoints: [
        '/health',
        '/auth',
        '/feedback',
        '/notifications',
        '/listings',
        '/feed',
        '/categories',
        '/stores',
        '/favorites',
        '/cart',
        '/addresses',
        '/checkout',
        '/orders',
        '/reviews',
        '/seller',
        '/rates',
        '/me',
        '/admin',
        '/channels/oauth',
        '/channels/ingest',
        '/channels/webhooks',
        '/stripe/onboarding',
        '/merchants',
        '/storefronts',
        '/brand-relationships',
        '/canonical-products',
        '/product-families',
        '/product-page',
        '/offers',
        '/catalog-attributes',
        '/merchant-claims',
        '/store-linkage',
        '/guest/session',
        '/analytics',
        // `/internal/payments`, `/internal/commerce-graph`,
        // `/internal/canonical-catalog`, `/internal/offers`,
        // `/internal/catalog-attributes`, `/internal/analytics`,
        // `/internal/retail-eligibility` and `/internal/guest-commerce` are
        // deliberately ABSENT, and this is not an
        // oversight to correct: this list is public and unauthenticated, and the
        // operator surface answers 404 on a deployment with no operators
        // precisely so its existence is not discoverable. Advertising it here
        // would undo that in the one place nobody thinks to look.
      ]
    });
  });

  // Error handler
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.general.error({ err }, 'Unhandled Express error');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Something went wrong!' });
    }
  });

  return app;
}
