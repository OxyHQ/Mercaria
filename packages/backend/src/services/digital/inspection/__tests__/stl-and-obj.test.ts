/**
 * The two unitless mesh parsers and the geometry census they share.
 *
 * ## What this file is really testing
 *
 * `watertight`, and the three-valued answer ADR 0010 D12 made the column nullable
 * for. Every other measurement here is arithmetic; that one is the measurement a
 * buyer might spend money on the strength of, and #1015 W4's closing rule is that it
 * must never be overclaimed. So the tetrahedron appears three ways — closed, open,
 * and degenerate — and the `absent` case is asserted as `undefined` rather than as
 * falsy, because `false` and "not determined" are the two answers the rule is about
 * and `toBeFalsy()` would accept either.
 *
 * ## The NULL/0 pairs
 *
 * Each parser is asserted to report `animationCount: 0` and `missingResources: []`
 * as MEASURED facts — an STL genuinely has no animation track, which is a stronger
 * and more useful statement than `null`. The same assertions in the opposite
 * direction live in `gltf-and-container.test.ts`, where `watertight` is absent
 * because the format's indices are in a buffer this pipeline does not read.
 */

import { describe, expect, it } from 'vitest';
import { UNBOUNDED_INSPECTION_BUDGET, createInspectionBudget } from '../budget.js';
import { inspectStl } from '../stl.js';
import { inspectObj } from '../obj.js';
import { resourceIndexOf } from '../resources.js';
import { VERTEX_WELD_EPSILON } from '../mesh.js';
import { MAX_TEXT_DOCUMENT_BYTES } from '../limits.js';
import {
  CLOSED_TETRAHEDRON,
  asciiStl,
  binaryStl,
  objFile,
  openTetrahedron,
  type Triangle,
} from './fixtures.js';

const budget = UNBOUNDED_INSPECTION_BUDGET;
const NO_SIBLINGS = resourceIndexOf([]);

