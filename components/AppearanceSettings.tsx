import { useEffect, useState } from 'react';
import {
  APPEARANCE_BACKGROUNDS, APPEARANCE_PALETTES, BACKGROUND_NAMES, CARD_TRANSPARENCY_MAX, CARD_TRANSPARENCY_MIN, DEFAULT_APPEARANCE, PALETTE_NAMES,
  defaultSpeedFor, paletteColors, type AppearanceBackground, type AppearancePalette, type AppearanceSettings,
} from '../lib/appearance';

type Theme = 'dark' | 'light' | 'oled';
const PALETTE_ORDER: AppearancePalette[] = ['default', ...(Object.keys(APPEARANCE_PALETTES) as AppearancePalette[])];

/** Pozadí ve zmenšenině (stejné barvy jako skutečné pozadí aplikace). */
function backdrop(settings: AppearanceSettings, dark: boolean, background = settings.background): string {
  const c = paletteColors({ ...settings, background }, dark);
  const base = dark ? '#05070f' : '#eceff7';
  if (background === 'none') return base;
  if (background === 'field') return `radial-gradient(circle at 15% 15%, ${c[0]}, transparent 55%), radial-gradient(circle at 90% 30%, ${c[1]}, transparent 55%), radial-gradient(circle at 45% 100%, ${c[2]}, transparent 60%), ${base}`;
  // Hlubiny; pod grafem ztlumené a přes ně náznak svíček nebo křivky.
  const chart = background === 'candles' || background === 'equity';
  const [a, b, d] = chart ? ['66', '4d', '55'] : ['cc', '99', 'aa'];
  const depths = `radial-gradient(circle at 20% 24%, ${c[0]}${a}, transparent 46%), radial-gradient(circle at 82% 34%, ${c[2]}${b}, transparent 44%), radial-gradient(circle at 55% 95%, ${c[1]}${d}, transparent 50%), ${base}`;
  if (!chart) return depths;
  const up = dark ? '%2326a69a' : '%23089981', down = dark ? '%23ef5350' : '%23e0433f';
  const drawing = background === 'candles'
    ? [[6, 22, 8, up], [16, 17, 9, up], [26, 20, 7, down], [36, 12, 10, up], [46, 9, 8, up], [56, 13, 9, down], [66, 6, 9, up], [76, 9, 7, down], [86, 3, 9, up]]
        .map(([x, y, h, color]) => `<path d='M${Number(x) + 2.5} ${Number(y) - 3}V${Number(y) + Number(h) + 3}' stroke='${color}' vector-effect='non-scaling-stroke'/><rect x='${x}' y='${y}' width='5' height='${h}' fill='${color}'/>`).join('')
    : `<path d='M0 34L12 30L22 32L34 24L44 27L56 29L64 21L74 17L84 11L100 4' fill='none' stroke='${up}' stroke-width='1.6' vector-effect='non-scaling-stroke'/>`;
  return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 40' preserveAspectRatio='none'%3E${drawing.replace(/</g, '%3C').replace(/>/g, '%3E')}%3C/svg%3E") center / 100% 100% no-repeat, ${depths}`;
}

