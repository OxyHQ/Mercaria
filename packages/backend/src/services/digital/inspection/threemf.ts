/**
 * 3MF — the one container whose geometry is measured, and the only member any
 * parser in this directory is ever pointed at (#1015 W4, W12 threat 6).
 *
 * ## Why this is not a second container inspection
 *
 * `MAX_CONTAINER_DEPTH` is 1, and the reading that makes it hold is narrow: this
 * module opens a 3MF's central directory through `container.ts`, reads exactly ONE
 * part — the 3D model, at the path the 3MF specification fixes — and parses that
 * part as XML. It never enumerates the package looking for things to parse, never
 * follows a relationship to a second part of unknown type, and REFUSES a model
 * part that is itself an archive. So the member set a parser sees is one entry
 * chosen by the spec rather than several chosen by the uploader.
 *
 * `ASSET_FORMAT_REGISTRY` says `3mf` is `geometryMeasurable: true`, which is a
 * promise this module is what keeps. The alternative — inventorying the archive
 * and reporting `unsupported` — would have the registry claiming a capability the
 * pipeline does not have, and #1015 acceptance criterion 20 turns on the registry
 * being the truth about what a vertical can measure.
 *
 * ## The XML is scanned, not parsed into a tree
 *
 * There is no XML parser here and no XML dependency. A 3MF model part is read by
 * walking the tags this module cares about with a non-backtracking pattern
 * (`[^>]*` for attributes is linear in the input) and keeping a small state
 * machine of "which object am I inside". That is deliberate:
 *
 * - A DOM of a 64 MiB part is several hundred MB of nodes, where the scan holds
 *   one object's vertices at a time.
 * - An XML parser is an entity resolver, and an entity resolver on hostile input
 *   is XXE and the billion-laughs expansion. Nothing here expands an entity,
 *   resolves a DOCTYPE or opens an external reference, because there is nothing
 *   here that could.
 *
 * A NAMESPACE PREFIX on a tag is handled (`<m:texture2d>` is how the materials
 * extension is written in practice), and the cost that remains is that this is not a
 * conforming XML reader: a model part that nests the elements unusually measures as
 * fewer triangles than it has. That is the honest direction to be wrong in — an
 * under-count reads as a small model, not as a guarantee — and the alternative was a
 * general parser on exactly the input #1015 W12 says to treat as hostile.
 *
 * ## Units ARE carried, unlike STL and OBJ
 *
 * `<model unit="...">` is part of the format, so the bounding box needs no
 * convention: {@link THREEMF_UNIT_SCALE_TO_MM} is the spec's own table and the
 * default is millimetres because the spec says so.
 *
 * ## When the bounding box is withheld
 *
 * A `<build><item>` or a `<components><component>` may carry a `transform`. This
 * module does not compose them, so in their presence the union of object-space
 * extents is NOT the physical size of the printed thing — it could be out by the
 * scale factor in the transform. The box is therefore ABSENT whenever a transform
 * appears, rather than reported in the wrong space. Counts are unaffected: a
 * transform moves geometry, it does not add triangles.
 */

import { MAX_REPORTED_TRIANGLES, MAX_REPORTED_VERTICES, MAX_TEXT_DOCUMENT_BYTES } from './limits.js';
import { censusHaltOutcome, startMeshCensus } from './mesh.js';
import { corruptFile, measured, refusedTooLarge, type InspectionOutcome } from './result.js';
import {
  findThreeMfModelPart,
  openZipContainer,
  readContainerEntry,
  type ContainerEntry,
} from './container.js';
import type { InspectionBudget } from './budget.js';
import { convertUnit } from '../../canonical/units.js';

/**
 * The 3MF specification's unit names, mapped to the CANONICAL UNIT REGISTRY.
 *
 * A `Record` over the closed set rather than a switch, so an unrecognized unit is
 * `undefined` and is refused as `corrupt` — not silently treated as millimetres,
 * which would report an inch-scaled model at 1/25th of its size.
 *
 * `micron` has no registry token, so it is expressed as an SI factor over one that
 * does. That is not a second conversion table: a power of ten between metric
 * prefixes is exact in binary and carries no measurement decision, whereas
 * `inch: 25.4` and `foot: 304.8` are the imperial definitions, and those belong in
 * exactly one place. `unit-registry-authority.test.ts` enforces that — it refuses
 * both literals anywhere outside `services/canonical/units.ts`, which is how this
 * table was caught holding its own copy of them.
 */
const THREEMF_UNIT_TO_REGISTRY: Readonly<Record<string, { unit: string; factor: number }>> =
  Object.freeze({
    micron: { unit: 'mm', factor: 0.001 },
    millimeter: { unit: 'mm', factor: 1 },
    centimeter: { unit: 'cm', factor: 1 },
    inch: { unit: 'in', factor: 1 },
    foot: { unit: 'ft', factor: 1 },
    meter: { unit: 'm', factor: 1 },
  });

