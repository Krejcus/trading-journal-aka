import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { MarketTimeframe } from '../services/marketData';
import TradingViewColorPicker, { colorWithAlpha } from './TradingViewColorPicker';
import IndicatorTemplateMenu from './IndicatorTemplateMenu';

export interface IndicatorVisibilitySettings {
  minutes: boolean;
  minuteFrom: number;
  minuteTo: number;
  hours: boolean;
  hourFrom: number;
  hourTo: number;
  days: boolean;
  dayFrom: number;
  dayTo: number;
}

export interface FvgIndicatorSettings {
  enabled: boolean;
  bullColor: string;
  bearColor: string;
  bullOpacity: number;
  bearOpacity: number;
  fillOpacity: number;
  mitigatedTransparency: number;
  maxCount: number;
  labelText: string;
  labelSize: 'tiny' | 'small' | 'medium';
  labelColor: string;
  boxes: boolean;
  paneLabels: boolean;
  statusInputs: boolean;
  visibility: IndicatorVisibilitySettings;
}

export interface StructureIndicatorSettings {
  enabled: boolean;
  showBos: boolean;
  showChoch: boolean;
  bullishColor: string;
  bearishColor: string;
  lineWidth: 1 | 2 | 3 | 4;
  textSize: 'tiny' | 'small' | 'medium' | 'large';
  textBackground: boolean;
  textBackgroundColor: string;
  paneLabels: boolean;
  statusInputs: boolean;
  visibility: IndicatorVisibilitySettings;
}

export interface LevelsIndicatorSettings {
  showAsia: boolean;
  asiaColor: string;
  asiaStart: number;
  asiaEnd: number;
  showAsiaLines: boolean;
  showLondon: boolean;
  londonColor: string;
  londonStart: number;
  londonEnd: number;
  showLondonLines: boolean;
  showNewYork: boolean;
  newYorkColor: string;
  newYorkStart: number;
  newYorkEnd: number;
  showNewYorkLines: boolean;
  sessionLineWidth: 1 | 2 | 3 | 4;
  sessionLineStyle: 'solid' | 'dashed' | 'dotted';
  showSessionBoxes: boolean;
  sessionBoxTransparency: number;
  currentDay: boolean;
  priorDay: boolean;
  priorWeek: boolean;
  dayOpen: boolean;
  weekOpen: boolean;
  sessionHighLow: boolean;
  currentDayColor: string;
  priorDayColor: string;
  priorWeekColor: string;
  dayOpenColor: string;
  weekOpenColor: string;
  currentDayWidth: 1 | 2 | 3 | 4;
  currentDayStyle: 'solid' | 'dashed' | 'dotted';
  priorDayWidth: 1 | 2 | 3 | 4;
  priorDayStyle: 'solid' | 'dashed' | 'dotted';
  priorWeekWidth: 1 | 2 | 3 | 4;
  priorWeekStyle: 'solid' | 'dashed' | 'dotted';
  showOpen: boolean;
  openWidth: 1 | 2 | 3 | 4;
  openStyle: 'solid' | 'dashed' | 'dotted';
  lineWidth: 1 | 2 | 3 | 4;
  showVwap: boolean;
  showPrevVwap: boolean;
  showDeviations: boolean;
  vwapColor: string;
  bandsColor: string;
  deviation: number;
  dev1Multiplier: number;
  dev2Multiplier: number;
  prevVwapWidth: 1 | 2 | 3 | 4;
  prevVwapStyle: 'solid' | 'dashed' | 'dotted';
  timezone: string;
  showLabels: boolean;
  labelSize: 'small' | 'medium' | 'large';
  extendLines: number;
  showZones: boolean;
  zoneSize: number;
  showOvernight: boolean;
  overnightColor: string;
  showCompass: boolean;
  compassColor: string;
  showInitialBalance: boolean;
  initialBalanceColor: string;
  rthOpenHour: number;
  rthOpenMinute: number;
  showBiasTable: boolean;
  paneLabels: boolean;
  statusInputs: boolean;
  visibility: IndicatorVisibilitySettings;
}

