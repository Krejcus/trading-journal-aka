import React, { useEffect, useRef, useState } from 'react';
import { CandlestickChart, LayoutGrid, Rows3, Ruler, X, Zap } from 'lucide-react';
import TradingViewColorPicker from './TradingViewColorPicker';
import IndicatorTemplateMenu from './IndicatorTemplateMenu';
import {
  CHART_PRECISIONS,
  CHART_TIME_ZONES,
  mergeChartSettings,
  type ChartButtonVisibility,
  type ChartExecutionMarkerSize,
  type ChartGridLines,
  type ChartLineAppearance,
  type ChartLineStyleName,
  type ChartPrecision,
  type ChartPriceLabelSettings,
  type ChartPriceLineExtent,
  type ChartScalesPlacement,
  type ChartSettings,
  type ChartWatermarkMode,
  defaultChartSettings,
} from '../services/chartSettings';
import { CHART_DATE_FORMATS, formatChartDate, type ChartDateFormat, zonedTimeParts } from '../services/chartTimeAxisFormat';

type TabId = 'symbol' | 'statusLine' | 'scales' | 'trading' | 'canvas';

/** Jmenný prostor v úložišti šablon, aby se nemíchaly s šablonami indikátorů. */
const CHART_SETTINGS_TEMPLATE_NAMESPACE = 'chart-settings';

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'symbol', label: 'Symbol', icon: <CandlestickChart size={15} strokeWidth={1.6} /> },
  { id: 'statusLine', label: 'Stavový řádek', icon: <Rows3 size={15} strokeWidth={1.6} /> },
  { id: 'scales', label: 'Osy a čáry', icon: <Ruler size={15} strokeWidth={1.6} /> },
  { id: 'trading', label: 'Obchodování', icon: <Zap size={15} strokeWidth={1.6} /> },
  { id: 'canvas', label: 'Plátno', icon: <LayoutGrid size={15} strokeWidth={1.6} /> },
];

const PRECISION_LABELS: Record<string, string> = {
  default: 'Výchozí',
  integer: 'Celé číslo',
};

const precisionLabel = (precision: ChartPrecision): string => {
  if (typeof precision === 'number') return precision === 1 ? '1 desetinné místo' : `${precision} desetinných míst`;
  return PRECISION_LABELS[precision] ?? precision;
};

const VISIBILITY_LABELS: Record<ChartButtonVisibility, string> = {
  hover: 'Viditelné při najetí myší',
  always: 'Vždy viditelné',
  never: 'Vždy skryté',
};

const LINE_STYLE_LABELS: Record<ChartLineStyleName, string> = {
  solid: 'Plná',
  dotted: 'Tečkovaná',
  dashed: 'Čárkovaná',
  'large-dashed': 'Dlouhé čárky',
  'sparse-dotted': 'Řídké tečky',
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="mb-6 last:mb-0">
    <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">{title}</h3>
    {children}
  </section>
);

const Row: React.FC<{ label?: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-1 text-[13px] text-slate-800">
    <span className="min-w-0">{label}</span>
    {/* Užší dialog: ovládací prvky se v těsném řádku zalomí místo přetečení. */}
    <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5">{children}</span>
  </div>
);

const Check: React.FC<{ checked: boolean; onChange: (checked: boolean) => void; label: string }> = ({ checked, onChange, label }) => (
  <label className="flex min-h-10 cursor-pointer items-center gap-3 text-[13px] text-slate-800">
    <input
      type="checkbox"
      checked={checked}
      onChange={event => onChange(event.target.checked)}
      className="h-[18px] w-[18px] accent-[#2962ff]"
    />
    <span>{label}</span>
  </label>
);

const Select = <T extends string | number>({ value, options, onChange, width = 'w-[168px]' }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  width?: string;
}) => (
  <select
    value={String(value)}
    onChange={event => {
      const next = options.find(option => String(option.value) === event.target.value);
      if (next) onChange(next.value);
    }}
    className={`h-8 ${width} rounded-md border border-slate-300 bg-white px-2 text-[12px] outline-none focus:border-[#2962ff]`}
  >
    {options.map(option => (
      <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
    ))}
  </select>
);

