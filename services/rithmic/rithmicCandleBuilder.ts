/**
 * Skládá 1m svíčky a poslední cenu z ticků Rithmicu. Jen zobrazení (graf,
 * lístek) — nic z toho nesmí vstoupit do risk bran, day locku ani rozhodování
 * kopírky (stejné pravidlo jako INV-UI-04 pro ostatní zdroje ceny).
 *
 * Čistá logika bez časovačů: čas minuty se bere z burzy, jinak z brány
 * Rithmicu, jinak z příjmu. Snímek po přihlášení odběru (poslední obchod
 * před naším připojením) nastaví jen poslední cenu, do svíčky se nepočítá.
 */
import type { RithmicTick } from './rithmicClient';

export interface RithmicCandle {
  /** Začátek minuty v sekundách od epochy. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SymbolState {
  forming: RithmicCandle | null;
  finished: RithmicCandle[];
  lastPrice: number | null;
  lastPriceAt: number;
  bid: number | null;
  ask: number | null;
  bidAt: number;
  askAt: number;
  quoteNotifiedAt: number;
}

export interface RithmicCandleBuilderOptions {
  /** Kolik dokončených svíček na symbol držet v paměti. */
  keepFinished?: number;
}

const tickTimeMs = (tick: RithmicTick): number => tick.exchangeAt ?? tick.gatewayAt ?? tick.receivedAt;
const validPrice = (value: number | null): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

export class RithmicCandleBuilder {
  private readonly keepFinished: number;
  private readonly symbols = new Map<string, SymbolState>();

  constructor(options: RithmicCandleBuilderOptions = {}) {
    this.keepFinished = Math.max(1, options.keepFinished ?? 600);
  }

  private state(symbol: string): SymbolState {
    let state = this.symbols.get(symbol);
    if (!state) {
      state = { forming: null, finished: [], lastPrice: null, lastPriceAt: 0, bid: null, ask: null, bidAt: 0, askAt: 0, quoteNotifiedAt: 0 };
      this.symbols.set(symbol, state);
    }
    return state;
  }

  /** Vrací true, když tick změnil svíčku nebo cenu (má smysl překreslit). */
  onTick(tick: RithmicTick): boolean {
    if (!tick.symbol) return false;
    const state = this.state(tick.symbol);
    if (tick.isSnapshot && tick.exchangeAt === null && tick.gatewayAt === null) return false;
    if (tick.kind === 'bbo') {
      const at = Math.min(tickTimeMs(tick), tick.receivedAt);
      let changed = false;
      if (validPrice(tick.bidPrice) && at >= state.bidAt) {
        changed = tick.bidPrice !== state.bid;
        state.bid = tick.bidPrice;
        state.bidAt = at;
      }
      if (validPrice(tick.askPrice) && at >= state.askAt) {
        changed ||= tick.askPrice !== state.ask;
        state.ask = tick.askPrice;
        state.askAt = at;
      }
      const refreshed = (state.bidAt === at || state.askAt === at) && at - state.quoteNotifiedAt >= 1_000;
      if (changed || refreshed) state.quoteNotifiedAt = at;
      return changed || refreshed;
    }
    if (!validPrice(tick.tradePrice)) return false;
    const price = tick.tradePrice;
    const at = Math.min(tickTimeMs(tick), tick.receivedAt);
    if (tick.isSnapshot) {
      if (at >= state.lastPriceAt) {
        state.lastPrice = price;
        state.lastPriceAt = at;
        return true;
      }
      return false;
    }
    const minute = Math.floor(tickTimeMs(tick) / 60_000) * 60;
    const size = typeof tick.tradeSize === 'number' && Number.isFinite(tick.tradeSize) && tick.tradeSize > 0 ? tick.tradeSize : 0;
    const forming = state.forming;
    if (forming && minute < forming.time) {
      // Opožděný obchod ze starší minuty: svíčku zpětně nepřepisujeme.
      return false;
    }
    if (!forming || minute > forming.time) {
      if (forming) {
        state.finished.push(forming);
        if (state.finished.length > this.keepFinished) state.finished.splice(0, state.finished.length - this.keepFinished);
      }
      state.forming = { time: minute, open: price, high: price, low: price, close: price, volume: size };
    } else {
      forming.high = Math.max(forming.high, price);
      forming.low = Math.min(forming.low, price);
      forming.close = price;
      forming.volume += size;
    }
    if (at >= state.lastPriceAt) {
      state.lastPrice = price;
      state.lastPriceAt = at;
    }
    return true;
  }

  /** Rozpracovaná svíčka aktuální minuty; null, když poslední obchod patří do jiné minuty. */
  current(symbol: string, nowMs: number): RithmicCandle | null {
    const forming = this.symbols.get(symbol)?.forming;
    if (!forming) return null;
    return forming.time === Math.floor(nowMs / 60_000) * 60 ? { ...forming } : null;
  }

  /** Poslední obchodní cena, pokud není starší než `maxAgeMs`; jinak null (nikdy stará cena jako čerstvá). */
  lastPrice(symbol: string, nowMs: number, maxAgeMs: number): number | null {
    const state = this.symbols.get(symbol);
    if (!state || state.lastPrice === null) return null;
    return nowMs - state.lastPriceAt <= maxAgeMs ? state.lastPrice : null;
  }

  /** Nejlepší nabídka a poptávka, pokud nejsou starší než `maxAgeMs`. */
  quote(symbol: string, nowMs: number, maxAgeMs: number): { bid: number | null; ask: number | null } | null {
    const state = this.symbols.get(symbol);
    if (!state) return null;
    const bid = nowMs - state.bidAt <= maxAgeMs ? state.bid : null;
    const ask = nowMs - state.askAt <= maxAgeMs ? state.ask : null;
    if ((bid === null && ask === null) || (bid !== null && ask !== null && bid > ask)) return null;
    return { bid, ask };
  }

  /** Dokončené svíčky od připojení (starší historii dodává jiný zdroj). */
  finished(symbol: string): RithmicCandle[] {
    return (this.symbols.get(symbol)?.finished ?? []).map((c) => ({ ...c }));
  }

  /** Po výpadku spojení: rozpracovaná svíčka má díru, zahodit ji i poslední cenu. */
  reset(symbol?: string): void {
    if (symbol === undefined) this.symbols.clear();
    else this.symbols.delete(symbol);
  }
}
