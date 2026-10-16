/**
 * The three values hosted onboarding cannot run without.
 *
 * The two URLs are read from `config.payments.stripe`, where they are declared
 * OPTIONAL, and turned into required values here — the pattern
 * `connectors/config.ts` uses for its own callback base, and for the same
 * reason: the process must still boot (and the already-shipped webhook ingress
 * must still work) when onboarding has not been configured yet. Only an actual
 * onboarding operation fails, and it fails naming the variables.
 *
 * Both URLs are checked TOGETHER and reported together. Discovering one missing
 * variable per deploy is how a configuration change takes two deploys. The
 * state token's HMAC key is derived from `MERCARIA_SECRET_KEY`
 * (`lib/derived-secrets.ts`) and is never missing.
 */

import { config } from '../../../config/index.js';
import { derivedSecret } from '../../../lib/derived-secrets.js';
import { validationError } from '../../../lib/errors/error-codes.js';

/** The resolved onboarding endpoints and signing key. */
export interface StripeOnboardingConfig {
  /** This API's public origin, with any trailing slash removed. */
  readonly baseUrl: string;
  /** Where the seller's browser lands after the hosted flow. */
  readonly returnUrl: string;
  /** HMAC key for the round-trip state token. */
  readonly stateSecret: string;
}

/** A configured absolute URL, or a message naming what is wrong with it. */
function readUrl(name: string, value: string | undefined, missing: string[]): string {
  if (value === undefined) {
    missing.push(name);
    return '';
  }
  try {
    // Parsed rather than pattern-matched: a value that is not a URL must fail
    // HERE, where the variable can be named, and not later as a redirect to
    // something a browser will interpret creatively.
    return new URL(value).toString().replace(/\/+$/, '');
  } catch {
    throw validationError(`${name} is not a valid absolute URL`);
  }
}

/**
 * The onboarding configuration, or a `validationError` naming every missing
 * variable.
 *
 * @throws When either URL is unset, or a URL cannot be parsed.
 */
export function stripeOnboardingConfig(): StripeOnboardingConfig {
  const stripe = config.payments.stripe;
  const missing: string[] = [];

  const baseUrl = readUrl('STRIPE_ONBOARDING_BASE_URL', stripe.onboardingBaseUrl, missing);
  const returnUrl = readUrl('STRIPE_ONBOARDING_RETURN_URL', stripe.onboardingReturnUrl, missing);

  if (missing.length > 0) {
    throw validationError(
      `Stripe onboarding is not configured: ${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'
      } unset.`,
    );
  }

  return { baseUrl, returnUrl, stateSecret: derivedSecret('stripe-onboarding-state') };
}

/**
 * Whether this deployment can start or resume hosted onboarding at all.
 *
 * Read by the seller-facing settings surface so the dashboard can DISABLE its
 * connect action rather than offer a button that answers with an error. A
 * predicate rather than a try/catch around {@link stripeOnboardingConfig},
 * because "can this deployment onboard" is a question worth asking directly, and
 * using an exception as a boolean is how a genuine misconfiguration ends up
 * rendered as "not available yet".
 */
export function isStripeOnboardingConfigured(): boolean {
  const stripe = config.payments.stripe;
  return (
    stripe.enabled &&
    stripe.onboardingBaseUrl !== undefined &&
    stripe.onboardingReturnUrl !== undefined
  );
}
