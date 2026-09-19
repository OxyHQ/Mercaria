/**
 * glTF, GLB, the zip reader and 3MF — the declared-number formats and the hostile
 * container surface (#1015 W4 requirements 2–5, W12 threats 5–7).
 *
 * ## Two different kinds of claim, and two different defences
 *
 * An STL's triangle count is corroborated by the file's own LENGTH. A glTF's is not:
 * `accessor.count` is a number in a JSON document and the bytes it describes are in
 * a buffer this pipeline deliberately never decodes. So the defence is a guard on
 * the value itself — `1e300` and `-1` and `2.5` are refused rather than clamped —
 * and the tests below drive each of those directly, because a clamped count is a
 * measurement nobody made.
 *
 * A zip's claims are worse: the entry count, every path and every expanded size are
 * attacker-written, and acting on one before checking it is the zip bomb and the
 * traversal. Every refusal here is therefore asserted to happen WITHOUT inflating
 * anything, which the fixtures make checkable — the bomb's declared size is a lie
 * about a stream that is only a few bytes long.
 *
 * ## `watertight` is absent from every glTF assertion, and that is the assertion
 *
 * The format's indices live in a buffer the parser does not read, so the honest
 * answer is "not determined". It is checked as `undefined` rather than falsy, for
 * the reason `stl-and-obj.test.ts` states: `false` and absent are the two answers
 * #1015 W4's closing rule is about.
 */

import { describe, expect, it } from 'vitest';
import { UNBOUNDED_INSPECTION_BUDGET } from '../budget.js';
import { GLTF_SCALE_TO_MM, inspectGlb, inspectGltfJson } from '../gltf.js';
import {
  findThreeMfModelPart,
  inspectZipContainer,
  openZipContainer,
  readContainerEntry,
  refineZipContainerFormat,
} from '../container.js';
import { inspectThreeMf } from '../threemf.js';
import { resourceIndexOf } from '../resources.js';
import {
  MAX_CONTAINER_ENTRIES,
  MAX_CONTAINER_EXPANSION_RATIO,
  MAX_GLTF_NODE_DEPTH,
} from '../limits.js';
import {
  CLOSED_TETRAHEDRON,
  asciiStl,
  gltfJson,
  glb,
  threeMfArchive,
  threeMfModelXml,
  zipArchive,
} from './fixtures.js';

const budget = UNBOUNDED_INSPECTION_BUDGET;
const NO_SIBLINGS = resourceIndexOf([]);

/** A one-mesh glTF whose POSITION accessor carries the spec-required extents. */
function oneMeshDocument(options?: {
  readonly min?: number[];
  readonly max?: number[];
  readonly node?: Record<string, unknown>;
  readonly indexCount?: unknown;
  readonly positionCount?: unknown;
  readonly attributes?: Record<string, number>;
}): Record<string, unknown> {
  return {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [options?.node ?? { mesh: 0 }],
    meshes: [
      {
        primitives: [
          {
            attributes: options?.attributes ?? { POSITION: 0 },
            indices: 1,
          },
        ],
      },
    ],
    accessors: [
      {
        type: 'VEC3',
        componentType: 5126,
        count: options?.positionCount ?? 4,
        min: options?.min ?? [0, 0, 0],
        max: options?.max ?? [0.01, 0.02, 0.03],
      },
      { type: 'SCALAR', componentType: 5123, count: options?.indexCount ?? 12 },
    ],
    buffers: [{ byteLength: 256, uri: 'geometry.bin' }],
  };
}

