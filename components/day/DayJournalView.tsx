import React, { useEffect, useMemo, useState } from 'react';
import type { SessionConfig, Trade } from '../../types';
import { sessionWindows } from '../../lib/dayJournal';
import { dayStreak, tradingDaysBack } from '../../lib/dayJournalView';
import { useDayJournalRange } from '../../hooks/useDayJournal';
import DayDesktop from './DayDesktop';
import DayPhone from './DayPhone';
import { useDayController } from './useDayController';
import './dayJournal.css';

const PHONE_QUERY = '(max-width: 1023px)';
function useIsPhone() {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(PHONE_QUERY).matches === true);
  useEffect(() => {
    const media = window.matchMedia?.(PHONE_QUERY);
    if (!media) return;
    const update = () => setPhone(media.matches);
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  return phone;
}

/**
 * Deník dne: jeden graf dne se sessions, obchody a poznámkami s časem
 * zápisu; příprava a uzavření každé session; diktování čistým přepisem.
 * Nic odsud nezamyká ani neautorizuje copier.
 */
export default function DayJournalView({ trades, allTrades, sessions, isDark, initialDate, onUpdateTrade, onOpenTrade, onOpenLegacy, onOpenWeek, onOpenArchive, onOpenCoach, immersive = false }: {
  trades: readonly Trade[];
  allTrades: readonly Trade[];
  sessions: readonly SessionConfig[];
  isDark: boolean;
  initialDate?: string;
  onUpdateTrade: (id: string | number, updates: Partial<Trade>) => unknown;
  onOpenTrade?: (trade: Trade) => void;
  onOpenLegacy?: () => void;
  onOpenWeek?: () => void;
  onOpenArchive?: () => void;
  onOpenCoach?: () => void;
  /** Bez horní lišty appky — deník zabere celou výšku. */
  immersive?: boolean;
}) {
  const ctl = useDayController({ trades, allTrades, sessions, initialDate, onUpdateTrade });
  const phone = useIsPhone();

  // Řada posledních obchodních dnů; zvolený den bere živý stav deníku.
  const days = useMemo(() => tradingDaysBack(ctl.today, 10), [ctl.today]);
  const saves = Object.keys(ctl.journal.preps).length + Object.keys(ctl.journal.closes).length;
  const journals = useDayJournalRange(days, saves);
  const streak = useMemo(() => {
    const merged = new Map(journals);
    merged.set(ctl.day, ctl.journal);
    return dayStreak(days, merged, trades, day => sessionWindows(day, sessions), ctl.today);
  }, [ctl.day, ctl.journal, ctl.today, days, journals, sessions, trades]);

  if (phone) return <DayPhone ctl={ctl} isDark={isDark} streak={streak} onOpenTrade={onOpenTrade} />;
  return (
    <DayDesktop
      ctl={ctl}
      isDark={isDark}
      streak={streak}
      onOpenTrade={onOpenTrade}
      onOpenLegacy={onOpenLegacy}
      onOpenWeek={onOpenWeek}
      onOpenArchive={onOpenArchive}
      onOpenCoach={onOpenCoach}
      height={immersive ? 'calc(100dvh - 48px)' : 'calc(100dvh - 128px)'}
    />
  );
}
