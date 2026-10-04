/**
 * The scalar building blocks every public shape is made of.
 *
 * Every pattern here is written WITHOUT regex flags, because JSON Schema's
 * `pattern` has none: `z.toJSONSchema` exports `regex.source`, so an `i` flag
 * would make the published schema narrower than the zod schema it came from.
 */

import { z } from 'zod';
import { ALL_CURRENCY_CODES, type CurrencyCode } from '@mercaria/shared-types';

/** An opaque id: a string with at least one non-space character. Never parsed. */
export const MercariaIdSchema = z
  .string()
  .regex(/\S/, 'must contain a non-space character')
  .describe('An opaque id. Never parse it.');

/**
 * An absolute `http(s)` URL. A pattern rather than `new URL()`, which React
 * Native only partly implements; refusing every other scheme is what keeps a
 * `javascript:` value out of a consumer's `<img src>` or link.
 */
export const MercariaHttpUrlSchema = z
  .string()
  .regex(/^https?:\/\/[^\s/?#]+\S*$/, 'must be an absolute http(s) URL')
  .describe('An absolute http(s) URL.');

/** An ISO-8601 UTC timestamp (`2026-09-13T10:00:00.000Z`). */
export const MercariaTimestampSchema = z.iso.datetime().describe('An ISO-8601 UTC timestamp.');

/** A non-negative safe integer. */
export const MercariaCountSchema = z.number().int().min(0);

/** A CSS hex colour (`#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`). */
export const MercariaHexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'must be a CSS hex colour');

/**
 * A price: integer minor units in the listing's NATIVE currency. Every money
 * value in this contract is a price, so a negative or fractional amount is
 * malformed. Nothing on the public surface converts currency.
 */
export const MercariaMoneySchema = z
  .object({
    amount: MercariaCountSchema.describe('Integer minor units (cents for EUR, yen for JPY).'),
    currency: z.enum(ALL_CURRENCY_CODES as readonly [CurrencyCode, ...CurrencyCode[]]),
  })
  .describe('A price in the listing’s native currency.');
export type MercariaMoney = z.infer<typeof MercariaMoneySchema>;

/** An image, as an absolute URL a foreign client can render directly. */
export const MercariaImageSchema = z.object({
  url: MercariaHttpUrlSchema,
  alt: z.string().nullable().describe('Accessible description, or null when the seller gave none.'),
});
export type MercariaImage = z.infer<typeof MercariaImageSchema>;