describe('glTF JSON', () => {
  it('measures counts and a millimetre box from metadata alone', () => {
    const outcome = inspectGltfJson(gltfJson(oneMeshDocument()), {
      budget,
      availableResources: resourceIndexOf(['geometry.bin']),
    });
    expect(outcome.verdict).toBe('measured');
    expect(outcome.measurement.triangleCount).toBe(4); // 12 indices / 3
    expect(outcome.measurement.vertexCount).toBe(4);
    expect(outcome.measurement.meshCount).toBe(1);
    // One glTF unit is one metre, so 0.01 x 0.02 x 0.03 is 10 x 20 x 30 mm.
    expect(outcome.measurement.boundingBox).toEqual({ xMm: 10, yMm: 20, zMm: 30 });
    expect(GLTF_SCALE_TO_MM).toBe(1000);
  });

  it('leaves `watertight` NOT DETERMINED, because the indices are never decoded', () => {
    const outcome = inspectGltfJson(gltfJson(oneMeshDocument()), {
      budget,
      availableResources: resourceIndexOf(['geometry.bin']),
    });
    expect(outcome.measurement.watertight).toBeUndefined();
    expect('watertight' in outcome.measurement).toBe(false);
    // The control: the same pipeline DOES answer it for a format whose coordinates
    // are in the file, so the absence here is about glTF and not about the check
    // being unimplemented.
    expect(
      inspectGltfJson(gltfJson(oneMeshDocument()), {
        budget,
        availableResources: resourceIndexOf(['geometry.bin']),
      }).measurement.triangleCount,
    ).toBe(4);
  });

  it('applies a node SCALE to the bounding box', () => {
    const scaled = inspectGltfJson(
      gltfJson(oneMeshDocument({ node: { mesh: 0, scale: [2, 2, 2] } })),
      { budget, availableResources: resourceIndexOf(['geometry.bin']) },
    );
    // Twice the size, and the reason the walk exists: reporting accessor extents
    // untransformed would publish half the real print size for this file.
    expect(scaled.measurement.boundingBox).toEqual({ xMm: 20, yMm: 40, zMm: 60 });
  });

  it('applies an explicit column-major matrix', () => {
    const matrix = [3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 5, 0, 0, 1];
    const outcome = inspectGltfJson(
      gltfJson(oneMeshDocument({ node: { mesh: 0, matrix } })),
      { budget, availableResources: resourceIndexOf(['geometry.bin']) },
    );
    // A translation moves the box and does not resize it; the scale triples it.
    expect(outcome.measurement.boundingBox).toEqual({ xMm: 30, yMm: 60, zMm: 90 });
  });

  it('TERMINATES on a cyclic node hierarchy, and still measures it', () => {
    // Two nodes naming each other as children — a two-line file that hangs a
    // recursive walker forever. The visited set is what makes this return, and the
    // measurement is unaffected, so the assertion is that it finishes with an answer.
    const cyclic = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [
        { children: [1] },
        { children: [0], mesh: 0 },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ count: 3, min: [0, 0, 0], max: [1, 1, 1] }],
    };
    const outcome = inspectGltfJson(gltfJson(cyclic), { budget, availableResources: NO_SIBLINGS });
    expect(outcome.verdict).toBe('measured');
    expect(outcome.measurement.vertexCount).toBe(3);
    expect(outcome.measurement.boundingBox).toEqual({ xMm: 1000, yMm: 1000, zMm: 1000 });
  });

  it('WITHHOLDS the box when the node chain is deeper than the bound', () => {
    // A chain longer than `MAX_GLTF_NODE_DEPTH`, with the mesh at the bottom. The
    // walk stops and the size is absent rather than partial — half a scene's extents
    // is not the model's size.
    const depth = MAX_GLTF_NODE_DEPTH + 6;
    const nodes = Array.from({ length: depth }, (_unused, index) =>
      index === depth - 1 ? { mesh: 0 } : { children: [index + 1] },
    );
    const deep = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes,
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ count: 3, min: [0, 0, 0], max: [1, 1, 1] }],
    };
    const outcome = inspectGltfJson(gltfJson(deep), { budget, availableResources: NO_SIBLINGS });
    expect(outcome.verdict).toBe('measured');
    expect(outcome.measurement.vertexCount).toBe(3);
    expect(outcome.measurement.boundingBox).toBeUndefined();
    // The control: the SAME mesh one node deep does report a box, so the absence
    // above is the depth bound and not a broken walk.
    const shallow = { ...deep, nodes: [{ mesh: 0 }] };
    expect(
      inspectGltfJson(gltfJson(shallow), { budget, availableResources: NO_SIBLINGS }).measurement
        .boundingBox,
    ).toEqual({ xMm: 1000, yMm: 1000, zMm: 1000 });
  });

  it('withholds the box when a POSITION accessor carries no extents', () => {
    const noExtents = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ count: 3 }],
    };
    const outcome = inspectGltfJson(gltfJson(noExtents), { budget, availableResources: NO_SIBLINGS });
    expect(outcome.measurement.boundingBox).toBeUndefined();
    expect(outcome.measurement.vertexCount).toBe(3);
  });

  it('measures UV mapping, rigs and animations from the document', () => {
    const rigged = {
      ...oneMeshDocument({ attributes: { POSITION: 0, TEXCOORD_0: 0 } }),
      skins: [{ joints: [0] }],
      animations: [{ channels: [], samplers: [] }, { channels: [], samplers: [] }],
    };
    const outcome = inspectGltfJson(gltfJson(rigged), {
      budget,
      availableResources: resourceIndexOf(['geometry.bin']),
    });
    expect(outcome.measurement.hasUvMapping).toBe(true);
    expect(outcome.measurement.hasRig).toBe(true);
    expect(outcome.measurement.animationCount).toBe(2);
  });

  it('records absence as MEASURED zero and false, not as unknown', () => {
    const plain = inspectGltfJson(gltfJson(oneMeshDocument()), {
      budget,
      availableResources: resourceIndexOf(['geometry.bin']),
    });
    expect(plain.measurement.hasUvMapping).toBe(false);
    expect(plain.measurement.hasRig).toBe(false);
    expect(plain.measurement.animationCount).toBe(0);
  });

  it('REFUSES a declared count no column can hold, rather than clamping it', () => {
    for (const count of [1e300, -1, 2.5, Number.NaN, '12']) {
      const outcome = inspectGltfJson(gltfJson(oneMeshDocument({ indexCount: count })), {
        budget,
        availableResources: resourceIndexOf(['geometry.bin']),
      });
      expect(['corrupt', 'refused_too_large'], String(count)).toContain(outcome.verdict);
      expect(outcome.measurement.triangleCount, String(count)).toBeUndefined();
    }
    // The control: a sane count in the same document measures.
    expect(
      inspectGltfJson(gltfJson(oneMeshDocument({ indexCount: 9 })), {
        budget,
        availableResources: resourceIndexOf(['geometry.bin']),
      }).measurement.triangleCount,
    ).toBe(3);
  });

  it('refuses a triangle total above the reporting ceiling', () => {
    const outcome = inspectGltfJson(
      gltfJson(oneMeshDocument({ indexCount: 90_000_000, positionCount: 30_000_000 })),
      { budget, availableResources: resourceIndexOf(['geometry.bin']) },
    );
    expect(outcome.verdict).toBe('refused_too_large');
  });

  it('reports an external texture URI the version does not hold — requirement 3', () => {
    const withTexture = {
      ...oneMeshDocument(),
      images: [{ uri: 'textures/diffuse.png' }, { uri: 'https://cdn.example/normal.png' }],
    };
    const outcome = inspectGltfJson(gltfJson(withTexture), {
      budget,
      availableResources: resourceIndexOf(['geometry.bin']),
    });
    expect(outcome.verdict).toBe('missing_resources');
    expect(outcome.measurement.missingResources).toEqual([
      'textures/diffuse.png',
      'https://cdn.example/normal.png',
    ]);
    // The geometry survives, and the count is what the column stores.
    expect(outcome.measurement.triangleCount).toBe(4);
  });

  it('treats a data: URI as carrying its own bytes', () => {
    const embedded = {
      ...oneMeshDocument(),
      buffers: [{ byteLength: 4, uri: 'data:application/octet-stream;base64,AAAA' }],
      images: [{ uri: 'data:image/png;base64,AAAA' }],
    };
    const outcome = inspectGltfJson(gltfJson(embedded), { budget, availableResources: NO_SIBLINGS });
    expect(outcome.verdict).toBe('measured');
    expect(outcome.measurement.missingResources).toEqual([]);
  });

  it('decodes a percent-escaped URI before matching it', () => {
    const escaped = { ...oneMeshDocument(), images: [{ uri: 'my%20texture.png' }] };
    const outcome = inspectGltfJson(gltfJson(escaped), {
      budget,
      availableResources: resourceIndexOf(['geometry.bin', 'my texture.png']),
    });
    expect(outcome.verdict).toBe('measured');
  });

  it('refuses a buffer with no uri outside a GLB, which is a structural error', () => {
    const invalid = { ...oneMeshDocument(), buffers: [{ byteLength: 4 }] };
    const outcome = inspectGltfJson(gltfJson(invalid), { budget, availableResources: NO_SIBLINGS });
    expect(outcome.verdict).toBe('corrupt');
    expect(outcome.failureDetail).toContain('GLB');
  });

  it('refuses unparseable JSON and JSON that is not a glTF', () => {
    expect(
      inspectGltfJson(new TextEncoder().encode('{ not json'), {
        budget,
        availableResources: NO_SIBLINGS,
      }).verdict,
    ).toBe('corrupt');
    expect(
      inspectGltfJson(gltfJson({ meshes: [] }), { budget, availableResources: NO_SIBLINGS }).verdict,
    ).toBe('corrupt');
  });
});

