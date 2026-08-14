import { beforeEach, describe, expect, it, vi } from 'vitest';

const readdir = vi.fn();
const deleteFile = vi.fn();
const writeFile = vi.fn();

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: { readdir, deleteFile, writeFile },
}));

function fakeCanvas() {
  const gradient = { addColorStop: vi.fn() };
  const context = {
    fillStyle: '',
    font: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    createLinearGradient: vi.fn(() => gradient),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    setLineDash: vi.fn(),
  };
  return {
    canvas: {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toDataURL: vi.fn(() => 'data:image/png;base64,QUxQSEFUUkFERQ=='),
    },
    context,
  };
}

describe('native rich notification card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readdir.mockRejectedValue(new Error('cache directory does not exist yet'));
    writeFile.mockResolvedValue({ uri: 'file:///native-cache/trade-preview.png' });
  });

  it('renders the 1200 x 675 trade preview and persists PNG base64 in iOS cache', async () => {
    const { canvas, context } = fakeCanvas();
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'fixed-uuid') });

    const { createTradeNotificationAttachment } = await import('../services/nativeNotificationCard');
    const uri = await createTradeNotificationAttachment({
      key: 'trade-closed',
      type: 'trade_closed',
      severity: 'info',
      occurredAt: '2026-08-13T12:00:00Z',
      symbol: 'MNQ',
      side: 'LONG',
      pnl: 428.5,
      price: 21858.75,
      copiedAccountCount: 13,
      expectedAccountCount: 13,
    });

    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(675);
    expect(context.fillText).toHaveBeenCalledWith('MNQ · LONG', 52, 72);
    expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({
      directory: 'CACHE',
      recursive: true,
      data: 'QUxQSEFUUkFERQ==',
      path: expect.stringMatching(/^alphatrade-notifications\/trade-\d+-fixed-uuid\.png$/),
    }));
    expect(uri).toBe('file:///native-cache/trade-preview.png');

    vi.unstubAllGlobals();
  });

  it('removes stale cached previews before writing the next attachment', async () => {
    const { canvas } = fakeCanvas();
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'next') });
    readdir.mockResolvedValue({
      files: [
        { name: 'old.png', type: 'file', mtime: 0 },
        { name: 'fresh.png', type: 'file', mtime: Date.now() },
      ],
    });
    deleteFile.mockResolvedValue(undefined);

    const { createTradeNotificationAttachment } = await import('../services/nativeNotificationCard');
    await createTradeNotificationAttachment({
      key: 'trade-opened',
      type: 'trade_opened',
      severity: 'info',
      occurredAt: '2026-08-13T12:00:00Z',
      symbol: 'MNQ',
      side: 'SHORT',
    });

    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith({
      path: 'alphatrade-notifications/old.png',
      directory: 'CACHE',
    });

    vi.unstubAllGlobals();
  });
});
