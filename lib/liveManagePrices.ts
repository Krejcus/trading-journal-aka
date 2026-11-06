import { breakEvenStop, leaderManageBasis, type LiveChartPositionSummary } from './liveChartPosition';
import { liveLineMoveBlockReason } from './liveChartOrderLines';
import type { TicketBracketUnits } from './liveOrderTicket';

/**
 * Správa otevřené pozice leadera zadáním čísla a BE varianty (U10, 3. 11. 2026):
 * čistý výpočet ceny ZÁMĚRU uživatele pro stávající `move-stop` / `move-target`.
 * Nic odsud neodesílá a nic neautorizuje (INV-UI-01..04): „co jsem viděl“
 * (`expectPrice`) je cena nohy z read modelu brokera (`summary.stop/target`),
 * průměr vstupu je ze stavu pollu workeru (`manageEntryAvgPrice`) a poplatky jsou
 * ODHAD z poslední sazby brokera (`summary.rows[].fees` = průměrný poplatek za kontrakt
 * z posledních až 20 fillů účtu × kusy, `lib/liveTradeCard.ts:tradeCardFeeRates`) —
 * skutečné poplatky pozice se můžou lišit. Předkontroly jen blokují —
 * TP k trhu (`toward-market`), SL za TP (`beyond-target`) a SL blíž než 8 ticků
 * od trhu (`tighten-too-close`) znovu odmítne worker, SL přes trh broker.
 *
 * Zaokrouhlení na tick (každé pravidlo hlídá test s mutací floor/ceil):
 * - BE a BE + n ticků: `breakEvenStop` (na tick ve směru ochrany — long dolů,
 *   short nahoru) ± n ticků do zisku;
 * - BE s poplatky: na stranu zisku (long nahoru, short dolů) — stop na té ceně
 *   pokryje odhadnuté poplatky celé pozice (bez skluzu);
 * - číslo z pole (body / ticky / $ / cena): na stranu trhu (long SL nahoru, long TP
 *   dolů, short zrcadlově) — na ticku nikdy větší ztráta ani vzdálenější cíl, než
 *   uživatel zadal.
 */

const MNQ_TICK = 0.25;
/** Strop „BE + n ticků“ v panelu i listu. */
export const MANAGE_BE_MAX_TICKS = 40;
const EPSILON = 1e-9;

export type LiveManageLeg = 'stopLoss' | 'takeProfit';
/** Jednotky pole správy — stejné jako pole SL/TP panelu objednávky. */
export type LiveManageUnits = TicketBracketUnits;

/**
 * BE varianty posunu SL. `be-plus` nese n ticků do zisku (0 = čisté BE).
 * `be-fees` = průměr + poplatky celé pozice leadera / (qty · hodnota bodu).
 */
export type LiveManageBreakEvenVariant =
  | { kind: 'be' }
  | { kind: 'be-plus'; ticks: number }
  | { kind: 'be-fees' };

/**
 * Podklad správy leadera: jen hodnoty z čerstvého stavu (průměr z pollu workeru,
 * qty a poplatky ze stejného řádku leadera v read modelu brokera). null = neznámo
 * → odpovídající akce se nenabídne / je vypnutá.
 */
export interface LiveManageBasis {
  /** Průměrný vstup leadera od workeru (`manageEntryAvgPrice`); null = neznámo. */
  entryAvg: number | null;
  /** Kontrakty leadera (ne součet skupiny); null = neznámo. */
  quantity: number | null;
  /** ODHAD poplatků celé pozice leadera v USD (poslední sazba z fillů brokera × kusy); null = neznámé. */
  feesUsd: number | null;
  /** Dolarů za 1 bod a 1 kontrakt (MNQ 2). */
  pointValue: number;
  tick?: number;
}

