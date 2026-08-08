/**
 * Which adapter serves which rail.
 *
 * Deliberately tiny, and deliberately NOT a map keyed by `PaymentProviderId`:
 * only one of the three ids has an adapter at all. `external` and `manual_pos`
 * are payments Mercaria RECORDS rather than makes — nothing is authorized,
 * captured or refunded through them — so a lookup returning `undefined` for them
 * would invite a caller to treat "no adapter" as a failure instead of as the
 * defining property of those two.
 *
 * #46 and #51 add their rails by adding a resolver here beside this one, gated
 * on their own configuration. When there are three, this becomes a real lookup;
 * making it one now would be a registry with one entry and two holes.
 */

import { SyntheticPaymentProvider } from './synthetic-provider.js';

let instance: SyntheticPaymentProvider | undefined;

/**
 * The process-wide synthetic rail.
 *
 * One instance, because its payment state is in memory and a second would not
 * recognise the first's objects — a `capture` after a `createPayment` would fail
 * with `resource_missing`, which is exactly the bug a fresh instance per call
 * would produce and exactly the one that only shows up under a real flow.
 */
export function getMockPaymentProvider(): SyntheticPaymentProvider {
  instance ??= new SyntheticPaymentProvider();
  return instance;
}

/** Drop the instance. Test support — a suite must not inherit another's state. */
export function resetMockPaymentProvider(): void {
  instance = undefined;
}
