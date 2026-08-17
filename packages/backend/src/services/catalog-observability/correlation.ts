/**
 * One correlation id per request, carried through async work (#367 W17).
 *
 * The thing that makes a publish, its offer convergence, its match evaluation
 * and the log lines each of them wrote readable as ONE event rather than as four
 * unrelated ones. There was no such id anywhere in this backend before #367 —
 * no request id, no `AsyncLocalStorage`, no `cls` — so this file is the whole of
 * it, and the two decisions below are the ones a later reader will want.
 *
 * ## Why `AsyncLocalStorage` and not a parameter threaded through
 *
 * The chain crosses three transactions and two queues (`docs/catalog-observability.md`
 * — publish commits, the offer outbox converges on a later tick, the match queue
 * on a later one still). A parameter would have to be added to every repository
 * signature on the path, and the first function that forgot would silently break
 * the join with no test able to see it. The store is read by ONE consumer
 * (`catalog-log.ts`) and is never a function's input, so nothing here can become
 * a hidden argument to business logic: a service that behaved differently
 * because a correlation id was in scope would be untestable, which is the actual
 * hazard with ambient context.
 *
 * ## An INBOUND id is a security decision, not a convenience
 *
 * Accepting `X-Mercaria-Correlation-Id` verbatim gives an unauthenticated caller
 * two things. First, log injection: the value is written into structured log
 * lines an operator reads and a log pipeline parses, so a newline, a quote or a
 * hundred kilobytes of prose becomes ours to store and render. Second, and
 * worse, a cross-request correlation primitive — anybody who can choose the id
 * can make two unrelated requests, from two unrelated people, share one trace
 * handle, which is exactly the linkage every guest and analytics decision in
 * this repository is shaped to prevent (ADR 0003 I11: no per-person correlation
 * key, ever).
 *
 * So an inbound id is admitted only through `CORRELATION_ID_PATTERN` — bounded
 * length, `[A-Za-z0-9_-]` and nothing else, which is a character set with no
 * newline, no quote and no separator any log format treats specially — and
 * anything else MINTS a fresh one rather than being refused with an error. A 400
 * would be worse than useless: a header a client got wrong would fail the
 * request it was only trying to label, and the shape gate's whole purpose is
 * that it can never be the reason a catalog read fails.
 *
 * The id is still not TRUSTED after passing the gate; it is merely harmless. It
 * says "this client claims these requests belong together" and is reported as
 * `client_supplied` so a reader of the trace knows which of the two it is.
 *
 * ## Nothing about a PERSON is in the store
 *
 * The context holds one field and it is the id. No Oxy user id, no guest session
 * id, no bearer token, no IP. A correlation id correlates a REQUEST; the moment
 * an identity rides in the same ambient store, every log line in the process
 * acquires one by default and the allow-list in `catalog-log.ts` is worthless.
 * `CatalogCorrelationContext` is deliberately not exported, so no other module
 * can widen it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

/**
 * The request header a client may present and the response header every request
 * is answered with.
 *
 * Lower-case: Node normalizes inbound header names, and `res.setHeader` is
 * case-insensitive, so one spelling serves both directions.
 */
export const CORRELATION_ID_HEADER = 'x-mercaria-correlation-id';

/**
 * Marks a minted id apart from a client's at a glance in a log line, without
 * needing the `origin` field beside it.
 */
const CORRELATION_ID_PREFIX = 'mco_';

/** 128 bits, hex-encoded. Collision-free at any traffic this service will see. */
const CORRELATION_ID_ENTROPY_BYTES = 16;

/** Bounds stated as constants because the pattern below is rendered from them. */
export const CORRELATION_ID_MIN_LENGTH = 8;
export const CORRELATION_ID_MAX_LENGTH = 64;

