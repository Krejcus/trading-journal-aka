// Režim kurzoru grafu jako v TradingView (Cross / Dot / Arrow / Demonstration /
// Eraser). Volba platí pro všechny grafy zařízení, stejně jako magnet.

export type ChartCursorMode = 'cross' | 'dot' | 'arrow' | 'demonstration' | 'eraser';

export const CHART_CURSOR_MODES: readonly { id: ChartCursorMode; title: string }[] = [
  { id: 'cross', title: 'Kříž' },
  { id: 'dot', title: 'Tečka' },
  { id: 'arrow', title: 'Šipka' },
  { id: 'demonstration', title: 'Prezentace' },
  { id: 'eraser', title: 'Guma' },
];

const STORAGE_KEY = 'alphatrade:chart-cursor-mode';
const EVENT = 'alphatrade:chart-cursor-mode-change';

const isCursorMode = (value: unknown): value is ChartCursorMode =>
  CHART_CURSOR_MODES.some(mode => mode.id === value);

let cachedMode: ChartCursorMode | null = null;

export const getChartCursorMode = (): ChartCursorMode => {
  if (cachedMode) return cachedMode;
  if (typeof window === 'undefined') return 'cross';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    cachedMode = isCursorMode(stored) ? stored : 'cross';
  } catch {
    cachedMode = 'cross';
  }
  return cachedMode;
};

export const setChartCursorMode = (mode: ChartCursorMode): ChartCursorMode => {
  const next = isCursorMode(mode) ? mode : 'cross';
  cachedMode = next;
  if (typeof window !== 'undefined') {
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* private storage */ }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  }
  return next;
};

export const subscribeChartCursorMode = (listener: (mode: ChartCursorMode) => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => listener((event as CustomEvent<ChartCursorMode>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
};

/** Čáry crosshairu ukazují jen Kříž a Tečka; popisky na osách zůstávají vždy. */
export const chartCursorShowsCrosshairLines = (mode: ChartCursorMode) => mode === 'cross' || mode === 'dot';

const svgCursor = (svg: string, hotspot: number, fallback: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspot} ${hotspot}, ${fallback}`;

const DOT_CURSOR = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><circle cx="6" cy="6" r="2.5" fill="#131722" stroke="#fff" stroke-width="1.2"/></svg>',
  6,
  'crosshair',
);
const DEMONSTRATION_CURSOR = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="13" fill="rgba(255,152,0,0.28)" stroke="rgba(255,152,0,0.85)" stroke-width="1.5"/><circle cx="16" cy="16" r="2" fill="#ff9800"/></svg>',
  16,
  'pointer',
);
const ERASER_CURSOR = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="none" stroke="#131722" stroke-width="1.5" stroke-linejoin="round"><path d="m3 15 8.5-8.5 6 6L12 18H6z" fill="#fff"/><path d="m8 10.5 6 6M12 18h7"/></svg>',
  4,
  'pointer',
);

/** CSS kurzor nad grafem mimo kreslení a tažení kresby. */
export const chartCursorCss = (mode: ChartCursorMode) => ({
  cross: 'crosshair',
  dot: DOT_CURSOR,
  arrow: 'default',
  demonstration: DEMONSTRATION_CURSOR,
  eraser: ERASER_CURSOR,
}[mode]);
