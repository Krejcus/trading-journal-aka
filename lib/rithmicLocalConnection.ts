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
  /** Služba zařízení odmítla (není spárované, bylo odvoláno). Spojení se pak samo NEobnovuje. */
  onAuthFailed?(reason: string): void;
}

export interface RithmicLinkOptions {
  url: string;
  /**
   * Spárované zařízení (telefon): klíč zařízení se pošle jako PRVNÍ zpráva po otevření spojení — ne v adrese.
   * Dokud služba neodpoví, že zařízení zná, spojení se nehlásí jako otevřené a nic se neposílá.
   */
  auth?: () => Promise<string | null> | string | null;
  handlers: RithmicLinkHandlers;
  socketFactory?: (url: string) => RithmicLinkSocket;
  now?: () => number;
  newId?: () => string;
  reconnectMs?: number;
  replyTimeoutMs?: number;
  beatTimeoutMs?: number;
  /**
   * Měření otevření appky se službě posílá jen z obchodního spojení. Pasivní čtenář (graf deníku) ho vypíná
   * (`false`), aby službě neposlal vůbec nic a nekazil výpis měření.
   */
  measure?: boolean;
}

const OPEN = 1;
// Longer than a command reply timeout. Resume from a full snapshot after a prolonged gap.
const RESYNC_GAP_MS = 30_000;

/**
 * Zprávy službě, které NEJSOU obchodní příkaz: potvrzení incidentu, dohledání a upozornění na cenu (klíč a seznam).
 * Neukládají se do deníku příkazů a jejich selhání nikdy není „nejistý příkaz“ — k brokerovi z nich nic nejde.
 */
const UNTRACKED_OPS = new Set(['ack', 'lookup', 'alerts-key', 'alerts-set']);
const tracked = (op: string): boolean => !UNTRACKED_OPS.has(op);

export class RithmicLocalConnection {
  private socket: RithmicLinkSocket | null = null;
  private stopped = true;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAt = 0;
  private silent = false;
  private authenticated = false;
  private counter = 0;
  /**
   * Měření jednoho otevření appky (start nebo návrat z pozadí) po krocích — jen čísla pro výpis služby, nic neřídí.
   * Časy jsou hodiny zařízení (ms). Odešle se dvakrát: s první živou cenou a s historií svíček.
   */
  private trace: {
    wakeAt: number; cold: boolean; awayMs: number | null; hadSocket: boolean; closedAt?: number; attempts: number;
    attemptAt?: number; openAt?: number; keyAt?: number; authAt?: number; helloAt?: number; liveAt?: number; hellos: number; done?: boolean;
  } | null = null;
  private hiddenAt: number | null = null;
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

