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
}

/** Paginated list envelope: a page of `T` plus its pagination metadata. */
export interface PaginatedResponse<T> {
  /** The page of items. */
  data: T[];
  /** Pagination metadata describing this page. */
  pagination: Pagination;
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