/**
 * The shape gate.
 *
 * A REGEX LITERAL with its bounds written out, NOT assembled from a template
 * string. A pattern built with `new RegExp(\`…\`)` silently loses every
 * backslash the template swallowed, and the failure direction is the dangerous
 * one — a class that matches MORE than it was meant to, here admitting the very
 * newline this gate exists to keep out, with every test still green
 * (`~/Oxy/AGENTS.md`; measured in this repository inside a drizzle CHECK). The
 * literal costs one duplicated pair of numbers, and
 * `correlation.test.ts` asserts the literal and the two constants agree, so the
 * duplication cannot drift.
 *
 * Anchored at BOTH ends: an unanchored pattern admits `ok-id\ninjected: line`,
 * because the prefix matches. There is also deliberately no `\s`, no `.` and no
 * escape of any kind in the class — the safest pattern to write is one with
 * nothing in it that a template could have eaten.
 */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * A correlation id that has passed the shape gate.
 *
 * Branded with a module-private `unique symbol`, so no other file can produce
 * one: `runWithCorrelationId` therefore cannot be handed an unvalidated string
 * at all, and the guarantee "everything in the store passed the gate" is a
 * property of the type rather than of a runtime check somebody has to remember.
 * The `BuyerRequestActor` device (#110), for the same reason — the alternative
 * was a throw, and a throw inside request middleware fails the request it was
 * only labelling.
 */
declare const CORRELATION_ID_BRAND: unique symbol;
export type CorrelationId = string & { readonly [CORRELATION_ID_BRAND]: 'catalog-correlation-id' };

/** Not exported: see the header. One field, and it is not a person. */
interface CatalogCorrelationContext {
  readonly correlationId: CorrelationId;
}

const storage = new AsyncLocalStorage<CatalogCorrelationContext>();

/** Mint a fresh, server-side correlation id. */
export function newCorrelationId(): CorrelationId {
  const id = `${CORRELATION_ID_PREFIX}${randomBytes(CORRELATION_ID_ENTROPY_BYTES).toString('hex')}`;
  // An assertion rather than a cast of convenience: the composition above is the
  // one place in this file that produces a branded value without going through
  // the gate, so it is asserted against the gate here. `mco_` + 32 hex is 36
  // characters, inside the bounds — and if either constant moved, this is where
  // it would be caught rather than in a log line six weeks later.
  if (!CORRELATION_ID_PATTERN.test(id)) {
    throw new Error('A minted correlation id does not satisfy CORRELATION_ID_PATTERN.');
  }
  return id as CorrelationId;
}

/** Why a request is carrying a minted id rather than the one it presented. */
export type CorrelationIdMintReason = 'none_presented' | 'not_a_string' | 'malformed';

/**
 * Where the correlation id on this request came from.
 *
 * A STRING discriminant, not `clientSupplied: boolean`: this backend compiles
 * with `strict: false`, and without `strictNullChecks` TypeScript does not
 * narrow a union on a boolean-literal discriminant, so a caller checking the
 * flag would still be holding the whole union (`~/Oxy/Mercaria/AGENTS.md`).
 */
export type CorrelationIdResolution =
  | { readonly origin: 'client_supplied'; readonly correlationId: CorrelationId }
  | {
      readonly origin: 'minted';
      readonly correlationId: CorrelationId;
      readonly reason: CorrelationIdMintReason;
    };

/**
 * Decide this request's correlation id from whatever the client presented.
 *
 * Never throws and never refuses: every input produces an id. `presented` is
 * typed `unknown` on purpose — Express hands back `string | string[] |
 * undefined` for a header, and a repeated header is an array, which is neither
 * a valid id nor an error worth having.
 */
export function resolveCorrelationId(presented: unknown): CorrelationIdResolution {
  if (presented === undefined || presented === null || presented === '') {
    return { origin: 'minted', correlationId: newCorrelationId(), reason: 'none_presented' };
  }
  if (typeof presented !== 'string') {
    // A repeated header, which arrives as an array. Two claims about which
    // requests belong together, and nothing says which one to believe.
    return { origin: 'minted', correlationId: newCorrelationId(), reason: 'not_a_string' };
  }
  if (!CORRELATION_ID_PATTERN.test(presented)) {
    return { origin: 'minted', correlationId: newCorrelationId(), reason: 'malformed' };
  }
  return { origin: 'client_supplied', correlationId: presented as CorrelationId };
}

/**
 * Run `fn` with `correlationId` in scope for it and for everything it awaits.
 *
 * The id can only have come from `newCorrelationId` or `resolveCorrelationId`,
 * because nothing else can produce a `CorrelationId`.
 */
export function runWithCorrelationId<T>(correlationId: CorrelationId, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

/**
 * The correlation id in scope, or `undefined` outside a request.
 *
 * `undefined` rather than a placeholder: a dispatcher tick, a migration and a
 * script legitimately have no request behind them, and inventing an id for them
 * would put lines that belong to no request into a trace that claims one.
 */
export function currentCorrelationId(): CorrelationId | undefined {
  return storage.getStore()?.correlationId;
}
