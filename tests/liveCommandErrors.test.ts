import { describe, expect, it, vi } from 'vitest';
import { LIVE_RELAY_NOT_ADMITTED_CODES, LiveCommandNotSentError, isLiveCommandNotSent, liveCommandNotSentReason, withLiveRelayPhase } from '../lib/liveCommandErrors';
import { copierRelayValidationErrorStatus } from '../server/tradovateCopierCommandRelay';
import { executeTradovateCopierRelayCommand, TradovateRequestError } from '../services/tradovateOAuthConnection';
import { liveManageErrorNotice } from '../hooks/useLiveManageRunner';

vi.mock('../services/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'mock-token' } } }) } },
}));
import { LocalCopierAgentCommandError } from '../lib/localCopierAgentProtocol';
import { createLiveChartIntentStore, entryIntentDraft, trackLiveChartIntent } from '../lib/liveChartIntent';

const relay = (code: string, status = 409) => withLiveRelayPhase(new TradovateRequestError(code, status, null, code), 'submit');

describe('„neodesláno“ jen podle typu chyby a přesného kódu relay odmítnutí', () => {
  it('kódy UI jsou podmnožinou odmítnutí serveru PŘED frontou (400/409) — žádný konflikt idempotence ani entry-conflict', () => {
    expect(LIVE_RELAY_NOT_ADMITTED_CODES.length).toBeGreaterThan(5);
    for (const code of LIVE_RELAY_NOT_ADMITTED_CODES) expect([400, 409]).toContain(copierRelayValidationErrorStatus(code));
    expect(copierRelayValidationErrorStatus('copier-relay-entry-not-admitted: expired')).toBe(409);
    expect(LIVE_RELAY_NOT_ADMITTED_CODES).not.toContain('copier-relay-idempotency-conflict');
    expect(LIVE_RELAY_NOT_ADMITTED_CODES).not.toContain('copier-relay-entry-conflict');
    expect(isLiveCommandNotSent(relay('copier-relay-entry-conflict'))).toBe(false);
    expect(isLiveCommandNotSent(relay('copier-relay-idempotency-conflict'))).toBe(false);
  });

  it('arm-config-conflict (server ho umí hodit až po insertu, kontrola souběžného zařazení) nikdy není „neodesláno“', () => {
    expect(copierRelayValidationErrorStatus('copier-relay-arm-config-conflict')).toBe(409);
    expect(LIVE_RELAY_NOT_ADMITTED_CODES).not.toContain('copier-relay-arm-config-conflict');
    // Ani jako chyba samotného POST (fáze submit), ani z pollu.
    expect(isLiveCommandNotSent(relay('copier-relay-arm-config-conflict'))).toBe(false);
    expect(isLiveCommandNotSent(withLiveRelayPhase(new TradovateRequestError('copier-relay-arm-config-conflict', 409, null, 'copier-relay-arm-config-conflict'), 'accepted'))).toBe(false);
    // Totéž pro všechny 409 kódy serveru mimo bílou listinu (povinné rozhodnutí při přidání nového kódu).
    for (const code of ['copier-relay-arm-config-conflict', 'copier-relay-idempotency-conflict', 'copier-brake-idempotency-conflict', 'copier-relay-entry-conflict', 'copier-relay-runtime-not-found']) {
      expect(isLiveCommandNotSent(relay(code))).toBe(false);
    }
  });

  it('odmítnutí workerem PO zařazení (stejný text) i obyčejná chyba zůstávají neznámým výsledkem', () => {
    expect(isLiveCommandNotSent(new LocalCopierAgentCommandError('copier-relay-entry-busy'))).toBe(false);
    expect(isLiveCommandNotSent(new Error('copier-relay-entry-busy'))).toBe(false);
    expect(isLiveCommandNotSent(new Error('Stav kopírky není čerstvě ověřený — nic se neodeslalo.'))).toBe(false);
    expect(isLiveCommandNotSent(relay('copier-relay-entry-busy', 502))).toBe(false);
    expect(isLiveCommandNotSent(new TradovateRequestError('copier-relay-entry-busy', 409))).toBe(false);
  });

  it('typovaná chyba klienta a kódy relay odmítnutí', () => {
    expect(liveCommandNotSentReason(new LiveCommandNotSentError('x', 'busy'))).toBe('busy');
    expect(liveCommandNotSentReason(relay('copier-relay-entry-busy'))).toBe('entry-busy');
    expect(liveCommandNotSentReason(relay('invalid-relay-command-payload', 400))).toBe('invalid-payload');
    expect(liveCommandNotSentReason(relay('copier-relay-entry-not-admitted: expired'))).toBe('entry-not-admitted');
    expect(liveCommandNotSentReason(withLiveRelayPhase(new TradovateRequestError('Localhost je pro Tradovate pouze read-only.', 405), 'submit'))).toBe('read-only');
  });
});