/** Záměr uživatele pro `onManageEntry(action, expectPrice, newPrice)` — nic víc. */
export interface LiveManageIntent {
  /** Co se posouvá: číslo z pole, nebo BE varianta. */
  id: 'move' | 'be' | 'be-plus' | 'be-fees';
  action: 'move-stop' | 'move-target';
  leg: LiveManageLeg;
  /** Co uživatel viděl: současná cena nohy z read modelu brokera (worker porovná s brokerem). */
  expectPrice: number;
  newPrice: number;
  /** Utažení (k trhu) nebo uvolnění (od trhu) — jen text pro uživatele. */
  direction: 'tighten' | 'loosen';
  /** Text tlačítka / potvrzení s cenou, která odejde („SL na BE +2 t 25000.50“). */
  label: string;
  /** Klíč proti dvojkliku: varianta + akce + co jsem viděl + nová cena. */
  confirmKey: string;
}

export type LiveManagePlan =
  | { ok: true; intent: LiveManageIntent }
  /** `price` = vypočtená cena (když je známá) pro zobrazení u vypnutého tlačítka. */
  | { ok: false; reason: string; price: number | null };

const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
const dirOf = (side: 'long' | 'short') => (side === 'long' ? 1 : -1);
const validPrice = (value: number | null | undefined): value is number => finite(value) && value > 0 && value < 1_000_000;
const onTick = (value: number, tick: number) => Math.abs(value / tick - Math.round(value / tick)) < 1e-6;
/** Násobek ticku bez binárního šumu (0.1 · 3 apod.). */
const ticks = (units: number, tick: number) => Number((units * tick).toFixed(10));
const blocked = (reason: string, price: number | null = null): LiveManagePlan => ({ ok: false, reason, price });
const priceText = (price: number) => price.toFixed(2);

/**
 * SL na BE + n ticků do zisku: `breakEvenStop` (zaokrouhleno ve směru ochrany)
 * posunuté o n celých ticků ve směru obchodu. n = 0 je čisté BE. Neplatné n
 * (necelé, záporné, nad `MANAGE_BE_MAX_TICKS`) nebo neznámý průměr = null.
 */
export function breakEvenPlusTicks(
  side: 'long' | 'short', entryAvg: number | null | undefined, n: number, tick = MNQ_TICK,
): number | null {
  if (!Number.isInteger(n) || n < 0 || n > MANAGE_BE_MAX_TICKS) return null;
  const be = breakEvenStop(side, entryAvg, tick);
  if (be == null) return null;
  const price = ticks(Math.round(be / tick) + dirOf(side) * n, tick);
  return price > 0 ? price : null;
}

/**
 * SL na BE s poplatky: průměr + poplatky celé pozice / (qty · hodnota bodu) ve směru
 * zisku, zaokrouhleno na tick na stranu zisku (long nahoru, short dolů) — stop na
 * té ceně pokryje poplatky (bez skluzu). Nulové poplatky = průměr zaokrouhlený na
 * stranu zisku (na ticku shodné s BE). Cokoli neznámého nebo neplatného = null.
 */
export function breakEvenWithFees(
  side: 'long' | 'short',
  entryAvg: number | null | undefined,
  quantity: number | null | undefined,
  feesUsd: number | null | undefined,
  pointValue: number,
  tick = MNQ_TICK,
): number | null {
  if (!validPrice(entryAvg) || !finite(feesUsd) || feesUsd < 0) return null;
  if (!finite(quantity) || !Number.isInteger(quantity) || quantity <= 0 || !finite(pointValue) || pointValue <= 0) return null;
  const raw = entryAvg + dirOf(side) * feesUsd / (quantity * pointValue);
  const units = raw / tick;
  const price = ticks(side === 'long' ? Math.ceil(units - EPSILON) : Math.floor(units + EPSILON), tick);
  return validPrice(price) ? price : null;
}

