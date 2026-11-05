import React, { useEffect, useRef, useState } from 'react';
import { Minus, Plus, Star, Trash2, X } from 'lucide-react';
import {
  bracketDisplayValue, bracketPriceFromInput, snapToTick, ticketEntry, ticketMetrics, ticketProblems, ticketQuantity, withSide,
  type TicketBracketUnits, type TicketDraft, type TicketInstrument, type TicketMetrics, type TicketOrderType, type TicketProblem, type TicketQuote,
} from '../../lib/liveOrderTicket';
import type { LiveEntryPreviewDraft } from '../../lib/leaderEntryPreview';
import { livePhoneScaleInBlocked, livePhoneSheetEntry, type LivePhoneQuote, type LivePhoneTradeBridge } from '../../lib/livePhoneOrders';
import { LIVE_BARE_QUOTE_MAX_AGE_MS, LIVE_CONFIRM_WINDOW_MS, liveConfirmAsking, liveConfirmClick, liveTicketLegsProblem, type LiveConfirmState } from '../../lib/liveBareEntry';
import {
  applyLiveBracketTemplate, defaultLiveBracketTemplate, liveBracketTemplateChoices, liveMarketBracketDistanceProblem, liveTemplateFromDraft,
  type LiveBracketTemplate, type LiveBracketTemplateLibrary, type LiveTemplateApplyResult,
} from '../../lib/liveBracketTemplates';
import {
  deleteLiveBracketTemplate, readLiveBracketTemplates, saveLiveBracketTemplate, setDefaultLiveBracketTemplateId, subscribeLiveBracketTemplates,
} from '../../services/liveBracketTemplateStore';
import { livePreviewButton, livePreviewErrorText, livePreviewKey, livePreviewView, type LivePreviewSnapshot } from '../../lib/livePreviewView';
import { LIVE_TICKET_PREFS_KEY, LIVE_TICKET_RISK_STEP_USD, readLiveTicketPrefs, sanitizeTicketRiskUsd, updateLiveTicketPrefs } from '../../lib/liveTicketPrefs';
import type { LiveTicketScaleIn } from '../../lib/liveScaleIn';
import { playNativeHapticIfAvailable } from '../../services/nativeCapabilities';
import SheetGrip from './SheetGrip';

const SELL = '#ef4655';
const BUY = '#2f6bff';
const LOSS = '#ff8c95';
const GAIN = '#34d399';

const price = (value: number) => value.toFixed(2);
const money = (value: number) => `$${Math.round(Math.abs(value)).toLocaleString('cs-CZ')}`;
const parsePrice = (text: string): number | null => {
  const value = Number.parseFloat(text.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : null;
};
const contractsWord = (count: number) => (count === 1 ? 'kontrakt' : count >= 2 && count <= 4 ? 'kontrakty' : 'kontraktů');
const nameKey = (name: string) => name.trim().toLocaleLowerCase('cs-CZ');

const UNIT_LABEL: Record<TicketBracketUnits, string> = { price: 'Cena', pts: 'Body', ticks: 'Ticky', usd: '$' };
const UNIT_SUFFIX: Record<TicketBracketUnits, string> = { price: '', pts: 'b', ticks: 't', usd: '$' };
const UNITS: readonly TicketBracketUnits[] = ['price', 'pts', 'ticks', 'usd'];

/**
 * Co list potřebuje z LIVE desku (`LivePhoneTradeBridge`) — jen brány, strop, přikoupení
 * a náhled. Odesílací cesty (`place`, `attach`, `flatten`, `manage`) list nikdy nedostane:
 * odeslání jde dál jen přes `onSubmit` rodiče (INV-UI-01, „⚡ jen vyplní“).
 */
export type LivePhoneSheetTrade = Pick<LivePhoneTradeBridge, 'blockedReason' | 'marketSupported' | 'bareSupported' | 'maxContracts' | 'frontContract' | 'scaleIn' | 'preview'>;

type PrefsStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** localStorage zařízení, nebo null (soukromé okno, náhled, test) — nikdy nevyhodí. */
export const livePhoneDeviceStorage = (): PrefsStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage ?? null;
  } catch {
    return null;
  }
};

/**
 * Jednotky polí SL/TP v listu: sdílená předvolba panelu (`liveTicketPrefs`); dokud ji uživatel
 * nikdy neuložil, telefon dál ukazuje ceny (dosavadní chování listu, U2).
 */
export function livePhoneSheetUnits(storage: PrefsStorage | null): TicketBracketUnits {
  try {
    if (!storage || storage.getItem(LIVE_TICKET_PREFS_KEY) == null) return 'price';
  } catch {
    return 'price';
  }
  return readLiveTicketPrefs(storage).units;
}

/**
 * Co list (i lišta návrhu) odešle (U2): velikost vždy v kontraktech = zobrazené N,
 * u „Riziko $“ zaokrouhlené dolů (`ticketQuantity`). Do workeru nikdy nejde `riskUsd`,
 * jen výslovné N, které uživatel viděl (INV-UI-04); riziko worker přepočítá sám.
 */
export function livePhoneSheetSubmitDraft(draft: TicketDraft, instrument: TicketInstrument, quote: TicketQuote): TicketDraft {
  return { ...draft, sizing: 'qty', quantity: ticketQuantity(draft, instrument, quote) };
}

/**
 * Příkaz z návrhu listu — PŘESNĚ jako odeslání v `LivePhoneChart` (`livePhoneSheetEntry`
 * s kontraktem z IBKR, u Limitu bez IBKR front kontrakt podle brokera). Náhled tak ověřuje
 * totéž, co by odešlo; odeslání ho smí použít taky. Jen příprava, nic neodesílá.
 */
export function livePhoneSheetPayload(
  draft: TicketDraft,
  instrument: TicketInstrument,
  liveQuote: LivePhoneQuote | null,
  frontContract: string | null,
): LiveEntryPreviewDraft | { error: string } {
  if (!liveQuote) return { error: 'Cena trhu zatím není — nic se neodeslalo.' };
  return livePhoneSheetEntry(draft, instrument, { ...liveQuote, symbol: liveQuote.symbol ?? (draft.type === 'limit' ? frontContract : null) });
}

