/**
 * THE REUSABLE CONNECTOR CONTRACT SUITE — issue #69's Shopify and WooCommerce
 * scenario lists, every case that does not need a provisioned store.
 *
 * The Shopify harness and the WooCommerce harness each call
 * {@link describeConnectorContract} with an adapter over a {@link ContractWorld},
 * and get the same cases against the same tables. That is the point: the two
 * platforms disagree about almost everything on the wire and agree about every
 * property Mercaria actually depends on, so a case written once has to hold for
 * both or the disagreement is a bug in one of them.
 *
 * ## What is REAL here, and what is not
 *
 * Real: the provider (its URL building, its pagination, its zod schemas, its
 * price parsing, its rate-limit wrapper), `connector-sync.service` end to end,
 * `catalog-write.service`, the inventory service, and a Postgres server with
 * every CHECK, unique index and trigger the production schema carries.
 *
 * Faked: the socket, and nothing else. A `ContractWorld` is not a Shopify store
 * and cannot testify about one — see the header of `contract-world.ts` and
 * `docs/runbooks/connector-real-store-verification.md`, which carries the
 * scenarios that stay manual and why.
 *
 * ## Why this file is not named `*.test.ts`
 *
 * vitest collects `src/**\/*.test.ts`. A suite that ran itself with no harness
 * would be a file of cases nobody could interpret. The two runners are
 * `shopify/__tests__/shopify-contract.test.ts` and
 * `woocommerce/__tests__/woocommerce-contract.test.ts`; a third platform adds a
 * third one-line runner. This is the shape
 * `services/ingestion/__tests__/adapter-contract-suite.ts` established.
 *
 * ## Capabilities are DECLARED, and a missing one is stated rather than skipped
 *
 * WooCommerce implements no product push and no fulfillment push, and has no
 * inventory webhook. A suite that silently omitted those cases would report the
 * same green for a provider that lost the feature. Each capability-gated case
 * asserts the REFUSAL when the capability is absent, so both branches are
 * measured.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { ConnectorProviderId, CurrencyCode } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { categories, listings } from '../../db/schema/catalog.js';
import { connections } from '../../db/schema/connectors.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import { insertCategory } from '../../db/taxonomy/taxonomyRepository.js';
import { insertStore } from '../../db/stores/storeRepository.js';
import { insertLocation } from '../../db/stores/locationRepository.js';
import {
  claimConnectionWebhookRegistration,
  findConnection,
  findConnectionCredentials,
  findConnectionsByStore,
  findConnectionsNeedingWebhookRegistration,
  findConnectionWebhookFailures,
  findConnectionWebhookSecret,
  recordConnectionWebhookRegistration,
  releaseConnectionWebhookRegistration,
  updateSyncSettings as updateSyncSettingsColumns,
  type ConnectionRow,
} from '../../db/connectors/connectionRepository.js';
import {
  findListingBySourceExternalId,
  findListingChildren,
  findListingsBySourceConnection,
  setListingStatusIfIn,
  updateListingColumns,
} from '../../db/catalog/listingRepository.js';
import {
  findVariantOptionValues,
  findVariantsByListing,
  findVariantsBySourceConnection,
  updateVariant as updateVariantColumns,
} from '../../db/catalog/variantRepository.js';
import { findLevelsByVariant } from '../../db/catalog/inventoryLevelRepository.js';
import { listSyncRunsForConnection } from '../../db/connectors/syncRunRepository.js';
import {
  orderAppliedDiscounts,
  orders as ordersTable,
  orderTaxLines,
} from '../../db/schema/orders.js';
import { decryptSecret } from '../../lib/connector-crypto.js';
import {
  auditConnectionWebhooks,
  connectAndVerify,
  connectWithApiKey,
  disconnect,
  processConnectorWebhook,
  pushListingToChannels,
  pushOrderFulfillment,
  reregisterConnectionWebhooks,
  runBackfill,
  syncInventory,
  syncOrders,
  toConnectionDTOWithWebhookFailures,
} from '../../services/connector-sync.service.js';
import type { ConnectorCapabilities, ConnectorProvider } from '../types.js';
import type {
  ContractOrder,
  ContractProduct,
  ContractVariant,
  ContractWorld,
} from './contract-world.js';

/** What a provider package supplies to get every case below. */
export interface ConnectorContractHarness {
  /** Names the suite in test output — "the Shopify connector". */
  readonly name: string;
  readonly providerId: ConnectorProviderId;
  /** The shop host the world is served at, in the form the provider expects. */
  readonly shopDomain: string;
  /** The currency the world's shop reports. Deliberately never FAIR. */
  readonly shopCurrency: CurrencyCode;
  /** Build the REAL provider over a transport that serves `world`. */
  createProvider(world: ContractWorld): ConnectorProvider;
  /**
   * Make `getConnectorProvider` answer with `provider` from now on. The runner
   * owns the `vi.mock`, because vitest hoists it per FILE and this file is not
   * one of them.
   */
  installProvider(provider: ConnectorProvider): void;
  /** The provider's own topic string for each canonical webhook kind. */
  readonly topics: {
    readonly productUpsert: string;
    readonly productDelete: string;
    readonly orderUpsert: string;
    /** Absent when the platform has no inventory webhook (WooCommerce). */
    readonly inventoryUpdate?: string;
  };
  /**
   * The SHIPPED provider's own capability declaration — passed, never restated.
   *
   * #87 moved this onto `ConnectorProvider` because a merchant-facing channel
   * catalog needs it too, and a second copy here would let the suite go on
   * measuring a claim the catalog no longer makes. Each runner passes
   * `<provider>.capabilities` from the module-level singleton, so the value the
   * suite gates its cases on is the value production reads.
   */
  readonly capabilities: ConnectorCapabilities;
  /**
   * The SHIPPED provider's taxonomy noun, passed rather than restated for
   * `capabilities`' reason (#376). Asserting the suite's expectation against the
   * provider's own declaration is what makes a provider that quietly changed it
   * turn this red instead of the suite agreeing with whatever it now says.
   */
  readonly externalTaxonomyNoun: ConnectorProvider['externalTaxonomyNoun'];
  /**
   * Whether this platform's taxonomy NESTS — the one structural difference
   * between the two, and the reason the mapping screen cannot assume a flat list.
   * WooCommerce categories have a parent; Shopify collections do not. Both
   * branches are measured, so a flat provider that started inventing a hierarchy
   * fails just as loudly as a nested one that stopped reporting it.
   */
  readonly taxonomyNests: boolean;
  /**
   * The SHIPPED provider's webhook-secret strategy, passed for the same reason
   * `capabilities` is. #218's registration cases have to know the delivery URL
   * the provider builds, and it is the strategy that decides it: a
   * `per_connection` provider appends the connection id so the ingress route can
   * resolve the exact connection, an `app_secret` one does not.
   */
  readonly webhookSecretStrategy: ConnectorProvider['webhookSecretStrategy'];
  /**
   * The URL fragment BOTH the subscription list and the subscription create
   * share on this platform, for a method-scoped fault.
   */
  readonly webhookPathFragment: string;
  /**
   * The URL fragment a subscription DELETE carries, which is a SEPARATE
   * declaration rather than the one above: Shopify's list and create live at
   * `/webhooks.json` while its delete is `/webhooks/{id}.json`, so a fault armed
   * on the first fragment never fires on a delete at all — it matches nothing,
   * the delete succeeds, and a case that meant to measure a refusal measures a
   * healthy run instead. Measured: that is exactly how the retained-id case
   * first passed for WooCommerce and failed for Shopify.
   */
  readonly webhookDeletePathFragment: string;
  /**
   * Whether this platform publishes a subscription's own health — its `status`
   * and its failed-delivery count — in the list Mercaria reads (#295).
   *
   * Declared like a capability and measured on BOTH branches, because it decides
   * what a shop can be told about a subscription that DIED on the platform's
   * side. WooCommerce publishes both and disables a subscription itself past
   * five failures, so an audit can see it. Shopify's REST webhook object
   * publishes neither, so a subscription failing there is invisible until
   * Shopify removes it — and the audit is then reduced to noticing that a stored
   * id is gone or points somewhere we no longer serve.
   *
   * A suite that ran only the first branch would report the same green for a
   * provider that silently stopped reading a status it does publish.
   */
  readonly publishesSubscriptionHealth: boolean;
  /**
   * Whether this provider reports a product's PUBLISH STATE to Mercaria (#377).
   *
   * Declared like a capability and measured on BOTH branches, because it decides
   * what happens to a listing when the merchant takes the product down on their
   * own site — the difference between a sale stopping now and a sale continuing
   * until a backfill runs.
   *
   * WooCommerce publishes `status` on the pull and on every `product.*`
   * delivery. Shopify's product resource carries one too, and this connector
   * reads neither — see the Shopify runner, where the `false` is explained as a
   * fact about the connector rather than the platform.
   *
   * A suite that ran only the first branch would report the same green for a
   * provider that silently stopped reading a status it does publish.
   */
  readonly reportsPublishState: boolean;
  /**
   * Whether this provider reads a variant's BARCODE off the platform (#381).
   *
   * Declared like a capability and measured on BOTH branches. Shopify publishes
   * `barcode` on every variant and the provider maps it; WooCommerce core has no
   * barcode field at all, so its schema names none and its normalizer produces
   * none — a re-sync there can only ever leave the column empty, and a case that
   * asserted a barcode had moved would be asserting a fact the platform never
   * sent.
   *
   * The absent branch is what stops that reading as the same green: it asserts
   * the variant carries NO barcode, so a provider that gained the field without
   * the sync path learning to re-sync it fails here.
   */
  readonly reportsVariantBarcode: boolean;
  /**
   * Whether this platform states a discount's VALUE TYPE on an order (#378).
   *
   * Declared like a capability and measured on BOTH branches. Shopify publishes
   * `value_type` on every `discount_applications` entry; a WooCommerce order
   * coupon line is a code and an amount, and the coupon's own type is not part
   * of the order payload. So a WooCommerce import must store NO value type
   * rather than a plausible one, and asserting that ABSENCE is the only thing
   * that stops somebody defaulting it to `fixed_amount` later — a false snapshot
   * of another shop's discount, which no other check here would notice.
   */
  readonly publishesDiscountValueType: boolean;
  /**
   * The URL fragment the provider fetches to COMPLETE a webhook payload (#220),
   * or ABSENT when this platform's deliveries are self-contained.
   *
   * Declared like a capability and measured on BOTH branches: a platform whose
   * delivery is incomplete must make the extra call and must fail closed when it
   * cannot, and a platform whose delivery is complete must make no call at all.
   * A suite that only ran the first would report the same green for a provider
   * that silently stopped expanding.
   */
  readonly webhookExpansionPathFragment?: string;
  /**
   * Make the platform under-report `externalId`'s variations from now on — an
   * otherwise perfect 2xx that carries fewer variants than the product has
   * (#259) — or ABSENT when this platform cannot be made to.
   *
   * Declared like a capability and measured on BOTH branches, for the reason
   * every other declaration here is. WooCommerce can: its variations endpoint
   * pages, and the parent payload names the ids it is short of. Shopify cannot
   * below a hundred variants: its product resource inlines them, publishes no
   * manifest to be short against, and its only unprovable state is a product AT
   * the inline cap — a fixture of a hundred variants would be measuring the
   * catalogue cap rather than this rule, so that case lives in
   * `shopify-normalize.test.ts` where it costs nothing.
   */
  truncateVariantEnumeration?(world: ContractWorld, externalId: string): void;
  /**
   * Make the platform stop publishing whatever proves its PRODUCT enumeration
   * finished — a perfectly ordinary 200 whose pagination metadata is gone
   * (#259) — or ABSENT when this platform's pagination cannot be made unprovable.
   *
   * WooCommerce can: `X-WP-TotalPages` is a response header, and WordPress
   * caching and security plugins strip response headers as ordinary
   * configuration. Shopify cannot: it signals a next page by PRESENCE of a
   * `Link: rel="next"`, so removing it says "this was the last page", which is a
   * statement rather than a silence. Both branches run the same backfill and the
   * same assertions; only the WooCommerce one arms the fault first.
   */
  suppressEnumerationProof?(world: ContractWorld): void;
  /** Build the world every case starts from (fresh per case). */
  createWorld(): ContractWorld;
  /**
   * The raw payload a `product_upsert` webhook delivers for `externalId`, in the
   * platform's own JSON — the provider's `normalizeProduct` reads it directly.
   */
  webhookProductPayload(world: ContractWorld, externalId: string): unknown;
  /** The raw payload an `order_upsert` webhook delivers for `externalId`. */
  webhookOrderPayload(world: ContractWorld, externalId: string): unknown;
}

/** The env every case needs; a connector operation reads these AT USE. */
const REQUIRED_ENV: Readonly<Record<string, string>> = {
  CONNECTOR_ENCRYPTION_KEY: 'a'.repeat(64),
  CONNECTOR_OAUTH_STATE_SECRET: 'contract-suite-state-secret',
  CONNECTOR_OAUTH_REDIRECT_BASE_URL: 'https://api.mercaria.test',
  SHOPIFY_CLIENT_ID: 'contract-suite-client-id',
  SHOPIFY_CLIENT_SECRET: 'contract-suite-client-secret',
};

/** Everything one case works against: a store with a category, a location and a connection. */
interface ContractFixture {
  readonly storeId: string;
  readonly categorySlug: string;
  /** The connection's TARGET location — where every connector write must land. */
  readonly locationId: string;
  /** The store's DEFAULT location, which the connector must never write to. */
  readonly defaultLocationId: string;
  readonly connection: ConnectionRow;
  readonly world: ContractWorld;
}

