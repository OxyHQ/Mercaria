/**
 * The mermaid ER notation, defined ONCE.
 *
 * Both directions live here on purpose. The renderer turns a derived edge into
 * markers; the gate turns markers back into a derived edge and compares. If the
 * two conversions were written separately they could agree with each other and
 * both be wrong about the schema — two representations of one fact, which is
 * the defect this whole workstream is about.
 *
 * Crow's-foot markers, as mermaid defines them:
 *
 * | left | right | meaning                |
 * |------|-------|------------------------|
 * | `||` | `||`  | exactly one            |
 * | `|o` | `o|`  | zero or one            |
 * | `}o` | `o{`  | zero or more           |
 * | `}|` | `|{`  | one or more            |
 *
 * `}|` and `|{` — "one or more" — are deliberately NOT produced by the
 * renderer. "Every parent has at least one child" is not expressible in a
 * foreign key, a NOT NULL or a unique index, so nothing in the schema could
 * justify emitting one. They are parsed, because a hand-drawn diagram may
 * assert one and the gate has to be able to say so.
 */

import type { CardinalityEdge, ChildCardinality, ParentCardinality } from './model.js';

/** The PARENT's cardinality, written on the left of the line. */
export const PARENT_LEFT: Readonly<Record<ParentCardinality, string>> = {
  exactlyOne: '||',
  zeroOrOne: '|o',
};

/** The same fact written on the right of the line, when the parent is on the right. */
export const PARENT_RIGHT: Readonly<Record<ParentCardinality, string>> = {
  exactlyOne: '||',
  zeroOrOne: 'o|',
};

/** The CHILD's cardinality, written on the right of the line. */
export const CHILD_RIGHT: Readonly<Record<ChildCardinality, string>> = {
  many: 'o{',
  atMostOne: 'o|',
};

/** The same fact written on the left, when the child is on the left. */
export const CHILD_LEFT: Readonly<Record<ChildCardinality, string>> = {
  many: '}o',
  atMostOne: '|o',
};

/**
 * A relationship line as it appears in a mermaid `erDiagram`.
 *
 * Anchored at the start of the line and requiring the `:` label separator,
 * because an unanchored scan over a markdown file reads prose. The marker
 * alternatives are enumerated rather than expressed as a character class: a
 * class like `[|}o]{2}` also matches `oo`, `}}` and `o}`, none of which mermaid
 * accepts, and a parser that accepts more than the renderer can emit is a
 * parser that cannot notice a typo.
 */
export const ER_RELATIONSHIP =
  /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+(\|\||\|o|\}o|\}\|)(--|\.\.)(\|\||o\||o\{|\|\{)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/;

export interface ParsedRelationship {
  readonly left: string;
  readonly leftMarker: string;
  readonly rightMarker: string;
  readonly right: string;
  readonly label: string;
  readonly source: string;
}

/** Every ```mermaid fenced block in a markdown document, in order. */
export function mermaidBlocks(markdown: string): readonly string[] {
  const blocks: string[] = [];
  let open = false;
  let current: string[] = [];
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!open && trimmed === '```mermaid') {
      open = true;
      current = [];
      continue;
    }
    if (open && trimmed.startsWith('```')) {
      open = false;
      blocks.push(current.join('\n'));
      continue;
    }
    if (open) current.push(line);
  }
  return blocks;
}

/** Every relationship line in every `erDiagram` block of a markdown document. */
export function parseRelationships(markdown: string): readonly ParsedRelationship[] {
  const found: ParsedRelationship[] = [];
  for (const block of mermaidBlocks(markdown)) {
    const lines = block.split('\n');
    if (!lines.some((line) => line.trim() === 'erDiagram')) continue;
    for (const line of lines) {
      const match = ER_RELATIONSHIP.exec(line);
      if (!match) continue;
      found.push({
        left: match[1],
        leftMarker: match[2],
        rightMarker: match[4],
        right: match[5],
        label: match[6].trim(),
        source: line.trim(),
      });
    }
  }
  return found;
}

/**
 * An entity DECLARED with an attribute block: `category_aliases {`.
 *
 * The empty-block form is what lets a table with no foreign key appear as a
 * node at all, and it was verified against mermaid 11.17's own parser rather
 * than assumed — along with every other construct the renderer emits, and with
 * a deliberately malformed control to prove the check could fail.
 */
export const ER_ENTITY_DECLARATION = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*$/;

/**
 * Every entity NAME an `erDiagram` block puts on the page: the ones declared
 * with a block, and both endpoints of every relationship.
 *
 * Both, because either alone is a census with a hole. Declarations alone miss a
 * table that only ever appears as a relationship endpoint; endpoints alone miss
 * a table with no foreign key, which is precisely the set the declarations
 * exist for.
 */
export function parseEntities(markdown: string): ReadonlySet<string> {
  const found = new Set<string>();
  for (const block of mermaidBlocks(markdown)) {
    const lines = block.split('\n');
    if (!lines.some((line) => line.trim() === 'erDiagram')) continue;
    for (const line of lines) {
      const declared = ER_ENTITY_DECLARATION.exec(line);
      if (declared) found.add(declared[1]);
      const relationship = ER_RELATIONSHIP.exec(line);
      if (relationship) {
        found.add(relationship[1]);
        found.add(relationship[5]);
      }
    }
  }
  return found;
}

/**
 * Does a parsed line state exactly what a derived edge proves?
 *
 * Orientation-agnostic, because a diagram may legitimately write the child on
 * either side: `categories ||--o{ category_aliases` and
 * `category_aliases }o--|| categories` are the same claim, and a checker that
 * only understood one of them would report a false mismatch on the other and
 * get relaxed.
 */
export function relationshipAgrees(parsed: ParsedRelationship, edge: CardinalityEdge): boolean {
  if (edge.parent === parsed.left && edge.child === parsed.right) {
    return parsed.leftMarker === PARENT_LEFT[edge.parentSide] && parsed.rightMarker === CHILD_RIGHT[edge.childSide];
  }
  if (edge.child === parsed.left && edge.parent === parsed.right) {
    return parsed.leftMarker === CHILD_LEFT[edge.childSide] && parsed.rightMarker === PARENT_RIGHT[edge.parentSide];
  }
  return false;
}