/**
 * Millimetres per 3MF unit, DERIVED from the registry at module load.
 *
 * Derived rather than written out so the numbers cannot drift from the table every
 * other dimension in this codebase is measured against. A registry that stopped
 * knowing one of these units makes this throw at import — loudly, at boot — rather
 * than silently scaling a model by `NaN` and reporting a bounding box of nothing.
 */
export const THREEMF_UNIT_SCALE_TO_MM: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    Object.entries(THREEMF_UNIT_TO_REGISTRY).map(([name, { unit, factor }]) => {
      const perUnit = convertUnit(1, unit, 'mm');
      if (perUnit === null || !Number.isFinite(perUnit)) {
        throw new Error(
          `The canonical unit registry cannot convert '${unit}' to mm, so 3MF's '${name}' has no scale.`,
        );
      }
      return [name, perUnit * factor];
    }),
  ),
);

/** The spec's default when `<model>` carries no `unit`. */
const DEFAULT_THREEMF_UNIT = 'millimeter';

/**
 * How far into the part the `<model>` root is looked for — 8192 characters.
 *
 * It is the root element, so it follows only the XML declaration and possibly a
 * comment. A bounded search keeps "is this a model document" from being a scan of
 * the whole part.
 */
const MODEL_ROOT_SEARCH_CHARS = 8192;

/**
 * The tags this scan reacts to. Everything else in the part is skipped.
 *
 * Built per call rather than held at module scope: a `g`-flagged regex carries
 * `lastIndex` as mutable state, and a shared one is a cross-call dependency that
 * holds only because this loop happens to be synchronous. A fresh instance costs
 * nothing measurable against a 64 MiB scan and removes the question.
 */
function tagPattern(): RegExp {
  return /<(\/?)(?:[A-Za-z0-9_.-]+:)?(mesh|vertices|vertex|triangle|component|item|texture2d)\b([^>]*)>/giu;
}

/** Inspect a 3MF package: open the archive, read the model part, measure it. */
export function inspectThreeMf(
  bytes: Uint8Array,
  options: { readonly budget: InspectionBudget },
): InspectionOutcome {
  const opened = openZipContainer(bytes, options.budget);
  if (opened.ok === false) return opened.outcome;

  const part = findThreeMfModelPart(opened.entries);
  if (!part) {
    return corruptFile('the package holds no 3D model part');
  }
  const read = readContainerEntry(bytes, part);
  if (read.ok === false) return read.outcome;

  if (isArchive(read.bytes)) {
    // The depth bound, made concrete. A model part that is itself a zip is the
    // shape a nesting attack takes, and there is no legitimate 3MF that has one.
    return corruptFile(`the model part '${part.path}' is itself an archive`);
  }
  if (read.bytes.length > MAX_TEXT_DOCUMENT_BYTES) {
    return refusedTooLarge(
      `the model part is ${read.bytes.length} bytes, above the ${MAX_TEXT_DOCUMENT_BYTES}-byte ceiling`,
    );
  }

  return measureModelPart(read.bytes, opened.entries, options.budget);
}

/** Whether these bytes open with a zip local-file or end-of-directory signature. */
function isArchive(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  );
}

