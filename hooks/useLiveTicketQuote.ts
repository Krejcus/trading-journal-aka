import { useEffect, useRef, useState } from 'react';
import { LIVE_CANDLE_MAX_JUMP_RATIO, type LiveCandleFeed } from '../lib/liveCandleFeed';

/**
 * Živá cena pro panel objednávky LIVE → Graf (výjimka INV-UI-04 schválená
 * Filipem 30. 10. 2026): poslední cena zprávy z kanálu ceny (ne `close` svíčky),
 * nejvýš 10× za sekundu. Smí jen do zobrazení panelu a jako strop ceny
 * příkazu uživatele — nikdy do rizika, read modelu
 * ani rozhodnutí kopírky. `at` = kdy cena naposledy přišla (čerstvost Marketu).
 */
export function useLiveTicketQuote(feed: LiveCandleFeed | null, root: string, reference: number | null): { price: number; at: number } | null {
  const [quote, setQuote] = useState<{ price: number; at: number } | null>(null);
  // Kontrola kontraktu jako u grafu: tick daleko od svíčky grafu (jiný měsíc v rollu,
  // jiný trh v TradingView) se nepoužije — panel pak bere close svíčky.
  const referenceRef = useRef(reference);
  referenceRef.current = reference;
  useEffect(() => {
    if (!feed) { setQuote(null); return undefined; }
    let timer: number | null = null;
    let pending = false;
    // Čas příchodu ceny, ne vykreslení: iOS může čekající `flush` uspat a pustit až po návratu z pozadí.
    let receivedAt = 0;
    const flush = () => {
      timer = null;
      if (!pending) return;
      pending = false;
      // Poslední cena zprávy bez přehrání ticků: animace grafu se umí zaseknout (2. 11.) a close na přelomu minuty nese minulou minutu.
      const price = feed.lastPrice(root);
      const ref = referenceRef.current;
      if (price == null || !Number.isFinite(price) || ref == null || Math.abs(price - ref) > Math.abs(ref) * LIVE_CANDLE_MAX_JUMP_RATIO) {
        setQuote(null);
        return;
      }
      const at = receivedAt;
      setQuote(current => (current?.price === price && at - current.at < 1_000 ? current : { price, at }));
    };
    const unsubscribe = feed.subscribe(() => {
      pending = true;
      receivedAt = Date.now();
      if (timer == null) timer = window.setTimeout(flush, 100);
    });
    return () => {
      unsubscribe();
      if (timer != null) window.clearTimeout(timer);
    };
  }, [feed, root]);
  return quote;
}
