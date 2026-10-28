import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { tvLivePnlDelta, type TvLivePnlLeg } from '../lib/tvLivePnl';
import type { TvPriceDiagnostics } from '../lib/tvPriceStore';
import { tvPriceChannel, tvPriceStore } from '../services/tvPriceChannel';
import { observeLivePriceSource } from '../lib/livePriceSourceFallback';

/**
 * Listová komponenta otevřeného P&L (krok 4 návrhu
 * `docs/reviews/tv-price-channel-design-20261026.md`). Kotva je hodnota
 * z read modelu (broker / odhad z marku brokera); pohyb ceny z TradingView
 * se k ní přičte jen tady, v renderu, a jen když projdou kontroly
 * `lib/tvLivePnl.ts`. **INV-UI-04**: hodnota s pohybem z TV nikam neodchází
 * — ani do read modelu, marks, způsobilosti, limitů, ARM, příkazů, widgetu,
 * sdílených karet, žurnálu, ani do storage. Store čtou jen tyto komponenty,
 * takže změna ceny 4×/s překreslí jen je, ne velký strom LIVE.
 */

const NO_DELTA = Number.NaN;

export const TV_LIVE_PNL_TITLE = 'Živě: poslední kotva brokera + pohyb živé ceny (IBKR, záloha TradingView). Jen zobrazení.';

/** Zdroj živé ceny podle symbolu zprávy: vlákno workeru posílá `IBKR:…`, nebo symbol grafu TV. */
export const livePriceSourceName = (chart: string | null | undefined): 'IBKR' | 'TV' =>
  chart?.startsWith('IBKR:') ? 'IBKR' : 'TV';

const useLivePriceSource = () => useSyncExternalStore(
  tvPriceStore.subscribe,
  () => livePriceSourceName(tvPriceStore.view().latest?.chart),
  () => 'TV' as const,
);

/** Cena jde ze zálohy TradingView, přestože appka předtím viděla IBKR (Gateway nedostupná). */
const useLivePriceFallback = () => useSyncExternalStore(
  tvPriceStore.subscribe,
  () => observeLivePriceSource(tvPriceStore.view().latest?.chart),
  () => false,
);

export const LIVE_PRICE_FALLBACK_TITLE = 'IBKR je nedostupné (IB Gateway neběží, odhlásila se nebo jsi přihlášený v IBKR jinde) — živá cena jde ze zálohy TradingView.';