/** Measure one model part against the package that carried it. */
function measureModelPart(
  partBytes: Uint8Array,
  entries: readonly ContainerEntry[],
  budget: InspectionBudget,
): InspectionOutcome {
  const xml = new TextDecoder('utf-8', { fatal: false }).decode(partBytes);

  const root = xml.slice(0, MODEL_ROOT_SEARCH_CHARS).match(/<(?:[A-Za-z0-9_.-]+:)?model\b[^>]*>/iu);
  if (!root) {
    // No `<model>` root. Without this the scan simply matches no tags and the part
    // measures as a model with zero triangles — a plausible zero, which is the worst
    // available answer and the one a naive reader produces for a part that is not
    // XML at all.
    return corruptFile('the model part has no <model> root element');
  }
  const unit = attributeOf(root[0], 'unit');
  const unitKey = (unit ?? DEFAULT_THREEMF_UNIT).toLowerCase();
  const scaleToMm = THREEMF_UNIT_SCALE_TO_MM[unitKey];
  if (scaleToMm === undefined) {
    return corruptFile(`'${unitKey}' is not a 3MF unit`);
  }

  const census = startMeshCensus({ budget, scaleToMm, maxTriangles: MAX_REPORTED_TRIANGLES });

  /** The current object's vertices, flat. Reset at each `<mesh>`. */
  let positions: number[] = [];
  let insideVertices = false;
  let meshCount = 0;
  let sawTransform = false;
  let hasUvMapping = false;
  const texturePaths: string[] = [];

  const scan = tagPattern();
  let match: RegExpExecArray | null;
  let tags = 0;

  while ((match = scan.exec(xml)) !== null) {
    tags += 1;
    if (budget.expiredOnStride(tags)) {
      return refusedTooLarge('the inspection time budget was exhausted reading the model part');
    }
    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();
    const attributes = match[3] ?? '';
    // A self-closing tag is its own open AND close; only the paired tags below
    // care, and each of them reads the flag rather than the slash.
    const selfClosing = attributes.trimEnd().endsWith('/');

    if (tag === 'mesh' && !closing) {
      positions = [];
      meshCount += 1;
      continue;
    }
    if (tag === 'vertices') {
      insideVertices = !closing && !selfClosing;
      continue;
    }
    if (tag === 'vertex' && !closing) {
      if (!insideVertices) continue;
      if (positions.length / 3 >= MAX_REPORTED_VERTICES) {
        return refusedTooLarge(
          `more than ${MAX_REPORTED_VERTICES} vertices, above the inspection ceiling`,
        );
      }
      const x = numberAttribute(attributes, 'x');
      const y = numberAttribute(attributes, 'y');
      const z = numberAttribute(attributes, 'z');
      if (x === null || y === null || z === null) {
        return corruptFile('a vertex is missing a finite x, y or z');
      }
      positions.push(x, y, z);
      continue;
    }
    if (tag === 'triangle' && !closing) {
      const declared = positions.length / 3;
      const v1 = indexAttribute(attributes, 'v1', declared);
      const v2 = indexAttribute(attributes, 'v2', declared);
      const v3 = indexAttribute(attributes, 'v3', declared);
      if (v1 === null || v2 === null || v3 === null) {
        return corruptFile(
          `a triangle names a vertex outside the ${declared} its object declares`,
        );
      }
      const halt = census.add(
        positions[v1 * 3], positions[v1 * 3 + 1], positions[v1 * 3 + 2],
        positions[v2 * 3], positions[v2 * 3 + 1], positions[v2 * 3 + 2],
        positions[v3 * 3], positions[v3 * 3 + 1], positions[v3 * 3 + 2],
      );
      if (halt) return censusHaltOutcome(halt, MAX_REPORTED_TRIANGLES);
      continue;
    }
    if ((tag === 'item' || tag === 'component') && !closing) {
      if (attributeOf(match[0], 'transform') !== null) sawTransform = true;
      continue;
    }
    if (tag === 'texture2d' && !closing) {
      hasUvMapping = true;
      const path = attributeOf(match[0], 'path');
      if (path !== null) texturePaths.push(path);
      continue;
    }
  }

  const summary = census.finish();
  const missing = missingTextureParts(texturePaths, entries);

  return measured({
    ...summary,
    ...(sawTransform ? { boundingBox: undefined } : {}),
    meshCount,
    // 3MF's core has no texture coordinates; the Materials extension's
    // `texture2d` is the only thing that carries them, so its presence IS the
    // measurement and its absence is a measured `false` rather than an unknown.
    hasUvMapping,
    // Neither a skeleton nor an animation track exists anywhere in 3MF.
    hasRig: false,
    animationCount: 0,
    missingResources: missing,
  });
}

/**
 * Texture parts the model names and the package does not contain.
 *
 * A 3MF texture path is a part name inside the package — `/3D/Textures/x.png` —
 * so this is an exact comparison against the archive's own entries, with the
 * leading slash stripped and case folded. It is NOT the base-name match
 * `resources.ts` does for OBJ and glTF: inside an OPC package the full part name
 * is authoritative and available, so the weaker comparison would be a choice to
 * be less precise than the format allows.
 */
function missingTextureParts(
  texturePaths: readonly string[],
  entries: readonly ContainerEntry[],
): string[] {
  if (texturePaths.length === 0) return [];
  const present = new Set(entries.map((entry) => entry.lookupPath.replace(/^\/+/u, '')));
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const path of texturePaths) {
    const key = path.trim().replace(/^\/+/u, '').replace(/\\/gu, '/').toLowerCase();
    if (key === '' || present.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push(path.trim());
  }
  return missing;
}

/** One attribute's raw value from a tag's attribute text, or `null`. */
function attributeOf(tagText: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'iu');
  const match = pattern.exec(tagText);
  return match ? match[1] : null;
}

/** One attribute as a finite number, or `null`. */
function numberAttribute(tagText: string, name: string): number | null {
  const raw = attributeOf(tagText, name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * One attribute as a vertex index inside `declared`, or `null`.
 *
 * 3MF indices are 0-based, so the bound is `[0, declared)`. An index outside it is
 * refused rather than clamped, for `obj.ts`'s reason: a clamped index reads a real
 * coordinate from the wrong vertex, and the measurement that comes out is of a
 * mesh nobody uploaded.
 */
function indexAttribute(tagText: string, name: string, declared: number): number | null {
  const raw = attributeOf(tagText, name);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value >= declared) return null;
  return value;
}
