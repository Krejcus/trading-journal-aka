import { withLiveRelayPhase } from '../lib/liveCommandErrors';
import { LiveCommandNotSentError } from '../lib/liveCommandErrors';
import { TradovateRequestError } from '../services/tradovateOAuthConnection';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LeaderOrderManageAction, LeaderOrderManageResult } from '../lib/leaderOrderManage';
import {
  LIVE_MANAGE_CONFIRM_MIN_MS, LIVE_MANAGE_CONFIRM_MS, LIVE_MANAGE_PENDING_HOLD_MS, createLiveManageRun, liveManageConfirmStep,
  liveManageErrorNotice, liveManageResultNotice, useLiveManageRunner, type LiveManageCallback, type LiveManageNotice, type LiveManagePendingMove,
} from '../hooks/useLiveManageRunner';

const NOW = Date.UTC(2026, 10, 3, 15);
const result = (patch: Partial<LeaderOrderManageResult> = {}): LeaderOrderManageResult => ({
  type: 'leader-order-managed', operationId: 'manage:abcdefgh12', action: 'move-stop', status: 'acknowledged', checkedAt: NOW, blockers: [], ...patch,
});

/** Jádro běhu s falešným `manage` a stavem jako v Reactu (setState s funkcí). */
function harness(manage: LiveManageCallback | null) {
  let pending: LiveManagePendingMove | null = null;
  const pendingHistory: Array<LiveManagePendingMove | null> = [];
  const notices: LiveManageNotice[] = [];
  const busy: boolean[] = [];
  const busyRef = { current: false };
  const run = createLiveManageRun({
    manage: () => manage,
    busyRef,
    setPendingMove: update => {
      pending = typeof update === 'function' ? update(pending) : update;
      pendingHistory.push(pending);
    },
    setBusy: value => busy.push(value),
    report: notice => notices.push(notice),
    now: () => NOW,
  });
  return { run, busyRef, notices, busy, pendingHistory, pending: () => pending };
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('sdílený runner správy: jeden příkaz naráz, bez opakování (U10)', () => {
  it('posun: „odesílám“ drží do výsledku, po potvrzení ještě 5 s; manage dostane přesně záměr', async () => {
    const gate = deferred<LeaderOrderManageResult>();
    const manage = vi.fn<LiveManageCallback>(() => gate.promise);
    const h = harness(manage);
    const running = h.run('move-stop', 24_990, 25_000.5, 'stopLoss');
    expect(manage).toHaveBeenCalledTimes(1);
    expect(manage).toHaveBeenCalledWith('move-stop', 24_990, 25_000.5);
    expect(h.pending()).toEqual({ kind: 'stopLoss', price: 25_000.5, until: Number.POSITIVE_INFINITY });
    expect(h.busyRef.current).toBe(true);
    gate.resolve(result());
    const outcome = await running;
    expect(outcome).toMatchObject({ called: true, status: 'acknowledged', notice: { tone: 'ok', text: 'Posunuto u leadera; kopírka posune kopie.' } });
    expect(h.pending()).toEqual({ kind: 'stopLoss', price: 25_000.5, until: NOW + LIVE_MANAGE_PENDING_HOLD_MS });
    expect(h.busyRef.current).toBe(false);
    expect(h.busy).toEqual([true, false]);
  });

  it('neměnný group hash projde jako čtvrtý argument právě jedním manage voláním', async () => {
    const manage = vi.fn<LiveManageCallback>(async () => result());
    const h = harness(manage);
    await h.run('move-stop', 24_990, 24_995, 'stopLoss', 'immutablegroup123');
    expect(manage).toHaveBeenCalledExactlyOnceWith('move-stop', 24_990, 24_995, 'immutablegroup123');
  });

  it('druhý příkaz během běžícího se NEODEŠLE (sdílený zámek)', async () => {
    const gate = deferred<LeaderOrderManageResult>();
    const manage = vi.fn<LiveManageCallback>(() => gate.promise);
    const h = harness(manage);
    const first = h.run('move-stop', 24_990, 25_000, 'stopLoss');
    const second = await h.run('move-target', 25_020, 25_030, 'takeProfit');
    expect(manage).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ called: false, status: 'not-sent', notice: { tone: 'warn', text: expect.stringMatching(/nic se neodeslalo/) } });
    gate.resolve(result());
    await first;
    // Zámek je sdílený ref: jiný spouštěč (čára grafu) se stejným refem je taky zastavený.
    const other = createLiveManageRun({ manage: () => manage, busyRef: { current: true }, setPendingMove: () => {}, report: () => {} });
    expect(await other('move-stop', 24_990, 24_985)).toMatchObject({ called: false, status: 'not-sent' });
    expect(manage).toHaveBeenCalledTimes(1);
  });

  it('chybí „co jsem viděl“ nebo cesta = nic se nevolá, nikdy tiché nic', async () => {
    const manage = vi.fn<LiveManageCallback>(async () => result());
    const h = harness(manage);
    for (const expectPrice of [null, undefined, Number.NaN]) {
      expect(await h.run('move-stop', expectPrice, 25_000, 'stopLoss')).toMatchObject({ called: false, status: 'not-sent', notice: { tone: 'bad' } });
    }
    expect(manage).not.toHaveBeenCalled();
    expect(h.pendingHistory).toEqual([]);
    const none = harness(null);
    expect(await none.run('move-stop', 24_990, 25_000, 'stopLoss')).toMatchObject({ called: false, status: 'not-sent', notice: { tone: 'bad' } });
    expect(none.busyRef.current).toBe(false);
  });

  it('neznámý výsledek: jen jedno volání, „odesílám“ pryč, nic se neopakuje', async () => {
    const manage = vi.fn<LiveManageCallback>(async () => result({ status: 'unknown' }));
    const h = harness(manage);
    const outcome = await h.run('move-stop', 24_990, 25_000, 'stopLoss');
    expect(manage).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ called: true, status: 'unknown', notice: { tone: 'warn', text: expect.stringMatching(/Výsledek neznámý/) } });
    expect(h.pending()).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(manage).toHaveBeenCalledTimes(1);
  });

  it('výjimka: po odeslání = neznámý výsledek (nikdy úspěch), prokazatelně neodeslané = „Neodesláno“; bez opakování', async () => {
    const thrown = vi.fn<LiveManageCallback>(async () => { throw new Error('relay timeout'); });
    const h = harness(thrown);
    expect(await h.run('move-stop', 24_990, 25_000, 'stopLoss')).toMatchObject({ called: true, status: 'unknown', notice: { tone: 'warn', text: expect.stringMatching(/^Výsledek neznámý \(relay timeout\)/) } });
    expect(thrown).toHaveBeenCalledTimes(1);
    expect(h.pending()).toBeNull();
    expect(h.busyRef.current).toBe(false);
    const notSent = harness(async () => { throw new LiveCommandNotSentError('Stav kopírky není čerstvě ověřený nebo chybí spravovatelný obchod — nic se neodeslalo.'); });
    expect(await notSent.run('move-stop', 24_990, 25_000, 'stopLoss')).toMatchObject({ called: true, status: 'not-sent', notice: { tone: 'bad', text: expect.stringMatching(/^Neodesláno: /) } });
  });

  it('blokace / odmítnutí: „odesílám“ pryč, text s důvodem', async () => {
    const blocked = harness(async () => result({ status: 'blocked', blockers: [{ code: 'tighten-too-close', text: 'Nový SL je blíž než 8 ticků od trhu.' }] }));
    expect(await blocked.run('move-stop', 24_990, 25_008.25, 'stopLoss')).toMatchObject({ status: 'blocked', notice: { tone: 'bad', text: 'Neodesláno: Nový SL je blíž než 8 ticků od trhu.' } });
    expect(blocked.pending()).toBeNull();
    const rejected = harness(async () => result({ status: 'rejected', reason: 'InvalidPrice' }));
    expect(await rejected.run('move-stop', 24_990, 25_011, 'stopLoss')).toMatchObject({ status: 'rejected', notice: { tone: 'bad', text: 'InvalidPrice' } });
  });
});

