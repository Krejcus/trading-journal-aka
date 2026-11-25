/**
 * Dotykový kříž v grafu (telefon).
 *
 * Lightweight Charts po dlouhém podržení přejde do „režimu sledování“: kříž
 * zůstane i po zvednutí prstu a tah prstem ho posouvá místo grafu. Knihovna
 * režim ukončí jen klepnutím přímo do plochy grafu a nemá pro to veřejné API.
 * Kříž proto zůstával viset, kdykoli další dotyk skončil jinde (lišta, tlačítko,
 * list přes graf) — a taky po přerušeném dotyku (`touchcancel`: systémové gesto,
 * oznámení, list pod prstem): knihovna si přerušený dotyk dál vede jako
 * aktivní, další klepnutí proto zahodí a kříž nezmizí.
 *
 * Knihovna čte z dotykových událostí jen `touches`, `changedTouches` a
 * souřadnice, takže jí stačí obyčejná událost s těmito poli — není potřeba
 * konstruktor `Touch`, který nemusí být všude dostupný.
 */
interface TouchLike {
  identifier: number;
  target: EventTarget | null;
  clientX: number;
  clientY: number;
  pageX: number;
  pageY: number;
  screenX: number;
  screenY: number;
}

interface TouchChart {
  chartElement: () => HTMLElement;
  clearCrosshairPosition: () => void;
}

/** Identifikátor, který skutečný prst nikdy nedostane. */
const SYNTHETIC_TOUCH_ID = -7411;

const dispatchTouch = (target: EventTarget, type: 'touchstart' | 'touchend', touches: TouchLike[], changed: TouchLike[]): void => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: touches });
  Object.defineProperty(event, 'targetTouches', { value: touches });
  Object.defineProperty(event, 'changedTouches', { value: changed });
  target.dispatchEvent(event);
};

/** Plátna plochy grafu (bez cenové a časové osy); dotyky poslouchá to horní. */
const paneCanvases = (chartElement: HTMLElement): HTMLCanvasElement[] => {
  const cell = chartElement.querySelector('table tr:first-child td:nth-child(2)');
  return cell ? [...cell.querySelectorAll('canvas')] : [];
};

/**
 * Ukončí režim sledování a schová kříž: pošle ploše grafu klepnutí bez pohybu
 * (stejné, jakým režim ukončuje uživatel) a kříž pro jistotu smaže i přímo.
 * Klepnutí míří do rohu plochy, ať netrefí žádnou kresbu.
 */
export const exitTouchCrosshair = (chart: TouchChart): void => {
  try {
    paneCanvases(chart.chartElement()).forEach(canvas => {
      const rect = canvas.getBoundingClientRect();
      const x = rect.left + 1;
      const y = rect.top + 1;
      const touch: TouchLike = { identifier: SYNTHETIC_TOUCH_ID, target: canvas, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y };
      dispatchTouch(canvas, 'touchstart', [touch], [touch]);
      dispatchTouch(canvas, 'touchend', [], [touch]);
    });
  } catch { /* graf se právě přestavuje */ }
  try { chart.clearCrosshairPosition(); } catch { /* graf už zanikl */ }
};

const touchListOf = (list: ArrayLike<TouchLike> | undefined): TouchLike[] => (list ? Array.from(list) : []);

/**
 * Přerušený dotyk dořekne knihovně jako ukončený, aby si ho nevedla dál jako
 * aktivní a nezahodila kvůli němu další klepnutí. Vrací funkci pro odpojení.
 */
export const installTouchCancelRepair = (chartElement: HTMLElement): (() => void) => {
  const handler = (event: Event) => {
    const source = event as Event & { touches?: ArrayLike<TouchLike>; changedTouches?: ArrayLike<TouchLike> };
    const changed = touchListOf(source.changedTouches);
    if (!changed.length || !event.target) return;
    dispatchTouch(event.target, 'touchend', touchListOf(source.touches), changed);
  };
  chartElement.addEventListener('touchcancel', handler, { capture: true, passive: true });
  return () => chartElement.removeEventListener('touchcancel', handler, { capture: true });
};

/** Prvek, na který se smí klepnout, aniž kříž zmizí (plus u kříže). */
export const CROSSHAIR_KEEP_ATTRIBUTE = 'data-crosshair-keep';

/** Má klepnutí na `target` kříž ukončit? (Mimo plochu grafu a mimo prvky, které s křížem pracují.) */
export const tapEndsTouchCrosshair = (target: EventTarget | null, chartElement: HTMLElement): boolean => {
  const element = target as (Element & { closest?: Element['closest'] }) | null;
  if (!element || typeof element.closest !== 'function') return false;
  if (chartElement.contains(element)) return false;
  return element.closest(`[${CROSSHAIR_KEEP_ATTRIBUTE}]`) === null;
};

/** Cena kříže přesně (po přichycení magnetem) — pixel grafu bývá hrubší než tick. */
export const CROSSHAIR_PRICE_DATASET = 'atCrosshairPrice';
export const readCrosshairPrice = (chartElement: HTMLElement): number | null => {
  const raw = chartElement.dataset[CROSSHAIR_PRICE_DATASET];
  if (raw == null || raw === '') return null;
  const price = Number(raw);
  return Number.isFinite(price) ? price : null;
};