export interface AlphaTradeIndicatorSettings {
  fvg: FvgIndicatorSettings;
  structure: StructureIndicatorSettings;
  levels: LevelsIndicatorSettings;
}

const visibilityDefaults = (): IndicatorVisibilitySettings => ({
  minutes: true, minuteFrom: 1, minuteTo: 59,
  hours: true, hourFrom: 1, hourTo: 24,
  days: true, dayFrom: 1, dayTo: 366,
});

export const DEFAULT_INDICATOR_SETTINGS: AlphaTradeIndicatorSettings = {
  fvg: {
    enabled: true,
    bullColor: '#2196f3',
    bearColor: '#ff9800',
    bullOpacity: 30,
    bearOpacity: 30,
    fillOpacity: 30,
    mitigatedTransparency: 93,
    maxCount: 14,
    labelText: '',
    labelSize: 'small',
    labelColor: '#ffffff',
    boxes: true,
    paneLabels: true,
    statusInputs: true,
    visibility: visibilityDefaults(),
  },
  structure: {
    enabled: true,
    showBos: true,
    showChoch: true,
    bullishColor: '#26a69a',
    bearishColor: '#ef5350',
    lineWidth: 1,
    textSize: 'medium',
    textBackground: false,
    textBackgroundColor: '#ffffff',
    paneLabels: true,
    statusInputs: true,
    visibility: visibilityDefaults(),
  },
  levels: {
    showAsia: true,
    asiaColor: '#e91e63',
    asiaStart: 1,
    asiaEnd: 9,
    showAsiaLines: true,
    showLondon: true,
    londonColor: '#2196f3',
    londonStart: 9,
    londonEnd: 14,
    showLondonLines: true,
    showNewYork: true,
    newYorkColor: '#4caf50',
    newYorkStart: 14,
    newYorkEnd: 22,
    showNewYorkLines: true,
    sessionLineWidth: 1,
    sessionLineStyle: 'dashed',
    showSessionBoxes: true,
    sessionBoxTransparency: 92,
    currentDay: true,
    priorDay: true,
    priorWeek: true,
    dayOpen: true,
    weekOpen: true,
    sessionHighLow: true,
    currentDayColor: '#4db6c7',
    priorDayColor: '#f5a136',
    priorWeekColor: '#9c27b0',
    dayOpenColor: '#fbc43d',
    weekOpenColor: '#4db6c7',
    currentDayWidth: 2,
    currentDayStyle: 'dashed',
    priorDayWidth: 2,
    priorDayStyle: 'solid',
    priorWeekWidth: 2,
    priorWeekStyle: 'solid',
    showOpen: false,
    openWidth: 1,
    openStyle: 'dashed',
    lineWidth: 1,
    showVwap: true,
    showPrevVwap: true,
    showDeviations: true,
    vwapColor: '#ff9800',
    bandsColor: '#e6a637',
    deviation: 1,
    dev1Multiplier: 1,
    dev2Multiplier: 2,
    prevVwapWidth: 2,
    prevVwapStyle: 'solid',
    timezone: 'Europe/Prague',
    showLabels: true,
    labelSize: 'small',
    extendLines: 5,
    showZones: false,
    zoneSize: 2,
    showOvernight: false,
    overnightColor: '#ff5252',
    showCompass: false,
    compassColor: '#90a4ae4d',
    showInitialBalance: false,
    initialBalanceColor: '#7c4dff',
    rthOpenHour: 15,
    rthOpenMinute: 30,
    showBiasTable: false,
    paneLabels: true,
    statusInputs: true,
    visibility: visibilityDefaults(),
  },
};