/**
 * Klíč výsledku náhledu (`livePreviewKey`). U Marketu bez ceny a času kotace — jedou
 * s každým tickem a výsledek by zmizel dřív, než se dá přečíst; jiný návrh (strana, počet,
 * SL/TP) nebo stav kopírky ho dál zahodí. Náhled nic neautorizuje, telefon z něj neodesílá.
 */
export function livePhoneSheetPreviewKey(resetKey: string, payload: LiveEntryPreviewDraft | { error: string }): string {
  if ('error' in payload) return '';
  return livePreviewKey(resetKey, payload.orderType === 'Market' ? { ...payload, referencePrice: 0, quoteReceivedAt: 0 } : payload);
}

/**
 * Problémy návrhu v listu: výpočet panelu (`ticketProblems`), varování Marketu se SL/TP pod
 * 16 ticků a — s deskem — stejné brány, které by odeslání rodiče stejně zastavilo (nohy,
 * Market bez capability, přikoupení, strop). Jen UI pojistka: smí být přísnější, nikdy volnější.
 */
export function livePhoneSheetProblems(
  draft: TicketDraft,
  instrument: TicketInstrument,
  quote: TicketQuote,
  trade: LivePhoneSheetTrade | null | undefined,
): TicketProblem[] {
  const problems = ticketProblems(draft, instrument, quote, null);
  const tooClose = liveMarketBracketDistanceProblem(draft, instrument, quote);
  if (tooClose) problems.push(tooClose);
  if (!trade) return problems;
  const quantity = ticketQuantity(draft, instrument, quote);
  const legs = liveTicketLegsProblem(draft, trade.bareSupported);
  if (legs) problems.push({ level: 'error', text: legs });
  if (draft.type === 'market' && !trade.marketSupported) problems.push({ level: 'error', text: 'Worker zatím neumí Market — použij Limit.' });
  const scale = livePhoneScaleInBlocked({ ...draft, sizing: 'qty', quantity }, quantity, trade.scaleIn, trade.maxContracts);
  if (scale) problems.push({ level: 'error', text: scale });
  else if (quantity > trade.maxContracts) problems.push({ level: 'error', text: `Strop ručního vstupu je ${trade.maxContracts} ${contractsWord(trade.maxContracts)}.` });
  return problems;
}

/**
 * Proč „Zkontrolovat u workeru“ teď nejde (null = smí). Brána desku beze změny, čerstvá
 * kotace (≤ 3 s, jako odeslání), návrh bez chyb a příkaz, který jde postavit.
 */
export function livePhoneSheetPreviewBlocked(input: {
  blockedReason: string | null;
  problems: readonly TicketProblem[];
  payload: LiveEntryPreviewDraft | { error: string };
  liveQuote: LivePhoneQuote | null;
  now: number;
}): string | null {
  if (input.blockedReason) return input.blockedReason;
  if (!input.liveQuote || !(input.now - input.liveQuote.at <= LIVE_BARE_QUOTE_MAX_AGE_MS)) return 'Cena není čerstvá — náhled teď nejde.';
  const error = input.problems.find(problem => problem.level === 'error');
  if (error) return `Nejdřív oprav: ${error.text}`;
  return 'error' in input.payload ? input.payload.error : null;
}

/**
 * Nový návrh („+“ v grafu) s výchozí šablonou (U8) místo pevných 12 b / 2R. Přikoupení
 * (návrh na stranu pozice) šablonu ignoruje — platí SL/TP pozice. Automaticky jen závorky:
 * velikost šablony až výslovným klepnutím na čip (počet z lišty zůstává). Bez šablony beze změny.
 */
export function livePhoneSheetStartDraft(
  initial: TicketDraft,
  template: LiveBracketTemplate | null,
  instrument: TicketInstrument,
  quote: TicketQuote,
  scaleIn: Pick<LiveTicketScaleIn, 'side'> | null | undefined,
): LiveTemplateApplyResult {
  if (!template) return { draft: initial, applied: false, skipped: null, notes: [] };
  return applyLiveBracketTemplate(initial, template, instrument, quote, { scaleIn: scaleIn ?? null, applySizing: false });
}

/** Řádek pod velikostí „Riziko $“: „→ N kontraktů · skutečné riziko $X“ (Market jen odhad). */
export function livePhoneSheetSizingLine(draft: TicketDraft, m: TicketMetrics): string | null {
  if (draft.sizing !== 'risk') return null;
  if (draft.stopLoss == null) return '→ bez stop lossu velikost z rizika nejde';
  if (m.quantity < 1 || m.stopLossUsd == null) return '→ 0 kontraktů — riziko nestačí ani na 1';
  const estimate = draft.type === 'market';
  return `→ ${m.quantity} ${contractsWord(m.quantity)} · skutečné riziko ${estimate ? '≈ ' : ''}${money(m.stopLossUsd)}${estimate ? ' (odhad z ceny grafu)' : ''}`;
}

/**
 * Objednávka z position toolu na telefonu (jako „Vytvořit limitní objednávku…“
 * v TradingView). Počítá stejně jako panel na PC (lib/liveOrderTicket.ts).
 * Jen návrh: tlačítko odeslání volá `onSubmit` a samo nic neodesílá.
 *
 * U2/U8 (3. 11. 2026): velikost „Kontrakty | Riziko $“ (odchází zobrazené N),
 * SL/TP v jednotkách (cena / body / ticky / $), šablony SL/TP, „Zkontrolovat
 * u workeru“ (deskový náhled — nic neodešle a netvrdí „připraveno“) a „Upravit
 * v grafu“. Všechny nové props jsou volitelné; bez nich list funguje jako dřív.
 */
