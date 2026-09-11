/**
 * Content sniffing, the ceilings, and the clock — the three things every parser in
 * this directory depends on and none of them can be tested through one.
 *
 * ## The trap this file exists for
 *
 * A `.stl` that is really a zip is the case #1015 W4 requirement 1 names, and the
 * reason it is hard is that the honest detector for binary STL looks WRONG: real
 * exporters write the word `solid` into a binary file's free-form header, so the
 * first token is not evidence of anything. The arithmetic is. Both halves are
 * asserted below, and the binary-STL-that-says-solid case is the control proving the
 * detector is not simply reading the first word.
 *
 * ## Every gate here carries a control
 *
 * An assertion that a detector REFUSES something is paired with one showing the same
 * detector accepting the neighbouring real file, because a `sniffFormat` that
 * returned `unidentified` for everything would satisfy half of this file and be
 * useless. The ceiling relationships are asserted for the same reason: they are the
 * invariants a thoughtless edit to one constant breaks, and nothing else notices.
 */

import { describe, expect, it } from 'vitest';
import { ASSET_FORMAT_KEYS } from '@mercaria/shared-types';
import { PROBE_BYTES, sniffFormat } from '../sniff.js';
import {
  DEADLINE_CHECK_STRIDE,
  INSPECTION_TIME_BUDGET_MS,
  MAX_BOUNDING_BOX_MM,
  MAX_CONTAINER_ENTRY_EXPANDED_BYTES,
  MAX_CONTAINER_TOTAL_EXPANDED_BYTES,
  MAX_DEDUPLICATED_VERTEX_TRIANGLES,
  MAX_INSPECTED_FILE_BYTES,
  MAX_JSON_DOCUMENT_BYTES,
  MAX_REPORTED_TRIANGLES,
  MAX_REPORTED_VERTICES,
  MAX_TEXT_DOCUMENT_BYTES,
  MAX_WATERTIGHT_TRIANGLES,
} from '../limits.js';
import { UNBOUNDED_INSPECTION_BUDGET, createInspectionBudget } from '../budget.js';
import {
  BLEND_BYTES,
  CLOSED_TETRAHEDRON,
  COMPRESSED_BLEND_BYTES,
  JPEG_BYTES,
  PDF_BYTES,
  PNG_BYTES,
  asciiStl,
  binaryStl,
  gltfJson,
  glb,
  objFile,
  threeMfArchive,
  threeMfModelXml,
  zipArchive,
} from './fixtures.js';

/** The format key `sniffFormat` answered, or `null` for unidentified. */
function sniffed(bytes: Uint8Array): string | null {
  const result = sniffFormat(bytes);
  return result.kind === 'identified' ? result.formatKey : null;
}

