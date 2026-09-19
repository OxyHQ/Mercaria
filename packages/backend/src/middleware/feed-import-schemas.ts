/**
 * Request schemas for the universal feed importer (#63).
 *
 * Every schema is `.strict()`, and here that is load-bearing rather than tidy.
 * A mapping body reaches the code that decides how a stranger's file becomes
 * Mercaria's catalogue, so a field the schema does not declare — an
 * `expression`, a `template`, a `script`, a `transformFn` — must be REFUSED
 * rather than stripped. Stripping it would let a client believe the mapping it
 * sent is the mapping that runs, and the first person to notice would be a
 * merchant whose prices are wrong.
 *
 * That refusal is also the HTTP half of "the importer executes nothing a feed
 * or a mapping supplies": the schema has no member that could carry a program,
 * `feed_field_mappings` has no column that could store one, and
 * `FEED_FIELD_TRANSFORMS` is the closed set the only transform member accepts.
 */

import { z } from 'zod';
import {
  FEED_AUTH_KINDS,
  FEED_COMPRESSIONS,
  FEED_DELIVERY_MODES,
  FEED_ENCODINGS,
  FEED_FETCH_MODES,
  FEED_FIELD_ROLES,
  FEED_FIELD_TRANSFORMS,
  FEED_FORMATS,
  FEED_MAPPABLE_VALUE_ROLES,
  type FeedAuthKind,
  type FeedCompression,
  type FeedDeliveryMode,
  type FeedEncoding,
  type FeedFetchMode,
  type FeedFieldRole,
  type FeedFieldTransform,
  type FeedFormat,
} from '@mercaria/shared-types';

function tuple<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error('An empty value set cannot type an enum.');
  return [first, ...rest];
}

const FORMAT_VALUES = tuple<FeedFormat>(FEED_FORMATS);
const ENCODING_VALUES = tuple<FeedEncoding>(FEED_ENCODINGS);
const COMPRESSION_VALUES = tuple<FeedCompression>(FEED_COMPRESSIONS);
const DELIVERY_MODE_VALUES = tuple<FeedDeliveryMode>(FEED_DELIVERY_MODES);
const FETCH_MODE_VALUES = tuple<FeedFetchMode>(FEED_FETCH_MODES);
const AUTH_KIND_VALUES = tuple<FeedAuthKind>(FEED_AUTH_KINDS);
const ROLE_VALUES = tuple<FeedFieldRole>(FEED_FIELD_ROLES);
const TRANSFORM_VALUES = tuple<FeedFieldTransform>(FEED_FIELD_TRANSFORMS);
const VALUE_ROLE_VALUES = tuple<FeedFieldRole>(FEED_MAPPABLE_VALUE_ROLES);

/** A feed's own column name. A NAME — never a path expression. */
const sourceField = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9_:.[\] -]+$/u,
    'A source field is a column, element or key NAME. Path expressions are not evaluated.',
  );

export const createFeedConfigurationSchema = z
  .object({
    sourceName: z.string().trim().min(3).max(200),
    label: z.string().trim().min(1).max(200),
    /**
     * FROZEN once written (`mercaria_feed_configuration_identity_frozen`).
     * Bounded to four because a composite key longer than that is a row hash
     * wearing a key, and re-keying a feed retires the catalogue behind the old
     * ids.
     */
    identityKeyFields: z.array(sourceField).min(1).max(4),
    merchantId: z.string().trim().min(1).max(64).optional(),
    territories: z.array(z.string().trim().regex(/^[A-Z]{2}$/u)).max(64).optional(),
    fetchCadenceSeconds: z.number().int().min(60).max(30 * 24 * 60 * 60).optional(),
    freshnessTtlSeconds: z.number().int().min(60).max(30 * 24 * 60 * 60).optional(),
  })
  .strict();

export type CreateFeedConfigurationBody = z.infer<typeof createFeedConfigurationSchema>;

/**
 * The OPERATOR's create body — the merchant one plus `sourceKind`.
 *
 * `.extend` rather than a second literal, so a field added to the merchant
 * schema cannot be forgotten here; and the extension is one-directional on
 * purpose. A merchant may NOT declare their own feed an `affiliate_network`:
 * that kind says Mercaria links out to somebody else's shop and earns a
 * commission on the click, which is a statement about a contract Mercaria
 * signed, not about a file a store uploaded. Letting the merchant surface set
 * it would let a store turn its own catalogue into an offer that carries an
 * affiliate disclosure and no affiliate relationship.
 *
 * Defaulted rather than required: an operator-managed feed is usually just a
 * feed, and making every caller state the ordinary case is how the unusual one
 * stops being read.
 */