  /** Odmítnuté zařízení: konec bez dalších pokusů (opakování by jen bušilo na službu se špatným klíčem). */
  private refuse(socket: RithmicLinkSocket, reason: string): void {
    this.stopped = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    if (this.beat) { clearInterval(this.beat); this.beat = null; }
    try { this.options.handlers.onAuthFailed?.(reason); } finally { try { socket.close(); } catch { /* už zavřené */ } }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.trace = { wakeAt: this.now(), cold: true, awayMs: null, hadSocket: false, attempts: 0, hellos: 0 };
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

  /**
   * Appka se vrátila do popředí: nečekat na časovač dalšího pokusu a připojit se hned. Když spojení běží, nedělá nic.
   */
  /** Appka šla do pozadí / vrátila se: jen pro měření (viz `trace`). Návrat po méně než sekundě se neměří. */
  visibility(visible: boolean): void {
    const now = this.now();
    if (!visible) { this.hiddenAt ??= now; return; }
    if (this.hiddenAt === null) return;
    const awayMs = now - this.hiddenAt;
    this.hiddenAt = null;
    if (this.stopped || awayMs < 1_000) return;
    this.trace = { wakeAt: now, cold: false, awayMs, hadSocket: this.socket !== null, attempts: 0, hellos: 0 };
  }

  /** Odešle měření službě (ta ho jen vypíše). Selhání se ignoruje — měření nesmí nic rozbít. */
  private report(link: RithmicLinkSocket, stage: 'cena' | 'historie', extra: Record<string, number> = {}): void {
    const t = this.trace;
    if (!t || this.options.measure === false) return;
    const now = this.now();
    const since = (at: number | undefined, from: number | undefined): number | null => (at === undefined || from === undefined ? null : Math.round(at - from));
    const metric: Record<string, number | boolean | string | null> = {
      stage, cold: t.cold, awayMs: t.awayMs === null ? null : Math.round(t.awayMs), hadSocket: t.hadSocket,
      // Starý (mrtvý) socket po návratu: za jak dlouho se zavřel — do té doby se nové spojení nezačne stavět.
      staleMs: since(t.closedAt, t.wakeAt), attempts: t.attempts,
      startMs: since(t.attemptAt, t.wakeAt), // návrat → začátek úspěšného pokusu (včetně neúspěšných)
      socketMs: since(t.openAt, t.attemptAt), // síť: tunel + TLS + WebSocket
      keyMs: since(t.keyAt, t.openAt), // čtení klíče zařízení (Klíčenka)
      authMs: since(t.authAt, t.keyAt), // ověření zařízení službou
      helloMs: since(t.helloAt, t.authAt), // první zpráva se stavem a svíčkami
      liveMs: since(t.liveAt, t.authAt), // první živá cena
      totalMs: Math.round(now - t.wakeAt),
      pageMs: t.cold && typeof performance !== 'undefined' ? Math.round(performance.now()) : null, // start stránky → teď
      ...extra,
    };
    try { link.send(JSON.stringify({ metric })); } catch { /* jen měření — není to příkaz */ }
  }

  kick(): void {
    if (this.stopped || this.socket) return;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.connect();
  }

  isOpen(): boolean { return this.socket?.readyState === OPEN && this.authenticated; }

  /** Odešle příkaz právě jednou. Bez spojení se neodešle; bez odpovědi je výsledek „unknown". */
  send(command: { op: string } & Record<string, unknown>): Promise<RithmicLinkReply> {
    return new Promise((resolve) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== OPEN || !this.authenticated) { resolve({ ok: false, sent: false, error: 'místní proces není připojený' }); return; }
      // Timers and React may still be suspended when a click arrives after sleep.
      if (command.op !== 'flatten' && command.op !== 'lookup' && this.now() - this.lastHeartbeatAt > this.beatTimeoutMs) {
        resolve({ ok: false, sent: false, error: 'Místní služba neodpovídá — počkej na obnovení stavu účtu.' });
        return;
      }
      const id = this.newId();
      if (tracked(command.op)) {
        try { this.options.handlers.beforeSend?.(id, command); } catch (error) {
          if (command.op === 'entry' || command.op === 'replace-entry') {
            resolve({ ok: false, sent: false, error: error instanceof Error ? error.message : 'Nelze uložit ID příkazu pro obnovu po výpadku.' });
            return;
          }
        }
      }
      const timer = setTimeout(() => {
        if (!this.replies.delete(id)) return;
        if (tracked(command.op)) this.options.handlers.onUncertain({ id, at: this.now(), op: command.op, reason: 'místní proces neodpověděl' });
        resolve({ ok: false, sent: 'unknown', error: 'místní proces neodpověděl — ověř stav' });
      }, this.replyTimeoutMs);
      this.replies.set(id, { op: command.op, resolve: (reply) => { clearTimeout(timer); resolve(reply); } });
      try { socket.send(JSON.stringify({ id, command })); } catch {
        // Odeslání vyhodilo: jestli něco odešlo, se neví → stejné zacházení jako výpadek.
        const pending = this.replies.get(id);
        this.replies.delete(id);
        if (tracked(command.op)) this.options.handlers.onUncertain({ id, at: this.now(), op: command.op, reason: 'odeslání místnímu procesu selhalo' });
        pending?.resolve({ ok: false, sent: 'unknown', error: 'odeslání místnímu procesu selhalo — ověř stav' });
      }
    });
  }

  /** Příkazy bez odpovědi v okamžiku ztráty spojení: výsledek není znám, nic se neopakuje. */
  private failPending(): void {
    const pending = [...this.replies];
    this.replies.clear();
    for (const [id, item] of pending) {
      if (tracked(item.op)) this.options.handlers.onUncertain({ id, at: this.now(), op: item.op, reason: 'spojení s místním procesem spadlo' });
      item.resolve({ ok: false, sent: 'unknown', error: 'spojení s místním procesem spadlo — ověř stav' });
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.retry = null;
    if (this.trace && this.trace.authAt === undefined) {
      this.trace.attempts += 1;
      this.trace.attemptAt = this.now();
      this.trace.openAt = undefined;
      this.trace.keyAt = undefined;
    }
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
      if (this.trace && this.trace.authAt === undefined) this.trace.openAt = this.now();
      if (!this.options.auth) {
        if (this.trace && this.trace.authAt === undefined) { this.trace.keyAt = this.now(); this.trace.authAt = this.now(); }
        this.authenticated = true; this.options.handlers.onLink('open'); return;
      }
      this.authenticated = false;
      void Promise.resolve().then(() => this.options.auth!()).then((key) => {
        if (this.socket !== mine) return;
        if (!key) { this.refuse(mine, 'V tomto zařízení chybí klíč spárování.'); return; }
        if (this.trace && this.trace.authAt === undefined) this.trace.keyAt = this.now();
        try { mine.send(JSON.stringify({ auth: key })); } catch { mine.close(); }
        // Klíčenku nejde přečíst (zamčený telefon, chyba systému): přechodný stav — spojení zavřít a zkoušet dál,
        // NE nabízet nové spárování. Po odemčení se připojí samo.
      }, () => { if (this.socket === mine) mine.close(); });
    };
    mine.onclose = () => {
      if (this.socket !== mine) return;
      if (this.trace && this.trace.hadSocket && this.trace.closedAt === undefined) this.trace.closedAt = this.now();
      this.socket = null;
      this.authenticated = false;
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
      if (!this.authenticated) {
        // Před ověřením zařízení se čeká jen na verdikt služby; cokoli jiného se zahodí.
        if (message.type !== 'auth') return;
        if (message.ok === true) {
          if (this.trace && this.trace.authAt === undefined) this.trace.authAt = this.now();
          this.authenticated = true; this.lastHeartbeatAt = this.now(); this.options.handlers.onLink('open');
        }
        // `retry`: potíž je na straně služby (např. nečitelný seznam zařízení) — zkoušet dál, ne párovat znovu.
        else if (message.retry === true) mine.close();
        else this.refuse(mine, typeof message.error === 'string' ? message.error : 'Služba toto zařízení odmítla.');
        return;
      }
      const receivedAt = this.now();
      if (receivedAt - this.lastHeartbeatAt > RESYNC_GAP_MS) { mine.close(); return; }
      const trace = this.trace;
      if (trace && !trace.done) {
        if (message.type === 'hello') {
          trace.hellos += 1;
          if (trace.helloAt === undefined) trace.helloAt = receivedAt;
          // Druhá zpráva hello nese historii svíček: tím je graf úplný a měření končí.
          else if (trace.hellos === 2) { this.report(mine, 'historie', { bars: Array.isArray(message.bars) ? message.bars.length : 0 }); if (trace.liveAt !== undefined) trace.done = true; }
        } else if (trace.liveAt === undefined && (message.type === 'tick' || message.type === 'beat') && typeof message.at === 'number' && receivedAt - message.at <= this.beatTimeoutMs) {
          trace.liveAt = receivedAt;
          this.report(mine, 'cena', { feed: message.type === 'tick' ? 1 : 0 });
          // Spojení přežilo pozadí (žádné nové hello nepřijde): tím měření končí.
          if (trace.attempts === 0 || trace.hellos >= 2) trace.done = true;
        }
      }
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
        if (tracked(pending.op) && !reply.ok && reply.sent !== false) this.options.handlers.onUncertain({ id, at: this.now(), op: pending.op, reason: reply.error ?? 'výsledek není znám' });
        if (tracked(pending.op) && (reply.ok || reply.sent === false)) {
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