describe('sniffFormat — the format is decided from the bytes', () => {
  it('identifies every launch format from real bytes', () => {
    expect(sniffed(binaryStl(CLOSED_TETRAHEDRON))).toBe('stl');
    expect(sniffed(asciiStl([CLOSED_TETRAHEDRON]))).toBe('stl');
    expect(sniffed(objFile(['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3']))).toBe('obj');
    expect(sniffed(gltfJson({ asset: { version: '2.0' } }))).toBe('gltf');
    expect(sniffed(glb({ asset: { version: '2.0' } }))).toBe('glb');
    expect(sniffed(zipArchive([{ path: 'a.txt', data: 'hello' }]))).toBe('zip');
    expect(sniffed(PNG_BYTES)).toBe('png');
    expect(sniffed(JPEG_BYTES)).toBe('jpeg');
    expect(sniffed(PDF_BYTES)).toBe('pdf');
    expect(sniffed(BLEND_BYTES)).toBe('blend');
  });

  it('only ever answers with a key the REGISTRY carries', () => {
    // The coupling `sniff.ts` resolves through `assetFormatCapability`: a detector
    // that answered a key no capability row backs would hand the viewer a media
    // type nothing declares.
    const samples = [
      binaryStl(CLOSED_TETRAHEDRON),
      asciiStl([CLOSED_TETRAHEDRON]),
      gltfJson({ asset: { version: '2.0' } }),
      glb({ asset: { version: '2.0' } }),
      zipArchive([{ path: 'a.txt', data: 'x' }]),
      PNG_BYTES,
      JPEG_BYTES,
      PDF_BYTES,
      BLEND_BYTES,
    ];
    const keys = samples.map((sample) => sniffed(sample));
    // The floor: this assertion is about a NON-EMPTY population of identified keys.
    expect(keys.filter((key) => key !== null).length).toBe(samples.length);
    for (const key of keys) {
      expect(ASSET_FORMAT_KEYS).toContain(key);
    }
  });

  it('reads a binary STL by ARITHMETIC, not by its first word', () => {
    // The trap, in both directions. A binary file whose header begins `solid` is
    // still binary, because `84 + 50 x triangles` is its length...
    const binary = binaryStl(CLOSED_TETRAHEDRON, { header: 'solid made-by-an-exporter' });
    expect(binary.length).toBe(84 + 4 * 50);
    expect(sniffed(binary)).toBe('stl');

    // ...and the control: break the length by ONE byte and the formula stops
    // matching, so the file falls through to the text detectors — which is how we
    // know the answer above came from the arithmetic.
    const broken = binary.subarray(0, binary.length - 1);
    expect(sniffed(broken)).toBeNull();
  });

  it('calls a `.stl` that is really a ZIP a zip — requirement 1', () => {
    // The whole point: the bytes decide. The extension never reaches this function,
    // and the mismatch is resolved one layer up by `inspect.service.ts`.
    const archive = zipArchive([{ path: 'model.stl', data: 'not really an stl' }]);
    expect(sniffed(archive)).toBe('zip');
  });

  it('identifies a zip as a ZIP and leaves 3MF refinement to the container reader', () => {
    // `sniff.ts` deliberately does not open archives: deciding 3MF here would mean
    // inflating attacker bytes inside the detector.
    expect(sniffed(threeMfArchive(threeMfModelXml(CLOSED_TETRAHEDRON)))).toBe('zip');
  });

  it('does NOT identify a compressed .blend, and says nothing rather than guessing', () => {
    // Identifying one would mean decompressing an attacker's stream to look inside,
    // for a format the registry already declares unmeasurable. The control is the
    // UNcompressed sibling above, which IS identified.
    expect(sniffed(COMPRESSED_BLEND_BYTES)).toBeNull();
    expect(sniffed(BLEND_BYTES)).toBe('blend');
  });

  it('refuses to call arbitrary text an OBJ', () => {
    expect(sniffed(objFile(['this is a readme', 'about a model']))).toBeNull();
    // The control: one `v` and one `f` line is an OBJ.
    expect(sniffed(objFile(['# a comment', 'v 0 0 0', 'f 1 1 1']))).toBe('obj');
  });

  it('refuses to call a JSON document without `asset.version` a glTF', () => {
    expect(sniffed(gltfJson({ meshes: [] }))).toBeNull();
    expect(sniffed(gltfJson({ asset: { version: '2.0' }, meshes: [] }))).toBe('gltf');
  });

  it('survives an empty file and a single byte', () => {
    expect(sniffed(new Uint8Array(0))).toBeNull();
    expect(sniffed(new Uint8Array([0x7b]))).toBeNull();
  });

  it('reads only the probe window, and the whole-file length is passed separately', () => {
    // A future streaming caller sniffs a prefix. The STL formula needs the real
    // length, which is a number rather than bytes — so a short buffer with a true
    // length still identifies, and a short buffer with a WRONG length does not.
    const full = binaryStl(CLOSED_TETRAHEDRON);
    const prefix = full.subarray(0, 120);
    expect(sniffFormat(prefix, full.length).kind).toBe('identified');
    expect(sniffFormat(prefix, full.length + 7).kind).toBe('unidentified');
    expect(PROBE_BYTES).toBeGreaterThan(1024);
  });
});