describe('čekající čára po odeslání: rozhoduje kód odpovědi, ne text', () => {
  const draft = (operationId: string) => entryIntentDraft({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 99 }, operationId, null);
  it('markSent → relay 409 entry-busy = neodesláno (čára zmizí); markSent → 502 / timeout = neznámý', async () => {
    for (const [reason, expected] of [
      [relay('copier-relay-entry-busy'), []],
      [new TradovateRequestError('Bad gateway', 502), ['unknown']],
      [new Error('timeout'), ['unknown']],
      [new LocalCopierAgentCommandError('copier-relay-entry-busy'), ['unknown']],
    ] as const) {
      const store = createLiveChartIntentStore();
      await trackLiveChartIntent(store, draft('entry:abcdefgh9'), (): Promise<{ status: string; operationId: string }> => { store.markSent('entry:abcdefgh9'); return Promise.reject(reason); }).catch(() => undefined);
      expect(store.snapshot().map(intent => intent.state)).toEqual(expected);
    }
  });

  it('důkaz workeru dorazí ještě během odesílání: čára zůstane „odesílám“, potvrdí se až po výsledku', async () => {
    const store = createLiveChartIntentStore();
    let answer!: (value: { status: string; operationId: string }) => void;
    const tracked = trackLiveChartIntent(store, draft('entry:abcdefgh8'), () => { store.markSent('entry:abcdefgh8'); return new Promise<{ status: string; operationId: string }>(resolve => { answer = resolve; }); });
    const evidence = { workerEntryOperationIds: new Set(['entry:abcdefgh8']) };
    store.prune(Date.now(), null, evidence);
    expect(store.snapshot().map(intent => intent.state)).toEqual(['sending']);
    answer({ status: 'acknowledged', operationId: 'entry:abcdefgh8' });
    await tracked;
    // Bez nakreslené pozice záměr drží (žádné bliknutí na flat); s pozicí téže strany zmizí.
    store.prune(Date.now(), null, evidence);
    expect(store.snapshot().map(intent => intent.state)).toEqual(['acknowledged']);
    store.prune(Date.now(), { key: 'p', symbol: 'MNQZ6', lines: [], issue: null, summary: { kind: 'pending', side: 'long', quantity: 1, entry: 99 } } as never, evidence);
    expect(store.snapshot()).toEqual([]);
  });
});

