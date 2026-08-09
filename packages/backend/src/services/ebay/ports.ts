/**
 * The four capabilities the eBay adapter is CONSTRUCTED with, and the exact
 * shape of each — issue #65, and the one place #62's write boundary needed
 * something said out loud rather than merely obeyed.
 *
 * ## Why an adapter has ports at all
 *
 * #62 hands an adapter no database, no transaction, no repository and no
 * service, and that is what makes "an adapter cannot write to the commerce
 * graph" a property of the signature rather than a rule somebody follows. Two
 * of eBay's own requirements cannot be met inside that signature, and neither
 * of them is a write:
 *
 *  - **The call budget is fleet-wide or it is nothing.** eBay meters 5,000 calls
 *    a day against the APPLICATION. A counter in each ECS task bounds each task,
 *    so N tasks draw N × 5,000 against a 5,000-call agreement. The bound has to
 *    be durable, and durable means Postgres.
 *  - **The verification pass enumerates the items Mercaria already tracks.**
 *    "This item is no longer publicly available on eBay" — the deletion
 *    obligation in the API License Agreement — is establishable only by asking
 *    eBay about items Mercaria holds, by id. The adapter cannot know which those
 *    are unless something tells it.
 *
 * ## What keeps this from being a hole in the boundary
 *
 * Every port below is defined in THIS file, which imports nothing at all, and
 * each is the narrowest interface that answers its question:
 *
 *  1. Not one method returns a row, an entity, a repository or a handle. The
 *     widest return type here is a list of the provider's OWN item ids, which is
 *     information the adapter is about to send back to the provider.
 *  2. Not one method WRITES anything the adapter chose. `reserve` records a
 *     number of calls the adapter is about to make; there is no parameter
 *     through which to name a merchant, a product, an offer or a price.
 *  3. `ebay-write-boundary.test.ts` pins the shapes themselves, so a future
 *     method that could carry a canonical id fails the build rather than a
 *     review.
 *
 * The alternative — a `catalog_source_objects` read inside the adapter — is what
 * the ports exist INSTEAD of. Handing a provider module a repository to fetch a
 * cohort would hand it the repository, and the next thing it needed would arrive
 * through the same import.
 */

/** How many provider calls a reservation asked for, and what it got. */
export interface EbayBudgetGrant {
  /** Whether the whole reservation was granted. Budgets never partially grant. */
  readonly granted: boolean;
  /** Calls already spent today, after this reservation. For the metric, not for a decision. */
  readonly callsUsed: number;
  /** The allowance today was measured against. */
  readonly dailyLimit: number;
}

/**
 * The fleet-wide daily call budget.
 *
 * `reserve` is called BEFORE each provider call and never after: a call made and
 * then counted is a call the budget could not have refused, which is the whole
 * failure this port exists to prevent. A refusal is not an error — the adapter
 * stops the page, reports the enumeration INCOMPLETE, and nothing is retired.
 */
export interface EbayCallBudget {
  reserve(input: { applicationKey: string; calls: number; now: Date }): Promise<EbayBudgetGrant>;
}

/**
 * The items Mercaria currently believes this source publishes.
 *
 * Keyset-paginated on the provider's own id so a verification pass resumes
 * exactly where a lease expired, and RETURNS NOTHING ELSE — no offer, no
 * merchant, no price, no canonical anything. What the adapter does with the list
 * is hand it back to eBay twenty at a time and report which ones eBay still
 * answers for.
 *
 * `afterExternalId` is exclusive and `null` starts from the beginning. The order
 * is the provider id's own ascending order, which is stable and is not a
 * creation order — a cohort that reordered between pages would silently skip
 * items, and a skipped item in a verification pass is an item that gets retired
 * for having been missed.
 */
export interface EbayTrackedItemCohort {
  listTrackedItemIds(input: {
    sourceId: string;
    afterExternalId: string | null;
    limit: number;
    /**
     * Exclude items already re-observed at or after this instant — the pass's
     * own start.
     *
     * Discovery and verification are two halves of one enumeration, and an item
     * discovery just re-found does not need to be asked about by name. The
     * completeness claim is unchanged: every tracked item was either
     * re-observed or asked about. `null` verifies the whole cohort, which is the
     * conservative direction and what a cursor written before this existed gets.
     */
    notSeenSince: Date | null;
  }): Promise<readonly string[]>;
}

/** One configured discovery query, exactly as the sweep needs it. */
export interface EbayDiscoveryTarget {
  readonly marketplaceId: string;
  readonly queryKind: 'category' | 'keyword';
  readonly queryValue: string;
  readonly maxOffset: number;
}

/**
 * The bounded cohort a source discovers through.
 *
 * eBay grants search-driven discovery and publishes no catalogue export, so the
 * "catalogue" is exactly this list. It is read fresh at the start of every page
 * rather than cached on the adapter, because an operator disabling a runaway
 * category during an incident must take effect on the next page and not on the
 * next process restart.
 */
export interface EbayDiscoveryPlan {
  listDiscoveryTargets(input: { sourceId: string }): Promise<readonly EbayDiscoveryTarget[]>;
}

/**
 * The clock.
 *
 * Injected so the contract suite can drive a run at a fixed instant. It is not a
 * capability in the sense the other three are; it is here because an adapter
 * calling `new Date()` directly is untestable at the one place it matters, which
 * is a token that expires mid-page.
 */
export interface EbayClock {
  now(): Date;
}
