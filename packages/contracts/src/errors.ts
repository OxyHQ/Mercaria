/**
 * The error half of the contract (`~/Oxy/docs/api-conventions.md` §Errors).
 *
 * Every non-2xx response under `/public/v1` — the rate limiter's 429 included —
 * is `{ "error": { "code", "message", "details"? } }`. A consumer branches on
 * `code` (the SDK maps each one to a typed error) and never parses `message`.
 * `details` holds scalars only, and never user content.
 *
 * Renaming a code is a breaking change.
 */

import { z } from 'zod';

/**
 * The closed list of codes `/public/v1` answers with — the shared Oxy set. A
 * Mercaria domain code (such as `out_of_stock`) joins this list when a route
 * that can emit it does; no public read can today.
 */
export const MERCARIA_PUBLIC_ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'unknown_route',
  'gone',
  'conflict',
  'validation_failed',
  'rate_limited',
  'internal_error',
  'service_unavailable',
] as const;
export type MercariaPublicErrorCode = (typeof MERCARIA_PUBLIC_ERROR_CODES)[number];

/**
 * The HTTP status each code is answered with.
 *
 * `gone` is the one a consumer holding a persisted ref cannot live without: the
 * entity EXISTED and is no longer publicly available, and it deliberately says
 * nothing about WHY. `unknown_route` is never `not_found`: a client and a server
 * that disagree about the route table must not read as "this entity does not
 * exist", or a consumer would discard a valid persisted reference.
 */
export const MERCARIA_PUBLIC_ERROR_STATUS = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  unknown_route: 404,
  gone: 410,
  conflict: 409,
  validation_failed: 422,
  rate_limited: 429,
  internal_error: 500,
  service_unavailable: 503,
} as const satisfies Record<MercariaPublicErrorCode, number>;

export const MercariaPublicErrorCodeSchema = z.enum(MERCARIA_PUBLIC_ERROR_CODES);

/** Scalars only — never an object, an array, user content or a coordinate. */
export const MercariaErrorDetailsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type MercariaErrorDetails = z.infer<typeof MercariaErrorDetailsSchema>;

/** The body of every non-2xx response. */
export const MercariaErrorBodySchema = z.object({
  error: z.object({
    code: MercariaPublicErrorCodeSchema,
    message: z.string().describe('Human-readable and safe to log. Never parse it.'),
    details: MercariaErrorDetailsSchema.optional().describe(
      'Scalars only. `rate_limited` carries `retryAfterSeconds`; request errors carry `field`.',
    ),
  }),
});
export type MercariaErrorBody = z.infer<typeof MercariaErrorBodySchema>;

/** Build an error body. One spelling, so no surface hand-assembles the shape. */
export function mercariaErrorBody(
  code: MercariaPublicErrorCode,
  message: string,
  details?: MercariaErrorDetails,
): MercariaErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

// ── Request errors: shape versus value ─────────────────────────────────────

/**
 * zod issue codes that mean the request is not WELL-FORMED: a wrong type, a
 * missing field, an unknown or repeated parameter (Express hands a repeated one
 * over as an array), a value that does not parse as its type. Every other issue
 * — out of range, not one of the allowed values, a cross-field rule — means it
 * is well-formed and the VALUE is refused.
 */
const SHAPE_ISSUE_CODES: ReadonlySet<string> = new Set([
  'invalid_type',
  'unrecognized_keys',
  'invalid_format',
  'invalid_union',
  'invalid_key',
  'invalid_element',
]);

/** The longest field name a request error echoes in `details.field`. */
const MAX_FIELD_LENGTH = 64;

export type MercariaRequestErrorCode = Extract<MercariaPublicErrorCode, 'bad_request' | 'validation_failed'>;

/** A refused request, classified: what to answer and with which scalars. */
export interface MercariaRequestError {
  code: MercariaRequestErrorCode;
  message: string;
  details: { field: string } | undefined;
}

function issueField(issue: z.core.$ZodIssue): string | undefined {
  const path = issue.code === 'unrecognized_keys' && issue.keys.length > 0 ? [issue.keys[0]] : issue.path;
  const field = path.map(String).join('.');
  return field === '' ? undefined : field.slice(0, MAX_FIELD_LENGTH);
}

/**
 * Classify a refused request: `bad_request` (400) when any issue is about its
 * SHAPE, `validation_failed` (422) when every issue is about a VALUE. Shared by
 * the backend, which answers with it, and the SDK, which refuses the same input
 * before sending it.
 */
export function classifyRequestIssues(issues: readonly z.core.$ZodIssue[]): MercariaRequestError {
  const shape = issues.some((issue) => SHAPE_ISSUE_CODES.has(issue.code));
  const first = issues.find((issue) => SHAPE_ISSUE_CODES.has(issue.code) === shape) ?? issues[0];
  const field = first ? issueField(first) : undefined;
  return {
    code: shape ? 'bad_request' : 'validation_failed',
    message: issues
      .map((issue) => {
        const name = issueField(issue);
        return name === undefined || issue.code === 'unrecognized_keys' ? issue.message : `${name}: ${issue.message}`;
      })
      .join('; '),
    details: field === undefined ? undefined : { field },
  };
}
