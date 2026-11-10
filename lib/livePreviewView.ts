import { liveCommandNotSentReason } from './liveCommandErrors';
import type { LeaderEntryPreviewOrder, LeaderEntryPreviewResult, LiveEntryPreviewDraft } from './leaderEntryPreview';

/**
 * „Zkontrolovat u workeru“ — zobrazení výsledku náhledu pro PC panel i telefon
 * (U2, 3. 11. 2026), vytknuté z `PreviewSection` (`components/LiveOrderTicket.tsx`).
 * Čistý výpočet nad výsledkem deskového `previewLeaderEntry`: stáří, klíč
 * výsledku, texty, riziko v $. Náhled nic nezapíše a neautorizuje odeslání
 * (INV-MANUAL-01): výsledek nikdy netvrdí „připraveno“, po 15 s zešedne
 * a změna návrhu nebo stavu kopírky ho zahodí. Riziko u Marketu stojí na ceně,
 * kterou uživatel viděl (kanál grafu) — jen odhad, worker počítá z IBKR (INV-UI-04).
 */

/** Jak dlouho výsledek náhledu platí jako „aktuální“; pak zešedne (relay TTL náhledu je taky 15 s). */
export const LIVE_PREVIEW_FRESH_MS = 15_000;

/** Výsledek náhledu v komponentě: pod jakým klíčem přišel a kdy (hodiny tohoto zařízení). */
export interface LivePreviewSnapshot {
  key: string;
  receivedAt?: number;
  result?: LeaderEntryPreviewResult;
  error?: string;
  /** Jedno id odeslání na jeden náhled (PC Odeslat): opakování = tentýž vstup. */
  operationId?: string;
}

/**
 * Klíč výsledku: stav kopírky (`resetKey`, PC `String(group.armed)`) + celý
 * návrh. Jiný návrh = jiný klíč = výsledek se neukáže. Bez návrhu prázdný.
 */
export const livePreviewKey = (resetKey: string, draft: LiveEntryPreviewDraft | null): string => (
  draft ? `${resetKey}|${JSON.stringify(draft)}` : ''
);

/** Výsledek jen pro přesně tentýž návrh a stav kopírky. */
export const livePreviewShown = (snapshot: LivePreviewSnapshot | null, key: string): LivePreviewSnapshot | null => (
  snapshot && key !== '' && snapshot.key === key ? snapshot : null
);

/**
 * Změna stavu kopírky výsledek ZAHODÍ, ne jen skryje: po OFF→ON do 15 s by se
 * jinak starý výsledek z předchozího zapnutí ukázal znovu jako čerstvý
 * (klíč by se vrátil na stejnou hodnotu).
 */
export const livePreviewAfterReset = (
  snapshot: LivePreviewSnapshot | null,
  previousResetKey: string,
  resetKey: string,
): LivePreviewSnapshot | null => (previousResetKey === resetKey ? snapshot : null);

/** Stáří výsledku v celých sekundách a zda už zastaral (víc než 15 s od přijetí). */
export function livePreviewAge(receivedAt: number, now: number): { seconds: number; stale: boolean } {
  return { seconds: Math.max(0, Math.round((now - receivedAt) / 1000)), stale: now - receivedAt > LIVE_PREVIEW_FRESH_MS };
}

/** Text chyby náhledu podle KÓDU relay odmítnutí (`copier-relay-preview-busy`), ne podle textu. */
export function livePreviewErrorText(reason: unknown): string {
  if (liveCommandNotSentReason(reason) === 'preview-busy') return 'Náhled už běží, zkus to za 3 s.';
  return reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Náhled se nepodařil.';
}

/** Tlačítko náhledu: nikdy nic neodešle, proto to říká i v popisku. */
export function livePreviewButton(input: { hasDraft: boolean; blockedReason: string | null; busy: boolean }): { label: string; disabled: boolean; title: string } {
  return {
    label: input.busy ? 'Ověřuji u workeru…' : 'Zkontrolovat u workeru (nic se neodešle)',
    disabled: !input.hasDraft || input.blockedReason != null || input.busy,
    title: input.blockedReason ?? 'Worker projde všechna pravidla kopírky a ukáže, co by poslal. Nic se neodešle.',
  };
}

const NB = ' ';
const groupDigits = (text: string) => text.replace(/\B(?=(\d{3})+(?!\d))/g, NB);
/** Cena jako PC panel (`formatPrice`): mezery po tisících, 2 desetinná místa. */
const formatPrice = (value: number) => {
  const [whole, decimals] = Math.abs(value).toFixed(2).split('.');
  return `${value < 0 ? '−' : ''}${groupDigits(whole)}.${decimals}`;
};
/** $ jako PC panel (`formatUsd`): −$1 234.50. */
const formatUsd = (value: number) => {
  const [whole, decimals] = Math.abs(value).toFixed(2).split('.');
  return `${value < 0 ? '−' : value > 0 ? '+' : ''}$${groupDigits(whole)}.${decimals}`;
};
const typeLabel = (orderType: string) => (orderType === 'Market' ? 'MKT' : orderType === 'Limit' ? 'LMT' : 'STP');

