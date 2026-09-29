import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { LocalCopierAgentInstallation } from '../lib/localCopierAgentProtocol';

export interface MacCopierInstallManifest extends LocalCopierAgentInstallation {}

const validate = (raw: Partial<MacCopierInstallManifest>): MacCopierInstallManifest => {
  const gitSha = String(raw.gitSha ?? '').trim().toLowerCase();
  const installedAt = String(raw.installedAt ?? '').trim();
  if (
    raw.version !== 1
    || !/^[0-9a-f]{40,64}$/.test(gitSha)
    || typeof raw.dirty !== 'boolean'
    || !Number.isFinite(Date.parse(installedAt))
  ) {
    throw new Error('Neplatný Mac copier install manifest');
  }
  return { version: 1, gitSha, dirty: raw.dirty, installedAt };
};

export async function loadMacCopierInstallManifest(path: string): Promise<MacCopierInstallManifest> {
  const raw = JSON.parse(await readFile(resolve(path), 'utf8')) as Partial<MacCopierInstallManifest>;
  return validate(raw);
}

export async function loadMacCopierInstallManifestBestEffort(
  path: string,
  onWarning: (message: string) => void = message => console.warn(message),
): Promise<MacCopierInstallManifest | undefined> {
  try {
    return await loadMacCopierInstallManifest(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    onWarning(`Mac copier provenance neznámá: install manifest nelze načíst (${detail})`);
    return undefined;
  }
}

export async function writeMacCopierInstallManifest(
  path: string,
  manifest: MacCopierInstallManifest,
): Promise<void> {
  const target = resolve(path);
  const validated = validate(manifest);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function assertMacCopierInstallNotDowngrade(options: {
  candidate: MacCopierInstallManifest;
  installed: MacCopierInstallManifest | null;
  allowDowngrade: boolean;
  /** true = první SHA je předek druhého SHA, false = není, null = nelze ověřit. */
  isAncestor: (ancestorSha: string, descendantSha: string) => Promise<boolean | null>;
}): Promise<void> {
  if (options.allowDowngrade) return;
  if (options.candidate.dirty || options.installed?.dirty) {
    throw new Error(
      'Candidate nebo nainstalovaný worker pochází z dirty stromu s necommitnutými změnami; '
      + 'instalace je bez přesné ancestry odmítnutá (pro vědomou výjimku použij --allow-downgrade)',
    );
  }
  if (!options.installed) return;
  if (options.candidate.gitSha === options.installed.gitSha) return;
  const containsInstalled = await options.isAncestor(
    options.installed.gitSha,
    options.candidate.gitSha,
  );
  if (containsInstalled === null) {
    throw new Error(
      `Nelze bezpečně ověřit git ancestry candidate ${options.candidate.gitSha} proti nainstalovanému ${options.installed.gitSha}; `
      + 'instalace zůstává odmítnutá (pro vědomou výjimku použij --allow-downgrade)',
    );
  }
  if (!containsInstalled) {
    throw new Error(
      `Candidate HEAD ${options.candidate.gitSha} neobsahuje nainstalovaný commit ${options.installed.gitSha}; `
      + 'downgrade nebo divergentní/rebase historie je odmítnutá '
      + '(pro vědomou výjimku použij --allow-downgrade)',
    );
  }
}
