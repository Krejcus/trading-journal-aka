import { supabase } from './supabase';
import { chartProfileEditedAt, setChartAppearanceUserId, stampChartProfileEdit } from './chartAppearanceScope';
import {
  applyChartProfile,
  CHART_PROFILE_MAX_CHARS,
  chartProfileFingerprint,
  chartProfileHash,
  currentChartProfile,
  decideChartProfileSync,
  EMPTY_CHART_PROFILE_SYNC_STATE,
  hasLocalChartCustomization,
  parseChartProfile,
  type ChartProfileSyncState,
} from './chartProfile';

/**
 * Obousměrná synchronizace profilu grafů se serverem (viz services/chartProfile.ts).
 *
 * Profil grafů platí v celé appce mimo backtest a má být stejný na všech
 * zařízeních. Novější úprava vyhraje: `updated_at` řádku nese čas úpravy na
 * zařízení, které ji nahrálo (ne čas nahrání), a porovnává se s časem poslední
 * místní úpravy (`chartProfileEditedAt`).
 * - Místní změna se nejdřív porovná se serverem (pull) a nahraje se jen tehdy,
 *   když server nemá novější úpravu z jiného zařízení.
 * - Po přihlášení, při návratu do appky a každé 2 min se server zkontroluje
 *   a novější profil se převezme — grafy se překreslí.
 * - Řádek, kterému tahle verze nerozumí (novější verze profilu), se nikdy
 *   nepřepíše. Výchozí profil se na prázdný server nenahrává.
 * - Chybějící tabulka = do konce relace ticho; ostatní chyby (síť, výpadek)
 *   jen přeskočí tento pokus, další proběhne podle plánu.
 */

const TABLE = 'user_chart_profiles';
const PUSH_INTERVAL_MS = 30_000;
const PULL_INTERVAL_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;
const stateKey = (userId: string) => `alphatrade:chart-profile-sync:v2:user:${userId}`;
const backupKey = (userId: string) => `alphatrade:chart-profile-backup:user:${userId}`;
const legacySyncedKey = (userId: string) => `alphatrade:chart-profile-synced:user:${userId}`;

const readState = (userId: string): ChartProfileSyncState => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(stateKey(userId)) ?? 'null') as Partial<ChartProfileSyncState> | null;
    return parsed && typeof parsed === 'object' ? { ...EMPTY_CHART_PROFILE_SYNC_STATE, ...parsed } : { ...EMPTY_CHART_PROFILE_SYNC_STATE };
  } catch {
    return { ...EMPTY_CHART_PROFILE_SYNC_STATE };
  }
};
const writeState = (userId: string, state: ChartProfileSyncState) => {
  try { window.localStorage.setItem(stateKey(userId), JSON.stringify(state)); } catch { /* jen značka */ }
};

/** Chybějící tabulka (migrace ještě neproběhla) — jediná chyba, po které sync mlčí do konce relace. */
const isMissingTable = (error: { code?: string } | null | undefined) => error?.code === '42P01' || error?.code === 'PGRST205';

/** Zaseknutý dotaz (mobilní síť) nesmí sync zablokovat navždy. */
const withTimeout = <T,>(promise: PromiseLike<T>): Promise<T> => Promise.race([
  Promise.resolve(promise),
  new Promise<T>((_, reject) => { window.setTimeout(() => reject(new Error('chart-profile-sync-timeout')), REQUEST_TIMEOUT_MS); }),
]);

