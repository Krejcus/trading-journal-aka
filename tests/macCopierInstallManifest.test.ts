import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertMacCopierInstallNotDowngrade,
  loadMacCopierInstallManifest,
  loadMacCopierInstallManifestBestEffort,
  writeMacCopierInstallManifest,
  type MacCopierInstallManifest,
} from '../server/macCopierInstallManifest';

const candidate = (gitSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'): MacCopierInstallManifest => ({
  version: 1,
  gitSha,
  dirty: true,
  installedAt: '2026-09-29T10:00:00.000Z',
});
const cleanCandidate = (gitSha?: string): MacCopierInstallManifest => ({
  ...candidate(gitSha),
  dirty: false,
});

describe('Mac copier install provenance', () => {
  it('durable ukládá plný git SHA, dirty příznak a čas instalace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-copier-install-'));
    const path = join(root, 'install-manifest.json');
    const provenance = candidate();

    await writeMacCopierInstallManifest(path, provenance);

    await expect(loadMacCopierInstallManifest(path)).resolves.toEqual(provenance);
  });

  it('povolí jen candidate, který obsahuje nainstalovaný commit; downgrade i divergence odmítne', async () => {
    const installed = cleanCandidate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const isAncestor = vi.fn(async () => true);

    await expect(assertMacCopierInstallNotDowngrade({
      candidate: cleanCandidate(), installed, allowDowngrade: false, isAncestor,
    })).resolves.toBeUndefined();
    expect(isAncestor).toHaveBeenCalledWith(installed.gitSha, cleanCandidate().gitSha);

    await expect(assertMacCopierInstallNotDowngrade({
      candidate: cleanCandidate(), installed, allowDowngrade: false, isAncestor: async () => false,
    })).rejects.toThrow(/neobsahuje|divergent|downgrade/i);

    await expect(assertMacCopierInstallNotDowngrade({
      candidate: cleanCandidate(),
      installed,
      allowDowngrade: false,
      isAncestor: async () => null,
    })).rejects.toThrow(/nelze bezpečně ověřit/i);
  });

  it('dirty candidate i dirty nainstalovaný worker vyžadují explicitní --allow-downgrade', async () => {
    const clean = cleanCandidate();
    await expect(assertMacCopierInstallNotDowngrade({
      candidate: candidate(), installed: null, allowDowngrade: false, isAncestor: async () => true,
    })).rejects.toThrow(/dirty|necommitnut/i);
    await expect(assertMacCopierInstallNotDowngrade({
      candidate: clean, installed: candidate(), allowDowngrade: false, isAncestor: async () => true,
    })).rejects.toThrow(/dirty|necommitnut/i);
    await expect(assertMacCopierInstallNotDowngrade({
      candidate: candidate(), installed: candidate(), allowDowngrade: true, isAncestor: async () => false,
    })).resolves.toBeUndefined();
  });

  it('worker načte chybějící nebo poškozený manifest best-effort a ohlásí neznámou provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-copier-install-best-effort-'));
    const warnings: string[] = [];
    await expect(loadMacCopierInstallManifestBestEffort(
      join(root, 'missing.json'),
      warning => warnings.push(warning),
    )).resolves.toBeUndefined();
    await writeFile(join(root, 'broken.json'), '{broken', 'utf8');
    await expect(loadMacCopierInstallManifestBestEffort(
      join(root, 'broken.json'),
      warning => warnings.push(warning),
    )).resolves.toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(warnings.every(warning => /provenance neznámá/i.test(warning))).toBe(true);
  });

  it('shodný SHA projde bez ancestry dotazu a explicitní --allow-downgrade povolí starší strom', async () => {
    const same = cleanCandidate();
    const isAncestor = vi.fn(async () => true);
    await expect(assertMacCopierInstallNotDowngrade({
      candidate: same, installed: same, allowDowngrade: false, isAncestor,
    })).resolves.toBeUndefined();
    expect(isAncestor).not.toHaveBeenCalled();

    await expect(assertMacCopierInstallNotDowngrade({
      candidate: cleanCandidate(), installed: cleanCandidate('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      allowDowngrade: true, isAncestor,
    })).resolves.toBeUndefined();
  });
});