/** Řádek příkazu: „BUY MKT 2 ~25 000.00 · SL … · TP …“; holý Market „· bez SL/TP“. */
export function livePreviewOrderText(order: Pick<LeaderEntryPreviewOrder, 'side' | 'quantity' | 'orderType' | 'price' | 'stopLoss' | 'takeProfit'>): string {
  const at = order.orderType === 'Market' ? `~${formatPrice(order.price)}` : `@ ${formatPrice(order.price)}`;
  const legs = order.stopLoss == null || order.takeProfit == null
    ? 'bez SL/TP'
    : `SL ${formatPrice(order.stopLoss)} · TP ${formatPrice(order.takeProfit)}`;
  return `${order.side === 'Buy' ? 'BUY' : 'SELL'} ${typeLabel(order.orderType)} ${order.quantity} ${at} · ${legs}`;
}

/** Ztráta při SL v $ (záporné číslo); `estimate` = Market (cena z grafu); `unbounded` = holý Market bez SL. */
export interface LivePreviewRisk {
  usd: number | null;
  estimate: boolean;
  unbounded: boolean;
  text: string;
}

type RiskOrder = Pick<LeaderEntryPreviewOrder, 'orderType' | 'price' | 'stopLoss' | 'quantity'>;

/** Ztráta jednoho příkazu při SL: vzdálenost vstup–SL × kontrakty × $ za bod. */
const orderLossUsd = (order: RiskOrder, pointValue: number): number | null => (
  order.stopLoss == null ? null : -Math.abs(order.price - order.stopLoss) * order.quantity * pointValue
);

/**
 * Riziko celého příkazu (leader + kopie followerů) z výsledku workeru. U Marketu
 * je vstup cena, kterou uživatel viděl → jen odhad („≈“); worker riziko počítá
 * z IBKR + skluzu. Holý Market nemá SL → ztráta nemá strop (jen Flatten).
 */
export function livePreviewRisk(wouldPlace: { leader: RiskOrder; followers: readonly RiskOrder[] }, pointValue: number): LivePreviewRisk {
  const orders = [wouldPlace.leader, ...wouldPlace.followers];
  const estimate = wouldPlace.leader.orderType === 'Market';
  if (orders.some(order => order.stopLoss == null)) {
    return { usd: null, estimate, unbounded: true, text: 'Bez SL — ztráta nemá strop (jen Flatten).' };
  }
  const usd = orders.reduce((sum, order) => sum + (orderLossUsd(order, pointValue) ?? 0), 0);
  const scope = wouldPlace.followers.length > 0 ? ' (leader + followeři)' : '';
  return {
    usd, estimate, unbounded: false,
    text: estimate
      ? `Ztráta při SL ≈ ${formatUsd(usd)}${scope} · odhad z ceny grafu, worker počítá z IBKR`
      : `Ztráta při SL ${formatUsd(usd)}${scope}`,
  };
}

/** Co komponenta ukáže pod tlačítkem náhledu (PC i telefon totéž). */
export interface LivePreviewView {
  header: string;
  ageText: string;
  stale: boolean;
  /** `would-place` = worker by poslal (nikdy „připraveno“), `blocked` = nic by neposlal. */
  tone: 'would-place' | 'blocked';
  headline: string;
  leaderLine: string | null;
  followerLines: string[];
  risk: LivePreviewRisk | null;
  blockers: string[];
  notes: string[];
  /** PC Odeslat po náhledu: jen čerstvý výsledek bez blokací a bez blokace desku. */
  canSend: boolean;
  /** Proč Odeslat po náhledu nejde (jen když odeslání z náhledu existuje). */
  sendHint: string | null;
}

export function livePreviewView(input: {
  result: LeaderEntryPreviewResult;
  receivedAt: number;
  now: number;
  /** Brána desku / panelu (čerstvost, kopírka, cena); null = nic neblokuje. */
  blockedReason: string | null;
  /** Panel umí odeslat z náhledu (PC `onPlace`); telefon odesílá zvlášť → false. */
  placeSupported: boolean;
  /** Id odeslání přidělené k tomuto náhledu (bez něj Odeslat nejde). */
  operationId: string | null | undefined;
  /** $ za bod a kontrakt (MNQ 2). */
  pointValue: number;
}): LivePreviewView {
  const { result } = input;
  const { seconds, stale } = livePreviewAge(input.receivedAt, input.now);
  const wouldPlace = result.wouldPlace;
  const canSend = Boolean(input.placeSupported && wouldPlace && result.blockers.length === 0 && !stale && !input.blockedReason && input.operationId);
  const sendHint = input.placeSupported && wouldPlace && !canSend
    ? (stale ? 'Náhled zastaral (víc než 15 s) — zkontroluj znovu, pak hned Odeslat.'
      : result.blockers.length > 0 ? 'Odeslat nejde: náhled má blokace.'
        : input.blockedReason ?? 'Odeslat teď nejde — zkontroluj znovu.')
    : null;
  return {
    header: 'Náhled · nic se neodeslalo',
    ageText: stale ? `zastaralé · před ${seconds} s` : `před ${seconds} s`,
    stale,
    tone: wouldPlace ? 'would-place' : 'blocked',
    headline: wouldPlace ? `Worker by poslal (${result.symbol}):` : 'Worker by teď nic neposlal:',
    leaderLine: wouldPlace ? `Leader: ${livePreviewOrderText(wouldPlace.leader)}` : null,
    followerLines: wouldPlace ? wouldPlace.followers.map(follower => `Follower ${follower.accountId}: ${follower.quantity} ks`) : [],
    risk: wouldPlace ? livePreviewRisk(wouldPlace, input.pointValue) : null,
    blockers: result.blockers.map(issue => issue.text),
    notes: result.notes.map(issue => issue.text),
    canSend,
    sendHint,
  };
}
