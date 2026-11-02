import type { BrokerFill } from './brokerPort';

/**
 * Plnění leadera aktuální epizody pro šipky v LIVE grafu (2. 11. 2026) — JEN zobrazení.
 * Nic se neukládá, nic z toho nečte risk, ledger ani příkazy. Roli vstup/výstup bere
 * z rozdělení kopírky (`preclassifyLeaderFillExposure`: pozice před fillem + redukující
 * část), takže sedí s tím, co kopírka s fillem udělala. Neznámá pozice před fillem
 * (resync, mezera) = `gap` → web šipky nekreslí; nikdy nehádá.
 */
export interface CopierLeaderDisplayFill {
  fillId: string;
  orderId: string;
  /** Čas plnění u brokera (ms). */
  at: number;
  price: number;
  side: 'Buy' | 'Sell';
  quantity: number;
  role: 'entry' | 'exit';
}

export interface CopierLeaderDisplayFills {
  symbol: string;
  episodeId?: string;
  /** Epizoda začala z flat a je celá (jinak šipky nekreslit). */
  fromFlat: boolean;
  /** Mezera v řadě (neznámá pozice před fillem, resync) — epizoda neúplná. */
  gap?: true;
  /** Pozice leadera po posledním fillu epizody (znaménko = strana). */
  netAfter: number;
  fills: CopierLeaderDisplayFill[];
}

export const LEADER_DISPLAY_FILLS_MAX = 40;
const SEEN_MAX = 500;

export function createLeaderDisplayFills(max = LEADER_DISPLAY_FILLS_MAX) {
  let episode: CopierLeaderDisplayFills | null = null;
  const seen = new Set<string>();
  const remember = (id: string) => {
    seen.add(id);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!);
  };
  const start = (symbol: string, fromFlat: boolean, netAfter: number): CopierLeaderDisplayFills => {
    episode = { symbol, fromFlat, netAfter, fills: [] };
    return episode;
  };
  const push = (target: CopierLeaderDisplayFills, fill: BrokerFill, quantity: number, role: 'entry' | 'exit') => {
    if (quantity <= 0) return;
    target.fills.push({ fillId: fill.fillId, orderId: fill.brokerOrderId, at: fill.filledAt, price: fill.price, side: fill.side, quantity, role });
    if (target.fills.length > max) {
      target.fills.splice(0, target.fills.length - max);
      target.fromFlat = false;
    }
  };
  return {
    /** Synchronní, bez výjimek ven (volající ho stejně balí do try/catch). */
    observe(fill: BrokerFill, preNet: number | undefined, reducing: number): void {
      if (!fill.fillId || seen.has(fill.fillId)) return;
      remember(fill.fillId);
      if (!Number.isFinite(fill.price) || fill.price <= 0 || !(fill.quantity > 0)) return;
      const signed = fill.side === 'Buy' ? fill.quantity : -fill.quantity;
      // Bez platného času plnění u brokera šipku nejde umístit; pozice před fillem 0 s redukující
      // částí = rozdělení nesedí (Position=0 před Fillem u nesledovaného symbolu) — obojí = mezera.
      const badTime = !Number.isFinite(fill.filledAt) || fill.filledAt <= 0;
      if (preNet == null || !Number.isFinite(preNet) || badTime || (preNet === 0 && reducing > 0)) {
        // Bez pozice před fillem nejde poznat vstup/výstup — epizoda je neúplná.
        if (episode && episode.symbol === fill.symbol) episode.gap = true;
        else episode = { symbol: fill.symbol, fromFlat: false, gap: true, netAfter: 0, fills: [] };
        return;
      }
      const exitQty = Math.max(0, Math.min(reducing, fill.quantity));
      const entryQty = fill.quantity - exitQty;
      let current = episode;
      let pre = preNet;
      if (pre !== 0 && current && current.symbol === fill.symbol && current.netAfter !== pre) {
        // Position dorazila před Fillem: u vstupu z flat (ledger ještě bez lotu) má rozdělení
        // kopírky pozici už PO fillu. Jen tenhle jednoznačný tvar se bere jako vstup z flat;
        // jakýkoli jiný nesoulad s epizodou = mezera (nikdy přilepit k cizímu obchodu).
        if (current.netAfter === 0 && reducing === 0 && pre === signed) pre = 0;
        else {
          current.gap = true;
          return;
        }
      }
      if (pre === 0) current = start(fill.symbol, true, 0);
      else if (!current || current.symbol !== fill.symbol) current = start(fill.symbol, false, pre);
      push(current, fill, exitQty, 'exit');
      if (exitQty > 0 && entryQty > 0 && exitQty >= Math.abs(pre)) {
        // Flip: stará epizoda končí výstupem, nová začíná z flat jen vstupní částí.
        current.netAfter = 0;
        current = start(fill.symbol, true, 0);
      }
      push(current, fill, entryQty, 'entry');
      current.netAfter = pre + signed;
    },
    setEpisodeId(symbol: string, episodeId: string | undefined): void {
      if (episode && episode.symbol === symbol && episodeId && !episode.episodeId) episode.episodeId = episodeId;
    },
    markGap(): void {
      if (episode) episode.gap = true;
    },
    reset(): void {
      episode = null;
      seen.clear();
    },
    snapshot(): CopierLeaderDisplayFills | null {
      if (!episode) return null;
      return { ...episode, fills: episode.fills.map(fill => ({ ...fill })) };
    },
  };
}

export type LeaderDisplayFills = ReturnType<typeof createLeaderDisplayFills>;
