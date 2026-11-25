// Telefonní LIVE graf nad místní službou Rithmicu: čisté převody stavu služby na to, co čeká
// `LivePhoneChart` (most příkazů, kotace, štítek režimu účtu, karty stavů). Nic tady neodesílá a nic
// neautorizuje — každý příkaz ověřuje služba (LocalExec); obrazovka jen nabízí a ukazuje.
import type { LeaderEntryPlaceResult } from './leaderEntryPlace';
import type { LiveEntryPreviewDraft } from './leaderEntryPreview';
import type { LeaderOrderManageAction, LeaderOrderManageResult } from './leaderOrderManage';
import type { LiveBareLegIntent } from './liveBareLeg';
import type { LiveChartPosition } from './liveChartPosition';
import { snapToTick } from './liveOrderTicket';
import { livePhonePosition, type LivePhoneQuote, type LivePhoneTradeBridge } from './livePhoneOrders';
import type { LiveTicketScaleIn } from './liveScaleIn';
import type { BareLeaderTrade } from './manualBareClose';

/** Výsledek brzdy služby (`closeNow` hooku). */
export interface RithmicCloseResult { status: 'sent' | 'blocked' | 'unknown'; text: string | null }

/** Štítek režimu účtu v hlavičce telefonu. Pořadí: nejdřív omezení příkazů, pak skutečný účet, pak test. */
export interface RithmicPhoneModeLabel { text: string; tone: 'muted' | 'warn' | 'danger' }
export function rithmicPhoneModeLabel(input: { system: string | null; readOnly: boolean; closeOnly: boolean; liveAccount: boolean; simulation?: boolean }): RithmicPhoneModeLabel | null {
  if (input.readOnly) return { text: 'jen čtení', tone: 'warn' };
  if (input.closeOnly) return { text: 'jen zavírání', tone: 'warn' };
  if (input.liveAccount) return { text: 'ŽIVÝ ÚČET', tone: 'danger' };
  if (input.simulation) return { text: 'simulace', tone: 'muted' };
  if (input.system === 'Rithmic Test') return { text: 'test', tone: 'muted' };
  return null;
}

/**
 * Kotace pro telefonní lištu a list z poslední ceny služby — stejně jako panel na PC
 * (`LiveTradingScreen`): bid = cena na krok, ask = bid + krok. `at` = kdy cena přišla; čerstvost
 * se tu nevyrábí (stará cena zůstane stará a telefon s ní nic neodešle).
 */
export function rithmicPhoneQuote(input: { price: number | null; at: number | null; symbol: string; tickSize: number | null }): LivePhoneQuote | null {
  const { price, at, symbol, tickSize } = input;
  if (!symbol || price == null || !Number.isFinite(price) || price <= 0 || at == null || !Number.isFinite(at) || at <= 0
    || tickSize == null || !Number.isFinite(tickSize) || tickSize <= 0) return null;
  const bid = snapToTick(price, tickSize);
  return { symbol, bid, ask: bid + tickSize, at };
}

/** Text výsledku zavření pozice pro hlášku nad grafem. „Odesláno" není „zavřeno" — stav ukáže až služba. */
export function rithmicPhoneCloseText(result: RithmicCloseResult): string {
  if (result.status === 'sent') return 'Zavření pozice odesláno — výsledek ukáže graf.';
  if (result.status === 'blocked') return `Zavření neodešlo: ${result.text ?? 'služba ho nepustila'}`;
  return `Výsledek zavření NEZNÁMÝ: ${result.text ?? 'služba neodpověděla'} — ověř pozici u brokera, nic neopakuj.`;
}

/**
 * SL a TP jedním krokem (`attach`) služba Rithmicu z telefonu neumí: k otevřené pozici přidává
 * ochranu po jedné noze (`bareLeg` → čipy „+ SL" / „+ TP" na čáře). Dva příkazy za sebou by nebyly
 * atomické (první projde, druhý ne) — proto se nic neodešle a vrátí se srozumitelné odmítnutí.
 */
export function rithmicPhoneAttachRefusal(now: number): LeaderOrderManageResult {
  return {
    type: 'leader-order-managed', operationId: `manage:rithmic-attach-${now}`, action: 'attach-brackets', status: 'blocked', checkedAt: now,
    blockers: [{ code: 'local-exec', text: 'Rithmic přidává SL a TP po jedné — použij „+ SL“ a „+ TP“ na čáře pozice. Nic se neodeslalo.' }],
  };
}

