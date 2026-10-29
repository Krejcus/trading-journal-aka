import { describe, expect, it } from 'vitest';
import {
  buildLeaderEntryPlaceCommand,
  isLeaderEntryPlaceCommand,
  leaderEntryPayloadHash,
  leaderEntryPlaceAsPreview,
  validateLeaderEntryPlace,
} from '../lib/leaderEntryPlace';
import type { LeaderEntryPreviewCommand } from '../lib/leaderEntryPreview';

const preview = (): LeaderEntryPreviewCommand => ({
  type: 'preview-leader-entry', groupId: 'g1', operationId: 'preview:abcdefgh1234', leaderAccountId: 100,
  symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 29_500, stopLoss: 29_480, takeProfit: 29_560,
  intent: { armedAt: 5, groupConfigHash: 'abcdefgh12345678', followerQuantities: [{ accountId: 200, quantity: 1 }] },
});

describe('fáze 1b: formát odeslání ručního vstupu', () => {
  it('odeslání nese stejné pole jako náhled, vlastní prefix a sedící otisk', () => {
    const command = buildLeaderEntryPlaceCommand(preview(), 'entry:abcdefgh1234');
    expect(command).toMatchObject({ type: 'place-leader-entry', operationId: 'entry:abcdefgh1234', price: 29_500 });
    expect(validateLeaderEntryPlace(JSON.parse(JSON.stringify(command)))).toEqual(command);
    expect(leaderEntryPayloadHash(command)).toBe(command.payloadHash);
    expect(leaderEntryPlaceAsPreview(command)).toEqual({ ...preview(), operationId: 'preview:abcdefgh1234' });
    expect(isLeaderEntryPlaceCommand({ type: 'copy-command', command })).toBe(true);
    expect(isLeaderEntryPlaceCommand({ type: 'copy-command', command: preview() })).toBe(false);
  });

  it('otisk nezávisí na pořadí klíčů, ale na každé hodnotě', () => {
    const command = buildLeaderEntryPlaceCommand(preview(), 'entry:abcdefgh1234');
    const reordered = Object.fromEntries(Object.entries(command).reverse());
    expect(leaderEntryPayloadHash(reordered as typeof command)).toBe(command.payloadHash);
    expect(leaderEntryPayloadHash({ ...command, takeProfit: 29_561 })).not.toBe(command.payloadHash);
  });

  it.each([
    ['náhledový prefix', (c: Record<string, unknown>) => ({ ...c, operationId: 'preview:abcdefgh1234' })],
    ['jiná cena se starým otiskem', (c: Record<string, unknown>) => ({ ...c, price: 29_400 })],
    ['cizí klíč', (c: Record<string, unknown>) => ({ ...c, extra: 1 })],
    ['chybí otisk', (c: Record<string, unknown>) => ({ ...c, payloadHash: undefined })],
    ['qty nad strop', (c: Record<string, unknown>) => ({ ...c, quantity: 51 })],
    ['cena mimo tick', (c: Record<string, unknown>) => ({ ...c, price: 29_500.1 })],
  ])('odmítne: %s', (_label, mutate) => {
    const command = buildLeaderEntryPlaceCommand(preview(), 'entry:abcdefgh1234') as unknown as Record<string, unknown>;
    expect(() => validateLeaderEntryPlace(mutate(command))).toThrow('invalid-relay-command-payload');
  });
});