describe('GLB', () => {
  it('measures through the chunk table, and the BIN chunk is not a missing resource', () => {
    const document = oneMeshDocument();
    document.buffers = [{ byteLength: 8 }];
    const outcome = inspectGlb(glb(document, { bin: new Uint8Array(8) }), {
      budget,
      availableResources: NO_SIBLINGS,
    });
    expect(outcome.verdict).toBe('measured');
    expect(outcome.measurement.triangleCount).toBe(4);
    expect(outcome.measurement.missingResources).toEqual([]);
  });

  it('refuses a header declaring more bytes than the file holds', () => {
    const bytes = glb(oneMeshDocument(), { declaredLength: 10_000 });
    const outcome = inspectGlb(bytes, { budget, availableResources: NO_SIBLINGS });
    expect(outcome.verdict).toBe('corrupt');
    expect(outcome.failureDetail).toContain('declares');
  });

  it('refuses a container version it does not measure, as UNSUPPORTED not corrupt', () => {
    const outcome = inspectGlb(glb(oneMeshDocument(), { version: 1 }), {
      budget,
      availableResources: NO_SIBLINGS,
    });
    expect(outcome.verdict).toBe('unsupported');
  });

  it('refuses a chunk whose length runs past the declared end', () => {
    const bytes = glb(oneMeshDocument());
    new DataView(bytes.buffer).setUint32(12, 0xffff, true);
    expect(inspectGlb(bytes, { budget, availableResources: NO_SIBLINGS }).verdict).toBe('corrupt');
  });

  it('refuses bytes that are not a GLB at all', () => {
    expect(
      inspectGlb(new Uint8Array([1, 2, 3]), { budget, availableResources: NO_SIBLINGS }).verdict,
    ).toBe('corrupt');
    expect(
      inspectGlb(asciiStl([CLOSED_TETRAHEDRON]), { budget, availableResources: NO_SIBLINGS })
        .verdict,
    ).toBe('corrupt');
  });
});

