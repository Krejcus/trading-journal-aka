import React from 'react';
import type { ChartDataQuality } from '../lib/chartDataQuality';

const time = (at: number | null) => at == null ? 'neznámý' : new Date(at).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Always visible, including when the order ticket is hidden. Display evidence only. */
export default function ChartDataStatus({ quality }: { quality: ChartDataQuality }) {
  return <details className={`shrink-0 border-b px-3 py-1.5 text-[11px] ${quality.tone === 'warn' ? 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-300' : 'border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-secondary)]'}`} aria-label="Stav svíček">
    <summary className="cursor-pointer"><span className="font-bold">{quality.title}</span><span className="ml-2">Poslední svíčka {time(quality.lastCandleAt)} · {quality.source}</span><span className="ml-2 opacity-70">Podrobnosti</span></summary>
    <div className="space-y-1 pb-1 pt-2 leading-relaxed">
      {quality.reasons.map(reason => <p className="m-0" key={reason}>{reason}</p>)}
      {quality.capturedAt != null && <p className="m-0">Snapshot pořízen {time(quality.capturedAt)}.</p>}
      <p className="m-0 opacity-80">Běžný rozvrh NQ/MNQ vynechává denní pauzu a víkend; svátky a mimořádné uzavírky nejsou ověřené. Aktuální svíčka se ještě mění a živé cenové ticky nedodávají úplný objem.</p>
      <p className="m-0 opacity-80">Historie a živá cena mohou pocházet z různých zdrojů. Kontinuální a konkrétní kontrakt se zejména při rolování mohou cenou lišit; chybějící minuty ani objem se nedají přesně dopočítat z poslední ceny.</p>
      <p className="m-0 opacity-80">Shoda konkrétního kontraktu historie a živého zdroje není nezávisle potvrzená. Při přechodu na další expiraci se jejich ceny mohou lišit.</p>
    </div>
  </details>;
}
