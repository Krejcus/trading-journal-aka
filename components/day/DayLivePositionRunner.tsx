import { useEffect, useSyncExternalStore } from 'react';
import { journalLivePriceLines } from '../../lib/journalLivePosition';
import type { JournalLivePositionStore } from '../../lib/journalLivePositionStore';
import type { LivePriceLinesFeed } from '../../lib/livePriceLinesFeed';
import { useJournalLivePosition, type JournalLiveSource } from '../../hooks/useJournalLivePosition';

/**
 * Běžec živé pozice deníku (renderuje nic): čte data (stav workeru po 2 s,
 * úsporné čtení z brokera) a plní úložiště štítku a čáry grafu. Jen
 * zobrazení — nic odsud neodesílá příkaz. Záměrně odděleně od štítku, který
 * jediný vidí cenu z TradingView (INV-UI-04): čáry jdou jen z read modelu.
 */
export default function DayLivePositionRunner({ source, enabled, store, feed }: {
  source: JournalLiveSource | null | undefined;
  /** Jen deník dneška. */
  enabled: boolean;
  store: JournalLivePositionStore;
  feed: LivePriceLinesFeed;
}) {
  const target = useSyncExternalStore(store.subscribe, store.getTarget, store.getTarget);
  const view = useJournalLivePosition(source, enabled, target);
  useEffect(() => {
    store.setView(view);
    feed.publish(view.model?.symbol ?? null, journalLivePriceLines(view.model));
  }, [feed, store, view]);
  useEffect(() => () => {
    feed.publish(null, []);
  }, [feed]);
  return null;
}
