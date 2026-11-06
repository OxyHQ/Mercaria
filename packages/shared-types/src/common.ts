/**
 * Common utility types, API envelope and pagination contracts shared across the
 * Mercaria frontend and backend.
 */

/** ISO-8601 timestamps present on every persisted entity. */
export interface Timestamps {
  /** ISO-8601 creation time. */
  createdAt: string;
  /** ISO-8601 last-update time. */
  updatedAt: string;
}

/** Standard cursor/offset pagination metadata returned by list endpoints. */
export interface Pagination {
  /** 1-based page index. */
  page: number;
  /** Page size requested. */
  limit: number;
  /** Total number of matching records across all pages. */
  total: number;
  /** Total number of pages for the current `limit`. */
  pages: number;
  /** Whether another page exists after the current one. */
  hasNextPage: boolean;
  /** Whether a page exists before the current one. */
  hasPreviousPage: boolean;
}

/**
 * Canonical success/error envelope for every JSON API response.
 *
 * `T` is the payload type. The default is `unknown` (never `any`) so callers are
 * forced to narrow the payload before use.
 */
export interface ApiResponse<T = unknown> {
  /** `true` when the request succeeded. */
  success: boolean;
  /** Optional human-readable message (success or failure). */
  message?: string;
  /** Machine-readable error code, present when `success` is `false`. */
  error?: string;
  /** Response payload, present when `success` is `true`. */
  data?: T;
  /**
   * Structured facts about a failure, for a client to ACT on — present only on
   * the refusals {@link ApiErrorDetails} names. `message` stays the sentence a
   * person reads; ids live here, never in it.
   */
  details?: ApiErrorDetails;
}

/**
 * A seller a checkout refusal names: the key the buyer deselects by, and the
 * public name they know the seller by.
 */
export interface RefusedCheckoutSeller {
  /** `store:<id>` / `user:<id>` — what `CheckoutInput.sellerKeys` and `CartGroup.sellerKey` carry. */
  sellerKey: string;
  /**
   * The store's name, or a private seller's Oxy display name. Absent when it
   * could not be read (Oxy did not answer for the person) — a client then uses
   * the name its own cart shows, or "a seller", never the key.
   */
  name?: string;
}

/** A checkout refused because these sellers cannot be paid right now (ADR 0001 D4). */
export interface SellersNotPaymentReadyErrorDetails {
  reason: 'seller_not_payment_ready';
  sellers: RefusedCheckoutSeller[];
}

/**
 * A checkout refused because these sellers are not accepting orders right now —
 * a store an operator held or its owner paused, or a seller who has not accepted
 * the marketplace fee terms their sale selects (ADR 0018). Which of those fired
 * is deliberately NOT carried: a buyer cannot act on it, and it is somebody
 * else's business. The remedy is the same: deselect them.
 */
export interface SellersNotActivatedErrorDetails {
  reason: 'seller_not_activated';
  sellers: RefusedCheckoutSeller[];
}

/** Every structured error detail the API emits, discriminated by `reason`. */
export type ApiErrorDetails = SellersNotPaymentReadyErrorDetails | SellersNotActivatedErrorDetails;

/** Paginated list envelope: a page of `T` plus its pagination metadata. */
export interface PaginatedResponse<T> {
  /** The page of items. */
  data: T[];
  /** Pagination metadata describing this page. */
  pagination: Pagination;
}

/**
 * Cursor-paginated list envelope, used for infinite feeds where offset paging
 * is inappropriate (e.g. the home feed). The cursor is opaque to the client.
 */
export interface CursorPage<T> {
  /** The page of items. */
  data: T[];
  /** Opaque cursor to fetch the next page; absent when no further pages exist. */
  nextCursor?: string;
  /** Whether another page exists after this one. */
  hasMore: boolean;
}

/** Query parameters accepted by paginated list endpoints. */
export interface PaginationParams {
  /** 1-based page index (defaults to 1 server-side). */
  page?: number;
  /** Page size (server clamps to a sane maximum). */
  limit?: number;
}

/** Make `K` optional on `T`. */
export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/** Make `K` required on `T`. */
export type RequiredFields<T, K extends keyof T> = T & Required<Pick<T, K>>;

/** Recursively make every property of `T` optional. */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