describe('binary STL', () => {
  it('measures counts, a millimetre bounding box and a closed surface', () => {
    const outcome = inspectStl(binaryStl(CLOSED_TETRAHEDRON), { budget });
    expect(outcome.verdict).toBe('measured');
    expect(outcome.measurement.triangleCount).toBe(4);
    // Four WELDED corners, not twelve stored ones. The distinction `limits.ts`
    // refuses to blur: a viewer reports the welded figure.
    expect(outcome.measurement.vertexCount).toBe(4);
    expect(outcome.measurement.meshCount).toBe(1);
    expect(outcome.measurement.boundingBox).toEqual({ xMm: 10, yMm: 20, zMm: 30 });
    expect(outcome.measurement.watertight).toBe(true);
  });

  it('reports what the FORMAT settles as measured facts, not as absences', () => {
    const outcome = inspectStl(binaryStl(CLOSED_TETRAHEDRON), { budget });
    // STL carries no UV channel, no skeleton and no animation track, so these are
    // true statements rather than unknowns — the `0`-is-an-answer half of ADR 0010
    // D12, which is the half people forget.
    expect(outcome.measurement.hasUvMapping).toBe(false);
    expect(outcome.measurement.hasRig).toBe(false);
    expect(outcome.measurement.animationCount).toBe(0);
    expect(outcome.measurement.missingResources).toEqual([]);
  });

  it('says `false` for a surface with a hole, and the control is the closed one', () => {
    const open = inspectStl(binaryStl(openTetrahedron()), { budget });
    expect(open.verdict).toBe('measured');
    expect(open.measurement.watertight).toBe(false);
    expect(open.measurement.triangleCount).toBe(3);
    // The control: the same census says `true` for the closed mesh, so a `false`
    // here is a measurement rather than a check that never passes.
    expect(inspectStl(binaryStl(CLOSED_TETRAHEDRON), { budget }).measurement.watertight).toBe(true);
  });

  it('leaves watertight UNDETERMINED for an empty mesh rather than vacuously true', () => {
    const outcome = inspectStl(binaryStl([]), { budget });
    expect(outcome.verdict).toBe('measured');
    expect(outcome.measurement.triangleCount).toBe(0);
    // `undefined`, checked exactly: an empty file is not a printable model, and
    // `toBeFalsy()` here would also accept the `false` this rule forbids.
    expect(outcome.measurement.watertight).toBeUndefined();
    expect('watertight' in outcome.measurement).toBe(false);
    // And a bounding box of nothing is absent, not three zeroes.
    expect(outcome.measurement.boundingBox).toBeUndefined();
    // While the counts ARE zero, measured.
    expect(outcome.measurement.meshCount).toBe(0);
  });

  it('says `false` for a degenerate triangle, because a slicer will too', () => {
    const degenerate: readonly Triangle[] = [
      [[0, 0, 0], [1, 0, 0], [1, 0, 0]],
    ];
    expect(inspectStl(binaryStl(degenerate), { budget }).measurement.watertight).toBe(false);
  });

  it('REFUSES a header declaring more triangles than the file holds', () => {
    // The lie a parser must not act on: believing it would read past the buffer.
    const lying = binaryStl(CLOSED_TETRAHEDRON, { declaredTriangles: 1_000_000 });
    const outcome = inspectStl(lying, { budget });
    expect(outcome.verdict).toBe('corrupt');
    expect(outcome.measurement.triangleCount).toBeUndefined();
  });

  it('accepts trailing junk after the last facet', () => {
    // The other direction of the same arithmetic: fewer bytes NEEDED than the file
    // has is an exporter's padding, real files have it, and all four declared
    // triangles are present to measure.
    const padded = binaryStl(CLOSED_TETRAHEDRON, { trailingJunk: 16 });
    const outcome = inspectStl(padded, { budget });
    expect(outcome.verdict).toBe('measured');
    expect(outcome.measurement.triangleCount).toBe(4);
  });

  it('refuses a binary file declaring ZERO triangles rather than measuring an empty mesh', () => {
    // `84 <= length` is satisfied by every binary file, so a zero count plus a body
    // is the shape that would turn any mislabelled binary into a measured nothing —
    // the plausible zero this parser exists to avoid.
    const zeroDeclared = binaryStl(CLOSED_TETRAHEDRON, { declaredTriangles: 0 });
    expect(inspectStl(zeroDeclared, { budget }).verdict).toBe('corrupt');
    // The control: a genuinely empty binary STL is 84 bytes and IS measured as zero.
    const empty = binaryStl([]);
    expect(empty.length).toBe(84);
    expect(inspectStl(empty, { budget }).verdict).toBe('measured');
  });

  it('welds corners written as different floats within the tolerance', () => {
    const offset = VERTEX_WELD_EPSILON / 4;
    const nudged: readonly Triangle[] = CLOSED_TETRAHEDRON.map((triangle, index) =>
      index === 0
        ? ([
            [offset, 0, 0],
            triangle[1],
            triangle[2],
          ] as Triangle)
        : triangle,
    );
    // Still four welded corners and still closed: an exporter that rounds a shared
    // corner differently in one facet has not produced a mesh with a hole.
    const outcome = inspectStl(binaryStl(nudged), { budget });
    expect(outcome.measurement.vertexCount).toBe(4);
    expect(outcome.measurement.watertight).toBe(true);
  });

  it('refuses a non-finite coordinate as corrupt', () => {
    const bytes = binaryStl(CLOSED_TETRAHEDRON);
    new DataView(bytes.buffer).setUint32(84 + 12, 0x7fc00000, true); // NaN
    expect(inspectStl(bytes, { budget }).verdict).toBe('corrupt');
  });

  it('refuses when the time budget runs out mid-mesh', () => {
    let now = 0;
    const spent = createInspectionBudget({ timeBudgetMs: 0, now: () => now });
    now = 1;
    const outcome = inspectStl(binaryStl(CLOSED_TETRAHEDRON), { budget: spent });
    expect(outcome.verdict).toBe('refused_too_large');
    expect(outcome.failureDetail).toContain('time budget');
    // Nothing partial travels with a refusal: a prefix's triangle count is wrong
    // about the model rather than missing.
    expect(outcome.measurement.triangleCount).toBeUndefined();
  });
});

