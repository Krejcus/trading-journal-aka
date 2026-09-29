import { describe, expect, it, vi } from 'vitest';
import { createCopierSocketRenewalCoordinator } from '../services/copierSocketRenewal';

describe('V6 planovani obnov socketu', () => {
  it('hard blocker nikdy neobejde pres DISARMED a po uvolneni obnovi jen jednu route', () => {
    let now = 0;
    const first = { renewSocket: vi.fn(() => true) };
    const second = { renewSocket: vi.fn(() => true) };
    const coordinator = createCopierSocketRenewalCoordinator({
      routes: [
        { broker: first, label: 'A' },
        { broker: second, label: 'B' },
      ],
      clock: () => now,
      renewAfterMs: 50,
      forceAfterMs: 70,
      staggerMs: 10,
    });

    now = 80;
    expect(coordinator.poll({ connected: true, groupFlat: false, blocker: 'auto-close' })).toBeNull();
    expect(first.renewSocket).not.toHaveBeenCalled();
    expect(second.renewSocket).not.toHaveBeenCalled();

    const firstResult = coordinator.poll({ connected: true, groupFlat: false, blocker: null });
    expect(firstResult).toMatchObject({ label: 'A', forced: true });
    expect(first.renewSocket).toHaveBeenCalledTimes(1);
    expect(second.renewSocket).not.toHaveBeenCalled();

    now = 85;
    expect(coordinator.poll({ connected: true, groupFlat: false, blocker: null })).toBeNull();
    expect(second.renewSocket).not.toHaveBeenCalled();

    now = 90;
    expect(coordinator.poll({ connected: true, groupFlat: false, blocker: null }))
      .toMatchObject({ label: 'B', forced: true });
    expect(second.renewSocket).toHaveBeenCalledTimes(1);
  });

  it('pred force stropem odlozi obnovu po dobu otevrene pozice', () => {
    let now = 0;
    const broker = { renewSocket: vi.fn(() => true) };
    const coordinator = createCopierSocketRenewalCoordinator({
      routes: [{ broker, label: 'A' }], clock: () => now,
      renewAfterMs: 50, forceAfterMs: 70, staggerMs: 10,
    });

    now = 60;
    expect(coordinator.poll({ connected: true, groupFlat: false, blocker: null })).toBeNull();
    expect(broker.renewSocket).not.toHaveBeenCalled();
    now = 70;
    expect(coordinator.poll({ connected: true, groupFlat: false, blocker: null }))
      .toMatchObject({ forced: true });
  });
});
