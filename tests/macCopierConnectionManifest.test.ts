import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadMacCopierConnectionManifest,
  upsertMacCopierConnectionManifest,
} from '../server/macCopierConnectionManifest';

describe('Mac copier connection manifest', () => {
  it('resolves paths and puts the primary relay connection first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-manifest-'));
    const path = join(root, 'connections.json');
    await writeFile(path, JSON.stringify({
      version: 1,
      primaryConnectionId: 'second',
      connections: [
        { connectionId: 'first', accountIds: [11], deviceConfigPath: 'first/device.json' },
        { connectionId: 'second', accountIds: [22], deviceConfigPath: 'second/device.json', leasePath: 'second/lease.json' },
      ],
    }));
    const manifest = await loadMacCopierConnectionManifest(path);
    expect(manifest.connections.map(item => item.connectionId)).toEqual(['second', 'first']);
    expect(manifest.connections[0].deviceConfigPath).toBe(join(root, 'second/device.json'));
    expect(manifest.connections[0].leasePath).toBe(join(root, 'second/lease.json'));
  });

  it('rejects overlapping account ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-manifest-'));
    const path = join(root, 'connections.json');
    await writeFile(path, JSON.stringify({
      version: 1,
      primaryConnectionId: 'first',
      connections: [
        { connectionId: 'first', accountIds: [11], deviceConfigPath: 'first.json' },
        { connectionId: 'second', accountIds: [11], deviceConfigPath: 'second.json' },
      ],
    }));
    await expect(loadMacCopierConnectionManifest(path)).rejects.toThrow('patří v manifestu více OAuth');
  });

  it('atomically builds a multi-OAuth manifest and preserves its primary connection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-manifest-'));
    const path = join(root, 'connections.json');
    await upsertMacCopierConnectionManifest({
      path,
      connection: { connectionId: 'first', accountIds: [11, 12], deviceConfigPath: join(root, 'first/device.json') },
    });
    const manifest = await upsertMacCopierConnectionManifest({
      path,
      connection: { connectionId: 'second', accountIds: [22], deviceConfigPath: join(root, 'second/device.json') },
    });
    expect(manifest.primaryConnectionId).toBe('first');
    expect(manifest.connections.map(item => item.connectionId)).toEqual(['first', 'second']);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1, primaryConnectionId: 'first' });
  });

  it('fails closed instead of assigning one account to two OAuth identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-manifest-'));
    const path = join(root, 'connections.json');
    await upsertMacCopierConnectionManifest({
      path,
      connection: { connectionId: 'first', accountIds: [11], deviceConfigPath: join(root, 'first/device.json') },
    });
    await expect(upsertMacCopierConnectionManifest({
      path,
      connection: { connectionId: 'second', accountIds: [11], deviceConfigPath: join(root, 'second/device.json') },
    })).rejects.toThrow('patří v manifestu více OAuth');
    expect((await loadMacCopierConnectionManifest(path)).connections).toHaveLength(1);
  });
});