export const createOperatorFeedConfigurationSchema = createFeedConfigurationSchema
  .extend({
    sourceKind: z.enum(['feed', 'affiliate_network']).default('feed'),
  })
  .strict();

export type CreateOperatorFeedConfigurationBody = z.infer<
  typeof createOperatorFeedConfigurationSchema
>;

/**
 * ONE mapping instruction: a column, or a constant. There is no third member.
 *
 * The `superRefine` states the same rule `feed_field_mappings_source_shape_check`
 * enforces at the row, in words a merchant can act on: a 23514 never says which
 * of their form rows is the problem.
 */
const fieldMapping = z
  .object({
    role: z.enum(ROLE_VALUES),
    sourceField: sourceField.optional(),
    constantValue: z.string().max(512).optional(),
    transform: z.enum(TRANSFORM_VALUES).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const provided = [value.sourceField, value.constantValue].filter(
      (candidate) => candidate !== undefined,
    );
    if (provided.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'A mapping names exactly one of a source column or a constant value. There is ' +
          'deliberately no expression, template or fallback chain.',
      });
    }
  });

const valueMapping = z
  .object({
    role: z.enum(VALUE_ROLE_VALUES),
    sourceValue: z.string().trim().min(1).max(120),
    targetValue: z.string().trim().min(1).max(120),
  })
  .strict();

export const draftFeedVersionSchema = z
  .object({
    fetchMode: z.enum(FETCH_MODE_VALUES),
    /**
     * HTTPS only, refused here as well as by the column's CHECK. A feed served
     * in cleartext can be rewritten in transit, and a rewritten feed is a
     * catalogue of somebody else's choosing — including its prices.
     */
    feedUrl: z.string().trim().url().startsWith('https://').max(2_048).optional(),
    uploadId: z.string().trim().min(1).max(64).optional(),
    format: z.enum(FORMAT_VALUES),
    delimiter: z.string().length(1).optional(),
    quoteChar: z.string().length(1).optional(),
    encoding: z.enum(ENCODING_VALUES).optional(),
    compression: z.enum(COMPRESSION_VALUES).optional(),
    recordPath: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_:.[\]/-]+$/u).optional(),
    hasHeaderRow: z.boolean().optional(),
    listSeparator: z.string().length(1).optional(),
    defaultCurrency: z.string().trim().regex(/^[A-Za-z]{3,4}$/u).transform((value) => value.toUpperCase()).optional(),
    defaultCountry: z.string().trim().regex(/^[A-Za-z]{2}$/u).transform((value) => value.toUpperCase()).optional(),
    defaultLanguage: z.string().trim().max(35).optional(),
    /**
     * The most consequential field in this body.
     *
     * `snapshot` says a completed enumeration is evidence that an omitted row is
     * gone; `delta` says it is evidence of nothing. There is no default: a
     * merchant who does not know which their feed is must find out, because the
     * wrong answer either retires a healthy catalogue or leaves delisted
     * products on sale forever.
     */
    deliveryMode: z.enum(DELIVERY_MODE_VALUES),
    authKind: z.enum(AUTH_KIND_VALUES).optional(),
    /** PLAINTEXT, encrypted before storage and never returned by any read. */
    authSecret: z.string().min(1).max(4_096).optional(),
    authParamName: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/u).optional(),
    mappingNote: z.string().trim().max(512).optional(),
    fieldMappings: z.array(fieldMapping).min(1).max(FEED_FIELD_ROLES.length),
    valueMappings: z.array(valueMapping).max(200).optional(),
  })
  .strict();

export type DraftFeedVersionBody = z.infer<typeof draftFeedVersionSchema>;

export const activateFeedVersionSchema = z
  .object({
    /** The `validation` report that justified it (issue Mapping UX 6). */
    reportId: z.string().trim().min(1).max(64),
  })
  .strict();

export type ActivateFeedVersionBody = z.infer<typeof activateFeedVersionSchema>;

/**
 * An upload's METADATA. The bytes arrive as the raw request body.
 *
 * The filename is a LABEL and is sanitised again server-side; the declared
 * compression is compared against the artefact's own magic bytes, because a
 * gzip uploaded as `none` is handed to the CSV parser as binary and produces
 * ten thousand malformed records instead of one honest refusal.
 */
export const feedUploadMetadataSchema = z
  .object({
    filename: z.string().trim().min(1).max(200),
    compression: z.enum(COMPRESSION_VALUES),
  })
  .strict();

export type FeedUploadMetadataQuery = z.infer<typeof feedUploadMetadataSchema>;