describe('texty výsledků (shodné s dosavadním PC runLiveManage)', () => {
  const ack = (action: LeaderOrderManageAction, reason?: string) => liveManageResultNotice(action, result({ action, ...(reason ? { reason } : {}) }), NOW);
  it('potvrzeno podle akce; varování z workeru má přednost', () => {
    expect(ack('cancel-entry').text).toBe('Vstup zrušen; kopírka zruší kopie.');
    expect(ack('close-position').text).toBe('Leader zavřen; kopírka zavírá kopie.');
    expect(ack('move-target').text).toBe('Posunuto u leadera; kopírka posune kopie.');
    expect(ack('move-stop', 'Noha se mezitím vyplnila — vyplnil se SL.')).toMatchObject({ tone: 'warn', text: 'Noha se mezitím vyplnila — vyplnil se SL.' });
  });
  it('mapování prokazatelně neodeslaných chyb — podle kódu relay odmítnutí / typu chyby, ne textu', () => {
    const relay = (code: string, status = 409) => withLiveRelayPhase(new TradovateRequestError(code, status, null, code), 'submit');
    expect(liveManageErrorNotice(relay('copier-relay-entry-busy'), NOW)).toMatchObject({ tone: 'bad', text: 'Neodesláno: jiná změna se právě zpracovává' });
    expect(liveManageErrorNotice(relay('copier-relay-entry-superseded'), NOW).text).toBe('Neodesláno: mezitím přišlo vypnutí kopírky (brzda)');
    expect(liveManageErrorNotice(relay('copier-relay-entry-not-admitted: expired'), NOW).text).toBe('Neodesláno: server změnu nepřijal');
    expect(liveManageErrorNotice(new LiveCommandNotSentError('Stav není čerstvý — nic se neodeslalo.'), NOW).text).toBe('Neodesláno: Stav není čerstvý — nic se neodeslalo.');
    expect(liveManageErrorNotice('x', NOW)).toMatchObject({ tone: 'warn', text: expect.stringMatching(/Výsledek neznámý \(chyba\)/) });
    // Samotný text už „neodesláno“ nevyrobí: obyčejná chyba se stejnými slovy = neznámý výsledek.
    for (const text of ['entry-busy', 'copier-relay-entry-busy', 'Stav kopírky není čerstvě ověřený — nic se neodeslalo.']) {
      expect(liveManageErrorNotice(new Error(text), NOW).tone).toBe('warn');
    }
    // Kód s jiným HTTP stavem (např. 500 po zařazení) ani neznámý kód 409 (idempotence) neodeslané nejsou.
    expect(liveManageErrorNotice(relay('copier-relay-entry-busy', 500), NOW).tone).toBe('warn');
    expect(liveManageErrorNotice(relay('copier-relay-idempotency-conflict'), NOW).tone).toBe('warn');
  });
});

