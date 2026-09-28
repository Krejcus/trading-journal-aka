import { describe, expect, it, vi } from 'vitest';
import { newestCopierRelaySnapshot, startCopierRelayStatusPoll } from '../lib/copierRelayStatusPoll';

const remote = (name: string, connected = true, lastSeenAt = '2026-09-28T18:00:00.000Z') => ({
  status: name,
  lastSeenAt,
  connected,
});

describe('copier relay status poll', () => {
  it('publishes the first connected worker without waiting for the slowest connection', async () => {
    let finishSlow!: (value: ReturnType<typeof remote>) => void;
    const slow = new Promise<ReturnType<typeof remote>>(resolve => { finishSlow = resolve; });
    const load = vi.fn((connectionId: string) => connectionId === 'slow'
      ? slow
      : Promise.resolve(remote('fast')));
    const poll = startCopierRelayStatusPoll(['slow', 'fast'], null, load);

    await expect(poll.firstConnected).resolves.toMatchObject({ connectionId: 'fast', remote: { status: 'fast' } });
    let allSettled = false;
    void poll.settled.then(() => { allSettled = true; });
    await Promise.resolve();
    expect(allSettled).toBe(false);

    finishSlow(remote('slow'));
    await expect(poll.settled).resolves.toHaveLength(2);
  });

  it('starts the last used connection first and keeps rejected peers out of settled candidates', async () => {
    const calls: string[] = [];
    const poll = startCopierRelayStatusPoll(['other', 'preferred'], 'preferred', async connectionId => {
      calls.push(connectionId);
      if (connectionId === 'other') throw new Error('offline');
      return remote('preferred');
    });
    await expect(poll.firstConnected).resolves.toMatchObject({ connectionId: 'preferred' });
    await expect(poll.settled).resolves.toHaveLength(1);
    expect(calls).toEqual(['preferred', 'other']);
  });

  it('selects the newest retained snapshot, using the last route as an equal-time tie breaker', () => {
    const candidates = [
      { connectionId: 'other', remote: remote('other', false, '2026-09-28T18:00:01.000Z') },
      { connectionId: 'preferred', remote: remote('preferred', false, '2026-09-28T18:00:01.000Z') },
    ];
    expect(newestCopierRelaySnapshot(candidates, 'preferred')?.connectionId).toBe('preferred');
  });
});
