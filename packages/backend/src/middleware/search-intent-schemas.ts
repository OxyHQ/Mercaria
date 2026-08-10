/**
 * Request schemas for the natural-language intent surfaces (#95).
 *
 * Every body schema is `.strict()`, which is load-bearing rather than tidy: it
 * is what makes "this request cannot carry X" a property of the schema instead
 * of a habit at every handler.
 *
 * Four absences are the point:
 *
 * - **No `provider`, `model`, `prompt` or `temperature`.** Provider choice and
 *   prompt logic stay on the server (#95 model-boundary rule 8), so a client
 *   able to name a provider — or to send a prompt — would be a client able to
 *   pick a model no benchmark ever measured.
 * - **No `mode`, `interpretation` or `constraints`.** A client does not submit a
 *   parse; it submits a QUERY. `deterministicOnly` is the one lever it has, and
 *   it can only ever narrow (#95 client rule 5's "run plain text search"), never
 *   assert what Mercaria understood.
 * - **No `latitude`, `longitude` or address.** Safety rule 6's "do not send
 *   precise location to the model", held by there being nowhere to put one. A
 *   nearby leaning is read from the shopper's own WORDS and reported as
 *   unenforceable, which is #93's seam.
 * - **No free-text clarification answer.** An answer names an OPTION, so a
 *   second round of natural language cannot enter through the clarification
 *   path and bypass the parse budget.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  CONDITION_GROUPS,
  INTENT_QUERY_MAX_LENGTH,
  OFFER_AVAILABILITY_STATES,
  OFFER_KINDS,
  type ConditionGroup,
  type CurrencyCode,
  type OfferAvailability,
  type OfferKind,
} from '@mercaria/shared-types';

const asEnum = <T extends string>(values: readonly T[]): readonly [T, ...T[]] => {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error('An enum schema needs at least one value.');
  return [first, ...rest];
};

const idSchema = z.string().trim().min(1).max(64);

/**
 * The filters a shopper already selected in the UI (#95 input 6).
 *
 * A SUBSET of #70's `SearchFilters` — the ones a filter panel actually sets.
 * `attributes` is deliberately absent: a client that could submit an attribute
 * filter could submit a key #94 never defined, and the interpretation path
 * exists precisely to resolve those against the registry. A shopper's selected
 * attribute facets reach `GET /search` directly, where #70 validates them.
 */
const selectedFiltersSchema = z
  .object({
    categorySlugs: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
    brandIds: z.array(idSchema).max(16).optional(),
    conditionGroups: z
      .array(z.enum(asEnum(CONDITION_GROUPS as readonly ConditionGroup[])))
      .max(CONDITION_GROUPS.length)
      .optional(),
    availability: z
      .array(z.enum(asEnum(OFFER_AVAILABILITY_STATES as readonly OfferAvailability[])))
      .max(OFFER_AVAILABILITY_STATES.length)
      .optional(),
    offerKinds: z
      .array(z.enum(asEnum(OFFER_KINDS as readonly OfferKind[])))
      .max(OFFER_KINDS.length)
      .optional(),
    officialChannelOnly: z.boolean().optional(),
    merchantIds: z.array(idSchema).max(16).optional(),
    price: z
      .object({
        currency: z.enum(asEnum(ALL_CURRENCY_CODES as readonly CurrencyCode[])),
        minMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        maxMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** `POST /search-intent`. */
export const shoppingIntentSchema = z
  .object({
    // The query is BOUNDED rather than refused when long: a shopper who pasted
    // a specification sheet still means something by the first part of it, and
    // the excess is dropped before anything — the model included — sees it.
    query: z.string().min(1).max(INTENT_QUERY_MAX_LENGTH * 4),
    locale: z
      .string()
      .trim()
      .min(2)
      .max(35)
      .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u, 'A locale is a BCP-47 tag'),
    market: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/u)
      .transform((value) => value.toUpperCase())
      .optional(),
    currency: z.enum(asEnum(ALL_CURRENCY_CODES as readonly CurrencyCode[])).optional(),
    categoryId: idSchema.optional(),
    canonicalProductId: idSchema.optional(),
    sessionId: idSchema.optional(),
    clarificationAnswer: z
      .object({ clarificationId: idSchema, optionId: z.string().trim().min(1).max(64) })
      .strict()
      .optional(),
    selectedFilters: selectedFiltersSchema.optional(),
    deterministicOnly: z.boolean().optional(),
  })
  .strict();

/** `POST /internal/search-intent/benchmark-runs`. */
export const intentBenchmarkRunSchema = z
  .object({
    /** ISO 639-1 — a run measures ONE language. */
    language: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}$/u),
    categoryId: idSchema.optional(),
  })
  .strict();

/** `POST /internal/search-intent/enablements`. */
export const intentEnablementSchema = z
  .object({
    language: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}$/u),
    /** Absent is the LANGUAGE-WIDE row. See `search_intent_enablements`. */
    categoryId: idSchema.optional(),
    enabled: z.boolean(),
    benchmarkRunId: idSchema,
    note: z.string().trim().min(1).max(500),
  })
  .strict();

/** The parsed body types, written out rather than inferred — see #94's note. */
export interface ShoppingIntentBody {
  query: string;
  locale: string;
  market?: string;
  currency?: CurrencyCode;
  categoryId?: string;
  canonicalProductId?: string;
  sessionId?: string;
  clarificationAnswer?: { clarificationId: string; optionId: string };
  selectedFilters?: {
    categorySlugs?: string[];
    brandIds?: string[];
    conditionGroups?: ConditionGroup[];
    availability?: OfferAvailability[];
    offerKinds?: OfferKind[];
    officialChannelOnly?: boolean;
    merchantIds?: string[];
    price?: { currency: CurrencyCode; minMinor?: number; maxMinor?: number };
  };
  deterministicOnly?: boolean;
}

export interface IntentBenchmarkRunBody {
  language: string;
  categoryId?: string;
}

export interface IntentEnablementBody {
  language: string;
  categoryId?: string;
  enabled: boolean;
  benchmarkRunId: string;
  note: string;
}