describe('dvoukrokové potvrzení (350 ms – 4 s, klíč s akcí a cenou)', () => {
  it('první klik se ptá, druhý stejný klíč za ≥ 350 ms odešle', () => {
    const first = liveManageConfirmStep(null, 'be:move-stop:24990:25000', NOW);
    expect(first).toEqual({ fire: false, next: { key: 'be:move-stop:24990:25000', since: NOW, until: NOW + LIVE_MANAGE_CONFIRM_MS } });
    expect(liveManageConfirmStep(first.next, 'be:move-stop:24990:25000', NOW + LIVE_MANAGE_CONFIRM_MIN_MS)).toEqual({ fire: true, next: null });
  });

  it('dvojklik (< 350 ms) neodešle a kotvu posune; trojklik nepotvrdí', () => {
    const first = liveManageConfirmStep(null, 'k', NOW).next;
    const quick = liveManageConfirmStep(first, 'k', NOW + LIVE_MANAGE_CONFIRM_MIN_MS - 1);
    expect(quick).toEqual({ fire: false, tooSoon: true, next: { key: 'k', since: NOW + 349, until: NOW + 349 + LIVE_MANAGE_CONFIRM_MS } });
    // 0 / 200 / 360 ms: třetí klik je jen 160 ms po druhém → nic.
    const a = liveManageConfirmStep(null, 'k', NOW).next;
    const b = liveManageConfirmStep(a, 'k', NOW + 200);
    const c = liveManageConfirmStep(b.next, 'k', NOW + 360);
    expect(c.fire).toBe(false);
    expect(liveManageConfirmStep(c.next, 'k', NOW + 710).fire).toBe(true);
  });

  it('po 4 s nebo s jiným klíčem (jiná cena / SL se mezitím změnil) se ptá znovu', () => {
    const first = liveManageConfirmStep(null, 'be-plus:move-stop:24990:25000.5', NOW).next;
    const late = liveManageConfirmStep(first, 'be-plus:move-stop:24990:25000.5', NOW + LIVE_MANAGE_CONFIRM_MS);
    expect(late.fire).toBe(false);
    expect(late.next).toMatchObject({ since: NOW + LIVE_MANAGE_CONFIRM_MS });
    const changed = liveManageConfirmStep(first, 'be-plus:move-stop:24989:25000.5', NOW + 1_000);
    expect(changed).toEqual({ fire: false, next: { key: 'be-plus:move-stop:24989:25000.5', since: NOW + 1_000, until: NOW + 1_000 + LIVE_MANAGE_CONFIRM_MS } });
  });
});