export function startChartProfileSync(): () => void {
  let userId: string | null = null;
  let disabled = false;
  let busy = false;
  let generation = 0;

  /** Místní profil a jeho otisk; při změně zapíše čas poslední úpravy. */
  const observeLocal = (owner: string) => {
    const profile = currentChartProfile();
    const fingerprint = chartProfileFingerprint(profile);
    const hash = chartProfileHash(fingerprint);
    const state = readState(owner);
    if (state.localHash !== hash) {
      // První pozorování neznamená změnu — čas zůstane neznámý.
      const localAt = state.localHash === null ? state.localAt : chartProfileEditedAt() ?? Date.now();
      writeState(owner, { ...state, localHash: hash, localAt });
    }
    return { profile, fingerprint, hash };
  };

  const push = async (owner: string) => {
    const { profile, fingerprint, hash } = observeLocal(owner);
    if (fingerprint.length > CHART_PROFILE_MAX_CHARS) return;
    const state = readState(owner);
    // Čas úpravy, ne nahrání — jinak by pozdě nahraná starší úprava přebila novější.
    // Vždy po verzi, kterou zařízení na serveru vidělo, ať ji ostatní poznají jako novou.
    const editedAt = Math.max(state.localAt ?? chartProfileEditedAt() ?? Date.now(), (state.seenServerAt ?? 0) + 1);
    const { error } = await withTimeout(supabase.from(TABLE)
      .upsert({ user_id: owner, profile, updated_at: new Date(editedAt).toISOString() }, { onConflict: 'user_id' }));
    if (error) { if (isMissingTable(error)) disabled = true; return; }
    if (userId !== owner) return;
    writeState(owner, { ...readState(owner), syncedHash: hash, seenServerAt: editedAt });
  };

  /** Porovnat se serverem: převzít novější, nebo nahrát místní. */
  const pull = async () => {
    const owner = userId;
    if (!owner || disabled || busy) return;
    const current = generation;
    busy = true;
    try {
      const { data, error } = await withTimeout(supabase.from(TABLE).select('profile, updated_at').eq('user_id', owner).maybeSingle());
      if (current !== generation || userId !== owner) return;
      if (error) { if (isMissingTable(error)) disabled = true; return; }
      const local = observeLocal(owner);
      if (!data) {
        // Na serveru nic: nahrát jen vlastní nastavení, ne výchozí profil.
        if (hasLocalChartCustomization()) await push(owner);
        return;
      }
      const server = parseChartProfile(data.profile);
      // Řádek z novější verze appky — nepřepisovat ho ani nepřebírat.
      if (!server) return;
      const parsedAt = data.updated_at ? Date.parse(String(data.updated_at)) : NaN;
      const serverAt = Number.isFinite(parsedAt) ? parsedAt : null;
      const serverHash = chartProfileHash(chartProfileFingerprint(server));
      const state = readState(owner);
      const decision = decideChartProfileSync({ state, localHash: local.hash, serverHash, serverAt });
      if (decision === 'apply-server') {
        if (state.syncedHash === null) {
          // První převzetí na tomto zařízení: místní profil zůstane schovaný jako záloha.
          try { window.localStorage.setItem(backupKey(owner), JSON.stringify({ savedAt: new Date().toISOString(), profile: local.profile })); } catch { /* jen záloha */ }
        }
        applyChartProfile(server);
        // Zápis profilu je převzetí, ne místní úprava.
        if (serverAt !== null) stampChartProfileEdit(serverAt);
        // Po zápisu se místní profil skládá znovu (normalizace) — shoda = tento stav.
        const after = chartProfileHash(chartProfileFingerprint(currentChartProfile()));
        writeState(owner, { seenServerAt: serverAt, syncedHash: after, localHash: after, localAt: serverAt });
        try { window.localStorage.setItem(legacySyncedKey(owner), new Date().toISOString()); } catch { /* jen značka */ }
        return;
      }
      const next = { ...readState(owner) };
      if (serverAt !== null && (next.seenServerAt === null || serverAt > next.seenServerAt)) next.seenServerAt = serverAt;
      if (serverHash === local.hash) next.syncedHash = local.hash;
      writeState(owner, next);
      if (decision === 'push-local') await push(owner);
    } catch {
      // Síť nebo časový limit: zkusí se znovu při dalším plánovaném pokusu.
    } finally {
      busy = false;
    }
  };

  /** Místní změna → nejdřív porovnat se serverem, teprve pak případně nahrát. */
  const pushIfChanged = () => {
    const owner = userId;
    if (!owner || disabled || busy) return;
    const { hash } = observeLocal(owner);
    const state = readState(owner);
    if (state.syncedHash === hash) return;
    void pull();
  };

  const begin = (owner: string) => {
    generation += 1;
    userId = owner;
    disabled = false;
    busy = false;
    // Vlastník vzhledu grafu musí být známý dřív, než se profil čte/zapisuje.
    setChartAppearanceUserId(owner);
    void pull();
  };

  const end = () => { generation += 1; userId = null; };

  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
    const owner = session?.user.id ?? null;
    if (!owner) { end(); return; }
    // Odložit: dotaz přímo v callbacku čeká na zámek přihlášení (supabase-js).
    if (owner !== userId) { userId = owner; window.setTimeout(() => begin(owner), 0); }
  });
  const pushTimer = window.setInterval(pushIfChanged, PUSH_INTERVAL_MS);
  const pullTimer = window.setInterval(() => { if (document.visibilityState === 'visible') void pull(); }, PULL_INTERVAL_MS);
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') pushIfChanged();
    else void pull();
  };
  const onFocus = () => { void pull(); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  return () => {
    end();
    subscription.unsubscribe();
    window.clearInterval(pushTimer);
    window.clearInterval(pullTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
  };
}
