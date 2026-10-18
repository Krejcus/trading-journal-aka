/**
 * Poznámka „Hlava“: osobní zápis o tom, co se děje v hlavě a v životě
 * (rodina, jídlo, pohyb, spánek, vztahy, práce, trading). Oblasti pozná
 * místní klasifikátor podle slov — nic se kvůli tomu nikam neposílá —
 * a uživatel je může upravit.
 */

export type MindArea = 'rodina' | 'jidlo' | 'pohyb' | 'spanek' | 'vztahy' | 'prace' | 'trading';

export const MIND_AREAS: readonly MindArea[] = ['rodina', 'jidlo', 'pohyb', 'spanek', 'vztahy', 'prace', 'trading'];

export const MIND_AREA_LABEL: Record<MindArea, string> = {
  rodina: 'Rodina', jidlo: 'Jídlo', pohyb: 'Pohyb', spanek: 'Spánek', vztahy: 'Vztahy', prace: 'Práce', trading: 'Trading hlava',
};

export const MIND_AREA_ICON: Record<MindArea, string> = {
  rodina: '🏠', jidlo: '🍽', pohyb: '🏃', spanek: '🌙', vztahy: '💬', prace: '💼', trading: '📈',
};

export const isMindArea = (value: unknown): value is MindArea => typeof value === 'string' && (MIND_AREAS as readonly string[]).includes(value);

/** Začátky slov (bez diakritiky, malými písmeny). Slovo musí oblastí začínat. */
const STEMS: Record<MindArea, readonly string[]> = {
  rodina: ['rodin', 'doma', 'domov', 'domu ', 'dum ', 'manzel', 'zena', 'zenou', 'zene ', 'partner', 'pritelk', 'deti', 'dite', 'ditet', 'syn ', 'syna', 'synem', 'synovi', 'synek', 'dcer', 'mama', 'mamk', 'mami', 'mamou', 'tata', 'tatk', 'tati', 'rodic', 'bratr', 'brach', 'segr', 'sestr', 'babi', 'deda', 'dedeck', 'tchyn', 'tchan'],
  jidlo: ['jidl', 'najist', 'najedl', 'snidan', 'obed', 'vecere', 'veceri', 'svacin', 'hlad', 'prejid', 'prejed', 'cukr', 'sladk', 'kafe', 'kav', 'kofein', 'alkohol', 'pivo', 'piv', 'vino', 'dieta', 'diet', 'strav', 'kalori', 'fastfood', 'pizz', 'energetak'],
  pohyb: ['cvic', 'trenin', 'trenovat', 'posil', 'fitk', 'fitn', 'gym', 'behat', 'behal', 'behani', 'bezet', 'bezel', 'prochaz', 'kolo ', 'na kole', 'plav', 'sport', 'pohyb', 'protah', 'jog', 'strecink', 'kroky', 'kroku'],
  spanek: ['span', 'spal', 'spat', 'spim', 'vyspal', 'nevyspal', 'nespal', 'usnul', 'usnout', 'nespavost', 'unav', 'vstaval', 'probud', 'budik', 'nocni', 'v noci', 'zdriml'],
  vztahy: ['vztah', 'kamarad', 'kamos', 'pratel', 'hadk', 'pohadal', 'konflikt', 'osamel', 'samota', 'samotu', 'samote', 'rande', 'laska', 'lasky', 'lasce', 'rozchod', 'kolega', 'kolegyn'],
  prace: ['prac', 'job', 'sef', 'kancl', 'kancelar', 'projekt', 'klient', 'zakazk', 'termin', 'deadline', 'schuzk', 'meeting', 'firm', 'podnik', 'faktur', 'uctov', 'penize', 'penez', 'dluh', 'hypotek', 'najem'],
  trading: ['trad', 'obchod', 'trh', 'graf', 'stop', 'sl ', 'tp ', 'vstup', 'entry', 'pozic', 'ztrat', 'zisk', 'loss', 'tilt', 'revenge', 'dohan', 'fomo', 'setup', 'propk', 'prop ', 'challenge', 'drawdown', 'kontrakt', 'nq ', 'es ', 'london', 'ny ', 'new york', 'sweep', 'bias'],
};

const fold = (value: string) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Oblasti, kterých se text týká, v pořadí podle `MIND_AREAS`. Kmen musí
 * stát na začátku slova; kmeny s mezerou na konci se berou jako celé slovo.
 */
export function detectMindAreas(text: string): MindArea[] {
  const folded = ` ${fold(text).replace(/[^a-z0-9]+/g, ' ')} `;
  return MIND_AREAS.filter(area => STEMS[area].some(stem => folded.includes(` ${stem}`)));
}

/**
 * Oblasti po úpravě textu: ručně přidané zůstanou, rozpoznané se přepočítají.
 * `manual` = oblasti, které uživatel sám zapnul (nepřepisují se).
 */
export function mergeMindAreas(text: string, manual: readonly string[] = []): MindArea[] {
  const detected = new Set<string>([...detectMindAreas(text), ...manual.filter(isMindArea)]);
  return MIND_AREAS.filter(area => detected.has(area));
}

/** Vidí AI coach poznámky Hlava? Volba jen v tomto prohlížeči, výchozí ano. */
const COACH_KEY = 'alphatrade_mind_coach';
export function readMindCoachEnabled(): boolean {
  try { return window.localStorage.getItem(COACH_KEY) !== 'off'; } catch { return true; }
}
export function writeMindCoachEnabled(enabled: boolean) {
  try { window.localStorage.setItem(COACH_KEY, enabled ? 'on' : 'off'); } catch { /* jen bez paměti volby */ }
}
