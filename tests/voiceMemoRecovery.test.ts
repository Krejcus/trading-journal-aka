import { describe, expect, it, vi } from 'vitest';
import { createVoiceMemoRecovery, exportVoiceMemo } from '../services/voiceMemoRecovery';
import { alphaTradeNativePlugin } from '../services/alphaTradeNativePlugin';

vi.mock('../utils/runtimeConfig', () => ({ isNativeBuild: true }));
vi.mock('../services/alphaTradeNativePlugin', () => ({ alphaTradeNativePlugin: { shareFile: vi.fn().mockResolvedValue({ completed: false }) } }));

describe('failed voice memo recovery', () => {
  it('retains exactly the same recording after failure and releases only after successful append', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mp4' });
    const transcribe = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(' saved text ');
    const append = vi.fn();
    const recovery = createVoiceMemoRecovery(transcribe, append);
    recovery.retain(blob);
    await expect(recovery.retry()).rejects.toThrow('offline');
    expect(recovery.blob).toBe(blob); expect(append).not.toHaveBeenCalled();
    await recovery.retry();
    expect(transcribe.mock.calls.map(call => call[0])).toEqual([blob, blob]);
    expect(append).toHaveBeenCalledExactlyOnceWith('saved text');
    expect(recovery.blob).toBeNull();
  });

  it('does not append a late transcript after discard, replacement or screen unmount', async () => {
    let resolve!: (text: string) => void;
    const append = vi.fn();
    const recovery = createVoiceMemoRecovery(() => new Promise(r => { resolve = r; }), append);
    recovery.retain(new Blob(['old']));
    const pending = recovery.retry();
    recovery.clear();
    const replacement = new Blob(['new']); recovery.retain(replacement);
    resolve('old transcript'); await pending;
    expect(append).not.toHaveBeenCalled(); expect(recovery.blob).toBe(replacement);
  });

  it('coalesces rapid retry clicks and keeps unrecognized recordings', async () => {
    let resolve!: (text: string) => void;
    const transcribe = vi.fn(() => new Promise<string>(r => { resolve = r; }));
    const recovery = createVoiceMemoRecovery(transcribe, vi.fn());
    const blob = new Blob(['silence']); recovery.retain(blob);
    const first = recovery.retry(); const second = recovery.retry();
    expect(first).toBe(second); expect(transcribe).toHaveBeenCalledOnce();
    resolve(''); await expect(first).rejects.toThrow('rozpoznat řeč');
    expect(recovery.blob).toBe(blob);
  });

  it('exports a native recording with its audio extension and keeps it after share cancellation', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mp4;codecs=mp4a.40.2' });
    const recovery = createVoiceMemoRecovery(vi.fn(), vi.fn()); recovery.retain(blob);
    await exportVoiceMemo(blob);
    expect(alphaTradeNativePlugin.shareFile).toHaveBeenCalledWith({ base64: 'YXVkaW8=', fileName: expect.stringMatching(/^alphatrade-memo-\d+\.m4a$/) });
    expect(recovery.blob).toBe(blob);
  });

  it('keeps oversized recordings available for export or explicit deletion', async () => {
    const blob = new Blob([new Uint8Array(3 * 1024 * 1024 + 1)], { type: 'audio/webm' });
    const recovery = createVoiceMemoRecovery(async () => { throw new Error('3 MB limit'); }, vi.fn());
    recovery.retain(blob);
    await expect(recovery.retry()).rejects.toThrow('3 MB limit');
    expect(recovery.blob).toBe(blob);
    recovery.clear(); expect(recovery.blob).toBeNull();
  });
});