describe('the zip reader refuses before it expands', () => {
  it('inventories a well-formed archive', () => {
    const opened = openZipContainer(
      zipArchive([
        { path: 'readme.txt', data: 'hello' },
        { path: 'models/part.stl', data: 'x', method: 8 },
        { path: 'models/', data: '' },
      ]),
      budget,
    );
    expect(opened.ok).toBe(true);
    if (opened.ok === true) {
      expect(opened.entries.map((entry) => entry.path)).toEqual([
        'readme.txt',
        'models/part.stl',
        'models/',
      ]);
      expect(opened.entries[2].isDirectory).toBe(true);
    }
  });

  it('refuses a TRAVERSAL path — threat 6', () => {
    const opened = openZipContainer(
      zipArchive([{ path: '../../etc/passwd', data: 'x' }]),
      budget,
    );
    expect(opened.ok).toBe(false);
    if (opened.ok === false) {
      expect(opened.outcome.verdict).toBe('corrupt');
      expect(opened.outcome.failureDetail).toContain('escapes the archive root');
    }
  });

  it('refuses an absolute path, and accepts a harmless `./` chain', () => {
    expect(openZipContainer(zipArchive([{ path: '/etc/shadow', data: 'x' }]), budget).ok).toBe(false);
    expect(
      openZipContainer(zipArchive([{ path: 'C:/Windows/x.dll', data: 'x' }]), budget).ok,
    ).toBe(false);
    // The control: a path that dips and returns stays inside, and a substring test
    // for `..` would wrongly refuse it.
    expect(openZipContainer(zipArchive([{ path: 'a/../b.txt', data: 'x' }]), budget).ok).toBe(true);
  });

  it('refuses a SYMLINK entry, which is the traversal that survives extraction', () => {
    const opened = openZipContainer(
      zipArchive([{ path: 'innocent.txt', data: '/etc/shadow', unixMode: 0o120777 }]),
      budget,
    );
    expect(opened.ok).toBe(false);
    if (opened.ok === false) expect(opened.outcome.failureDetail).toContain('symlink');
    // The control: the same entry as an ordinary file is accepted, so the refusal is
    // about the mode and not about the name or the content.
    expect(
      openZipContainer(zipArchive([{ path: 'innocent.txt', data: '/etc/shadow' }]), budget).ok,
    ).toBe(true);
  });

  it('refuses an entry count above the ceiling WITHOUT reading an entry record', () => {
    // The directory claims thousands of entries and holds one. Nothing walks it.
    const opened = openZipContainer(
      zipArchive([{ path: 'a.txt', data: 'x' }], {
        declaredTotalEntries: MAX_CONTAINER_ENTRIES + 1,
      }),
      budget,
    );
    expect(opened.ok).toBe(false);
    if (opened.ok === false) expect(opened.outcome.verdict).toBe('refused_too_large');
  });

  it('refuses a zip64 archive by its sentinel', () => {
    const opened = openZipContainer(
      zipArchive([{ path: 'a.txt', data: 'x' }], { declaredTotalEntries: 0xffff }),
      budget,
    );
    expect(opened.ok).toBe(false);
    if (opened.ok === false) expect(opened.outcome.failureDetail).toContain('zip64');
  });

  it('refuses a declared expansion RATIO above the ceiling — the bomb', () => {
    // Four bytes of data claiming to expand to a megabyte. The advertisement is
    // refused; nothing is inflated.
    const opened = openZipContainer(
      zipArchive([
        { path: 'bomb.bin', data: 'tiny', declaredUncompressedSize: 4 * MAX_CONTAINER_EXPANSION_RATIO + 4 },
      ]),
      budget,
    );
    expect(opened.ok).toBe(false);
    if (opened.ok === false) {
      expect(opened.outcome.verdict).toBe('refused_too_large');
      expect(opened.outcome.failureDetail).toContain('expansion');
    }
  });

  it('reads one stored entry and one deflated entry, and refuses a lying size', () => {
    const archive = zipArchive([
      { path: 'stored.txt', data: 'stored bytes' },
      { path: 'deflated.txt', data: 'deflated bytes', method: 8 },
    ]);
    const opened = openZipContainer(archive, budget);
    expect(opened.ok).toBe(true);
    if (opened.ok === false) return;
    const decoder = new TextDecoder();
    for (const entry of opened.entries) {
      const read = readContainerEntry(archive, entry);
      expect(read.ok, entry.path).toBe(true);
      if (read.ok === true) expect(decoder.decode(read.bytes)).toContain('bytes');
    }

    // And a central directory that over-declares is caught by comparing the result.
    const lying = zipArchive([
      { path: 'liar.txt', data: 'short', method: 8, declaredUncompressedSize: 40 },
    ]);
    const openedLiar = openZipContainer(lying, budget);
    expect(openedLiar.ok).toBe(true);
    if (openedLiar.ok === true) {
      const read = readContainerEntry(lying, openedLiar.entries[0]);
      expect(read.ok).toBe(false);
      if (read.ok === false) expect(read.outcome.verdict).toBe('corrupt');
    }
  });

  it('refuses an archive with no end record', () => {
    const opened = openZipContainer(new Uint8Array(64), budget);
    expect(opened.ok).toBe(false);
  });

  it('reports a SAFE zip as unsupported rather than as a measurement', () => {
    const outcome = inspectZipContainer(
      zipArchive([{ path: 'a.txt', data: 'x' }, { path: 'b/', data: '' }]),
      budget,
    );
    // Nothing geometric was measured and nothing is claimed as zero; what the row
    // records is that the safety checks ran.
    expect(outcome.verdict).toBe('unsupported');
    expect(outcome.failureDetail).toContain('1 file entry');
    expect(outcome.measurement).toEqual({});
  });

  it('refines a zip to 3MF only when BOTH OPC parts are present', () => {
    const threeMf = threeMfArchive(threeMfModelXml(CLOSED_TETRAHEDRON));
    const openedThreeMf = openZipContainer(threeMf, budget);
    expect(openedThreeMf.ok).toBe(true);
    if (openedThreeMf.ok === true) {
      expect(refineZipContainerFormat(openedThreeMf.entries)).toBe('3mf');
      expect(findThreeMfModelPart(openedThreeMf.entries)?.path).toBe('3D/3dmodel.model');
    }

    // The control: a plain zip that happens to contain a `.model` file is NOT a 3MF,
    // because mis-refining would report a format mismatch against a correct `.zip`.
    const looksSimilar = zipArchive([{ path: '3D/3dmodel.model', data: '<model/>' }]);
    const openedPlain = openZipContainer(looksSimilar, budget);
    if (openedPlain.ok === true) {
      expect(refineZipContainerFormat(openedPlain.entries)).toBe('zip');
    }
  });
});