/** Cena BE varianty; null = podklad chybí nebo je varianta neplatná. */
export function breakEvenVariantPrice(side: 'long' | 'short', basis: LiveManageBasis, variant: LiveManageBreakEvenVariant): number | null {
  const tick = basis.tick ?? MNQ_TICK;
  if (variant.kind === 'be') return breakEvenStop(side, basis.entryAvg, tick);
  if (variant.kind === 'be-plus') return breakEvenPlusTicks(side, basis.entryAvg, variant.ticks, tick);
  return breakEvenWithFees(side, basis.entryAvg, basis.quantity, basis.feesUsd, basis.pointValue, tick);
}

/**
 * Zaokrouhlení ceny z pole na tick na stranu trhu: long SL nahoru / long TP dolů,
 * short zrcadlově. Na ticku tak nikdy větší ztráta ani vzdálenější cíl, než bylo
 * zadáno; blízkost trhu pak hlídá pojistka 8 ticků (a worker).
 */
export function roundManagePrice(side: 'long' | 'short', leg: LiveManageLeg, raw: number, tick = MNQ_TICK): number {
  const units = raw / tick;
  const up = (side === 'long') === (leg === 'stopLoss');
  return ticks(up ? Math.ceil(units - EPSILON) : Math.floor(units + EPSILON), tick);
}

/**
 * Číslo z pole správy → cena nohy. Body / ticky / $ jsou vzdálenost od průměru
 * vstupu leadera se znaménkem: kladné = přirozená strana (SL do ztráty, TP do zisku),
 * záporné SL = zamčený zisk za průměrem (TP musí být kladné). $ = na celou pozici
 * leadera (qty · hodnota bodu, bez poplatků). „cena“ = přímo cena. Vždy zaokrouhleno
 * `roundManagePrice`. Vrací cenu nebo důvod, proč z čísla cena není.
 */
export function managePriceFromInput(input: {
  side: 'long' | 'short';
  leg: LiveManageLeg;
  units: LiveManageUnits;
  value: number;
  entryAvg: number | null;
  quantity: number | null;
  pointValue: number;
  tick?: number;
}): { price: number } | { blocked: string } {
  const tick = input.tick ?? MNQ_TICK;
  const { side, leg, units, value } = input;
  if (!finite(value)) return { blocked: 'Zadej číslo.' };
  let raw: number;
  if (units === 'price') {
    raw = value;
  } else {
    if (leg === 'takeProfit' && value <= 0) return { blocked: 'TP musí být v zisku — zadej vzdálenost větší než 0.' };
    if (!validPrice(input.entryAvg)) return { blocked: 'Průměrný vstup leadera není známý — zadej přímo cenu.' };
    let points: number;
    if (units === 'pts') points = value;
    else if (units === 'ticks') {
      if (!Number.isInteger(value)) return { blocked: 'Ticky zadej celým číslem.' };
      points = value * tick;
    } else {
      if (!finite(input.quantity) || !Number.isInteger(input.quantity) || input.quantity <= 0) return { blocked: 'Počet kontraktů leadera není známý — zadej body, ticky nebo cenu.' };
      if (!finite(input.pointValue) || input.pointValue <= 0) return { blocked: 'Hodnota bodu není známá.' };
      points = value / (input.pointValue * input.quantity);
    }
    // SL leží proti směru obchodu, TP po směru (kladné číslo = přirozená strana).
    raw = input.entryAvg + (leg === 'stopLoss' ? -1 : 1) * dirOf(side) * points;
  }
  const price = roundManagePrice(side, leg, raw, tick);
  if (!validPrice(price)) return { blocked: 'Z čísla nevychází platná cena.' };
  return { price };
}

/**
 * Opačný převod pro předvyplnění pole: cena nohy → číslo v jednotkách (se znaménkem
 * jako `managePriceFromInput`: kladné = přirozená strana). null = nejde spočítat.
 */