/**
 * Nastavení → Vzhled. Kompaktní: každá volba na jednom řádku přes celou šířku
 * (změny jsou hned vidět na skutečném pozadí za kartou). Posuvníky mění vzhled živě přes CSS proměnné
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
  const [speed, setSpeed] = useState(appearance.speed);
  const [mouseStrength, setMouseStrength] = useState(appearance.mouseStrength);
  useEffect(() => setSpeed(appearance.speed), [appearance.speed]);
  useEffect(() => setMouseStrength(appearance.mouseStrength), [appearance.mouseStrength]);

  const set = (patch: Partial<AppearanceSettings>) => onChange({ ...appearance, ...patch });
  const live = (name: '--aurora-strength' | '--aurora-card-opacity', value: string) => document.documentElement.style.setProperty(name, value);
  const commitStrength = () => { if (strength !== appearance.strength) set({ strength }); };
  const commitTransparency = () => { if (transparency !== appearance.cardTransparency) set({ cardTransparency: transparency }); };
  const commitSpeed = () => { if (speed !== appearance.speed) set({ speed }); };
  const commitMouseStrength = () => { if (mouseStrength !== appearance.mouseStrength) set({ mouseStrength }); };
  // Graf v pozadí bez pohybu nedává smysl — při jeho výběru se stojící pozadí rozhýbe.
  const pickBackground = (background: AppearanceBackground) => set({
    background,
    speed: appearance.speed === 0 && (background === 'candles' || background === 'equity') ? defaultSpeedFor(background) : appearance.speed,
  });
  const still = appearance.background === 'none';

  // Na telefonu se ovládání zalomí pod popisek, na širší obrazovce je vedle něj.
  const row = 'flex flex-wrap items-center gap-x-4 gap-y-2 min-h-[58px] px-4 sm:px-5 py-2.5 border-b border-[var(--border-subtle)]';
  const label = 'w-full sm:w-36 shrink-0 text-[13px] font-bold text-[var(--text-primary)]';
  const segBtn = (on: boolean) => `h-7 px-3 rounded text-xs font-semibold transition-colors ${on
    ? (dark ? 'bg-white/15 text-white shadow-sm' : 'bg-white text-slate-900 shadow-sm')
    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`;
  const ends = 'text-[11px] font-semibold text-[var(--text-secondary)] whitespace-nowrap';

  return (
    <div className="w-full">
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
              {APPEARANCE_BACKGROUNDS.map(value => [value, BACKGROUND_NAMES[value]] as const).map(([value, text]) => (
                <button key={value} type="button" onClick={() => pickBackground(value)} aria-pressed={appearance.background === value}
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
            <div className="ml-auto flex items-center gap-2.5 w-full max-w-[560px]">
              <span className={ends}>Jemné</span>
              <input type="range" min={0} max={100} value={strength} aria-label="Síla pozadí" className="flex-1 accent-indigo-500"
                onChange={e => { const v = Number(e.target.value); setStrength(v); live('--aurora-strength', String(v / 100)); }}
                onPointerUp={commitStrength} onKeyUp={commitStrength} onBlur={commitStrength} />
              <span className={ends}>Výrazné</span>
            </div>
          </div>

          <div className={`${row} ${still ? 'opacity-45' : ''}`}>
            <span className={label}>Rychlost pohybu</span>
            <div className="ml-auto flex items-center gap-2.5 w-full max-w-[560px]">
              <span className={ends}>Stojí</span>
              <input type="range" min={0} max={100} step={5} value={speed} disabled={still} aria-label="Rychlost pohybu pozadí" className="flex-1 accent-indigo-500"
                onChange={e => setSpeed(Number(e.target.value))}
                onPointerUp={commitSpeed} onKeyUp={commitSpeed} onBlur={commitSpeed} />
              <span className={ends}>Rychlé</span>
            </div>
          </div>

          <div className={row}>
            <span className={label}>Reakce na myš<small className="block mt-0.5 text-[11px] font-medium text-[var(--text-secondary)]">jen na počítači</small></span>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-2 w-full max-w-[560px]">
              <div className="inline-flex gap-0.5 p-0.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)]">
                {([['none', 'Žádná'], ['smoke', 'Kouř']] as const).map(([value, text]) => (
                  <button key={value} type="button" onClick={() => set({ mouseEffect: value })} className={segBtn(appearance.mouseEffect === value)} aria-pressed={appearance.mouseEffect === value}>{text}</button>
                ))}
              </div>
              <div className={`flex flex-1 min-w-[180px] items-center gap-2.5 ${appearance.mouseEffect === 'smoke' ? '' : 'opacity-45'}`}>
                <span className={ends}>Slabá</span>
                <input type="range" min={5} max={100} step={5} value={mouseStrength} disabled={appearance.mouseEffect !== 'smoke'} aria-label="Síla reakce na myš" className="flex-1 accent-indigo-500"
                  onChange={e => setMouseStrength(Number(e.target.value))}
                  onPointerUp={commitMouseStrength} onKeyUp={commitMouseStrength} onBlur={commitMouseStrength} />
                <span className={ends}>Silná</span>
              </div>
            </div>
          </div>

          <div className={row}>
            <span className={label}>Průhlednost karet</span>
            <div className="ml-auto flex items-center gap-2.5 w-full max-w-[560px]">
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
    </div>
  );
}