export function describeConnectorContract(harness: ConnectorContractHarness): void {
  describe(`the connector contract — ${harness.name}`, () => {
    let db: Database;
    const createdStoreIds: string[] = [];
    const createdCategoryIds: string[] = [];
    /** Env values this suite overwrote, restored afterwards. */
    const previousEnv = new Map<string, string | undefined>();

    beforeAll(async () => {
      for (const [name, value] of Object.entries(REQUIRED_ENV)) {
        previousEnv.set(name, process.env[name]);
        process.env[name] = value;
      }
      db = await connectPostgres();
    }, 120_000);

    afterEach(async () => {
      // `listings.store_id`, `orders.store_id` and both `source_connection_id`
      // columns are ON DELETE RESTRICT — deliberately, so a live connection can
      // never be dropped out from under the provenance that points at it. The
      // consequence for a fixture is that the order below is load-bearing:
      // orders, then listings, then the connection, then the store. Variants,
      // images, options, inventory levels and order items cascade from their own
      // parents, so those are not repeated here.
      for (const storeId of createdStoreIds.splice(0)) {
        await db.delete(ordersTable).where(eq(ordersTable.storeId, storeId));
        await db.delete(listings).where(eq(listings.storeId, storeId));
        await db.delete(connections).where(eq(connections.storeId, storeId));
        // Nothing in the connector path writes a native store link. #60's
        // `store_merchants` backfill stage does, over whatever stores are in the
        // database — and the suites share one, so a concurrent apply run can
        // attach a link to a store this file created between its last write and
        // this teardown. Reproduced since, on `store-linkage.realdb.test.ts`,
        // and the clear now lives in `deleteTestStores` for every fixture that
        // owns a store rather than in the two files that happened to hit it.
        await deleteTestStores(db, [storeId]);
      }
      for (const categoryId of createdCategoryIds.splice(0)) {
        await db.delete(categories).where(eq(categories.id, categoryId));
      }
    });

    afterAll(async () => {
      for (const [name, value] of previousEnv) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      await closePostgres();
    });

    /**
     * The harness's topic map and the provider's `inventoryWebhook` state the
     * same fact, so they are pinned against each other rather than left to
     * drift.
     *
     * They are separate because each is needed where the other cannot go: a
     * test must DELIVER an inventory webhook and needs the platform's own topic
     * string, while #87's merchant channel catalog must say "stock moves only on
     * a scheduled pull" and can see nothing inside `registerWebhooks`. This is
     * the assertion that stops a provider gaining an inventory webhook while the
     * catalog goes on telling merchants it has none.
     */
    it('declares an inventory webhook exactly when its topic map names one', () => {
      expect(harness.capabilities.inventoryWebhook).toBe(
        harness.topics.inventoryUpdate !== undefined,
      );
    });

    /**
     * Run the provider's own connect path for `storeId`.
     *
     * Extracted because #218's cases RE-connect deliberately: webhook
     * registration happens inside the connect, so a case that wants to observe a
     * refusal, a reconnect or an orphaned shop has to arrange the world and then
     * run the real thing again — not call a registration helper the production
     * path does not use.
     */
    async function connectStore(storeId: string): Promise<ConnectionRow> {
      return harness.providerId === 'woocommerce'
        ? connectWithApiKey(storeId, harness.providerId, {
            shopDomain: harness.shopDomain,
            consumerKey: 'ck_contract',
            consumerSecret: 'cs_contract',
          })
        : connectAndVerify(storeId, harness.providerId, {
            code: 'contract-auth-code',
            shopDomain: harness.shopDomain,
            redirectUri: 'https://api.mercaria.test/channels/oauth/shopify/callback',
          });
    }

    /**
     * Stand up a store, its import category, its default location, the fake
     * platform and a CONNECTED connection — through the real connect path, so a
     * broken exchange or a broken currency validation fails here rather than
     * being configured around.
     */
    async function makeFixture(options?: {
      products?: 'off' | 'pull' | 'bidirectional';
      inventory?: 'off' | 'pull';
      orders?: 'off' | 'pull' | 'bidirectional';
      autoPublish?: boolean;
      conflictPolicy?: 'respect_overrides' | 'connector_wins';
      world?: ContractWorld;
    }): Promise<ContractFixture> {
      const suffix = uuidv7();
      const store = await insertStore(
        {
          handle: `connector-contract-${suffix}`,
          name: 'Connector contract store',
          description: '',
          brandColor: '#123456',
          defaultCurrency: 'FAIR',
        },
        [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
      );
      createdStoreIds.push(store.id);

      // TWO locations, and the connection's target is deliberately NOT the
      // default (#259 defect B). A fixture where the two coincide cannot see the
      // failure it is supposed to gate: `updateVariant` routed every absolute
      // stock set to the store DEFAULT while the connector stocked at its
      // TARGET, so unselling a removed variant inserted a 0 beside the surviving
      // stock, `recomputeVariantScalarFromLevels` summed them, and the variant
      // stayed on sale — with the contract suite green throughout.
      const defaultLocation = await insertLocation(store.id, {
        name: 'Default location',
        type: 'warehouse',
        isDefault: true,
        isActive: true,
        fulfillsOnlineOrders: true,
      });
      const location = await insertLocation(store.id, {
        name: 'Connector target location',
        type: 'warehouse',
        isDefault: false,
        isActive: true,
        fulfillsOnlineOrders: true,
      });

      const category = await insertCategory({
        key: `contract-imports-${suffix}`,
        name: 'Contract imports',
        slug: `contract-imports-${suffix}`,
      });
      createdCategoryIds.push(category.id);
      process.env.CONNECTOR_DEFAULT_CATEGORY_SLUG = category.slug;

      const world = options?.world ?? harness.createWorld();
      harness.installProvider(harness.createProvider(world));

      const connection = await connectStore(store.id);

      const configured = await updateSyncSettingsColumns(store.id, connection.id, {
        products: options?.products ?? 'pull',
        inventory: options?.inventory ?? 'pull',
        orders: options?.orders ?? 'pull',
        autoPublish: options?.autoPublish ?? true,
        conflictPolicy: options?.conflictPolicy ?? 'respect_overrides',
        targetLocationId: location.id,
      });
      expect(configured, 'the connection this fixture just created must be readable').not.toBeNull();

      return {
        storeId: store.id,
        categorySlug: category.slug,
        locationId: location.id,
        defaultLocationId: defaultLocation.id,
        // `updateSyncSettings` returns the row it wrote; the expect above proves it.
        connection: configured as ConnectionRow,
        world,
      };
    }

    /**
     * The orders this connection imported.
     *
     * Read straight off the table rather than through a repository: the order
     * repository has no by-source-connection reader, and inventing one to serve a
     * test would put a query in production nothing calls.
     */
    async function importedOrders(connectionId: string) {
      return db.select().from(ordersTable).where(eq(ordersTable.sourceConnectionId, connectionId));
    }

    /** The listing this connection imported for `externalId`, or a failed expectation. */
    async function importedListing(fixture: ContractFixture, externalId: string) {
      const listing = await findListingBySourceExternalId(
        fixture.storeId,
        fixture.connection.id,
        externalId,
      );
      expect(listing, `no listing was imported for external id ${externalId}`).not.toBeNull();
      return listing as NonNullable<typeof listing>;
    }

    // --- SCENARIOS 1 + 9: connect, reconnect, revoke, recover ----------------

    describe('credentials', () => {
      it('CONNECTS once and a RECONNECT keeps ONE row, refreshed rather than duplicated', async () => {
        const fixture = await makeFixture();

        // A second authorization for the same shop — the merchant re-installing,
        // or two callbacks racing. `UNIQUE(store_id, provider)` is what makes this
        // an update; a read-then-branch would race itself.
        const reconnected =
          harness.providerId === 'woocommerce'
            ? await connectWithApiKey(fixture.storeId, harness.providerId, {
                shopDomain: harness.shopDomain,
                consumerKey: 'ck_rotated',
                consumerSecret: 'cs_rotated',
              })
            : await connectAndVerify(fixture.storeId, harness.providerId, {
                code: 'second-auth-code',
                shopDomain: harness.shopDomain,
                redirectUri: 'https://api.mercaria.test/channels/oauth/shopify/callback',
              });

        expect(reconnected.id).toBe(fixture.connection.id);
        const all = await findConnectionsByStore(fixture.storeId);
        expect(all).toHaveLength(1);
        expect(all[0].status).toBe('connected');
        expect(all[0].hasCredentials).toBe(true);
        // The sync settings the merchant configured survive a reconnect — the
        // upsert must not reset a connection to its column defaults.
        expect(all[0].syncSettingsProducts).toBe('pull');
      });

      it('DISCONNECT clears every credential column, and the row survives', async () => {
        const fixture = await makeFixture();

        const disconnected = await disconnect(fixture.storeId, fixture.connection.id, 'keep_listings');

        expect(disconnected.status).toBe('disconnected');
        expect(disconnected.hasCredentials).toBe(false);
        expect(await findConnectionCredentials(fixture.connection.id)).toBeNull();
        // Provenance on already-imported listings has to stay meaningful, so the
        // row is kept rather than deleted.
        expect(await findConnection(fixture.storeId, fixture.connection.id)).not.toBeNull();
      });

      it('a REVOKED credential fails the run and archives NOTHING', async () => {
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);
        const before = await findListingsBySourceConnection(fixture.storeId, fixture.connection.id);
        expect(before.length).toBeGreaterThan(0);

        // The merchant uninstalled the app / rotated the key: every read 401s.
        fixture.world.fail('/products', 401, 99);
        const run = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(run.status).toBe('failed');
        const after = await findListingsBySourceConnection(fixture.storeId, fixture.connection.id);
        // THE property: a credential failure must never look like "the merchant
        // deleted their catalogue". Delete reconciliation is unreachable from the
        // failure path, and this is what asserts it.
        expect(after.filter((listing) => listing.status === 'archived')).toHaveLength(0);
        const connection = await findConnection(fixture.storeId, fixture.connection.id);
        expect(connection?.status).toBe('error');
      });

      it('RECOVERS after the credential is restored — the next run completes and re-syncs', async () => {
        const fixture = await makeFixture();
        fixture.world.fail('/products', 401, 1);
        expect((await runBackfill(fixture.storeId, fixture.connection.id)).status).toBe('failed');

        const recovered = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(recovered.status).toBe('completed');
        expect(recovered.countsCreated).toBe(fixture.world.products.length);
        const connection = await findConnection(fixture.storeId, fixture.connection.id);
        expect(connection?.status).toBe('connected');
      });

      it('an INSUFFICIENT-PERMISSION 403 fails the run and archives NOTHING', async () => {
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);

        // WooCommerce scenario 7: a REST key issued read-only, or a scope the
        // Shopify app was never granted. The connector cannot tell it from a
        // revocation and must not: both mean "do not conclude anything".
        fixture.world.fail('/products', 403, 99);
        const run = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(run.status).toBe('failed');
        expect(run.error).toBeTruthy();
        const after = await findListingsBySourceConnection(fixture.storeId, fixture.connection.id);
        expect(after.filter((listing) => listing.status === 'archived')).toHaveLength(0);
      });
    });

    // --- #218: webhook registration is durable and idempotent ---------------

    describe('webhook registration', () => {
      /** The delivery URL this provider's subscriptions carry for `connectionId`. */
      function deliveryUrlFor(connectionId: string): string {
        const address = `https://api.mercaria.test/channels/webhooks/${harness.providerId}`;
        return harness.webhookSecretStrategy === 'per_connection'
          ? `${address}/${encodeURIComponent(connectionId)}`
          : address;
      }

      /**
       * Put a connected fixture back into the state a FIRST registration starts
       * from — nothing on the platform, nothing recorded — so a fault armed
       * afterwards is exercised by every provider.
       *
       * Without it the two reconcile modes diverge on this setup rather than on
       * the property under test: an `app_secret` provider adopts what is already
       * there and never issues the create the fault is waiting for.
       */
      async function resetRegistration(fixture: ContractFixture): Promise<void> {
        fixture.world.webhooks.splice(0, fixture.world.webhooks.length);
        fixture.world.deletedWebhookIds.splice(0, fixture.world.deletedWebhookIds.length);
        await recordConnectionWebhookRegistration(fixture.connection.id, {
          outcome: 'reconciled',
          webhookIds: [],
          failures: [],
        });
      }

      it('SUBSCRIBES every topic and PERSISTS the ids the platform created', async () => {
        const fixture = await makeFixture();

        // The connection ROW, not the object `makeFixture` was handed: the
        // property under test is that the ids reached the DATABASE, which is
        // exactly what #218 lost.
        const stored = await findConnection(fixture.storeId, fixture.connection.id);
        expect(stored?.webhookIds.length).toBeGreaterThan(0);
        expect([...(stored?.webhookIds ?? [])].sort()).toEqual(
          fixture.world.webhooks.map((webhook) => webhook.id).sort(),
        );
        for (const webhook of fixture.world.webhooks) {
          expect(webhook.deliveryUrl).toBe(deliveryUrlFor(fixture.connection.id));
        }
        expect(await findConnectionWebhookFailures([fixture.connection.id])).toEqual(new Map());
      });

      it('PERSISTS the ids it DID create when the platform refuses a topic, and NAMES the refusal', async () => {
        // The whole of #218 in one case. The platform refuses ONE create and
        // answers the rest; before the fix the ids already created were
        // discarded — live subscriptions Mercaria held no id for — and on a
        // `per_connection` provider the signing secret went with them, so every
        // delivery 401'd forever.
        //
        // The fault is scoped to the CREATE verb: both platforms serve the list
        // and the create from one path, and a URL-only fault would refuse the
        // list, at which point the connector correctly declines to create
        // anything and this case would be measuring the wrong refusal.
        const fixture = await makeFixture();
        await resetRegistration(fixture);
        fixture.world.fail(harness.webhookPathFragment, 403, 1, {}, 'POST');

        await connectStore(fixture.storeId);

        const stored = await findConnection(fixture.storeId, fixture.connection.id);
        expect(
          stored?.webhookIds.length,
          'the subscriptions the platform DID create must be persisted',
        ).toBeGreaterThan(0);
        expect([...(stored?.webhookIds ?? [])].sort()).toEqual(
          fixture.world.webhooks.map((webhook) => webhook.id).sort(),
        );

        const failures = (await findConnectionWebhookFailures([fixture.connection.id])).get(
          fixture.connection.id,
        );
        expect(failures).toHaveLength(1);
        expect(failures?.[0].reason).toBe('permission_denied');
        expect(failures?.[0].httpStatus).toBe(403);
        // The merchant surface names the TOPIC, so the refused one has to be a
        // real topic that is genuinely absent from the platform — not whatever
        // string came back, and not one that also got registered.
        expect(fixture.world.webhooks.map((webhook) => webhook.topic)).not.toContain(
          failures?.[0].topic,
        );
      });

      it('does NOT erase the ids it holds when the platform will not LIST them', async () => {
        // #218's first consequence, end to end. The platform answers nothing at
        // all about its subscriptions; NONE was created and none was deleted, so
        // every id already stored still names something live. Writing `[]` over
        // them — which is what an empty `subscriptions` array meant — makes the
        // disconnect below delete nothing and leaves them delivering forever.
        //
        // It also proves the registration RETURNED rather than threw: a throw is
        // caught one frame up and returns WITHOUT writing, so the recorded
        // refusals could not exist.
        const fixture = await makeFixture();
        const before = await findConnection(fixture.storeId, fixture.connection.id);
        expect(before?.webhookIds.length, 'the premise: ids to erase').toBeGreaterThan(0);
        fixture.world.fail(harness.webhookPathFragment, 403, 99, {}, 'GET');

        await connectStore(fixture.storeId);

        const stored = await findConnection(fixture.storeId, fixture.connection.id);
        expect(stored?.webhookIds).toEqual(before?.webhookIds);
        // Every desired topic is reported refused, because none of those events
        // will arrive — the honest merchant-facing answer to "I could not find
        // out", which is a different fact from "there are none".
        const failures = (await findConnectionWebhookFailures([fixture.connection.id])).get(
          fixture.connection.id,
        );
        expect(failures?.length).toBeGreaterThan(0);
        expect(failures?.every((failure) => failure.reason === 'permission_denied')).toBe(true);
      });

      it('KEEPS the ids of subscriptions the platform would not DELETE', async () => {
        // A duplicate at our exact delivery URL, and a platform that refuses to
        // remove anything. Both providers reach the delete: an `app_secret` one
        // adopts the first and tries to remove the duplicate, a `per_connection`
        // one deletes before it recreates. Either way BOTH subscriptions are
        // still live at our address when the attempt finishes, so Mercaria must
        // hold both ids — they are the only handle a later reconcile or the
        // disconnect can remove them by. Dropping one is #218 in miniature.
        const fixture = await makeFixture();
        const original = fixture.world.webhooks[0];
        expect(original, 'the premise: a registered subscription to duplicate').toBeTruthy();
        const duplicate = {
          id: 'wh-stubborn-duplicate',
          topic: original.topic,
          deliveryUrl: deliveryUrlFor(fixture.connection.id),
          status: 'active' as const,
          failureCount: 0,
        };
        fixture.world.webhooks.push(duplicate);
        fixture.world.fail(harness.webhookDeletePathFragment, 403, 99, {}, 'DELETE');

        await connectStore(fixture.storeId);

        expect(
          fixture.world.webhooks.map((webhook) => webhook.id),
          'the premise: the platform really refused the delete',
        ).toContain(duplicate.id);
        const stored = await findConnection(fixture.storeId, fixture.connection.id);
        expect(stored?.webhookIds).toContain(duplicate.id);
        expect(stored?.webhookIds).toContain(original.id);
      });

      it('stores a webhook secret that verifies the subscriptions it CREATED', async () => {
        // The property the whole adopt-vs-recreate split exists for, and nothing
        // read it back until now. A `per_connection` platform fixes the secret
        // AT CREATION and never discloses it again, so the stored envelope has
        // to decrypt to the exact string every live subscription was created
        // with — otherwise `/channels/webhooks/woocommerce/:id` answers 401 to
        // every delivery, permanently, which is #218's worst half.
        const fixture = await makeFixture();
        const envelope = await findConnectionWebhookSecret(
          fixture.connection.id,
          harness.providerId,
        );

        if (harness.webhookSecretStrategy !== 'per_connection') {
          // An `app_secret` provider mints none, and storing one would be a
          // second secret nothing verifies with. Both halves are measured so a
          // provider that changed strategy cannot report the same green.
          expect(envelope).toBeNull();
          expect(fixture.world.webhooks.every((webhook) => webhook.secret === undefined)).toBe(true);
          return;
        }

        expect(envelope, 'a per-connection provider must store its secret').not.toBeNull();
        const stored = decryptSecret(envelope as NonNullable<typeof envelope>);
        expect(fixture.world.webhooks.length).toBeGreaterThan(0);
        for (const webhook of fixture.world.webhooks) {
          expect(
            webhook.secret,
            `${webhook.topic} was created with a secret Mercaria did not store`,
          ).toBe(stored);
        }
      });

      it('does NOT replace the stored secret when the attempt created NOTHING', async () => {
        // The reason a retained subscription is distinguishable from a created
        // one. Every delete is refused, so a `per_connection` provider blocks
        // every recreate and creates nothing — while its ids are all retained,
        // because those subscriptions are still live. Reading "there are
        // subscriptions" as "we created some" would store the fresh secret this
        // attempt minted, over the one that actually verifies every live
        // delivery, and every delivery would 401 from then on.
        const fixture = await makeFixture();
        const envelope = await findConnectionWebhookSecret(
          fixture.connection.id,
          harness.providerId,
        );
        if (harness.webhookSecretStrategy !== 'per_connection') {
          expect(envelope).toBeNull();
          return;
        }
        const before = decryptSecret(envelope as NonNullable<typeof envelope>);
        fixture.world.fail(harness.webhookDeletePathFragment, 403, 99, {}, 'DELETE');

        await connectStore(fixture.storeId);

        expect(
          fixture.world.webhooks.every((webhook) => webhook.secret === before),
          'the premise: nothing new was created, so every live subscription still carries the old secret',
        ).toBe(true);
        const after = await findConnectionWebhookSecret(fixture.connection.id, harness.providerId);
        expect(decryptSecret(after as NonNullable<typeof after>)).toBe(before);
      });

      it('a RECONNECT leaves ONE subscription per topic, not two sets', async () => {
        const fixture = await makeFixture();
        const firstTopics = fixture.world.webhooks.map((webhook) => webhook.topic).sort();
        expect(firstTopics.length).toBeGreaterThan(0);

        await connectStore(fixture.storeId);

        const topics = fixture.world.webhooks.map((webhook) => webhook.topic);
        expect(new Set(topics).size, 'a reconnect must not add a second set').toBe(topics.length);
        expect(topics.sort()).toEqual(firstTopics);
        const stored = await findConnection(fixture.storeId, fixture.connection.id);
        expect([...(stored?.webhookIds ?? [])].sort()).toEqual(
          fixture.world.webhooks.map((webhook) => webhook.id).sort(),
        );
      });

      it('CONVERGES a shop whose live subscriptions Mercaria holds no id for', async () => {
        // The state a deployment broken by #218 is ALREADY in: subscriptions
        // live on the platform, `webhook_ids` empty. Deleting `conn.webhookIds`
        // first — what the service used to do — converges nothing here, because
        // there is nothing in it to delete, and the next create adds a second
        // full set. Reconciling against the PLATFORM's own list is the only
        // thing that does.
        const fixture = await makeFixture();
        const orphanTopics = fixture.world.webhooks.map((webhook) => webhook.topic).sort();
        expect(orphanTopics.length).toBeGreaterThan(0);
        await recordConnectionWebhookRegistration(fixture.connection.id, {
          outcome: 'reconciled',
          webhookIds: [],
          failures: [],
        });

        await connectStore(fixture.storeId);

        const topics = fixture.world.webhooks.map((webhook) => webhook.topic);
        expect(new Set(topics).size, 'an orphan must not become a duplicate').toBe(topics.length);
        expect(topics.sort()).toEqual(orphanTopics);
        const stored = await findConnection(fixture.storeId, fixture.connection.id);
        expect(
          [...(stored?.webhookIds ?? [])].sort(),
          'every live subscription must now be one Mercaria can delete',
        ).toEqual(fixture.world.webhooks.map((webhook) => webhook.id).sort());
      });

      it("LEAVES another connection's subscriptions alone", async () => {
        // The reconcile compares the delivery URL EXACTLY. This subscription is
        // deliberately shaped as the sibling that a `startsWith` would swallow:
        // the connector's own webhook ADDRESS plus a different connection's id.
        // Deleting it is a cross-store deletion dressed as tidying up.
        //
        // The per-connection half of the same property — connection A's
        // reconcile against connection B's URL under one base — is pinned in
        // `__tests__/webhook-registration.test.ts`, where a `ContractWorld` for
        // one store cannot construct a second connection to be wrong about.
        const fixture = await makeFixture();
        const foreign = {
          id: 'wh-someone-else',
          topic: harness.topics.productUpsert,
          deliveryUrl: `https://api.mercaria.test/channels/webhooks/${harness.providerId}/some-other-connection`,
          status: 'active' as const,
          failureCount: 0,
        };
        fixture.world.webhooks.push(foreign);

        await connectStore(fixture.storeId);

        expect(fixture.world.webhooks).toContainEqual(foreign);
        expect(fixture.world.deletedWebhookIds).not.toContain(foreign.id);
        const stored = await findConnection(fixture.storeId, fixture.connection.id);
        expect(stored?.webhookIds).not.toContain(foreign.id);
      });

      it('DISCONNECT deletes every subscription it holds an id for, and forgets the refusals', async () => {
        const fixture = await makeFixture();
        await resetRegistration(fixture);
        fixture.world.fail(harness.webhookPathFragment, 403, 1, {}, 'POST');
        await connectStore(fixture.storeId);
        const registered = fixture.world.webhooks.map((webhook) => webhook.id).sort();
        expect(registered.length).toBeGreaterThan(0);
        expect(
          (await findConnectionWebhookFailures([fixture.connection.id])).get(fixture.connection.id),
        ).toHaveLength(1);
        fixture.world.deletedWebhookIds.splice(0, fixture.world.deletedWebhookIds.length);

        await disconnect(fixture.storeId, fixture.connection.id, 'keep_listings');

        // A PARTIAL registration is disconnectable — the half #218 made
        // impossible, because the ids were never stored to delete by.
        expect(fixture.world.deletedWebhookIds.sort()).toEqual(registered);
        expect(await findConnectionWebhookFailures([fixture.connection.id])).toEqual(new Map());
      });

      it('DISCONNECT deletes a live subscription Mercaria holds NO id for', async () => {
        // Registration was taught to converge by reading the platform; this is
        // disconnect being brought along. `wh-orphan` is what a registration
        // that threw between the platform call and the database write leaves
        // behind: live at our exact delivery URL, absent from `webhook_ids`.
        // Trusting the stored ids walks straight past it and leaves it
        // delivering to an endpoint whose connection is gone — consequence 1 of
        // the issue, arriving by a second route.
        const fixture = await makeFixture();
        const orphan = {
          id: 'wh-orphan',
          topic: harness.topics.productUpsert,
          deliveryUrl: deliveryUrlFor(fixture.connection.id),
          status: 'active' as const,
          failureCount: 0,
        };
        fixture.world.webhooks.push(orphan);
        const stored = await findConnection(fixture.storeId, fixture.connection.id);
        expect(
          stored?.webhookIds,
          'the premise: Mercaria must NOT hold this id',
        ).not.toContain(orphan.id);
        fixture.world.deletedWebhookIds.splice(0, fixture.world.deletedWebhookIds.length);

        await disconnect(fixture.storeId, fixture.connection.id, 'keep_listings');

        expect(fixture.world.deletedWebhookIds).toContain(orphan.id);
        // And the ids it DID hold, so reading the platform ADDS to the set
        // rather than replacing it: a stored id the platform no longer lists is
        // still worth a delete, and both providers answer an absent one as an
        // idempotent success.
        for (const id of stored?.webhookIds ?? []) {
          expect(fixture.world.deletedWebhookIds).toContain(id);
        }
        expect(fixture.world.webhooks).toEqual([]);
      });

      it('DISCONNECT spares platform-discovered ids when another connection SHARES the address', async () => {
        // Both branches in one case, because the discriminant is a property of
        // the PROVIDER: Shopify delivers every shop's events to one app-wide
        // address, so a second Mercaria store on the same shop resolves to the
        // SAME delivery URL and the platform sweep would take its live set;
        // WooCommerce's URL carries the connection id, so a sibling's
        // subscriptions are at a different URL and the sweep is safe.
        //
        // It matters more than a tidy-up because nothing puts a swept sibling
        // back: `registerConnectionWebhooks` runs on CONNECT and nowhere else,
        // so the shop would stay dark until a person reconnected it.
        const fixture = await makeFixture();
        const suffix = uuidv7();
        const siblingStore = await insertStore(
          {
            handle: `connector-contract-sibling-${suffix}`,
            name: 'Sibling store on the same shop',
            description: '',
            brandColor: '#123456',
            defaultCurrency: 'FAIR',
          },
          [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
        );
        createdStoreIds.push(siblingStore.id);
        const siblingConnection = await connectStore(siblingStore.id);

        // Pushed AFTER the sibling connects, so it is an orphan neither
        // connection holds an id for — the state a registration that threw
        // between the platform call and the database write leaves behind.
        const orphan = {
          id: 'wh-shared-address-orphan',
          topic: harness.topics.productUpsert,
          deliveryUrl: deliveryUrlFor(fixture.connection.id),
          status: 'active' as const,
          failureCount: 0,
        };
        fixture.world.webhooks.push(orphan);
        const stored = await findConnection(fixture.storeId, fixture.connection.id);
        fixture.world.deletedWebhookIds.splice(0, fixture.world.deletedWebhookIds.length);

        await disconnect(fixture.storeId, fixture.connection.id, 'keep_listings');

        const addressIsShared =
          deliveryUrlFor(siblingConnection.id) === deliveryUrlFor(fixture.connection.id);
        expect(
          addressIsShared,
          'the shared-address branch belongs to the app-wide-address providers',
        ).toBe(harness.webhookSecretStrategy !== 'per_connection');
        if (addressIsShared) {
          expect(fixture.world.deletedWebhookIds).not.toContain(orphan.id);
          expect(fixture.world.webhooks.map((webhook) => webhook.id)).toContain(orphan.id);
        } else {
          expect(fixture.world.deletedWebhookIds).toContain(orphan.id);
        }
        // Either way this connection's OWN ids go — they are its own record.
        for (const id of stored?.webhookIds ?? []) {
          expect(fixture.world.deletedWebhookIds).toContain(id);
        }
      });

      it('DISCONNECT still deletes the stored ids when the platform will not LIST', async () => {
        // The other half of the union. An expired token, a 5xx or a revoked
        // scope makes the platform's list unreadable — which must not turn a
        // disconnect into a no-op, because the stored ids are then the only
        // handle anyone has.
        const fixture = await makeFixture();
        const stored = await findConnection(fixture.storeId, fixture.connection.id);
        expect(stored?.webhookIds.length, 'the premise: ids to delete').toBeGreaterThan(0);
        fixture.world.deletedWebhookIds.splice(0, fixture.world.deletedWebhookIds.length);
        fixture.world.fail(harness.webhookPathFragment, 500, 99, {}, 'GET');

        await disconnect(fixture.storeId, fixture.connection.id, 'keep_listings');

        expect(fixture.world.deletedWebhookIds.sort()).toEqual([...(stored?.webhookIds ?? [])].sort());
      });

      it('ENUMERATES the platform subscription list across every PAGE', async () => {
        // A truncated list is read as "these are all the subscriptions that
        // exist", so every subscription past the page boundary is invisible:
        // adopted by nobody, deleted by nobody, and duplicated by the create
        // that follows. That happens on exactly the shops this reconcile exists
        // to rescue, because they are the ones carrying accumulated orphans.
        const fixture = await makeFixture();
        const registered = fixture.world.webhooks.map((webhook) => webhook.id).sort();
        expect(registered.length, 'the premise: more than one page worth').toBeGreaterThan(1);
        // ONE subscription per page, so every topic but the first sits behind a
        // cursor the provider has to follow.
        fixture.world.pageSize = 1;
        const beyondFirstPage = fixture.world.webhooks[1];
        // The floor's baseline. `world.calls` accumulates from the fixture's own
        // connect, so the count that means anything is the DELTA across the
        // reconnect below.
        const listReadsBefore = fixture.world
          .callsMatching(harness.webhookPathFragment)
          .filter((call) => call.method === 'GET').length;

        await connectStore(fixture.storeId);

        // THE VACUITY FLOOR, and it guards this case rather than the connector.
        // `world.pageSize` is an INPUT the fake is free to ignore: a fake that
        // answered the whole list on one page would make every assertion below
        // pass while measuring nothing, because with nothing past a boundary
        // there is no boundary to mishandle. That is not hypothetical — the
        // paging this relies on is a hunk in the shared WooCommerce fake that a
        // three-way merge could drop, and losing it must turn this case RED
        // rather than quietly green.
        const listReads =
          fixture.world.callsMatching(harness.webhookPathFragment).filter((call) => call.method === 'GET')
            .length - listReadsBefore;
        expect(
          listReads,
          'the fake served the whole list on one page — this case measured nothing',
        ).toBeGreaterThan(1);

        const topics = fixture.world.webhooks.map((webhook) => webhook.topic);
        expect(new Set(topics).size, 'a topic past the page boundary was duplicated').toBe(
          topics.length,
        );
        const stored = await findConnection(fixture.storeId, fixture.connection.id);
        // NAMED rather than counted: a count survives a truncated list that
        // dropped one subscription and created another in its place.
        expect(
          fixture.world.webhooks.map((webhook) => webhook.topic),
          'the subscription on page two must still be the shop\'s only one for its topic',
        ).toContain(beyondFirstPage.topic);
        expect([...(stored?.webhookIds ?? [])].sort()).toEqual(
          fixture.world.webhooks.map((webhook) => webhook.id).sort(),
        );
      });

      it('NEVER throws out of a registration, whatever the platform answers', async () => {
        // Per-topic fault tolerance is a CONTRACT, not an implementation
        // detail, and a throw is how #218 discarded the ids in the first place.
        // `registerConnectionWebhooks` catches a throw and returns WITHOUT
        // writing anything, so a recorded refusal is the observable proof that
        // the provider ANSWERED with a value.
        //
        // Two phases, because one fault schedule cannot exercise all three
        // verbs: a refused LIST correctly stops the attempt before any create
        // or delete is issued, so arming everything at once would leave the
        // create and delete faults unconsumed and the case would claim more
        // than it measured.
        const fixture = await makeFixture();

        // Phase 1 — the create AND the delete refuse, with the list readable.
        // The duplicate is what guarantees a DELETE is issued on an `app_secret`
        // provider, which otherwise adopts and deletes nothing.
        fixture.world.webhooks.push({
          id: 'wh-throws-duplicate',
          topic: fixture.world.webhooks[0].topic,
          deliveryUrl: deliveryUrlFor(fixture.connection.id),
          status: 'active',
          failureCount: 0,
        });
        fixture.world.fail(harness.webhookPathFragment, 500, 99, {}, 'POST');
        fixture.world.fail(harness.webhookDeletePathFragment, 500, 99, {}, 'DELETE');

        const afterWrites = await connectStore(fixture.storeId);

        expect(afterWrites.status).toBe('connected');
        expect(
          fixture.world.callsMatching(harness.webhookDeletePathFragment).length,
          'the premise: a DELETE was actually issued and refused',
        ).toBeGreaterThan(0);
        const stored = await findConnection(fixture.storeId, fixture.connection.id);
        expect(stored?.webhookIds).toContain('wh-throws-duplicate');

        // Phase 2 — the LIST refuses, which is the branch that knows nothing.
        fixture.world.fail(harness.webhookPathFragment, 500, 99, {}, 'GET');

        const afterListing = await connectStore(fixture.storeId);

        expect(afterListing.status).toBe('connected');
        const failures = (await findConnectionWebhookFailures([fixture.connection.id])).get(
          fixture.connection.id,
        );
        expect(failures?.length).toBeGreaterThan(0);
        expect(failures?.every((failure) => failure.reason === 'platform_error')).toBe(true);
      });
    });

    // --- #262: the trigger that re-runs a registration ----------------------

    describe('webhook RE-registration', () => {
      /** The delivery URL this provider's subscriptions carry for `connectionId`. */
      function deliveryUrlFor(connectionId: string): string {
        const address = `https://api.mercaria.test/channels/webhooks/${harness.providerId}`;
        return harness.webhookSecretStrategy === 'per_connection'
          ? `${address}/${encodeURIComponent(connectionId)}`
          : address;
      }

      /**
       * Connect a fixture and leave ONE topic refused, the way a real shop is
       * left when a scope is too narrow at connect time.
       *
       * The registration is reset first so both reconcile modes issue the CREATE
       * the fault is waiting for — an `app_secret` provider otherwise adopts what
       * is already there and never creates anything.
       */
      async function leaveOneTopicRefused(
        fixture: ContractFixture,
        status: number,
      ): Promise<string> {
        fixture.world.webhooks.splice(0, fixture.world.webhooks.length);
        fixture.world.deletedWebhookIds.splice(0, fixture.world.deletedWebhookIds.length);
        await recordConnectionWebhookRegistration(fixture.connection.id, {
          outcome: 'reconciled',
          webhookIds: [],
          failures: [],
        });
        fixture.world.fail(harness.webhookPathFragment, status, 1, {}, 'POST');
        await connectStore(fixture.storeId);
        const failures = (await findConnectionWebhookFailures([fixture.connection.id])).get(
          fixture.connection.id,
        );
        expect(failures, 'the premise: a topic really was refused').toHaveLength(1);
        return (failures ?? [])[0].topic;
      }

      it('RE-REGISTERS a refused topic with no reconnect, and CLEARS the refusal', async () => {
        // #262 in one case. Before it, `registerConnectionWebhooks` had exactly
        // two call sites, both on CONNECT, so a shop left in this state stayed in
        // it until a person re-authorized the channel — which for Shopify is the
        // whole OAuth round trip and for WooCommerce a fresh API key, for a
        // problem that is usually a scope they have since widened.
        const fixture = await makeFixture();
        const refusedTopic = await leaveOneTopicRefused(fixture, 500);
        expect(fixture.world.webhooks.map((webhook) => webhook.topic)).not.toContain(refusedTopic);

        const outcome = await reregisterConnectionWebhooks(
          fixture.storeId,
          fixture.connection.id,
          { countsAsAttempt: true },
        );

        expect(outcome).toBe('registered');
        // The refused topic is now live, exactly once, and the connection holds
        // the platform's WHOLE set rather than only what this attempt made.
        expect(fixture.world.webhooks.map((webhook) => webhook.topic)).toContain(refusedTopic);
        const topics = fixture.world.webhooks.map((webhook) => webhook.topic);
        expect(new Set(topics).size, 'a re-registration must not add a second set').toBe(
          topics.length,
        );
        const stored = await findConnection(fixture.storeId, fixture.connection.id);
        expect([...(stored?.webhookIds ?? [])].sort()).toEqual(
          fixture.world.webhooks.map((webhook) => webhook.id).sort(),
        );
        expect(await findConnectionWebhookFailures([fixture.connection.id])).toEqual(new Map());
        // And the DTO SAYS SO (#297). This used to assert `undefined`, because a
        // successful registration wrote `pending` and the serializer's only way
        // to stop a healthy connection reading as "never attempted" was to omit
        // the field. The state now has a success value, so the honest assertion
        // is the positive one — and it is strictly stronger: `undefined` was
        // also what a connection nobody had ever tried produced, so the old
        // assertion held for the case this one exists to distinguish.
        expect(
          (await toConnectionDTOWithWebhookFailures(stored as ConnectionRow)).webhookRegistration,
        ).toEqual({ state: 'registered', attempts: 0 });
      });

      it('the derived POPULATION finds it, and a healthy connection is not in it', async () => {
        // The population is derived rather than stored, so it needs BOTH a
        // positive and a negative control — and the assertions are CONTAINMENT
        // rather than equality, because one throwaway database is shared by the
        // whole run and a sibling file's connection is legitimately in the set.
        const healthy = await makeFixture();
        const broken = await makeFixture({ world: harness.createWorld() });
        await leaveOneTopicRefused(broken, 500);

        const ids = (await findConnectionsNeedingWebhookRegistration({ limit: 500 })).map(
          (row) => row.id,
        );

        expect(ids).toContain(broken.connection.id);
        // The negative control this file OWNS. Without it a population that
        // returned every connection in the database would pass the line above.
        expect(ids).not.toContain(healthy.connection.id);
      });

      it('a scope refusal STOPS retrying and says so, and drops out of the population', async () => {
        // The visible give-up. A credential that answered 403 answers 403 again,
        // so the honest outcome is a `dead_letter` a merchant can see beside the
        // topics that will not arrive — not twelve attempts nobody reads.
        const fixture = await makeFixture();
        const refusedTopic = await leaveOneTopicRefused(fixture, 403);
        // The platform goes on refusing that topic, which is what a too-narrow
        // grant does.
        fixture.world.fail(harness.webhookPathFragment, 403, 99, {}, 'POST');

        const outcome = await reregisterConnectionWebhooks(
          fixture.storeId,
          fixture.connection.id,
          { countsAsAttempt: true },
        );

        expect(outcome).toBe('dead_lettered');
        const stored = await findConnection(fixture.storeId, fixture.connection.id);
        const dto = await toConnectionDTOWithWebhookFailures(stored as ConnectionRow);
        expect(dto.webhookRegistration?.state).toBe('dead_letter');
        expect(dto.webhookRegistration?.nextAttemptAt).toBeUndefined();
        expect(dto.webhookFailures?.map((failure) => failure.topic)).toContain(refusedTopic);
        const ids = (await findConnectionsNeedingWebhookRegistration({ limit: 500 })).map(
          (row) => row.id,
        );
        expect(ids, 'a dead-lettered connection must not be swept again').not.toContain(
          fixture.connection.id,
        );
      });

      it('REUSES the stored webhook secret rather than rotating it', async () => {
        // The whole reason a re-registration does not mint. A `per_connection`
        // platform fixes a webhook's secret AT CREATION and never discloses it
        // again, and Mercaria holds no previous-secret grace for a connection —
        // so a fresh secret makes every delivery already queued under the old one
        // 401 until the swap lands. Recreating with the SAME secret leaves the
        // stored envelope verifying survivors and recreations alike.
        const fixture = await makeFixture();
        const before = await findConnectionWebhookSecret(
          fixture.connection.id,
          harness.providerId,
        );
        if (harness.webhookSecretStrategy !== 'per_connection') {
          // An `app_secret` provider mints none and must go on storing none, so a
          // provider that changed strategy cannot report the same green.
          expect(before).toBeNull();
          await reregisterConnectionWebhooks(fixture.storeId, fixture.connection.id, {
            countsAsAttempt: true,
          });
          expect(
            await findConnectionWebhookSecret(fixture.connection.id, harness.providerId),
          ).toBeNull();
          expect(fixture.world.webhooks.every((webhook) => webhook.secret === undefined)).toBe(
            true,
          );
          return;
        }

        expect(before, 'the premise: a stored secret to reuse').not.toBeNull();
        const secret = decryptSecret(before as NonNullable<typeof before>);

        await reregisterConnectionWebhooks(fixture.storeId, fixture.connection.id, {
          countsAsAttempt: true,
        });

        // Every live subscription — including the ones this attempt recreated —
        // carries the secret the stored envelope still decrypts to.
        expect(fixture.world.webhooks.length).toBeGreaterThan(0);
        for (const webhook of fixture.world.webhooks) {
          expect(
            webhook.secret,
            `${webhook.topic} was recreated with a secret the stored envelope does not verify`,
          ).toBe(secret);
        }
        const after = await findConnectionWebhookSecret(fixture.connection.id, harness.providerId);
        expect(decryptSecret(after as NonNullable<typeof after>)).toBe(secret);
      });

      it("LEAVES a sibling connection's subscriptions alone at a SHARED delivery address", async () => {
        // #218's disconnect guard exists because Shopify delivers every shop's
        // events to ONE app-wide address, so a second Mercaria store on the same
        // shop resolves to the same URL. A re-registration has to be safe there in
        // a way a disconnect is not, and the reason is the reconcile MODE rather
        // than a guard: an `app_secret` provider ADOPTS what is already at the
        // address, and every Mercaria connection wants the same topic set, so the
        // sibling's rows are kept and both connections end up holding them.
        //
        // "It should be safe because it is idempotent" is how the original defect
        // got in, so it is measured rather than reasoned about.
        const fixture = await makeFixture();
        const suffix = uuidv7();
        const siblingStore = await insertStore(
          {
            handle: `connector-reregister-sibling-${suffix}`,
            name: 'Sibling store on the same shop',
            description: '',
            brandColor: '#123456',
            defaultCurrency: 'FAIR',
          },
          [{ oxyUserId: `owner-${suffix}`, role: 'owner', permissions: ['store:manage'] }],
        );
        createdStoreIds.push(siblingStore.id);
        const siblingConnection = await connectStore(siblingStore.id);
        const siblingBefore = await findConnection(siblingStore.id, siblingConnection.id);
        expect(siblingBefore?.webhookIds.length, 'the premise: the sibling holds ids').toBeGreaterThan(
          0,
        );
        const addressIsShared =
          deliveryUrlFor(siblingConnection.id) === deliveryUrlFor(fixture.connection.id);
        expect(
          addressIsShared,
          'the shared-address branch belongs to the app-wide-address providers',
        ).toBe(harness.webhookSecretStrategy !== 'per_connection');
        fixture.world.deletedWebhookIds.splice(0, fixture.world.deletedWebhookIds.length);

        await reregisterConnectionWebhooks(fixture.storeId, fixture.connection.id, {
          countsAsAttempt: true,
        });

        if (addressIsShared) {
          // Not one of the sibling's subscriptions was deleted, and every one is
          // still live for the topic it serves.
          for (const id of siblingBefore?.webhookIds ?? []) {
            expect(fixture.world.deletedWebhookIds).not.toContain(id);
            expect(fixture.world.webhooks.map((webhook) => webhook.id)).toContain(id);
          }
        } else {
          // A `per_connection` provider's sibling is at a DIFFERENT URL, so the
          // exact-URL comparison never reaches it — the wall is the same one that
          // stops a cross-store deletion.
          const siblingUrl = deliveryUrlFor(siblingConnection.id);
          expect(
            fixture.world.webhooks.some((webhook) => webhook.deliveryUrl === siblingUrl),
            "the sibling's own subscriptions must survive untouched",
          ).toBe(true);
        }
      });

      it('an UNCLAIMED pass registers NOTHING and never knocks at the platform', async () => {
        // The hazard the lease exists for is not a wasted call. On a
        // `per_connection` provider two passes each delete and recreate every
        // topic, and whichever finishes LAST stores its secret over the other's
        // while the other's subscriptions are the live ones — every delivery 401s
        // from then on, permanently and silently. The realistic racer is a
        // merchant pressing retry while the scheduled sweep is mid-flight.
        //
        // ## Why this HOLDS the lease instead of racing two passes
        //
        // It used to be two `reregisterConnectionWebhooks` calls under
        // `Promise.all`, which is the vacuous shape `~/Oxy/AGENTS.md` names:
        // `Promise.all` does not make statements interleave, postgres.js pipelines
        // onto one connection, and whether the second pass reaches its claim
        // BEFORE the first releases is a fact about the machine. It overlapped on
        // a 32-core box and serialized on CI, where the second pass claimed
        // legitimately after the first had finished — so zero refusals was the
        // correct answer to what the test actually asked, and the local green had
        // meant nothing.
        //
        // No race is needed, because the claim is a conditional UPDATE whose
        // empty `RETURNING` set IS the refusal rather than a `SKIP LOCKED` queue.
        // Holding the lease through the repository's own claim STATES the
        // precondition instead of hoping for it.
        const fixture = await makeFixture();
        const held = await claimConnectionWebhookRegistration({
          connectionId: fixture.connection.id,
          leaseOwner: 'contract-suite-holder',
          leaseMs: 60_000,
          countsAsAttempt: true,
        });
        expect(held, 'the premise: the lease was free and is now HELD').not.toBeNull();

        const callsBefore = fixture.world.calls.length;
        const subscriptionsBefore = fixture.world.webhooks.map((webhook) => webhook.id).sort();

        const refused = await reregisterConnectionWebhooks(
          fixture.storeId,
          fixture.connection.id,
          { countsAsAttempt: true },
        );

        expect(refused).toBe('not_claimed');
        // THE property, and the one the returned enum alone does not establish: a
        // pass that could not claim must not have touched the merchant's platform
        // at all. Counting the fake's own request log is what says so.
        expect(
          fixture.world.calls.length,
          'an unclaimed pass must not call the platform',
        ).toBe(callsBefore);
        expect(fixture.world.webhooks.map((webhook) => webhook.id).sort()).toEqual(
          subscriptionsBefore,
        );

        // THE POSITIVE CONTROL, in the same currency as the measurement: release
        // the lease and the SAME call does knock. Without it a fake transport that
        // had stopped being reachable at all would satisfy every assertion above —
        // "it did not call the platform" is also what a broken harness reports.
        expect(
          await releaseConnectionWebhookRegistration({
            connectionId: fixture.connection.id,
            leaseOwner: 'contract-suite-holder',
            deadLettered: false,
            nextAttemptAt: null,
          }),
          'the premise: the held lease was released by its owner',
        ).toBe(true);

        const allowed = await reregisterConnectionWebhooks(
          fixture.storeId,
          fixture.connection.id,
          { countsAsAttempt: true },
        );

        expect(allowed).toBe('registered');
        expect(
          fixture.world.calls.length,
          'the control: a CLAIMED pass does reach the platform',
        ).toBeGreaterThan(callsBefore);
        // And it left the shop consistent: one subscription per topic, every id
        // recorded.
        const topics = fixture.world.webhooks.map((webhook) => webhook.topic);
        expect(new Set(topics).size).toBe(topics.length);
        const stored = await findConnection(fixture.storeId, fixture.connection.id);
        expect([...(stored?.webhookIds ?? [])].sort()).toEqual(
          fixture.world.webhooks.map((webhook) => webhook.id).sort(),
        );
      });

      it('a DISCONNECTED channel is never re-registered', async () => {
        const fixture = await makeFixture();
        await disconnect(fixture.storeId, fixture.connection.id, 'keep_listings');
        fixture.world.webhooks.splice(0, fixture.world.webhooks.length);

        const outcome = await reregisterConnectionWebhooks(
          fixture.storeId,
          fixture.connection.id,
          { countsAsAttempt: true },
        );

        // The credentials are gone, so there is nothing to authenticate with —
        // and re-subscribing a channel a merchant disconnected would be the
        // sweep undoing their decision.
        expect(outcome).toBe('not_registerable');
        expect(fixture.world.webhooks).toEqual([]);
        const ids = (await findConnectionsNeedingWebhookRegistration({ limit: 500 })).map(
          (row) => row.id,
        );
        expect(ids).not.toContain(fixture.connection.id);
      });
    });

    // --- #295: the delivery address moved, and nothing noticed --------------

    describe('webhook AUDIT after a delivery-address change', () => {
      /** The delivery URL this provider's subscriptions carry for `connectionId`. */
      function deliveryUrlFor(connectionId: string): string {
        const address = `https://api.mercaria.test/channels/webhooks/${harness.providerId}`;
        return harness.webhookSecretStrategy === 'per_connection'
          ? `${address}/${encodeURIComponent(connectionId)}`
          : address;
      }

      /** The base this deployment is moved TO, mid-case. */
      const MOVED_BASE = 'https://api-moved.mercaria.test';

      /**
       * Move `CONNECTOR_OAUTH_REDIRECT_BASE_URL` and return the address the
       * connection's subscriptions OUGHT to carry afterwards.
       *
       * The env var and nothing else, because that is the whole of the real
       * trigger: a domain migration, a move between environments, a preview
       * deployment expiring. `afterAll` restores it — `REQUIRED_ENV` is captured
       * and put back by the suite's own hooks.
       */
      function moveDeliveryBase(connectionId: string): string {
        process.env.CONNECTOR_OAUTH_REDIRECT_BASE_URL = MOVED_BASE;
        const address = `${MOVED_BASE}/channels/webhooks/${harness.providerId}`;
        return harness.webhookSecretStrategy === 'per_connection'
          ? `${address}/${encodeURIComponent(connectionId)}`
          : address;
      }

      afterEach(() => {
        process.env.CONNECTOR_OAUTH_REDIRECT_BASE_URL =
          REQUIRED_ENV.CONNECTOR_OAUTH_REDIRECT_BASE_URL;
      });

      it('#295: the base URL moves, deliveries fail, and the audit leaves ONE live set', async () => {
        // The issue's own test, in its own order: register, change the delivery
        // base URL, drive six deliveries, then let the scheduled reconcile do
        // what it does. Before #295 every step succeeded and reported success —
        // the registration had worked, so `webhookFailures` was empty; what
        // failed was DELIVERY, days later, on the platform's side.
        const fixture = await makeFixture();
        const original = fixture.world.webhooks.map((webhook) => ({ ...webhook }));
        expect(original.length, 'the premise: subscriptions to orphan').toBeGreaterThan(0);
        const oldUrl = deliveryUrlFor(fixture.connection.id);
        expect(original.every((webhook) => webhook.deliveryUrl === oldUrl)).toBe(true);

        const newUrl = moveDeliveryBase(fixture.connection.id);
        expect(newUrl, 'the premise: the address really moved').not.toBe(oldUrl);
        // SIX, because the platform disables at MORE than five (#295's citation
        // of `failed_delivery()`), so five would leave every subscription alive
        // and this case would measure the address change alone.
        fixture.world.deliverWebhookEvents(6, newUrl);
        if (harness.publishesSubscriptionHealth) {
          expect(
            fixture.world.webhooks.every((webhook) => webhook.status === 'disabled'),
            'the premise: the platform disabled them itself',
          ).toBe(true);
        }

        const audit = await auditConnectionWebhooks(fixture.storeId, fixture.connection.id);

        expect(audit.outcome).toBe('repair_requested');
        expect(audit.findings).toContain('delivery_address_moved');
        expect(audit.repair).toBe('registered');
        // NO SECOND SET — the whole of the issue's assertion. Counted by TOPIC,
        // because a count of subscriptions is satisfied by a shop holding two of
        // one topic and none of another.
        const topics = fixture.world.webhooks.map((webhook) => webhook.topic);
        expect(new Set(topics).size, 'a base-URL change must not leave a second set').toBe(
          topics.length,
        );
        expect([...topics].sort()).toEqual(original.map((webhook) => webhook.topic).sort());
        // And every one of them is USABLE: live, at the address this deployment
        // now serves, and delivering.
        for (const webhook of fixture.world.webhooks) {
          expect(webhook.deliveryUrl).toBe(newUrl);
          expect(webhook.status).toBe('active');
          expect(webhook.failureCount).toBe(0);
        }
        // The orphans are GONE from the merchant's site rather than merely
        // ignored — decision three, and the reason the id is worth keeping.
        for (const webhook of original) {
          expect(fixture.world.deletedWebhookIds).toContain(webhook.id);
          expect(fixture.world.webhooks.map((live) => live.id)).not.toContain(webhook.id);
        }
        // Mercaria holds the platform's whole truth about its own address, so a
        // disconnect can still reach every one of them.
        const stored = await findConnection(fixture.storeId, fixture.connection.id);
        expect([...(stored?.webhookIds ?? [])].sort()).toEqual(
          fixture.world.webhooks.map((webhook) => webhook.id).sort(),
        );
        // A SECOND audit is a no-op, which is what makes running this on every
        // connection every six hours affordable rather than a re-registration
        // schedule wearing a detector's name.
        const again = await auditConnectionWebhooks(fixture.storeId, fixture.connection.id);
        expect(again.outcome).toBe('healthy');
      });

      it('leaves a HEALTHY connection completely alone — no calls, no attempt spent', async () => {
        // The negative control, and it carries the property that makes the
        // detector affordable. Without it every assertion in the case above is
        // also satisfied by an audit that simply re-registers everything it is
        // pointed at, which is precisely what
        // `findConnectionsNeedingWebhookRegistration` refuses to become.
        const fixture = await makeFixture();
        const before = fixture.world.webhooks.map((webhook) => webhook.id).sort();
        expect(before.length).toBeGreaterThan(0);
        const callsBefore = fixture.world.calls.length;
        const storedBefore = await findConnection(fixture.storeId, fixture.connection.id);

        const audit = await auditConnectionWebhooks(fixture.storeId, fixture.connection.id);

        expect(audit.outcome).toBe('healthy');
        expect(audit.findings).toEqual([]);
        expect(fixture.world.deletedWebhookIds).toEqual([]);
        expect(fixture.world.webhooks.map((webhook) => webhook.id).sort()).toEqual(before);
        // It DID knock — one list read — so "nothing changed" cannot be a fake
        // that stopped answering. The floor is on the delta, because the
        // fixture's own connect already filled the log.
        expect(
          fixture.world.calls.length,
          'the audit must actually read the platform',
        ).toBeGreaterThan(callsBefore);
        const storedAfter = await findConnection(fixture.storeId, fixture.connection.id);
        expect(storedAfter?.webhookRegistrationAttempts).toBe(
          storedBefore?.webhookRegistrationAttempts,
        );
      });

      it('reads the platform HEALTH of a subscription at the RIGHT address, or says it cannot', async () => {
        // The second, independent detector: the address never moved, Mercaria
        // was simply unreachable for long enough that the platform gave up. It
        // is what `status` and `failure_count` are read for, and BOTH branches
        // run — a platform that publishes neither must not be reported as
        // healthy on the strength of a field nobody answered.
        const fixture = await makeFixture();
        expect(fixture.world.webhooks.length).toBeGreaterThan(0);
        // No served address at all: every delivery fails where it stands.
        fixture.world.deliverWebhookEvents(6);

        const audit = await auditConnectionWebhooks(fixture.storeId, fixture.connection.id);

        if (!harness.publishesSubscriptionHealth) {
          // Shopify publishes no status, so this is INVISIBLE — stated as an
          // assertion rather than left out, so a platform that grows one and is
          // not read fails here.
          expect(audit.outcome).toBe('healthy');
          expect(audit.maxFailureCount, 'no health published, so none reported').toBeUndefined();
          return;
        }
        expect(audit.outcome).toBe('repair_requested');
        expect(audit.findings).toEqual(['subscription_disabled']);
        expect(audit.repair).toBe('registered');
        // The failure count is REPORTED as evidence beside the verdict — it is
        // what tells an operator this was a delivery problem rather than
        // somebody deleting subscriptions.
        expect(audit.maxFailureCount).toBe(6);
        for (const webhook of fixture.world.webhooks) {
          expect(webhook.status).toBe('active');
          expect(webhook.failureCount).toBe(0);
        }
      });

      it('does NOT restart a connection that has stopped retrying', async () => {
        // A `dead_letter` is #262's deliberate end to the automatic loop. A
        // detector firing into it every six hours would undo that stop from
        // outside, and the remedy #262 built is the merchant's own button.
        const fixture = await makeFixture();
        const before = fixture.world.webhooks.map((webhook) => webhook.id).sort();
        const newUrl = moveDeliveryBase(fixture.connection.id);
        fixture.world.deliverWebhookEvents(6, newUrl);
        const leaseOwner = 'contract-suite-dead-letter';
        expect(
          await claimConnectionWebhookRegistration({
            connectionId: fixture.connection.id,
            leaseOwner,
            leaseMs: 60_000,
            countsAsAttempt: false,
          }),
          'the premise: the lease was claimable',
        ).not.toBeNull();
        expect(
          await releaseConnectionWebhookRegistration({
            connectionId: fixture.connection.id,
            leaseOwner,
            deadLettered: true,
            nextAttemptAt: null,
          }),
        ).toBe(true);

        const audit = await auditConnectionWebhooks(fixture.storeId, fixture.connection.id);

        expect(audit.outcome).toBe('repair_withheld');
        expect(audit.findings).toContain('delivery_address_moved');
        expect(audit.repair, 'no repair may have run').toBeUndefined();
        // Nothing on the merchant's site moved, and the orphans are still there
        // for the merchant's own re-registration to converge.
        expect(fixture.world.webhooks.map((webhook) => webhook.id).sort()).toEqual(before);
        expect(fixture.world.deletedWebhookIds).toEqual([]);
      });

      it('concludes NOTHING when the platform will not say what it holds', async () => {
        // An unreadable list is not evidence of a dead subscription, and a
        // re-registration would fail at the same call and spend an attempt
        // discovering it. A revoked credential answers this way every time.
        const fixture = await makeFixture();
        const before = fixture.world.webhooks.map((webhook) => webhook.id).sort();
        const storedBefore = await findConnection(fixture.storeId, fixture.connection.id);
        fixture.world.fail(harness.webhookPathFragment, 403, 99, {}, 'GET');

        const audit = await auditConnectionWebhooks(fixture.storeId, fixture.connection.id);

        expect(audit.outcome).toBe('unreadable');
        expect(audit.findings).toEqual([]);
        expect(fixture.world.webhooks.map((webhook) => webhook.id).sort()).toEqual(before);
        expect(fixture.world.deletedWebhookIds).toEqual([]);
        const storedAfter = await findConnection(fixture.storeId, fixture.connection.id);
        expect(storedAfter?.webhookRegistrationAttempts).toBe(
          storedBefore?.webhookRegistrationAttempts,
        );
      });

      it('leaves an EMPTY registration to the sweep that owns it', async () => {
        // One state, one owner. An empty `webhook_ids` IS
        // `findConnectionsNeedingWebhookRegistration`'s own population, and this
        // detector reporting it too would give it a second, racing owner.
        const fixture = await makeFixture();
        await recordConnectionWebhookRegistration(fixture.connection.id, {
          outcome: 'reconciled',
          webhookIds: [],
          failures: [],
        });
        const callsBefore = fixture.world.calls.length;

        const audit = await auditConnectionWebhooks(fixture.storeId, fixture.connection.id);

        expect(audit.outcome).toBe('nothing_registered');
        // And it never knocked — the platform has nothing to say about a
        // connection Mercaria holds no id for.
        expect(fixture.world.calls.length).toBe(callsBefore);
        // The control: the sweep's population DOES claim it.
        const ids = (await findConnectionsNeedingWebhookRegistration({ limit: 500 })).map(
          (row) => row.id,
        );
        expect(ids).toContain(fixture.connection.id);
      });

      it('never touches a subscription at a foreign address it holds NO id for', async () => {
        // The bound on decision three, and the reason ownership is an ID rather
        // than a URL shape. This one sits under a base this deployment does not
        // serve and Mercaria never recorded it — a sibling environment, a
        // staging deployment, another app. Deleting it on the strength of its
        // hostname is the cross-deployment form of the prefix bug the exact
        // comparison exists to prevent.
        const fixture = await makeFixture();
        const stranger = {
          id: 'wh-another-deployment',
          topic: harness.topics.productUpsert,
          deliveryUrl: `${MOVED_BASE}/channels/webhooks/${harness.providerId}/some-other-connection`,
          status: 'active' as const,
          failureCount: 0,
        };
        fixture.world.webhooks.push(stranger);
        const stored = await findConnection(fixture.storeId, fixture.connection.id);
        expect(
          stored?.webhookIds,
          'the premise: Mercaria must NOT hold this id',
        ).not.toContain(stranger.id);

        // Re-register for real, which is the path that would delete it.
        const outcome = await reregisterConnectionWebhooks(
          fixture.storeId,
          fixture.connection.id,
          { countsAsAttempt: false },
        );

        expect(outcome).toBe('registered');
        expect(fixture.world.deletedWebhookIds).not.toContain(stranger.id);
        expect(fixture.world.webhooks).toContainEqual(stranger);
        const after = await findConnection(fixture.storeId, fixture.connection.id);
        expect(after?.webhookIds).not.toContain(stranger.id);
      });
    });

    // --- SCENARIOS 2, 4, 10: backfill, updates, native currency -------------

    describe('the catalogue', () => {
      it('BACKFILLS every product in the shop NATIVE currency, with its images and stock', async () => {
        const fixture = await makeFixture();

        const run = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(run.status).toBe('completed');
        expect(run.countsCreated).toBe(fixture.world.products.length);
        expect(run.countsFailed).toBe(0);

        const source = fixture.world.products[0];
        const listing = await importedListing(fixture, source.externalId);
        expect(listing.title).toBe(source.title);
        expect(listing.sourceProvider).toBe(harness.providerId);
        expect(listing.sourceExternalId).toBe(source.externalId);

        const children = await findListingChildren([listing.id]);
        expect((children.images.get(listing.id) ?? []).map((image) => image.fileId)).toEqual([
          ...source.imageUrls,
        ]);

        const variants = await findVariantsByListing(listing.id);
        expect(variants).toHaveLength(source.variants.length);
        for (const variant of variants) {
          // #69 scenario 10, and the currency contract: the catalogue stores
          // NATIVE. A variant priced in the store's own `defaultCurrency` (FAIR
          // here) would mean the import converted, which it must never do.
          expect(variant.priceCurrency).toBe(harness.shopCurrency);
          expect(variant.priceCurrency).not.toBe('FAIR');
        }
        expect(variants.map((variant) => variant.inventoryAvailable)).toEqual(
          source.variants.map((variant) => variant.available),
        );
      });

      it('a PRICE, TITLE and IMAGE change on the platform reaches an already-imported listing', async () => {
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);
        const source = fixture.world.products[0];

        fixture.world.products = fixture.world.products.map((product) =>
          product.externalId === source.externalId
            ? {
                ...product,
                title: `${product.title} (revised)`,
                imageUrls: [...product.imageUrls, 'https://cdn.example.test/added.jpg'],
                variants: product.variants.map((variant) => ({ ...variant, price: '44.50' })),
              }
            : product,
        );

        const run = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(run.countsUpdated).toBeGreaterThan(0);
        const listing = await importedListing(fixture, source.externalId);
        expect(listing.title).toBe(`${source.title} (revised)`);
        const children = await findListingChildren([listing.id]);
        expect(children.images.get(listing.id) ?? []).toHaveLength(source.imageUrls.length + 1);
        const variants = await findVariantsByListing(listing.id);
        for (const variant of variants) {
          expect(variant.priceAmount).toBe(4450);
          expect(variant.priceCurrency).toBe(harness.shopCurrency);
        }
      });

      it('a LOCALLY OVERRIDDEN field survives a resync, and an unpinned one does not', async () => {
        const fixture = await makeFixture({ conflictPolicy: 'respect_overrides' });
        await runBackfill(fixture.storeId, fixture.connection.id);
        const source = fixture.world.products[0];
        const listing = await importedListing(fixture, source.externalId);

        // The merchant edited the title and the price in Mercaria. `price` is the
        // interesting pin: it guards the VARIANT re-price, which is a different
        // code path from the listing-field merge.
        await updateListingColumns(listing.id, {
          title: 'Merchant wrote this title',
          overriddenFields: ['title', 'price'],
        });

        fixture.world.products = fixture.world.products.map((product) =>
          product.externalId === source.externalId
            ? {
                ...product,
                title: 'Platform wrote this title',
                description: 'Platform wrote this description',
                variants: product.variants.map((variant) => ({ ...variant, price: '99.00' })),
              }
            : product,
        );

        await runBackfill(fixture.storeId, fixture.connection.id);

        const after = await importedListing(fixture, source.externalId);
        expect(after.title, 'a pinned title must survive').toBe('Merchant wrote this title');
        expect(after.description, 'an UNPINNED field must still track the platform').toBe(
          'Platform wrote this description',
        );
        const variants = await findVariantsByListing(after.id);
        for (const variant of variants) {
          expect(variant.priceAmount, 'a pinned price must survive').not.toBe(9900);
        }
      });

      it('a product REMOVED from the platform is ARCHIVED, never hard-deleted', async () => {
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);
        const removed = fixture.world.products[0];

        fixture.world.products = fixture.world.products.filter(
          (product) => product.externalId !== removed.externalId,
        );
        await runBackfill(fixture.storeId, fixture.connection.id);

        const listing = await importedListing(fixture, removed.externalId);
        // Archived, not gone: order history and provenance point at this row.
        expect(listing.status).toBe('archived');
        const survivors = await findListingsBySourceConnection(
          fixture.storeId,
          fixture.connection.id,
        );
        expect(survivors.filter((row) => row.status === 'archived')).toHaveLength(1);
        expect(survivors).toHaveLength(fixture.world.products.length + 1);
      });

      it('CREATES a variant the platform ADDED to an existing product', async () => {
        // #220's other half. Re-pricing used to skip an unmatched incoming
        // variant with the comment "creation is a later phase", and that skip is
        // what made a collapsed import permanent: no later sync could add the
        // variants a first, incomplete delivery missed.
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);
        const source = fixture.world.products[0];
        const listing = await importedListing(fixture, source.externalId);
        const before = await findVariantsByListing(listing.id);

        fixture.world.products = fixture.world.products.map((product) =>
          product.externalId === source.externalId
            ? {
                ...product,
                optionNames: product.optionNames.length > 0 ? product.optionNames : ['Size'],
                variants: [
                  ...product.variants,
                  {
                    externalVariantId: `${source.externalId}-added`,
                    externalInventoryItemId: `${source.externalId}-added-item`,
                    optionValues: [{ name: product.optionNames[0] ?? 'Size', value: 'XL' }],
                    price: '31.00',
                    sku: `${source.externalId}-ADDED`,
                    available: 4,
                  },
                ],
              }
            : product,
        );
        const run = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(run.status).toBe('completed');
        const after = await findVariantsByListing(listing.id);
        expect(after).toHaveLength(before.length + 1);
        const added = after.find((variant) => variant.sku === `${source.externalId}-ADDED`);
        expect(added, 'the added variant must exist').toBeDefined();
        expect(added?.priceAmount).toBe(3100);
        expect(added?.inventoryAvailable).toBe(4);
        // Stamped, or it is a variant the inventory sync can never find again —
        // which is a variant that exists and never updates.
        expect(added?.sourceConnectionId).toBe(fixture.connection.id);
        expect(added?.sourceExternalVariantId).toBe(`${source.externalId}-added`);
        // #259 case 10: a genuinely NEW external id creates a variant and leaves
        // every existing one exactly where it was. Creating is the easy half —
        // the half that went wrong was creating one for a variant that already
        // existed under another SKU, which shows up here as a lost id.
        expect(after.filter((variant) => before.some((row) => row.id === variant.id))).toHaveLength(
          before.length,
        );
      });

      it('UNSELLS a variant the platform REMOVED, and never deletes it', async () => {
        // The documented semantics: a variant id is referenced by cart lines,
        // saves, offers and the canonical links, every one `ON DELETE CASCADE`,
        // so deleting it would empty it out of live carts and retire an offer.
        // Leaving it buyable would be reading the platform's silence as
        // availability. So it stays, unsellable.
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);
        const source = fixture.world.products.find((product) => product.variants.length > 1);
        expect(source, 'the fixture catalogue must carry a multi-variant product').toBeDefined();
        const multiVariant = source as NonNullable<typeof source>;
        const listing = await importedListing(fixture, multiVariant.externalId);
        const removed = multiVariant.variants[0];

        fixture.world.products = fixture.world.products.map((product) =>
          product.externalId === multiVariant.externalId
            ? {
                ...product,
                variants: product.variants.filter(
                  (variant) => variant.externalVariantId !== removed.externalVariantId,
                ),
              }
            : product,
        );
        await runBackfill(fixture.storeId, fixture.connection.id);

        const after = await findVariantsByListing(listing.id);
        expect(after, 'the row must SURVIVE — carts and offers point at it').toHaveLength(
          multiVariant.variants.length,
        );
        const orphan = after.find((variant) => variant.sku === removed.sku);
        expect(orphan, 'the removed variant must still exist').toBeDefined();
        expect(orphan?.inventoryAvailable).toBe(0);
        // Tracking ON, or the zero means nothing: an untracked variant ignores
        // its stock entirely and stays buyable.
        expect(orphan?.inventoryTracked).toBe(true);
        // Its SIBLING is untouched, so this is a removal and not a wipe.
        const survivor = after.find((variant) => variant.sku === multiVariant.variants[1].sku);
        expect(survivor?.inventoryAvailable).toBe(multiVariant.variants[1].available);

        // #259 defect B, and the assertion the old single-location fixture could
        // not make: the unsell has to land on the level the connector's stock
        // actually lives in. Routed to the store DEFAULT it inserted a second
        // level row at 0, `recomputeVariantScalarFromLevels` summed the two, and
        // the variant stayed fully buyable while every scalar assertion above
        // still read whatever the target held.
        const orphanLevels = await findLevelsByVariant((orphan as NonNullable<typeof orphan>).id);
        expect(orphanLevels.map((level) => level.locationId)).toEqual([fixture.locationId]);
        expect(orphanLevels[0].available).toBe(0);
        const survivorLevels = await findLevelsByVariant(
          (survivor as NonNullable<typeof survivor>).id,
        );
        expect(survivorLevels.map((level) => level.locationId)).toEqual([fixture.locationId]);
      });

      it('is IDEMPOTENT — a re-run creates no second listing and no second variant', async () => {
        const fixture = await makeFixture();
        const first = await runBackfill(fixture.storeId, fixture.connection.id);
        const before = await findListingsBySourceConnection(
          fixture.storeId,
          fixture.connection.id,
        );

        const second = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(first.countsCreated).toBe(fixture.world.products.length);
        expect(second.countsCreated).toBe(0);
        const after = await findListingsBySourceConnection(fixture.storeId, fixture.connection.id);
        expect(after).toHaveLength(fixture.world.products.length);
        // The same ROWS, not merely the same count — a re-import that deleted and
        // recreated would satisfy a count and lose every local edit and order link.
        expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
        for (const listing of after) {
          expect(await findVariantsByListing(listing.id)).toHaveLength(
            fixture.world.products.find((product) => product.externalId === listing.sourceExternalId)
              ?.variants.length,
          );
        }
        // NOT asserted: that the second run reports `skipped`. `toUpdatePatch`
        // builds a patch from every unpinned connector-managed field whether or
        // not it changed, so an unchanged re-sync writes identical values and
        // tallies as `updated`. That is a reporting nuance — the dashboard says
        // "2 updated" after a no-op reconcile — and not a data one.
      });
    });

    // --- #259: stable variant identity, and enumerations that were PROVEN ---

    describe('variant identity', () => {
      /** The fixture catalogue's multi-variant product, or a failed expectation. */
      function multiVariant(fixture: ContractFixture): ContractProduct {
        const source = fixture.world.products.find((product) => product.variants.length > 1);
        expect(source, 'the fixture catalogue must carry a multi-variant product').toBeDefined();
        return source as ContractProduct;
      }

      /** Rewrite `externalId`'s entry in the world — the merchant editing their shop. */
      function editProduct(
        fixture: ContractFixture,
        externalId: string,
        edit: (product: ContractProduct) => ContractProduct,
      ): void {
        fixture.world.products = fixture.world.products.map((product) =>
          product.externalId === externalId ? edit(product) : product,
        );
      }

      /** The stored option tuple of one variant, in the platform's own shape. */
      async function storedOptionValues(
        variantId: string,
      ): Promise<{ name: string; value: string }[]> {
        const values = (await findVariantOptionValues([variantId])).get(variantId) ?? [];
        return values.map((row) => ({ name: row.name, value: row.value }));
      }

      it('case 7: a changed SKU keeps the SAME local variant and renames it', async () => {
        // The platform says this is the same variation; only its SKU moved. The
        // old matcher keyed on the SKU, so it matched nothing, CREATED a second
        // variant and unsold the original — taking its carts, saves, offers and
        // order history out of circulation with it.
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);
        const source = multiVariant(fixture);
        const listing = await importedListing(fixture, source.externalId);
        const before = await findVariantsByListing(listing.id);
        const renamed = source.variants[0];

        editProduct(fixture, source.externalId, (product) => ({
          ...product,
          variants: product.variants.map((variant) =>
            variant.externalVariantId === renamed.externalVariantId
              ? { ...variant, sku: `${renamed.sku}-RENAMED` }
              : variant,
          ),
        }));
        const run = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(run.countsFailed).toBe(0);
        const after = await findVariantsByListing(listing.id);
        expect(after.map((variant) => variant.id).sort()).toEqual(
          before.map((variant) => variant.id).sort(),
        );
        const moved = after.find(
          (variant) => variant.sourceExternalVariantId === renamed.externalVariantId,
        );
        expect(moved?.sku).toBe(`${renamed.sku}-RENAMED`);
        // Still on sale: a rename is not a removal, and the removal loop must not
        // have reached it.
        expect(moved?.inventoryAvailable).toBe(renamed.available);
      });

      it('a CORRECTED barcode reaches an already-imported variant', async () => {
        // #381. The barcode was written on create and never on update, so a
        // variant kept whatever GTIN it was first imported with however many
        // times the merchant fixed it upstream.
        //
        // It belongs in `variant identity` rather than beside the price merge:
        // `subject-loader.ts` asserts this column as an `ean` for #58's matcher,
        // and #296 removed the table-wide unique so that identity is decided by
        // the collision gate rather than a constraint. A stale barcode is a
        // wrong identifier offered to the thing that attaches this variant to a
        // canonical product, not a stale display string.
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);
        const source = multiVariant(fixture);
        const listing = await importedListing(fixture, source.externalId);
        const target = source.variants.find((variant) => variant.barcode !== undefined);
        expect(target, 'the fixture catalogue must carry a variant with a barcode').toBeDefined();
        const corrected = '4006381333931';
        expect(corrected).not.toBe((target as ContractVariant).barcode);

        editProduct(fixture, source.externalId, (product) => ({
          ...product,
          variants: product.variants.map((variant) =>
            variant.externalVariantId === (target as ContractVariant).externalVariantId
              ? { ...variant, barcode: corrected }
              : variant,
          ),
        }));
        const run = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(run.countsFailed).toBe(0);
        const after = await findVariantsByListing(listing.id);
        const moved = after.find(
          (variant) =>
            variant.sourceExternalVariantId === (target as ContractVariant).externalVariantId,
        );
        if (!harness.reportsVariantBarcode) {
          // The REFUSAL branch: this platform publishes no barcode, so there is
          // nothing to re-sync and the column stays empty. A provider that grew
          // the field without this path learning to write it fails here.
          expect(moved?.barcode ?? null).toBeNull();
          return;
        }
        expect(moved?.barcode).toBe(corrected);
        // The same variant, renamed — not a second one. A barcode is an identity
        // CLAIM about this variant, and re-keying on it would take its carts,
        // saves, offers and order history out of circulation.
        expect(after).toHaveLength(source.variants.length);
      });

      it('case 8: a changed option LABEL and VALUE keep the SAME local variant id', async () => {
        // This case does NOT discriminate the new matcher from the old one, and
        // saying so is the point: it leaves the SKU alone, so the pre-#259 SKU
        // tier matched and preserved these ids for a reason that has nothing to
        // do with the platform's variation id. What it measures is that the
        // option values are genuinely PATCHED onto the surviving row rather than
        // left stale. The evidence that identity comes from the source id is
        // "cases 7 AND 8 together" below, which moves both legacy keys at once —
        // and that case exists because a mutation removing the source-id tier
        // left this one green.
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);
        const source = multiVariant(fixture);
        const listing = await importedListing(fixture, source.externalId);
        const before = await findVariantsByListing(listing.id);
        const axis = source.optionNames[0];
        expect(axis, 'the multi-variant fixture must carry an option axis').toBeDefined();

        editProduct(fixture, source.externalId, (product) => ({
          ...product,
          optionNames: ['Talla'],
          variants: product.variants.map((variant) => ({
            ...variant,
            optionValues: variant.optionValues.map((option) => ({
              name: 'Talla',
              value: `${option.value} (grande)`,
            })),
          })),
        }));
        const run = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(run.countsFailed).toBe(0);
        const after = await findVariantsByListing(listing.id);
        // THE assertion of case 8: the local id is what carts, saves, offers,
        // canonical links and order lines point at, and a relabelled option is
        // not a different product.
        expect(after.map((variant) => variant.id).sort()).toEqual(
          before.map((variant) => variant.id).sort(),
        );
        const renamed = after.find(
          (variant) => variant.sourceExternalVariantId === source.variants[0].externalVariantId,
        );
        expect(await storedOptionValues((renamed as NonNullable<typeof renamed>).id)).toEqual([
          { name: 'Talla', value: `${source.variants[0].optionValues[0].value} (grande)` },
        ]);
      });

      it('cases 7 AND 8 together: when BOTH legacy keys move, only the platform id still identifies it', async () => {
        // Neither case above can measure that the SOURCE ID is the PRIMARY
        // match, and that is a fact about them rather than a suspicion: with the
        // source-id tier mutated away, a SKU rename is still resolved by the
        // unchanged option tuple and an option rename by the unchanged SKU, so
        // both stayed green. This is the shape where every legacy key moves at
        // once — which is what a merchant does when they rebuild a size chart —
        // and where matching on anything but the platform's own variation id
        // creates a second variant and unsells a live one.
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);
        const source = multiVariant(fixture);
        const listing = await importedListing(fixture, source.externalId);
        const before = await findVariantsByListing(listing.id);
        const moved = source.variants[0];

        editProduct(fixture, source.externalId, (product) => ({
          ...product,
          optionNames: ['Talla'],
          variants: product.variants.map((variant) => ({
            ...variant,
            sku: `${variant.sku}-REBUILT`,
            optionValues: variant.optionValues.map((option) => ({
              name: 'Talla',
              value: `${option.value} (rebuilt)`,
            })),
          })),
        }));
        const run = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(run.countsFailed).toBe(0);
        const after = await findVariantsByListing(listing.id);
        expect(after.map((variant) => variant.id).sort()).toEqual(
          before.map((variant) => variant.id).sort(),
        );
        const kept = after.find(
          (variant) => variant.sourceExternalVariantId === moved.externalVariantId,
        );
        expect(kept?.sku).toBe(`${moved.sku}-REBUILT`);
        expect(await storedOptionValues((kept as NonNullable<typeof kept>).id)).toEqual([
          { name: 'Talla', value: `${moved.optionValues[0].value} (rebuilt)` },
        ]);
        // And it is still SELLABLE: the removal loop must not have reached a
        // variant the platform never stopped listing.
        expect(kept?.inventoryAvailable).toBe(moved.available);
      });

      it('case 9: an AMBIGUOUS legacy match on the option TUPLE refuses the product and writes NOTHING', async () => {
        // The pre-provenance state the SKU/tuple fallback exists for, with two
        // rows it cannot tell apart. Picking one by map insertion order is what
        // the old matcher did, and the loser was silently unsold.
        //
        // This is the TUPLE half. The SKU half is the case below, reachable
        // since #296 dropped `product_variants_sku_key` — until then the
        // database refused that state outright and this comment recorded it as
        // unbuildable.
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);
        const source = multiVariant(fixture);
        const listing = await importedListing(fixture, source.externalId);
        const before = await findVariantsByListing(listing.id);
        const collidingTuple = source.variants[0].optionValues.map((option) => ({
          name: option.name,
          value: option.value,
        }));

        for (const variant of before) {
          await updateVariantColumns(
            listing.id,
            variant.id,
            {
              sku: null,
              sourceConnectionId: null,
              sourceProvider: null,
              sourceExternalVariantId: null,
              sourceExternalInventoryItemId: null,
            },
            collidingTuple,
          );
        }

        const run = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(run.countsFailed).toBeGreaterThan(0);
        const after = await findVariantsByListing(listing.id);
        expect(after, 'an ambiguous match must create nothing').toHaveLength(before.length);
        expect(after.map((variant) => variant.inventoryAvailable).sort()).toEqual(
          before.map((variant) => variant.inventoryAvailable).sort(),
        );
        expect(after.map((variant) => variant.priceAmount).sort()).toEqual(
          before.map((variant) => variant.priceAmount).sort(),
        );
      });

      it('case 9: an AMBIGUOUS legacy match on a shared SKU refuses the product and NAMES its candidates', async () => {
        // The half #259 could not build. `product_variants_sku_key` was a unique
        // index over the WHOLE table, so two variants sharing a SKU was a state
        // the database refused and this branch of `matchIncomingVariant` was
        // dead code. #296 dropped it — a SKU is unique at no grain Mercaria can
        // enforce, and one Shopify product carrying two variants with one SKU is
        // an ordinary catalogue rather than a corruption — so the refusal is now
        // reachable and is what stands between that catalogue and an arbitrary
        // row being picked.
        //
        // Driven through the product WEBHOOK rather than a backfill on purpose:
        // `runBackfill` catches a per-product failure and only LOGS the message,
        // while `runWebhookUnit` records it on the `sync_runs` row — so the
        // refusal can be read back rather than inferred from a counter that
        // would look the same for any failure at all.
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);
        const source = multiVariant(fixture);
        const listing = await importedListing(fixture, source.externalId);
        const before = await findVariantsByListing(listing.id);
        expect(before.length, 'the collision needs two rows to be between').toBeGreaterThan(1);
        const sharedSku = source.variants[0].sku;
        expect(sharedSku, 'the fixture multi-variant product must carry a SKU').toBeTruthy();

        // Both rows carry the SKU the incoming first variant carries, and
        // NEITHER carries provenance — so the exact source-id tier misses and
        // the SKU tier is what answers. Option values are left ALONE, which is
        // what keeps the tuple tier from being the thing that refuses: without
        // that this case would pass identically with the SKU tier deleted.
        for (const variant of before) {
          await updateVariantColumns(
            listing.id,
            variant.id,
            {
              sku: sharedSku,
              sourceConnectionId: null,
              sourceProvider: null,
              sourceExternalVariantId: null,
              sourceExternalInventoryItemId: null,
            },
            undefined,
          );
        }

        await processConnectorWebhook({
          connectionId: fixture.connection.id,
          topic: harness.topics.productUpsert,
          payload: harness.webhookProductPayload(fixture.world, source.externalId),
        });

        const [run] = await listSyncRunsForConnection(fixture.connection.id, 1);
        expect(run?.kind).toBe('webhook');
        expect(run?.status).toBe('failed');
        // It NAMES what it found — the field it matched on and EVERY candidate
        // row — so whoever reads it can see which two the catalogue cannot tell
        // apart. A refusal saying only "ambiguous" would leave them looking.
        expect(run?.error).toContain('sku');
        for (const variant of before) {
          expect(run?.error).toContain(variant.id);
        }

        // And it wrote NOTHING, which is the half a failed counter cannot show:
        // the matching pass resolves every incoming variant BEFORE the write
        // loop, so one ambiguity refuses the product rather than half-applying it.
        const after = await findVariantsByListing(listing.id);
        expect(after.map((variant) => variant.id).sort()).toEqual(
          before.map((variant) => variant.id).sort(),
        );
        expect(after.every((variant) => variant.sku === sharedSku)).toBe(true);
        expect(after.every((variant) => variant.sourceExternalVariantId === null)).toBe(true);
        expect(after.map((variant) => variant.priceAmount).sort()).toEqual(
          before.map((variant) => variant.priceAmount).sort(),
        );
      });

      it('an UNAMBIGUOUS legacy row is matched and STAMPED — the control for case 9', async () => {
        // The vacuity floor on the case above: the same unstamped, SKU-less
        // fixture WITHOUT the collision has to converge, or "nothing was written"
        // would be equally true of a fallback tier that matches nothing at all.
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);
        const source = multiVariant(fixture);
        const listing = await importedListing(fixture, source.externalId);
        const before = await findVariantsByListing(listing.id);

        for (const variant of before) {
          await updateVariantColumns(
            listing.id,
            variant.id,
            {
              sku: null,
              sourceConnectionId: null,
              sourceProvider: null,
              sourceExternalVariantId: null,
              sourceExternalInventoryItemId: null,
            },
            undefined,
          );
        }

        const run = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(run.countsFailed).toBe(0);
        const after = await findVariantsByListing(listing.id);
        expect(after.map((variant) => variant.id).sort()).toEqual(
          before.map((variant) => variant.id).sort(),
        );
        // Re-stamped, which is what makes the fallback a one-time migration
        // rather than the matcher this listing lives on forever.
        expect(after.map((variant) => variant.sourceExternalVariantId).sort()).toEqual(
          source.variants.map((variant) => variant.externalVariantId).sort(),
        );
      });

      it(
        harness.truncateVariantEnumeration === undefined
          ? 'reports a PROVEN enumeration for the products this platform serves'
          : 'case 12: an INCOMPLETE variation response changes no listing and no variant, on every retry',
        async () => {
          const fixture = await makeFixture();
          await runBackfill(fixture.storeId, fixture.connection.id);
          const source = multiVariant(fixture);
          const listing = await importedListing(fixture, source.externalId);
          const before = await findVariantsByListing(listing.id);

          if (harness.truncateVariantEnumeration === undefined) {
            // The measured half of the absent branch. Every case above rests on
            // this platform's ordinary payload normalizing to a PROVEN
            // enumeration; a provider that started reporting `incomplete` for
            // everything would make them pass for the wrong reason, and one that
            // could never report it would make case 12 unmeasurable rather than
            // absent.
            const provider = harness.createProvider(fixture.world);
            const normalized = provider.normalizeProduct(
              harness.webhookProductPayload(fixture.world, source.externalId),
              harness.shopCurrency,
            );
            expect(normalized.variants.enumeration).toBe('complete');
            return;
          }

          // The title moves TOO, so "no listing row changed" is a real assertion
          // rather than one that would hold whatever the connector did.
          editProduct(fixture, source.externalId, (product) => ({
            ...product,
            title: `${product.title} (renamed while truncated)`,
          }));
          harness.truncateVariantEnumeration(fixture.world, source.externalId);

          const run = await runBackfill(fixture.storeId, fixture.connection.id);
          const retry = await runBackfill(fixture.storeId, fixture.connection.id);

          // The DAMAGE is asserted before the tally, deliberately. Asserting
          // `countsFailed` first makes a run that quietly unsold everything fail
          // on the count and never reach the assertions that would say so —
          // measured, on the mutation that removes the refusal.
          const after = await findVariantsByListing(listing.id);
          expect(after.map((variant) => variant.id).sort()).toEqual(
            before.map((variant) => variant.id).sort(),
          );
          expect(
            after.map((variant) => variant.inventoryAvailable).sort(),
            'an unproven enumeration must not unsell anything',
          ).toEqual(before.map((variant) => variant.inventoryAvailable).sort());
          const listingAfter = await importedListing(fixture, source.externalId);
          expect(listingAfter.title, 'the listing row must not have moved either').toBe(
            listing.title,
          );
          expect(listingAfter.status).toBe(listing.status);
          // And the refusal is OBSERVABLE, which is the other half: a sync that
          // changed nothing and reported success is indistinguishable from a
          // quiet day.
          expect(run.countsFailed).toBeGreaterThan(0);
          expect(retry.countsFailed, 'a retry must converge on the same refusal').toBeGreaterThan(0);
        },
      );
    });

    // --- SCENARIO 5 / WooCommerce 3: pagination and rate limiting -----------

    describe('pagination and rate limiting', () => {
      it('FOLLOWS the cursor across pages and imports every product exactly ONCE', async () => {
        const world = harness.createWorld();
        world.pageSize = 1;
        const fixture = await makeFixture({ world });

        const run = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(run.status).toBe('completed');
        expect(run.countsCreated).toBe(world.products.length);
        const listings = await findListingsBySourceConnection(
          fixture.storeId,
          fixture.connection.id,
        );
        expect(listings).toHaveLength(world.products.length);
        expect(new Set(listings.map((row) => row.sourceExternalId)).size).toBe(
          world.products.length,
        );
      });

      it(
        harness.capabilities.retriesRateLimit
          ? 'RETRIES a 429 and completes the backfill'
          : 'does NOT retry a 429 — the run fails and archives nothing (a declared gap)',
        async () => {
          const fixture = await makeFixture();
          // Two consecutive refusals: one is indistinguishable from a fluke, and a
          // wrapper that retried exactly once would pass a one-shot fixture.
          fixture.world.fail('/products', 429, 2, { 'retry-after': '0' });

          const run = await runBackfill(fixture.storeId, fixture.connection.id);

          if (harness.capabilities.retriesRateLimit) {
            expect(run.status).toBe('completed');
            expect(run.countsCreated).toBe(fixture.world.products.length);
            // The retry has to be visible in the call log, or "completed" could
            // just mean the fault never matched anything.
            expect(
              fixture.world.callsMatching('/products').filter((call) => call.status === 429),
            ).toHaveLength(2);
          } else {
            expect(run.status).toBe('failed');
            const listings = await findListingsBySourceConnection(
              fixture.storeId,
              fixture.connection.id,
            );
            expect(listings.filter((row) => row.status === 'archived')).toHaveLength(0);
          }
        },
      );

      it(
        harness.suppressEnumerationProof === undefined
          ? 'ARCHIVES nothing on a paged catalogue whose end the platform STATES'
          : 'ARCHIVES nothing when the platform proves nothing about where its catalogue ENDS',
        async () => {
          // #259 defect A, and the reason it outranks the variant half: an
          // enumeration that stops early does not merely import less. It reaches
          // `archiveUnseenSourcedListings` with a complete-LOOKING seen-set and
          // soft-archives every listing past the last page it read — the whole
          // catalogue of a site behind a header-stripping plugin, on an entirely
          // successful run.
          //
          // `pageSize = 1` is what makes the damage reachable at fixture scale:
          // the failure needs a page the connector could wrongly believe was the
          // last, and one product is such a page.
          const world = harness.createWorld();
          world.pageSize = 1;
          const fixture = await makeFixture({ world });

          // The production sequence, and the order matters: the catalogue is
          // imported while the platform still says where it ends, and only THEN
          // does the site start answering without that proof. Suppressing it
          // from the first run would leave nothing to archive, and "nothing
          // archived" would be true of the bug as well as of the fix.
          const first = await runBackfill(fixture.storeId, fixture.connection.id);
          expect(first.countsCreated).toBe(world.products.length);
          harness.suppressEnumerationProof?.(fixture.world);

          const run = await runBackfill(fixture.storeId, fixture.connection.id);

          expect(run.status).toBe('completed');
          const listings = await findListingsBySourceConnection(
            fixture.storeId,
            fixture.connection.id,
          );
          expect(
            listings.filter((row) => row.status === 'archived'),
            'a catalogue nobody proved they had finished reading must archive nothing',
          ).toHaveLength(0);
          expect(listings).toHaveLength(world.products.length);
        },
      );

      it('a page failure MID-RUN archives nothing — a partial fetch is never a deletion', async () => {
        const world = harness.createWorld();
        world.pageSize = 1;
        const fixture = await makeFixture({ world });
        await runBackfill(fixture.storeId, fixture.connection.id);

        // The first page answers; the platform then falls over. Everything the
        // second page would have listed is now "unseen", which is exactly the
        // shape that mass-archives a catalogue if the guard is wrong.
        fixture.world.fail('/products', 500, 99);
        const run = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(run.status).toBe('failed');
        const listings = await findListingsBySourceConnection(
          fixture.storeId,
          fixture.connection.id,
        );
        expect(listings.filter((row) => row.status === 'archived')).toHaveLength(0);
      });
    });

    // --- SCENARIO 7 / WooCommerce 5: orders --------------------------------

    describe('orders', () => {
      it('IMPORTS an order with the platform amounts VERBATIM and re-syncs in place', async () => {
        const fixture = await makeFixture();

        const first = await syncOrders(fixture.storeId, fixture.connection.id);
        const second = await syncOrders(fixture.storeId, fixture.connection.id);

        expect(first.status).toBe('completed');
        expect(first.countsCreated).toBe(fixture.world.orders.length);
        // Idempotent by the partial unique on `{store, connection, external id}`:
        // a re-sync must refresh, never duplicate.
        expect(second.countsCreated).toBe(0);

        const orders = await importedOrders(fixture.connection.id);
        expect(orders).toHaveLength(fixture.world.orders.length);
        const source = fixture.world.orders[0];
        const imported = orders.find((row) => row.sourceExternalId === source.externalId);
        expect(imported, 'the imported order must be findable by its external id').toBeDefined();
        // Mercaria FX never re-prices an imported order: both sides of the
        // `DualMoney` carry the source platform's own currency and amount.
        expect(imported?.totalsGrandTotalShopCurrency).toBe(harness.shopCurrency);
        expect(imported?.totalsGrandTotalPresentmentCurrency).toBe(harness.shopCurrency);
        expect(imported?.buyerOrigin).toBe('external');
      });

      it('a repeated order WEBHOOK converges on the same order rather than a second one', async () => {
        const fixture = await makeFixture();
        const source = fixture.world.orders[0];
        const payload = harness.webhookOrderPayload(fixture.world, source.externalId);

        await processConnectorWebhook({
          connectionId: fixture.connection.id,
          topic: harness.topics.orderUpsert,
          payload,
        });
        await processConnectorWebhook({
          connectionId: fixture.connection.id,
          topic: harness.topics.orderUpsert,
          payload,
        });

        const orders = await importedOrders(fixture.connection.id);
        expect(orders.filter((row) => row.sourceExternalId === source.externalId)).toHaveLength(1);
      });

      it('IGNORES an order webhook when order pull is disabled', async () => {
        const fixture = await makeFixture({ orders: 'off' });

        await processConnectorWebhook({
          connectionId: fixture.connection.id,
          topic: harness.topics.orderUpsert,
          payload: harness.webhookOrderPayload(fixture.world, fixture.world.orders[0].externalId),
        });

        expect(await importedOrders(fixture.connection.id)).toHaveLength(0);
      });
    });

    // --- #378: the discount, tax and shipping BREAKDOWN --------------------

    describe('the order discount, tax and shipping breakdown', () => {
      /** The world's order that carries a breakdown, or a failed expectation. */
      function orderWithBreakdown(fixture: ContractFixture): ContractOrder {
        const source = fixture.world.orders.find((order) => order.discounts.length > 0);
        expect(source, 'the fixture order book must carry an order with a discount').toBeDefined();
        return source as ContractOrder;
      }

      /** The persisted order row for one external id, or a failed expectation. */
      async function importedOrder(fixture: ContractFixture, externalId: string) {
        const rows = await importedOrders(fixture.connection.id);
        const row = rows.find((order) => order.sourceExternalId === externalId);
        expect(row, `no order was imported for external id ${externalId}`).toBeDefined();
        return row as NonNullable<typeof row>;
      }

      /** The persisted breakdown rows of one order, in their stored position order. */
      async function breakdownOf(orderId: string) {
        const [discounts, taxLines] = await Promise.all([
          db
            .select()
            .from(orderAppliedDiscounts)
            .where(eq(orderAppliedDiscounts.orderId, orderId))
            .orderBy(asc(orderAppliedDiscounts.position)),
          db
            .select()
            .from(orderTaxLines)
            .where(eq(orderTaxLines.orderId, orderId))
            .orderBy(asc(orderTaxLines.position)),
        ]);
        return { discounts, taxLines };
      }

      /** The twenty totals columns, as the row stores them. */
      function totalsOf(order: Awaited<ReturnType<typeof importedOrder>>) {
        return {
          subtotal: [order.totalsSubtotalShopAmount, order.totalsSubtotalPresentmentAmount],
          discountTotal: [
            order.totalsDiscountTotalShopAmount,
            order.totalsDiscountTotalPresentmentAmount,
          ],
          tax: [order.totalsTaxShopAmount, order.totalsTaxPresentmentAmount],
          shipping: [order.totalsShippingShopAmount, order.totalsShippingPresentmentAmount],
          grandTotal: [order.totalsGrandTotalShopAmount, order.totalsGrandTotalPresentmentAmount],
        };
      }

      it('IMPORTS the per-discount and per-rate breakdown, and the shipping LABEL', async () => {
        const fixture = await makeFixture();
        const source = orderWithBreakdown(fixture);

        await syncOrders(fixture.storeId, fixture.connection.id);

        const order = await importedOrder(fixture, source.externalId);
        const { discounts, taxLines } = await breakdownOf(order.id);

        // ONE row per discount the platform published, carrying the CODE — which
        // is the merchant's actual complaint: an imported order showed a
        // discount total with nothing saying which coupon produced it.
        expect(discounts).toHaveLength(1);
        expect(discounts[0].code).toBe('CONTRACT10');
        expect(discounts[0].amountAmount).toBe(400);
        expect(discounts[0].amountCurrency).toBe(harness.shopCurrency);
        // Order-targeted, because Mercaria's `targetLineIndex` is an index into
        // ITS OWN lines and no platform states that mapping.
        expect(discounts[0].target).toBe('order');
        expect(discounts[0].targetLineIndex).toBeNull();
        // Provenance on the SOURCE platform, never a Mercaria discount id (which
        // is a bare `generatedId()` and carries no colon).
        expect(discounts[0].discountId.startsWith(`ext:${harness.providerId}:`)).toBe(true);
        // BOTH branches measured — see `publishesDiscountValueType`. The absent
        // branch is the load-bearing one: it is what refuses a default.
        expect(discounts[0].valueType).toBe(
          harness.publishesDiscountValueType ? 'fixed_amount' : null,
        );

        // TWO rates, each with its own amount — a breakdown that copied the tax
        // total into one line would pass a one-rate assertion. The second states
        // no rate, and NULL is what "the platform did not say" has to look like:
        // a zero there would claim a 0% rate collected 0.32.
        expect(taxLines.map((line) => [line.name, line.rateBps, line.amountAmount])).toEqual([
          ['VAT', 800, 128],
          ['City tax', null, 32],
        ]);
        expect(taxLines.every((line) => line.amountCurrency === harness.shopCurrency)).toBe(true);

        // The platform's own shipping text, and the METHOD deliberately left on
        // `standard`: `SHIPPING_METHODS` is a closed Mercaria set and mapping
        // carrier text onto `express`/`pickup` would be a guess.
        expect(order.shippingLabel).toBe('Express (2 days)');
        expect(order.shippingMethod).toBe('standard');
      });

      it('leaves an order the platform did NOT itemize with no breakdown rows', async () => {
        const fixture = await makeFixture();
        // The first two fixture orders publish a tax TOTAL and itemize nothing,
        // which is an ordinary platform state. The control that the import reads
        // what a platform published rather than manufacturing lines from a total.
        const bare = fixture.world.orders.filter(
          (order) => order.discounts.length === 0 && order.taxLines.length === 0,
        );
        expect(bare.length, 'the fixture order book must carry an un-itemized order').toBeGreaterThan(0);

        await syncOrders(fixture.storeId, fixture.connection.id);

        for (const source of bare) {
          const order = await importedOrder(fixture, source.externalId);
          const { discounts, taxLines } = await breakdownOf(order.id);
          expect(discounts).toHaveLength(0);
          expect(taxLines).toHaveLength(0);
          // Non-zero tax with no tax line: the total is still the platform's.
          expect(order.totalsTaxShopAmount).toBeGreaterThan(0);
          expect(order.shippingLabel).toBe('Shipping');
        }
      });

      it('records a breakdown that does NOT reconcile with its own total, uncorrected', async () => {
        const fixture = await makeFixture();
        const source = orderWithBreakdown(fixture);
        // A SECOND discount, applied to the shipping line, with the order's
        // `discountTotal` left exactly where it was. This is not a contrived
        // fixture: Shopify leaves a shipping-targeted discount out of
        // `total_discounts`, so any free-shipping code produces precisely this.
        fixture.world.orders = fixture.world.orders.map((order) =>
          order.externalId === source.externalId
            ? {
                ...order,
                discounts: [
                  ...order.discounts,
                  { code: 'FREESHIP', title: 'FREESHIP', amount: '5.00', targetsShipping: true },
                ],
              }
            : order,
        );

        await syncOrders(fixture.storeId, fixture.connection.id);

        const order = await importedOrder(fixture, source.externalId);
        const { discounts } = await breakdownOf(order.id);

        // BOTH lines are stored at the amounts the platform published, and the
        // carried total is unchanged. Nothing was scaled to fit, nothing was
        // dropped for overflowing, and no balancing row was invented — the sum
        // exceeding the total IS the record.
        expect(discounts.map((row) => row.amountAmount)).toEqual([400, 500]);
        expect(discounts.map((row) => row.code)).toEqual(['CONTRACT10', 'FREESHIP']);
        expect(order.totalsDiscountTotalShopAmount).toBe(400);
      });

      it('moves NO money — every total is the platform’s own, and a re-sync changes none', async () => {
        // The guard the whole change is measured against, and the ONE case here
        // that is deliberately green on both revisions: #378 adds a breakdown
        // BESIDE totals that already reconciled, so if it ever moves one of them
        // this is what says so.
        const fixture = await makeFixture();
        const source = orderWithBreakdown(fixture);

        await syncOrders(fixture.storeId, fixture.connection.id);
        const first = await importedOrder(fixture, source.externalId);

        // The platform's own figures, in minor units, on BOTH sides of every
        // `DualMoney` — Mercaria FX never re-prices an imported order.
        expect(totalsOf(first)).toEqual({
          subtotal: [2899, 2899],
          discountTotal: [400, 400],
          tax: [160, 160],
          shipping: [500, 500],
          grandTotal: [3159, 3159],
        });

        await syncOrders(fixture.storeId, fixture.connection.id);
        const second = await importedOrder(fixture, source.externalId);
        expect(totalsOf(second)).toEqual(totalsOf(first));

        // And the re-sync did not duplicate the breakdown either: it is written
        // on a first import and never backfilled or rewritten afterwards.
        const { discounts, taxLines } = await breakdownOf(second.id);
        expect(discounts).toHaveLength(1);
        expect(taxLines).toHaveLength(2);
      });
    });

    // --- SCENARIO 3: product webhooks --------------------------------------

    describe('product webhooks', () => {
      it('APPLIES a product upsert webhook through the same merge a backfill uses', async () => {
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);
        const source = fixture.world.products[0];

        fixture.world.products = fixture.world.products.map((product) =>
          product.externalId === source.externalId
            ? { ...product, title: 'Changed by webhook' }
            : product,
        );
        await processConnectorWebhook({
          connectionId: fixture.connection.id,
          topic: harness.topics.productUpsert,
          payload: harness.webhookProductPayload(fixture.world, source.externalId),
        });

        expect((await importedListing(fixture, source.externalId)).title).toBe('Changed by webhook');
      });

      it('ARCHIVES on a delete webhook, and a RE-DELIVERY is a no-op', async () => {
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);
        const source = fixture.world.products[0];
        const payload = { id: source.externalId };

        await processConnectorWebhook({
          connectionId: fixture.connection.id,
          topic: harness.topics.productDelete,
          payload,
        });
        await processConnectorWebhook({
          connectionId: fixture.connection.id,
          topic: harness.topics.productDelete,
          payload,
        });

        const listing = await importedListing(fixture, source.externalId);
        expect(listing.status).toBe('archived');
        // A platform re-delivery is ordinary. The archive is conditional on the
        // status actually moving, so the second one changes nothing at all.
        const listings = await findListingsBySourceConnection(
          fixture.storeId,
          fixture.connection.id,
        );
        expect(listings.filter((row) => row.status === 'archived')).toHaveLength(1);
      });

      it('a product moved OUT of publish stops selling, and its edit is not merged', async () => {
        // #377. The pull filters on the platform's publish state and the webhook
        // path did not, so unpublishing a product upstream was invisible until
        // the next full backfill archived it as unseen — while every edit
        // webhook in between kept writing to a listing that stayed on sale.
        //
        // The delivery carries BOTH changes at once, which is the shape a real
        // one has: a merchant unpublishes a product and its title moves in the
        // same save. So the title is what says which branch ran, rather than a
        // second delivery testing it separately.
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);
        const source = fixture.world.products[0];
        const importedTitle = (await importedListing(fixture, source.externalId)).title;

        fixture.world.products = fixture.world.products.map((product) =>
          product.externalId === source.externalId
            ? { ...product, published: false, title: 'Renamed while being unpublished' }
            : product,
        );
        await processConnectorWebhook({
          connectionId: fixture.connection.id,
          topic: harness.topics.productUpsert,
          payload: harness.webhookProductPayload(fixture.world, source.externalId),
        });

        const listing = await importedListing(fixture, source.externalId);
        if (!harness.reportsPublishState) {
          // The REFUSAL branch, measured rather than skipped: this provider
          // reports no publish state, so the delivery is an ordinary edit and
          // the listing is still on sale. A provider that silently stopped
          // reading a status it does publish would land here and be caught.
          expect(listing.status).toBe('active');
          expect(listing.title).toBe('Renamed while being unpublished');
          return;
        }
        // ARCHIVED, not `draft`: the backfill already archives this exact
        // product (it is filtered out of the pull, so it is unseen), and the
        // case below proves a backfill afterwards agrees rather than moving it
        // again.
        expect(listing.status).toBe('archived');
        // The merge did NOT run. An unpublished product's edit must not be
        // written to a listing that is being taken off sale.
        expect(listing.title).toBe(importedTitle);
      });

      it('the unpublish webhook and the BACKFILL agree — a later backfill moves it no further', async () => {
        // #377's archive-vs-draft argument, made checkable. An unpublished
        // product is absent from the pull, so the very next backfill reaches it
        // through `archiveUnseenSourcedListings`. Had the webhook written
        // `draft`, this backfill would overwrite it — two paths disagreeing
        // about one event, which is the defect rather than a variation on it.
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);
        const source = fixture.world.products[0];

        fixture.world.products = fixture.world.products.map((product) =>
          product.externalId === source.externalId ? { ...product, published: false } : product,
        );
        await processConnectorWebhook({
          connectionId: fixture.connection.id,
          topic: harness.topics.productUpsert,
          payload: harness.webhookProductPayload(fixture.world, source.externalId),
        });
        const afterWebhook = (await importedListing(fixture, source.externalId)).status;
        const run = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(run.countsFailed).toBe(0);
        const afterBackfill = (await importedListing(fixture, source.externalId)).status;
        // Whichever state the webhook path left it in, the backfill agrees with
        // it. For a provider that reports no publish state both are `active`,
        // because the product never left its pull either.
        expect(afterBackfill).toBe(afterWebhook);
        expect(afterBackfill).toBe(harness.reportsPublishState ? 'archived' : 'active');
      });

      it('a LOCALLY PINNED status survives an unpublish webhook, as it survives a backfill', async () => {
        // The merchant pinned `status` in Mercaria, so the platform no longer
        // decides it. `archiveUnseenSourcedListings` has always respected that
        // under `respect_overrides`; the webhook path reaches the same rule in
        // the same place rather than restating it.
        const fixture = await makeFixture({ conflictPolicy: 'respect_overrides' });
        await runBackfill(fixture.storeId, fixture.connection.id);
        const source = fixture.world.products[0];
        const listing = await importedListing(fixture, source.externalId);
        await updateListingColumns(listing.id, { overriddenFields: ['status'] });

        fixture.world.products = fixture.world.products.map((product) =>
          product.externalId === source.externalId ? { ...product, published: false } : product,
        );
        await processConnectorWebhook({
          connectionId: fixture.connection.id,
          topic: harness.topics.productUpsert,
          payload: harness.webhookProductPayload(fixture.world, source.externalId),
        });

        expect((await importedListing(fixture, source.externalId)).status).toBe('active');
      });

      it('the BACKFILL never puts an unpublished product on sale, whatever the pull returns', async () => {
        // #379. #377 closed the WEBHOOK; the PULL reached `importProduct`, which
        // consulted no publish state and created the listing from `autoPublish`
        // alone. That was invisible while the only provider reporting a publish
        // state ALSO filtered its pull server-side — an unpublished WooCommerce
        // product never reaches the importer, so nothing there had to check.
        // Shopify sends no status filter, so it does.
        //
        // The assertion is the OUTCOME rather than the mechanism, because the
        // two providers reach it differently and both are correct: one never
        // returns the product, the other returns it and the importer refuses it.
        // A provider that reports no publish state at all publishes it, which is
        // the branch that would catch one that stopped reading a status it does
        // send.
        const fixture = await makeFixture({ autoPublish: true });
        const source = fixture.world.products[0];
        fixture.world.products = fixture.world.products.map((product) =>
          product.externalId === source.externalId ? { ...product, published: false } : product,
        );

        const run = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(run.status).toBe('completed');
        expect(run.countsFailed).toBe(0);
        const listing = await findListingBySourceExternalId(
          fixture.storeId,
          fixture.connection.id,
          source.externalId,
        );
        if (!harness.reportsPublishState) {
          expect(listing?.status).toBe('active');
          return;
        }
        // NO listing at all, rather than one created `archived`. Nothing was
        // ever sold through it, so there is no order history or provenance to
        // preserve — and creating a row nobody can buy would put a product the
        // merchant never launched into their archive. It is also what keeps
        // `createStoreProduct`'s status set free of `archived`.
        expect(listing).toBeNull();
      });

      it('the BACKFILL archives an already-imported listing the shop has unpublished', async () => {
        // #379, the other half: no webhook is involved, so a connection whose
        // deliveries are failing still converges on the next scheduled sync.
        //
        // Again the mechanism differs and the outcome does not: for a pull that
        // filters, the product goes unseen and `archiveUnseenSourcedListings`
        // reaches it; for one that does not, the product is returned, is
        // therefore SEEN — so the unseen sweep will never touch it — and
        // `importProduct` is the only thing that can.
        const fixture = await makeFixture({ autoPublish: true });
        const source = fixture.world.products[0];
        await runBackfill(fixture.storeId, fixture.connection.id);
        expect((await importedListing(fixture, source.externalId)).status).toBe('active');

        fixture.world.products = fixture.world.products.map((product) =>
          product.externalId === source.externalId ? { ...product, published: false } : product,
        );
        const run = await runBackfill(fixture.storeId, fixture.connection.id);

        expect(run.countsFailed).toBe(0);
        expect((await importedListing(fixture, source.externalId)).status).toBe(
          harness.reportsPublishState ? 'archived' : 'active',
        );
      });

      it('an unpublish never archives a RESTRICTED listing, so a moderation restore still works', async () => {
        // #379. Archiving is a soft-delete everywhere else here; against a
        // moderation restriction it is a ONE-WAY DOOR.
        // `enforcement.service.restoreSubject` restores only from
        // `['restricted', 'draft']`, so a restricted listing moved to `archived`
        // can never be relisted by an accepted appeal — the restore is refused
        // and reports that the listing was never restricted in the first place.
        //
        // A merchant unpublishing upstream must not be able to end a jury's
        // decision, and the two facts do not conflict: the listing is already
        // off sale, which is what the unpublish was asking for.
        const fixture = await makeFixture({ autoPublish: true });
        const source = fixture.world.products[0];
        await runBackfill(fixture.storeId, fixture.connection.id);
        const listing = await importedListing(fixture, source.externalId);
        await updateListingColumns(listing.id, { status: 'restricted' });

        fixture.world.products = fixture.world.products.map((product) =>
          product.externalId === source.externalId ? { ...product, published: false } : product,
        );
        await processConnectorWebhook({
          connectionId: fixture.connection.id,
          topic: harness.topics.productUpsert,
          payload: harness.webhookProductPayload(fixture.world, source.externalId),
        });

        expect((await importedListing(fixture, source.externalId)).status).toBe('restricted');
        // And the restore an appeal would run still succeeds — the property the
        // status assertion above exists to protect, asserted rather than implied.
        expect(await setListingStatusIfIn(listing.id, 'active', ['restricted', 'draft'])).toBe(true);
      });

      it('imports EVERY variant of a MULTI-VARIANT product first seen through a webhook', async () => {
        // #220. No backfill first, deliberately: the delivery is the ONLY thing
        // Mercaria has seen of this product, which is the ordinary case for
        // anything created on the platform after the connection exists (both
        // `*/create` topics are registered). A WooCommerce delivery carries
        // `variations` as IDS and no variation objects, so before #220 this
        // imported ONE variant at the parent's lowest price with no option
        // values and no stock — and stayed that way, because nothing added the
        // missing variants later.
        const fixture = await makeFixture();
        const source = fixture.world.products.find((product) => product.variants.length > 1);
        expect(source, 'the fixture catalogue must carry a multi-variant product').toBeDefined();
        const multiVariant = source as NonNullable<typeof source>;

        await processConnectorWebhook({
          connectionId: fixture.connection.id,
          topic: harness.topics.productUpsert,
          payload: harness.webhookProductPayload(fixture.world, multiVariant.externalId),
        });

        const listing = await importedListing(fixture, multiVariant.externalId);
        const variants = await findVariantsByListing(listing.id);
        expect(variants).toHaveLength(multiVariant.variants.length);
        expect(variants.map((variant) => variant.priceAmount).sort((a, b) => a - b)).toEqual(
          multiVariant.variants
            .map((variant) => Math.round(Number(variant.price) * 100))
            .sort((a, b) => a - b),
        );
        // The stock too: a collapsed import reports zero for a product whose
        // variations each track their own, and a price assertion alone would
        // pass on a single variant that happened to be the cheapest.
        expect(variants.map((variant) => variant.inventoryAvailable).sort((a, b) => a - b)).toEqual(
          multiVariant.variants.map((variant) => variant.available).sort((a, b) => a - b),
        );
      });

      it(
        harness.webhookExpansionPathFragment === undefined
          ? 'needs NO extra call — the delivery is self-contained'
          : 'FAILS the run and changes NOTHING when the payload cannot be completed',
        async () => {
          const fixture = await makeFixture();
          await runBackfill(fixture.storeId, fixture.connection.id);
          const source = fixture.world.products.find((product) => product.variants.length > 1);
          expect(source, 'the fixture catalogue must carry a multi-variant product').toBeDefined();
          const multiVariant = source as NonNullable<typeof source>;
          const before = await importedListing(fixture, multiVariant.externalId);
          const variantsBefore = await findVariantsByListing(before.id);

          if (harness.webhookExpansionPathFragment === undefined) {
            // The measured half of the absent branch: build the provider over a
            // transport that THROWS on every call, and complete the payload with
            // it. A provider that quietly started fetching would raise here
            // rather than pass, which is what makes this an assertion about the
            // delivery rather than a case that skips.
            const deadProvider = harness.createProvider(harness.createWorld());
            const untouched = harness.webhookProductPayload(
              fixture.world,
              multiVariant.externalId,
            );
            expect(
              await deadProvider.expandWebhookProduct(
                { accessToken: 'unused', shopDomain: harness.shopDomain },
                untouched,
              ),
            ).toBe(untouched);
            return;
          }

          fixture.world.fail(harness.webhookExpansionPathFragment, 500, 99);
          await processConnectorWebhook({
            connectionId: fixture.connection.id,
            topic: harness.topics.productUpsert,
            payload: harness.webhookProductPayload(fixture.world, multiVariant.externalId),
          });

          // Fail CLOSED: a payload that cannot be completed writes nothing. The
          // listing keeps every variant it had, and — the half that matters most
          // — it is not archived, because "the platform did not answer" is never
          // evidence that a merchant deleted anything.
          const after = await importedListing(fixture, multiVariant.externalId);
          expect(after.status).toBe(before.status);
          expect(await findVariantsByListing(after.id)).toHaveLength(variantsBefore.length);
        },
      );

      it('IGNORES a product webhook when product pull is disabled', async () => {
        const fixture = await makeFixture({ products: 'off' });

        await processConnectorWebhook({
          connectionId: fixture.connection.id,
          topic: harness.topics.productUpsert,
          payload: harness.webhookProductPayload(
            fixture.world,
            fixture.world.products[0].externalId,
          ),
        });

        expect(
          await findListingsBySourceConnection(fixture.storeId, fixture.connection.id),
        ).toHaveLength(0);
      });
    });

    // --- SCENARIO 4 (stock half) + WooCommerce 2: inventory -----------------

    describe('inventory', () => {
      it('SETS stock from the platform total, and a re-run converges', async () => {
        const fixture = await makeFixture();
        await runBackfill(fixture.storeId, fixture.connection.id);

        fixture.world.products = fixture.world.products.map((product) => ({
          ...product,
          variants: product.variants.map((variant) => ({ ...variant, available: 7 })),
        }));
        const first = await syncInventory(fixture.storeId, fixture.connection.id);
        const second = await syncInventory(fixture.storeId, fixture.connection.id);

        expect(first.status).toBe('completed');
        expect(first.countsUpdated).toBeGreaterThan(0);
        expect(second.status).toBe('completed');
        const variants = await findVariantsBySourceConnection(fixture.connection.id);
        expect(variants.length).toBeGreaterThan(0);
        for (const variant of variants) {
          // An absolute SET, so running it twice lands on the same number.
          expect(variant.inventoryAvailable).toBe(7);
        }
      });
    });

    // --- SCENARIO 6: product push (capability-gated) ------------------------

    describe('product push', () => {
      it(
        harness.capabilities.pushesProducts
          ? 'PUSHES a store listing out to a bidirectional connection'
          : 'is NOT implemented — a push attempt reaches the platform with nothing',
        async () => {
          // A listing this connection did NOT import, so the loop-prevention
          // branch (never push a listing back to the connection it came from)
          // cannot be what makes the `false` case pass. Without that the absent
          // capability and a correctly-skipped origin push would be
          // indistinguishable, which is the whole failure this suite exists to
          // rule out.
          const fixture = await makeFixture({ products: 'bidirectional' });
          await runBackfill(fixture.storeId, fixture.connection.id);
          const imported = await importedListing(
            fixture,
            fixture.world.products[0].externalId,
          );
          await updateListingColumns(imported.id, {
            sourceConnectionId: null,
            sourceExternalId: null,
          });

          await pushListingToChannels(fixture.storeId, imported.id);

          if (harness.capabilities.pushesProducts) {
            expect(fixture.world.pushedProducts).toHaveLength(1);
          } else {
            // `pushListingToChannels` records the provider's refusal on a failed
            // run rather than propagating it, so the observable is that NOTHING
            // reached the platform.
            expect(fixture.world.pushedProducts).toHaveLength(0);
          }
        },
      );
    });

    // --- SCENARIO 8: fulfillment push (capability-gated) --------------------

    describe('fulfillment push', () => {
      it(
        harness.capabilities.pushesFulfillment
          ? 'PUSHES a fulfillment back for a bidirectional connection, idempotently'
          : 'is NOT implemented — a push attempt is refused rather than silently skipped',
        async () => {
          const fixture = await makeFixture({ orders: 'bidirectional' });
          await syncOrders(fixture.storeId, fixture.connection.id);
          const orders = await importedOrders(fixture.connection.id);
          // Named, not `orders[0]`: the read has no ORDER BY, and a uuid v7 key is
          // not monotonic inside a millisecond, so an index would pick at random.
          const shipped = orders.find(
            (row) => row.sourceExternalId === fixture.world.orders[0].externalId,
          );
          expect(shipped, 'the order this case ships must have been imported').toBeDefined();

          await pushOrderFulfillment((shipped as NonNullable<typeof shipped>).id);
          await pushOrderFulfillment((shipped as NonNullable<typeof shipped>).id);

          if (harness.capabilities.pushesFulfillment) {
            // Two pushes, and the SECOND must find nothing left to fulfill — the
            // platform reports zero fulfillable units once a line has shipped.
            expect(fixture.world.pushedFulfillments.length).toBe(1);
          } else {
            // `pushOrderFulfillment` swallows the provider's refusal onto a failed
            // run rather than propagating it, so the observable is that NOTHING
            // reached the platform.
            expect(fixture.world.pushedFulfillments).toHaveLength(0);
          }
        },
      );
    });

    describe('the collection taxonomy (#376)', () => {
      /**
       * `fetchCollections` is what makes `syncSettings.collectionMapping`
       * configurable at all: without it the mapping's keys are the platform's raw
       * ids, which a merchant has no way to discover and no way to type
       * correctly. It is NOT capability-gated — both platforms publish a complete
       * named list — so unlike the push cases there is no refusal branch to
       * measure, and the NOUN is what varies instead.
       */
      it('lists every grouping the shop publishes, with the platform’s own ids', async () => {
        const world = harness.createWorld();
        const provider = harness.createProvider(world);

        const listed = await provider.fetchCollections({
          accessToken: 'unused',
          shopDomain: harness.shopDomain,
          shopCurrency: harness.shopCurrency,
        });

        // Every grouping, both of Shopify's two lists included. A provider that
        // read only one would return a strict subset and this is what says so.
        expect(listed.map((c) => c.externalId).sort()).toEqual(
          world.collections.map((c) => String(c.id)).sort(),
        );

        // STRINGS, not numbers. Both platforms send a numeric id and both
        // providers write `String(id)` into `collectionRefs`; a picker emitting
        // anything else stores a key no import can ever match, and nothing
        // reports the miss.
        for (const row of listed) {
          expect(typeof row.externalId).toBe('string');
        }

        const titled = listed.find((c) => c.externalId === '8001');
        expect(titled?.title, 'a name the merchant will recognize').toBe('Tees');

        // A nameless grouping is KEPT and labelled by its id rather than dropped:
        // dropping it would silently remove a mappable collection from the picker.
        const nameless = listed.find((c) => c.externalId === '8004');
        expect(nameless, 'a nameless grouping is still mappable').toBeDefined();
        expect(nameless?.title).toContain('8004');
      });

      it('declares what this platform CALLS a grouping', () => {
        const provider = harness.createProvider(harness.createWorld());
        // Read off the SHIPPED provider rather than restated: a merchant screen
        // calling a WooCommerce category a "collection" is naming something they
        // cannot find in their own admin.
        expect(provider.externalTaxonomyNoun).toBe(harness.externalTaxonomyNoun);
        expect(['collection', 'category']).toContain(provider.externalTaxonomyNoun);
      });

      it('reports nesting exactly where the platform HAS it', async () => {
        const world = harness.createWorld();
        const provider = harness.createProvider(world);
        const listed = await provider.fetchCollections({
          accessToken: 'unused',
          shopDomain: harness.shopDomain,
          shopCurrency: harness.shopCurrency,
        });

        const child = listed.find((c) => c.externalId === '8003');
        expect(child, 'the fixture must carry a nested grouping').toBeDefined();

        if (harness.taxonomyNests) {
          expect(child?.parentExternalId, 'a nested taxonomy names the parent').toBe('8001');
          // `0` is WordPress's spelling of "root", not a term. Emitting it would
          // hand a screen a parent id matching no row in its own list.
          const root = listed.find((c) => c.externalId === '8001');
          expect(root?.parentExternalId, 'a root node has no parent').toBeUndefined();
        } else {
          // A FLAT taxonomy must not invent a hierarchy from a fixture that
          // happens to carry one — the measured half of the absent branch.
          for (const row of listed) {
            expect(row.parentExternalId).toBeUndefined();
          }
        }
      });
    });
  });
}