export const indicatorVisibleOnTimeframe = (
  timeframe: MarketTimeframe,
  visibility: IndicatorVisibilitySettings,
): boolean => {
  if (timeframe.endsWith('m')) {
    const value = Number(timeframe.slice(0, -1));
    return visibility.minutes && value >= visibility.minuteFrom && value <= visibility.minuteTo;
  }
  if (timeframe.endsWith('h')) {
    const value = Number(timeframe.slice(0, -1));
    return visibility.hours && value >= visibility.hourFrom && value <= visibility.hourTo;
  }
  return visibility.days && visibility.dayFrom <= 1 && visibility.dayTo >= 1;
};

type IndicatorId = keyof AlphaTradeIndicatorSettings;
type TabId = 'inputs' | 'style' | 'visibility';

const titles: Record<IndicatorId, string> = {
  fvg: 'AlphaTrade FVG INSTANT (CZ)',
  structure: 'AlphaTrade BoS/ChoCh (CZ)',
  levels: 'Liquidity Levels CZ – Advanced',
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="grid min-h-10 grid-cols-[minmax(0,1fr)_280px] items-center gap-3 text-[13px] text-slate-800">
    <span>{label}</span><span className="flex items-center justify-end gap-2">{children}</span>
  </div>
);

const Check: React.FC<{ checked: boolean; onChange: (checked: boolean) => void; label: string }> = ({ checked, onChange, label }) => (
  <label className="flex min-h-10 cursor-pointer items-center gap-3 text-[13px] text-slate-800">
    <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} className="h-5 w-5 accent-[#2962ff]" />
    <span>{label}</span>
  </label>
);

const NumberInput: React.FC<{ value: number; min?: number; max?: number; step?: number; onChange: (value: number) => void }> = ({ value, min, max, step = 1, onChange }) => (
  <input type="number" value={value} min={min} max={max} step={step} onChange={event => onChange(Number(event.target.value))} className="h-9 w-24 rounded-md border border-slate-300 px-2 text-right outline-none focus:border-[#2962ff]" />
);

const LineStyleInput: React.FC<{ value: 'solid' | 'dashed' | 'dotted'; onChange: (value: 'solid' | 'dashed' | 'dotted') => void }> = ({ value, onChange }) => (
  <select value={value} onChange={event => onChange(event.target.value as 'solid' | 'dashed' | 'dotted')} className="h-9 w-[118px] rounded-md border border-slate-300 px-2 text-[12px]">
    <option value="solid">Plná</option><option value="dashed">Čárkovaná</option><option value="dotted">Tečkovaná</option>
  </select>
);

const ColorInput: React.FC<{
  value: string;
  opacity?: number;
  onChange: (value: string, opacity: number) => void;
  label: string;
}> = ({ value, opacity, onChange, label }) => {
  return <TradingViewColorPicker
    value={value}
    opacity={opacity}
    label={label}
    onChange={(nextColor, nextOpacity) => {
      onChange(opacity === undefined ? colorWithAlpha(nextColor, nextOpacity) : nextColor, nextOpacity);
    }}
  />;
};

const VisibilityEditor: React.FC<{ value: IndicatorVisibilitySettings; onChange: (value: IndicatorVisibilitySettings) => void }> = ({ value, onChange }) => {
  const row = (key: 'minutes' | 'hours' | 'days', label: string, fromKey: 'minuteFrom' | 'hourFrom' | 'dayFrom', toKey: 'minuteTo' | 'hourTo' | 'dayTo') => (
    <div className="grid min-h-12 grid-cols-[150px_90px_90px] items-center gap-3">
      <Check checked={value[key]} onChange={checked => onChange({ ...value, [key]: checked })} label={label} />
      <NumberInput value={value[fromKey]} min={1} onChange={next => onChange({ ...value, [fromKey]: next })} />
      <NumberInput value={value[toKey]} min={1} onChange={next => onChange({ ...value, [toKey]: next })} />
    </div>
  );
  return <div className="space-y-1">{row('minutes', 'Minutes', 'minuteFrom', 'minuteTo')}{row('hours', 'Hours', 'hourFrom', 'hourTo')}{row('days', 'Days', 'dayFrom', 'dayTo')}</div>;
};

