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

/** Jedno spojení appky se službou. Co přijde z jiného než právě připojeného spojení, se ignoruje. */
export interface OrderFlowSession {
  /** Služba se ohlásila (`hello`) nebo oznámila nový zdroj (`of-ready`): co umí. */
  hello(raw: unknown): void;
  /** Konec relace: data pryč, odběr se přihlásí znovu až po dalším `hello`. */
  sessionReset(): void;
  /** Zpráva ze služby; vrací true, pokud patřila order flow. */
  message(message: Record<string, unknown>): boolean;
  detach(): void;
}

export interface OrderFlowLinkOptions {
  now?: () => number;
  /**
   * O kolik se odloží odhlášení po posledním zájemci. Přestavba grafu (změna rozložení, timeframu,
   * náhled v dialogu) zájem na okamžik zruší a hned zase ohlásí — bez odkladu by to byl pokaždé
   * nový snímek a služba by žádosti brzy odmítla.
   */
  releaseDelayMs?: number;
  /** Za jak dlouho zkusit odběr znovu, když ho služba odmítla. */
  retryMs?: number;
}

const RESYNC_GAP_MS = 2_000;

export class OrderFlowLink {
  readonly store = new OrderFlowStore();
  capability: OrderFlowCapability | null = null;
  /** Poslední chyba od služby (např. „order flow není zapnutý“), jen pro zobrazení. */
  error: string | null = null;

  private sender: OrderFlowSender | null = null;
  private readonly demands = new Map<symbol, OrderFlowDemand>();
  private active: { source: string; days: number } | null = null;
  private readonly listeners = new Set<() => void>();
  private resyncAt = -Infinity;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly releaseDelayMs: number;
  private readonly retryMs: number;

  constructor(options: OrderFlowLinkOptions = {}) {
    this.now = options.now ?? Date.now;
    this.releaseDelayMs = options.releaseDelayMs ?? 1_500;
    this.retryMs = options.retryMs ?? 5_000;
    this.store.subscribe(() => {
      // Mezera ve zprávách: nový snímek, ale nejvýš jednou za 2 s (každá další neshoda to zkusí znovu).
      if (this.store.needsResync && this.now() - this.resyncAt > RESYNC_GAP_MS) { this.resyncAt = this.now(); this.sync(true); }
    });
  }

  /** Změna dostupnosti nebo chyby (ne dat — ta hlásí `store.subscribe`). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Připojí spojení appky se službou. Poslední připojené vyhrává; starší už nic nezmění. */
  attach(sender: OrderFlowSender): OrderFlowSession {
    this.sender = sender;
    this.capability = null;
    this.active = null;
    const mine = (): boolean => this.sender === sender;
    return {
      hello: (raw) => { if (mine()) this.onHello(raw); },
      sessionReset: () => { if (mine()) this.onSessionReset(); },
      message: (message) => (mine() ? this.onMessage(message) : typeof message.type === 'string' && message.type.startsWith('of')),
      detach: () => {
        if (!mine()) return;
        this.sender = null;
        this.onSessionReset();
      },
    };
  }

  /** Indikátor chce data. Vrací zrušení zájmu (odběr se odhlásí s krátkým odkladem). */
  demand(demand: OrderFlowDemand): () => void {
    const key = Symbol('order-flow-demand');
    this.demands.set(key, demand);
    this.sync(false);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const drop = () => { if (this.demands.delete(key)) this.sync(false); };
      if (this.releaseDelayMs > 0) setTimeout(drop, this.releaseDelayMs); else drop();
    };
  }

  /** Zdroj, který se pro požadavek skutečně použije (služba požadovaný mít nemusí). */
  resolveSource(wanted: string): string | null {
    const sources = this.capability?.sources;
    if (!sources) return null;
    if (Object.prototype.hasOwnProperty.call(sources, wanted)) return wanted;
    return Object.keys(sources)[0] ?? null;
  }

  private onHello(raw: unknown): void {
    this.capability = parseOrderFlowCapability(raw);
    this.error = null;
    this.active = null;
    this.notify();
    this.sync(false);
  }

  private onSessionReset(): void {
    this.capability = null;
    this.active = null;
    this.error = null;
    this.clearRetry();
    this.store.expectSource(null);
    this.store.reset();
    this.notify();
  }

  private onMessage(message: Record<string, unknown>): boolean {
    if (message.type === 'of-error') {
      this.error = typeof message.message === 'string' ? message.message : 'order flow není dostupný';
      this.active = null;
      // Co je v grafu, už služba neudržuje — nesmí se to tvářit jako živé.
      this.store.expectSource(null);
      this.store.reset();
      this.notify();
      // Odmítnutí bývá dočasné (strop žádostí): zkusit znovu s odstupem, dokud data někdo chce.
      this.clearRetry();
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.sync(false); }, this.retryMs);
      return true;
    }
    return this.store.apply(message);
  }

  private wanted(): { source: string; days: number } | null {
    if (this.demands.size === 0) return null;
    const all = [...this.demands.values()];
    // Zdroj podle nejnovějšího zájemce: po změně nastavení starý zájem ještě chvíli dobíhá.
    const source = this.resolveSource(all[all.length - 1].source);
    if (!source) return null;
    const keep = this.capability?.keepDays ?? 1;
    return { source, days: Math.max(1, Math.min(keep, Math.max(...all.map((item) => Math.floor(item.days) || 1)))) };
  }

  private sync(force: boolean): void {
    if (!this.sender || !this.capability) return;
    const wanted = this.wanted();
    if (!wanted) {
      this.clearRetry();
      if (this.active) { this.sender({ subscribe: false }); this.active = null; this.store.expectSource(null); this.store.reset(); }
      return;
    }
    // Stejný zdroj a dost dní už běží: nechat být (kratší požadavek nový snímek nepotřebuje).
    if (!force && this.active && this.active.source === wanted.source && this.active.days >= wanted.days) return;
    if (this.active && this.active.source !== wanted.source) this.store.reset();
    const days = force && this.active && this.active.source === wanted.source ? Math.max(this.active.days, wanted.days) : wanted.days;
    this.store.expectSource(wanted.source);
    if (this.sender({ subscribe: true, source: wanted.source, days })) this.active = { source: wanted.source, days };
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* posluchač nesmí shodit spojku */ } }
  }
}

/** Jedna spojka na appku: jedno spojení se službou, jeden odběr. */
export const orderFlowLink = new OrderFlowLink();
