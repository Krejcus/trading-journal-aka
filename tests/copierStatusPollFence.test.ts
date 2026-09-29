import { describe, expect, it } from 'vitest';
import { CopierStatusAckFence, CopierStatusPollFence, shouldAcceptCopierStatus } from '../lib/copierStatusPollFence';

describe('CopierStatusPollFence', () => {
  it('odmítne status poll zahájený před nebo během potvrzované konfigurace', () => {
    const fence = new CopierStatusPollFence();
    const beforeWrite = fence.beginPoll();

    expect(fence.canAcceptPoll(beforeWrite)).toBe(true);
    expect(fence.beginMutation()).toBe(true);
    expect(fence.canAcceptPoll(beforeWrite)).toBe(false);

    const duringWrite = fence.beginPoll();
    expect(fence.canAcceptPoll(duringWrite)).toBe(false);

    fence.endMutation();
    expect(fence.canAcceptPoll(beforeWrite)).toBe(false);
    expect(fence.canAcceptPoll(duringWrite)).toBe(false);
    expect(fence.canAcceptPoll(fence.beginPoll())).toBe(true);
  });

  it('nepovolí souběžnou konfigurační mutaci', () => {
    const fence = new CopierStatusPollFence();
    expect(fence.beginMutation()).toBe(true);
    expect(fence.beginMutation()).toBe(false);
    fence.endMutation();
    expect(fence.beginMutation()).toBe(true);
  });
});

describe('copier status monotonic ordering', () => {
  const status = (startedAt: string, revision: number) => ({ startedAt, controller: { revision } });

  it('odmítne starší poll v témže běhu po novějším ACK', () => {
    const accepted = status('2026-09-28T18:00:00.000Z', 42);
    expect(shouldAcceptCopierStatus(status(accepted.startedAt, 41), accepted)).toBe(false);
    expect(shouldAcceptCopierStatus(status(accepted.startedAt, 42), accepted)).toBe(true);
    expect(shouldAcceptCopierStatus(status(accepted.startedAt, 43), accepted)).toBe(true);
  });

  it('novější restart workeru vyhraje i s revision od nuly', () => {
    const beforeRestart = status('2026-09-28T18:00:00.000Z', 9_000);
    expect(shouldAcceptCopierStatus(status('2026-09-28T18:01:00.000Z', 0), beforeRestart)).toBe(true);
    expect(shouldAcceptCopierStatus(status('2026-09-28T17:59:00.000Z', 99_999), beforeRestart)).toBe(false);
  });

  it('fail-closed odmítne kandidáta s neplatnou epochou', () => {
    expect(shouldAcceptCopierStatus(status('invalid', 2), null)).toBe(false);
    expect(shouldAcceptCopierStatus(status('invalid', 2), status('2026-09-28T18:00:00.000Z', 1))).toBe(false);
  });

  it('invalidatePolls zahodí poll zahájený před bezpečnostním příkazem, ale nic neblokuje', () => {
    const fence = new CopierStatusPollFence();
    const before = fence.beginPoll();
    fence.invalidatePolls();
    expect(fence.canAcceptPoll(before)).toBe(false);
    expect(fence.inFlight).toBe(false);
    expect(fence.beginMutation()).toBe(true);
    fence.endMutation();
    const after = fence.beginPoll();
    expect(fence.canAcceptPoll(after)).toBe(true);
  });
});

describe('copier ACK ordering', () => {
  it('nepřijme pozdě doručený ARM ACK po novějším kill ACK', () => {
    const fence = new CopierStatusAckFence();
    const armRequest = fence.beginRequest();
    const killRequest = fence.beginRequest();
    expect(fence.accept(killRequest)).toBe(true);
    expect(fence.accept(armRequest)).toBe(false);
  });
});
