import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ALERT_TONE_GROUPS, customToneId, customToneValue } from '../lib/priceAlertTones';
import {
  getLiveChartAutomation,
  setLiveChartAutomation,
  subscribeLiveChartAutomation,
} from '../services/liveChartAutomation';
import { liveFillAudio } from '../services/liveFillAudio';
import {
  addCustomAlertSound,
  listCustomAlertSounds,
  playAlertTone,
  type CustomAlertSound,
} from '../services/priceAlertSounds';

type ToneKey = 'fillTone' | 'slTone' | 'tpTone';
const NO_TONE = '';

/** Automatika LIVE grafu: box s pozicí a vlastní zvuky SL/TP. Telefon i PC, jen zobrazení. */
const LiveChartAutomationSettings: React.FC<{ isDark: boolean }> = ({ isDark }) => {
  const settings = useSyncExternalStore(subscribeLiveChartAutomation, getLiveChartAutomation, getLiveChartAutomation);
  const [customs, setCustoms] = useState<CustomAlertSound[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const uploadFor = useRef<ToneKey>('fillTone');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void listCustomAlertSounds().then(items => { if (alive) setCustoms(items); });
    return () => { alive = false; };
  }, []);

  const line = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.14)';
  const muted = isDark ? '#94a3b8' : '#64748b';
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, minHeight: 40 };
  const label: React.CSSProperties = { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 };

  const choose = (key: ToneKey, value: string) => {
    setProblem(null);
    setLiveChartAutomation({ [key]: value === NO_TONE ? null : value });
    if (value !== NO_TONE) {
      liveFillAudio.unlock();
      void playAlertTone(value);
    }
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    const result = await addCustomAlertSound(file);
    if ('error' in result) { setProblem(result.error); return; }
    setCustoms(await listCustomAlertSounds());
    choose(uploadFor.current, customToneValue(result.sound.id));
  };
  const toneRow = (key: ToneKey, text: string) => {
    const value = settings[key];
    return (
      <div style={row}>
        <span style={label}>{text}</span>
        <select
          aria-label={`Zvuk: ${text}`}
          value={value ?? NO_TONE}
          onChange={event => choose(key, event.target.value)}
          style={{ width: 150, height: 32, borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: 'inherit', fontSize: 12.5, padding: '0 6px' }}
        >
          <option value={NO_TONE}>{key === 'fillTone' ? 'Podle Zvuku při fillu' : 'Jako vyplnění'}</option>
          {customs.length > 0 && (
            <optgroup label="Vlastní">
              {customs.map(item => <option key={item.id} value={customToneValue(item.id)}>{item.name}</option>)}
            </optgroup>
          )}
          {customToneId(value) && !customs.some(item => item.id === customToneId(value)) && <option value={value!}>Vlastní zvuk</option>}
          {ALERT_TONE_GROUPS.map(group => (
            <optgroup key={group.name} label={group.name}>
              {group.tones.map(tone => <option key={tone.id} value={tone.id}>{tone.name}</option>)}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          aria-label={`Nahrát vlastní zvuk: ${text}`}
          title="Nahrát vlastní zvuk"
          onClick={() => { uploadFor.current = key; fileRef.current?.click(); }}
          style={{ width: 32, height: 32, flex: 'none', borderRadius: 8, border: `1px solid ${line}`, background: 'transparent', color: 'inherit', fontSize: 16, lineHeight: 1 }}
        >
          +
        </button>
      </div>
    );
  };

  return (
    <div data-live-chart-automation>
      <label style={{ ...row, cursor: 'pointer' }}>
        <span style={label}>Protahovat position box s pozicí</span>
        <input
          type="checkbox"
          checked={settings.boxFollow}
          onChange={event => setLiveChartAutomation({ boxFollow: event.target.checked })}
          style={{ width: 18, height: 18 }}
        />
      </label>
      <p style={{ margin: '0 0 8px', fontSize: 11.5, color: muted }}>
        Box se stejným směrem, ve kterém leží vstup pozice, roste s obchodem a skončí s jeho zavřením.
      </p>
      {toneRow('fillTone', 'Vyplnění')}
      {toneRow('slTone', 'Zásah SL')}
      {toneRow('tpTone', 'Zásah TP')}
      <p style={{ margin: '2px 0 0', fontSize: 11.5, color: problem ? '#ef4444' : muted }}>
        {problem ?? 'Podle plnění u brokera, jen s otevřeným grafem. Vybraný zvuk nahradí Tón i Hlas. Vlastní zvuky jsou jen v tomto zařízení.'}
      </p>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.mp3,.wav,.ogg,.m4a"
        style={{ display: 'none' }}
        aria-label="Soubor se zvukem"
        onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }}
      />
    </div>
  );
};

/** Přihlásí okno grafu k protahování boxu. */
export const LiveBoxFollowPane: React.FC<{ api: Parameters<LiveBoxFollowRegister>[0] | null; register: LiveBoxFollowRegister }> = ({ api, register }) => {
  useEffect(() => (api ? register(api) : undefined), [api, register]);
  return null;
};

export type LiveBoxFollowRegister = ReturnType<typeof import('../hooks/useLivePositionBoxFollow').useLivePositionBoxFollow>;

export default LiveChartAutomationSettings;