export default function LivePhoneOrderSheet({
  initial, instrument, quote, onSubmit, onClose,
  trade = null, liveQuote = null, userId = null, applyDefaultTemplate = false, onEditInChart,
}: {
  initial: TicketDraft;
  instrument: TicketInstrument;
  /** Orientační cena z grafu (INV-UI-04: odeslání ji musí přepočítat u brokera). */
  quote: TicketQuote;
  onSubmit: (draft: TicketDraft) => void;
  onClose: () => void;
  /** Brány desku, strop, přikoupení a náhled (`LivePhoneTradeBridge`); null = jen výpočet jako dřív. */
  trade?: LivePhoneSheetTrade | null;
  /** Kotace kanálu ceny (kontrakt jen z IBKR, čas ticku) pro náhled u workeru; null = náhled nejde. */
  liveQuote?: LivePhoneQuote | null;
  /** Klíč knihovny šablon SL/TP na zařízení; bez přihlášení jen vestavěná 12 b / 2R, nic se neukládá. */
  userId?: string | null;
  /** Nový návrh („+“): výchozí šablona (★) nahradí 12 b / 2R. Position box (⚡) false — SL/TP z boxu. */
  applyDefaultTemplate?: boolean;
  /** „Upravit v grafu“: list se stáhne do lišty návrhu (dostane aktuální návrh). Chybí = tlačítko není. */
  onEditInChart?: (draft: TicketDraft) => void;
}) {
  const [boot] = useState(() => {
    const library = readLiveBracketTemplates(userId).library;
    const template = applyDefaultTemplate ? defaultLiveBracketTemplate(library) : null;
    const start = livePhoneSheetStartDraft(initial, template, instrument, quote, trade?.scaleIn ?? null);
    return { library, draft: start.draft, templateId: start.applied && template ? template.id : null };
  });
  const [draft, setDraft] = useState<TicketDraft>(boot.draft);
  // Vypnutý TP/SL si pamatuje poslední cenu, ať se po zapnutí vrátí.
  const [memo, setMemo] = useState({ tp: boot.draft.takeProfit, sl: boot.draft.stopLoss });
  const [text, setText] = useState({ price: price(boot.draft.price), qty: String(boot.draft.quantity) });
  // Pole SL/TP drží text jen během psaní; jinak ukazuje hodnotu návrhu v jednotkách.
  const [exitEdit, setExitEdit] = useState<{ field: 'tp' | 'sl'; text: string } | null>(null);
  const [units, setUnitsState] = useState<TicketBracketUnits>(() => livePhoneSheetUnits(livePhoneDeviceStorage()));
  const [riskText, setRiskText] = useState<string | null>(null);

  // Šablony (U8): jen předvyplnění návrhu, nic neodesílají.
  const [library, setLibrary] = useState<LiveBracketTemplateLibrary>(boot.library);
  useEffect(() => {
    setLibrary(readLiveBracketTemplates(userId).library);
    return subscribeLiveBracketTemplates(userId, read => setLibrary(read.library));
  }, [userId]);
  const [templateId, setTemplateId] = useState<string | null>(boot.templateId);
  const [templateNote, setTemplateNote] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const [saving, setSaving] = useState<{ name: string; withSize: boolean; targetR: boolean; asDefault: boolean } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<LiveConfirmState | null>(null);

  // Náhled u workeru (U2): výsledek jen pro tentýž návrh a stav kopírky, po 15 s zešedne.
  const [snapshot, setSnapshot] = useState<LivePreviewSnapshot | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewBusyRef = useRef(false);
  const [, setClock] = useState(0);
  const resetKey = trade?.blockedReason ?? 'ok';
  useEffect(() => { setSnapshot(null); }, [resetKey]);
  useEffect(() => {
    if (!snapshot?.result) return undefined;
    const timer = window.setInterval(() => setClock(value => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [snapshot?.result]);
  useEffect(() => {
    if (!deleteConfirm) return undefined;
    const timer = window.setTimeout(() => setDeleteConfirm(null), Math.max(0, deleteConfirm.at + LIVE_CONFIRM_WINDOW_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [deleteConfirm]);

  const now = Date.now();
  const tick = instrument.tickSize;
  const m = ticketMetrics(draft, instrument, quote);
  const problems = livePhoneSheetProblems(draft, instrument, quote, trade);
  const blocked = problems.some(problem => problem.level === 'error') || trade?.blockedReason != null;
  const sell = draft.side === 'sell';
  const market = draft.type === 'market';
  const risk = draft.sizing === 'risk';
  const ticks = (points: number | null) => (points == null ? null : Math.round(Math.abs(points) / tick));
  const slTicks = ticks(m.stopLossPoints);
  const tpTicks = ticks(m.takeProfitPoints);
  const reference = sell ? quote.bid : quote.ask;
  const relative = Math.round((m.entry - reference) / tick);
  const submitDraft = livePhoneSheetSubmitDraft(draft, instrument, quote);
  const payload = livePhoneSheetPayload(submitDraft, instrument, liveQuote, trade?.frontContract ?? null);
  const previewKey = livePhoneSheetPreviewKey(resetKey, payload);
  const previewBlocked = livePhoneSheetPreviewBlocked({ blockedReason: trade?.blockedReason ?? null, problems, payload, liveQuote, now });
  const shownPreview = snapshot && previewKey !== '' && snapshot.key === previewKey ? snapshot : null;
  const scaleLocked = trade?.scaleIn != null && trade.scaleIn.side === draft.side;

  const update = (next: TicketDraft) => setDraft(next);
  const setSide = (side: 'buy' | 'sell') => {
    if (side === draft.side) return;
    playNativeHapticIfAvailable('selection');
    update(withSide(draft, side, quote, instrument));
  };
  const setType = (type: TicketOrderType) => { playNativeHapticIfAvailable('selection'); update({ ...draft, type }); };
  const setQty = (quantity: number) => { const qty = Math.max(1, Math.min(999, Math.floor(quantity))); update({ ...draft, quantity: qty }); setText(current => ({ ...current, qty: String(qty) })); };
  const setSizing = (sizing: 'qty' | 'risk') => {
    if (sizing === draft.sizing) return;
    playNativeHapticIfAvailable('selection');
    if (sizing === 'risk') {
      update({ ...draft, sizing, riskUsd: sanitizeTicketRiskUsd(readLiveTicketPrefs(livePhoneDeviceStorage()).riskUsd) });
      return;
    }
    // Zpět na kontrakty s počtem, který riziko právě dávalo (nic neskočí).
    const qty = Math.max(1, m.quantity);
    update({ ...draft, sizing, quantity: qty });
    setText(current => ({ ...current, qty: String(qty) }));
  };
  const setRisk = (value: number) => {
    const riskUsd = sanitizeTicketRiskUsd(value);
    update({ ...draft, riskUsd });
    updateLiveTicketPrefs(livePhoneDeviceStorage(), { riskUsd });
  };
  const setUnits = (next: TicketBracketUnits) => {
    if (next === units) return;
    playNativeHapticIfAvailable('selection');
    setUnitsState(next);
    setExitEdit(null);
    updateLiveTicketPrefs(livePhoneDeviceStorage(), { units: next });
  };
  const editPrice = (value: string) => {
    setText(current => ({ ...current, price: value }));
    const parsed = parsePrice(value);
    if (parsed != null) update({ ...draft, price: snapToTick(parsed, tick) });
  };
  const blurPrice = () => setText(current => ({ ...current, price: price(draft.price) }));
  const editExit = (field: 'tp' | 'sl', value: string) => {
    setExitEdit({ field, text: value });
    const parsed = parsePrice(value);
    if (parsed == null) return;
    const next = bracketPriceFromInput(draft, field, units, parsed, instrument, quote);
    if (next == null) return;
    if (field === 'tp') { update({ ...draft, takeProfit: next }); setMemo(current => ({ ...current, tp: next })); }
    else { update({ ...draft, stopLoss: next }); setMemo(current => ({ ...current, sl: next })); }
  };
  const exitValue = (field: 'tp' | 'sl'): string => {
    if (exitEdit?.field === field) return exitEdit.text;
    const value = bracketDisplayValue(draft, field, units, instrument, quote);
    return value == null ? '' : units === 'ticks' ? String(Math.round(value)) : value.toFixed(2);
  };
  const toggleExit = (field: 'tp' | 'sl') => {
    playNativeHapticIfAvailable('selection');
    const key = field === 'tp' ? 'takeProfit' : 'stopLoss';
    if (draft[key] != null) { update({ ...draft, [key]: null }); return; }
    // Zapnutí: poslední cena, jinak výchozí šablona (★) jen pro chybějící nohu, jinak 12 / 24 b.
    const entry = ticketEntry(draft, quote);
    const d = sell ? -1 : 1;
    const fallback = snapToTick(field === 'tp' ? entry + d * 24 : entry - d * 12, tick);
    const fromTemplate = applyLiveBracketTemplate({ ...draft, [key]: null }, defaultLiveBracketTemplate(library), instrument, quote, { onlyMissing: true }).draft[key];
    update({ ...draft, [key]: memo[field] ?? fromTemplate ?? fallback });
  };
  const note = (tone: 'ok' | 'bad' | 'warn', textValue: string | null) => setTemplateNote(textValue ? { tone, text: textValue } : null);
  const applyTemplate = (template: LiveBracketTemplate) => {
    playNativeHapticIfAvailable('selection');
    const result = applyLiveBracketTemplate(draft, template, instrument, quote, { scaleIn: trade?.scaleIn ?? null, ...(trade ? { maxContracts: trade.maxContracts } : {}) });
    if (result.skipped === 'scale-in') { note('warn', 'Přikoupení: platí SL a TP pozice — šablona se nepoužije.'); return; }
    if (result.skipped) { note('bad', result.notes[0] ?? 'Šablonu teď nejde použít.'); return; }
    update(result.draft);
    setMemo(current => ({ tp: result.draft.takeProfit ?? current.tp, sl: result.draft.stopLoss ?? current.sl }));
    if (result.draft.quantity !== draft.quantity) setText(current => ({ ...current, qty: String(result.draft.quantity) }));
    setExitEdit(null);
    setTemplateId(template.id);
    setDeleteConfirm(null);
    note('warn', result.notes.join(' ') || null);
  };
  const saveTemplate = () => {
    if (!saving) return;
    const created = liveTemplateFromDraft(draft, instrument, quote, { name: saving.name, targetUnit: saving.targetR ? 'r' : 'ticks', includeSizing: saving.withSize });
    if ('errors' in created) { note('bad', created.errors.join(' ')); return; }
    const written = saveLiveBracketTemplate(userId, created.template);
    if ('error' in written) { note('bad', written.error); return; }
    // Stejný název = přepis té šablony (id zůstává) — uložené id podle názvu.
    const saved = written.library.templates.find(template => nameKey(template.name) === nameKey(created.template.name)) ?? null;
    let nextLibrary = written.library;
    if (saving.asDefault && saved) {
      const starred = setDefaultLiveBracketTemplateId(userId, saved.id);
      if ('error' in starred) { note('bad', starred.error); return; }
      nextLibrary = starred.library;
    }
    setLibrary(nextLibrary);
    setTemplateId(saved?.id ?? null);
    setSaving(null);
    note('ok', `Šablona „${created.template.name}“ uložena${saving.asDefault ? ' jako výchozí' : ''}.`);
  };
  const starTemplate = (template: LiveBracketTemplate, builtIn: boolean) => {
    const written = setDefaultLiveBracketTemplateId(userId, builtIn ? null : template.id);
    if ('error' in written) { note('bad', written.error); return; }
    setLibrary(written.library);
    note('ok', `Výchozí šablona: ${template.name}.`);
  };
  const removeTemplate = (template: LiveBracketTemplate) => {
    // Smazání na dvě klepnutí (druhé 350 ms až 4 s po prvním, klíč = šablona).
    const step = liveConfirmClick(deleteConfirm, `delete-template:${template.id}`, Date.now());
    setDeleteConfirm(step.next);
    if (!step.send) return;
    const written = deleteLiveBracketTemplate(userId, template.id);
    if ('error' in written) { note('bad', written.error); return; }
    setLibrary(written.library);
    setTemplateId(null);
    note('ok', `Šablona „${template.name}“ smazána.`);
  };
  const runPreview = async () => {
    // Náhled nic neautorizuje; jeden naráz (relay: jeden na zařízení, rozestup 3 s).
    if (!trade?.preview || previewBusyRef.current || previewBlocked || 'error' in payload) return;
    const key = previewKey;
    previewBusyRef.current = true;
    setPreviewBusy(true);
    try {
      const result = await trade.preview(payload);
      // Stáří od přijetí v tomto zařízení — hodiny telefonu a Macu se můžou lišit.
      setSnapshot({ key, result, receivedAt: Date.now() });
    } catch (reason) {
      setSnapshot({ key, error: livePreviewErrorText(reason instanceof Error ? reason.message : 'Náhled se nepodařil.') });
    } finally {
      previewBusyRef.current = false;
      setPreviewBusy(false);
    }
  };

  const label: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '14px 2px 6px', fontSize: 12, fontWeight: 700, color: 'var(--dj-muted)' };
  const box = (bad: boolean, dim = false): React.CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 8, height: 46, padding: '0 12px', borderRadius: 12, border: `1px solid ${bad ? 'rgba(239,70,85,.7)' : 'var(--dj-line)'}`, background: 'var(--dj-chip)', opacity: dim ? 0.45 : 1 });
  const input: React.CSSProperties = { flex: 1, minWidth: 0, height: '100%', border: 0, outline: 0, background: 'transparent', color: 'var(--dj-text)', font: '600 16px "JetBrains Mono", ui-monospace, monospace' };
  const segGroup: React.CSSProperties = { display: 'grid', gap: 4, padding: 4, borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)' };
  const seg = (on: boolean): React.CSSProperties => ({ height: 30, borderRadius: 9, border: 0, cursor: 'pointer', font: '700 12px Inter, sans-serif', background: on ? 'var(--dj-seg-on)' : 'transparent', color: on ? 'var(--dj-seg-on-ink)' : 'var(--dj-muted)' });
  const chip = (on: boolean): React.CSSProperties => ({ flex: 'none', height: 32, padding: '0 10px', borderRadius: 9, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', border: `1px solid ${on ? 'rgba(129,140,248,.6)' : 'var(--dj-line)'}`, background: on ? 'var(--dj-indigo-bg-soft)' : 'transparent', color: 'var(--dj-text)', font: '700 12px Inter, sans-serif' });
  const smallButton: React.CSSProperties = { width: 34, height: 34, borderRadius: 9, border: 0, background: 'var(--dj-chip)', color: 'var(--dj-text)', display: 'grid', placeItems: 'center', cursor: 'pointer' };
  const row = (name: string, value: React.ReactNode) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderTop: '1px solid var(--dj-line)', fontSize: 13 }}>
      <span style={{ color: 'var(--dj-muted)' }}>{name}</span><b className="dj-mono" style={{ fontSize: 13 }}>{value}</b>
    </div>
  );
  const switchButton = (on: boolean, onClick: () => void, name: string) => (
    <button type="button" role="switch" aria-checked={on} aria-label={name} className="dj-btn" onClick={onClick} style={{ width: 46, height: 28, borderRadius: 99, padding: 3, boxSizing: 'border-box', border: '1px solid var(--dj-line)', cursor: 'pointer', background: on ? 'linear-gradient(180deg,#6366f1,#4f46e5)' : 'var(--dj-chip)', display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start' }}>
      <span style={{ width: 20, height: 20, borderRadius: 99, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
    </button>
  );
  const toneColor = (tone: 'ok' | 'bad' | 'warn') => (tone === 'ok' ? GAIN : tone === 'bad' ? LOSS : 'var(--dj-amber-text)');
  const exitProblem = (which: 'Take profit' | 'Stop loss') => problems.some(problem => problem.level === 'error' && problem.text.startsWith(which));
  const priceProblem = problems.some(problem => /^(Limit je|Stop je)/.test(problem.text));
  const choices = liveBracketTemplateChoices(library, tick);
  const selected = templateId ? choices.find(choice => choice.template.id === templateId) ?? null : null;
  const previewButton = livePreviewButton({ hasDraft: !('error' in payload), blockedReason: previewBlocked, busy: previewBusy });
  const preview = shownPreview?.result && shownPreview.receivedAt != null
    ? livePreviewView({ result: shownPreview.result, receivedAt: shownPreview.receivedAt, now, blockedReason: previewBlocked, placeSupported: false, operationId: null, pointValue: instrument.pointValue })
    : null;
  const sizingLine = livePhoneSheetSizingLine(draft, m);

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 46 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', animation: 'dj-fade .18s ease both' }} />
      <section aria-label="Objednávka" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, top: 'calc(env(safe-area-inset-top, 0px) + 36px)', display: 'flex', flexDirection: 'column', borderRadius: '20px 20px 0 0', background: 'var(--dj-sheet, var(--dj-card))', borderTop: '1px solid var(--dj-line)', animation: 'dj-sheet .28s cubic-bezier(.2,.9,.25,1) both' }}>
        <div style={{ padding: '8px 16px 0' }}><SheetGrip onClose={onClose} gap={4} /></div>
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 16px 8px' }}>
          <p style={{ margin: 0, flex: 1, fontSize: 16, fontWeight: 800 }}>{instrument.symbol} · objednávka</p>
          <button type="button" className="dj-btn" aria-label="Zavřít" onClick={onClose} style={{ width: 30, height: 30, borderRadius: 15, border: 0, background: 'var(--dj-chip)', color: 'var(--dj-muted)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}><X size={16} /></button>
        </div>
        <div className="dj-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '0 16px 12px' }}>
          {/* Riziko a cíl v USD hned nahoře. */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)' }}>
              <span style={{ fontSize: 11.5, color: 'var(--dj-muted)', fontWeight: 700 }}>Riziko</span>
              <b className="dj-mono" style={{ display: 'block', fontSize: 18, color: LOSS }}>{m.stopLossUsd != null ? `−${money(m.stopLossUsd)}` : 'bez SL'}</b>
              <span className="dj-mono" style={{ fontSize: 11.5, color: 'var(--dj-muted)' }}>{slTicks != null ? `${slTicks} t` : '—'}</span>
            </div>
            <div style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', textAlign: 'right' }}>
              <span style={{ fontSize: 11.5, color: 'var(--dj-muted)', fontWeight: 700 }}>Cíl</span>
              <b className="dj-mono" style={{ display: 'block', fontSize: 18, color: GAIN }}>{m.takeProfitUsd != null ? `+${money(m.takeProfitUsd)}` : 'bez TP'}</b>
              <span className="dj-mono" style={{ fontSize: 11.5, color: 'var(--dj-muted)' }}>{tpTicks != null ? `${tpTicks} t` : '—'}</span>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 6, marginTop: 12 }}>
            {(['sell', 'buy'] as const).map((side, index) => {
              const on = draft.side === side;
              const color = side === 'sell' ? SELL : BUY;
              const button = (
                <button key={side} type="button" className="dj-btn" aria-pressed={on} onClick={() => setSide(side)} style={{ height: 50, borderRadius: 12, cursor: 'pointer', border: `1px solid ${on ? color : 'var(--dj-line)'}`, background: on ? color : 'transparent', color: on ? '#fff' : 'var(--dj-text-2)', font: '800 14px Inter, sans-serif', lineHeight: 1.15 }}>
                  {side === 'sell' ? 'Prodat' : 'Koupit'}
                  <span className="dj-mono" style={{ display: 'block', fontSize: 12, fontWeight: 600, opacity: 0.85 }}>{price(side === 'sell' ? quote.bid : quote.ask)}</span>
                </button>
              );
              // Spread až s bid/ask ze streamu; z ceny svíčky by byl vždy 0.
              return index === 0 ? [button, <span key="spread" className="dj-mono" style={{ fontSize: 11, color: 'var(--dj-muted)' }}>{quote.ask > quote.bid ? (quote.ask - quote.bid).toFixed(2) : ''}</span>] : button;
            })}
          </div>

          <div role="radiogroup" aria-label="Typ příkazu" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, padding: 4, marginTop: 12, borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)' }}>
            {(['market', 'limit', 'stop'] as const).map(type => (
              <button key={type} type="button" role="radio" aria-checked={draft.type === type} className="dj-btn" onClick={() => setType(type)} style={{ height: 34, borderRadius: 9, border: 0, cursor: 'pointer', font: '700 12.5px Inter, sans-serif', background: draft.type === type ? 'var(--dj-seg-on)' : 'transparent', color: draft.type === type ? 'var(--dj-seg-on-ink)' : 'var(--dj-muted)' }}>{type === 'market' ? 'Market' : type === 'limit' ? 'Limit' : 'Stop'}</button>
            ))}
          </div>

          <div style={label}><span>Cena</span><span>{market ? 'market vezme aktuální cenu' : draft.type === 'limit' ? 'limitní vstup' : 'stop vstup'}</span></div>
          <div style={box(priceProblem)}>
            <input aria-label="Cena" inputMode="decimal" disabled={market} value={market ? `Trh · ${price(m.entry)}` : text.price} onChange={event => editPrice(event.target.value)} onBlur={blurPrice} style={input} />
            {!market && <span className="dj-mono" style={{ fontSize: 12, color: 'var(--dj-muted)', whiteSpace: 'nowrap' }}>{sell ? 'Bid' : 'Ask'} {relative >= 0 ? '+' : '−'} {Math.abs(relative)} t</span>}
          </div>

          <div style={label}><span>Velikost</span><span>{risk ? `krok ${LIVE_TICKET_RISK_STEP_USD} $` : m.stopLossUsd != null ? `riziko ${money(m.stopLossUsd)}` : 'bez stop lossu'}</span></div>
          <div role="radiogroup" aria-label="Velikost" style={{ ...segGroup, gridTemplateColumns: '1fr 1fr', marginBottom: 6 }}>
            {(['qty', 'risk'] as const).map(sizing => (
              <button key={sizing} type="button" role="radio" aria-checked={draft.sizing === sizing} className="dj-btn" onClick={() => setSizing(sizing)} style={seg(draft.sizing === sizing)}>{sizing === 'qty' ? 'Kontrakty' : 'Riziko $'}</button>
            ))}
          </div>
          {risk ? (
            <>
              <div style={box(m.quantity < 1)}>
                <button type="button" className="dj-btn" aria-label={`Riziko −${LIVE_TICKET_RISK_STEP_USD} $`} onClick={() => { setRiskText(null); setRisk(draft.riskUsd - LIVE_TICKET_RISK_STEP_USD); }} style={smallButton}><Minus size={16} /></button>
                <input
                  aria-label="Riziko v dolarech"
                  inputMode="numeric"
                  value={riskText ?? `$${draft.riskUsd}`}
                  onFocus={() => setRiskText(String(draft.riskUsd))}
                  onChange={event => setRiskText(event.target.value)}
                  onBlur={() => { const parsed = parsePrice((riskText ?? '').replace('$', '')); setRiskText(null); if (parsed != null) setRisk(parsed); }}
                  onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                  style={{ ...input, textAlign: 'center' }}
                />
                <button type="button" className="dj-btn" aria-label={`Riziko +${LIVE_TICKET_RISK_STEP_USD} $`} onClick={() => { setRiskText(null); setRisk(draft.riskUsd + LIVE_TICKET_RISK_STEP_USD); }} style={smallButton}><Plus size={16} /></button>
              </div>
              {sizingLine && <p className="dj-mono" style={{ margin: '6px 2px 0', fontSize: 12.5, fontWeight: 700, color: m.quantity < 1 ? LOSS : 'var(--dj-text)' }}>{sizingLine}</p>}
            </>
          ) : (
            <div style={box(m.quantity < 1)}>
              <button type="button" className="dj-btn" aria-label="Méně" onClick={() => setQty(draft.quantity - 1)} style={smallButton}><Minus size={16} /></button>
              <input aria-label="Kontrakty" inputMode="numeric" value={text.qty} onChange={event => { setText(current => ({ ...current, qty: event.target.value })); const value = Number.parseInt(event.target.value, 10); if (value > 0) update({ ...draft, quantity: Math.min(999, value) }); }} onBlur={() => setText(current => ({ ...current, qty: String(draft.quantity) }))} style={{ ...input, textAlign: 'center' }} />
              <button type="button" className="dj-btn" aria-label="Více" onClick={() => setQty(draft.quantity + 1)} style={smallButton}><Plus size={16} /></button>
            </div>
          )}

          {/* Šablony SL/TP (U8): jen předvyplní návrh; přikoupení je ignoruje (SL/TP pozice). */}
          <div style={{ ...label, marginTop: 18 }}><span>Šablona SL/TP</span>{scaleLocked && <span>přikoupení · SL/TP pozice</span>}</div>
          <div className="dj-scroll" style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
            {choices.map(choice => (
              <button key={choice.template.id} type="button" className="dj-btn" aria-pressed={choice.template.id === templateId} disabled={scaleLocked} onClick={() => applyTemplate(choice.template)} title={market ? choice.marketWarning ?? undefined : undefined} style={{ ...chip(choice.template.id === templateId), opacity: scaleLocked ? 0.45 : 1 }}>
                {choice.isDefault && <Star size={12} fill="currentColor" aria-label="výchozí" />}
                <span>{choice.label}</span>
                {choice.sizingLabel && <span style={{ color: 'var(--dj-muted)' }}>· {choice.sizingLabel}</span>}
                {market && choice.marketWarning && <span style={{ color: 'var(--dj-amber-text)' }}>!</span>}
              </button>
            ))}
            {userId && !saving && <button type="button" className="dj-btn" onClick={() => setSaving({ name: '', withSize: false, targetR: false, asDefault: false })} style={chip(false)}><Plus size={12} />Uložit</button>}
          </div>
          {selected && !saving && (
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              {userId && !selected.isDefault && <button type="button" className="dj-btn" onClick={() => starTemplate(selected.template, selected.builtIn)} style={chip(false)}><Star size={12} />Nastavit jako výchozí</button>}
              {userId && !selected.builtIn && (
                <button type="button" className="dj-btn" onClick={() => removeTemplate(selected.template)} style={{ ...chip(false), color: liveConfirmAsking(deleteConfirm, `delete-template:${selected.template.id}`, now) ? LOSS : 'var(--dj-text)' }}>
                  <Trash2 size={12} />{liveConfirmAsking(deleteConfirm, `delete-template:${selected.template.id}`, now) ? 'Opravdu smazat?' : 'Smazat'}
                </button>
              )}
            </div>
          )}
          {saving && (
            <div style={{ display: 'grid', gap: 6, marginTop: 8, padding: 10, borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)' }}>
              <input aria-label="Název šablony" placeholder="Název (např. Scalp)" maxLength={32} value={saving.name} onChange={event => setSaving({ ...saving, name: event.target.value })} style={{ ...input, height: 38, padding: '0 10px', borderRadius: 9, border: '1px solid var(--dj-line)', fontSize: 14 }} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <button type="button" className="dj-btn" aria-pressed={saving.targetR} onClick={() => setSaving({ ...saving, targetR: !saving.targetR })} style={chip(saving.targetR)}>TP jako R</button>
                <button type="button" className="dj-btn" aria-pressed={saving.withSize} onClick={() => setSaving({ ...saving, withSize: !saving.withSize })} style={chip(saving.withSize)}>I velikost</button>
                <button type="button" className="dj-btn" aria-pressed={saving.asDefault} onClick={() => setSaving({ ...saving, asDefault: !saving.asDefault })} style={chip(saving.asDefault)}><Star size={12} />Výchozí</button>
              </div>
              <p style={{ margin: 0, fontSize: 11.5, color: 'var(--dj-muted)' }}>Ukládá jen vzdálenost SL/TP od vstupu (ticky / R), žádnou cenu.</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 6 }}>
                <button type="button" className="dj-btn" onClick={() => setSaving(null)} style={{ ...chip(false), justifyContent: 'center' }}>Zrušit</button>
                <button type="button" className="dj-btn" disabled={saving.name.trim() === ''} onClick={saveTemplate} style={{ ...chip(true), justifyContent: 'center', opacity: saving.name.trim() === '' ? 0.5 : 1 }}>Uložit šablonu</button>
              </div>
            </div>
          )}
          {templateNote && <p role="status" style={{ margin: '6px 2px 0', fontSize: 12, fontWeight: 600, color: toneColor(templateNote.tone) }}>{templateNote.text}</p>}

          <div style={{ ...label, marginTop: 18 }}><span>Výstupy</span></div>
          <div role="radiogroup" aria-label="Jednotky SL a TP" style={{ ...segGroup, gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 8 }}>
            {UNITS.map(unit => (
              <button key={unit} type="button" role="radio" aria-checked={units === unit} className="dj-btn" onClick={() => setUnits(unit)} style={seg(units === unit)}>{UNIT_LABEL[unit]}</button>
            ))}
          </div>
          {(['tp', 'sl'] as const).map(field => {
            const exit = field === 'tp' ? draft.takeProfit : draft.stopLoss;
            const on = exit != null;
            const usd = field === 'tp' ? m.takeProfitUsd : m.stopLossUsd;
            const t = field === 'tp' ? tpTicks : slTicks;
            const name = field === 'tp' ? 'Take profit' : 'Stop loss';
            return (
              <div key={field} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '4px 2px 6px' }}>
                  <span style={{ fontSize: 14, fontWeight: 700 }}>{name}</span>
                  {switchButton(on, () => toggleExit(field), name)}
                </div>
                <div style={box(exitProblem(field === 'tp' ? 'Take profit' : 'Stop loss'), !on)}>
                  <input aria-label={units === 'price' ? `Cena ${field === 'tp' ? 'take profit' : 'stop loss'}` : `${name} v jednotkách ${UNIT_LABEL[units]}`} inputMode="decimal" disabled={!on} value={on ? exitValue(field) : ''} placeholder="vypnuto" onChange={event => editExit(field, event.target.value)} onBlur={() => setExitEdit(null)} style={input} />
                  {on && UNIT_SUFFIX[units] && <span className="dj-mono" style={{ fontSize: 12, color: 'var(--dj-muted)' }}>{UNIT_SUFFIX[units]}</span>}
                  {on && usd != null && (
                    <span className="dj-mono" style={{ fontSize: 12, color: 'var(--dj-muted)', whiteSpace: 'nowrap' }}>
                      {units === 'price' ? `${t ?? '—'} t` : `@ ${price(exit!)}`} · <b style={{ color: field === 'tp' ? GAIN : LOSS }}>{field === 'tp' ? '+' : '−'}{money(usd)}</b>
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {problems.length > 0 && (
            <div role="status" style={{ marginTop: 6, display: 'grid', gap: 4 }}>
              {problems.map(problem => <p key={problem.text} style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: problem.level === 'error' ? LOSS : 'var(--dj-amber-text)' }}>{problem.text}</p>)}
            </div>
          )}

          {/* „Zkontrolovat u workeru“ (U2): deskový náhled — nic neodešle, nikdy „připraveno“. */}
          {trade?.preview && (
            <div style={{ display: 'grid', gap: 6, marginTop: 12 }}>
              <button type="button" className="dj-btn" disabled={previewButton.disabled} title={previewButton.title} onClick={() => { playNativeHapticIfAvailable('selection'); void runPreview(); }} style={{ height: 40, borderRadius: 11, border: '1px solid var(--dj-line)', background: 'transparent', color: 'var(--dj-text)', font: '800 12.5px Inter, sans-serif', cursor: previewButton.disabled ? 'not-allowed' : 'pointer', opacity: previewButton.disabled ? 0.5 : 1 }}>{previewButton.label}</button>
              {previewBlocked && <p style={{ margin: 0, fontSize: 11.5, color: 'var(--dj-muted)' }}>{previewBlocked}</p>}
              {shownPreview?.error && <p role="status" style={{ margin: 0, fontSize: 12, fontWeight: 700, color: LOSS }}>Náhled: {shownPreview.error}</p>}
              {preview && (
                <div role="status" style={{ display: 'grid', gap: 4, padding: 10, borderRadius: 12, border: '1px solid var(--dj-line)', background: 'var(--dj-chip)', opacity: preview.stale ? 0.5 : 1, fontSize: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--dj-muted)' }}><span>{preview.header}</span><span>{preview.ageText}</span></div>
                  <b style={{ color: preview.tone === 'blocked' ? LOSS : 'var(--dj-text)' }}>{preview.headline}</b>
                  {preview.leaderLine && <span className="dj-mono" style={{ fontSize: 11.5 }}>{preview.leaderLine}</span>}
                  {preview.followerLines.map(line => <span key={line} className="dj-mono" style={{ fontSize: 11.5 }}>{line}</span>)}
                  {preview.risk && <span style={{ fontWeight: 700, color: LOSS }}>{preview.risk.text}</span>}
                  {preview.blockers.map(blocker => <span key={blocker} style={{ color: LOSS }}>• {blocker}</span>)}
                  {preview.notes.map(item => <span key={item} style={{ color: 'var(--dj-muted)' }}>· {item}</span>)}
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            {row('Riziko (SL)', <span style={{ color: LOSS }}>{m.stopLossUsd != null ? `−${money(m.stopLossUsd)}` : '—'}</span>)}
            {row('Zisk (TP)', <span style={{ color: GAIN }}>{m.takeProfitUsd != null ? `+${money(m.takeProfitUsd)}` : '—'}</span>)}
            {row('Riziko : zisk', m.riskReward != null ? `1 : ${m.riskReward.toFixed(2).replace('.', ',')}` : '—')}
            {row('Tick', `${String(tick).replace('.', ',')} = ${(tick * instrument.pointValue).toFixed(2).replace('.', ',')} USD`)}
          </div>
        </div>
        {trade?.blockedReason && <p role="status" style={{ margin: 0, padding: '8px 16px 0', fontSize: 12, fontWeight: 600, color: 'var(--dj-amber-text)' }}>{trade.blockedReason}</p>}
        <div style={{ display: 'grid', gridTemplateColumns: onEditInChart ? '1fr 1fr 2fr' : '1fr 2fr', gap: 8, padding: '10px 16px calc(12px + var(--dj-safe-bottom, env(safe-area-inset-bottom, 0px)))', borderTop: '1px solid var(--dj-line)' }}>
          <button type="button" className="dj-btn" onClick={onClose} style={{ height: 48, borderRadius: 12, border: '1px solid var(--dj-line)', background: 'transparent', color: 'var(--dj-text)', font: '700 14px Inter, sans-serif', cursor: 'pointer' }}>Zahodit</button>
          {onEditInChart && <button type="button" className="dj-btn" onClick={() => { playNativeHapticIfAvailable('selection'); onEditInChart(draft); }} style={{ height: 48, borderRadius: 12, border: '1px solid var(--dj-line)', background: 'transparent', color: 'var(--dj-text)', font: '700 13px Inter, sans-serif', cursor: 'pointer' }}>Upravit v grafu</button>}
          <button type="button" className="dj-btn" disabled={blocked} onClick={() => { playNativeHapticIfAvailable('medium'); onSubmit(submitDraft); }} style={{ height: 48, borderRadius: 12, border: 0, color: '#fff', background: sell ? SELL : BUY, opacity: blocked ? 0.4 : 1, font: '800 14px Inter, sans-serif', cursor: blocked ? 'not-allowed' : 'pointer' }}>
            {sell ? 'Prodat' : 'Koupit'} {m.quantity} {market ? 'market' : draft.type === 'limit' ? 'limit' : 'stop'}
          </button>
        </div>
      </section>
    </div>
  );
}
