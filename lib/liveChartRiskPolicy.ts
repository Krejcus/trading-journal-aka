import type { LiveChartPositionSummary } from './liveChartPosition';

/**
 * Co jde z NEOVĚŘENÉ pozice grafu (stav workeru bez dokladu / držený stav) — 10. 11. 2026,
 * závazný checklist obchodovatelnosti (Filip): nezamykat vše kromě Flattenu, ale povolit akce,
 * které riziko jen SNIŽUJÍ. Jedna politika pro bránu odeslání, plánovače panelu, čáry i zkratky.
 *
 * Povoleno: zavřít pozici (i z víc ticketů), zrušit čekající vstup, utáhnout SL (i BE), přidat
 * SL / TP. Odmítnuto se srozumitelným důvodem: rozšířit nebo odebrat SL, posunout TP nebo limit,
 * odebrat TP, přikoupit, nový vstup. Ověřená pozice: politika nic neomezuje (rozhoduje jako dosud
 * worker u brokera). Jen UI pojistka — nic neautorizuje; worker vše ověří znovu (INV-UI-01/03).
 */
export type LiveChartRiskAction =
  | { kind: 'close' }
  | { kind: 'cancel-entry' }
  | { kind: 'add-protection' }
  | { kind: 'move-stop'; newPrice: number | null | undefined; currentStop?: number | null }
  | { kind: 'remove-stop' }
  | { kind: 'move-target' }
  | { kind: 'remove-target' }
  | { kind: 'move-limit' }
  | { kind: 'scale-in' }
  | { kind: 'entry' };

export const LIVE_UNVERIFIED_ALLOWED_TEXT = 'teď jde jen snížit riziko: zavřít, zrušit vstup, utáhnout SL / BE nebo přidat SL a TP';

const reject = (what: string) => `Pozice je zatím neověřená — ${what} teď nejde; ${LIVE_UNVERIFIED_ALLOWED_TEXT}. Nic se neodeslalo.`;

/** Nový SL je blíž trhu než dosavadní (long výš, short níž). Neznámý dosavadní SL = nelze posoudit. */
export function liveStopTightens(side: 'long' | 'short', currentStop: number | null | undefined, newPrice: number | null | undefined): boolean {
  if (currentStop == null || newPrice == null || !Number.isFinite(currentStop) || !Number.isFinite(newPrice)) return false;
  return side === 'long' ? newPrice > currentStop : newPrice < currentStop;
}

/** null = akce smí dál (u ověřené pozice vždy); jinak důvod, proč z neověřené pozice neodejde. */
export function liveUnverifiedActionBlock(
  summary: Pick<LiveChartPositionSummary, 'unverified' | 'continuityOnly' | 'side' | 'stop'> | null | undefined,
  action: LiveChartRiskAction,
): string | null {
  if (summary?.unverified !== true) return summary?.continuityOnly === true ? continuityOnlyBlock(summary, action) : null;
  switch (action.kind) {
    case 'close':
    case 'cancel-entry':
    case 'add-protection':
      return null;
    case 'move-stop': {
      const current = action.currentStop !== undefined ? action.currentStop : summary.stop;
      if (current == null) return reject('posun SL bez jedné známé ceny SL');
      return liveStopTightens(summary.side, current, action.newPrice) ? null : reject('rozšířit SL');
    }
    case 'remove-stop': return reject('odebrat SL');
    case 'move-target': return reject('posunout TP');
    case 'remove-target': return reject('odebrat TP');
    case 'move-limit': return reject('posunout limit vstupu');
    case 'scale-in': return reject('přikoupit');
    case 'entry': return reject('nový vstup na tomto kontraktu');
    default: return reject('tahle akce');
  }
}

/**
 * Pozice ověřená jen kotvou kontinuity (review Codexu 5e9b2aef): kotva nepozná vynechanou
 * událost Tradovate, proto neprojde nic, co zvětší možnou ztrátu — rozšíření nebo odebrání SL,
 * přikoupení a nový vstup na kontraktu. TP, limit vstupu, zavření, BE a utažení SL dál jdou.
 */
function continuityOnlyBlock(
  summary: Pick<LiveChartPositionSummary, 'side' | 'stop'>,
  action: LiveChartRiskAction,
): string | null {
  const block = (what: string) => `Pozice není plně ověřená u brokera — ${what} teď nejde (zavřít, utáhnout SL, BE a TP jdou). Nic se neodeslalo.`;
  switch (action.kind) {
    case 'move-stop': {
      const current = action.currentStop !== undefined ? action.currentStop : summary.stop;
      if (current == null) return block('posun SL bez jedné známé ceny SL');
      return liveStopTightens(summary.side, current, action.newPrice) ? null : block('rozšířit SL');
    }
    case 'close':
    case 'cancel-entry':
    case 'add-protection':
    // TP je výstup s pevným množstvím (přes trh = zavření); limit vstupu nemění množství —
    // přes trh je to v praxi okamžitý vstup, vědomá výjimka (COPIER_INVARIANTS).
    case 'move-target':
    case 'remove-target':
    case 'move-limit':
      return null;
    case 'remove-stop': return block('odebrat SL');
    case 'scale-in': return block('přikoupit');
    case 'entry': return block('nový vstup');
    default: return block('tahle akce');
  }
}

/** Akce správy leadera (`manage-leader-order`) → druh pro politiku. */
export function liveManageRiskAction(action: string, newPrice: number | null | undefined, currentStop?: number | null): LiveChartRiskAction {
  switch (action) {
    case 'close-position': return { kind: 'close' };
    case 'cancel-entry': return { kind: 'cancel-entry' };
    case 'attach-brackets': case 'add-leg': return { kind: 'add-protection' };
    case 'move-stop': return { kind: 'move-stop', newPrice, ...(currentStop !== undefined ? { currentStop } : {}) };
    case 'move-target': return { kind: 'move-target' };
    case 'move-limit': return { kind: 'move-limit' };
    case 'remove-leg': return { kind: 'remove-stop' };
    default: return { kind: 'entry' };
  }
}
