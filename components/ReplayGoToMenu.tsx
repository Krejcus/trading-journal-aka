import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarClock, ChevronRight, DollarSign, RotateCcw, Star, X } from 'lucide-react';
import {
  defaultReplayGoToSettings,
  REPLAY_GO_TO_TARGETS,
  formatClockTime,
  parseClockTime,
  saveReplayGoToSettings,
  type ReplayGoToRequest,
  type ReplayGoToSettings,
  type ReplayGoToTargetId,
  type ReplayGoToWeekday,
} from '../services/replayGoTo';

const WEEKDAYS: { value: ReplayGoToWeekday; label: string }[] = [
  { value: 1, label: 'Pondělí' },
  { value: 2, label: 'Úterý' },
  { value: 3, label: 'Středa' },
  { value: 4, label: 'Čtvrtek' },
  { value: 5, label: 'Pátek' },
  { value: 6, label: 'Sobota' },
  { value: 0, label: 'Neděle' },
];

const GROUP_LABELS: Record<string, string> = {
  session: 'Začátek session',
  day: 'Otevření dne',
  silver_bullet: 'Silver Bullet',
  manual: 'Ruční cíl',
};

const timeTargets = REPLAY_GO_TO_TARGETS.filter(
  (target): target is typeof target & { id: Exclude<ReplayGoToTargetId, 'price' | 'future_date'> } =>
    target.group !== 'manual',
);

