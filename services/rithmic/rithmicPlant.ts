/**
 * Jedno spojení na jeden „plant" Rithmicu (order / ticker / pnl / history).
 *
 * Bezpečnostní vlastnosti, na kterých stojí vyšší vrstvy:
 *  - žádné automatické opakování požadavku — nikdy (INV-OUTBOX: žádný blind retry);
 *  - požadavek, který už odešel a nedostal konečnou odpověď (timeout, pád
 *    spojení), končí chybou s `outcome: 'unknown'` — volající MUSÍ výsledek
 *    dohledat, ne předpokládat neúspěch;
 *  - `outcome: 'not-sent'` jen když se o odeslání vůbec nepokusil (spojení není
 *    připravené, požadavek nejde sestavit); výjimka ze `send()` je 'unknown';
 *  - výslovné odmítnutí serverem je `outcome: 'rejected'`;
 *  - spojení se samo neobnovuje; o novém připojení a dorovnání stavu rozhoduje
 *    vrstva nad tím.
 */
import {
  decodeRithmicFrames,
  encodeRithmicFrame,
  rithmicStrings,
  rithmicTemplateHasField,
  type RithmicFields,
  type RithmicMessage,
} from './rithmicCodec';

export const RITHMIC_INFRA = { TICKER_PLANT: 1, ORDER_PLANT: 2, HISTORY_PLANT: 3, PNL_PLANT: 4 } as const;
export type RithmicInfraType = (typeof RITHMIC_INFRA)[keyof typeof RITHMIC_INFRA];

export interface RithmicSocketLike {
  binaryType?: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}
export type RithmicSocketFactory = (url: string) => RithmicSocketLike;

export interface RithmicCredentials {
  user: string;
  password: string;
  systemName: string;
  appName: string;
  appVersion: string;
}

export type RithmicOutcome = 'rejected' | 'unknown' | 'not-sent';

export class RithmicRequestError extends Error {
  readonly outcome: RithmicOutcome;
  readonly templateId: number;
  readonly rpCode: string[];
  constructor(message: string, outcome: RithmicOutcome, templateId: number, rpCode: string[] = []) {
    super(message);
    this.name = 'RithmicRequestError';
    this.outcome = outcome;
    this.templateId = templateId;
    this.rpCode = rpCode;
  }
}

export interface RithmicRequestOptions {
  timeoutMs?: number;
  /**
   * Zprávy bez `user_msg`, které k požadavku patří (např. snímky příkazů 352
   * po RequestShowOrders). Zachycené zprávy se neposílají dál jako živé události.
   */
  collect?: (message: RithmicMessage) => boolean;
}

export interface RithmicResponse {
  /** Datové řádky (odpovědi bez rp_code + zachycené zprávy), v pořadí doručení. */
  rows: RithmicMessage[];
  /** Konečná odpověď s rp_code „0"; null, když server řekl „žádná data" (rp_code 7). */
  terminal: RithmicMessage | null;
  sentAt: number;
  completedAt: number;
}

export interface RithmicCloseInfo {
  code?: number;
  reason?: string;
  /** true = zavřeli jsme sami (close()), false = spadlo nebo zavřel server. */
  intentional: boolean;
  forcedLogout: boolean;
}

export interface RithmicPlantConfig {
  url: string;
  infraType: RithmicInfraType;
  credentials: RithmicCredentials;
  socketFactory: RithmicSocketFactory;
  onPush?: (message: RithmicMessage, receivedAt: number) => void;
  onClose?: (info: RithmicCloseInfo) => void;
  onUnknownTemplate?: (templateId: number) => void;
  /** Zpracování zprávy vyhodilo výjimku (zpráva se NEuplatnila). */
  onHandlerError?: (message: RithmicMessage, error: unknown) => void;
  /** Jakákoli zpráva ze serveru (i odpověď na heartbeat) = důkaz živého spojení. */
  onAlive?: (receivedAt: number) => void;
  now?: () => number;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Jak často posílat heartbeat, jako podíl intervalu ze serveru (výchozí 0,5). */
  heartbeatFraction?: number;
}