describe('ASCII STL', () => {
  it('measures the same mesh as its binary twin', () => {
    const ascii = inspectStl(asciiStl([CLOSED_TETRAHEDRON]), { budget });
    const binary = inspectStl(binaryStl(CLOSED_TETRAHEDRON), { budget });
    expect(ascii.verdict).toBe('measured');
    expect(ascii.measurement.triangleCount).toBe(binary.measurement.triangleCount);
    expect(ascii.measurement.boundingBox).toEqual(binary.measurement.boundingBox);
    expect(ascii.measurement.watertight).toBe(binary.measurement.watertight);
  });

  it('counts one mesh per `solid` block', () => {
    const outcome = inspectStl(asciiStl([CLOSED_TETRAHEDRON, CLOSED_TETRAHEDRON]), { budget });
    expect(outcome.measurement.meshCount).toBe(2);
    expect(outcome.measurement.triangleCount).toBe(8);
  });

  it('refuses a facet that is not a triangle, naming the line', () => {
    const bad = new TextEncoder().encode(
      ['solid x', 'facet normal 0 0 0', 'outer loop',
       'vertex 0 0 0', 'vertex 1 0 0', 'vertex 0 1 0', 'vertex 1 1 0',
       'endloop', 'endfacet', 'endsolid x'].join('\n'),
    );
    const outcome = inspectStl(bad, { budget });
    expect(outcome.verdict).toBe('corrupt');
    expect(outcome.failureDetail).toMatch(/line \d+/u);
  });

  it('refuses a file that ends inside a facet', () => {
    const truncated = new TextEncoder().encode(
      ['solid x', 'facet normal 0 0 0', 'outer loop', 'vertex 0 0 0'].join('\n'),
    );
    expect(inspectStl(truncated, { budget }).verdict).toBe('corrupt');
  });

  it('refuses text that is not STL at all', () => {
    expect(inspectStl(new TextEncoder().encode('hello world\n'), { budget }).verdict).toBe('corrupt');
  });

  it('refuses a text file above the text ceiling without decoding it', () => {
    // Space-filled rather than zero-filled, deliberately: a NUL would make this
    // binary, and the binary branch would refuse it on the length formula instead —
    // a pass for the wrong reason.
    const huge = new Uint8Array(MAX_TEXT_DOCUMENT_BYTES + 1).fill(0x20);
    huge.set(new TextEncoder().encode('solid x\n'), 0);
    const outcome = inspectStl(huge, { budget });
    expect(outcome.verdict).toBe('refused_too_large');
    expect(outcome.failureDetail).toContain('ceiling');
  });
});

