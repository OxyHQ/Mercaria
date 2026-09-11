/**
 * The orchestrator, the two fail-closed ports, and the row that comes out.
 *
 * ## What this file is for
 *
 * The parsers are tested directly against real bytes elsewhere. What only this file
 * can see is the composition: that a format mismatch becomes a verdict rather than a
 * measurement of the wrong thing, that `NULL` and `0` survive the trip into
 * `recordFileInspection`'s arguments, that the scanner's refusal is WRITTEN rather
 * than swallowed, and that the processor name and version travel with every result.
 *
 * ## Fail closed, asserted in the currency that matters
 *
 * With no scanner registered the shipped port answers `error`, and
 * `PUBLISHABLE_ASSET_SCAN_VERDICTS` is `['clean']` — so the assertion is not merely
 * "the verdict is error" but that the verdict written is NOT in the publishable set,
 * with the membership of `clean` as the control. A port that had been "helpfully"
 * changed to answer `clean` would pass a test that only checked a string.
 *
 * ## The repository is mocked; the bytes never are
 *
 * `assetRepository` is a thin writer over real SQL and its own behaviour is proven
 * against a real server in `db/digital/__tests__/digital-commerce.realdb.test.ts`.
 * What is asserted here is the ARGUMENTS it is handed, which is the part this module
 * decides. Every file that reaches a parser is built from genuine bytes by
 * `fixtures.ts`, because a mocked parser would accept a reader that walked off the
 * end of its buffer.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLISHABLE_ASSET_SCAN_VERDICTS } from '@mercaria/shared-types';

const findVersionFiles = vi.fn();
const recordFileInspection = vi.fn();
const recordAssetFileScan = vi.fn();
const enqueueAssetFileInspection = vi.fn();

vi.mock('../../../../db/digital/assetRepository.js', () => ({
  findVersionFiles: (...args: unknown[]) => findVersionFiles(...args),
  recordFileInspection: (...args: unknown[]) => recordFileInspection(...args),
  recordAssetFileScan: (...args: unknown[]) => recordAssetFileScan(...args),
}));
vi.mock('../../../../queue/producers.js', () => ({
  enqueueAssetFileInspection: (...args: unknown[]) => enqueueAssetFileInspection(...args),
}));
vi.mock('../../../../lib/logger.js', () => ({
  log: { general: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import {
  INSPECTION_PROCESSOR_NAME,
  INSPECTION_PROCESSOR_VERSION,
  inspectAssetFile,
  inspectAssetVersion,
} from '../inspect.service.js';
import {
  registerAssetByteSource,
  resetAssetByteSource,
  isAssetByteSourceConfigured,
  unregisteredAssetByteSource,
  type AssetByteRead,
} from '../bytes.js';
import {
  NO_SCANNER_CONFIGURED_NAME,
  isAssetMalwareScannerConfigured,
  registerAssetMalwareScanner,
  resetAssetMalwareScanner,
} from '../scanner.js';
import { MAX_INSPECTED_FILE_BYTES } from '../limits.js';
import {
  BLEND_BYTES,
  CLOSED_TETRAHEDRON,
  binaryStl,
  objFile,
  zipArchive,
} from './fixtures.js';

/** A file row as `findVersionFiles` returns it, with only what this module reads. */
function fileRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'file_1',
    versionId: 'ver_1',
    fileName: 'tetra.stl',
    format: 'stl',
    mediaType: 'model/stl',
    role: 'mesh',
    visibility: 'rightful_download_only',
    byteSize: 0,
    contentHash: 'a'.repeat(64),
    scanVerdict: 'pending',
    scanAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Register a byte source that hands back exactly these bytes. */
function serveBytes(bytes: Uint8Array): { reads: number } {
  const counter = { reads: 0 };
  registerAssetByteSource({
    read(): Promise<AssetByteRead> {
      counter.reads += 1;
      return Promise.resolve({ outcome: 'ok', bytes });
    },
  });
  return counter;
}

/** The single `recordFileInspection` argument object. */
function recordedRow(): Record<string, unknown> {
  expect(recordFileInspection, 'nothing was recorded').toHaveBeenCalledTimes(1);
  return recordFileInspection.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAssetByteSource();
  resetAssetMalwareScanner();
  recordFileInspection.mockResolvedValue(undefined);
  recordAssetFileScan.mockResolvedValue(undefined);
  enqueueAssetFileInspection.mockResolvedValue(undefined);
});