interface Pending {
  id: string;
  templateId: number;
  responseTemplateId: number;
  rows: RithmicMessage[];
  collect?: (message: RithmicMessage) => boolean;
  sentAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: RithmicResponse) => void;
  reject: (error: RithmicRequestError) => void;
}

const SOCKET_OPEN = 1;
const TEMPLATE_LOGIN = 10;
const TEMPLATE_LOGOUT = 12;
const TEMPLATE_HEARTBEAT = 18;
const TEMPLATE_HEARTBEAT_RESPONSE = 19;
const TEMPLATE_REJECT = 75;
const TEMPLATE_FORCED_LOGOUT = 77;

export class RithmicPlant {
  private readonly config: RithmicPlantConfig;
  private readonly now: () => number;
  private socket: RithmicSocketLike | null = null;
  private pending = new Map<string, Pending>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sequence = 0;
  private loggedIn = false;
  private intentionalClose = false;
  private forcedLogout = false;
  /** Vyplněno po přihlášení; order plant je doplní i z RequestLoginInfo. */
  identity: { fcmId?: string; ibId?: string; userType?: number } = {};
  heartbeatIntervalSec = 60;
  lastMessageAt = 0;

  constructor(config: RithmicPlantConfig) {
    this.config = config;
    this.now = config.now ?? (() => Date.now());
  }

  get connected(): boolean {
    return this.loggedIn && !!this.socket && this.socket.readyState === SOCKET_OPEN;
  }

