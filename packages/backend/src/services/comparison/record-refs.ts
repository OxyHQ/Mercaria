/**
 * Opaque record references (#96 grounded input item 9, explanation rule 2).
 *
 * Every fact a comparison states names the Mercaria record it came from, and it
 * names it through a handle minted for THIS comparison — `p1`, `o7`, `a23` —
 * rather than through the record's own id.
 *
 * ## Why opaque, and why per comparison
 *
 * Two reasons, and only the first is the obvious one.
 *
 * 1. **A model package carries no ids.** {@link ComparisonRecordRef} has a
 *    `recordId` and a `canonicalPath`, and the package handed to an explanation
 *    provider carries NEITHER — only the ref and a short label. So a generated
 *    sentence cannot contain a canonical product id, a merchant id or a URL,
 *    because the provider never saw one.
 * 2. **An invented citation cannot accidentally resolve.** If refs were ids, a
 *    model that hallucinated a plausible id would produce a citation that
 *    LOOKS valid and points at an unrelated record. A per-comparison handle has
 *    a domain of a few dozen values that exist only inside this response, so an
 *    invented one is refused by {@link ComparisonRecordIndex.has} and a
 *    misattributed one is refused by the package's own facts not matching.
 *
 * The index is deliberately a plain builder rather than a registry with
 * registration functions: it lives for one request, it is handed to the
 * assembler as a value, and nothing outside a request could hold one.
 */

import type { ComparisonRecordKind, ComparisonRecordRef } from '@mercaria/shared-types';

/**
 * The one-letter prefix each kind mints under.
 *
 * A `Record` over the union, so a kind added without a prefix is a compile
 * error rather than something that silently mints under `undefined1`. The
 * letters are for a human reading a trace — a citation of `o3` is obviously an
 * offer — and carry no meaning the code reads.
 */
const REF_PREFIX: Readonly<Record<ComparisonRecordKind, string>> = {
  canonical_product: 'p',
  canonical_variant: 'v',
  offer: 'o',
  merchant: 'm',
  storefront: 'f',
  attribute_value: 'a',
  price_signal: 'h',
  relationship: 'r',
  constraint: 'c',
  catalog_source: 's',
};

/** What a caller knows about a record when it registers one. */
export interface RegisterRecordInput {
  readonly kind: ComparisonRecordKind;
  readonly recordId: string;
  readonly canonicalPath?: string;
  readonly label?: string;
}

/**
 * The reference table for one comparison.
 *
 * Registration is IDEMPOTENT on `(kind, recordId)` — the same offer cited from
 * a table cell, a plan line and a tradeoff gets one ref — because a package
 * whose grounded set contained three handles for one record would let a draft
 * cite a different one each time and still pass every check.
 */
export class ComparisonRecordIndex {
  private readonly byKey = new Map<string, ComparisonRecordRef>();
  private readonly counters = new Map<ComparisonRecordKind, number>();

  /**
   * Register a record and return its handle.
   *
   * A repeat call with a richer `label` or `canonicalPath` UPGRADES the stored
   * entry in place rather than minting a second one: the first citation of a
   * merchant may come from an offer that knows only its id, and the merchant
   * read that follows knows its name. Upgrading is safe because the handle does
   * not change and no already-emitted citation is invalidated.
   */
  register(input: RegisterRecordInput): string {
    const key = `${input.kind}:${input.recordId}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      const upgraded: ComparisonRecordRef = {
        ref: existing.ref,
        kind: existing.kind,
        recordId: existing.recordId,
        ...(existing.canonicalPath ?? input.canonicalPath
          ? { canonicalPath: existing.canonicalPath ?? input.canonicalPath }
          : {}),
        ...(existing.label ?? input.label ? { label: existing.label ?? input.label } : {}),
      };
      this.byKey.set(key, upgraded);
      return upgraded.ref;
    }

    const next = (this.counters.get(input.kind) ?? 0) + 1;
    this.counters.set(input.kind, next);
    const ref = `${REF_PREFIX[input.kind]}${String(next)}`;
    this.byKey.set(key, {
      ref,
      kind: input.kind,
      recordId: input.recordId,
      ...(input.canonicalPath === undefined ? {} : { canonicalPath: input.canonicalPath }),
      ...(input.label === undefined ? {} : { label: input.label }),
    });
    return ref;
  }

  /** Whether a handle was minted by this index. The citation whitelist. */
  has(ref: string): boolean {
    for (const entry of this.byKey.values()) if (entry.ref === ref) return true;
    return false;
  }

  /** The record behind a handle, or `undefined`. */
  resolve(ref: string): ComparisonRecordRef | undefined {
    for (const entry of this.byKey.values()) if (entry.ref === ref) return entry;
    return undefined;
  }

  /**
   * The whole table, in a STABLE order.
   *
   * Sorted by kind then by the handle's numeric suffix, so two runs over the
   * same catalogue emit byte-identical tables. An insertion-ordered list would
   * make the response depend on the order the assembler happened to visit
   * things in, which is the ingestion-order dependency the whole domain refuses.
   */
  all(): readonly ComparisonRecordRef[] {
    return [...this.byKey.values()].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
      return numericSuffix(left.ref) - numericSuffix(right.ref);
    });
  }
}

/** The counter inside a handle. A handle is always `<letter><digits>`. */
function numericSuffix(ref: string): number {
  return Number.parseInt(ref.slice(1), 10);
}
