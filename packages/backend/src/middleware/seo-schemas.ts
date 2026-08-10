/**
 * Request schemas for the public routing and SEO surface (#75).
 *
 * `.strict()`, like every schema in this backend: an undeclared key is a 400
 * rather than a silently ignored one. The path parameter is the interesting
 * case — it is a URL supplied by the edge on a crawler's behalf, so it is
 * checked for the two shapes that would make the resolver answer about a
 * DIFFERENT address than the one requested.
 */

import { z } from 'zod';

/**
 * The longest path the resolver will consider.
 *
 * A bound rather than a judgement: every registered pattern is two segments and
 * a slug, so anything approaching this is not one of Mercaria's addresses and
 * matching it against the registry is work spent on a probe.
 */
const MAX_PATH_CHARACTERS = 2048;

/**
 * `GET /seo/resolve?path=/p/example`
 *
 * The path must be ABSOLUTE and must not be protocol-relative. `//evil.example`
 * parses as a host under some URL readers and as a path under others, and the
 * two disagreeing is how a resolver ends up describing somebody else's page —
 * so it is refused here rather than normalised somewhere downstream.
 */
export const seoResolveQuerySchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(MAX_PATH_CHARACTERS)
      .refine((value) => value.startsWith('/'), { message: 'path must be absolute' })
      .refine((value) => !value.startsWith('//'), {
        message: 'path must not be protocol-relative',
      })
      .refine((value) => !value.includes('\\'), { message: 'path must not contain a backslash' }),
  })
  .strict();