  /** Otevře spojení a přihlásí se. Chyba přihlášení = spojení se zavře. */
  async connect(): Promise<RithmicMessage> {
    if (this.socket) throw new Error('Rithmic plant už je připojený nebo se připojuje');
    this.intentionalClose = false;
    this.forcedLogout = false;
    const socket = this.config.socketFactory(this.config.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Rithmic: vypršel čas na otevření spojení'));
      }, this.config.connectTimeoutMs ?? 15_000);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Rithmic: spojení se nepodařilo otevřít'));
      };
      socket.onclose = (event) => {
        clearTimeout(timer);
        reject(new Error(`Rithmic: spojení zavřeno při otevírání (${event?.code ?? '?'})`));
      };
    }).catch((error) => {
      this.teardown();
      throw error;
    });
    socket.onmessage = (event) => this.handleData(event.data);
    socket.onerror = () => undefined;
    socket.onclose = (event) => this.handleClose(event);
    try {
      const { credentials } = this.config;
      const response = await this.sendRequest(TEMPLATE_LOGIN, {
        template_version: '3.9',
        user: credentials.user,
        password: credentials.password,
        system_name: credentials.systemName,
        app_name: credentials.appName,
        app_version: credentials.appVersion,
        infra_type: this.config.infraType,
      }, {}, true);
      const login = response.terminal;
      if (!login) throw new RithmicRequestError('Rithmic: přihlášení bez odpovědi', 'rejected', TEMPLATE_LOGIN);
      this.identity = {
        fcmId: typeof login.fields.fcm_id === 'string' ? login.fields.fcm_id : undefined,
        ibId: typeof login.fields.ib_id === 'string' ? login.fields.ib_id : undefined,
      };
      const interval = Number(login.fields.heartbeat_interval);
      if (Number.isFinite(interval) && interval > 0) this.heartbeatIntervalSec = interval;
      this.loggedIn = true;
      this.lastMessageAt = this.now();
      this.startHeartbeat();
      return login;
    } catch (error) {
      this.intentionalClose = true;
      this.closeSocket();
      throw error;
    }
  }

  /**
   * Pošle požadavek a počká na konečnou odpověď. Nikdy neopakuje.
   * Odmítnutí serverem → 'rejected'; timeout nebo pád po odeslání → 'unknown'.
   */
  request(templateId: number, fields: RithmicFields = {}, options: RithmicRequestOptions = {}): Promise<RithmicResponse> {
    return this.sendRequest(templateId, fields, options, false);
  }

  private sendRequest(
    templateId: number,
    fields: RithmicFields,
    options: RithmicRequestOptions,
    duringLogin: boolean,
  ): Promise<RithmicResponse> {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN || (!duringLogin && !this.loggedIn)) {
      return Promise.reject(new RithmicRequestError('Rithmic: spojení není připravené', 'not-sent', templateId));
    }
    const id = `${this.config.infraType}-${++this.sequence}-${this.now().toString(36)}`;
    const payload: RithmicFields = { ...fields, user_msg: [id] };
    if (payload.fcm_id === undefined && this.identity.fcmId && rithmicTemplateHasField(templateId, 'fcm_id')) {
      payload.fcm_id = this.identity.fcmId;
    }
    if (payload.ib_id === undefined && this.identity.ibId && rithmicTemplateHasField(templateId, 'ib_id')) {
      payload.ib_id = this.identity.ibId;
    }
    if (
      payload.user_type === undefined &&
      this.identity.userType !== undefined &&
      rithmicTemplateHasField(templateId, 'user_type')
    ) {
      payload.user_type = this.identity.userType;
    }
    let frame: Uint8Array;
    try {
      frame = encodeRithmicFrame(templateId, payload);
    } catch (error) {
      return Promise.reject(
        new RithmicRequestError(`Rithmic: požadavek nejde sestavit: ${(error as Error).message}`, 'not-sent', templateId),
      );
    }
    return new Promise<RithmicResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RithmicRequestError(`Rithmic: požadavek ${templateId} bez odpovědi`, 'unknown', templateId));
      }, options.timeoutMs ?? this.config.requestTimeoutMs ?? 10_000);
      const pending: Pending = {
        id,
        templateId,
        responseTemplateId: templateId + 1,
        rows: [],
        collect: options.collect,
        sentAt: this.now(),
        timer,
        resolve,
        reject,
      };
      this.pending.set(id, pending);
      try {
        socket.send(frame);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        // Výjimka ze send() nedokazuje, že neodešel ani bajt (rámec mohl být
        // zčásti zapsán). Výsledek je proto neznámý a musí se dohledat.
        reject(new RithmicRequestError(`Rithmic: výsledek požadavku ${templateId} neznámý, send() selhal: ${(error as Error).message}`, 'unknown', templateId));
      }
    });
  }

  /** Zavře spojení (logout best-effort). Čekající požadavky skončí jako 'unknown'. */
  close(): void {
    this.intentionalClose = true;
    const socket = this.socket;
    if (socket && socket.readyState === SOCKET_OPEN && this.loggedIn) {
      try {
        socket.send(encodeRithmicFrame(TEMPLATE_LOGOUT, {}));
      } catch {
        // logout je jen zdvořilost
      }
    }
    this.closeSocket();
  }

  private closeSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    try {
      socket.close(1000, 'Closing Connection');
    } catch {
      // socket už může být zavřený
    }
    // Některé implementace nevolají onclose synchronně ani vůbec po chybě.
    if (this.socket === socket) this.handleClose({ code: 1000, reason: 'local close' });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const periodMs = Math.max(1_000, Math.floor(this.heartbeatIntervalSec * 1000 * (this.config.heartbeatFraction ?? 0.5)));
    const silenceMs = Math.max(this.heartbeatIntervalSec * 1000 * 2.5, periodMs * 3);
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== SOCKET_OPEN) return;
      // Tiché spojení: server neodpověděl ani na heartbeat. Bereme ho jako spadlé.
      if (this.now() - this.lastMessageAt > silenceMs) {
        this.closeSocket();
        return;
      }
      try {
        socket.send(encodeRithmicFrame(TEMPLATE_HEARTBEAT, {}));
      } catch {
        // pád spojení ohlásí onclose
      }
    }, periodMs);
    (this.heartbeatTimer as { unref?: () => void }).unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private teardown(): void {
    this.stopHeartbeat();
    const socket = this.socket;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
    }
    this.socket = null;
    this.loggedIn = false;
  }

  private handleClose(event?: { code?: number; reason?: string }): void {
    if (!this.socket) return;
    this.teardown();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(
        new RithmicRequestError(
          `Rithmic: spojení spadlo před odpovědí na požadavek ${p.templateId}`,
          'unknown',
          p.templateId,
        ),
      );
    }
    this.config.onClose?.({
      code: event?.code,
      reason: event?.reason,
      intentional: this.intentionalClose,
      forcedLogout: this.forcedLogout,
    });
  }

  private handleData(data: unknown): void {
    let messages: RithmicMessage[];
    try {
      messages = decodeRithmicFrames(data);
    } catch {
      // Poškozený rámec = nedá se věřit ničemu dalšímu na tomhle spojení.
      this.closeSocket();
      return;
    }
    const receivedAt = this.now();
    this.lastMessageAt = receivedAt;
    this.config.onAlive?.(receivedAt);
    for (const message of messages) {
      try {
        this.handleMessage(message, receivedAt);
      } catch (error) {
        // Výjimka odběratele nesmí zahodit zbytek zpráv z téhož rámce, ale nesmí ani zmizet:
        // vrstva nad tím musí stav ověřit čtením.
        this.config.onHandlerError?.(message, error);
      }
    }
  }

  private handleMessage(message: RithmicMessage, receivedAt: number): void {
    if (message.name === null) {
      this.config.onUnknownTemplate?.(message.templateId);
      return;
    }
    if (message.templateId === TEMPLATE_HEARTBEAT_RESPONSE) return;
    if (message.templateId === TEMPLATE_FORCED_LOGOUT) {
      this.forcedLogout = true;
      this.closeSocket();
      return;
    }
    const userMsg = rithmicStrings(message.fields.user_msg);
    const rpCode = rithmicStrings(message.fields.rp_code);
    const pending = userMsg.length ? this.pending.get(userMsg[0]) : undefined;

    if (message.templateId === TEMPLATE_REJECT) {
      if (pending) this.finish(pending, null, rpCode, receivedAt);
      return;
    }
    // Odpověď se přiřadí JEN podle shodného user_msg — konečná i datový řádek. Pozdní řádek
    // starého požadavku bez user_msg by jinak skončil ve výsledku jiného čtení nebo potvrdil
    // jiný zápis. Pokud server u některé šablony user_msg nevrací, čtení vyprší (bezpečně).
    if (pending && pending.responseTemplateId === message.templateId) {
      if (rpCode.length === 0) {
        pending.rows.push(message);
        return;
      }
      this.finish(pending, message, rpCode, receivedAt);
      return;
    }
    for (const p of this.pending.values()) {
      if (p.collect?.(message)) {
        p.rows.push(message);
        return;
      }
    }
    this.config.onPush?.(message, receivedAt);
  }

  private finish(pending: Pending, terminal: RithmicMessage | null, rpCode: string[], completedAt: number): void {
    clearTimeout(pending.timer);
    this.pending.delete(pending.id);
    const code = rpCode[0] ?? '';
    if (terminal && code === '0') {
      pending.resolve({ rows: pending.rows, terminal, sentAt: pending.sentAt, completedAt });
      return;
    }
    if (terminal && code === '7') {
      // „Žádná data" — platná prázdná odpověď.
      pending.resolve({ rows: pending.rows, terminal: null, sentAt: pending.sentAt, completedAt });
      return;
    }
    pending.reject(
      new RithmicRequestError(
        `Rithmic odmítl požadavek ${pending.templateId}: ${rpCode.join(' ') || 'bez důvodu'}`,
        'rejected',
        pending.templateId,
        rpCode,
      ),
    );
  }
}