describe('fáze relay požadavku: „neodesláno“ jen u chyby samotného POST před zařazením (review Codexu, P2)', () => {
  const command = { type: 'copy-command', command: { type: 'manage-leader-order', operationId: 'manage:phase0001', action: 'move-stop' } } as never;
  const run = async (respond: (method: string) => Response) => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => respond(init?.method ?? 'GET')));
    try {
      return await executeTradovateCopierRelayCommand('mock-connection', command).then(() => null, error => error);
    } finally {
      vi.unstubAllGlobals();
    }
  };
  const accepted = () => Response.json({ id: 'queued-1', expiresAt: new Date(Date.now() + 15_000).toISOString() });

  it('POST přijat, poll vrátí HTTP 405 = výsledek NEZNÁMÝ (příkaz mohl proběhnout), nikdy „neodesláno“', async () => {
    const error = await run(method => (method === 'POST' ? accepted() : Response.json({ error: 'Method not allowed' }, { status: 405 })));
    expect(error).toBeInstanceOf(TradovateRequestError);
    expect(error.status).toBe(405);
    expect(isLiveCommandNotSent(error)).toBe(false);
    expect(liveManageErrorNotice(error, 1).tone).toBe('warn');
  });

  it('POST přijat, poll vrátí 409 s kódem odmítnutí = taky neznámý výsledek', async () => {
    const error = await run(method => (method === 'POST' ? accepted() : Response.json({ error: 'copier-relay-entry-busy' }, { status: 409 })));
    expect(error.code).toBe('copier-relay-entry-busy');
    expect(isLiveCommandNotSent(error)).toBe(false);
  });

  it('samotný POST odmítnutý 405 (read-only) nebo 409 entry-busy = neodesláno', async () => {
    const readOnly = await run(() => Response.json({ error: 'Localhost je pro Tradovate pouze read-only.' }, { status: 405 }));
    expect(liveCommandNotSentReason(readOnly)).toBe('read-only');
    const busy = await run(() => Response.json({ error: 'copier-relay-entry-busy' }, { status: 409 }));
    expect(liveCommandNotSentReason(busy)).toBe('entry-busy');
    // POST s chybou serveru (502) nebo neznámým kódem není prokazatelně neodeslaný.
    expect(isLiveCommandNotSent(await run(() => Response.json({ error: 'boom' }, { status: 502 })))).toBe(false);
  });

  it('čekající čára: přijatý POST + 405 z pollu = „výsledek neznámý“, čára nezmizí (žádné ruční duplicitní odeslání)', async () => {
    const store = createLiveChartIntentStore();
    const draft = entryIntentDraft({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 99 }, 'manage:phase0001', null);
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => (init?.method === 'POST' ? accepted() : Response.json({ error: 'x' }, { status: 405 }))));
    try {
      await trackLiveChartIntent(store, draft, () => {
        store.markSent('manage:phase0001');
        return executeTradovateCopierRelayCommand('mock-connection', command) as unknown as Promise<{ status: string; operationId: string }>;
      }).catch(() => undefined);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(store.snapshot().map(intent => intent.state)).toEqual(['unknown']);
  });

  it('POST: výpadek sítě = neznámý; výsledek „rejected“ přímo v odpovědi POST (už ve frontě) = neznámý', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const network = await executeTradovateCopierRelayCommand('mock-connection', command).then(() => null, error => error).finally(() => vi.unstubAllGlobals());
    expect(network).not.toBeNull();
    expect(isLiveCommandNotSent(network)).toBe(false);
    const inline = await run(() => Response.json({ id: 'queued-2', expiresAt: new Date(Date.now() + 15_000).toISOString(),
      resolution: { status: 'rejected', error: 'copier-relay-entry-busy' } }));
    expect(inline).toBeInstanceOf(LocalCopierAgentCommandError);
    expect(isLiveCommandNotSent(inline)).toBe(false);
  });

  it('bez značky fáze (jiný původ chyby) HTTP stav nerozhoduje', () => {
    expect(isLiveCommandNotSent(new TradovateRequestError('copier-relay-entry-busy', 409, null, 'copier-relay-entry-busy'))).toBe(false);
    expect(isLiveCommandNotSent(new TradovateRequestError('x', 405))).toBe(false);
    expect(isLiveCommandNotSent(withLiveRelayPhase(new TradovateRequestError('x', 405), 'accepted'))).toBe(false);
    // Typovaná klientská kontrola fázi nepotřebuje.
    expect(isLiveCommandNotSent(new LiveCommandNotSentError('x'))).toBe(true);
  });
});