const NumberInput: React.FC<{
  value: number;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}> = ({ value, min, max, step = 1, suffix, onChange }) => (
  <span className="flex items-center gap-1">
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={event => onChange(Number(event.target.value))}
      className="h-8 w-[74px] rounded-md border border-slate-300 px-2 text-right text-[12px] outline-none focus:border-[#2962ff]"
    />
    {suffix && <span className="text-[12px] text-slate-500">{suffix}</span>}
  </span>
);

/** Barva + tloušťka + styl čáry pohromadě, jak je nabízí TradingView. */
const LineAppearance: React.FC<{
  label: string;
  value: ChartLineAppearance;
  onChange: (value: ChartLineAppearance) => void;
}> = ({ label, value, onChange }) => (
  <>
    <TradingViewColorPicker label={label} value={value.color} onChange={color => onChange({ ...value, color })} />
    <Select
      value={value.width}
      width="w-[56px]"
      options={[1, 2, 3, 4].map(width => ({ value: width as 1 | 2 | 3 | 4, label: `${width} px` }))}
      onChange={width => onChange({ ...value, width })}
    />
    <Select
      value={value.style}
      width="w-[104px]"
      options={(Object.keys(LINE_STYLE_LABELS) as ChartLineStyleName[]).map(style => ({
        value: style,
        label: LINE_STYLE_LABELS[style],
      }))}
      onChange={style => onChange({ ...value, style })}
    />
  </>
);

/** Řádek popisku na cenové ose: volba hodnota/čára (+ volitelně název) a vzhled. */
const PriceLabelRow: React.FC<{
  label: string;
  value: ChartPriceLabelSettings;
  withName?: boolean;
  withAppearance?: boolean;
  onChange: (value: ChartPriceLabelSettings) => void;
  children?: React.ReactNode;
}> = ({ label, value, withName = false, withAppearance = true, onChange, children }) => (
  <div className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-1 text-[13px] text-slate-800">
    <span className="pt-1.5">{label}</span>
    <div className="flex flex-col items-end gap-1.5">
      <span className="flex items-center gap-3">
        {withName && (
          <label className="flex cursor-pointer items-center gap-1.5 text-[12px]">
            <input type="checkbox" checked={Boolean(value.name)} onChange={event => onChange({ ...value, name: event.target.checked })} className="h-[15px] w-[15px] accent-[#2962ff]" />
            Název
          </label>
        )}
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px]">
          <input type="checkbox" checked={value.value} onChange={event => onChange({ ...value, value: event.target.checked })} className="h-[15px] w-[15px] accent-[#2962ff]" />
          Hodnota
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px]">
          <input type="checkbox" checked={value.line} onChange={event => onChange({ ...value, line: event.target.checked })} className="h-[15px] w-[15px] accent-[#2962ff]" />
          Čára
        </label>
      </span>
      {withAppearance && value.appearance && (
        <span className="flex items-center gap-2">
          {/* Rozsah dává smysl jen když čára vůbec je — jinak by šlo o mrtvý ovladač. */}
          {value.line && (
            <select
              value={value.lineExtent ?? 'full'}
              onChange={event => onChange({ ...value, lineExtent: event.target.value as ChartPriceLineExtent })}
              className="h-7 rounded border border-slate-300 bg-white px-1.5 text-[12px] text-slate-800"
              aria-label={`Rozsah čáry — ${label}`}
              title="Kam až čára sahá"
            >
              <option value="full">Celý graf</option>
              <option value="fromPoint">Od svíčky doprava</option>
            </select>
          )}
          <LineAppearance label={label} value={value.appearance} onChange={appearance => onChange({ ...value, appearance })} />
        </span>
      )}
      {children}
    </div>
  </div>
);

export interface ChartSettingsDialogProps {
  settings: ChartSettings;
  isDark: boolean;
  onPreview: (settings: ChartSettings) => void;
  onCancel: () => void;
  /** `allPanels` odlišuje „Ok" (jen upravovaný graf) od „Na všechny grafy". */
  onApply: (settings: ChartSettings, allPanels: boolean) => void;
}