/** Viditelný štítek živé ceny u hodnoty (i na telefonu, kde není title). */
export const LiveTvMark = () => {
  const source = useLivePriceSource();
  const fallback = useLivePriceFallback();
  return (
    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${fallback ? 'bg-amber-500' : 'bg-indigo-500'}`} role="img"
      aria-label={fallback ? 'Živě ze zálohy TradingView, IBKR nedostupné' : source === 'IBKR' ? 'Živě z IBKR' : 'Živě z TradingView'}
      title={fallback ? LIVE_PRICE_FALLBACK_TITLE : TV_LIVE_PNL_TITLE} />
  );
};

/** Text „živě · IBKR“ / „živě · TV“ podle zdroje poslední zprávy; při záloze žlutě „TV (záloha)“. */
export const LivePriceSourceTag = () => {
  const source = useLivePriceSource();
  const fallback = useLivePriceFallback();
  return fallback
    ? <span className="text-amber-600 dark:text-amber-400" title={LIVE_PRICE_FALLBACK_TITLE}>živě · TV (záloha)</span>
    : <>živě · {source}</>;
};

export function LiveOpenPnlValue({ anchor, legs, children }: {
  /** Zobrazená hodnota z read modelu (bez TV). */
  anchor: number;
  /** Pozice, kterých se hodnota týká; `null` = jen kotva (a worker nestreamuje). */
  legs: readonly TvLivePnlLeg[] | null;
  children: (value: number, live: boolean) => React.ReactNode;
}) {
  const interested = legs != null && legs.length > 0;
  // Presence „dívám se na P&L“ jen s otevřenou pozicí; skrytí appky řeší kanál.
  useEffect(() => (interested ? tvPriceChannel.addPnlInterest() : undefined), [interested]);
  // Primitivní výběr: změna storu bez změny pohybu komponentu nepřekreslí.
  const delta = useSyncExternalStore(tvPriceStore.subscribe, () => {
    const result = tvLivePnlDelta(legs, tvPriceStore.view());
    return result.live ? result.deltaUsd : NO_DELTA;
  }, () => NO_DELTA);
  const live = Number.isFinite(delta) && Number.isFinite(anchor);
  return <>{children(live ? anchor + delta : anchor, live)}</>;
}

const STATE_LABEL: Record<TvPriceDiagnostics['state'], string> = {
  off: 'vypnuto',
  connecting: 'připojuje se',
  waiting: 'připojeno, čeká na cenu',
  live: 'živě',
  stale: 'stojí',
};

const REASON_LABEL: Record<string, string> = {
  'no-grant': 'worker kanál nenabízí (nepřipojený, nebo vypnuto na serveru)',
  'signed-out': 'nepřihlášeno',
  'no-webcrypto': 'prohlížeč neumí ověřit podpis',
  background: 'aplikace na pozadí',
  'not-watching': 'nic živého na obrazovce (bez pozice a bez živého grafu)',
  'channel-error': 'kanál se nepodařilo otevřít',
  'grant-changed': 'nové zařízení nebo klíč',
  subscribing: 'přihlašuje se ke kanálu',
  channel_error: 'chyba kanálu, zkouší znovu',
  timed_out: 'kanál neodpověděl, zkouší znovu',
  closed: 'kanál zavřen, zkouší znovu',
  'no-message': 'worker zatím nic neposlal',
  'tv-stale': 'cena nepřišla déle než 2 s',
  interval: 'zdrojový panel TV není 1m',
  mode: 'TV neposílá realtime data',
  'no-price': 'TV nehlásí poslední cenu',
};

const stateTone = (state: TvPriceDiagnostics['state']) => state === 'live'
  ? 'text-emerald-500' : state === 'stale' ? 'text-amber-500' : 'text-[var(--text-muted)]';

/** Diagnostika kanálu ceny z TV (krok 3). Odebírá store jen v rozbaleném panelu. */
export function TvPriceDiagnosticsRow() {
  const diagnostics = useSyncExternalStore(tvPriceStore.subscribe, tvPriceStore.diagnostics, tvPriceStore.diagnostics);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const age = diagnostics.lastReceivedAt != null ? Math.max(0, now - diagnostics.lastReceivedAt) : null;
  const reason = diagnostics.reason ? REASON_LABEL[diagnostics.reason] ?? diagnostics.reason : null;
  return (
    <div className="mt-4 rounded-md border border-[var(--border-subtle)] px-3 py-2" data-testid="tv-price-diagnostics">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs font-black text-[var(--text-primary)]">Živá cena z {livePriceSourceName(diagnostics.chart) === 'IBKR' ? 'IBKR' : 'TradingView'} (jen zobrazení)</span>
        <span className={`text-xs font-bold ${stateTone(diagnostics.state)}`}>
          {STATE_LABEL[diagnostics.state]}{reason ? ` · ${reason}` : ''}
        </span>
      </div>
      <div className="mt-1 text-[10px] tabular-nums text-[var(--text-muted)]">
        {diagnostics.perSecond} zpráv/s
        {age != null ? ` · poslední před ${(age / 1_000).toFixed(1)} s` : ''}
        {diagnostics.lagMs != null ? ` · zpoždění ${diagnostics.lagMs} ms` : ''}
        {diagnostics.seq != null ? ` · seq ${diagnostics.seq}` : ''}
        {diagnostics.chart ? ` · ${diagnostics.chart}${diagnostics.interval ? ` ${diagnostics.interval}m` : ''}` : ''}
        {diagnostics.front ? ` · ${diagnostics.front}` : ''}
        {diagnostics.mode ? ` · ${diagnostics.mode}` : ''}
      </div>
      <div className="mt-0.5 text-[10px] tabular-nums text-[var(--text-muted)]">
        podpis platný {diagnostics.verified} · neplatný {diagnostics.rejected} · přehrání {diagnostics.replayed}
        {' · '}mezery {diagnostics.gaps} · nový běh {diagnostics.runChanges} · zahozeno {diagnostics.dropped}
      </div>
    </div>
  );
}
