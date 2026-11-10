import { describe, expect, it } from 'vitest';
import { LIVE_RELAY_NOT_ADMITTED_CODES, LiveCommandNotSentError, isLiveCommandNotSent, liveCommandNotSentReason } from '../lib/liveCommandErrors';
import { copierRelayValidationErrorStatus } from '../server/tradovateCopierCommandRelay';
import { TradovateRequestError } from '../services/tradovateOAuthConnection';
import { LocalCopierAgentCommandError } from '../lib/localCopierAgentProtocol';
import { createLiveChartIntentStore, entryIntentDraft, trackLiveChartIntent } from '../lib/liveChartIntent';

const relay = (code: string, status = 409) => new TradovateRequestError(code, status, null, code);

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
    expect(liveCommandNotSentReason(new TradovateRequestError('Localhost je pro Tradovate pouze read-only.', 405))).toBe('read-only');
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
    store.prune(Date.now(), null, evidence);
    expect(store.snapshot()).toEqual([]);
  });
});