/** Co most potřebuje ze stavu místní služby (`useRithmicLocalTrading`) — jen čtení a callbacky. */
export interface RithmicPhoneBridgeInput {
  readOnly: boolean;
  /** Služba hlásí incident (`state.blocked`): nové vstupy stojí do „Potvrdit incident". */
  blocked: string | null;
  entryBlockedReason: string | null;
  maxContracts: number;
  symbol: string;
  averagePrice: number | null;
  scaleIn: LiveTicketScaleIn | null;
  position: LiveChartPosition | null;
  bareLegTrade: BareLeaderTrade | null;
  soloAccountId: number;
  onPlaceEntry: (draft: LiveEntryPreviewDraft, operationId: string) => Promise<LeaderEntryPlaceResult>;
  onManageEntry: (action: LeaderOrderManageAction, expectPrice: number, newPrice?: number) => Promise<LeaderOrderManageResult>;
  onBareLeg: (seen: BareLeaderTrade, intent: LiveBareLegIntent) => Promise<LeaderOrderManageResult>;
  closeNow: () => Promise<RithmicCloseResult>;
}

/**
 * Most příkazů pro `LivePhoneChart`. Účet jen pro čtení most NEMÁ (null = graf jen zobrazuje).
 * Schopnosti jsou stejné jako Rithmic graf na PC (Market, vstup bez SL/TP, čekající bez SL/TP, posun
 * vstupu, SL/TP čekajícího vstupu, × zavřít); jestli příkaz opravdu projde, rozhoduje služba.
 */
export function rithmicPhoneBridge(input: RithmicPhoneBridgeInput): LivePhoneTradeBridge | null {
  if (input.readOnly) return null;
  const summary = input.position?.summary ?? null;
  return {
    blockedReason: input.blocked ? `Nové vstupy stojí: ${input.blocked}` : input.entryBlockedReason,
    marketSupported: true,
    bareSupported: true,
    barePendingSupported: true,
    maxContracts: input.maxContracts,
    frontContract: input.symbol || null,
    place: input.onPlaceEntry,
    // `bareEntryOperationId` zůstává null: „Přidat SL/TP" jedním krokem (attach) se nenabízí, nohy jdou přes `bareLeg`.
    position: livePhonePosition(summary, summary?.leader ? { quantity: summary.leader.quantity } : null, input.symbol || null, null),
    attach: async () => rithmicPhoneAttachRefusal(Date.now()),
    flatten: async () => rithmicPhoneCloseText(await input.closeNow()),
    pendingLegs: true,
    moveLimit: true,
    moveBareEntry: true,
    manage: (action, expectPrice, newPrice) => input.onManageEntry(action, expectPrice, newPrice),
    closeSupported: true,
    closeWithoutStop: true,
    entryAvg: input.averagePrice,
    scaleIn: input.scaleIn,
    leaderAccountId: input.soloAccountId,
    ...(input.bareLegTrade ? { bareLegTrade: input.bareLegTrade, bareLeg: input.onBareLeg } : {}),
  };
}

/** Karta stavu nad telefonním grafem (incident, nejistý příkaz, spojení, výsledek brzdy). */
export interface RithmicPhoneCard {
  id: string;
  tone: 'red' | 'amber' | 'green';
  title: string;
  text: string;
  /** Tlačítko karty; `ack` = Potvrdit incident, `verified` = zavřít varování nejistého příkazu, `dismiss` = zavřít kartu. */
  action?: { kind: 'ack' | 'verified' | 'dismiss'; label: string; disabled?: boolean };
}

/**
 * Karty stavů, které PC řeší kartami a tlačítky. Čistá funkce: pořadí = naléhavost (spojení, incident,
 * nejistý příkaz, výsledky). Bez těchto karet by telefon nesměl obchodovat — vstupy mezitím drží
 * `blockedReason` mostu a služba.
 */
