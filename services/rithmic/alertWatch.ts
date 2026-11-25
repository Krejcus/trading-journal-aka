/**
 * Hlídání upozornění na cenu ve službě Rithmic (24. 11. 2026). JEN OZNÁMENÍ — nic odsud nerozhoduje o příkazech,
 * riziku ani o ceně pro příkaz (INV-UI-01). Chyba hlídače nesmí nikdy shodit ani zdržet obchodní část služby:
 * všechno je obalené, síť běží mimo zpracování ticku.
 *
 * Jak to teče:
 *  1. Přihlášená appka (PC nebo spárovaný telefon) pošle službě místním spojením klíč hlídače (`alerts-key`)
 *     a seznam aktivních upozornění (`alerts-set`); služba si obojí uloží, takže hlídá i se zavřenou appkou
 *     a po svém restartu.
 *  2. Každý obchod z burzy projde jádrem (`priceAlertWatchCore`): křížení úrovně = spuštění.
 *  3. Spuštění se podepsané ohlásí serveru; ten pod zámkem rozhodne („jednou“, odstup, strop), zapíše událost
 *     (appkám dorazí přes Realtime) a pošle oznámení do iPhonu.
 *
 * Po výpadku cen se bere jen nová výchozí cena: úroveň protnutá během výpadku se NEOHLÁSÍ (nevíme kdy ani jak).
 */
import { createPriceAlertWatchCore, parseWatchAlert, type WatchAlert, type WatchTrigger } from '../priceAlertWatchCore';
import { alertListDigest, alertUserTag } from '../../lib/rithmicAlertWatch';

export interface AlertWatchStatus {
  /** Kolik upozornění služba hlídá. */
  count: number;
  /** Služba má klíč, kterým smí spuštění ohlásit. */
  keyed: boolean;
  /** Ceny z burzy běží. */
  feed: boolean;
  /** Poslední potíž s ohlášením (česky), nebo null. */
  error: string | null;
  /** Otisk hlídaného seznamu (`id:verze`) — appka podle něj pozná, že služba hlídá přesně její seznam. */
  digest: string;
  /** Otisk uživatele, jehož klíč služba drží; '' = žádný. */
  user: string;
}

export interface AlertWatchPersisted { userId: string; key: string | null; alerts: WatchAlert[] }

export interface AlertWatchPostResult { status: number; json: unknown }

