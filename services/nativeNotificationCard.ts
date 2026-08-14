import { Directory, Filesystem } from '@capacitor/filesystem';

import type { TradecopiaFastEvent } from './tradecopiaNotificationFormatter';

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 675;
const ATTACHMENT_DIRECTORY = 'alphatrade-notifications';
const MAX_ATTACHMENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

function drawText(
  context: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  size: number,
  color: string,
  weight = 700,
): void {
  context.fillStyle = color;
  context.font = `${weight} ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.fillText(value, x, y);
}

function drawGrid(context: CanvasRenderingContext2D): void {
  context.strokeStyle = 'rgba(148,163,184,0.12)';
  context.lineWidth = 1;
  for (let row = 0; row <= 5; row += 1) {
    const y = 166 + row * 72;
    context.beginPath();
    context.moveTo(54, y);
    context.lineTo(1146, y);
    context.stroke();
  }
  for (let column = 0; column <= 8; column += 1) {
    const x = 54 + column * 136.5;
    context.beginPath();
    context.moveTo(x, 166);
    context.lineTo(x, 526);
    context.stroke();
  }
}

function drawCandles(context: CanvasRenderingContext2D, positive: boolean): void {
  const closes = [0.61, 0.56, 0.64, 0.52, 0.48, 0.55, 0.44, 0.38, 0.42, 0.33, 0.27, 0.31, 0.22, 0.18, 0.24, 0.15, 0.11, 0.08];
  const values = positive ? closes : closes.map(value => 0.7 - value * 0.55);
  values.forEach((value, index) => {
    const x = 80 + index * 58;
    const y = 182 + value * 320;
    const rising = positive ? index % 4 !== 0 : index % 3 === 0;
    const color = rising ? '#22c55e' : '#f43f5e';
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(x, y - 34);
    context.lineTo(x, y + 42);
    context.stroke();
    context.fillRect(x - 9, rising ? y - 18 : y - 2, 18, 27);
  });
}

export function renderTradeNotificationCard(event: TradecopiaFastEvent): string {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('iOS nedokázal vytvořit náhled obchodu.');

  const gradient = context.createLinearGradient(0, 0, CARD_WIDTH, CARD_HEIGHT);
  gradient.addColorStop(0, '#020617');
  gradient.addColorStop(1, '#0f172a');
  context.fillStyle = gradient;
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  context.fillStyle = '#111a31';
  context.beginPath();
  context.roundRect(36, 142, 1128, 414, 24);
  context.fill();
  drawGrid(context);
  drawCandles(context, Number(event.pnl ?? 1) >= 0);

  const symbol = event.symbol || 'MNQ';
  const side = event.side || 'LONG';
  const result = event.pnl == null
    ? (event.type === 'trade_opened' ? 'LIVE' : 'TEST')
    : `${event.pnl >= 0 ? '+' : ''}${usd.format(event.pnl)}`;
  const resultColor = Number(event.pnl ?? 1) >= 0 ? '#22c55e' : '#f43f5e';

  drawText(context, `${symbol} · ${side}`, 52, 72, 38, '#f8fafc', 800);
  context.textAlign = 'right';
  drawText(context, result, 1148, 72, 38, resultColor, 800);
  context.textAlign = 'left';
  drawText(context, 'ALPHATRADE · NATIVE TRADE PREVIEW', 52, 116, 20, '#60a5fa', 700);

  context.strokeStyle = '#3b82f6';
  context.lineWidth = 4;
  context.setLineDash([14, 10]);
  context.beginPath();
  context.moveTo(52, 445);
  context.lineTo(1148, 445);
  context.stroke();
  context.setLineDash([]);

  const accounts = Math.max(0, Number(event.copiedAccountCount || 0));
  const expected = Math.max(accounts, Number(event.expectedAccountCount || accounts || 1));
  const price = event.price == null ? 'MARKET' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(event.price);
  drawText(context, `PRICE ${price}   ·   ACCOUNTS ${accounts}/${expected}   ·   ${event.severity.toUpperCase()}`, 52, 612, 23, '#cbd5e1', 700);

  return canvas.toDataURL('image/png');
}

async function cleanupOldAttachments(now = Date.now()): Promise<void> {
  try {
    const listing = await Filesystem.readdir({ path: ATTACHMENT_DIRECTORY, directory: Directory.Cache });
    await Promise.all(listing.files
      .filter(file => file.type === 'file' && now - file.mtime > MAX_ATTACHMENT_AGE_MS)
      .map(file => Filesystem.deleteFile({
        path: `${ATTACHMENT_DIRECTORY}/${file.name}`,
        directory: Directory.Cache,
      }).catch(() => undefined)));
  } catch {
    // The directory does not exist before the first rich notification.
  }
}

export async function createTradeNotificationAttachment(event: TradecopiaFastEvent): Promise<string> {
  await cleanupOldAttachments();
  const dataUrl = renderTradeNotificationCard(event);
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const path = `${ATTACHMENT_DIRECTORY}/trade-${Date.now()}-${crypto.randomUUID()}.png`;
  const written = await Filesystem.writeFile({
    path,
    data: base64,
    directory: Directory.Cache,
    recursive: true,
  });
  return written.uri;
}
