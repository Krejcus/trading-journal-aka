import type { TradecopiaNotificationPreferences } from './tradecopiaNotificationPreferences';

export interface TradecopiaFastEvent {
  key: string;
  type: 'order_submitted' | 'trade_opened' | 'trade_closed' | 'copy_partial' | 'order_rejected' | 'connection_changed' | 'position_mismatch' | 'risk_alert';
  severity: 'info' | 'warning' | 'critical';
  occurredAt: string;
  symbol?: string;
  side?: string;
  quantity?: number;
  orderType?: string;
  price?: number | null;
  pnl?: number | null;
  firm?: string;
  connected?: boolean;
  reason?: string;
  groupName?: string | null;
  leaderName?: string | null;
  copiedAccountCount?: number;
  expectedAccountCount?: number;
  failedAccountCount?: number;
  accountNames?: string[];
  reasons?: string[];
  cushion?: number;
  drawdownFloor?: number;
  balance?: number;
}

export interface FormattedTradecopiaNotification { title: string; body: string; url: string }

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const number = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 });
const accountsLabel = (count: number) => count === 1 ? '1 účtu' : `${count} účtech`;

const commonLines = (event: TradecopiaFastEvent, preferences: TradecopiaNotificationPreferences): string[] => {
  const lines: string[] = [];
  if (event.symbol) {
    const qty = event.quantity ? ` · ${number.format(event.quantity)} kontrakt${event.quantity === 1 ? '' : 'y'}` : '';
    const price = event.price != null ? ` · ${number.format(event.price)}` : '';
    lines.push(`${event.symbol}${qty}${price}`);
  }
  if (event.leaderName) lines.push(`Leader: ${event.leaderName}`);
  if (preferences.includeAccountNames && event.accountNames?.length) {
    const visible = event.accountNames.slice(0, 3);
    lines.push(`${visible.join(', ')}${event.accountNames.length > visible.length ? ` +${event.accountNames.length - visible.length}` : ''}`);
  }
  return lines;
};

export function formatTradecopiaNotification(
  event: TradecopiaFastEvent,
  preferences: TradecopiaNotificationPreferences,
): FormattedTradecopiaNotification {
  const copied = Math.max(0, Number(event.copiedAccountCount || 0));
  const expected = Math.max(copied, Number(event.expectedAccountCount || copied || 1));
  const failed = Math.max(0, Number(event.failedAccountCount || expected - copied));
  const lines = commonLines(event, preferences);
  let title = '🔔 TradeCopia událost';

  switch (event.type) {
    case 'order_submitted':
      title = `📤 ${event.side || ''} objednávka zkopírována na ${accountsLabel(copied)}`.replace('  ', ' ');
      lines.unshift(`${event.orderType || 'Objednávka'} · ✅ ${copied}/${expected} přijato`);
      break;
    case 'trade_opened':
      title = `🟢 ${event.side || ''} ${event.symbol || ''} otevřen na ${accountsLabel(copied)}`.replace(/\s+/g, ' ').trim();
      lines.unshift(`✅ ${copied}/${expected} účtů synchronizováno`);
      break;
    case 'trade_closed':
      title = `${event.pnl != null && event.pnl < 0 ? '🔴' : '💰'} ${event.side || ''} ${event.symbol || ''} uzavřen na ${accountsLabel(copied)}`.replace(/\s+/g, ' ').trim();
      if (preferences.includePnl && event.pnl != null) lines.unshift(`Výsledek skupiny: ${event.pnl > 0 ? '+' : ''}${money.format(event.pnl)}`);
      lines.push(`✅ ${copied}/${expected} účtů uzavřeno`);
      break;
    case 'copy_partial':
      title = `⚠️ Obchod zkopírován jen na ${copied} z ${expected} účtů`;
      lines.unshift(`${event.side || ''} ${event.symbol || ''}`.trim());
      if (failed) lines.push(`❌ ${failed} účt${failed === 1 ? 'u' : 'ů'} čeká nebo selhalo`);
      break;
    case 'order_rejected':
      title = `🚫 Objednávka zamítnuta na ${failed || 1} účt${failed === 1 ? 'u' : 'ech'}`;
      lines.unshift(`${event.side || ''} ${event.symbol || ''} · ✅ ${copied}/${expected}`.trim());
      if (event.reasons?.length) lines.push(event.reasons.slice(0, 2).join(' · '));
      break;
    case 'connection_changed':
      title = event.connected ? `✅ ${event.firm || 'Prop účet'} je znovu online` : `🔌 ${event.firm || 'Prop účet'} se odpojil`;
      lines.unshift(event.connected ? `${expected} účtů je připojeno` : `Skupina nyní kopíruje na ${copied} z ${expected} účtů`);
      if (event.reason) lines.push(`Důvod: ${event.reason}`);
      break;
    case 'position_mismatch':
      title = `🚨 Nesoulad kopírování na ${failed || 1} účt${failed === 1 ? 'u' : 'ech'}`;
      lines.unshift(`${event.groupName || 'Kopírovací skupina'} · ✅ ${copied}/${expected} synchronizováno`);
      break;
    case 'risk_alert':
      title = Number(event.cushion) <= 0 ? '🛑 Drawdown limit dosažen' : '🟠 Účet se blíží drawdownu';
      if (event.cushion != null) lines.unshift(`Rezerva ${money.format(event.cushion)}`);
      if (event.drawdownFloor != null) lines.push(`Floor: ${money.format(event.drawdownFloor)}`);
      break;
  }

  return { title: title.slice(0, 120), body: lines.filter(Boolean).join('\n').slice(0, 500), url: '/?page=live' };
}
