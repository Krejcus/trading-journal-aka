import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/supabase', () => ({ supabase: {} }));

import { LocalCopierAgentCommandError } from '../lib/localCopierAgentProtocol';
import {
  TradingViewRestartUnavailableError, restartTradingView, tradingViewRestartErrorText, tradingViewRestartOutcomeText, type TradingViewRestartDeps,
} from '../services/tradingViewRestart';

const health = (state: string, cdpReachable = state === 'ready') => ({ snapshotHealth: { state, cdpReachable } }) as never;
const ok = { status: {} } as never;
const COMMAND = { type: 'snapshot-test', requestId: 'req-1', repairCamera: true };

function relayDeps(after: unknown[], patch: Partial<TradingViewRestartDeps> = {}) {
  let sent = false;
  let clock = 0;
  const queue = [...after];
  const d: TradingViewRestartDeps = {
    canUseLocal: false,
    local: { status: vi.fn(async () => health('cdp-offline')), execute: vi.fn(async () => ok) },
    connectedConnectionIds: vi.fn(async () => ['a', 'b']),
    relayStatus: vi.fn(async (id: string) => (id !== 'b'
      ? { connected: false }
      : { connected: true, status: sent ? (queue.length > 1 ? queue.shift() : queue[0]) as never : health('cdp-offline') })),
    relayExecute: vi.fn(async () => { sent = true; return ok; }),
    newRequestId: () => 'req-1',
    sleep: vi.fn(async (ms: number) => { clock += ms; }),
    now: () => clock,
    ...patch,
  };
  return d;
}

describe('restartTradingView', () => {
  it('na dálku jde přes relay na spojení s připojeným workerem a „hotovo“ až podle stavu snímků', async () => {
    const d = relayDeps([health('checking'), health('ready')]);
    await expect(restartTradingView(d)).resolves.toEqual({ kind: 'ready', route: 'relay' });
    expect(d.relayExecute).toHaveBeenCalledTimes(1);
    expect(d.relayExecute).toHaveBeenCalledWith('b', COMMAND);
    expect(d.local.execute).not.toHaveBeenCalled();
  });

  it('přijatý příkaz neznamená restart: bez připojení v limitu vrátí not-ready', async () => {
    const d = relayDeps([health('checking')]);
    await expect(restartTradingView(d)).resolves.toMatchObject({ kind: 'not-ready', state: 'checking' });
    const failed = relayDeps([health('cdp-offline')]);
    await expect(restartTradingView(failed)).resolves.toMatchObject({ kind: 'not-ready', state: 'cdp-offline' });
  });

  it('TradingView už s CDP neřestartuje (problém je v grafu)', async () => {
    const d = relayDeps([health('ready')], { relayStatus: vi.fn(async (id: string) => (id === 'b' ? { connected: true, status: health('ready') } : { connected: false })) });
    await expect(restartTradingView(d)).resolves.toEqual({ kind: 'already-connected', route: 'relay' });
    expect(d.relayExecute).not.toHaveBeenCalled();
  });

  it('na Macu jde přímo na lokální worker', async () => {
    let sent = false;
    const d = relayDeps([], {
      canUseLocal: true,
      local: { status: vi.fn(async () => (sent ? health('ready') : health('cdp-offline'))), execute: vi.fn(async () => { sent = true; return ok; }) },
    });
    await expect(restartTradingView(d)).resolves.toEqual({ kind: 'ready', route: 'local' });
    expect(d.local.execute).toHaveBeenCalledWith(COMMAND);
    expect(d.relayExecute).not.toHaveBeenCalled();
  });

  it('nedostupný lokální worker → relay; odmítnutí workerem se nezkouší druhou cestou', async () => {
    const unreachable = relayDeps([health('ready')], { canUseLocal: true, local: { status: vi.fn(async () => { throw new Error('fetch failed'); }), execute: vi.fn() } });
    await expect(restartTradingView(unreachable)).resolves.toMatchObject({ route: 'relay' });
    const rejectedLocal = relayDeps([], { canUseLocal: true, local: { status: vi.fn(async () => health('cdp-offline')), execute: vi.fn(async () => { throw new Error('… DISARMED a flat workeru'); }) } });
    await expect(restartTradingView(rejectedLocal)).rejects.toThrow('DISARMED');
    expect(rejectedLocal.relayExecute).not.toHaveBeenCalled();
    const rejectedRelay = relayDeps([], {
      connectedConnectionIds: vi.fn(async () => ['b', 'c']),
      relayStatus: vi.fn(async () => ({ connected: true, status: health('cdp-offline') })),
      relayExecute: vi.fn(async () => { throw new Error('Mac worker příkaz včas nepotvrdil'); }),
    });
    await expect(restartTradingView(rejectedRelay)).rejects.toThrow('včas nepotvrdil');
    expect(rejectedRelay.relayExecute).toHaveBeenCalledTimes(1);
  });

  it('chyba čtení na jednom spojení zkusí další; síťová chyba se nevydává za odpojený worker', async () => {
    const d = relayDeps([health('ready')], {
      relayStatus: vi.fn(async (id: string) => { if (id === 'a') throw new Error('network'); return { connected: true, status: health('cdp-offline') }; }),
    });
    await expect(restartTradingView(d)).resolves.toMatchObject({ route: 'relay' });
    const offline = relayDeps([], { relayStatus: vi.fn(async () => { throw new Error('401 Unauthorized'); }) });
    await expect(restartTradingView(offline)).rejects.toThrow('401');
    const none = relayDeps([], { relayStatus: vi.fn(async () => ({ connected: false })) });
    await expect(restartTradingView(none)).rejects.toBeInstanceOf(TradingViewRestartUnavailableError);
    expect(none.relayExecute).not.toHaveBeenCalled();
    const noConnections = relayDeps([], { connectedConnectionIds: vi.fn(async () => { throw new Error('oauth down'); }) });
    await expect(restartTradingView(noConnections)).rejects.toThrow('oauth down');
  });
});

describe('hlášky', () => {
  it('strukturované blokery workeru mají přednost před obecnou větou', () => {
    const blocked = new LocalCopierAgentCommandError('TradingView lze obnovit pouze při … DISARMED a flat workeru', {
      code: 'snapshot-repair-blocked', blockers: ['reconciliation-required'],
    } as never);
    expect(tradingViewRestartErrorText(blocked)).toMatch(/^Obnova snímků blokována/);
    expect(tradingViewRestartErrorText(new Error('TradingView lze obnovit pouze při připojeném, reconciled, DISARMED a flat workeru bez pracovních příkazů.'))).toMatch(/vypnuté a zkontrolované kopírce/);
    expect(tradingViewRestartErrorText(new Error('snapshot-test-already-running'))).toMatch(/už běží/);
    expect(tradingViewRestartErrorText(new Error('Localhost je pro Tradovate pouze read-only.'))).toMatch(/port 3000/);
  });
  it('výsledek: jen ready je úspěch', () => {
    expect(tradingViewRestartOutcomeText({ kind: 'ready', route: 'relay' }).ok).toBe(true);
    expect(tradingViewRestartOutcomeText({ kind: 'already-connected', route: 'relay' })).toMatchObject({ ok: false, text: expect.stringMatching(/1m graf MNQ/) });
    expect(tradingViewRestartOutcomeText({ kind: 'not-ready', route: 'local', state: 'cdp-offline' })).toMatchObject({ ok: false, text: expect.stringMatching(/přijal/) });
  });
});
