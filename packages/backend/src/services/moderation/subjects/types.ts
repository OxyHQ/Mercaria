/**
 * The seam that makes this integration Mercaria's rather than a copy of someone
 * else's.
 *
 * Everything downstream of a snapshot — resource ids, relations, digests,
 * pseudonymous principal refs, the identity binding proof, the pinned policy
 * version, privacy terms, the idempotency key, the envelope — is composed by
 * `@oxyhq/crowdsource` and is IDENTICAL for every application. What is left for
 * Mercaria is a translation problem, and this file is the whole of it:
 *
 *     "given one of MY nouns and its id, describe the material"
 *
 * So adding a subject type is one provider file plus one line in the registry.
 * Nothing in the outbox, the delivery worker, the webhook receiver or the
 * enforcement service knows what a listing is.
 *
 * Two rules keep it that way, and both are load-bearing rather than stylistic:
 *
 * 1. **A provider returns a DESCRIPTION, never an envelope.** The types below are
 *    the SDK's own input types, re-exported unchanged. A provider that built an
 *    envelope would have to invent resource ids and principal refs, and the
 *    dedup key is computed over exactly those — two shoppers reporting one
 *    counterfeit listing would open two cases, two juries and two consequences,
 *    with nothing failing in a test.
 * 2. **A provider is pure translation with reads.** It loads its own object and
 *    returns. It does not decide whether to deliver, what the allegation is, or
 *    what happens to the report. Those belong to callers that are shared.
 */

import type { ContextInput, ReportSubjectInput, ResourceInput } from '@oxyhq/crowdsource';

/**
 * The SDK's resource description, unchanged.
 *
 * Aliased so a provider imports the vocabulary from this seam rather than from
 * four places — but it IS the SDK's type, not a local restatement. A resource
 * type added to the contract becomes available to every provider the moment the
 * dependency is bumped, and a field removed from it stops compiling instead of
 * being silently ignored at ingress.
 */
export type ModerationResource = ResourceInput;
export type ModerationContextResource = ContextInput;

/** One reported object, described. */
export interface ModerationSubjectSnapshot {
  /** Identity, type and owner of the reported object. */
  readonly subject: ReportSubjectInput;
  /** The reported material itself. A string is shorthand for plain text. */
  readonly content: string | ModerationResource;
  /** Media carried BY the subject. */
  readonly attachments?: readonly ModerationResource[];
  /**
   * Surrounding material a jury needs to judge fairly — the listing a review is
   * about, the price and condition a "misleading listing" claim turns on.
   * Context, not extra exposure: a reviewer sees the minimum that makes the
   * question answerable.
   */
  readonly context?: readonly ModerationContextResource[];
}

/**
 * Translates one of Mercaria's nouns into universal material.
 *
 * `subjectType` is declared on the provider rather than returned per snapshot
 * because it is a property of the noun: every Mercaria listing is a
 * `commerce.listing`. Keeping it here means the registry can answer "what does
 * this application report?" without loading a single object.
 */
export interface ModerationSubjectProvider {
  /** Mercaria's own name for the noun, as it arrives on a report. */
  readonly reportedType: string;
  /** The contract's namespaced subject type. */
  readonly subjectType: string;
  /**
   * Describes the object, or returns `null` when it no longer exists.
   *
   * `null` is not a failure. An item deleted between the report and its delivery
   * is ordinary in a marketplace — sellers remove listings constantly — and it is
   * the caller's job to decide what that means. A provider that threw would make
   * a deleted listing look like an outage and be retried for days.
   */
  snapshot(reportedId: string): Promise<ModerationSubjectSnapshot | null>;
}
