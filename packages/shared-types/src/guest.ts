/**
 * Guest commerce identity DTOs — ADR 0003 (#102), implemented by #103.
 *
 * A guest session is Mercaria's own revocable credential for a signed-out
 * buyer. It is NOT Oxy identity: no Oxy account exists behind it, its id must
 * never appear where an Oxy user id is expected (ADR 0003 I1), and the bearer
 * token itself never travels in a response body, a log line or a DTO — the
 * server stores only a SHA-256 of it, and the client carries it in an
 * `HttpOnly` cookie (web) or `expo-secure-store` via the
 * `X-Mercaria-Guest-Token` header (native). Nothing in this module can hold a
 * token, by construction.
 */

/**
 * The lifecycle states a guest session can be observed in.
 *
 * DERIVED, never stored: the `guest_sessions` row carries only the timestamp
 * set (`expires_at`, `revoked_at`, `converted_at`, `last_seen_at`), and the
 * status is computed from those at read time. A stored status column beside
 * them would be a second representation of one fact, which is the shape this
 * schema refuses everywhere (ADR 0003 D3; the `provider_accounts` rule).
 */
export const GUEST_SESSION_STATUSES = ['active', 'converted', 'expired', 'revoked'] as const;

/** One of {@link GUEST_SESSION_STATUSES}. */
export type GuestSessionStatus = (typeof GUEST_SESSION_STATUSES)[number];

/**
 * The surface a guest session was issued to. AUDIT dimension only — it is
 * never an authorization input and never binds the credential to a device
 * (ADR 0003 T2 rejects device binding outright).
 */
export const GUEST_CLIENT_CLASSES = ['web', 'ios', 'android', 'other'] as const;

/** One of {@link GUEST_CLIENT_CLASSES}. */
export type GuestClientClass = (typeof GUEST_CLIENT_CLASSES)[number];

/**
 * The SAFE projection of a guest session — what `GET /guest/session` answers.
 *
 * Deliberately names every field (the payment status-projection rule): there
 * is no token, no token hash, no internal correlation beyond what the holder
 * already knows. `id` IS included: it is the audit handle and the cart owner
 * key, never the credential (possession of the token is what authorizes, and
 * the id cannot be exchanged for one).
 */
export interface GuestSessionState {
  /** The session row id — an audit handle, never a credential. */
  id: string;
  /** Derived lifecycle state; see {@link GUEST_SESSION_STATUSES}. */
  status: GuestSessionStatus;
  /** The surface the session was issued to. */
  clientClass: GuestClientClass;
  /** ISO timestamp the session was created. */
  createdAt: string;
  /** ISO timestamp of the last resolved request (≥ 60 s granularity). */
  lastSeenAt: string;
  /** ISO timestamp of the last token rotation, `null` before the first. */
  rotatedAt: string | null;
  /** ISO timestamp of the ABSOLUTE expiry deadline (90 days from issuance). */
  expiresAt: string;
}
