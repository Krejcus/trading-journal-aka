import React, { useRef } from 'react';
import type { TradovateRequestHealth } from '../lib/tradovateRequestControl';
import { BUDGET_NOTICE_INITIAL, stabilizeTradovateHealthNotices, tradovateRequestHealthDisplay, type BudgetNoticeMemory } from '../lib/tradovateRequestHealthDisplay';

export default function TradovateRequestHealthNotice({ rows, now, floating = false }: {
  rows: readonly TradovateRequestHealth[] | null | undefined; now: number; floating?: boolean;
}) {
  const memory = useRef<BudgetNoticeMemory>(BUDGET_NOTICE_INITIAL);
  const stable = stabilizeTradovateHealthNotices(tradovateRequestHealthDisplay(rows, now), memory.current, now);
  memory.current = stable.memory;
  const notices = stable.notices;
  if (!notices.length) return null;
  return <div className={floating ? 'pointer-events-none fixed left-3 right-3 z-[330] mx-auto max-w-[900px] space-y-1' : 'space-y-1'}
    style={floating ? { top: 'calc(env(safe-area-inset-top, 0px) + 64px)' } : undefined}>
    {notices.map(notice => <p key={notice.key} role="status" title={notice.title} data-tradovate-health={notice.tone}
      className={`rounded-md border px-3 py-2 text-xs font-semibold shadow-sm ${notice.tone === 'danger'
        ? 'border-rose-500/40 bg-[var(--bg-card)] text-rose-600' : 'border-amber-500/40 bg-[var(--bg-card)] text-amber-600'}`}>
      {notice.text}
    </p>)}
  </div>;
}
