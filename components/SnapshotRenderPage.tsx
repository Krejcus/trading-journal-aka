import React, { useEffect, useMemo, useState } from 'react';
import type { Trade } from '../types';
import { storageService } from '../services/storageService';
import { supabase } from '../services/supabase';
import { loadJournalChartDetail } from '../services/journalChartDetail';
import { publishSnapshotStatus, SNAPSHOT_RENDER_VERSION, type SnapshotRenderParams, type SnapshotRenderStatus } from '../lib/snapshotRender';
import { setChartAppearanceUserId } from '../services/chartAppearanceScope';
import { applyChartProfile, parseChartProfile } from '../services/chartProfile';

/**
 * Profil grafu ze serveru (indikátory, styl, nastavení grafu) → do místního
 * úložiště dřív, než se graf vykreslí. Bez profilu platí místní/výchozí.
 */
async function applyServerChartProfile(): Promise<'server' | 'local'> {
  const { data: { session } } = await supabase.auth.getSession();
  const owner = session?.user.id;
  if (!owner) return 'local';
  setChartAppearanceUserId(owner);
  const { data, error } = await supabase.from('user_chart_profiles').select('profile').eq('user_id', owner).maybeSingle();
  const profile = error ? null : parseChartProfile(data?.profile);
  if (!profile) return 'local';
  applyChartProfile(profile);
  return 'server';
}

const TradeMarketChart = React.lazy(() => import('./TradeMarketChart'));

/** Stránka, která se nikdy neusadí, nesmí workeru viset — po 90 s chyba. */
const RENDER_TIMEOUT_MS = 90_000;
/**
 * Čtení obchodu po čerstvém načtení stránky občas visí až do 20s limitu
 * dotazu (journal-facts-unavailable) a další pokus projde. Jde jen o čtení,
 * opakuje se nejvýš 3×.
 */
const LOAD_ATTEMPTS = 3;

/**
 * Vykreslovací stránka automatických snímků: graf obchodu stejný jako
 * v detailu, v pevné velikosti, bez ovládání. Viz lib/snapshotRender.ts.
 */
export default function SnapshotRenderPage({ params }: { params: SnapshotRenderParams }) {
  const isDark = params.theme === 'dark';
  const [trade, setTrade] = useState<Trade | null>(null);
  const [status, setStatus] = useState<SnapshotRenderStatus>(() => ({
    status: 'loading', tradeId: params.tradeId, mode: params.mode, renderVersion: SNAPSHOT_RENDER_VERSION,
    width: params.width, height: params.height,
  }));
  useEffect(() => publishSnapshotStatus(status), [status]);
  // Jen první výsledek platí (ready i chyba jsou konečné).
  const finish = useMemo(() => (next: 'ready' | 'error', error?: string) => setStatus(current =>
    current.status === 'loading' ? { ...current, status: next, ...(error ? { error } : {}) } : current), []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    document.body.style.margin = '0';
    document.body.style.background = isDark ? '#090d12' : '#ffffff';
  }, [isDark]);

  useEffect(() => {
    const timer = window.setTimeout(() => finish('error', 'Graf se nevykreslil do minuty.'), RENDER_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [finish]);

  useEffect(() => {
    if (params.token) {
      // Přihlášení workeru jednorázovým tokenem dodá serverová část (Codex).
      finish('error', 'Přihlášení tokenem zatím není k dispozici.');
      return;
    }
    let cancelled = false;
    const load = (id: string) => storageService.getTradeById(id);
    const attempt = async (): Promise<Trade> => {
      // Nejdřív dokončit obnovu přihlášení (jinak dotazy čekají na token).
      await supabase.auth.getSession();
      const found = await load(params.tradeId);
      if (!found) throw new Error('Obchod nenalezen nebo chybí přihlášení.');
      const detail = await loadJournalChartDetail(found, load);
      // Vzhled grafu jako u uživatele; chyba profilu snímek nezastaví.
      const profile = await applyServerChartProfile().catch(() => 'local' as const);
      if (!cancelled) setStatus(current => ({ ...current, chartProfile: profile }));
      return detail;
    };
    void (async () => {
      let lastError: unknown = null;
      for (let index = 0; index < LOAD_ATTEMPTS && !cancelled; index += 1) {
        try {
          const detail = await attempt();
          if (!cancelled) setTrade(detail);
          return;
        } catch (reason) {
          lastError = reason;
          // Obchod bez ověřené historie se opakováním nezmění.
          if (reason instanceof Error && reason.message === 'journal-chart-detail-unavailable') break;
        }
      }
      if (cancelled) return;
      const message = lastError instanceof Error ? lastError.message : 'Obchod se nepodařilo načíst.';
      finish('error', message === 'journal-chart-detail-unavailable' ? 'Obchod nemá ověřenou historii plnění.' : message);
    })();
    return () => { cancelled = true; };
  }, [finish, params.token, params.tradeId]);

  const snapshotRender = useMemo(() => ({
    mode: params.mode,
    onReady: () => finish('ready'),
    onError: (message: string) => finish('error', message),
  }), [finish, params.mode]);

  return (
    // Bez myši (žádný kříž kurzoru) a bez ovládání označeného pro snímky.
    <div data-snapshot-root style={{ width: params.width, height: params.height, overflow: 'hidden', pointerEvents: 'none', background: isDark ? '#090d12' : '#ffffff' }}>
      <style>{'[data-snapshot-root] [data-snapshot-hide] { display: none !important; }'}</style>
      {trade && (
        <React.Suspense fallback={null}>
          <TradeMarketChart trade={trade} isDark={isDark} variant="detail" snapshotRender={snapshotRender} />
        </React.Suspense>
      )}
    </div>
  );
}