describe('the ports ship refusing, and the refusals are the safe direction', () => {
  it('has NO scanner and NO byte source registered by default', () => {
    expect(isAssetMalwareScannerConfigured()).toBe(false);
    expect(isAssetByteSourceConfigured()).toBe(false);
  });

  it('answers `error` for a scan, which is NOT a publishable verdict', async () => {
    const result = await (
      await import('../scanner.js')
    ).assetMalwareScanner().scan({
      fileId: 'file_1',
      fileName: 'x.stl',
      declaredMediaType: 'model/stl',
      bytes: new Uint8Array(4),
    });
    expect(result.verdict).toBe('error');
    expect(result.scannerName).toBe(NO_SCANNER_CONFIGURED_NAME);
    // The assertion that matters: publication is gated on membership of this set, and
    // `error` is not in it. The control is that `clean` IS, so the set is not empty.
    expect(PUBLISHABLE_ASSET_SCAN_VERDICTS).toContain('clean');
    expect(PUBLISHABLE_ASSET_SCAN_VERDICTS as readonly string[]).not.toContain(result.verdict);
  });

  it('refuses to hand over bytes, and says not_found rather than empty bytes', async () => {
    const read = await unregisteredAssetByteSource.read('file_1', MAX_INSPECTED_FILE_BYTES);
    expect(read.outcome).toBe('not_found');
  });
});

