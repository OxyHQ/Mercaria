import { expect, test } from 'vitest';
import { createCommerceCredential, type CredentialStorage } from '../commerce-credential';

const expiry = new Date(Date.now() + 86_400_000).toISOString();
function memory(initial: string | null = null) {
  let value = initial;
  const storage: CredentialStorage = {
    read: async () => value,
    write: async (next) => {
      value = next;
    },
    remove: async () => {
      value = null;
    },
  };
  return { storage, read: () => value };
}

test('hydration cannot resurrect after explicit clear; deletion follows the initial read', async () => {
  const disk = memory('mgs_old');
  let resolve!: (value: string | null) => void;
  disk.storage.read = () =>
    new Promise((done) => {
      resolve = done;
    });
  const credential = createCommerceCredential(disk.storage);
  credential.clear();
  resolve('mgs_old');
  await credential.ready;
  await credential.settled();
  expect(credential.current().token).toBeNull();
  expect(disk.read()).toBeNull();
});

test('serialized persistence cannot finish an old write after a later revocation', async () => {
  const disk = memory();
  let release!: () => void;
  let started!: () => void;
  const writing = new Promise<void>((done) => {
    started = done;
  });
  const original = disk.storage.write;
  disk.storage.write = async (value) => {
    started();
    await new Promise<void>((done) => {
      release = done;
    });
    await original(value);
  };
  const credential = createCommerceCredential(disk.storage);
  await credential.ready;
  credential.snapshot().accept('mgs_first', expiry, '1');
  await writing;
  const stale = credential.snapshot();
  credential.clear();
  stale.accept('mgs_late', expiry, '2');
  release();
  await credential.settled();
  expect(credential.current().token).toBeNull();
  expect(disk.read()).toBeNull();
});

test('separate portal issuance rejects an older response; expiry and generation are checked', async () => {
  const disk = memory();
  const credential = createCommerceCredential(disk.storage);
  await credential.ready;
  const first = credential.snapshot();
  const second = credential.snapshot();
  second.accept('mgp_groupB', expiry, '20');
  first.accept('mgp_groupA', expiry, '30');
  credential.snapshot().accept('mgp_older', expiry, '19');
  credential.snapshot().accept('mgp_expired', new Date(0).toISOString(), '21');
  expect(credential.current().token).toBe('mgp_groupB');
  await credential.settled();
  expect(JSON.parse(disk.read() ?? 'null').token).toBe('mgp_groupB');
});

test('native opaque credentials survive hydration; a failed write is never acknowledged as durable', async () => {
  const disk = memory('mgp_native');
  disk.storage.write = async () => {
    throw new Error('storage unavailable');
  };
  const credential = createCommerceCredential(disk.storage);
  await credential.ready;
  expect(credential.current().token).toBe('mgp_native');
  credential.snapshot().accept('mgp_rotated', expiry, '2');
  expect(await credential.persisted()).toBe(false);
  expect(credential.store.getState().storageAvailable).toBe(false);
  expect(disk.read()).toBe('mgp_native');
});

test('restored expiry is enforced before any request', async () => {
  const disk = memory(JSON.stringify({ token: 'mgs_expired', expiresAt: 50, generation: 1 }));
  const credential = createCommerceCredential(disk.storage, () => 100);
  await credential.ready;
  await credential.settled();
  expect(credential.current().token).toBeNull();
  expect(disk.read()).toBeNull();
});
