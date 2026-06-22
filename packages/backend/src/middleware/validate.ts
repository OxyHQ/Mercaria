/**
 * Request validation middleware (Zod).
 *
 * Ported from Mention's `middleware/validate.ts`, but every validation failure
 * is routed through Mercaria's `sendError(res, ErrorCodes.VALIDATION_ERROR, …)`
 * so it emits the canonical Mercaria envelope (`error` as a string code) rather
 * than Mention's nested `{ code, message }` shape.
 *
 * Domain schemas (listing, store, cart, …) are added by their respective
 * phases; this module provides only the reusable middleware factories.
 */

import type { Request, Response, NextFunction } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { sendError, ErrorCodes } from '../utils/api-response.js';

/** Flatten Zod issues into a single human-readable message. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

/**
 * Validate `req.body` against `schema`. On success, replaces `req.body` with
 * the parsed (and possibly defaulted/coerced) result; on failure responds 400.
 */
export function validateBody<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, formatIssues(result.error), 400);
      return;
    }
    req.body = result.data;
    next();
  };
}

/**
 * Validate `req.query` against `schema`. On success, replaces `req.query` with
 * the parsed result; on failure responds 400.
 */
export function validateQuery<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, formatIssues(result.error), 400);
      return;
    }
    req.query = result.data as typeof req.query;
    next();
  };
}

/**
 * Ensure `req.params[paramName]` is a valid MongoDB ObjectId. Responds 400 when
 * the param is missing or malformed.
 *
 * @param paramName - The route param to validate (default `'id'`).
 */
export function validateObjectId(paramName = 'id') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const raw = req.params[paramName];
    // Express params can be string[] when a path repeats a segment name.
    const id = Array.isArray(raw) ? raw[0] : raw;
    if (!id) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, `${paramName} parameter is required`, 400);
      return;
    }
    if (!isValidObjectId(id)) {
      sendError(res, ErrorCodes.VALIDATION_ERROR, `Invalid ${paramName} format`, 400);
      return;
    }
    next();
  };
}