export function rithmicPhoneCards(input: {
  link: 'off' | 'connecting' | 'open' | 'closed';
  helloFresh: boolean;
  rithmicConnected: boolean;
  silent: boolean;
  readOnly: boolean;
  blocked: string | null;
  uncertain: readonly { id: string; label: string; reason: string; confirmed?: boolean }[];
  closeNote: { at: number; text: string } | null;
  ackNote: { at: number; text: string } | null;
  rejection: { at: number; reason: string } | null;
  sessionWarning: string | null;
  foreignOrders: number;
}): RithmicPhoneCard[] {
  const out: RithmicPhoneCard[] = [];
  if (input.link !== 'open') out.push({ id: 'link', tone: 'red', title: 'Místní služba Rithmicu je odpojená', text: 'Stav v grafu není znám. Příkazy nejdou, dokud se spojení neobnoví.' });
  else if (!input.helloFresh) out.push({ id: 'hello', tone: 'amber', title: 'Připojuji se ke službě…', text: 'Příkazy půjdou až po novém stavu účtu.' });
  else if (!input.rithmicConnected) out.push({ id: 'rithmic', tone: 'red', title: 'Rithmic je odpojený', text: 'Služba běží, ale spojení s Rithmicem ne. Stav pozice ověř u brokera.' });
  else if (input.silent) out.push({ id: 'silent', tone: 'red', title: 'Služba neodpovídá', text: 'Cena i stav jsou staré. Nové příkazy nejdou — zavřít pozici zkusit jde.' });
  if (input.blocked) {
    out.push(input.readOnly
      ? { id: `blocked:${input.blocked}`, tone: 'amber', title: 'Služba hlásí stav účtu', text: `${input.blocked} Účet je připojený jen pro čtení — nic se neposílá.` }
      : { id: `blocked:${input.blocked}`, tone: 'red', title: 'Nové vstupy stojí', text: `${input.blocked} Zkontroluj účet u brokera a potvrď.`, action: { kind: 'ack', label: 'Potvrdit incident', disabled: input.link !== 'open' } });
  }
  if (input.ackNote) out.push({ id: `ack:${input.ackNote.at}`, tone: 'red', title: 'Incident se nepotvrdil', text: input.ackNote.text, action: { kind: 'dismiss', label: 'Zavřít' } });
  const open = input.uncertain.filter(item => !item.confirmed);
  const confirmed = input.uncertain.filter(item => item.confirmed);
  // Tlačítko maže VŠECHNA varování naráz (tak to dělá služba spojení) — proto je jen na poslední kartě.
  const ready = input.link === 'open' && input.helloFresh;
  open.forEach((item, index) => out.push({
    id: `uncertain:${item.id}`, tone: 'amber', title: `${item.label}: výsledek NEZNÁMÝ`, text: `${item.reason} — ověř pozici a příkazy u brokera, nic neopakuj.`,
    ...(index === open.length - 1 ? { action: { kind: 'verified' as const, label: 'Stav u brokera ověřen', disabled: !ready } } : {}),
  }));
  confirmed.forEach((item, index) => out.push({
    id: `verified:${item.id}`, tone: 'green', title: 'Broker potvrdil stav příkazu', text: item.reason,
    ...(open.length === 0 && index === confirmed.length - 1 ? { action: { kind: 'verified' as const, label: 'Zavřít potvrzení', disabled: !ready } } : {}),
  }));
  if (input.closeNote) out.push({ id: `close:${input.closeNote.at}`, tone: 'red', title: 'Zavření pozice: zkontroluj výsledek', text: input.closeNote.text, action: { kind: 'dismiss', label: 'Zavřít' } });
  if (input.rejection) out.push({ id: `rejected:${input.rejection.at}`, tone: 'amber', title: 'Rithmic příkaz odmítl', text: input.rejection.reason });
  if (input.sessionWarning) out.push({ id: 'session-close', tone: 'amber', title: 'Blíží se konec seance', text: input.sessionWarning });
  if (input.foreignOrders > 0) out.push({ id: `foreign:${input.foreignOrders}`, tone: 'amber', title: `Na účtu ${input.foreignOrders === 1 ? 'pracuje 1 příkaz zadaný' : `pracuje ${input.foreignOrders} příkazů zadaných`} jinde`, text: 'Graf je ukazuje jen pro zobrazení — z této appky je nejde posunout ani zrušit.' });
  return out;
}

/** Prázdný stav místo grafu (null = graf má co kreslit). Pozdější výpadek graf NEodmontuje — hlásí ho karta. */
export function rithmicPhoneWaiting(input: { url: string | null; instrumentIssue: string | null; hasMarket: boolean; link: 'off' | 'connecting' | 'open' | 'closed' }): string | null {
  if (!input.url) return 'Chybí spárování s místní službou Rithmicu (přístupový klíč v tomto zařízení).';
  if (input.instrumentIssue) return input.instrumentIssue;
  if (input.hasMarket) return null;
  return input.link !== 'open' ? 'Místní služba Rithmicu není dostupná — běží na počítači?' : 'Čekám na první cenu z Rithmicu…';
}
