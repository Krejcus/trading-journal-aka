import { supabase } from './supabase';
import { setChartAppearanceUserId } from './chartAppearanceScope';
import {
  applyChartProfile,
  CHART_PROFILE_MAX_CHARS,
  chartProfileFingerprint,
  currentChartProfile,
  hasLocalChartCustomization,
  parseChartProfile,
} from './chartProfile';

/**
 * Synchronizace profilu grafu se serverem (viz services/chartProfile.ts).
 * - Po přihlášení: zařízení bez vlastního nastavení si profil stáhne; jinak
 *   platí místní a nahraje se.
 * - Pak každých 30 s (a při skrytí stránky) porovná místní profil s posledním
 *   nahraným a při změně ho nahraje. Síť jen při změně.
 * - Tabulka ještě není (migrace) nebo chyba sítě → do konce relace ticho,
 *   appka funguje dál čistě z localStorage.
 */

const TABLE = 'user_chart_profiles';
const SYNC_INTERVAL_MS = 30_000;
const syncedKey = (userId: string) => `alphatrade:chart-profile-synced:user:${userId}`;

export function startChartProfileSync(): () => void {
  let userId: string | null = null;
  let lastSaved: string | null = null;
  let disabled = false;
  let busy = false;
  let generation = 0;

  const push = async () => {
    const owner = userId;
    if (!owner || disabled || busy || lastSaved === null) return;
    const profile = currentChartProfile();
    const json = chartProfileFingerprint(profile);
    if (json === lastSaved || json.length > CHART_PROFILE_MAX_CHARS) return;
    busy = true;
    try {
      const { error } = await supabase.from(TABLE)
        .upsert({ user_id: owner, profile, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) { disabled = true; return; }
      if (userId === owner) {
        lastSaved = json;
        try { window.localStorage.setItem(syncedKey(owner), new Date().toISOString()); } catch { /* jen značka */ }
      }
    } catch {
      disabled = true;
    } finally {
      busy = false;
    }
  };

  const begin = async (owner: string) => {
    const current = ++generation;
    userId = owner;
    lastSaved = null;
    disabled = false;
    // Vlastník vzhledu grafu musí být známý dřív, než se profil čte/zapisuje.
    setChartAppearanceUserId(owner);
    try {
      const { data, error } = await supabase.from(TABLE).select('profile').eq('user_id', owner).maybeSingle();
      if (current !== generation) return;
      if (error) { disabled = true; return; }
      const server = parseChartProfile(data?.profile);
      let synced = false;
      try { synced = window.localStorage.getItem(syncedKey(owner)) != null; } catch { /* bez úložiště */ }
      if (server && !synced && !hasLocalChartCustomization()) {
        // Nové zařízení bez vlastního nastavení: převezme profil ze serveru.
        applyChartProfile(server);
        try { window.localStorage.setItem(syncedKey(owner), new Date().toISOString()); } catch { /* jen značka */ }
      }
      // Porovnávat proti serveru — nahraje se jen skutečný rozdíl ('' = na serveru nic).
      lastSaved = server ? chartProfileFingerprint(server) : '';
      await push();
    } catch {
      if (current === generation) disabled = true;
    }
  };

  const end = () => { generation += 1; userId = null; lastSaved = null; };

  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
    const owner = session?.user.id ?? null;
    if (!owner) { end(); return; }
    // Odložit: dotaz přímo v callbacku čeká na zámek přihlášení (supabase-js).
    if (owner !== userId) { userId = owner; window.setTimeout(() => { void begin(owner); }, 0); }
  });
  const interval = window.setInterval(() => { void push(); }, SYNC_INTERVAL_MS);
  const onHide = () => { if (document.visibilityState === 'hidden') void push(); };
  document.addEventListener('visibilitychange', onHide);
  return () => {
    end();
    subscription.unsubscribe();
    window.clearInterval(interval);
    document.removeEventListener('visibilitychange', onHide);
  };
}