describe('3MF', () => {
  it('measures the model part and converts its declared unit', () => {
    const outcome = inspectThreeMf(threeMfArchive(threeMfModelXml(CLOSED_TETRAHEDRON)), { budget });
    expect(outcome.verdict).toBe('measured');
    expect(outcome.measurement.triangleCount).toBe(4);
    expect(outcome.measurement.vertexCount).toBe(4);
    expect(outcome.measurement.meshCount).toBe(1);
    expect(outcome.measurement.boundingBox).toEqual({ xMm: 10, yMm: 20, zMm: 30 });
    expect(outcome.measurement.watertight).toBe(true);
  });

  it('scales a centimetre model, because 3MF CARRIES its unit', () => {
    const outcome = inspectThreeMf(
      threeMfArchive(threeMfModelXml(CLOSED_TETRAHEDRON, { unit: 'centimeter' })),
      { budget },
    );
    expect(outcome.measurement.boundingBox).toEqual({ xMm: 100, yMm: 200, zMm: 300 });
  });

  it('refuses a unit that is not in the spec rather than assuming millimetres', () => {
    const outcome = inspectThreeMf(
      threeMfArchive(threeMfModelXml(CLOSED_TETRAHEDRON, { unit: 'furlong' })),
      { budget },
    );
    expect(outcome.verdict).toBe('corrupt');
    expect(outcome.failureDetail).toContain('furlong');
  });

  it('WITHHOLDS the box when a build item carries a transform, and keeps the counts', () => {
    const outcome = inspectThreeMf(
      threeMfArchive(
        threeMfModelXml(CLOSED_TETRAHEDRON, { itemTransform: '2 0 0 0 2 0 0 0 2 0 0 0' }),
      ),
      { budget },
    );
    expect(outcome.verdict).toBe('measured');
    expect(outcome.measurement.triangleCount).toBe(4);
    // The transform is not composed, so the object-space union is not the physical
    // size — absent rather than wrong by a factor of two.
    expect(outcome.measurement.boundingBox).toBeUndefined();
  });

  it('reports a texture part the package does not contain', () => {
    const outcome = inspectThreeMf(
      threeMfArchive(
        threeMfModelXml(CLOSED_TETRAHEDRON, { texturePath: '/3D/Textures/diffuse.png' }),
      ),
      { budget },
    );
    expect(outcome.verdict).toBe('missing_resources');
    expect(outcome.measurement.missingResources).toEqual(['/3D/Textures/diffuse.png']);
    expect(outcome.measurement.hasUvMapping).toBe(true);

    // The control: the same model with the texture part present measures cleanly.
    const complete = inspectThreeMf(
      threeMfArchive(
        threeMfModelXml(CLOSED_TETRAHEDRON, { texturePath: '/3D/Textures/diffuse.png' }),
        { extraEntries: [{ path: '3D/Textures/diffuse.png', data: 'png bytes' }] },
      ),
      { budget },
    );
    expect(complete.verdict).toBe('measured');
    expect(complete.measurement.missingResources).toEqual([]);
  });

  it('refuses a triangle naming a vertex its object does not declare', () => {
    const broken = threeMfModelXml(CLOSED_TETRAHEDRON).replace('v1="0"', 'v1="99"');
    const outcome = inspectThreeMf(threeMfArchive(broken), { budget });
    expect(outcome.verdict).toBe('corrupt');
  });

  it('refuses a model part that is itself an archive — the depth bound', () => {
    // A zip inside the zip, at the path the spec fixes. Nothing opens it: the
    // nesting bound is that there is no second container reader to reach.
    const inner = zipArchive([{ path: 'inner.model', data: '<model/>' }]);
    const nested = zipArchive([
      { path: '[Content_Types].xml', data: '<Types/>' },
      { path: '3D/3dmodel.model', data: inner },
    ]);
    const outcome = inspectThreeMf(nested, { budget });
    expect(outcome.verdict).toBe('corrupt');
    expect(outcome.failureDetail).toContain('itself an archive');
  });

  it('refuses a model part that is not a model document, rather than measuring zero', () => {
    // The plausible zero: a part with no `<model>` root matches no tag, so a naive
    // scan reports a model with zero triangles.
    const outcome = inspectThreeMf(threeMfArchive('this is not xml at all'), { budget });
    expect(outcome.verdict).toBe('corrupt');
    expect(outcome.failureDetail).toContain('<model> root');
    // The control: a real model part with the same machinery measures.
    expect(
      inspectThreeMf(threeMfArchive(threeMfModelXml(CLOSED_TETRAHEDRON)), { budget }).verdict,
    ).toBe('measured');
  });

  it('refuses a package with no model part', () => {
    const outcome = inspectThreeMf(zipArchive([{ path: 'a.txt', data: 'x' }]), { budget });
    expect(outcome.verdict).toBe('corrupt');
    expect(outcome.failureDetail).toContain('no 3D model part');
  });

  it('records what the format settles as measured facts', () => {
    const outcome = inspectThreeMf(threeMfArchive(threeMfModelXml(CLOSED_TETRAHEDRON)), { budget });
    expect(outcome.measurement.hasRig).toBe(false);
    expect(outcome.measurement.animationCount).toBe(0);
    expect(outcome.measurement.hasUvMapping).toBe(false);
  });
});
