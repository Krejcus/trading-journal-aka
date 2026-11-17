/**
 * Spojení appky s místní službou Rithmicu (ws na 127.0.0.1) — bez Reactu, aby šlo zkoušet s falešným socketem.
 *
 * Pravidla, která drží:
 *  - příkaz bez odpovědi (výpadek spojení, vypršení lhůty) má výsledek „unknown" a NIKDY se neopakuje;
 *  - po výpadku se nic ze staré relace netváří jako živé (`onSessionReset`), zprávy starého socketu se zahazují;
 *  - spojení se obnovuje samo, příkazy ne;
 *  - mlčení služby delší než `beatTimeoutMs` se hlásí (`onSilent`) — cena je pak stará.
 */
export interface RithmicLinkReply { ok: boolean; sent?: boolean | 'unknown'; error?: string; result?: unknown }

export interface RithmicLinkSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface RithmicLinkHandlers {
  beforeSend?(id: string, command: { op: string } & Record<string, unknown>): void;
  onCertain?(id: string): void;
  onLink(state: 'connecting' | 'open' | 'closed'): void;
  /** Zprávy služby kromě odpovědí na příkazy (hello, tick, beat, state). Jen z aktuálního socketu. */
  onMessage(message: Record<string, unknown>): void;
  /** Konec relace: výpadek i ukončení. Vše, co pochází ze staré relace, má příjemce zahodit. */
  onSessionReset(): void;
  onSilent(silent: boolean): void;
  /** Příkaz, jehož výsledek není znám (kromě `ack`). */
  onUncertain(item: { id: string; at: number; op: string; reason: string }): void;
}

export interface RithmicLinkOptions {
  url: string;
  handlers: RithmicLinkHandlers;
  socketFactory?: (url: string) => RithmicLinkSocket;
  now?: () => number;
  newId?: () => string;
  reconnectMs?: number;
  replyTimeoutMs?: number;
  beatTimeoutMs?: number;
}

const OPEN = 1;
// Longer than a command reply timeout. Resume from a full snapshot after a prolonged gap.
const RESYNC_GAP_MS = 30_000;

export class RithmicLocalConnection {
  private socket: RithmicLinkSocket | null = null;
  private stopped = true;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAt = 0;
  private silent = false;
  private counter = 0;
  private readonly replies = new Map<string, { op: string; resolve: (reply: RithmicLinkReply) => void }>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly reconnectMs: number;
  private readonly replyTimeoutMs: number;
  private readonly beatTimeoutMs: number;

