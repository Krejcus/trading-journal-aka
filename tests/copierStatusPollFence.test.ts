import { describe, expect, it } from 'vitest';
import { CopierStatusPollFence } from '../lib/copierStatusPollFence';

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
