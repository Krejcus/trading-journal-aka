import type { BrokerEnvironment, BrokerOrderRequest } from './brokerPort';

/**
 * Poslední kontrola před odesláním na brokera.
 *
 * Čistá funkce, žádné IO. Copier spočítá plán, gate rozhodne, co z něj smí
 * ven. Nic se nesmí odeslat mimo tuhle cestu — a to včetně reconciliation
 * a flatten příkazů.
 *
 * Výchozí stav je vždy zavřeno: `createRiskGateContext()` vrací DISARMED
 * a bez spojení. Aplikace se po startu nikdy nesmí probudit připravená
 * odesílat.
 */

export type RiskBlockReason =
  | 'kill-switch'
  | 'disarmed'
  | 'arm-expired'
  | 'disconnected'
  | 'stale-heartbeat'
  | 'environment-mismatch'
  | 'position-divergence'
  | 'sequence-broken'
  | 'stuck-outbox'
  | 'quantity-limit'
  | 'symbol-not-allowed'
  | 'zero-quantity';

/**
 * Jak se zachovat při rozdílu pozic.
 *
 * `halt-group` je výchozí a jediný bezpečný default: rozdíl na jednom
 * followerovi znamená, že model reality je rozbitý, a posílat mezitím
 * příkazy ostatním by vědomě vyrobilo další rozdíl. Zúžení na jeden účet
 * je vědomá politika, ne implicitní chování.
 */
export type DivergencePolicy = 'halt-group' | 'isolate-account';

export interface RiskGateContext {
  /** Ruční ARM. Platí jen pro aktuální běh aplikace. */
  armed: boolean;
  /** Kdy uživatel armoval. Slouží k expiraci ARM po `armTtlMs`. */
  armedAt: number;
  armTtlMs: number;
  killSwitch: boolean;
  connected: boolean;
  lastHeartbeatAt: number;
  maxHeartbeatAgeMs: number;
  now: number;
  brokerEnvironment: BrokerEnvironment;
  /** Co uživatel v UI potvrdil, že očekává. Neshoda = tvrdý stop. */
  expectedEnvironment: BrokerEnvironment;
  /** Účty s nevyřešeným rozdílem pozic. */
  divergentAccounts: ReadonlySet<number>;
  divergencePolicy: DivergencePolicy;
  /**
   * Stream leadera je rozbitý — mezera nebo událost mimo pořadí. Nevíme,
   * co leader mezitím udělal, takže se nesmí replikovat.
   */
  sequenceBroken: boolean;
  /**
   * V outboxu visí objednávka s neznámým osudem. Dokud se nedohledá,
   * nesmí se posílat další — jinak se rozdíly začnou vrstvit.
   */
  stuckOutbox: boolean;
  /** Strop množství na jednu objednávku, per účet. */
  maxQuantityPerAccount: ReadonlyMap<number, number>;
  /** Prázdná množina = bez omezení symbolů. */
  allowedSymbols: ReadonlySet<string>;
  /**
   * Shadow mode spočítá všechno, ale nic neodešle. Tohle je režim, ve
   * kterém copier běží celou dobu před OAuth — a taky první dny vedle
   * TradeCopie.
   */
  shadowMode: boolean;
}

export interface BlockedRequest {
  request: BrokerOrderRequest;
  reason: RiskBlockReason;
}

export interface RiskGateDecision {
  /** Objednávky, které prošly. V shadow mode se stejně neodesílají. */
  allowed: BrokerOrderRequest[];
  blocked: BlockedRequest[];
  /** false = volající nesmí zavolat `placeOrder()`, ať `allowed` obsahuje cokoli. */
  dispatch: boolean;
  /** Vyplněné, když gate zavřel všechno naráz. */
  haltReason?: RiskBlockReason;
}