export interface AlertWatchDeps {
  now?: () => number;
  uuid: () => string;
  /** Adresa appky na serveru, např. `https://alphatrade-mentor-15.vercel.app` (pevná, nikdy od klienta). */
  apiBase: string;
  post: (url: string, headers: Record<string, string>, body: string) => Promise<AlertWatchPostResult>;
  sign: (input: { userId: string; key: string; body: string; ts: number }) => string;
  load: () => AlertWatchPersisted | null;
  save: (state: AlertWatchPersisted) => void;
  onStatus: (status: AlertWatchStatus) => void;
  log: (line: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{43}$/;
/** Klidný trh není výpadek: o skutečném výpadku služba ví (spojení spadlo) a řekne to `feedLost()`. */
export const ALERT_WATCH_GAP_MS = 120_000;
export const ALERT_WATCH_MAX_ALERTS = 50;
/** Upozornění jsou na úrovně NQ (MNQ má stejnou cenu). */
const WATCHED_CONTRACT = /^(MNQ|NQ)[FGHJKMNQUVXZ]\d{1,4}$/;
const RETRY_DELAYS_MS = [5_000, 20_000];
const MAX_QUEUE = 40;

export function createRithmicAlertWatch(deps: AlertWatchDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const core = createPriceAlertWatchCore({ now, uuid: deps.uuid, gapMs: ALERT_WATCH_GAP_MS });
  let userId: string | null = null;
  let key: string | null = null;
  let alerts: WatchAlert[] = [];
  let feed = false;
  let error: string | null = null;
  let lastPrice: number | null = null;
  let queue: WatchTrigger[] = [];
  let sending = false;
  /** Čeká se na opakování po chybě sítě: nová křížení se jen řadí, neposílají se mimo pořadí pokusů. */
  let waiting = false;
  let lastStatus = '';

  const status = (): AlertWatchStatus => ({ count: alerts.length, keyed: key !== null, feed, error, digest: alertListDigest(alerts), user: key !== null ? alertUserTag(userId) : '' });
  const publish = (): void => {
    const next = status();
    const text = JSON.stringify(next);
    if (text === lastStatus) return;
    lastStatus = text;
    try { deps.onStatus(next); } catch { /* oznámení stavu nesmí nic shodit */ }
  };
  // Zápis na disk se sdružuje a běží mimo zpracování zprávy (služba na téže smyčce zpracovává ticky).
  let persistPending = false;
  const persist = (): void => {
    if (!userId || persistPending) return;
    persistPending = true;
    setTimer(() => {
      persistPending = false;
      if (!userId) return;
      try { deps.save({ userId, key, alerts }); } catch (reason) { deps.log(`uložení selhalo (${reason instanceof Error ? reason.message : String(reason)}) — hlídám dál z paměti`); }
    }, 250);
  };
  const apply = (): void => { core.setAlerts(alerts); publish(); };
  const dropAlert = (alertId: string, version: number): void => {
    const before = alerts.length;
    alerts = alerts.filter((alert) => !(alert.id === alertId && alert.version === version));
    if (alerts.length !== before) { apply(); persist(); }
  };

  try {
    const saved = deps.load();
    if (saved && USER_ID.test(saved.userId)) {
      userId = saved.userId.toLowerCase();
      key = typeof saved.key === 'string' && KEY.test(saved.key) ? saved.key : null;
      alerts = (Array.isArray(saved.alerts) ? saved.alerts : []).map(parseWatchAlert).filter((alert): alert is WatchAlert => alert !== null).slice(0, ALERT_WATCH_MAX_ALERTS);
      core.setAlerts(alerts);
    }
  } catch (reason) {
    deps.log(`uložený stav nejde přečíst (${reason instanceof Error ? reason.message : String(reason)}) — začínám bez upozornění`);
  }

  async function flush(attempt = 0, fromTimer = false): Promise<void> {
    // Časovač opakování vždy shodí čekání (i když se fronta mezitím vyprázdnila), jinak by další křížení oněměla.
    if (fromTimer) waiting = false;
    if (sending || !queue.length || waiting) return;
    if (!userId || !key) { error = 'chybí klíč — otevři appku, předá ho sama'; for (const trigger of queue) core.settle(trigger.triggerId, 'retry'); queue = []; publish(); return; }
    sending = true;
    const batch = queue.slice(0, 10);
    const settle = (outcome: 'final' | 'retry') => { for (const trigger of batch) core.settle(trigger.triggerId, outcome); queue = queue.filter((item) => !batch.includes(item)); };
    let retry = false;
    try {
      const body = JSON.stringify({ action: 'trigger', triggers: batch });
      const reply = await deps.post(`${deps.apiBase}/api/price-alerts/watch`, {
        'Content-Type': 'application/json',
        'x-alphatrade-alert-auth': deps.sign({ userId, key, body, ts: now() }),
      }, JSON.stringify({ payload: body }));
      if (reply.status === 401) {
        // Klíč server neuznal (odvolaný, jiný uživatel): zahodit, appka předá nový. Křížení se nehlásí naslepo znovu.
        key = null; error = 'server klíč neuznal — otevři appku, předá nový'; settle('retry'); persist();
      } else if (reply.status !== 200) {
        retry = true; error = `server odpověděl ${reply.status}`;
      } else {
        const results = Array.isArray((reply.json as { results?: unknown } | null)?.results) ? (reply.json as { results: Array<{ triggerId?: unknown; status?: unknown } | null> }).results : [];
        const byId = new Map(results.filter((row): row is { triggerId?: unknown; status?: unknown } => row != null && typeof row === 'object').map((row) => [String(row.triggerId), String(row.status)]));
        error = null;
        for (const trigger of batch) {
          const outcome = byId.get(trigger.triggerId) ?? 'error';
          if (outcome === 'triggered' || outcome === 'duplicate') { core.settle(trigger.triggerId, 'final'); deps.log(`upozornění ${trigger.alertId} ohlášeno (${outcome})`); }
          else if (outcome === 'rejected:cooldown' || outcome === 'error') core.settle(trigger.triggerId, 'retry');
          else {
            // Server upozornění už nezná v tomhle stavu (smazané, vypršelé, jiná verze, už spuštěné): přestat ho hlídat.
            core.settle(trigger.triggerId, 'final');
            dropAlert(trigger.alertId, trigger.version);
            deps.log(`upozornění ${trigger.alertId} server odmítl (${outcome}) — přestávám ho hlídat`);
          }
        }
        queue = queue.filter((item) => !batch.includes(item));
      }
    } catch (reason) {
      retry = true; error = `server je nedostupný (${reason instanceof Error ? reason.message : String(reason)})`;
    }
    sending = false;
    if (retry) {
      if (attempt < RETRY_DELAYS_MS.length) {
        // Stejné `triggerId` = server opakované hlášení pozná (duplicate), nic se nespustí dvakrát.
        waiting = true;
        setTimer(() => { void flush(attempt + 1, true).catch(() => undefined); }, RETRY_DELAYS_MS[attempt]);
      } else {
        deps.log(`ohlášení ${batch.length} upozornění se nepodařilo (${error}) — příští křížení je ohlásí znovu`);
        settle('retry');
        // Zbytek fronty (víc než 10 křížení naráz) nečeká na další obchod.
        if (queue.length) setTimer(() => { void flush(0).catch(() => undefined); }, RETRY_DELAYS_MS[0]);
      }
    } else if (queue.length) {
      void flush(0).catch(() => undefined);
    }
    publish();
  }

  return {
    /** Klíč hlídače od přihlášené appky. Jiný uživatel = začít načisto (upozornění předchozího se zahodí). */
    setKey(raw: unknown): { ok: boolean; error?: string } {
      const row = raw as { userId?: unknown; key?: unknown } | null;
      if (!row || typeof row.userId !== 'string' || !USER_ID.test(row.userId) || typeof row.key !== 'string' || !KEY.test(row.key)) return { ok: false, error: 'neplatný klíč hlídače' };
      const id = row.userId.toLowerCase();
      if (userId !== id) { alerts = []; core.clear(); queue = []; }
      userId = id; key = row.key; error = null;
      apply(); persist();
      return { ok: true };
    },
    /** Celý seznam aktivních upozornění od appky (nahrazuje předchozí). Seznam jiného uživatele se odmítne. */
    setAlerts(raw: unknown): { ok: boolean; count?: number; error?: string } {
      const row = raw as { userId?: unknown; alerts?: unknown } | null;
      if (!row || typeof row.userId !== 'string' || !USER_ID.test(row.userId) || !Array.isArray(row.alerts)) return { ok: false, error: 'neplatný seznam upozornění' };
      const id = row.userId.toLowerCase();
      if (userId !== null && userId !== id) return { ok: false, error: 'služba hlídá upozornění jiného účtu appky — nejdřív předej klíč' };
      if (userId === null) userId = id;
      const seen = new Set<string>();
      alerts = row.alerts.map(parseWatchAlert).filter((alert): alert is WatchAlert => {
        if (!alert || seen.has(alert.id)) return false;
        seen.add(alert.id);
        return true;
      }).slice(0, ALERT_WATCH_MAX_ALERTS);
      apply(); persist();
      return { ok: true, count: alerts.length };
    },
    /** Jeden obchod z burzy. Nikdy nevyhodí a nikdy nečeká na síť. */
    onTrade(price: number, at: number, contract: string): void {
      try {
        if (!Number.isFinite(price) || !Number.isFinite(at)) return;
        // Jiný trh než NQ/MNQ jádro nehlídá: pak se služba netváří, že hlídá (INV-UI-03).
        if (!WATCHED_CONTRACT.test(contract)) return;
        if (!feed) { feed = true; publish(); }
        const prev = lastPrice;
        lastPrice = price;
        if (!alerts.length) return;
        const triggers = core.onBatch({ contract, prev, min: price, max: price, last: price, at });
        if (!triggers.length) return;
        for (const trigger of triggers) {
          if (queue.length >= MAX_QUEUE) { core.settle(trigger.triggerId, 'retry'); continue; }
          queue.push(trigger);
        }
        void flush(0).catch(() => undefined);
      } catch (reason) {
        deps.log(`chyba při vyhodnocení (${reason instanceof Error ? reason.message : String(reason)})`);
      }
    },
    /** Spojení pro ceny spadlo: příští obchod je jen nová výchozí cena. */
    feedLost(): void {
      feed = false;
      lastPrice = null;
      core.resetBaseline();
      publish();
    },
    status,
  };
}
