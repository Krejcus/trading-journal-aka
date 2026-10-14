import type { Trade } from '../types';
import { tradeRMultiple } from '../utils/tradeRisk';
import {
  DAY_BIAS_LABEL, DAY_EXECUTION_LABEL, DAY_PHASE_LABEL, DAY_SESSIONS, DAY_SESSION_LABEL, DAY_VERDICT_LABEL, editedAt, notePhase, pragueClock, pragueDayKey,
  type DayJournal, type SessionWindows,
} from './dayJournal';
import { planChoiceOf, tradeTimeMs } from './weeklyReview';

/**
 * Deník dne jako text: pro AI kouče (kompaktně) a pro export (Markdown).
 * Čas „zapsáno“ je skutečný čas zápisu; fáze se z něj odvozuje.
 */

const clock = (iso: string) => pragueClock(Date.parse(iso));
const writtenLabel = (iso: string, day: string) => {
  const ms = Date.parse(iso);
  const other = pragueDayKey(ms) !== day;
  return `${pragueClock(ms)}${other ? ` (${pragueDayKey(ms)})` : ''}`;
};
const edited = (writtenAt: string, updatedAt: string, day: string) => {
  const at = editedAt(writtenAt, updatedAt);
  return at ? `, upraveno ${writtenLabel(at, day)}` : '';
};
const trim = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const PLAN_LABEL = { yes: 'podle plánu', partial: 'částečně', no: 'mimo plán' } as const;

/** Kompaktní řádky pro systémový prompt kouče (víc dnů). */
export function dayJournalCoachText(journals: readonly DayJournal[], windowsOf: (day: string) => SessionWindows, maxText = 300): string {
  const lines: string[] = [];
  for (const journal of [...journals].sort((a, b) => a.day.localeCompare(b.day))) {
    const windows = windowsOf(journal.day);
    const dayLines: string[] = [];
    for (const session of DAY_SESSIONS) {
      const prep = journal.preps[session];
      const close = journal.closes[session];
      if (!prep && !close) continue;
      const prepText = prep
        ? `příprava zapsána ${clock(prep.writtenAt)}${edited(prep.writtenAt, prep.savedAt, journal.day)} · bias ${prep.bias ? DAY_BIAS_LABEL[prep.bias] : '—'}${prep.scenario ? ` · ${trim(prep.scenario, maxText)}` : ''}${prep.rules.length ? ` · neobchoduju pokud: ${prep.rules.join(', ')}` : ''}`
        : 'bez přípravy';
      const closeText = close
        ? `uzavřeno ${clock(close.writtenAt)}${edited(close.writtenAt, close.closedAt, journal.day)} · exekuce ${close.execution ? DAY_EXECUTION_LABEL[close.execution].toLowerCase() : '—'}${close.summary ? ` · „${trim(close.summary, maxText * 2)}“` : ''}`
        : 'neuzavřeno';
      dayLines.push(`   · ${DAY_SESSION_LABEL[session]}: ${prepText} | ${closeText}`);
      const verdicts = close ? Object.entries(close.verdicts) : [];
      for (const [id, verdict] of verdicts) {
        const pin = journal.notes.find(note => note.id === id);
        if (pin) dayLines.push(`     plán „${trim(pin.text, 120)}“ → ${DAY_VERDICT_LABEL[verdict].toLowerCase()}`);
      }
    }
    for (const note of journal.notes) {
      const phase = DAY_PHASE_LABEL[notePhase(note, windows)];
      const anchor = note.time != null ? ` → ${pragueClock(note.time * 1000)}${note.price != null ? ` @ ${note.price}` : ''}` : '';
      dayLines.push(`   · pozn. zapsáno ${writtenLabel(note.writtenAt, journal.day)} [${phase}${note.voice ? ', hlasem' : ''}${note.origin === 'prep' ? ', z přípravy' : ''}${edited(note.writtenAt, note.updatedAt, journal.day)}]${anchor}: ${trim(note.text, maxText)}`);
    }
    if (dayLines.length) lines.push(`${journal.day}:`, ...dayLines);
  }
  return lines.join('\n');
}

