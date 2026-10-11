/**
 * Every failure the location editor can meet, as a translation KEY — pure.
 *
 * Two services answer the editor: GoWay (the place, with the merchant's own
 * session) and Mercaria (the publication). Each says WHY in a typed way — the
 * SDK's error classes, Mercaria's HTTP status — and the editor shows a sentence
 * in the merchant's language rather than a server's English message.
 */

import {
  GoWayConflictError,
  GoWayForbiddenError,
  GoWayGoneError,
  GoWayNetworkError,
  GoWayNotFoundError,
  GoWayRateLimitError,
  GoWayUnauthorizedError,
  GoWayUnavailableError,
  GoWayValidationError,
} from '@goway.to/sdk';
import axios from 'axios';

/** A GoWay failure, as the merchant reads it. */
export function goWayErrorKey(error: unknown): string {
  // FORBIDDEN first and named: it is the ordinary answer while the store's
  // claim on the place is still pending, not a fault.
  if (error instanceof GoWayForbiddenError)
    return 'settings.locations.editor.errors.gowayForbidden';
  if (error instanceof GoWayUnauthorizedError)
    return 'settings.locations.editor.errors.gowaySignIn';
  if (
    error instanceof GoWayUnavailableError ||
    error instanceof GoWayNetworkError ||
    error instanceof GoWayRateLimitError
  ) {
    return 'settings.locations.editor.errors.gowayUnavailable';
  }
  if (error instanceof GoWayValidationError) return 'settings.locations.editor.errors.gowayInvalid';
  if (error instanceof GoWayConflictError) return 'settings.locations.editor.errors.gowayConflict';
  if (error instanceof GoWayNotFoundError || error instanceof GoWayGoneError) {
    return 'settings.locations.editor.errors.gowayGone';
  }
  return 'settings.locations.editor.errors.gowayFailed';
}

/** A failure saving or publishing the Mercaria side, by what Mercaria's status means there. */
export function publicationErrorKey(error: unknown): string {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  switch (status) {
    case 400:
      return 'settings.locations.editor.errors.publicationRefused';
    case 404:
      return 'settings.locations.editor.errors.locationMissing';
    case 409:
      return 'settings.locations.editor.errors.placeTaken';
    case 503:
      return 'settings.locations.editor.errors.gowayUnavailable';
    default:
      return 'settings.locations.editor.errors.publicationFailed';
  }
}
