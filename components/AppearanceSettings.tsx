import { useEffect, useState } from 'react';
import {
  APPEARANCE_PALETTES, CARD_TRANSPARENCY_MAX, CARD_TRANSPARENCY_MIN, DEFAULT_APPEARANCE, PALETTE_NAMES,
  paletteColors, type AppearancePalette, type AppearanceSettings,
} from '../lib/appearance';

type Theme = 'dark' | 'light' | 'oled';
const PALETTE_ORDER: AppearancePalette[] = ['default', ...(Object.keys(APPEARANCE_PALETTES) as AppearancePalette[])];

/** Pozadí ve zmenšenině (stejné barvy jako skutečné pozadí aplikace). */
function backdrop(settings: AppearanceSettings, dark: boolean, background = settings.background): string {
  const c = paletteColors({ ...settings, background }, dark);
  const base = dark ? '#05070f' : '#eceff7';
  return background === 'depths'
    ? `radial-gradient(circle at 20% 24%, ${c[0]}cc, transparent 46%), radial-gradient(circle at 82% 34%, ${c[2]}99, transparent 44%), radial-gradient(circle at 55% 95%, ${c[1]}aa, transparent 50%), ${base}`
    : `radial-gradient(circle at 15% 15%, ${c[0]}, transparent 55%), radial-gradient(circle at 90% 30%, ${c[1]}, transparent 55%), radial-gradient(circle at 45% 100%, ${c[2]}, transparent 60%), ${base}`;
}

/**
 * Nastavení → Vzhled. Kompaktní (bez scrollu): každá volba na jednom řádku,
 * vpravo zmenšený dashboard. Posuvníky mění vzhled živě přes CSS proměnné
 * a ukládají se až po puštění — aplikace se nepřekresluje při každém pohybu.
 */