export const ChartIndicatorSettingsDialog: React.FC<{
  indicator: IndicatorId;
  settings: AlphaTradeIndicatorSettings;
  onPreview: (settings: AlphaTradeIndicatorSettings) => void;
  onCancel: () => void;
  /** `allPanels` odlišuje „Ok" (jen upravovaný graf) od „Na všechny grafy". */
  onApply: (settings: AlphaTradeIndicatorSettings, allPanels: boolean) => void;
}> = ({ indicator, settings, onPreview, onCancel, onApply }) => {
  const [tab, setTab] = useState<TabId>('inputs');
  const [draft, setDraft] = useState(settings);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  useEffect(() => { setDraft(settings); setTab('inputs'); setPosition({ x: 0, y: 0 }); }, [indicator]);
  const update = <K extends IndicatorId>(id: K, next: Partial<AlphaTradeIndicatorSettings[K]>) => {
    const value = { ...draft, [id]: { ...draft[id], ...next } } as AlphaTradeIndicatorSettings;
    setDraft(value);
    onPreview(value);
  };
  const applyIndicatorTemplate = (indicatorValue: unknown) => {
    const value = { ...draft, [indicator]: structuredClone(indicatorValue) } as AlphaTradeIndicatorSettings;
    setDraft(value);
    onPreview(value);
  };
  const current = draft[indicator];
  const styleFlags = current as { paneLabels: boolean; statusInputs: boolean };

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-transparent p-4" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={titles[indicator]}
        data-chart-settings-dialog="true"
        className={`flex max-h-[86vh] ${indicator === 'levels' ? 'w-[560px]' : 'w-[440px]'} max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-950 shadow-2xl`}
        style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }}
        onWheelCapture={event => event.stopPropagation()}
      >
        <header
          className="flex h-16 shrink-0 cursor-move select-none items-center justify-between px-6"
          onPointerDown={event => {
            if ((event.target as HTMLElement).closest('button')) return;
            dragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              originX: position.x,
              originY: position.y,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            const nextX = drag.originX + event.clientX - drag.startX;
            const nextY = drag.originY + event.clientY - drag.startY;
            const maxX = Math.max(0, window.innerWidth / 2 - 80);
            const maxY = Math.max(0, window.innerHeight / 2 - 60);
            setPosition({
              x: Math.max(-maxX, Math.min(maxX, nextX)),
              y: Math.max(-maxY, Math.min(maxY, nextY)),
            });
          }}
          onPointerUp={event => {
            if (dragRef.current?.pointerId !== event.pointerId) return;
            dragRef.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { dragRef.current = null; }}
        >
          <h2 className="text-xl font-semibold">{titles[indicator]}</h2>
          <button type="button" onClick={onCancel} className="cursor-pointer rounded-lg p-2 hover:bg-slate-100" aria-label="Zavřít nastavení"><X size={23} /></button>
        </header>
        <div className="flex h-11 shrink-0 items-end gap-7 border-b border-slate-200 px-6">
          {(['inputs', 'style', 'visibility'] as const).map(id => (
            <button key={id} type="button" onClick={() => setTab(id)} className={`h-11 border-b-2 px-0.5 text-[14px] font-semibold ${tab === id ? 'border-[#2962ff] text-slate-950' : 'border-transparent text-slate-600'}`}>
              {id === 'inputs' ? 'Inputs' : id === 'style' ? 'Style' : 'Visibility'}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
          {tab === 'inputs' && indicator === 'fvg' && (() => { const value = draft.fvg; return <div>
            <h3 className="mb-2 mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">📊 FVG</h3>
            <Check checked={value.enabled} onChange={enabled => update('fvg', { enabled })} label="Zobrazit FVG" />
            <Field label="Bull / Bear"><ColorInput label="Bullish FVG barva" value={value.bullColor} opacity={value.bullOpacity ?? value.fillOpacity} onChange={(bullColor, bullOpacity) => update('fvg', { bullColor, bullOpacity })} /><ColorInput label="Bearish FVG barva" value={value.bearColor} opacity={value.bearOpacity ?? value.fillOpacity} onChange={(bearColor, bearOpacity) => update('fvg', { bearColor, bearOpacity })} /></Field>
            <Field label="Mitig %"><NumberInput value={value.mitigatedTransparency} min={80} max={98} onChange={mitigatedTransparency => update('fvg', { mitigatedTransparency })} /></Field>
            <Field label="Max počet aktivních FVG"><NumberInput value={value.maxCount} min={1} max={30} onChange={maxCount => update('fvg', { maxCount })} /></Field>
            <Field label="Text"><input value={value.labelText} onChange={event => update('fvg', { labelText: event.target.value })} className="h-9 w-full rounded-md border border-slate-300 px-2 outline-none focus:border-[#2962ff]" /></Field>
            <Field label="Velikost"><select value={value.labelSize} onChange={event => update('fvg', { labelSize: event.target.value as FvgIndicatorSettings['labelSize'] })} className="h-9 w-full rounded-md border border-slate-300 px-2"><option value="tiny">Mikro</option><option value="small">Malé</option><option value="medium">Střední</option></select></Field>
            <Field label="Barva textu"><ColorInput label="Barva textu FVG" value={value.labelColor} onChange={labelColor => update('fvg', { labelColor })} /></Field>
          </div>; })()}
          {tab === 'inputs' && indicator === 'structure' && (() => { const value = draft.structure; return <div>
            <h3 className="mb-2 mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">BoS/ChoCh</h3>
            <Check checked={value.enabled} onChange={enabled => update('structure', { enabled })} label="Zobrazit BoS/ChoCh" />
            <Check checked={value.showBos} onChange={showBos => update('structure', { showBos })} label="Zobrazit BOS" />
            <Check checked={value.showChoch} onChange={showChoch => update('structure', { showChoch })} label="Zobrazit CHoCH" />
            <Field label="Bullish / Bearish"><ColorInput label="Bullish struktura" value={value.bullishColor} onChange={bullishColor => update('structure', { bullishColor })} /><ColorInput label="Bearish struktura" value={value.bearishColor} onChange={bearishColor => update('structure', { bearishColor })} /></Field>
            <Field label="Šířka čáry"><NumberInput value={value.lineWidth} min={1} max={4} onChange={lineWidth => update('structure', { lineWidth: lineWidth as StructureIndicatorSettings['lineWidth'] })} /></Field>
            <Field label="Velikost textu"><select value={value.textSize} onChange={event => update('structure', { textSize: event.target.value as StructureIndicatorSettings['textSize'] })} className="h-9 w-full rounded-md border border-slate-300 px-2"><option value="tiny">Mikro</option><option value="small">Malé</option><option value="medium">Střední</option><option value="large">Velké</option></select></Field>
            <Check checked={value.textBackground} onChange={textBackground => update('structure', { textBackground })} label="Zobrazit pozadí textu" />
            {value.textBackground && <Field label="Barva pozadí textu"><ColorInput label="Pozadí textu struktury" value={value.textBackgroundColor} onChange={textBackgroundColor => update('structure', { textBackgroundColor })} /></Field>}
          </div>; })()}
          {tab === 'inputs' && indicator === 'levels' && (() => { const value = draft.levels; const heading = (text: string) => <h3 className="mb-2 mt-6 first:mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">{text}</h3>; return <div>
            {heading('Sessions')}
            <Check checked={value.showAsia} onChange={showAsia => update('levels', { showAsia })} label="ASIA" />
            <Field label="Barva · čas · čáry"><ColorInput label="ASIA" value={value.asiaColor} onChange={asiaColor => update('levels', { asiaColor })} /><NumberInput value={value.asiaStart} min={0} max={23} onChange={asiaStart => update('levels', { asiaStart })} /><span>–</span><NumberInput value={value.asiaEnd} min={0} max={23} onChange={asiaEnd => update('levels', { asiaEnd })} /><input aria-label="ASIA čáry" type="checkbox" checked={value.showAsiaLines} onChange={event => update('levels', { showAsiaLines: event.target.checked })} className="h-5 w-5 accent-[#2962ff]" /></Field>
            <Check checked={value.showLondon} onChange={showLondon => update('levels', { showLondon })} label="LONDON" />
            <Field label="Barva · čas · čáry"><ColorInput label="LONDON" value={value.londonColor} onChange={londonColor => update('levels', { londonColor })} /><NumberInput value={value.londonStart} min={0} max={23} onChange={londonStart => update('levels', { londonStart })} /><span>–</span><NumberInput value={value.londonEnd} min={0} max={23} onChange={londonEnd => update('levels', { londonEnd })} /><input aria-label="LONDON čáry" type="checkbox" checked={value.showLondonLines} onChange={event => update('levels', { showLondonLines: event.target.checked })} className="h-5 w-5 accent-[#2962ff]" /></Field>
            <Check checked={value.showNewYork} onChange={showNewYork => update('levels', { showNewYork })} label="NEW YORK" />
            <Field label="Barva · čas · čáry"><ColorInput label="NEW YORK" value={value.newYorkColor} onChange={newYorkColor => update('levels', { newYorkColor })} /><NumberInput value={value.newYorkStart} min={0} max={23} onChange={newYorkStart => update('levels', { newYorkStart })} /><span>–</span><NumberInput value={value.newYorkEnd} min={0} max={23} onChange={newYorkEnd => update('levels', { newYorkEnd })} /><input aria-label="NEW YORK čáry" type="checkbox" checked={value.showNewYorkLines} onChange={event => update('levels', { showNewYorkLines: event.target.checked })} className="h-5 w-5 accent-[#2962ff]" /></Field>
            <Field label="Tloušťka · styl"><NumberInput value={value.sessionLineWidth} min={1} max={4} onChange={sessionLineWidth => update('levels', { sessionLineWidth: sessionLineWidth as LevelsIndicatorSettings['sessionLineWidth'] })} /><LineStyleInput value={value.sessionLineStyle} onChange={sessionLineStyle => update('levels', { sessionLineStyle })} /></Field>
            <Check checked={value.showSessionBoxes} onChange={showSessionBoxes => update('levels', { showSessionBoxes })} label="Boxy" />
            <Field label="Průhlednost boxů"><NumberInput value={value.sessionBoxTransparency} min={80} max={98} onChange={sessionBoxTransparency => update('levels', { sessionBoxTransparency })} /></Field>

            {heading('Denní / týdenní')}
            <Check checked={value.currentDay} onChange={currentDay => update('levels', { currentDay })} label="Current Day H/L" />
            <Field label="Barva · tloušťka · styl"><ColorInput label="Current Day" value={value.currentDayColor} onChange={currentDayColor => update('levels', { currentDayColor })} /><NumberInput value={value.currentDayWidth} min={1} max={4} onChange={currentDayWidth => update('levels', { currentDayWidth: currentDayWidth as LevelsIndicatorSettings['currentDayWidth'] })} /><LineStyleInput value={value.currentDayStyle} onChange={currentDayStyle => update('levels', { currentDayStyle })} /></Field>
            <Check checked={value.priorDay} onChange={priorDay => update('levels', { priorDay })} label="PDH/PDL" />
            <Field label="Barva · tloušťka · styl"><ColorInput label="PDH PDL" value={value.priorDayColor} onChange={priorDayColor => update('levels', { priorDayColor })} /><NumberInput value={value.priorDayWidth} min={1} max={4} onChange={priorDayWidth => update('levels', { priorDayWidth: priorDayWidth as LevelsIndicatorSettings['priorDayWidth'] })} /><LineStyleInput value={value.priorDayStyle} onChange={priorDayStyle => update('levels', { priorDayStyle })} /></Field>
            <Check checked={value.priorWeek} onChange={priorWeek => update('levels', { priorWeek })} label="PWH/PWL" />
            <Field label="Barva · tloušťka · styl"><ColorInput label="PWH PWL" value={value.priorWeekColor} onChange={priorWeekColor => update('levels', { priorWeekColor })} /><NumberInput value={value.priorWeekWidth} min={1} max={4} onChange={priorWeekWidth => update('levels', { priorWeekWidth: priorWeekWidth as LevelsIndicatorSettings['priorWeekWidth'] })} /><LineStyleInput value={value.priorWeekStyle} onChange={priorWeekStyle => update('levels', { priorWeekStyle })} /></Field>
            <Check checked={value.showOpen} onChange={showOpen => update('levels', { showOpen, dayOpen: showOpen, weekOpen: showOpen })} label="Day Open · Week Open" />
            <Field label="DO · WO barva"><ColorInput label="Day Open" value={value.dayOpenColor} onChange={dayOpenColor => update('levels', { dayOpenColor })} /><ColorInput label="Week Open" value={value.weekOpenColor} onChange={weekOpenColor => update('levels', { weekOpenColor })} /></Field>
            <Field label="Tloušťka · styl"><NumberInput value={value.openWidth} min={1} max={4} onChange={openWidth => update('levels', { openWidth: openWidth as LevelsIndicatorSettings['openWidth'] })} /><LineStyleInput value={value.openStyle} onChange={openStyle => update('levels', { openStyle })} /></Field>

            {heading('VWAP')}
            <Check checked={value.showVwap} onChange={showVwap => update('levels', { showVwap })} label="Zobrazit VWAP" />
            <Field label="VWAP barva"><ColorInput label="VWAP" value={value.vwapColor} onChange={vwapColor => update('levels', { vwapColor })} /></Field>
            <Check checked={value.showPrevVwap} onChange={showPrevVwap => update('levels', { showPrevVwap })} label="Zobrazit Prev VWAP" />
            <Check checked={value.showDeviations} onChange={showDeviations => update('levels', { showDeviations })} label="Zobrazit Deviace" />
            <Field label="Bands barva"><ColorInput label="VWAP bands" value={value.bandsColor} onChange={bandsColor => update('levels', { bandsColor })} /></Field>
            <Field label="Deviace 1"><NumberInput value={value.dev1Multiplier} step={0.5} onChange={dev1Multiplier => update('levels', { dev1Multiplier })} /></Field>
            <Field label="Deviace 2"><NumberInput value={value.dev2Multiplier} step={0.5} onChange={dev2Multiplier => update('levels', { dev2Multiplier })} /></Field>
            <Field label="Prev VWAP tloušťka · styl"><NumberInput value={value.prevVwapWidth} min={1} max={4} onChange={prevVwapWidth => update('levels', { prevVwapWidth: prevVwapWidth as LevelsIndicatorSettings['prevVwapWidth'] })} /><LineStyleInput value={value.prevVwapStyle} onChange={prevVwapStyle => update('levels', { prevVwapStyle })} /></Field>

            {heading('Vzhled')}
            <Field label="Časové pásmo"><input value={value.timezone} onChange={event => update('levels', { timezone: event.target.value })} className="h-9 w-full rounded-md border border-slate-300 px-2" /></Field>
            <Check checked={value.showLabels} onChange={showLabels => update('levels', { showLabels })} label="Popisky" />
            <Field label="Velikost popisků"><select value={value.labelSize} onChange={event => update('levels', { labelSize: event.target.value as LevelsIndicatorSettings['labelSize'] })} className="h-9 w-full rounded-md border border-slate-300 px-2"><option value="small">Malé</option><option value="medium">Střední</option><option value="large">Velké</option></select></Field>
            <Field label="Prodloužení"><NumberInput value={value.extendLines} min={0} max={100} onChange={extendLines => update('levels', { extendLines })} /></Field>
            <Check checked={value.showZones} onChange={showZones => update('levels', { showZones })} label="Zóny" />
            <Field label="Velikost zóny"><NumberInput value={value.zoneSize} min={0.5} max={10} step={0.5} onChange={zoneSize => update('levels', { zoneSize })} /></Field>

            {heading('Bias & Kontext')}
            <Check checked={value.showOvernight} onChange={showOvernight => update('levels', { showOvernight })} label="ON High/Low (overnight extrémy)" />
            <Field label="ON barva"><ColorInput label="ON High Low" value={value.overnightColor} onChange={overnightColor => update('levels', { overnightColor })} /></Field>
            <Check checked={value.showCompass} onChange={showCompass => update('levels', { showCompass })} label="Kompas: PDC · PD MID · ON MID · RTH Open" />
            <Field label="Kompas barva"><ColorInput label="Kompas" value={value.compassColor} onChange={compassColor => update('levels', { compassColor })} /></Field>
            <Check checked={value.showInitialBalance} onChange={showInitialBalance => update('levels', { showInitialBalance })} label="IB High/Low (první hodina RTH)" />
            <Field label="IB barva"><ColorInput label="Initial Balance" value={value.initialBalanceColor} onChange={initialBalanceColor => update('levels', { initialBalanceColor })} /></Field>
            <Field label="RTH open"><NumberInput value={value.rthOpenHour} min={0} max={23} onChange={rthOpenHour => update('levels', { rthOpenHour })} /><span>:</span><NumberInput value={value.rthOpenMinute} min={0} max={59} onChange={rthOpenMinute => update('levels', { rthOpenMinute })} /></Field>
            <Check checked={value.showBiasTable} onChange={showBiasTable => update('levels', { showBiasTable })} label="Bias tabulka (vpravo nahoře)" />
          </div>; })()}
          {tab === 'style' && <div>
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">Graphic objects</h3>
            {indicator === 'fvg' && <Check checked={draft.fvg.boxes} onChange={boxes => update('fvg', { boxes })} label="Boxes" />}
            <Check checked={styleFlags.paneLabels} onChange={paneLabels => update(indicator, { paneLabels } as never)} label="Pane labels" />
            <h3 className="mb-3 mt-6 text-xs font-medium uppercase tracking-wide text-slate-500">Input values</h3>
            <Check checked={styleFlags.statusInputs} onChange={statusInputs => update(indicator, { statusInputs } as never)} label="Inputs in status line" />
          </div>}
          {tab === 'visibility' && <VisibilityEditor value={current.visibility} onChange={visibility => update(indicator, { visibility } as never)} />}
        </div>
        <footer className="relative flex h-16 shrink-0 items-center justify-between border-t border-slate-200 px-6">
          <IndicatorTemplateMenu
            indicator={indicator}
            value={draft[indicator]}
            defaultValue={DEFAULT_INDICATOR_SETTINGS[indicator]}
            onApply={applyIndicatorTemplate}
          />
          <div className="flex gap-3">
            <button type="button" onClick={onCancel} className="h-9 rounded-md border border-slate-300 px-5 text-[13px] font-medium hover:bg-slate-50">Cancel</button>
            <button
              type="button"
              onClick={() => onApply(draft, true)}
              title="Přepíše nastavení indikátorů ve všech grafech workspace"
              className="h-9 rounded-md border border-slate-300 px-4 text-[13px] font-medium hover:bg-slate-50"
            >Na všechny grafy</button>
            <button type="button" onClick={() => onApply(draft, false)} className="h-9 rounded-md bg-[#2962ff] px-6 text-[13px] font-semibold text-white hover:bg-[#1e53e5]">Ok</button>
          </div>
        </footer>
      </section>
    </div>
  );
};

export default ChartIndicatorSettingsDialog;
