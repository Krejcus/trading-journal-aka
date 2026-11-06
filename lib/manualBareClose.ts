/**
 * C8 — × zavřít holý Market bez SL/TP (3. 11. 2026,
 * docs/reviews/trading-gaps-designs/safety.md, oponentura copier-design-critic).
 *
 * ČISTÁ logika bez IO: výběr holého obchodu pro UI, brány zavření nad durable
 * záznamem, tvar z čerstvého REST čtení a synchronní kontrola cache těsně před
 * `liquidatePosition`. Controller sebere zmrazený stav, tady se jen rozhoduje.
 *
 * Payload se nemění: `manage-leader-order` `close-position` s `entryOperationId`
 * holého záznamu a `expect = { price: referencePrice, quantity }`. „Co jsem
 * viděl“ je u holé pozice jen počet kontraktů (`referencePrice` je konstanta
 * záznamu, zastaralé zobrazení nezachytí — oponentura P3); vlastnictví pozice
 * dokládají výhradně kontroly ve workeru (nejnovější záznam, `closedAt == null`,
 * vstup v aktuální session vyplněný přesně na qty, |net| = qty na správné straně,
 * otevřený lot deníku dne s fillem vstupu = očekávaná pozice, na symbolu nic nepracuje).
 *
 * Jen sólo skupina (manual-only local-only DEMO bez followerů) a zatím jen za
 * ARMED ∧ ¬shadow ∧ ¬kill — za DISARMED až s C9 (INV-MANUAL-01).
 */

export type BareCloseSide = 'Buy' | 'Sell';

export interface BareCloseIssue { code: string; text: string }

/**
 * Sólo skupina (návrh §0.2): manual-only ∧ local-only ∧ bez followerů ∧ DEMO.
 * Stejná podmínka jako `scaleInEnabled` (services/manualScaleIn.ts), jen bez opt-inu.
 * `group: null` = smazaná (retired) skupina → nikdy.
 */
export function soloManualGroup(input: {
  group: { manualOnly?: boolean; localOnly?: boolean; followers: readonly unknown[] } | null;
  brokerEnvironment: string | null | undefined;
}): boolean {
  return input.group?.manualOnly === true && input.group.localOnly === true
    && input.group.followers.length === 0 && input.brokerEnvironment === 'demo';
}

/** Podmnožina durable `CopierManualEntryRecord`, kterou C8 čte. */
export interface BareCloseEntryRecord {
  operationId: string;
  status: string;
  createdAt: number;
  bare?: true;
  closedAt?: number;
  entryBrokerOrderId?: string;
  stopBrokerOrderId?: string;
  targetBrokerOrderId?: string;
  request: {
    accountId: number;
    symbol: string;
    side: BareCloseSide;
    quantity: number;
    orderType?: string;
    referencePrice?: number;
  };
}

/** Holý záznam bez nohou (bez ohledu na stav) — rozhoduje, zda `close-position` jde cestou C8. */
export function isBareEntryWithoutLegs(record: BareCloseEntryRecord | null | undefined): boolean {
  return record?.bare === true && !record.stopBrokerOrderId && !record.targetBrokerOrderId;
}

/** Holý záznam s nejvýš jednou nohou (SL a TP po jedné): zavírá se a spravuje vlastní cestou, ne jako obchod se dvěma nohami. */
export function isBareEntryAtMostOneLeg(record: BareCloseEntryRecord | null | undefined): boolean {
  return record?.bare === true && !(record.stopBrokerOrderId && record.targetBrokerOrderId);
}

/** Nejnovější ruční vstup (podle `createdAt`) — jen ten smí „vlastnit“ holou pozici. */
export function newestManualEntry<T extends { createdAt: number }>(records: readonly T[]): T | null {
  return records.reduce<T | null>((latest, record) => (!latest || record.createdAt > latest.createdAt ? record : latest), null);
}

/** Co status workeru nabídne UI (jen zobrazení, INV-UI-01/03 — worker vše ověří znovu). */
export interface BareLeaderTrade {
  entryOperationId: string;
  symbol: string;
  side: BareCloseSide;
  quantity: number;
  /** Cena, kterou uživatel viděl při holém Marketu — `expect.price` příkazu zavření. */
  referencePrice: number;
  /** Která noha už je u brokera (SL a TP po jedné). Jen zobrazení. */
  hasStop?: boolean;
  hasTarget?: boolean;
}

/**
 * Výběr holého obchodu pro UI — stejný jako `bare` v desku (TradovateLiveDesk):
 * nejnovější záznam, `acknowledged`, holý, bez nohou, otevřený (`closedAt == null`),
 * s id vstupu a cenou, kterou uživatel viděl. Mimo sólo skupinu `null`.
 */
