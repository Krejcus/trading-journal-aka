// Předává službě Rithmic klíč hlídače a seznam aktivních upozornění a vrací text „kdo hlídá“ (24. 11. 2026).
// JEN OZNÁMENÍ: nic odsud nesouvisí s příkazy (INV-UI-01). Nepřihlášený uživatel (místní úložiště) se nehlídá.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { alertListDigest, alertUserTag, rithmicAlertWatchLabel, rithmicAlertWatchProblem, rithmicWatchedAlerts, type RithmicAlertFired, type RithmicAlertWatchStatus } from '../lib/rithmicAlertWatch';
import { usePriceAlertStore } from '../services/priceAlertStoreHook';
import { supabase } from '../services/supabase';
import { apiUrl } from '../utils/runtimeConfig';

interface Link {
  link: string;
  helloFresh: boolean;
  alertWatch: RithmicAlertWatchStatus | null;
  sendAlertCommand: (command: { op: 'alerts-key' | 'alerts-set' } & Record<string, unknown>) => Promise<boolean>;
  onAlertFired: (listener: (fired: RithmicAlertFired) => void) => () => void;
}

async function fetchGrant(): Promise<{ userId: string; key: string } | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return null;
    const response = await fetch(apiUrl('/api/price-alerts/watch'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'grant' }) });
    if (!response.ok) return null;
    const json = await response.json() as { userId?: unknown; key?: unknown };
    return typeof json.userId === 'string' && typeof json.key === 'string' ? { userId: json.userId, key: json.key } : null;
  } catch { return null; }
}

/** `enabled` = skutečný trh (na zkušebním systému se nehlídá). Vrací text pro UI: `watching` nebo důvod, proč ne. */
export function useRithmicAlertWatch(trading: Link, enabled: boolean): { watching: string | null; problem: string | null } {
  const store = usePriceAlertStore();
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void supabase.auth.getSession().then(({ data }) => { if (alive) setUserId(data.session?.user.id ?? null); }).catch(() => undefined);
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setUserId(session?.user.id ?? null));
    return () => { alive = false; data.subscription.unsubscribe(); };
  }, []);
  const watched = useMemo(() => rithmicWatchedAlerts(state.alerts), [state.alerts]);
  const fingerprint = useMemo(() => JSON.stringify(watched), [watched]);
  const ready = enabled && trading.link === 'open' && trading.helloFresh && trading.alertWatch !== null && userId !== null;
  const userTag = alertUserTag(userId);
  const digest = useMemo(() => alertListDigest(watched), [watched]);
  // Klíč musí být TOHOTO uživatele: cizí klíč ve službě = předat svůj (služba pak začne načisto).
  const keyed = trading.alertWatch?.keyed === true && trading.alertWatch.user === userTag;
  const sentRef = useRef<string | null>(null);
  const grantBusy = useRef(false);
  // Nové spojení = služba mohla mezitím spadnout nebo se vyměnit: seznam poslat znovu.
  useEffect(() => { if (!ready) sentRef.current = null; }, [ready]);

  // Klíč: služba ho nemá → vyžádat u serveru a předat. Jeden pokus na spojení a stav; neúspěch počká na další změnu.
  useEffect(() => {
    if (!ready || keyed || grantBusy.current) return;
    grantBusy.current = true;
    void (async () => {
      try {
        const grant = await fetchGrant();
        if (grant && grant.userId === userId) await trading.sendAlertCommand({ op: 'alerts-key', userId: grant.userId, key: grant.key });
      } finally { window.setTimeout(() => { grantBusy.current = false; }, 30_000); }
    })();
  }, [ready, keyed, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seznam: po spojení a po každé změně (s krátkým zpožděním, ať tažení čáry neposílá zprávu při každém pohybu).
  useEffect(() => {
    // Poslat, když jsme tento seznam ještě neposlali, NEBO když služba drží jiný (jiné zařízení, restart, odmítnutí).
    if (!ready || !keyed || (sentRef.current === fingerprint && trading.alertWatch?.digest === digest)) return undefined;
    const timer = window.setTimeout(() => {
      const sending = fingerprint;
      void trading.sendAlertCommand({ op: 'alerts-set', userId, alerts: watched }).then((ok) => { if (ok) sentRef.current = sending; });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [ready, keyed, fingerprint, userId, trading.alertWatch?.digest]); // eslint-disable-line react-hooks/exhaustive-deps

  // Křížení rovnou ze služby (bez čekání na server): jen na skutečném trhu a jen pro tohoto uživatele.
  const firedGate = useRef({ enabled, userTag });
  firedGate.current = { enabled, userTag };
  const onAlertFired = trading.onAlertFired;
  useEffect(() => onAlertFired((fired) => {
    const gate = firedGate.current;
    if (!gate.enabled || !gate.userTag || fired.user !== gate.userTag) return;
    store.fired?.({ alertId: fired.alertId, version: fired.version, triggerId: fired.triggerId, at: Date.now() });
  }), [onAlertFired, store]);

  if (!enabled) return { watching: null, problem: 'Na zkušebním systému se upozornění nehlídají (trh je smyšlený).' };
  if (userId === null) return { watching: null, problem: 'Upozornění hlídá služba jen přihlášenému uživateli.' };
  return {
    watching: rithmicAlertWatchLabel(trading.alertWatch, { digest, user: userTag }),
    problem: rithmicAlertWatchProblem(trading.alertWatch, trading.link === 'open', userTag),
  };
}
