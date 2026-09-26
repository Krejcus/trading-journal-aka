/**
 * Klient soukromého skladu svíček (`market-candle-store`, viz
 * docs/CANDLE_STORE_SERVER_HANDOFF.md). Rozhoduje jen o tom, co s odpovědí
 * skladu udělat; samotné volání a starý endpoint řeší `marketData`.
 *
 * Pravidla:
 * - `202 store-pending` = jiný požadavek právě stejné období kupuje → čekat
 *   a zkusit znovu, **nikdy** k tomu nevolat placený `market-candles`
 *   (obešel by zámek a koupil tatáž data podruhé).
 * - Sklad nepatří tomuto uživateli / není nastavený → starý endpoint a do
 *   konce relace už sklad nezkoušet. Nenasazená funkce se v prohlížeči
 *   projeví jako síťová chyba (CORS) → starý endpoint a pár minut nezkoušet.
 * - `409` (konec ještě není historický) → starý endpoint, ten konec ořízne.
 * - `404 no-data` = opravdu prázdná řada (víkend, svátek).
 * - `402/429` = cena/limit u poskytovatele → chyba bez zálohy.
 * - `503` → jednou zopakovat, pak starý endpoint (graf se musí dát otevřít
 *   i při rozbitém skladu; odsouhlaseno s Codexem).
 *
 * Výjimka ze zámku: zámek chrání souběžné běžné požadavky, ne nejisté chyby.
 * Selže-li sklad až po stažení z Databenta (503), nebo spadne síť bez HTTP
 * odpovědi, záložní `market-candles` může zaplatit tatáž data podruhé.
 * Jediný nákup je zaručený jen u cesty přes `202 store-pending`.
 */

export interface StoreRequest {
  symbol: string;
  schema: 'ohlcv-1m' | 'ohlcv-1h';
  start: string;
  end: string;
}

export type StoreOutcome =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'no-data' }
  /** `session` = do konce relace nezkoušet, `temporary` = pár minut ne. */
  | { kind: 'fallback'; reason: string; disable: 'session' | 'temporary' | false }
  | { kind: 'error'; code: string; message: string };

export type StoreInvoke = (body: StoreRequest) => Promise<{ data: unknown; error: unknown }>;

interface ParsedFailure { status: number | null; code: string | null; message: string | null }

async function parseFailure(error: unknown): Promise<ParsedFailure> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    let payload: Record<string, unknown> | null = null;
    try { payload = await context.clone().json(); } catch { /* ne-JSON odpověď brány */ }
    return {
      status: context.status,
      code: typeof payload?.error === 'string' ? payload.error : typeof payload?.code === 'string' ? payload.code : null,
      message: typeof payload?.message === 'string' ? payload.message : null,
    };
  }
  return { status: null, code: null, message: String((error as { message?: unknown } | null)?.message ?? '') || null };
}

export async function requestCandleStore(invoke: StoreInvoke, body: StoreRequest, options: {
  sleep?: (ms: number) => Promise<void>;
  /** Jak dlouho nanejvýš čekat na cizí rozběhnutý nákup (202). */
  maxPendingMs?: number;
} = {}): Promise<StoreOutcome> {
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxPendingMs = options.maxPendingMs ?? 60_000;
  let waited = 0;
  let unavailableRetried = false;
  for (;;) {
    let result: { data: unknown; error: unknown };
    try {
      result = await invoke(body);
    } catch (reason) {
      return { kind: 'fallback', reason: `store-network:${String((reason as Error)?.message ?? reason)}`, disable: 'temporary' };
    }
    const data = result.data as Record<string, unknown> | null;
    if (!result.error) {
      if (data?.error === 'store-pending') {
        const pause = Math.max(250, Math.min(5_000, Number(data.retryAfterMs) || 1_000));
        if (waited + pause > maxPendingMs) return { kind: 'error', code: 'store-pending-timeout', message: 'Sklad svíček stále stahuje stejné období. Zkus to za chvíli znovu.' };
        waited += pause;
        await sleep(pause);
        continue;
      }
      if (data && Array.isArray(data.candles)) return { kind: 'ok', data };
      return { kind: 'fallback', reason: 'store-invalid-response', disable: false };
    }
    const failure = await parseFailure(result.error);
    // Bez HTTP odpovědi (FunctionsFetchError): nenasazená funkce neprojde CORS,
    // nebo výpadek sítě.
    if (failure.status === null) return { kind: 'fallback', reason: `store-unreachable:${failure.message ?? ''}`, disable: 'temporary' };
    // Funkce ve Supabase neexistuje (sklad ještě není nasazený).
    if (failure.status === 404 && failure.code !== 'no-data') return { kind: 'fallback', reason: 'store-not-deployed', disable: 'session' };
    if (failure.status === 404) return { kind: 'no-data' };
    if (failure.status === 401 || failure.status === 403) return { kind: 'fallback', reason: `store-${failure.code ?? failure.status}`, disable: 'session' };
    if (failure.status === 503 && failure.code === 'store-not-configured') return { kind: 'fallback', reason: 'store-not-configured', disable: 'session' };
    if (failure.status === 409) return { kind: 'fallback', reason: 'store-not-historical', disable: false };
    if (failure.status === 402 || failure.status === 429) {
      return { kind: 'error', code: failure.code ?? `store-${failure.status}`, message: failure.message ?? 'Poskytovatel tržních dat odmítl požadavek (cena nebo limit).' };
    }
    if (failure.status === 400) return { kind: 'error', code: failure.code ?? 'invalid-request', message: failure.message ?? 'Neplatný požadavek na tržní data.' };
    if (failure.status === 503 && !unavailableRetried) {
      unavailableRetried = true;
      await sleep(1_000);
      continue;
    }
    // Výpadek skladu nebo sítě: graf se musí dát otevřít i tak.
    return { kind: 'fallback', reason: `store-${failure.code ?? failure.status}`, disable: false };
  }
}