export default function AppearanceSettings({ appearance, onChange, theme, onThemeChange }: {
  appearance: AppearanceSettings;
  onChange: (next: AppearanceSettings) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}) {
  const dark = theme !== 'light';
  const oled = theme === 'oled';
  const [strength, setStrength] = useState(appearance.strength);
  const [transparency, setTransparency] = useState(appearance.cardTransparency);
  useEffect(() => setStrength(appearance.strength), [appearance.strength]);
  useEffect(() => setTransparency(appearance.cardTransparency), [appearance.cardTransparency]);

  const set = (patch: Partial<AppearanceSettings>) => onChange({ ...appearance, ...patch });
  const live = (name: '--aurora-strength' | '--aurora-card-opacity', value: string) => document.documentElement.style.setProperty(name, value);
  const commitStrength = () => { if (strength !== appearance.strength) set({ strength }); };
  const commitTransparency = () => { if (transparency !== appearance.cardTransparency) set({ cardTransparency: transparency }); };

  // Na telefonu se ovládání zalomí pod popisek, na širší obrazovce je vedle něj.
  const row = 'flex flex-wrap items-center gap-x-4 gap-y-2 min-h-[58px] px-4 sm:px-5 py-2.5 border-b border-[var(--border-subtle)]';
  const label = 'w-full sm:w-36 shrink-0 text-[13px] font-bold text-[var(--text-primary)]';
  const segBtn = (on: boolean) => `h-7 px-3 rounded text-xs font-semibold transition-colors ${on
    ? (dark ? 'bg-white/15 text-white shadow-sm' : 'bg-white text-slate-900 shadow-sm')
    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`;
  const ends = 'text-[11px] font-semibold text-[var(--text-secondary)] whitespace-nowrap';

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(260px,1fr)] items-start max-w-[1100px]">
      <section aria-label="Vzhled" className="theme-card rounded-lg overflow-hidden">
        <div className={row}>
          <span className={label}>Režim</span>
          <div className="ml-auto inline-flex gap-0.5 p-0.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)]">
            {([['light', 'Světlý'], ['dark', 'Tmavý'], ['oled', 'OLED']] as const).map(([value, text]) => (
              <button key={value} type="button" onClick={() => onThemeChange(value)} className={segBtn(theme === value)} aria-pressed={theme === value}>{text}</button>
            ))}
          </div>
        </div>

        <fieldset disabled={oled} className={`contents ${oled ? '[&>*]:opacity-45' : ''}`}>
          <div className={row}>
            <span className={label}>Pozadí</span>
            <div className="ml-auto flex flex-wrap justify-end gap-2">
              {([['depths', 'Hlubiny'], ['field', 'Barevné pole']] as const).map(([value, text]) => (
                <button key={value} type="button" onClick={() => set({ background: value })} aria-pressed={appearance.background === value}
                  className={`h-10 inline-flex items-center gap-2.5 pl-1 pr-3 rounded-md border text-xs font-semibold text-[var(--text-primary)] bg-[var(--bg-page)] transition-shadow ${appearance.background === value ? 'border-transparent ring-2 ring-indigo-500' : 'border-[var(--border-subtle)]'}`}>
                  <span className="w-[52px] h-[30px] rounded" style={{ background: backdrop(appearance, dark, value) }} />{text}
                </button>
              ))}
            </div>
          </div>

          <div className={row}>
            <span className={label}>Barvy<small className="block mt-0.5 text-[11px] font-medium text-[var(--text-secondary)]">{PALETTE_NAMES[appearance.palette]}</small></span>
            <div className="ml-auto flex flex-wrap justify-end gap-2">
              {PALETTE_ORDER.map(key => {
                const colors = paletteColors(appearance, dark, key);
                return (
                  <button key={key} type="button" title={PALETTE_NAMES[key]} aria-label={PALETTE_NAMES[key]} aria-pressed={appearance.palette === key} onClick={() => set({ palette: key })}
                    className={`w-8 h-8 p-[3px] rounded-full ${appearance.palette === key ? 'ring-2 ring-indigo-500' : 'ring-1 ring-[var(--border-subtle)]'}`}>
                    <span className="flex w-full h-full rounded-full overflow-hidden -rotate-[30deg]">{colors.map((c, i) => <i key={i} className="flex-1" style={{ background: c }} />)}</span>
                  </button>
                );
              })}
              <label title="Vlastní barva — ostatní odstíny se dopočítají" className={`relative w-8 h-8 p-[3px] rounded-full cursor-pointer ${appearance.palette === 'custom' ? 'ring-2 ring-indigo-500' : 'ring-1 ring-[var(--border-subtle)]'}`}>
                <span className="flex w-full h-full rounded-full overflow-hidden -rotate-[30deg]">{paletteColors(appearance, dark, 'custom').map((c, i) => <i key={i} className="flex-1" style={{ background: c }} />)}</span>
                <span aria-hidden="true" className="absolute -right-1 -bottom-1 w-3.5 h-3.5 rounded-full grid place-items-center text-[11px] font-black leading-none bg-[var(--bg-input)] text-[var(--text-primary)] shadow">+</span>
                <input type="color" aria-label="Vlastní barva" value={appearance.customColor} onChange={e => set({ palette: 'custom', customColor: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer" />
              </label>
            </div>
          </div>

          <div className={row}>
            <span className={label}>Síla pozadí</span>
            <div className="ml-auto flex items-center gap-2.5 w-full max-w-[420px]">
              <span className={ends}>Jemné</span>
              <input type="range" min={0} max={100} value={strength} aria-label="Síla pozadí" className="flex-1 accent-indigo-500"
                onChange={e => { const v = Number(e.target.value); setStrength(v); live('--aurora-strength', String(v / 100)); }}
                onPointerUp={commitStrength} onKeyUp={commitStrength} onBlur={commitStrength} />
              <span className={ends}>Výrazné</span>
            </div>
          </div>

          <div className={row}>
            <span className={label}>Průhlednost karet</span>
            <div className="ml-auto flex items-center gap-2.5 w-full max-w-[420px]">
              <span className={ends}>Neprůhledné</span>
              <input type="range" min={CARD_TRANSPARENCY_MIN} max={CARD_TRANSPARENCY_MAX} value={transparency} aria-label="Průhlednost karet" className="flex-1 accent-indigo-500"
                onChange={e => { const v = Number(e.target.value); setTransparency(v); live('--aurora-card-opacity', `${100 - v}%`); }}
                onPointerUp={commitTransparency} onKeyUp={commitTransparency} onBlur={commitTransparency} />
              <span className={ends}>Průhledné</span>
            </div>
          </div>
        </fieldset>

        <div className="flex items-center justify-between gap-3 px-5 py-3 text-[11.5px] text-[var(--text-secondary)]">
          <span>{oled ? 'V režimu OLED je pozadí vypnuté — čistě černá šetří baterii.' : 'Uloženo k účtu · platí na všech zařízeních'}</span>
          <button type="button" onClick={() => onChange(DEFAULT_APPEARANCE)} className="h-[30px] px-3 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] text-xs font-semibold text-[var(--text-primary)]">Obnovit výchozí</button>
        </div>
      </section>

      {/* Zmenšený dashboard — reaguje na všechna nastavení vlevo. */}
      <section aria-label="Náhled vzhledu" className="theme-card rounded-lg p-2.5">
        <div className="relative grid grid-cols-[22px_1fr] grid-rows-[auto_1fr] gap-1.5 h-[230px] lg:h-[268px] p-2 rounded-md overflow-hidden"
          style={{ background: oled ? '#000' : backdrop(appearance, dark) }}>
          {!oled && <span aria-hidden="true" className="absolute inset-0" style={{ background: dark ? '#05070f' : '#eceff7', opacity: `calc(1 - (0.3 + 0.7 * var(--aurora-strength, ${appearance.strength / 100})))` }} />}
          <span className="relative row-span-2 rounded-lg bg-[var(--bg-card)] border border-[var(--glass-border)] shadow-[var(--shadow-card)] flex flex-col items-center gap-1.5 pt-2">
            {Array.from({ length: 6 }, (_, i) => <i key={i} className={`w-2 h-2 rounded-[3px] ${i === 1 ? 'bg-[var(--text-primary)] opacity-70' : 'bg-[var(--text-secondary)] opacity-30'}`} />)}
          </span>
          <span className="relative h-6 rounded-lg bg-[var(--bg-card)] border border-[var(--glass-border)] px-2.5 flex items-center text-[10.5px] font-extrabold text-[var(--text-primary)]">Dashboard</span>
          <span className="relative grid grid-cols-2 grid-rows-[auto_1fr] gap-1.5 min-h-0">
            {[
              ['Net P&L', <b key="v" className="text-[15px] font-extrabold tabular-nums text-emerald-500">+$17 719</b>],
              ['Win rate', <b key="v" className="text-[15px] font-extrabold tabular-nums text-[var(--text-primary)]">45,6 %</b>],
              ['Equity', <svg key="v" viewBox="0 0 100 40" preserveAspectRatio="none" className="w-full flex-1 min-h-[40px]"><path d="M0,34 L12,30 L22,32 L34,24 L44,27 L56,30 L64,22 L74,18 L84,12 L100,4" fill="none" stroke="#10b981" strokeWidth="1.6" vectorEffect="non-scaling-stroke" /></svg>],
              ['Září', <span key="v" className="grid grid-cols-5 gap-[3px] mt-auto">{[1, -1, 1, -1, 1, 1, -1, 1, -1, 1].map((sign, i) => <i key={i} className={`aspect-[1.2] rounded-[3px] ${sign > 0 ? 'bg-emerald-500/55' : 'bg-rose-500/50'}`} />)}</span>],
            ].map(([title, body]) => (
              <span key={String(title)} className="flex flex-col gap-1 min-w-0 rounded-lg p-2 bg-[var(--bg-card)] border border-[var(--glass-border)] shadow-[var(--shadow-card)]">
                <span className="text-[8.5px] font-semibold text-[var(--text-secondary)]">{title}</span>{body}
              </span>
            ))}
          </span>
        </div>
        <p className="flex justify-between gap-2 px-1 pt-2 text-[11px] text-[var(--text-secondary)]"><b className="text-[var(--text-primary)]">Náhled</b>takhle bude vypadat dashboard</p>
      </section>
    </div>
  );
}