  constructor(private readonly options: RithmicLinkOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => `${Date.now().toString(36)}-${(this.counter += 1)}-${Math.random().toString(36).slice(2, 8)}`);
    this.reconnectMs = options.reconnectMs ?? 2_000;
    this.replyTimeoutMs = options.replyTimeoutMs ?? 15_000;
    this.beatTimeoutMs = options.beatTimeoutMs ?? 4_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.beat = setInterval(() => {
      if (this.socket?.readyState !== OPEN) return;
      const age = this.now() - this.lastHeartbeatAt;
      if (age > RESYNC_GAP_MS) { this.socket.close(); return; }
      if (age <= this.beatTimeoutMs || this.silent) return;
      this.silent = true;
      this.options.handlers.onSilent(true);
    }, 1_000);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.beat !== null) clearInterval(this.beat);
    if (this.retry !== null) clearTimeout(this.retry);
    this.beat = null;
    this.retry = null;
    const closing = this.socket;
    this.socket = null;
    this.failPending();
    this.silent = false;
    this.options.handlers.onSessionReset();
    closing?.close();
  }

  isOpen(): boolean { return this.socket?.readyState === OPEN; }

  /** Odešle příkaz právě jednou. Bez spojení se neodešle; bez odpovědi je výsledek „unknown". */
  send(command: { op: string } & Record<string, unknown>): Promise<RithmicLinkReply> {
    return new Promise((resolve) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== OPEN) { resolve({ ok: false, sent: false, error: 'místní proces není připojený' }); return; }
      // Timers and React may still be suspended when a click arrives after sleep.
      if (command.op !== 'flatten' && command.op !== 'lookup' && this.now() - this.lastHeartbeatAt > this.beatTimeoutMs) {
        resolve({ ok: false, sent: false, error: 'Místní služba neodpovídá — počkej na obnovení stavu účtu.' });
        return;
      }
      const id = this.newId();
      if (command.op !== 'ack' && command.op !== 'lookup') {
        try { this.options.handlers.beforeSend?.(id, command); } catch (error) {
          if (command.op === 'entry' || command.op === 'replace-entry') {
            resolve({ ok: false, sent: false, error: error instanceof Error ? error.message : 'Nelze uložit ID příkazu pro obnovu po výpadku.' });
            return;
          }
        }
      }
      const timer = setTimeout(() => {
        if (!this.replies.delete(id)) return;
        if (command.op !== 'ack' && command.op !== 'lookup') this.options.handlers.onUncertain({ id, at: this.now(), op: command.op, reason: 'místní proces neodpověděl' });
        resolve({ ok: false, sent: 'unknown', error: 'místní proces neodpověděl — ověř stav' });
      }, this.replyTimeoutMs);
      this.replies.set(id, { op: command.op, resolve: (reply) => { clearTimeout(timer); resolve(reply); } });
      try { socket.send(JSON.stringify({ id, command })); } catch {
        // Odeslání vyhodilo: jestli něco odešlo, se neví → stejné zacházení jako výpadek.
        const pending = this.replies.get(id);
        this.replies.delete(id);
        if (command.op !== 'ack' && command.op !== 'lookup') this.options.handlers.onUncertain({ id, at: this.now(), op: command.op, reason: 'odeslání místnímu procesu selhalo' });
        pending?.resolve({ ok: false, sent: 'unknown', error: 'odeslání místnímu procesu selhalo — ověř stav' });
      }
    });
  }

  /** Příkazy bez odpovědi v okamžiku ztráty spojení: výsledek není znám, nic se neopakuje. */
  private failPending(): void {
    const pending = [...this.replies];
    this.replies.clear();
    for (const [id, item] of pending) {
      if (item.op !== 'ack' && item.op !== 'lookup') this.options.handlers.onUncertain({ id, at: this.now(), op: item.op, reason: 'spojení s místním procesem spadlo' });
      item.resolve({ ok: false, sent: 'unknown', error: 'spojení s místním procesem spadlo — ověř stav' });
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.retry = null;
    this.options.handlers.onLink('connecting');
    const factory = this.options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as RithmicLinkSocket);
    let mine: RithmicLinkSocket;
    try { mine = factory(this.options.url); } catch {
      this.options.handlers.onLink('closed');
      this.retry = setTimeout(() => this.connect(), this.reconnectMs);
      return;
    }
    this.socket = mine;
    mine.onopen = () => {
      if (this.socket !== mine) return;
      this.lastHeartbeatAt = this.now();
      this.options.handlers.onLink('open');
    };
    mine.onclose = () => {
      if (this.socket !== mine) return;
      this.socket = null;
      this.failPending();
      this.silent = false;
      // Po obnově je první stav výchozí, ne událost; starý stav se nesmí tvářit jako živý.
      this.options.handlers.onSessionReset();
      this.options.handlers.onLink('closed');
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), this.reconnectMs);
    };
    mine.onmessage = (event) => {
      if (this.socket !== mine) return;
      let message: Record<string, unknown>;
      try { message = JSON.parse(String(event.data)) as Record<string, unknown>; } catch { return; }
      if (!message || typeof message !== 'object') return;
      const receivedAt = this.now();
      if (receivedAt - this.lastHeartbeatAt > RESYNC_GAP_MS) { mine.close(); return; }
      if (message.type === 'beat' || message.type === 'tick') {
        if (typeof message.at !== 'number' || receivedAt - message.at > this.beatTimeoutMs) return;
        this.lastHeartbeatAt = Math.max(this.lastHeartbeatAt, Math.min(receivedAt, message.at));
        if (this.silent) { this.silent = false; this.options.handlers.onSilent(false); }
      }
      if (message.type === 'reply') {
        const id = String(message.id);
        const pending = this.replies.get(id);
        if (!pending) return; // odpověď na příkaz, který už vypršel nebo patřil jiné relaci
        this.replies.delete(id);
        const reply = message as unknown as RithmicLinkReply;
        // Nejistou odpověď služby zapisuje jedno místo — stejně jako timeout a výpadek.
        if (pending.op !== 'ack' && pending.op !== 'lookup' && !reply.ok && reply.sent !== false) this.options.handlers.onUncertain({ id, at: this.now(), op: pending.op, reason: reply.error ?? 'výsledek není znám' });
        if (pending.op !== 'ack' && pending.op !== 'lookup' && (reply.ok || reply.sent === false)) {
          const status = (reply.result as { status?: string } | null)?.status;
          if (pending.op !== 'flatten' || !reply.ok || status === 'already-flat' || status === 'submitted' || status === 'rejected') {
            try { this.options.handlers.onCertain?.(id); } catch {
              this.options.handlers.onUncertain({ id, at: this.now(), op: pending.op, reason: 'Výsledek se nepodařilo uložit pro obnovu.' });
            }
          } else {
            this.options.handlers.onUncertain({ id, at: this.now(), op: pending.op, reason: 'Zavření nemá jednoznačné potvrzení' });
          }
        }
        pending.resolve(reply);
        return;
      }
      this.options.handlers.onMessage(message);
    };
  }
}
