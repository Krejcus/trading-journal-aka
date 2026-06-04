// Feature flags — localStorage-backed toggles pro experimentální features.
// Použij pro postupné A/B testování nových UI bez nutnosti server-side flag systému.
//
// Použití:
//   import { useFeatureFlag, setFeatureFlag } from '@/services/featureFlags';
//   const [denikV2, setDenikV2] = useFeatureFlag('denik_v2');
//   ...<button onClick={() => setDenikV2(!denikV2)}>...

import { useState, useEffect, useCallback } from 'react';

const PREFIX = 'alphatrade_ff_';

export type FeatureFlagKey =
  | 'denik_v2' // Nový Deník layout (collapsed sessions + visual strip + kick-off/debrief fáze)
  ;

/** Synchronní read — pro non-React kontexty. */
export function getFeatureFlag(key: FeatureFlagKey): boolean {
  try {
    return localStorage.getItem(PREFIX + key) === '1';
  } catch {
    return false;
  }
}

/** Synchronní write — pro non-React kontexty. */
export function setFeatureFlag(key: FeatureFlagKey, value: boolean): void {
  try {
    if (value) localStorage.setItem(PREFIX + key, '1');
    else localStorage.removeItem(PREFIX + key);
    // Trigger event aby ostatní komponenty se re-renderly
    window.dispatchEvent(new CustomEvent('featureflag-change', { detail: { key, value } }));
  } catch (e) {
    console.warn('[featureFlags] write failed:', e);
  }
}

/** React hook s auto-subscribe na změny (cross-tab + cross-component). */
export function useFeatureFlag(key: FeatureFlagKey): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => getFeatureFlag(key));

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.key === key) setValue(detail.value);
    };
    window.addEventListener('featureflag-change', handler);
    return () => window.removeEventListener('featureflag-change', handler);
  }, [key]);

  const toggle = useCallback((newValue: boolean) => {
    setFeatureFlag(key, newValue);
  }, [key]);

  return [value, toggle];
}
