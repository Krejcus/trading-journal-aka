import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileCopyGroupStore } from '../services/fileCopyGroupStore';
import {
  compareDurableGroupWithCli,
  copierPilotGroupPath,
  decideDurableGroupInstall,
  durableGroupReplacementBlockers,
  parseCopierFollowersFlag,
  replaceDurableGroupWithBackup,
  type CopierCliGroup,
  type DurableGroupReplacementStatus,
} from '../services/copierPilotGroup';
import { DEFAULT_COPY_GROUP_SAFETY, type CopyGroupConfig } from '../services/liveCopyTrading';

const durableGroup = (): CopyGroupConfig => ({
  id: 'durable-group',
  name: 'Autoritativní skupina',
  enabled: true,
  leaderAccountId: 11,
  followers: [
    { accountId: 33, mode: 'on-submit', multiplier: 2, maxContracts: 4 },
    { accountId: 22, mode: 'on-fill', multiplier: 1.5 },
  ],
  safety: { ...DEFAULT_COPY_GROUP_SAFETY, entryCooldownMinutes: 15 },
  localOnly: true,
});

const matchingCli = (): CopierCliGroup => ({
  leaderAccountId: 11,
  followers: [
    { accountId: 22, mode: 'on-submit', multiplier: 1.5 },
    { accountId: 33, mode: 'on-submit', multiplier: 2, maxContracts: 4 },
  ],
});

const fallbackGroup = (cli = matchingCli()): CopyGroupConfig => ({
  id: 'fallback',
  name: 'CLI fallback',
  enabled: true,
  leaderAccountId: cli.leaderAccountId,
  followers: cli.followers,
  localOnly: true,
});

const safeReplacementStatus = (): DurableGroupReplacementStatus => ({
  armed: false,
  groupFlat: true,
  workingOrderAccounts: [],
  stuckOutbox: false,
  stuckOperations: [],
});

describe('Mac copier durable group install guard', () => {
  it('sdílí stabilní connectionId-leader cestu a parser follower parametrů', () => {
    expect(copierPilotGroupPath('/tmp/copier', 'connection-1', 11))
      .toBe('/tmp/copier/connection-1-11.group.json');
    expect(parseCopierFollowersFlag('22@1.5,33@2@4', 11)).toEqual(matchingCli().followers);
  });

  it('porovná leadera a follower accountId + multiplier + maxContracts bez závislosti na pořadí nebo mode', () => {
    expect(compareDurableGroupWithCli(durableGroup(), matchingCli())).toMatchObject({ matches: true });
    expect(compareDurableGroupWithCli(durableGroup(), {
      ...matchingCli(),
      followers: matchingCli().followers.map(item => (
        item.accountId === 33 ? { ...item, maxContracts: 5 } : item
      )),
    })).toMatchObject({
      matches: false,
      durable: 'leader=11 followers=[22@1.5, 33@2@4]',
      cli: 'leader=11 followers=[22@1.5, 33@2@5]',
    });
  });

  it('při shodě pokračuje s durable skupinou a bez durable souboru použije CLI fallback', () => {
    expect(decideDurableGroupInstall({
      durableGroup: durableGroup(),
      cliGroup: matchingCli(),
      fallbackGroup: fallbackGroup(),
      strategy: 'require-match',
    })).toMatchObject({ action: 'match', group: { id: 'durable-group' } });
    expect(decideDurableGroupInstall({
      durableGroup: null,
      cliGroup: matchingCli(),
      fallbackGroup: fallbackGroup(),
      strategy: 'require-match',
    })).toMatchObject({ action: 'first-install', group: { id: 'fallback' } });
  });

  it('při rozdílu bez explicitního příznaku zastaví', () => {
    const cli = { ...matchingCli(), leaderAccountId: 44 };
    expect(() => decideDurableGroupInstall({
      durableGroup: durableGroup(),
      cliGroup: cli,
      fallbackGroup: fallbackGroup(cli),
      strategy: 'require-match',
    })).toThrow('CLI skupina se liší od autoritativní durable skupiny');
  });

  it('--adopt-durable-group ponechá durable skupinu a CLI jen jako fallback', () => {
    const cli = { ...matchingCli(), followers: [{ accountId: 99, mode: 'on-submit' as const, multiplier: 1 }] };
    expect(decideDurableGroupInstall({
      durableGroup: durableGroup(),
      cliGroup: cli,
      fallbackGroup: fallbackGroup(cli),
      strategy: 'adopt',
    })).toMatchObject({
      action: 'adopt',
      group: { id: 'durable-group', followers: [{ accountId: 33 }, { accountId: 22 }] },
      comparison: { matches: false },
    });
  });

  it('--replace-durable-group odmítne každou chybějící bezpečnostní podmínku', () => {
    const unsafeStatuses: Array<DurableGroupReplacementStatus | null> = [
      null,
      { ...safeReplacementStatus(), armed: true },
      { ...safeReplacementStatus(), groupFlat: false },
      { ...safeReplacementStatus(), workingOrderAccounts: [22] },
      { ...safeReplacementStatus(), stuckOutbox: true },
      { ...safeReplacementStatus(), stuckOperations: [{ key: 'unknown' }] },
    ];
    const cli = { ...matchingCli(), followers: [{ accountId: 99, mode: 'on-submit' as const, multiplier: 1 }] };
    for (const replacementStatus of unsafeStatuses) {
      expect(() => decideDurableGroupInstall({
        durableGroup: durableGroup(),
        cliGroup: cli,
        fallbackGroup: fallbackGroup(cli),
        strategy: 'replace',
        replacementStatus,
      })).toThrow('Durable skupinu nelze bezpečně přepsat');
    }
    expect(durableGroupReplacementBlockers(safeReplacementStatus())).toEqual([]);
  });

  it('--replace-durable-group v bezpečném stavu přepíše jen CLI topologii a zachová durable metadata', () => {
    const cli: CopierCliGroup = {
      leaderAccountId: 11,
      followers: [
        { accountId: 22, mode: 'on-submit', multiplier: 3, maxContracts: 6 },
        { accountId: 99, mode: 'on-submit', multiplier: 1 },
      ],
    };
    expect(decideDurableGroupInstall({
      durableGroup: durableGroup(),
      cliGroup: cli,
      fallbackGroup: fallbackGroup(cli),
      strategy: 'replace',
      replacementStatus: safeReplacementStatus(),
    })).toMatchObject({
      action: 'replace',
      group: {
        id: 'durable-group',
        name: 'Autoritativní skupina',
        safety: { entryCooldownMinutes: 15 },
        followers: [
          { accountId: 22, mode: 'on-fill', multiplier: 3, maxContracts: 6 },
          { accountId: 99, mode: 'on-submit', multiplier: 1 },
        ],
      },
    });
  });

  it('vytvoří nedotčenou .bak-<timestamp> zálohu před atomickým přepisem', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copier-install-group-'));
    const path = join(root, 'connection-1-11.group.json');
    const original = durableGroup();
    const replacement = { ...original, followers: [{ accountId: 99, mode: 'on-submit' as const, multiplier: 1 }] };
    await createFileCopyGroupStore(path).save(original);

    const backupPath = await replaceDurableGroupWithBackup({ path, group: replacement, timestamp: 1_777_777 });

    expect(backupPath).toBe(`${path}.bak-1777777`);
    expect(JSON.parse(await readFile(backupPath, 'utf8'))).toEqual(original);
    expect(await createFileCopyGroupStore(path).load()).toEqual(replacement);
  });
});
