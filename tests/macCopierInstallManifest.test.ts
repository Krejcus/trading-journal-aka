import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertMacCopierInstallNotDowngrade,
  loadMacCopierInstallManifest,
  writeMacCopierInstallManifest,
  type MacCopierInstallManifest,
} from '../server/macCopierInstallManifest';

const candidate = (gitSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'): MacCopierInstallManifest => ({
  version: 1,
  gitSha,
  dirty: true,
  installedAt: '2026-09-29T10:00:00.000Z',
});

describe('Mac copier install provenance', () => {
  it('durable ukládá plný git SHA, dirty příznak a čas instalace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-copier-install-'));
    const path = join(root, 'install-manifest.json');
    const provenance = candidate();

    await writeMacCopierInstallManifest(path, provenance);

    await expect(loadMacCopierInstallManifest(path)).resolves.toEqual(provenance);
  });

  it('odmítne starší candidate HEAD a při neověřitelné ancestry zůstane fail-closed', async () => {
    const installed = candidate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const isAncestor = vi.fn(async () => true);

    await expect(assertMacCopierInstallNotDowngrade({
      candidate: candidate(), installed, allowDowngrade: false, isAncestor,
    })).rejects.toThrow(/starší|downgrade/i);
    expect(isAncestor).toHaveBeenCalledWith(candidate().gitSha, installed.gitSha);

    await expect(assertMacCopierInstallNotDowngrade({
      candidate: candidate(),
      installed,
      allowDowngrade: false,
      isAncestor: async () => null,
    })).rejects.toThrow(/nelze bezpečně ověřit/i);
  });

  it('shodný SHA projde bez ancestry dotazu a explicitní --allow-downgrade povolí starší strom', async () => {
    const same = candidate();
    const isAncestor = vi.fn(async () => true);
    await expect(assertMacCopierInstallNotDowngrade({
      candidate: same, installed: same, allowDowngrade: false, isAncestor,
    })).resolves.toBeUndefined();
    expect(isAncestor).not.toHaveBeenCalled();

    await expect(assertMacCopierInstallNotDowngrade({
      candidate: candidate(), installed: candidate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      allowDowngrade: true, isAncestor,
    })).resolves.toBeUndefined();
  });
});
