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
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { ConnectorProviderId, CurrencyCode } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { categories, listings } from '../../db/schema/catalog.js';
import { connections } from '../../db/schema/connectors.js';
import { deleteTestStores } from '../../db/__tests__/store-teardown.js';
import { insertCategory } from '../../db/catalog/categoryRepository.js';
import { insertStore } from '../../db/stores/storeRepository.js';
import { insertLocation } from '../../db/stores/locationRepository.js';
import {
  findConnection,
  findConnectionCredentials,
  findConnectionsByStore,
  findConnectionWebhookFailures,
  recordConnectionWebhookRegistration,
  updateSyncSettings as updateSyncSettingsColumns,
  type ConnectionRow,
} from '../../db/connectors/connectionRepository.js';
import {
  findListingBySourceExternalId,
  findListingChildren,
  findListingsBySourceConnection,
  updateListingColumns,
} from '../../db/catalog/listingRepository.js';
import {
  findVariantsByListing,
  findVariantsBySourceConnection,
} from '../../db/catalog/variantRepository.js';
import { orders as ordersTable } from '../../db/schema/orders.js';
import {
  connectAndVerify,
  connectWithApiKey,
  disconnect,
  processConnectorWebhook,
  pushListingToChannels,
  pushOrderFulfillment,
  runBackfill,
  syncInventory,
  syncOrders,
} from '../../services/connector-sync.service.js';
import type { ConnectorCapabilities, ConnectorProvider } from '../types.js';
import type { ContractWorld } from './contract-world.js';

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
  readonly locationId: string;
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

      const location = await insertLocation(store.id, {
        name: 'Default location',
        type: 'warehouse',
        isDefault: true,
        isActive: true,
        fulfillsOnlineOrders: true,
      });

      const category = await insertCategory({
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
  });
}
