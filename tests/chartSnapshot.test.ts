import { describe, expect, it, vi } from 'vitest';
import { toPng } from 'html-to-image';
import {
  captureChartSnapshotDataUrl,
  captureChartWorkspaceSnapshotDataUrl,
} from '../services/chartSnapshot';

vi.mock('html-to-image', () => ({ toPng: vi.fn() }));

describe('captureChartSnapshotDataUrl', () => {
  it('captures the active chart with primitives and returns a PNG preview', () => {
    const toDataURL = vi.fn(() => 'data:image/png;base64,preview');
    const takeScreenshot = vi.fn(() => ({ toDataURL }));
    const api = {
      controller: { getChart: () => ({ takeScreenshot }) },
    } as any;

    expect(captureChartSnapshotDataUrl(api)).toBe('data:image/png;base64,preview');
    expect(takeScreenshot).toHaveBeenCalledWith(true, false);
    expect(toDataURL).toHaveBeenCalledWith('image/png');
  });

  it('merges the visible execution overlay into the saved image', () => {
    const chartCanvas = { width: 1200, height: 700, toDataURL: vi.fn() };
    const executionOverlay = { width: 1200, height: 700 } as HTMLCanvasElement;
    const drawImage = vi.fn();
    const output = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toDataURL: vi.fn(() => 'data:image/png;base64,composited'),
    };
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: vi.fn(() => output) },
    });
    try {
      const api = {
        controller: { getChart: () => ({ takeScreenshot: () => chartCanvas }) },
      } as any;
      expect(captureChartSnapshotDataUrl(api, executionOverlay)).toBe('data:image/png;base64,composited');
      expect(drawImage).toHaveBeenNthCalledWith(1, chartCanvas, 0, 0);
      expect(drawImage).toHaveBeenNthCalledWith(2, executionOverlay, 0, 0, 1200, 700);
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    }
  });

  it('captures the complete visible workspace instead of one active panel', async () => {
    vi.mocked(toPng).mockResolvedValueOnce('data:image/png;base64,workspace');
    const workspace = {} as HTMLElement;

    await expect(captureChartWorkspaceSnapshotDataUrl(workspace, true)).resolves.toBe('data:image/png;base64,workspace');
    expect(toPng).toHaveBeenCalledWith(workspace, expect.objectContaining({
      backgroundColor: '#070a0f',
      cacheBust: false,
      skipAutoScale: true,
      skipFonts: true,
    }));
  });
});