describe('OBJ', () => {
  it('measures a triangulated mesh', () => {
    const outcome = inspectObj(
      objFile([
        'o tetra',
        'v 0 0 0', 'v 10 0 0', 'v 0 20 0', 'v 0 0 30',
        'f 1 2 3', 'f 1 3 4', 'f 1 4 2', 'f 2 4 3',
      ]),
      { budget, availableResources: NO_SIBLINGS },
    );
    expect(outcome.verdict).toBe('measured');
    expect(outcome.measurement.triangleCount).toBe(4);
    expect(outcome.measurement.vertexCount).toBe(4);
    expect(outcome.measurement.meshCount).toBe(1);
    expect(outcome.measurement.boundingBox).toEqual({ xMm: 10, yMm: 20, zMm: 30 });
    expect(outcome.measurement.watertight).toBe(true);
    expect(outcome.measurement.hasRig).toBe(false);
    expect(outcome.measurement.animationCount).toBe(0);
  });

  it('fan-triangulates a polygon, so a quad counts as TWO triangles', () => {
    const outcome = inspectObj(
      objFile(['v 0 0 0', 'v 10 0 0', 'v 10 10 0', 'v 0 10 0', 'f 1 2 3 4']),
      { budget, availableResources: NO_SIBLINGS },
    );
    // The convention stated in `obj.ts`: `cornerCount - 2`, which is what every
    // importer reports and is comparable with the STL in the same package.
    expect(outcome.measurement.triangleCount).toBe(2);
  });

  it('resolves NEGATIVE indices against the vertices declared so far', () => {
    const outcome = inspectObj(
      objFile(['v 0 0 0', 'v 4 0 0', 'v 0 8 0', 'f -3 -2 -1']),
      { budget, availableResources: NO_SIBLINGS },
    );
    expect(outcome.verdict).toBe('measured');
    expect(outcome.measurement.triangleCount).toBe(1);
    expect(outcome.measurement.boundingBox).toEqual({ xMm: 4, yMm: 8, zMm: 0 });
  });

  it('refuses an index outside the declared vertices rather than clamping it', () => {
    const outcome = inspectObj(objFile(['v 0 0 0', 'f 1 2 3']), {
      budget,
      availableResources: NO_SIBLINGS,
    });
    expect(outcome.verdict).toBe('corrupt');
    expect(outcome.failureDetail).toContain('not declared');
    // The control: the same file with the vertices it promises measures cleanly.
    expect(
      inspectObj(objFile(['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3']), {
        budget,
        availableResources: NO_SIBLINGS,
      }).verdict,
    ).toBe('measured');
  });

  it('refuses a forward reference, because an index is relative to THIS line', () => {
    // `f` before the `v` it names. A parser that resolved indices after reading the
    // whole file would accept this and mis-resolve every negative index in it.
    const outcome = inspectObj(objFile(['f 1 2 3', 'v 0 0 0', 'v 1 0 0', 'v 0 1 0']), {
      budget,
      availableResources: NO_SIBLINGS,
    });
    expect(outcome.verdict).toBe('corrupt');
  });

  it('reports a missing MTL by name — requirement 3', () => {
    const outcome = inspectObj(
      objFile(['mtllib tetra.mtl', 'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3']),
      { budget, availableResources: resourceIndexOf(['tetra.obj', 'preview.png']) },
    );
    expect(outcome.verdict).toBe('missing_resources');
    expect(outcome.measurement.missingResources).toEqual(['tetra.mtl']);
    // The geometry survives the verdict: a creator who forgot one file has still
    // uploaded a mesh, and dropping the measurement punishes them twice.
    expect(outcome.measurement.triangleCount).toBe(1);
    expect(outcome.failureDetail).toContain('tetra.mtl');
  });

  it('finds the MTL when the version HOLDS it, which is the control', () => {
    const outcome = inspectObj(
      objFile(['mtllib tetra.mtl', 'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3']),
      { budget, availableResources: resourceIndexOf(['tetra.obj', 'tetra.mtl']) },
    );
    expect(outcome.verdict).toBe('measured');
    expect(outcome.measurement.missingResources).toEqual([]);
  });

  it('matches an exported directory path against the flat file name', () => {
    const outcome = inspectObj(
      objFile(['mtllib materials/Tetra.MTL', 'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3']),
      { budget, availableResources: resourceIndexOf(['tetra.mtl']) },
    );
    expect(outcome.verdict).toBe('measured');
  });

  it('never resolves a traversal or a remote reference, and reports both missing', () => {
    const outcome = inspectObj(
      objFile([
        'mtllib ../../../etc/passwd',
        'mtllib http://attacker.example/x.mtl',
        'mtllib /absolute.mtl',
        'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3',
      ]),
      { budget, availableResources: resourceIndexOf(['passwd', 'x.mtl', 'absolute.mtl']) },
    );
    // Every one of the three names something that IS in the resource set by base
    // name, and all three are still missing: the refusal is about the shape of the
    // reference, not about whether a matching name exists.
    expect(outcome.verdict).toBe('missing_resources');
    expect(outcome.measurement.missingResources?.length).toBe(3);
  });

  it('measures UV mapping from the FACES, not from the `vt` declarations', () => {
    const unused = inspectObj(
      objFile(['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'vt 0 0', 'f 1 2 3']),
      { budget, availableResources: NO_SIBLINGS },
    );
    // `vt` lines nothing references is not UV mapping.
    expect(unused.measurement.hasUvMapping).toBe(false);

    const used = inspectObj(
      objFile(['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'vt 0 0', 'vt 1 0', 'vt 0 1', 'f 1/1 2/2 3/3']),
      { budget, availableResources: NO_SIBLINGS },
    );
    expect(used.measurement.hasUvMapping).toBe(true);
  });

  it('skips directives it does not measure instead of calling the file corrupt', () => {
    const outcome = inspectObj(
      objFile([
        '# exported by something',
        'mtllib x.mtl',
        'usemtl shiny',
        'vn 0 0 1',
        's off',
        'g group-one',
        'l 1 2',
        'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1//1 2//1 3//1',
      ]),
      { budget, availableResources: resourceIndexOf(['x.mtl']) },
    );
    expect(outcome.verdict).toBe('measured');
    expect(outcome.measurement.triangleCount).toBe(1);
    // `f 1//1` has an empty texture field, so it is NOT UV mapping.
    expect(outcome.measurement.hasUvMapping).toBe(false);
  });

  it('measures a zero-triangle OBJ as zero meshes, not as one empty one', () => {
    const outcome = inspectObj(objFile(['v 0 0 0']), {
      budget,
      availableResources: NO_SIBLINGS,
    });
    expect(outcome.measurement.meshCount).toBe(0);
    expect(outcome.measurement.triangleCount).toBe(0);
    expect(outcome.measurement.watertight).toBeUndefined();
  });
});