/** Jeden den jako Markdown (export / sdílení s jiným AI). */
export function dayJournalMarkdown(journal: DayJournal, trades: readonly Trade[], windows: SessionWindows): string {
  const out: string[] = [`# Deník dne ${journal.day}`, ''];
  out.push('Čas „zapsáno“ = kdy jsem to skutečně napsal/nadiktoval. Fáze: příprava (před session) / živě / dopsáno zpětně.', '');
  for (const session of DAY_SESSIONS) {
    const prep = journal.preps[session];
    const close = journal.closes[session];
    out.push(`## ${DAY_SESSION_LABEL[session]} (${pragueClock(windows[session].start)}–${pragueClock(windows[session].end)})`, '');
    if (prep) {
      out.push(`**Příprava** · zapsáno ${clock(prep.writtenAt)}${edited(prep.writtenAt, prep.savedAt, journal.day).replace(', ', ' · ')}${prep.durationSec != null ? ` · ${prep.durationSec} s` : ''}`);
      out.push(`- Bias: ${prep.bias ? DAY_BIAS_LABEL[prep.bias] : '—'}`);
      if (prep.scenario) out.push(`- Scénář: ${prep.scenario}`);
      if (prep.rules.length) out.push(`- Neobchoduju, pokud: ${prep.rules.join(' · ')}`);
      out.push('');
    } else out.push('_Bez přípravy._', '');
    const sessionTrades = trades.filter(trade => { const at = tradeTimeMs(trade); const window = windows[session]; return at >= window.start && at < window.end; });
    if (sessionTrades.length) {
      out.push('**Obchody**', '');
      out.push('| Čas | Směr | P&L | R | Hodnocení |', '|---|---|---:|---:|---|');
      for (const trade of sessionTrades) {
        const r = tradeRMultiple(trade);
        const plan = planChoiceOf(trade);
        out.push(`| ${pragueClock(tradeTimeMs(trade))} | ${trade.direction} | ${Math.round(trade.pnl)} | ${r == null ? '—' : r.toFixed(2)} | ${plan ? PLAN_LABEL[plan] : 'neohodnoceno'} |`);
      }
      out.push('');
    }
    if (close) {
      out.push(`**Uzavření** · zapsáno ${clock(close.writtenAt)}${edited(close.writtenAt, close.closedAt, journal.day).replace(', ', ' · ')} · exekuce: ${close.execution ? DAY_EXECUTION_LABEL[close.execution] : '—'}`);
      if (close.summary) out.push('', `> ${close.summary.replace(/\n/g, '\n> ')}`);
      for (const [id, verdict] of Object.entries(close.verdicts)) {
        const pin = journal.notes.find(note => note.id === id);
        if (pin) out.push(`- Plán „${pin.text}“ → ${DAY_VERDICT_LABEL[verdict]}`);
      }
      out.push('');
    }
  }
  if (journal.notes.length) {
    out.push('## Poznámky', '', '| Zapsáno | Fáze | Session | Ukazuje na | Text |', '|---|---|---|---|---|');
    for (const note of journal.notes) {
      const anchor = note.time != null ? `${pragueClock(note.time * 1000)}${note.price != null ? ` @ ${note.price}` : ''}` : '—';
      out.push(`| ${writtenLabel(note.writtenAt, journal.day)}${edited(note.writtenAt, note.updatedAt, journal.day).replace(',', ' ·')} | ${DAY_PHASE_LABEL[notePhase(note, windows)]}${note.voice ? ' (hlasem)' : ''} | ${DAY_SESSION_LABEL[note.session]} | ${anchor} | ${note.text.replace(/\|/g, '/').replace(/\n/g, ' ')} |`);
    }
    out.push('');
  }
  return out.join('\n');
}