describe('inspectAssetFile — the composition', () => {
  it('records `failed` and never reads when no byte source is registered', async () => {
    findVersionFiles.mockResolvedValue([fileRow({ byteSize: 84 })]);
    const report = await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' });

    expect(report.kind).toBe('recorded');
    if (report.kind !== 'recorded') return;
    expect(report.verdict).toBe('failed');
    expect(report.failureDetail).toContain('byte source');
    // Not `unsupported` (which would blame the format) and not `corrupt` (which would
    // blame the creator). And no scan was attempted, because there were no bytes.
    expect(recordAssetFileScan).not.toHaveBeenCalled();
    expect(recordedRow().verdict).toBe('failed');
  });

  it('writes the scanner verdict even when the scanner cannot decide', async () => {
    const bytes = binaryStl(CLOSED_TETRAHEDRON);
    serveBytes(bytes);
    findVersionFiles.mockResolvedValue([fileRow({ byteSize: bytes.length })]);

    const report = await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' });

    expect(recordAssetFileScan).toHaveBeenCalledTimes(1);
    expect(recordAssetFileScan.mock.calls[0][1]).toBe('error');
    // `pending` and `error` are different facts — nothing has looked, versus
    // something looked and could not establish it is clean — and an operator needs
    // the difference. So the verdict is written rather than left alone.
    if (report.kind === 'recorded') expect(report.scanVerdict).toBe('error');
  });

  it('still MEASURES when the scanner cannot decide, because publication is gated elsewhere', async () => {
    const bytes = binaryStl(CLOSED_TETRAHEDRON);
    serveBytes(bytes);
    findVersionFiles.mockResolvedValue([fileRow({ byteSize: bytes.length })]);

    const report = await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' });
    expect(report.kind === 'recorded' && report.verdict).toBe('measured');
    expect(recordedRow().triangleCount).toBe(4);
  });

  it('does NOT parse bytes a scanner called infected', async () => {
    const bytes = binaryStl(CLOSED_TETRAHEDRON);
    serveBytes(bytes);
    findVersionFiles.mockResolvedValue([fileRow({ byteSize: bytes.length })]);
    registerAssetMalwareScanner({
      scan: () =>
        Promise.resolve({
          verdict: 'infected' as const,
          scannerName: 'test-scanner',
          scannerVersion: '1',
          detail: 'EICAR',
        }),
    });

    const report = await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' });
    expect(report.kind === 'recorded' && report.verdict).toBe('failed');
    const row = recordedRow();
    expect(row.failureDetail).toContain('infected');
    // The parsers are the attack surface, so nothing measured this file: the same
    // bytes DO measure with a clean scanner, which is the test above. ABSENT rather
    // than null here because the absence is what travels — `recordFileInspection`
    // maps an absent field to SQL NULL at the boundary (`input.x ?? null`), and the
    // column's own behaviour is proven against a real server in the realdb suite.
    expect(row.triangleCount).toBeUndefined();
  });

  it('records the processor NAME and VERSION with every result', async () => {
    const bytes = binaryStl(CLOSED_TETRAHEDRON);
    serveBytes(bytes);
    findVersionFiles.mockResolvedValue([fileRow({ byteSize: bytes.length })]);
    await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' });

    const row = recordedRow();
    expect(row.processorName).toBe(INSPECTION_PROCESSOR_NAME);
    expect(row.processorVersion).toBe(INSPECTION_PROCESSOR_VERSION);
    expect(row.measuredAt).toBeInstanceOf(Date);
  });

  it('keeps NULL and 0 apart in the row it writes', async () => {
    const bytes = binaryStl(CLOSED_TETRAHEDRON);
    serveBytes(bytes);
    findVersionFiles.mockResolvedValue([fileRow({ byteSize: bytes.length })]);
    await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' });

    const row = recordedRow();
    // Measured values, including a measured ZERO and a measured `false`.
    expect(row.triangleCount).toBe(4);
    expect(row.animationCount).toBe(0);
    expect(row.missingResourceCount).toBe(0);
    expect(row.hasUvMapping).toBe(false);
    expect(row.watertight).toBe(true);
    expect(row.boundingBoxXMm).toBe(10);
  });

  it('writes NULL for everything a non-measurable format does not establish', async () => {
    serveBytes(BLEND_BYTES);
    findVersionFiles.mockResolvedValue([
      fileRow({ fileName: 'sculpt.blend', format: 'blend', byteSize: BLEND_BYTES.length }),
    ]);
    const report = await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' });

    // `unsupported` is the honest verdict for `.blend`, and it comes from the
    // REGISTRY's `geometryMeasurable: false` rather than from a list in the code.
    expect(report.kind === 'recorded' && report.verdict).toBe('unsupported');
    const row = recordedRow();
    for (const column of [
      'triangleCount',
      'vertexCount',
      'meshCount',
      'boundingBoxXMm',
      'boundingBoxYMm',
      'boundingBoxZMm',
      'watertight',
      'hasUvMapping',
      'hasRig',
      'animationCount',
      'missingResourceCount',
    ]) {
      // Absent, which `recordFileInspection` writes as SQL NULL. Never `0`.
      expect(row[column], column).toBeUndefined();
    }
    // Not a measurement of zero anywhere — which is the distinction the whole of
    // ADR 0010 D12 exists for.
    expect(row.verdict).toBe('unsupported');
  });

  it('calls a `.stl` that is really a ZIP corrupt, and names both formats', async () => {
    const archive = zipArchive([{ path: 'readme.txt', data: 'gotcha' }]);
    serveBytes(archive);
    findVersionFiles.mockResolvedValue([fileRow({ byteSize: archive.length })]);

    const report = await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' });
    expect(report.kind).toBe('recorded');
    if (report.kind !== 'recorded') return;
    expect(report.verdict).toBe('corrupt');
    expect(report.declaredFormat).toBe('stl');
    expect(report.verifiedFormat).toBe('zip');
    expect(report.verifiedMediaType).toBe('application/zip');
    expect(report.failureDetail).toContain("'stl'");
    expect(report.failureDetail).toContain("'zip'");
    expect(recordedRow().triangleCount).toBeUndefined();
  });

  it('accepts a file whose content IS what the row claims — the control', async () => {
    const archive = zipArchive([{ path: 'readme.txt', data: 'fine' }]);
    serveBytes(archive);
    findVersionFiles.mockResolvedValue([
      fileRow({ fileName: 'extras.zip', format: 'zip', mediaType: 'application/zip', byteSize: archive.length }),
    ]);
    const report = await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' });
    // A safe archive: nothing measured, nothing refused, and the safety checks ran.
    expect(report.kind === 'recorded' && report.verdict).toBe('unsupported');
    expect(recordedRow().failureDetail).toContain('checked and accepted');
  });

  it('answers `unsupported` for a format the registry calls measurable with no processor', async () => {
    // `\0` rather than the raw byte: a NUL in a .ts file makes `grep` report every
    // symbol in it as ABSENT, and git's binary detection reads only the first 8000
    // bytes, so the diff either vanishes or shows as ordinary text. Same value.
    const fbx = new TextEncoder().encode('Kaydara FBX Binary  \0 rest of a file');
    serveBytes(fbx);
    findVersionFiles.mockResolvedValue([
      fileRow({ fileName: 'rig.fbx', format: 'fbx', byteSize: fbx.length }),
    ]);
    const report = await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' });
    expect(report.kind === 'recorded' && report.verdict).toBe('unsupported');
    // The detail distinguishes the two causes of `unsupported`: a format declared
    // unmeasurable, and a format with no processor in THIS processor version.
    expect(recordedRow().failureDetail).toContain('no processor');
  });

  it('reports a missing sibling resource as `missing_resources`, keeping the geometry', async () => {
    const obj = objFile(['mtllib tetra.mtl', 'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3']);
    serveBytes(obj);
    findVersionFiles.mockResolvedValue([
      fileRow({ id: 'file_obj', fileName: 'tetra.obj', format: 'obj', byteSize: obj.length }),
      fileRow({ id: 'file_png', fileName: 'preview.png', format: 'png', byteSize: 12 }),
    ]);

    const report = await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_obj' });
    expect(report.kind === 'recorded' && report.verdict).toBe('missing_resources');
    const row = recordedRow();
    expect(row.missingResourceCount).toBe(1);
    expect(row.triangleCount).toBe(1);
  });

  it('refuses by RECORDED size without reading a byte', async () => {
    const counter = serveBytes(binaryStl(CLOSED_TETRAHEDRON));
    findVersionFiles.mockResolvedValue([fileRow({ byteSize: MAX_INSPECTED_FILE_BYTES + 1 })]);

    const report = await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' });
    expect(report.kind === 'recorded' && report.verdict).toBe('refused_too_large');
    // The point of checking the row first: a 400 MB file costs one indexed read.
    expect(counter.reads).toBe(0);
  });

  it('refuses when the stored object and the row disagree about the size', async () => {
    const bytes = binaryStl(CLOSED_TETRAHEDRON);
    serveBytes(bytes);
    findVersionFiles.mockResolvedValue([fileRow({ byteSize: bytes.length + 1 })]);

    const report = await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' });
    expect(report.kind === 'recorded' && report.verdict).toBe('corrupt');
    expect(recordedRow().failureDetail).toContain('bytes');
  });

  it('records `refused_too_large` when the port refuses on size', async () => {
    registerAssetByteSource({
      read: () => Promise.resolve({ outcome: 'too_large', byteSize: 999_999_999 }),
    });
    findVersionFiles.mockResolvedValue([fileRow({ byteSize: 84 })]);
    const report = await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' });
    expect(report.kind === 'recorded' && report.verdict).toBe('refused_too_large');
  });

  it('records `failed` when the object is gone, and does not blame the file', async () => {
    registerAssetByteSource({ read: () => Promise.resolve({ outcome: 'not_found' }) });
    findVersionFiles.mockResolvedValue([fileRow({ byteSize: 84 })]);
    const report = await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' });
    expect(report.kind === 'recorded' && report.verdict).toBe('failed');
  });

  it('SKIPS a file that is not one of the version\'s, and writes nothing', async () => {
    findVersionFiles.mockResolvedValue([fileRow({ id: 'someone_elses' })]);
    const report = await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' });
    expect(report.kind).toBe('skipped');
    expect(recordFileInspection).not.toHaveBeenCalled();
    expect(recordAssetFileScan).not.toHaveBeenCalled();
  });

  it('converges on the same row when run twice — the retry contract', async () => {
    const bytes = binaryStl(CLOSED_TETRAHEDRON);
    serveBytes(bytes);
    findVersionFiles.mockResolvedValue([fileRow({ byteSize: bytes.length })]);
    const fixedNow = () => new Date('2026-08-11T00:00:00.000Z');

    await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' }, { now: fixedNow });
    await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' }, { now: fixedNow });

    expect(recordFileInspection).toHaveBeenCalledTimes(2);
    const [first, second] = recordFileInspection.mock.calls.map((call) => call[0]);
    // Identical arguments, so the upsert on `(file, processor, version)` writes the
    // same row twice rather than a second, contradicting one.
    expect(second).toEqual(first);
  });

  it('does not throw for any conclusion about the file', async () => {
    // The whole of the verdict-not-exception contract, driven over the refusals a
    // creator can actually cause.
    const cases: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array([1, 2, 3]),
      zipArchive([{ path: 'a.txt', data: 'x' }]),
      binaryStl(CLOSED_TETRAHEDRON, { declaredTriangles: 77 }),
    ];
    for (const bytes of cases) {
      vi.clearAllMocks();
      recordFileInspection.mockResolvedValue(undefined);
      recordAssetFileScan.mockResolvedValue(undefined);
      serveBytes(bytes);
      findVersionFiles.mockResolvedValue([fileRow({ byteSize: bytes.length })]);
      const report = await inspectAssetFile({ versionId: 'ver_1', fileId: 'file_1' });
      expect(report.kind).toBe('recorded');
      // And every one of them recorded a row, which is what a thrown handler would
      // not have done.
      expect(recordFileInspection).toHaveBeenCalledTimes(1);
    }
  });
});

describe('inspectAssetVersion — the fan-out', () => {
  it('enqueues one job per file and advances no version state', async () => {
    findVersionFiles.mockResolvedValue([
      fileRow({ id: 'file_a' }),
      fileRow({ id: 'file_b' }),
      fileRow({ id: 'file_c' }),
    ]);
    const report = await inspectAssetVersion({ versionId: 'ver_1' });

    expect(report).toEqual({ versionId: 'ver_1', fileCount: 3, enqueued: 3 });
    expect(enqueueAssetFileInspection.mock.calls.map((call) => call[0])).toEqual([
      { versionId: 'ver_1', fileId: 'file_a' },
      { versionId: 'ver_1', fileId: 'file_b' },
      { versionId: 'ver_1', fileId: 'file_c' },
    ]);
  });

  it('enqueues nothing for a version with no files', async () => {
    findVersionFiles.mockResolvedValue([]);
    const report = await inspectAssetVersion({ versionId: 'ver_1' });
    expect(report.enqueued).toBe(0);
    expect(enqueueAssetFileInspection).not.toHaveBeenCalled();
  });
});