describe('the ceilings hold the relationships the parsers assume', () => {
  it('bounds what is PARSED below what is READ', () => {
    // `limits.ts` draws this distinction deliberately: the file ceiling bounds the
    // transfer and these bound the in-memory representation, which costs more.
    expect(MAX_JSON_DOCUMENT_BYTES).toBeLessThan(MAX_INSPECTED_FILE_BYTES);
    expect(MAX_TEXT_DOCUMENT_BYTES).toBeLessThan(MAX_INSPECTED_FILE_BYTES);
    expect(MAX_JSON_DOCUMENT_BYTES).toBeLessThan(MAX_TEXT_DOCUMENT_BYTES);
  });

  it('keeps the watertight ceiling at or below the vertex-dedup ceiling', () => {
    // The edge census is keyed by welded vertex id, so it cannot outlive the map it
    // reads. A watertight ceiling ABOVE the dedup ceiling would be a census that
    // silently stops measuring while still reporting a verdict.
    expect(MAX_WATERTIGHT_TRIANGLES).toBeLessThanOrEqual(MAX_DEDUPLICATED_VERTEX_TRIANGLES);
  });

  it('keeps a per-entry container ceiling below the whole-archive one', () => {
    expect(MAX_CONTAINER_ENTRY_EXPANDED_BYTES).toBeLessThan(MAX_CONTAINER_TOTAL_EXPANDED_BYTES);
  });

  it('keeps the bounding-box ceiling inside an int4 column', () => {
    // The reason this ceiling exists at all: above 2 147 483 647 the INSERT fails
    // rather than a CHECK, and a job that cannot write its result records nothing.
    expect(MAX_BOUNDING_BOX_MM).toBeLessThan(2_147_483_647);
  });

  it('allows three vertices per triangle at the reporting ceilings', () => {
    expect(MAX_REPORTED_VERTICES).toBeGreaterThanOrEqual(MAX_REPORTED_TRIANGLES * 3);
  });

  it('keeps the deadline stride a power of two, because the check is a mask', () => {
    expect(DEADLINE_CHECK_STRIDE & (DEADLINE_CHECK_STRIDE - 1)).toBe(0);
  });

  it('keeps the time budget in seconds, because the inline fallback holds a request', () => {
    expect(INSPECTION_TIME_BUDGET_MS).toBeGreaterThan(1_000);
    expect(INSPECTION_TIME_BUDGET_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('the budget is a cooperative clock, and a test can drive it', () => {
  it('expires when the injected clock passes the deadline', () => {
    let now = 1_000;
    const budget = createInspectionBudget({ timeBudgetMs: 50, now: () => now });
    expect(budget.expired()).toBe(false);
    now = 1_049;
    expect(budget.expired()).toBe(false);
    now = 1_050;
    expect(budget.expired()).toBe(true);
  });

  it('only reads the clock on the stride', () => {
    let reads = 0;
    const budget = createInspectionBudget({
      timeBudgetMs: 0,
      now: () => {
        reads += 1;
        return 0;
      },
    });
    const readsAfterConstruction = reads;
    // Off-stride iterations must not touch the clock at all: at one read per
    // triangle the clock costs more than the triangle.
    expect(budget.expiredOnStride(1)).toBe(false);
    expect(budget.expiredOnStride(DEADLINE_CHECK_STRIDE - 1)).toBe(false);
    expect(reads).toBe(readsAfterConstruction);
    // And on the stride it does, and a spent budget says so.
    expect(budget.expiredOnStride(DEADLINE_CHECK_STRIDE)).toBe(true);
    expect(reads).toBeGreaterThan(readsAfterConstruction);
  });

  it('starts unexpired at iteration zero even with a spent budget', () => {
    // Iteration 0 IS on the stride (`0 & mask === 0`), which is what makes a budget
    // already spent refuse the first triangle rather than the 65 537th.
    const budget = createInspectionBudget({ timeBudgetMs: -1, now: () => 0 });
    expect(budget.expiredOnStride(0)).toBe(true);
  });

  it('offers an explicitly unbounded budget for the tests that are not about time', () => {
    expect(UNBOUNDED_INSPECTION_BUDGET.expired()).toBe(false);
    expect(UNBOUNDED_INSPECTION_BUDGET.expiredOnStride(0)).toBe(false);
  });
});
