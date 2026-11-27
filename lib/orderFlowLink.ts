/**
 * Spojka mezi spojením na místní službu Rithmicu a kreslicími vrstvami order flow.
 *
 * Indikátory (Bubliny, Volume profil) tu ohlásí, že data chtějí, a spojka přihlásí odběr u služby
 * stávajícím spojením appky — žádné další spojení nevzniká (INV-UI-04). Když data nikdo nechce,
 * odběr se odhlásí a služba neposílá nic navíc (důležité hlavně pro telefon na mobilních datech).
 *
 * JEN ZOBRAZENÍ: spojka neposílá příkazy a nic z ní nesmí do cen pro příkazy.
 */
import { OrderFlowStore, parseOrderFlowCapability, type OrderFlowCapability } from './orderFlowStore';

export interface OrderFlowDemand {
  /** Požadovaný zdroj (např. NQ); když ho služba nemá, vezme se první dostupný. */
  source: string;
  /** Kolik dní zpět (telefon 1, PC víc). */
  days: number;
}

export type OrderFlowSender = (request: { subscribe: boolean; source?: string; days?: number }) => boolean;

export class OrderFlowLink {
  readonly store = new OrderFlowStore();
  capability: OrderFlowCapability | null = null;
  /** Poslední chyba od služby (např. „order flow není zapnutý“), jen pro zobrazení. */
  error: string | null = null;

  private sender: OrderFlowSender | null = null;
  private readonly demands = new Map<symbol, OrderFlowDemand>();
  private active: { source: string; days: number } | null = null;
  private readonly listeners = new Set<() => void>();
  private resyncAt = 0;

  constructor(private readonly now: () => number = Date.now) {
    this.store.subscribe(() => {
      // Mezera ve zprávách: jednou za 2 s zkusit nový snímek (ne smyčka žádostí).
      if (this.store.needsResync && this.now() - this.resyncAt > 2_000) { this.resyncAt = this.now(); this.sync(true); }
    });
  }

  /** Změna dostupnosti nebo chyby (ne dat — ta hlásí `store.subscribe`). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Spojení appky se službou; vrací odpojení. Poslední připojené vyhrává. */
  attach(sender: OrderFlowSender): () => void {
    this.sender = sender;
    return () => {
      if (this.sender !== sender) return;
      this.sender = null;
      this.sessionReset();
    };
  }

  /** Služba se ohlásila (`hello`): co umí. Nové `hello` = nová relace odběru. */
  hello(raw: unknown): void {
    this.capability = parseOrderFlowCapability(raw);
    this.error = null;
    this.active = null;
    this.notify();
    this.sync(false);
  }

  /** Konec relace: data pryč, odběr se přihlásí znovu až po dalším `hello`. */
  sessionReset(): void {
    this.capability = null;
    this.active = null;
    this.error = null;
    this.store.reset();
    this.notify();
  }

  /** Zpráva ze služby; vrací true, pokud patřila order flow. */
  message(message: Record<string, unknown>): boolean {
    if (message.type === 'of-error') {
      this.error = typeof message.message === 'string' ? message.message : 'order flow není dostupný';
      this.active = null;
      this.notify();
      return true;
    }
    return this.store.apply(message);
  }

  /** Indikátor chce data. Vrací zrušení zájmu. */
  demand(demand: OrderFlowDemand): () => void {
    const key = Symbol('order-flow-demand');
    this.demands.set(key, demand);
    this.sync(false);
    return () => {
      if (!this.demands.delete(key)) return;
      this.sync(false);
    };
  }

  /** Zdroj, který se pro požadavek skutečně použije (služba požadovaný mít nemusí). */
  resolveSource(wanted: string): string | null {
    const sources = this.capability?.sources;
    if (!sources) return null;
    if (Object.prototype.hasOwnProperty.call(sources, wanted)) return wanted;
    return Object.keys(sources)[0] ?? null;
  }

  private wanted(): { source: string; days: number } | null {
    if (this.demands.size === 0) return null;
    const all = [...this.demands.values()];
    const source = this.resolveSource(all[0].source);
    if (!source) return null;
    const keep = this.capability?.keepDays ?? 1;
    return { source, days: Math.max(1, Math.min(keep, Math.max(...all.map((item) => Math.floor(item.days) || 1)))) };
  }

  private sync(force: boolean): void {
    if (!this.sender || !this.capability) return;
    const wanted = this.wanted();
    if (!wanted) {
      if (this.active) { this.sender({ subscribe: false }); this.active = null; this.store.reset(); }
      return;
    }
    // Stejný zdroj a dost dní už běží: nechat být (kratší požadavek nový snímek nepotřebuje).
    if (!force && this.active && this.active.source === wanted.source && this.active.days >= wanted.days) return;
    if (this.active && this.active.source !== wanted.source) this.store.reset();
    const days = force && this.active && this.active.source === wanted.source ? Math.max(this.active.days, wanted.days) : wanted.days;
    if (this.sender({ subscribe: true, source: wanted.source, days })) this.active = { source: wanted.source, days };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* posluchač nesmí shodit spojku */ } }
  }
}

/** Jedna spojka na appku: jedno spojení se službou, jeden odběr. */
export const orderFlowLink = new OrderFlowLink();