export function selectBareLeaderTrade(
  records: readonly BareCloseEntryRecord[],
  context: { solo: boolean; leaderAccountId: number | null },
): BareLeaderTrade | null {
  if (!context.solo || context.leaderAccountId == null) return null;
  const newest = newestManualEntry(records);
  if (!newest || newest.status !== 'acknowledged' || !isBareEntryAtMostOneLeg(newest) || newest.closedAt != null
    || !newest.entryBrokerOrderId || newest.request.accountId !== context.leaderAccountId) return null;
  const reference = newest.request.referencePrice;
  if (typeof reference !== 'number' || !Number.isFinite(reference) || reference <= 0) return null;
  return {
    entryOperationId: newest.operationId, symbol: newest.request.symbol, side: newest.request.side,
    quantity: newest.request.quantity, referencePrice: reference,
    ...(newest.stopBrokerOrderId ? { hasStop: true } : {}), ...(newest.targetBrokerOrderId ? { hasTarget: true } : {}),
  };
}

/**
 * Obchod pro SL a TP po jedné: nejnovější otevřený holý záznam s 0 až 2 nohami. Na rozdíl od
 * `selectBareLeaderTrade` ho UI dostane i se dvěma nohami, aby šla jedna z nich zrušit. Jen zobrazení.
 */
export function selectBareLegTrade(
  records: readonly BareCloseEntryRecord[],
  context: { solo: boolean; leaderAccountId: number | null },
): BareLeaderTrade | null {
  if (!context.solo || context.leaderAccountId == null) return null;
  const newest = newestManualEntry(records);
  const reference = newest?.request.referencePrice;
  if (!newest || newest.status !== 'acknowledged' || newest.bare !== true || newest.closedAt != null || !newest.entryBrokerOrderId
    || newest.request.accountId !== context.leaderAccountId || typeof reference !== 'number' || !Number.isFinite(reference) || reference <= 0) return null;
  return {
    entryOperationId: newest.operationId, symbol: newest.request.symbol, side: newest.request.side, quantity: newest.request.quantity, referencePrice: reference,
    ...(newest.stopBrokerOrderId ? { hasStop: true } : {}), ...(newest.targetBrokerOrderId ? { hasTarget: true } : {}),
  };
}

/**
 * Pole příkazu zavření holé pozice pro UI (`buildLeaderOrderManageCommand` doplní
 * `groupId`, `operationId`, `leaderAccountId`). Nic neodesílá.
 */
export function bareCloseManageFields(trade: BareLeaderTrade): {
  entryOperationId: string; symbol: string; action: 'close-position'; expect: { price: number; quantity: number };
} {
  return {
    entryOperationId: trade.entryOperationId, symbol: trade.symbol, action: 'close-position',
    expect: { price: trade.referencePrice, quantity: trade.quantity },
  };
}

/**
 * Brány nad durable záznamem a stavem kopírky — ve frontě controlleru, PŘED
 * REST čtením. Pořadí = priorita prvního textu. Prázdné pole = pokračovat.
 */
export function bareCloseRecordBlockers(input: {
  record: BareCloseEntryRecord | null | undefined;
  newestOperationId: string | null;
  solo: boolean;
  leaderAccountId: number | null;
  groupId: string;
  runtime: { armed: boolean; shadowMode: boolean; killSwitch: boolean };
  command: { groupId: string; leaderAccountId: number; symbol: string; expect: { price: number; quantity: number } };
}): BareCloseIssue[] {
  const { record, command } = input;
  if (!record || record.status !== 'acknowledged' || !isBareEntryAtMostOneLeg(record) || !record.entryBrokerOrderId
    || input.leaderAccountId == null || record.request.accountId !== input.leaderAccountId) {
    return [{ code: 'not-bare-entry', text: 'Zavřít jde jen vlastní přijatý Market bez SL/TP.' }];
  }
  if (!input.solo) {
    return [{ code: 'not-solo', text: 'Holou pozici jde z appky zavřít jen na ručním DEMO účtu bez followerů — zavři ji Flattenem.' }];
  }
  if (command.groupId !== input.groupId || command.leaderAccountId !== input.leaderAccountId || command.symbol !== record.request.symbol) {
    return [{ code: 'not-leader', text: 'Obchod nepatří leaderovi této skupiny.' }];
  }
  // Starý holý záznam nesmí „adoptovat“ cizí pozici (jako attach, oponentura P1-3).
  if (input.newestOperationId !== record.operationId || record.closedAt != null) {
    return [{ code: 'entry-closed', text: 'Tenhle Market už byl uzavřený nebo ho nahradil novější vstup — pozici zavři Flattenem.' }];
  }
  // C8 před C9: jen jako dnešní × zavřít (fáze 2d) — za DISARMED / shadow / kill zůstává Flatten.
  if (!input.runtime.armed || input.runtime.shadowMode || input.runtime.killSwitch) {
    return [{ code: 'not-armed', text: 'Zavření jde jen za zapnuté kopírky (ne shadow, ne kill) — holou pozici zavři Flattenem na Live Dashboardu.' }];
  }
  // „Co jsem viděl“ = počet kontraktů; referencePrice je konstanta záznamu (P3), jen konzistence payloadu.
  if (command.expect.quantity !== record.request.quantity || record.request.referencePrice == null
    || command.expect.price !== record.request.referencePrice) {
    return [{ code: 'order-changed', text: 'Pozice se od zobrazení změnila — obnov panel.' }];
  }
  return [];
}

