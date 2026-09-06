import { describe, it, expect, vi } from 'vitest';
import { createNativePrivacyController } from '../services/nativePrivacyController';

describe('native privacy lifecycle', () => {
  it('retries cancel → background → resume even though React remains locked', async () => {
    let generation = 0;
    const authenticate = vi.fn().mockResolvedValue(false);
    const controller = createNativePrivacyController({ read: async () => ({ enabled: true, generation }), authenticate });
    await controller.refresh();
    await controller.refresh(); // Same system prompt foreground: no loop.
    expect(authenticate).toHaveBeenCalledTimes(1);
    generation++;
    await controller.refresh();
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(controller.state).toMatchObject({ locked: true, busy: false });
    authenticate.mockResolvedValue(true);
    await controller.unlock();
    await controller.refresh();
    expect(controller.state.locked).toBe(false);
    expect(authenticate).toHaveBeenCalledTimes(3);
  });
  it('does not uncover a newer lock from a previous successful authentication', async () => {
    let generation = 0;
    let resolve!: (success: boolean) => void;
    const authenticate = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue(false);
    const controller = createNativePrivacyController({ read: async () => ({ enabled: true, generation }), authenticate });
    const first = controller.refresh();
    await Promise.resolve();
    generation = 1;
    await controller.refresh();
    resolve(true);
    await first;
    expect(controller.state.locked).toBe(true);
    expect(authenticate).toHaveBeenCalledTimes(2);
  });
  it('fails closed on unavailable native state and permits manual retry', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('bridge unavailable')).mockResolvedValue({ enabled: true, generation: 0 });
    const controller = createNativePrivacyController({ read, authenticate: async () => true });
    await controller.refresh();
    expect(controller.state).toMatchObject({ locked: true, error: true });
    await controller.unlock();
    expect(controller.state.locked).toBe(false);
  });
  it('retries the new lock when an older post-auth read arrives after the background refresh', async () => {
    let resolveOld!: (state: { enabled: boolean; generation: number }) => void;
    const read = vi.fn()
      .mockResolvedValueOnce({ enabled: true, generation: 0 })
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue({ enabled: true, generation: 1 });
    const authenticate = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const controller = createNativePrivacyController({ read, authenticate });
    const first = controller.refresh();
    await Promise.resolve(); await Promise.resolve();
    await controller.refresh(); // New native shield; authentication is still busy.
    resolveOld({ enabled: true, generation: 0 });
    await first;
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(controller.state).toMatchObject({ locked: true, busy: false });
  });
});
