/**
 * Prořídnutí štítků na cenové ose pro úzký graf (telefon).
 *
 * Úrovně a VWAP pásma dávají na osu i pět a víc štítků blízko sebe; na
 * telefonu se pak překrývají a nejdou přečíst (TradingView mobile je proto
 * nekreslí přes sebe). Ponechá se štítek s vyšší prioritou, ostatní, které by
 * ho překryly, odpadnou. Kolize se hlídá i proti rezervovaným souřadnicím —
 * typicky aktuální cena, jejíž štítek kreslí knihovna sama.
 */

export interface PriceAxisLabelCandidate {
  name: string;
  price: number;
}

/** Hlavní VWAP > úrovně (high/low, session) > σ pásma VWAPu. */
export const priceAxisLabelPriority = (name: string): number => {
  if (name === 'VWAP') return 0;
  if (name.startsWith('VWAP')) return 2;
  return 1;
};

export const thinPriceAxisLabels = <T extends PriceAxisLabelCandidate>(
  labels: readonly T[],
  coordinate: (price: number) => number | null,
  reserved: readonly number[],
  minGap: number,
): T[] => {
  const ranked = labels
    .map((label, order) => ({ label, order, y: coordinate(label.price) }))
    .filter((item): item is { label: T; order: number; y: number } => item.y !== null && Number.isFinite(item.y))
    .sort((a, b) => priceAxisLabelPriority(a.label.name) - priceAxisLabelPriority(b.label.name) || a.order - b.order);
  const taken = reserved.filter(Number.isFinite);
  const kept: { label: T; order: number }[] = [];
  for (const item of ranked) {
    if (taken.some(y => Math.abs(y - item.y) < minGap)) continue;
    taken.push(item.y);
    kept.push(item);
  }
  // Pořadí jako na vstupu, ať se štítky při posunu grafu nepřehazují.
  return kept.sort((a, b) => a.order - b.order).map(item => item.label);
};