/**
 * Tvar holé pozice z čerstvého REST čtení leadera (ve frontě): vstup vyplněný
 * přesně na qty, |net| = qty na správné straně a na symbolu NIC nepracuje
 * (liquidate by pracující příkaz zrušil — cizí příkaz se bez souhlasu neruší).
 */
export function bareCloseShapeBlockers(input: {
  side: BareCloseSide;
  quantity: number;
  entryOrder: { status: string; filledQuantity: number } | null | undefined;
  net: number;
  openOrdersOnSymbol: number;
}): BareCloseIssue[] {
  const long = input.side === 'Buy';
  if (!input.entryOrder || input.entryOrder.status !== 'filled' || input.entryOrder.filledQuantity !== input.quantity
    || Math.abs(input.net) !== input.quantity || (long ? input.net <= 0 : input.net >= 0)) {
    return [{ code: 'shape', text: 'Pozice nesedí s Marketem (jiný počet, částečné vyplnění, jiná strana nebo je zavřená) — zavři ji Flattenem.' }];
  }
  if (input.openOrdersOnSymbol > 0) {
    return [{ code: 'other-orders', text: 'Na symbolu pracuje jiný příkaz (zavření by ho zrušilo) — zavři pozici Flattenem nebo v Tradovate.' }];
  }
  return [];
}

/** Očekávaná pozice leadera se znaménkem (long +, short −). */
export const bareCloseSignedNet = (side: BareCloseSide, quantity: number): number => (side === 'Buy' ? quantity : -quantity);

/**
 * Pozice je pořád ta z tohoto Marketu (oponentura C8, P3 „obrat přes nulu“): otevřený lot deníku dne
 * obsahuje fill vstupu a jeho pozice = očekávaná se znaménkem. Obrat jedním fillem (+2 → −2 → +2 bez
 * eventu net 0) uzavře lot vstupu a založí nový bez jeho id → blokováno. Lot chybí (jiná session,
 * obchod před startem počítadla, neúplná data) = taky blokováno — zavřít jde Flattenem (fail-closed).
 */
export function bareCloseLotBlockers(input: {
  lots: readonly { symbol: string; netQuantity: number; entryOrderIds?: readonly string[] }[];
  symbol: string;
  entryBrokerOrderId: string;
  expectedNet: number;
}): BareCloseIssue[] {
  const lot = input.lots.find(item => item.symbol === input.symbol && (item.entryOrderIds ?? []).includes(input.entryBrokerOrderId));
  if (!lot || lot.netQuantity !== input.expectedNet) {
    return [{ code: 'entry-not-open', text: 'Pozice už není ta z tohoto Marketu (mezitím se otočila nebo ji deník dne nezná) — zavři ji Flattenem.' }];
  }
  return [];
}

/**
 * Dořešení `unknown` zavření holé pozice (oponentura C8, P3 „falešný incident“): záznam už současnou
 * pozici nevlastní, když ho stream uzavřel (`closedAt`, leader byl flat) nebo ho nahradil novější
 * ruční vstup, který došel k brokerovi a není přikoupení (ten prošel branou z flat `account-not-flat`).
 * Pak současná pozice patří jinému vstupu — žádný incident „holá pozice trvá“, nic se neposílá.
 */
export function bareCloseSuperseded(
  entry: { operationId: string; createdAt: number; closedAt?: number | null },
  records: readonly { operationId: string; createdAt: number; scaleIn?: boolean; entryBrokerOrderId?: string }[],
): boolean {
  return entry.closedAt != null || records.some(other => other.operationId !== entry.operationId && other.createdAt > entry.createdAt
    && other.scaleIn !== true && !!other.entryBrokerOrderId);
}

/**
 * Synchronní kontrola z cache streamu těsně před `liquidatePosition` (místo
 * `legsLive` u obchodu s nohami): na symbolu leadera nic nepracuje a stream
 * ukazuje přesně očekávanou pozici. `null` = smí se zapsat.
 */
export function bareClosePreWriteBlocker(input: {
  expectedNet: number;
  streamNet: number | null;
  openOrdersOnSymbol: number;
}): string | null {
  if (input.openOrdersOnSymbol > 0) return 'Na symbolu mezitím začal pracovat příkaz — nic se neodeslalo (zavři Flattenem).';
  if (input.streamNet == null || input.streamNet !== input.expectedNet) return 'Pozice leadera se mezitím změnila — nic se neodeslalo.';
  return null;
}