export function manageDisplayValue(input: {
  side: 'long' | 'short';
  leg: LiveManageLeg;
  units: LiveManageUnits;
  price: number | null;
  entryAvg: number | null;
  quantity: number | null;
  pointValue: number;
  tick?: number;
}): number | null {
  const tick = input.tick ?? MNQ_TICK;
  if (!validPrice(input.price)) return null;
  if (input.units === 'price') return input.price;
  if (!validPrice(input.entryAvg)) return null;
  const points = (input.leg === 'stopLoss' ? -1 : 1) * dirOf(input.side) * (input.price - input.entryAvg);
  if (input.units === 'pts') return Number(points.toFixed(4));
  if (input.units === 'ticks') return Math.round(points / tick);
  if (!finite(input.quantity) || input.quantity <= 0) return null;
  return Number((points * input.quantity * input.pointValue).toFixed(2));
}

/**
 * Podklad správy jen pro leadera SKUPINY WORKERU (ne zobrazovací `isLeader`):
 * qty a poplatky ze stejného řádku leadera, průměr ze stavu pollu (předává desk
 * jako `manageEntryAvgPrice`, null když graf předbíhá poll). Poplatky řádku
 * k jinému počtu kusů než leader = neznámé.
 */
export function liveManageBasis(
  summary: LiveChartPositionSummary | null | undefined,
  leaderAccountId: number | null | undefined,
  entryAvg: number | null | undefined,
  pointValue: number,
  tick = MNQ_TICK,
): LiveManageBasis {
  const leader = leaderManageBasis(summary, leaderAccountId);
  const quantity = leader && Number.isInteger(leader.quantity) && leader.quantity > 0 ? leader.quantity : null;
  const row = leader ? summary?.rows.find(item => item.accountId === leader.accountId) ?? null : null;
  const feesUsd = row && quantity != null && row.quantity === quantity && finite(row.fees) && row.fees >= 0 ? row.fees : null;
  return { entryAvg: validPrice(entryAvg) ? entryAvg : null, quantity, feesUsd, pointValue, tick };
}

const intentFor = (
  summary: LiveChartPositionSummary, leg: LiveManageLeg, id: LiveManageIntent['id'], expectPrice: number, newPrice: number, label: string,
): LiveManageIntent => {
  const action = leg === 'stopLoss' ? 'move-stop' : 'move-target';
  const dir = dirOf(summary.side);
  // SL k trhu = utažení (long nahoru); TP k trhu by worker nepustil, tady jen dál = uvolnění.
  const tighten = leg === 'stopLoss' ? (newPrice - expectPrice) * dir > 0 : (newPrice - expectPrice) * dir < 0;
  return {
    id, action, leg, expectPrice, newPrice, direction: tighten ? 'tighten' : 'loosen', label,
    confirmKey: `${id}:${action}:${expectPrice}:${newPrice}`,
  };
};

/**
 * Posun SL / TP na zadanou cenu (už zaokrouhlenou `managePriceFromInput`). `summary`
 * má být pojistkový souhrn v okamžiku akce (`withIbkrTightenMark` s aktuálním časem).
 * Blokuje: nevyplněná pozice, neznámá / rozjetá noha, stejná cena, TP k trhu, SL
 * za TP, SL blíž než 8 ticků od trhu nebo za ním, neznámý trh při utažení.
 */
export function planManageMove(
  summary: LiveChartPositionSummary | null | undefined,
  leg: LiveManageLeg,
  price: number,
  options: { tick?: number; pendingLegs?: boolean } = {},
): LiveManagePlan {
  const tick = options.tick ?? MNQ_TICK;
  if (!summary) return blocked('Pozice leadera není známá.');
  if (!validPrice(price) || !onTick(price, tick)) return blocked(`Cena musí být kladná a na ticku ${tick}.`);
  const reason = liveLineMoveBlockReason(summary, leg, price, { pendingLegs: options.pendingLegs === true });
  if (reason) return blocked(reason, price);
  const current = leg === 'stopLoss' ? summary.stop : summary.target;
  // liveLineMoveBlockReason už odmítla neznámou nohu; tady jen pro typy.
  if (current == null) return blocked(`${leg === 'stopLoss' ? 'SL' : 'TP'} leadera není známý.`, price);
  if (price === current) return blocked(`${leg === 'stopLoss' ? 'SL' : 'TP'} už je na ${priceText(price)}.`, price);
  return { ok: true, intent: intentFor(summary, leg, 'move', current, price, `${leg === 'stopLoss' ? 'SL' : 'TP'} na ${priceText(price)}`) };
}

