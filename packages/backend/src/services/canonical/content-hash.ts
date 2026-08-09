/**
 * The content hash that makes a source observation idempotent (ADR 0002 D19).
 *
 * `source_records` converges on `(source, type, id, content_hash)`, so the hash
 * must be a function of the CONTENT and nothing else — the moderation-envelope
 * lesson applies verbatim: anything volatile folded in (a run timestamp, an
 * unsorted list, nondeterministic key order) turns a legitimate re-run into a
 * new row per delivery, silently, forever. Hence the canonical form below sorts
 * object keys recursively and the hash is of that ONE serialization; callers
 * keep volatile fields (like `observedAt`) OUT of the payload they hash — those
 * are columns, not content.
 */

import { createHash } from 'node:crypto';

/** JSON values the canonical serialization accepts. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Serialize with recursively sorted object keys, so two structurally equal
 * payloads produce IDENTICAL bytes regardless of construction order. Array
 * order is preserved — it is content (a caller that considers a list unordered
 * sorts it before hashing, visibly, at the call site).
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys
    .map((key) => {
      const entry = value[key];
      return entry === undefined ? undefined : `${JSON.stringify(key)}:${canonicalJson(entry)}`;
    })
    .filter((entry): entry is string => entry !== undefined)
    .join(',');
  return `{${body}}`;
}

/** sha-256 hex of the canonical serialization — what `content_hash` stores. */
export function contentHashOf(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