describe('hook se vykreslí bez odeslání', () => {
  it('výchozí stav: nic neběží, žádný výsledek ani potvrzení; render nic nevolá', () => {
    const manage = vi.fn<LiveManageCallback>(async () => result());
    let seen: ReturnType<typeof useLiveManageRunner> | null = null;
    const Probe = () => { seen = useLiveManageRunner({ manage, landed: { stopLoss: 24_990, takeProfit: 25_020 } }); return null; };
    renderToStaticMarkup(React.createElement(Probe));
    expect(seen).toMatchObject({ busy: false, result: null, pendingMove: null });
    expect(manage).not.toHaveBeenCalled();
  });
});

describe('jeden klik = jeden příkaz (Filip 5. 11. 2026, bez „Opravdu?“)', () => {
  const intent = { id: 'be', action: 'move-stop', leg: 'stopLoss', expectPrice: 24_990, newPrice: 25_000, direction: 'tighten', label: 'SL na BE 25000.00', confirmKey: 'be:move-stop:24990:25000' } as const;
  const runner = (manage: LiveManageCallback) => {
    let seen: ReturnType<typeof useLiveManageRunner> | null = null;
    const Probe = () => { seen = useLiveManageRunner({ manage }); return null; };
    renderToStaticMarkup(React.createElement(Probe));
    return seen!;
  };
  it('první klik odešle, dvojklik nepošle druhý příkaz', async () => {
    const manage = vi.fn<LiveManageCallback>(async () => result());
    const run = runner(manage);
    const first = run.request(intent);
    expect(first.step).toBe('sent');
    expect(run.request(intent)).toEqual({ step: 'repeat' });
    if (first.step === 'sent') await first.outcome;
    expect(manage).toHaveBeenCalledTimes(1);
    expect(manage).toHaveBeenCalledWith('move-stop', 24_990, 25_000);
  });
  it('jiná cena je jiný příkaz, ale běžící příkaz ho sdíleným zámkem nepustí', async () => {
    let finish!: (value: ReturnType<typeof result>) => void;
    const manage = vi.fn<LiveManageCallback>(() => new Promise(done => { finish = done; }));
    const run = runner(manage);
    const first = run.request(intent);
    const second = run.request({ ...intent, newPrice: 25_001, confirmKey: 'be:move-stop:24990:25001' });
    expect(second.step).toBe('sent');
    if (second.step === 'sent') expect((await second.outcome).called).toBe(false);
    expect(manage).toHaveBeenCalledTimes(1);
    finish(result());
    if (first.step === 'sent') await first.outcome;
  });
});

describe('statika: runner posílá jen přes předaný onManageEntry (INV-UI-01)', () => {
  const source = readFileSync('hooks/useLiveManageRunner.ts', 'utf8');
  it('žádný relay, fetch ani služby; jediný send je solo/group varianta předaného manage', () => {
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]).sort();
    expect(imports).toEqual(['../lib/groupLimitUiNotice', '../lib/leaderOrderManage', '../lib/liveClickGate', '../lib/liveCommandErrors', '../lib/liveManagePrices', 'react', 'react']);
    expect(source).toMatch(/import type \{[^}]+\} from '\.\.\/lib\/leaderOrderManage'/);
    expect(source).toMatch(/import type \{[^}]+\} from '\.\.\/lib\/liveManagePrices'/);
    expect(source).not.toMatch(/fetch\(|executeTradovate|services\/|buildLeaderOrderManageCommand|crypto\./);
    expect(source.match(/await manage\(/g)).toEqual(['await manage(', 'await manage(']);
    expect(source).toMatch(/seenGroupLimitStateHash \? await manage\(action, expectPrice, newPrice, seenGroupLimitStateHash\) : await manage\(action, expectPrice, newPrice\)/);
    const formatter = readFileSync('lib/groupLimitUiNotice.ts', 'utf8');
    expect([...formatter.matchAll(/from '([^']+)'/g)].map(match => match[1])).toEqual(['./leaderOrderManage']);
    expect(formatter).toMatch(/import type \{[^}]+\} from '\.\/leaderOrderManage'/);
    expect(formatter).not.toMatch(/fetch\(|executeTradovate|services\/|buildLeaderOrderManageCommand|crypto\./);
    expect(source).toMatch(/await manage\(action, expectPrice, newPrice\)/);
  });
  it('žádné opakování: volání není ve smyčce ani v catch', () => {
    const body = source.slice(source.indexOf('export function createLiveManageRun'), source.indexOf('export function liveManageConfirmStep'));
    expect(body).not.toMatch(/\bwhile\b|\bfor\s*\(|retry|setTimeout/);
    const catchBlock = body.slice(body.indexOf('} catch'), body.indexOf('} finally'));
    expect(catchBlock).not.toMatch(/manage\(/);
  });
});
