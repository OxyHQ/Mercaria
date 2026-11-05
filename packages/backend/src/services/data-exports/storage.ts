/**
 * Where an export file goes: a PRIVATE file of the Mercaria application in Oxy
 * Files (ADR 0043), readable by no person and downloaded only through a
 * short-lived URL Mercaria mints after its own permission check.
 *
 * A port with one implementation, so the worker's realdb suite can run the
 * whole claim → read → store → complete path against a real database without
 * reaching Oxy.
 */

import {
  mintPrivateDownloadUrls,
  uploadPrivateApplicationFile,
} from '../catalog-media/oxy-files.js';

export interface DataExportStorage {
  /** Store the file's bytes; answers the Oxy file id. Throws when storage refused. */
  store(body: string, filename: string): Promise<{ fileId: string }>;
  /** A short-lived download URL, or `null` when the file is no longer served. */
  downloadUrl(fileId: string): Promise<string | null>;
}

export const oxyDataExportStorage: DataExportStorage = {
  async store(body, filename) {
    const stored = await uploadPrivateApplicationFile(
      new Blob([body], { type: 'text/csv' }),
      'text/csv',
      { filename, metadata: { purpose: 'data_export' } },
    );
    return { fileId: stored.fileId };
  },
  async downloadUrl(fileId) {
    const minted = await mintPrivateDownloadUrls([fileId]);
    return minted.find((entry) => entry?.id === fileId)?.url ?? null;
  },
};
