import { livePositionMatchesRoot, type LivePriceLine } from './journalLivePosition';

/**
 * Čáry živé pozice pro grafy deníku (jen zobrazení). Štítek pozice sem
 * zapisuje, grafy si čáry kreslí samy (`useLivePriceLinesBinding`) — obnova
 * po 2 s tak nepřekresluje deník ani graf přes React.
 */
export interface LivePriceLinesFeed {
  subscribe(listener: () => void): () => void;
  /** Čáry pro panel daného kořene (MNQ i NQ mají stejnou cenu). */
  current(root: string): readonly LivePriceLine[];
  publish(symbol: string | null, lines: readonly LivePriceLine[]): void;
}

const sameLines = (a: readonly LivePriceLine[], b: readonly LivePriceLine[]) => a.length === b.length
  && a.every((line, index) => line.id === b[index].id && line.price === b[index].price
    && line.title === b[index].title && line.color === b[index].color && line.style === b[index].style);

export function createLivePriceLinesFeed(): LivePriceLinesFeed {
  const listeners = new Set<() => void>();
  let symbol: string | null = null;
  let lines: readonly LivePriceLine[] = [];
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    current(root) {
      return symbol && livePositionMatchesRoot(symbol, root) ? lines : [];
    },
    publish(nextSymbol, nextLines) {
      if (nextSymbol === symbol && sameLines(lines, nextLines)) return;
      symbol = nextSymbol;
      lines = [...nextLines];
      listeners.forEach(listener => listener());
    },
  };
}