export function createRiskGateContext(
  overrides: Partial<RiskGateContext> = {},
): RiskGateContext {
  return {
    armed: false,
    armedAt: 0,
    armTtlMs: 8 * 60 * 60 * 1000,
    killSwitch: false,
    connected: false,
    lastHeartbeatAt: 0,
    maxHeartbeatAgeMs: 10_000,
    now: 0,
    brokerEnvironment: 'demo',
    expectedEnvironment: 'demo',
    divergentAccounts: new Set(),
    divergencePolicy: 'halt-group',
    sequenceBroken: false,
    stuckOutbox: false,
    maxQuantityPerAccount: new Map(),
    allowedSymbols: new Set(),
    shadowMode: true,
    ...overrides,
  };
}

/**
 * Globální důvod k zastavení, nebo `null` když je cesta volná.
 *
 * Pořadí je záměrné — kill switch a DISARMED musí přebít všechno ostatní,
 * aby se v logu objevil ten důvod, který uživatel skutečně nastavil.
 */
export function haltReason(context: RiskGateContext): RiskBlockReason | null {
  if (context.killSwitch) return 'kill-switch';
  if (!context.armed) return 'disarmed';
  if (context.armTtlMs > 0 && context.now - context.armedAt > context.armTtlMs) return 'arm-expired';
  if (!context.connected) return 'disconnected';
  if (context.now - context.lastHeartbeatAt > context.maxHeartbeatAgeMs) return 'stale-heartbeat';
  if (context.brokerEnvironment !== context.expectedEnvironment) return 'environment-mismatch';
  if (context.sequenceBroken) return 'sequence-broken';
  if (context.stuckOutbox) return 'stuck-outbox';
  if (context.divergencePolicy === 'halt-group' && context.divergentAccounts.size > 0) {
    return 'position-divergence';
  }
  return null;
}

/**
 * Gate pro risk-redukující cancel už známé follower objednávky.
 *
 * DISARM/Kill switch/TTL zastavují NOVOU expozici. Nesmějí ale osiřet už
 * zkopírovanou pracovní objednávku poté, co ji leader zrušil. Cancel proto
 * vyžaduje pouze živé, čerstvé spojení do správného prostředí. Konkrétní
 * brokerOrderId musí přijít z durable `links`; nic se nehledá odhadem.
 */
export function cancelLifecycleHaltReason(
  context: RiskGateContext,
): RiskBlockReason | null {
  if (!context.connected) return 'disconnected';
  if (context.now - context.lastHeartbeatAt > context.maxHeartbeatAgeMs) return 'stale-heartbeat';
  if (context.brokerEnvironment !== context.expectedEnvironment) return 'environment-mismatch';
  return null;
}

function requestBlockReason(
  request: BrokerOrderRequest,
  context: RiskGateContext,
): RiskBlockReason | null {
  if (request.quantity <= 0) return 'zero-quantity';
  if (context.divergentAccounts.has(request.accountId)) return 'position-divergence';
  if (context.allowedSymbols.size > 0 && !context.allowedSymbols.has(request.symbol)) {
    return 'symbol-not-allowed';
  }
  const limit = context.maxQuantityPerAccount.get(request.accountId);
  if (limit != null && request.quantity > limit) return 'quantity-limit';
  return null;
}

export function evaluateRiskGate(
  requests: readonly BrokerOrderRequest[],
  context: RiskGateContext,
): RiskGateDecision {
  const halt = haltReason(context);
  if (halt) {
    return {
      allowed: [],
      blocked: requests.map(request => ({ request, reason: halt })),
      dispatch: false,
      haltReason: halt,
    };
  }

  const allowed: BrokerOrderRequest[] = [];
  const blocked: BlockedRequest[] = [];
  for (const request of requests) {
    const reason = requestBlockReason(request, context);
    if (reason) blocked.push({ request, reason });
    else allowed.push(request);
  }

  return { allowed, blocked, dispatch: !context.shadowMode && allowed.length > 0 };
}