/** Lokální datum a čas do `datetime-local` bez posunu do UTC. */
const toDateTimeLocalValue = (unixSeconds: number): string => {
  const date = new Date(unixSeconds * 1_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const ReplayGoToMenu: React.FC<{
  settings: ReplayGoToSettings;
  onSettingsChange: (settings: ReplayGoToSettings) => void;
  onGoTo: (request: ReplayGoToRequest) => void;
  disabled: boolean;
  isDark: boolean;
  /** Pro předvyplnění pole s datem — kurzor replaye v sekundách. */
  cursorTime: number | null;
  /** Pásmo grafu — časy se zadávají i zobrazují v něm. */
  timeZone: string;
  /** Lidský název pásma do popisku dialogu ("Praha"). */
  timeZoneLabel: string;
  buttonClassName: string;
}> = ({ settings, onSettingsChange, onGoTo, disabled, isDark, cursorTime, timeZone, timeZoneLabel, buttonClassName }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Kolikátý oblíbený cíl byl použitý naposled — FX Replay to ukazuje jako "1/3".
  const [lastUsedIndex, setLastUsedIndex] = useState(1);

  const favorites = useMemo(
    () => REPLAY_GO_TO_TARGETS.filter(target => settings.favorites.includes(target.id)),
    [settings.favorites],
  );

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', closeOutside);
    return () => window.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  const runTarget = (target: ReplayGoToTargetId, index: number) => {
    setOpen(false);
    setLastUsedIndex(index + 1);
    if (target === 'price' || target === 'future_date') {
      setSettingsOpen(true);
      return;
    }
    onGoTo({ kind: 'time', target });
  };

  const counter = favorites.length > 0
    ? ` ${Math.min(lastUsedIndex, favorites.length)}/${favorites.length}`
    : '';

  const menuSurface = isDark
    ? 'bg-[#1e222d] border-white/10 text-slate-200'
    : 'bg-white border-slate-200 text-slate-800';
  const rowHover = isDark ? 'hover:bg-white/5' : 'hover:bg-slate-50';

  return (
    <div ref={rootRef} className="relative flex items-center shrink-0">
      <button
        type="button"
        className={`${buttonClassName} gap-1 px-2 disabled:opacity-30`}
        disabled={disabled}
        onClick={() => setOpen(current => !current)}
        title="Skočit na začátek session, otevření dne nebo cenu"
        aria-label="Go To — skok replaye"
        aria-expanded={open}
      >
        <ChevronRight size={14} />
        <span className="text-[10px] font-bold whitespace-nowrap">Go To{counter}</span>
      </button>

      {open && (
        <div className={`absolute bottom-10 left-0 z-[700] w-[230px] overflow-hidden rounded-lg border py-1 shadow-2xl ${menuSurface}`}>
          {favorites.length === 0 && (
            <p className="px-3 py-3 text-[10px] font-medium text-slate-500">
              Žádný oblíbený cíl. Přidej si ho hvězdičkou v nastavení.
            </p>
          )}
          {favorites.map((target, index) => (
            <button
              key={target.id}
              type="button"
              onClick={() => runTarget(target.id, index)}
              className={`w-full h-9 px-3 flex items-center justify-between gap-3 text-left text-[11px] font-bold ${rowHover}`}
            >
              <span>{target.shortLabel}</span>
              {target.group !== 'manual' && (
                <span className="text-[10px] font-medium tabular-nums text-slate-500">
                  {formatClockTime(settings.times[target.id as keyof ReplayGoToSettings['times']])}
                </span>
              )}
            </button>
          ))}
          <div className={`my-1 border-t ${isDark ? 'border-white/10' : 'border-slate-200'}`} />
          <button
            type="button"
            onClick={() => { setOpen(false); setSettingsOpen(true); }}
            className={`w-full h-9 px-3 flex items-center text-left text-[11px] font-bold ${rowHover}`}
          >
            Vlastní nastavení
          </button>
        </div>
      )}

      {settingsOpen && (
        <ReplayGoToSettingsDialog
          settings={settings}
          onSettingsChange={onSettingsChange}
          onGoTo={onGoTo}
          onClose={() => setSettingsOpen(false)}
          isDark={isDark}
          cursorTime={cursorTime}
          timeZone={timeZone}
          timeZoneLabel={timeZoneLabel}
        />
      )}
    </div>
  );
};

const ReplayGoToSettingsDialog: React.FC<{
  settings: ReplayGoToSettings;
  onSettingsChange: (settings: ReplayGoToSettings) => void;
  onGoTo: (request: ReplayGoToRequest) => void;
  onClose: () => void;
  isDark: boolean;
  cursorTime: number | null;
  timeZone: string;
  timeZoneLabel: string;
}> = ({ settings, onSettingsChange, onGoTo, onClose, isDark, cursorTime, timeZone, timeZoneLabel }) => {
  const [draft, setDraft] = useState<ReplayGoToSettings>(settings);
  const [price, setPrice] = useState('');
  const [dateValue, setDateValue] = useState(() =>
    toDateTimeLocalValue((cursorTime ?? Math.floor(Date.now() / 1_000)) + 3_600));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setTime = (id: Exclude<ReplayGoToTargetId, 'price' | 'future_date'>, raw: string) => {
    const parsed = parseClockTime(raw);
    if (!parsed) return;
    setDraft(current => ({ ...current, times: { ...current.times, [id]: parsed } }));
  };

  const toggleFavorite = (id: ReplayGoToTargetId) => {
    setDraft(current => ({
      ...current,
      favorites: current.favorites.includes(id)
        ? current.favorites.filter(item => item !== id)
        // Pořadí drž podle registru, ne podle klikání — menu pak nepřeskakuje.
        : REPLAY_GO_TO_TARGETS.filter(target => [...current.favorites, id].includes(target.id)).map(target => target.id),
    }));
  };

  const toggleDay = (day: ReplayGoToWeekday) => {
    setDraft(current => ({
      ...current,
      daysToSkip: current.daysToSkip.includes(day)
        ? current.daysToSkip.filter(item => item !== day)
        : [...current.daysToSkip, day],
    }));
  };

  const save = () => {
    saveReplayGoToSettings(draft);
    onSettingsChange(draft);
    onClose();
  };

  const surface = isDark ? 'bg-[#1e222d] border-white/10 text-slate-200' : 'bg-white border-slate-200 text-slate-800';
  const inputStyle = isDark
    ? 'bg-white/5 border-white/10 text-slate-100'
    : 'bg-white border-slate-200 text-slate-900';
  const sectionTitle = 'text-[9px] font-black uppercase tracking-[0.13em] text-slate-500';
  const divider = isDark ? 'border-white/10' : 'border-slate-200';

  const groups: { key: string; targets: typeof timeTargets }[] = [
    { key: 'session', targets: timeTargets.filter(target => target.group === 'session') },
    { key: 'day', targets: timeTargets.filter(target => target.group === 'day') },
    { key: 'silver_bullet', targets: timeTargets.filter(target => target.group === 'silver_bullet') },
  ];

  // Portál do body je nutnost, ne kosmetika: replay toolbar se centruje přes
  // `transform`, a transformovaný předek se stává containing blockem i pro
  // `position: fixed` — dialog by se jinak pozicoval vůči liště a přetekl mimo
  // obrazovku. Guard drží render bezpečný i ve chvíli, kdy `document.body`
  // ještě není k dispozici (jinak createPortal shodí celý ErrorBoundary).
  const portalTarget = typeof document === 'undefined' ? null : document.body;
  if (!portalTarget) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center bg-black/50 p-4"
      onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className={`w-full max-w-[440px] max-h-[85vh] flex flex-col rounded-lg border shadow-2xl ${surface}`}>
        <div className={`px-4 py-3 flex items-center justify-between border-b ${divider}`}>
          <h3 className="text-[11px] font-black uppercase tracking-[0.13em]">Go To — nastavení</h3>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setDraft(defaultReplayGoToSettings(timeZone))}
              className={`h-7 px-2 inline-flex items-center gap-1.5 rounded-md text-[10px] font-bold ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-100'}`}
            ><RotateCcw size={12} />Výchozí</button>
            <button
              type="button"
              onClick={onClose}
              className={`w-7 h-7 inline-flex items-center justify-center rounded-md ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-100'}`}
              aria-label="Zavřít"
            ><X size={14} /></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          <p className="text-[10px] font-medium leading-relaxed text-slate-500">
            Časy jsou v pásmu grafu ({timeZoneLabel}) — stejná čísla, jaká vidíš na časové ose.
            Replay zastaví na poslední svíčce před cílem, takže začátek session uvidíš vzniknout.
          </p>

          {groups.map(group => (
            <section key={group.key} className="space-y-1.5">
              <h4 className={sectionTitle}>{GROUP_LABELS[group.key]}</h4>
              {group.targets.map(target => (
                <div key={target.id} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggleFavorite(target.id)}
                    className={`w-7 h-7 shrink-0 inline-flex items-center justify-center rounded-md ${draft.favorites.includes(target.id) ? 'text-amber-400' : 'text-slate-500 opacity-50 hover:opacity-100'}`}
                    aria-label={draft.favorites.includes(target.id) ? `Odebrat ${target.label} z rychlého menu` : `Přidat ${target.label} do rychlého menu`}
                    aria-pressed={draft.favorites.includes(target.id)}
                  ><Star size={13} fill={draft.favorites.includes(target.id) ? 'currentColor' : 'none'} /></button>
                  <span className="flex-1 text-[11px] font-bold">{target.label}</span>
                  <input
                    type="time"
                    value={formatClockTime(draft.times[target.id])}
                    onChange={event => setTime(target.id, event.target.value)}
                    className={`h-8 w-[92px] rounded-md border px-2 text-[11px] font-bold tabular-nums outline-none ${inputStyle}`}
                    aria-label={`Čas — ${target.label}`}
                  />
                </div>
              ))}
            </section>
          ))}

          <section className={`space-y-2 border-t pt-3 ${divider}`}>
            <h4 className={sectionTitle}>Ruční cíl</h4>
            <div className="flex items-center gap-2">
              <DollarSign size={13} className="shrink-0 text-slate-500" />
              <span className="flex-1 text-[11px] font-bold">Cena</span>
              <input
                type="number"
                step="any"
                value={price}
                onChange={event => setPrice(event.target.value)}
                placeholder="např. 21350"
                className={`h-8 w-[120px] rounded-md border px-2 text-[11px] font-bold tabular-nums outline-none ${inputStyle}`}
                aria-label="Cenová úroveň"
              />
              <button
                type="button"
                disabled={!Number.isFinite(Number(price)) || price.trim() === ''}
                onClick={() => { onGoTo({ kind: 'price', price: Number(price) }); onClose(); }}
                className="h-8 px-3 rounded-md bg-indigo-600 text-white text-[10px] font-bold disabled:opacity-30"
              >Skočit</button>
            </div>
            <div className="flex items-center gap-2">
              <CalendarClock size={13} className="shrink-0 text-slate-500" />
              <span className="flex-1 text-[11px] font-bold">Datum</span>
              <input
                type="datetime-local"
                value={dateValue}
                onChange={event => setDateValue(event.target.value)}
                className={`h-8 w-[180px] rounded-md border px-2 text-[11px] font-bold tabular-nums outline-none ${inputStyle}`}
                aria-label="Cílové datum a čas"
              />
              <button
                type="button"
                disabled={Number.isNaN(Date.parse(dateValue))}
                onClick={() => {
                  const parsed = Date.parse(dateValue);
                  if (Number.isNaN(parsed)) return;
                  onGoTo({ kind: 'date', unixSeconds: Math.floor(parsed / 1_000) });
                  onClose();
                }}
                className="h-8 px-3 rounded-md bg-indigo-600 text-white text-[10px] font-bold disabled:opacity-30"
              >Skočit</button>
            </div>
          </section>

          <section className={`space-y-2 border-t pt-3 ${divider}`}>
            <h4 className={sectionTitle}>Přeskakované dny</h4>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map(day => {
                const active = draft.daysToSkip.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    onClick={() => toggleDay(day.value)}
                    className={`h-7 px-2.5 rounded-md border text-[10px] font-bold transition-colors ${active
                      ? 'border-indigo-500 bg-indigo-500/10 text-indigo-500'
                      : isDark ? 'border-white/10 text-slate-400 hover:bg-white/5' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                    aria-pressed={active}
                  >{day.label}</button>
                );
              })}
            </div>
          </section>
        </div>

        <div className={`px-4 py-3 flex items-center justify-end gap-2 border-t ${divider}`}>
          <button
            type="button"
            onClick={onClose}
            className={`h-8 px-3 rounded-md text-[10px] font-bold ${isDark ? 'hover:bg-white/5' : 'hover:bg-slate-100'}`}
          >Zahodit</button>
          <button
            type="button"
            onClick={save}
            className="h-8 px-4 rounded-md bg-indigo-600 text-white text-[10px] font-bold"
          >Uložit</button>
        </div>
      </div>
    </div>,
    portalTarget,
  );
};

export default ReplayGoToMenu;