const variantLabel = (variant: LiveManageBreakEvenVariant) => (
  variant.kind === 'be' ? 'BE' : variant.kind === 'be-plus' ? `BE +${variant.ticks} t` : 'BE + odhad poplatků'
);

/**
 * SL na BE variantu. Stejné bloky jako BE na štítku pozice
 * (`liveBreakEven`) plus SL za TP — n ticků do zisku může TP přeskočit.
 */
export function planBreakEven(
  summary: LiveChartPositionSummary | null | undefined,
  basis: LiveManageBasis,
  variant: LiveManageBreakEvenVariant,
): LiveManagePlan {
  if (!summary) return blocked('Pozice leadera není známá.');
  if (summary.kind !== 'position') return blocked('BE jde až u vyplněné pozice.');
  // Pole „BE +[n] t“ v panelu i listu: n 1–40 (čisté BE má vlastní tlačítko).
  if (variant.kind === 'be-plus' && (!Number.isInteger(variant.ticks) || variant.ticks < 1 || variant.ticks > MANAGE_BE_MAX_TICKS)) {
    return blocked(`BE + n: n musí být celé číslo 1–${MANAGE_BE_MAX_TICKS} ticků.`);
  }
  if (!validPrice(basis.entryAvg)) return blocked('Průměrný vstup leadera není známý.');
  if (variant.kind === 'be-fees') {
    if (basis.feesUsd == null || !finite(basis.feesUsd) || basis.feesUsd < 0) return blocked('Poplatky leadera nejsou známé — BE s poplatky teď nejde.');
    if (basis.quantity == null) return blocked('Počet kontraktů leadera není známý — BE s poplatky teď nejde.');
  }
  const price = breakEvenVariantPrice(summary.side, basis, variant);
  // Rozjeté SL nohy (pozice z přikoupení) = žádná jedna cena SL: nic, s důvodem.
  if (summary.stop == null) return blocked('SL pozice není na jedné ceně (nebo není známý) — BE teď nejde.', price);
  if (price == null) return blocked('Cenu BE nejde spočítat.');
  const label = variantLabel(variant);
  if (price === summary.stop) return blocked(`SL už je na ${label} (${priceText(price)}).`, price);
  const reason = liveLineMoveBlockReason(summary, 'stopLoss', price);
  if (reason) return blocked(reason, price);
  return { ok: true, intent: intentFor(summary, 'stopLoss', variant.kind, summary.stop, price, `SL na ${label} ${priceText(price)}`) };
}

/**
 * Stav BE tlačítek sekce „Správa“ / listu: BE, BE + n, BE + poplatky. `fees` je null,
 * když poplatky leadera nejsou známé — tlačítko se pak nenabízí (U10 §3).
 */
export function liveManageBreakEvenOffers(
  summary: LiveChartPositionSummary | null | undefined,
  basis: LiveManageBasis,
  plusTicks: number,
): { be: LiveManagePlan; plus: LiveManagePlan; fees: LiveManagePlan | null } {
  return {
    be: planBreakEven(summary, basis, { kind: 'be' }),
    plus: planBreakEven(summary, basis, { kind: 'be-plus', ticks: plusTicks }),
    fees: basis.feesUsd == null ? null : planBreakEven(summary, basis, { kind: 'be-fees' }),
  };
}
