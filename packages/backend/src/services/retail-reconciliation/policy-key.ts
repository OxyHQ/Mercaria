/**
 * The reconciliation policy's stable logical id.
 *
 * A code CONSTANT and not an environment variable, for the reason #120's
 * pricing-policy key and #122's sourcing-policy key are: a deployment able to
 * name a different key could publish a version under one name and reconcile
 * against another, and the two would never disagree loudly — every order would
 * simply reconcile under no active policy and record nothing.
 *
 * Changing it is a code change plus a published version under the new name, in
 * one commit.
 */
export const RETAIL_RECONCILIATION_POLICY_KEY = 'mercaria-retail-reconciliation';
