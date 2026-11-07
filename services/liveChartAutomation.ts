import { isAlertTone } from '../lib/priceAlertTones';

/**
 * Předvolby automatiky LIVE grafu, jedna pro zařízení (vlastní zvuky jsou také
 * jen v zařízení). `fillTone` null = zvuk řídí volba Vypnuto/Tón/Hlas; `slTone`
 * a `tpTone` null = stejný zvuk jako při vyplnění.
 */
export interface LiveChartAutomation {
  boxFollow: boolean;
  fillTone: string | null;
  slTone: string | null;
  tpTone: string | null;
}

export const LIVE_CHART_AUTOMATION_KEY = 'at:live:chart-automation';
const DEFAULTS: LiveChartAutomation = { boxFollow: true, fillTone: null, slTone: null, tpTone: null };

export function parseLiveChartAutomation(raw: string | null | undefined): LiveChartAutomation {
  if (!raw) return DEFAULTS;
  try {
    const value = JSON.parse(raw) as Partial<LiveChartAutomation> | null;
    return {
      boxFollow: value?.boxFollow !== false,
      fillTone: isAlertTone(value?.fillTone) ? value.fillTone : null,
      slTone: isAlertTone(value?.slTone) ? value.slTone : null,
      tpTone: isAlertTone(value?.tpTone) ? value.tpTone : null,
    };
  } catch {
    return DEFAULTS;
  }
}

let cached: LiveChartAutomation | null = null;
const listeners = new Set<() => void>();
let storageListening = false;

const storage = () => {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
};

export function getLiveChartAutomation(): LiveChartAutomation {
  if (cached) return cached;
  let raw: string | null = null;
  try { raw = storage()?.getItem(LIVE_CHART_AUTOMATION_KEY) ?? null; } catch { /* soukromý režim */ }
  cached = parseLiveChartAutomation(raw);
  return cached;
}

export function setLiveChartAutomation(patch: Partial<LiveChartAutomation>): void {
  cached = { ...getLiveChartAutomation(), ...patch };
  try { storage()?.setItem(LIVE_CHART_AUTOMATION_KEY, JSON.stringify(cached)); } catch { /* platí aspoň do zavření */ }
  [...listeners].forEach(listener => listener());
}

export function subscribeLiveChartAutomation(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageListening && typeof window !== 'undefined') {
    storageListening = true;
    window.addEventListener('storage', event => {
      if (event.key !== null && event.key !== LIVE_CHART_AUTOMATION_KEY) return;
      cached = null;
      [...listeners].forEach(item => item());
    });
  }
  return () => { listeners.delete(listener); };
}
