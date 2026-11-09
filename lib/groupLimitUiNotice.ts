import type { LeaderOrderManageAction, LeaderOrderManageResult } from './leaderOrderManage';

/** Only the new group coordinator ACK proves all sealed members; unknown stays neutral. */
export function groupLimitOutcomeNotice(action: LeaderOrderManageAction, result: LeaderOrderManageResult, at: number) {
  if (result.status === 'acknowledged') {
    if (result.reason && /zastavila|spustil|vyplnil|skončil|ne tímto|Flatten/.test(result.reason)) return { tone: 'warn' as const, text: result.reason, at };
    const text = action === 'move-limit' ? 'Limit posunut' : action === 'cancel-entry' ? 'Čekající vstupy zrušeny'
      : action === 'close-position' ? 'Pozice zavřeny' : action === 'attach-brackets' ? 'SL a TP doplněny'
        : action === 'add-leg' ? 'Ochranná noha přidána' : action === 'remove-leg' ? 'Ochranná noha zrušena'
          : action === 'move-stop' ? 'SL posunut' : 'TP posunut';
    return { tone: 'ok' as const, text: `${text} — ověřeno na všech účtech skupiny.`, at };
  }
  if (result.status === 'blocked') return { tone: 'bad' as const, text: `Neodesláno: ${result.blockers.map(issue => issue.text).join(' ')}`, at };
  if (result.status === 'rejected') return { tone: 'bad' as const, text: result.reason ?? 'Broker změnu odmítl.', at };
  return { tone: 'warn' as const, text: result.reason ?? 'Výsledek skupiny není ověřený — zkontroluj účty v Tradovate, nic neopakuj.', at };
}