export const ChartSettingsDialog: React.FC<ChartSettingsDialogProps> = ({
  settings,
  isDark,
  onPreview,
  onCancel,
  onApply,
}) => {
  const [tab, setTab] = useState<TabId>('symbol');
  const [draft, setDraft] = useState(settings);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape nad otevřenou paletou patří paletě, ne celému dialogu — jinak by
      // zavření výběru barvy zahodilo i všechny rozpracované změny.
      if (document.querySelector('[data-tv-color-picker]')) return;
      onCancel();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onCancel]);

  const commit = (next: ChartSettings) => {
    setDraft(next);
    onPreview(next);
  };
  const update = <K extends keyof ChartSettings>(key: K, patch: Partial<ChartSettings[K]>) => {
    commit({ ...draft, [key]: { ...draft[key], ...patch } });
  };

  const { symbol, statusLine, scales, trading, canvas } = draft;
  // Vzorek data v náhledu formátu je stejný, jaký ukazuje TradingView.
  const sampleParts = zonedTimeParts(Date.UTC(1997, 8, 29, 12) / 1_000, symbol.timeZone);

  return (
    <div
      className="fixed inset-0 z-[10030] flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Nastavení grafu"
        data-chart-settings-dialog="chart"
        className="flex h-[560px] max-h-[88vh] w-[544px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-950 shadow-2xl"
        style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }}
        onWheelCapture={event => event.stopPropagation()}
        onPointerDown={event => event.stopPropagation()}
        onContextMenu={event => event.preventDefault()}
      >
        <header
          className="flex h-14 shrink-0 cursor-move select-none items-center justify-between border-b border-slate-200 px-5"
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
            const maxX = Math.max(0, window.innerWidth / 2 - 80);
            const maxY = Math.max(0, window.innerHeight / 2 - 60);
            setPosition({
              x: Math.max(-maxX, Math.min(maxX, drag.originX + event.clientX - drag.startX)),
              y: Math.max(-maxY, Math.min(maxY, drag.originY + event.clientY - drag.startY)),
            });
          }}
          onPointerUp={event => {
            if (dragRef.current?.pointerId !== event.pointerId) return;
            dragRef.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { dragRef.current = null; }}
        >
          <h2 className="text-[19px] font-semibold">Nastavení</h2>
          <button type="button" onClick={onCancel} className="rounded-lg p-2 hover:bg-slate-100" aria-label="Zavřít nastavení">
            <X size={20} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav className="w-[158px] shrink-0 border-r border-slate-200 py-2" aria-label="Sekce nastavení">
            {TABS.map(item => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
                className={`flex h-9 w-full items-center gap-2 px-3 text-left text-[12.5px] ${tab === item.id ? 'bg-slate-100 font-semibold text-slate-950' : 'text-slate-600 hover:bg-slate-50'}`}
              >
                <span className="text-slate-500">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {tab === 'symbol' && (
              <>
                <Section title="Svíčky">
                  <Check
                    checked={symbol.colorBarsBasedOnPreviousClose}
                    onChange={colorBarsBasedOnPreviousClose => update('symbol', { colorBarsBasedOnPreviousClose })}
                    label="Barvit svíčky podle předchozího close"
                  />
                  <Row label="">
                    <Check checked={symbol.bodyVisible} onChange={bodyVisible => update('symbol', { bodyVisible })} label="Tělo" />
                    <TradingViewColorPicker label="Tělo rostoucí svíčky" value={symbol.bodyUpColor} onChange={bodyUpColor => update('symbol', { bodyUpColor })} />
                    <TradingViewColorPicker label="Tělo klesající svíčky" value={symbol.bodyDownColor} onChange={bodyDownColor => update('symbol', { bodyDownColor })} />
                  </Row>
                  <Row label="">
                    <Check checked={symbol.bordersVisible} onChange={bordersVisible => update('symbol', { bordersVisible })} label="Obrys" />
                    <TradingViewColorPicker label="Obrys rostoucí svíčky" value={symbol.borderUpColor} onChange={borderUpColor => update('symbol', { borderUpColor })} />
                    <TradingViewColorPicker label="Obrys klesající svíčky" value={symbol.borderDownColor} onChange={borderDownColor => update('symbol', { borderDownColor })} />
                  </Row>
                  <Row label="">
                    <Check checked={symbol.wickVisible} onChange={wickVisible => update('symbol', { wickVisible })} label="Knot" />
                    <TradingViewColorPicker label="Knot rostoucí svíčky" value={symbol.wickUpColor} onChange={wickUpColor => update('symbol', { wickUpColor })} />
                    <TradingViewColorPicker label="Knot klesající svíčky" value={symbol.wickDownColor} onChange={wickDownColor => update('symbol', { wickDownColor })} />
                  </Row>
                </Section>
                <Section title="Úprava dat">
                  <Row label="Přesnost">
                    <Select
                      value={String(symbol.precision)}
                      options={CHART_PRECISIONS.map(precision => ({ value: String(precision), label: precisionLabel(precision) }))}
                      onChange={next => {
                        const precision = CHART_PRECISIONS.find(item => String(item) === next);
                        if (precision !== undefined) update('symbol', { precision });
                      }}
                    />
                  </Row>
                  <Row label="Časové pásmo">
                    <Select
                      value={symbol.timeZone}
                      options={CHART_TIME_ZONES.map(zone => ({ value: zone.id, label: zone.label }))}
                      onChange={timeZone => update('symbol', { timeZone })}
                    />
                  </Row>
                </Section>
              </>
            )}

            {tab === 'statusLine' && (
              <>
                <Section title="Symbol">
                  <Check checked={statusLine.symbolTitle} onChange={symbolTitle => update('statusLine', { symbolTitle })} label="Název" />
                  <Check checked={statusLine.symbolDescription} onChange={symbolDescription => update('statusLine', { symbolDescription })} label="Popis" />
                  <Check checked={statusLine.chartValues} onChange={chartValues => update('statusLine', { chartValues })} label="Hodnoty grafu (OHLC)" />
                  <Check checked={statusLine.barChangeValues} onChange={barChangeValues => update('statusLine', { barChangeValues })} label="Změna svíčky" />
                  <Check checked={statusLine.volume} onChange={volume => update('statusLine', { volume })} label="Objem" />
                </Section>
                <Section title="Indikátory">
                  <Check checked={statusLine.indicatorTitles} onChange={indicatorTitles => update('statusLine', { indicatorTitles })} label="Názvy" />
                  <Check checked={statusLine.indicatorInputs} onChange={indicatorInputs => update('statusLine', { indicatorInputs })} label="Vstupy" />
                  <Check checked={statusLine.indicatorValues} onChange={indicatorValues => update('statusLine', { indicatorValues })} label="Hodnoty" />
                  <Check checked={statusLine.indicatorBackground} onChange={indicatorBackground => update('statusLine', { indicatorBackground })} label="Pozadí" />
                </Section>
              </>
            )}

            {tab === 'scales' && (
              <>
                <Section title="Cenová osa">
                  <Row label="Tlačítka režimů (A a L)">
                    <Select
                      value={scales.scaleModeButtons}
                      options={(Object.keys(VISIBILITY_LABELS) as ChartButtonVisibility[]).map(id => ({ value: id, label: VISIBILITY_LABELS[id] }))}
                      onChange={scaleModeButtons => update('scales', { scaleModeButtons })}
                    />
                  </Row>
                  <div className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                    <Check
                      checked={scales.lockPriceToBarRatio}
                      onChange={lockPriceToBarRatio => update('scales', { lockPriceToBarRatio })}
                      label="Zamknout poměr ceny ke svíčce"
                    />
                    <NumberInput
                      value={scales.priceToBarRatio}
                      min={0.000001}
                      step={0.000001}
                      onChange={priceToBarRatio => update('scales', { priceToBarRatio })}
                    />
                  </div>
                  <Row label="Umístění os">
                    <Select
                      value={scales.placement}
                      options={([
                        ['left', 'Vlevo'],
                        ['right', 'Vpravo'],
                        ['auto', 'Automaticky'],
                      ] as [ChartScalesPlacement, string][]).map(([value, label]) => ({ value, label }))}
                      onChange={placement => update('scales', { placement })}
                    />
                  </Row>
                </Section>

                <Section title="Popisky a čáry ceny">
                  <Check checked={scales.noOverlappingLabels} onChange={noOverlappingLabels => update('scales', { noOverlappingLabels })} label="Nepřekrývat popisky" />
                  <Check checked={scales.plusButton} onChange={plusButton => update('scales', { plusButton })} label="Tlačítko plus" />
                  <Check checked={scales.countdownToBarClose} onChange={countdownToBarClose => update('scales', { countdownToBarClose })} label="Odpočet do uzavření svíčky" />
                  <PriceLabelRow
                    label="Symbol"
                    value={scales.symbolLabel}
                    onChange={symbolLabel => update('scales', { symbolLabel })}
                  >
                    <Select
                      value={scales.symbolLastValueMode}
                      width="w-[196px]"
                      options={[
                        { value: 'priceAndPercentage' as const, label: 'Cena a procentní hodnota' },
                        { value: 'valueAccordingToScale' as const, label: 'Hodnota podle osy' },
                      ]}
                      onChange={symbolLastValueMode => update('scales', { symbolLastValueMode })}
                    />
                  </PriceLabelRow>
                  <PriceLabelRow
                    label="Předchozí denní close"
                    value={scales.previousDayClose}
                    onChange={previousDayClose => update('scales', { previousDayClose })}
                  />
                  <Row label="Indikátory a finanční data">
                    <label className="flex cursor-pointer items-center gap-1.5 text-[12px]">
                      <input
                        type="checkbox"
                        checked={scales.indicatorsAndFinancials.name}
                        onChange={event => update('scales', { indicatorsAndFinancials: { ...scales.indicatorsAndFinancials, name: event.target.checked } })}
                        className="h-[15px] w-[15px] accent-[#2962ff]"
                      />
                      Název
                    </label>
                    <label className="flex cursor-pointer items-center gap-1.5 text-[12px]">
                      <input
                        type="checkbox"
                        checked={scales.indicatorsAndFinancials.value}
                        onChange={event => update('scales', { indicatorsAndFinancials: { ...scales.indicatorsAndFinancials, value: event.target.checked } })}
                        className="h-[15px] w-[15px] accent-[#2962ff]"
                      />
                      Hodnota
                    </label>
                  </Row>
                  <PriceLabelRow
                    label="Maximum a minimum"
                    value={scales.highAndLow}
                    onChange={highAndLow => update('scales', { highAndLow })}
                  />
                </Section>

                <Section title="Časová osa">
                  <Check checked={scales.dayOfWeekOnLabels} onChange={dayOfWeekOnLabels => update('scales', { dayOfWeekOnLabels })} label="Den v týdnu u popisků" />
                  <Row label="Formát data">
                    <Select
                      value={scales.dateFormat}
                      width="w-[196px]"
                      options={CHART_DATE_FORMATS.map(format => ({
                        value: format as ChartDateFormat,
                        label: formatChartDate(sampleParts, format),
                      }))}
                      onChange={dateFormat => update('scales', { dateFormat })}
                    />
                  </Row>
                  <Row label="Formát hodin">
                    <Select
                      value={scales.hour12 ? '12' : '24'}
                      width="w-[140px]"
                      options={[
                        { value: '24', label: '24hodinový' },
                        { value: '12', label: '12hodinový' },
                      ]}
                      onChange={value => update('scales', { hour12: value === '12' })}
                    />
                  </Row>
                  <Check
                    checked={scales.keepLeftEdgeOnIntervalChange}
                    onChange={keepLeftEdgeOnIntervalChange => update('scales', { keepLeftEdgeOnIntervalChange })}
                    label="Zachovat levý okraj grafu při změně intervalu"
                  />
                </Section>
              </>
            )}

            {tab === 'trading' && (
              <>
                <Section title="Rychlé objednávky">
                  <Check
                    checked={trading.quickOrderButton}
                    onChange={quickOrderButton => update('trading', { quickOrderButton })}
                    label="Zobrazit blesk Quick Order u position boxu"
                  />
                  <Check
                    checked={trading.positionBoxes}
                    onChange={positionBoxes => update('trading', { positionBoxes })}
                    label="Zobrazit automatický position box"
                  />
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                    Blesk okamžitě vytvoří Market, Limit nebo Stop objednávku podle position boxu. Box lze skrýt a ponechat jen fill markery.
                  </p>
                </Section>

                <Section title="Objednávky a pozice">
                  <Check
                    checked={trading.orderLines}
                    onChange={orderLines => update('trading', { orderLines })}
                    label="Zobrazit čáry objednávek, pozice, SL a TP"
                  />
                </Section>

                <Section title="Provedené obchody">
                  <Check
                    checked={trading.tradeLines}
                    onChange={tradeLines => update('trading', { tradeLines })}
                    label="Zobrazit spojnici vstupu a výstupu"
                  />
                  <Check
                    checked={trading.executionMarkers}
                    onChange={executionMarkers => update('trading', { executionMarkers })}
                    label="Zobrazit trojúhelníky jednotlivých fillů"
                  />
                  {trading.executionMarkers && (
                    <Row label="Velikost trojúhelníků">
                      <Select
                        value={trading.executionMarkerSize}
                        width="w-[136px]"
                        options={([
                          ['small', 'Malá'],
                          ['medium', 'Střední'],
                          ['large', 'Velká'],
                        ] as [ChartExecutionMarkerSize, string][]).map(([value, label]) => ({ value, label }))}
                        onChange={executionMarkerSize => update('trading', { executionMarkerSize })}
                      />
                    </Row>
                  )}
                </Section>
              </>
            )}

            {tab === 'canvas' && (
              <>
                <Section title="Základní styly grafu">
                  <Row label="Pozadí">
                    <Select
                      value={canvas.backgroundType}
                      width="w-[130px]"
                      options={[
                        { value: 'solid' as const, label: 'Jednolité' },
                        { value: 'gradient' as const, label: 'Přechod' },
                      ]}
                      onChange={backgroundType => update('canvas', { backgroundType })}
                    />
                    {canvas.backgroundType === 'solid'
                      ? <TradingViewColorPicker label="Barva pozadí" value={canvas.backgroundColor} onChange={backgroundColor => update('canvas', { backgroundColor })} />
                      : (
                        <>
                          <TradingViewColorPicker label="Přechod nahoře" value={canvas.backgroundGradientTop} onChange={backgroundGradientTop => update('canvas', { backgroundGradientTop })} />
                          <TradingViewColorPicker label="Přechod dole" value={canvas.backgroundGradientBottom} onChange={backgroundGradientBottom => update('canvas', { backgroundGradientBottom })} />
                        </>
                      )}
                  </Row>
                  <Row label="Mřížka">
                    <Select
                      value={canvas.gridLines}
                      width="w-[150px]"
                      options={([
                        ['both', 'Svislé i vodorovné'],
                        ['vert', 'Jen svislé'],
                        ['horz', 'Jen vodorovné'],
                        ['none', 'Žádné'],
                      ] as [ChartGridLines, string][]).map(([value, label]) => ({ value, label }))}
                      onChange={gridLines => update('canvas', { gridLines })}
                    />
                    <TradingViewColorPicker label="Svislé čáry mřížky" value={canvas.gridVertColor} onChange={gridVertColor => update('canvas', { gridVertColor })} />
                    <TradingViewColorPicker label="Vodorovné čáry mřížky" value={canvas.gridHorzColor} onChange={gridHorzColor => update('canvas', { gridHorzColor })} />
                  </Row>
                  <div className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                    <Check checked={canvas.sessionBreaks} onChange={sessionBreaks => update('canvas', { sessionBreaks })} label="Předěly seancí" />
                    <span className="flex items-center gap-2">
                      <LineAppearance label="Předěl seance" value={canvas.sessionBreak} onChange={sessionBreak => update('canvas', { sessionBreak })} />
                    </span>
                  </div>
                  <Row label="Křížový kurzor">
                    <LineAppearance label="Křížový kurzor" value={canvas.crosshair} onChange={crosshair => update('canvas', { crosshair })} />
                  </Row>
                  <Row label="Vodoznak">
                    <Select
                      value={canvas.watermark}
                      width="w-[150px]"
                      options={([
                        ['hidden', 'Skrytý'],
                        ['ticker', 'Ticker'],
                        ['interval', 'Interval'],
                        ['description', 'Popis'],
                      ] as [ChartWatermarkMode, string][]).map(([value, label]) => ({ value, label }))}
                      onChange={watermark => update('canvas', { watermark })}
                    />
                    <TradingViewColorPicker label="Barva vodoznaku" value={canvas.watermarkColor} onChange={watermarkColor => update('canvas', { watermarkColor })} />
                  </Row>
                </Section>

                <Section title="Osy">
                  <Row label="Text">
                    <Select
                      value={canvas.scalesTextSize}
                      width="w-[80px]"
                      options={[8, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 40].map(size => ({ value: size, label: String(size) }))}
                      onChange={scalesTextSize => update('canvas', { scalesTextSize })}
                    />
                    <TradingViewColorPicker label="Barva textu os" value={canvas.scalesTextColor} onChange={scalesTextColor => update('canvas', { scalesTextColor })} />
                  </Row>
                  <Row label="Čáry">
                    <TradingViewColorPicker label="Barva čar os" value={canvas.scalesLineColor} onChange={scalesLineColor => update('canvas', { scalesLineColor })} />
                  </Row>
                </Section>

                <Section title="Tlačítka">
                  <Row label="Navigace">
                    <Select
                      value={canvas.navigationButtons}
                      options={(Object.keys(VISIBILITY_LABELS) as ChartButtonVisibility[]).map(id => ({ value: id, label: VISIBILITY_LABELS[id] }))}
                      onChange={navigationButtons => update('canvas', { navigationButtons })}
                    />
                  </Row>
                  <Row label="Panel">
                    <Select
                      value={canvas.paneButtons}
                      options={(Object.keys(VISIBILITY_LABELS) as ChartButtonVisibility[]).map(id => ({ value: id, label: VISIBILITY_LABELS[id] }))}
                      onChange={paneButtons => update('canvas', { paneButtons })}
                    />
                  </Row>
                </Section>

                <Section title="Okraje">
                  <Row label="Nahoře">
                    <NumberInput value={canvas.marginTop} min={0} max={90} suffix="%" onChange={marginTop => update('canvas', { marginTop })} />
                  </Row>
                  <Row label="Dole">
                    <NumberInput value={canvas.marginBottom} min={0} max={90} suffix="%" onChange={marginBottom => update('canvas', { marginBottom })} />
                  </Row>
                  <Row label="Vpravo">
                    <NumberInput value={canvas.marginRight} min={0} max={200} suffix="svíček" onChange={marginRight => update('canvas', { marginRight })} />
                  </Row>
                </Section>
              </>
            )}
          </div>
        </div>

        <footer className="relative flex h-14 shrink-0 items-center justify-between border-t border-slate-200 px-5">
          <IndicatorTemplateMenu
            indicator={CHART_SETTINGS_TEMPLATE_NAMESPACE}
            value={draft}
            defaultValue={defaultChartSettings(isDark)}
            menuLabel="Šablony nastavení grafu"
            fallbackLabel="Šablona"
            namePlaceholder="Např. Tmavé svíčky"
            // Uložená šablona může být starší než dnešní model, proto se slévá
            // s výchozím nastavením, ne aplikuje přímo.
            onApply={value => commit(mergeChartSettings(value, isDark))}
          />
          <div className="flex gap-3">
            <button type="button" onClick={onCancel} className="h-8 rounded-md border border-slate-300 px-5 text-[13px] font-medium hover:bg-slate-50">Zrušit</button>
            <button
              type="button"
              onClick={() => onApply(draft, true)}
              title="Přepíše nastavení ve všech grafech workspace"
              className="h-8 rounded-md border border-slate-300 px-4 text-[13px] font-medium hover:bg-slate-50"
            >Na všechny grafy</button>
            <button type="button" onClick={() => onApply(draft, false)} className="h-8 rounded-md bg-[#2962ff] px-6 text-[13px] font-semibold text-white hover:bg-[#1e53e5]">Ok</button>
          </div>
        </footer>
      </section>
    </div>
  );
};

export default ChartSettingsDialog;
