import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LIVE_PREVIEW_FRESH_MS, livePreviewAfterReset, livePreviewAge, livePreviewButton, livePreviewErrorText,
  livePreviewKey, livePreviewOrderText, livePreviewRisk, livePreviewShown, livePreviewView,
} from '../lib/livePreviewView';
import type { LeaderEntryPreviewOrder, LeaderEntryPreviewResult, LiveEntryPreviewDraft } from '../lib/leaderEntryPreview';

const NOW = Date.UTC(2026, 10, 3, 15);
const limitDraft: LiveEntryPreviewDraft = { symbol: 'MNQZ6', side: 'Buy', quantity: 2, orderType: 'Limit', price: 24_980, stopLoss: 24_968, takeProfit: 25_004 };
const leader = (over: Partial<LeaderEntryPreviewOrder> = {}): LeaderEntryPreviewOrder => ({
  accountId: 1, side: 'Buy', quantity: 2, orderType: 'Limit', price: 24_980, stopLoss: 24_968, takeProfit: 25_004, ...over,
});
const result = (over: Partial<LeaderEntryPreviewResult> = {}): LeaderEntryPreviewResult => ({
  type: 'leader-entry-preview', operationId: 'preview:abcdefgh1', checkedAt: NOW, symbol: 'MNQZ6',
  wouldPlace: { leader: leader(), followers: [] }, blockers: [], notes: [], ...over,
});
const view = (over: Partial<Parameters<typeof livePreviewView>[0]> = {}) => livePreviewView({
  result: result(), receivedAt: NOW, now: NOW + 2_000, blockedReason: null, placeSupported: true, operationId: 'entry:abc', pointValue: 2, ...over,
});

describe('klíč výsledku a resetKey', () => {
  it('klíč = stav kopírky + celý návrh; bez návrhu prázdný', () => {
    expect(livePreviewKey('true', limitDraft)).toBe(`true|${JSON.stringify(limitDraft)}`);
    expect(livePreviewKey('true', null)).toBe('');
    expect(livePreviewKey('false', limitDraft)).not.toBe(livePreviewKey('true', limitDraft));
    expect(livePreviewKey('true', { ...limitDraft, price: 24_980.25 })).not.toBe(livePreviewKey('true', limitDraft));
  });

  it('výsledek se ukáže jen pro přesně tentýž návrh a stav', () => {
    const key = livePreviewKey('true', limitDraft);
    const snapshot = { key, receivedAt: NOW, result: result() };
    expect(livePreviewShown(snapshot, key)).toBe(snapshot);
    expect(livePreviewShown(snapshot, livePreviewKey('true', { ...limitDraft, quantity: 1 }))).toBeNull();
    expect(livePreviewShown(snapshot, livePreviewKey('false', limitDraft))).toBeNull();
    expect(livePreviewShown({ ...snapshot, key: '' }, '')).toBeNull();
    expect(livePreviewShown(null, key)).toBeNull();
  });

  it('OFF→ON do 15 s: starý výsledek se NEvrátí jako čerstvý (mutace: jen skrýt → červená)', () => {
    const on = livePreviewKey('true', limitDraft);
    let snapshot = livePreviewAfterReset({ key: on, receivedAt: NOW, result: result() }, 'true', 'true');
    expect(snapshot).not.toBeNull();
    snapshot = livePreviewAfterReset(snapshot, 'true', 'false');
    snapshot = livePreviewAfterReset(snapshot, 'false', 'true');
    expect(livePreviewShown(snapshot, on)).toBeNull();
  });
});

describe('stáří a hranice 15 s', () => {
  it('15 000 ms ještě platí, 15 001 ms zastaralo (mutace hranice → červená)', () => {
    expect(LIVE_PREVIEW_FRESH_MS).toBe(15_000);
    expect(livePreviewAge(NOW, NOW + 15_000)).toEqual({ seconds: 15, stale: false });
    expect(livePreviewAge(NOW, NOW + 15_001)).toEqual({ seconds: 15, stale: true });
    expect(livePreviewAge(NOW, NOW + 1_499)).toEqual({ seconds: 1, stale: false });
    expect(livePreviewAge(NOW, NOW - 3_000)).toEqual({ seconds: 0, stale: false });
  });

  it('zastaralý výsledek zešedne a Odeslat nejde', () => {
    const stale = view({ now: NOW + 15_001 });
    expect(stale.stale).toBe(true);
    expect(stale.ageText).toBe('zastaralé · před 15 s');
    expect(stale.canSend).toBe(false);
    expect(stale.sendHint).toBe('Náhled zastaral (víc než 15 s) — zkontroluj znovu, pak hned Odeslat.');
    expect(view().ageText).toBe('před 2 s');
  });
});

describe('texty výsledku', () => {
  it('Limit: leader, followeři, „Worker by poslal“, hlavička „nic se neodeslalo“', () => {
    const v = view({ result: result({ wouldPlace: { leader: leader(), followers: [leader({ accountId: 7, quantity: 4 })] } }) });
    expect(v.header).toBe('Náhled · nic se neodeslalo');
    expect(v.tone).toBe('would-place');
    expect(v.headline).toBe('Worker by poslal (MNQZ6):');
    expect(v.leaderLine).toBe('Leader: BUY LMT 2 @ 24 980.00 · SL 24 968.00 · TP 25 004.00');
    expect(v.followerLines).toEqual(['Follower 7: 4 ks']);
  });

  it('Market s „~“ (cena jen odhad), holý Market „bez SL/TP“', () => {
    expect(livePreviewOrderText(leader({ orderType: 'Market', price: 25_000 }))).toBe('BUY MKT 2 ~25 000.00 · SL 24 968.00 · TP 25 004.00');
    expect(livePreviewOrderText(leader({ side: 'Sell', orderType: 'Market', price: 25_000, stopLoss: null, takeProfit: null }))).toBe('SELL MKT 2 ~25 000.00 · bez SL/TP');
    expect(livePreviewOrderText(leader({ orderType: 'Stop' }))).toMatch(/^BUY STP 2 @ /);
  });

  it('blokace: nic by neposlal, blokery i poznámky jako text', () => {
    const v = view({ result: result({ wouldPlace: null, blockers: [{ code: 'account-not-flat', text: 'Leader není flat.' }], notes: [{ code: 'n', text: 'Follower 7 nedostane kopii.' }] }) });
    expect(v.tone).toBe('blocked');
    expect(v.headline).toBe('Worker by teď nic neposlal:');
    expect(v.leaderLine).toBeNull();
    expect(v.risk).toBeNull();
    expect(v.blockers).toEqual(['Leader není flat.']);
    expect(v.notes).toEqual(['Follower 7 nedostane kopii.']);
    expect(v.canSend).toBe(false);
    expect(v.sendHint).toBeNull();
  });

  it('nikdy netvrdí „připraveno“ (mutace textu → červená)', () => {
    const variants = [
      view(), view({ now: NOW + 20_000 }), view({ placeSupported: false }), view({ blockedReason: 'Kopírka je vypnutá.' }),
      view({ result: result({ wouldPlace: null, blockers: [{ code: 'x', text: 'Blok.' }] }) }),
      view({ result: result({ wouldPlace: { leader: leader({ orderType: 'Market', stopLoss: null, takeProfit: null }), followers: [] } }) }),
    ];
    for (const v of variants) expect(JSON.stringify(v)).not.toMatch(/připraven|ready/i);
    expect(JSON.stringify(livePreviewButton({ hasDraft: true, blockedReason: null, busy: false }))).not.toMatch(/připraven/i);
  });

  it('chyba náhledu: preview-busy = „zkus za 3 s“, jinak text beze změny', () => {
    expect(livePreviewErrorText('copier-relay-preview-busy')).toBe('Náhled už běží, zkus to za 3 s.');
    expect(livePreviewErrorText('Stav kopírky není čerstvě ověřený — náhled teď nejde.')).toBe('Stav kopírky není čerstvě ověřený — náhled teď nejde.');
  });
});

describe('riziko v $ z výsledku workeru', () => {
  it('Limit: vzdálenost vstup–SL × kontrakty × $ za bod (MNQ 2)', () => {
    const risk = livePreviewRisk({ leader: leader(), followers: [] }, 2);
    expect(risk).toEqual({ usd: -48, estimate: false, unbounded: false, text: 'Ztráta při SL −$48.00' });
  });

  it('short: SL nad vstupem dává taky ztrátu', () => {
    expect(livePreviewRisk({ leader: leader({ side: 'Sell', price: 25_000, stopLoss: 25_010 }), followers: [] }, 2).usd).toBe(-40);
  });

  it('leader + followeři se sčítají', () => {
    const risk = livePreviewRisk({ leader: leader(), followers: [leader({ accountId: 7, quantity: 4 })] }, 2);
    expect(risk.usd).toBe(-144);
    expect(risk.text).toBe('Ztráta při SL −$144.00 (leader + followeři)');
  });

  it('Market = jen odhad z ceny grafu (INV-UI-04)', () => {
    const risk = livePreviewRisk({ leader: leader({ orderType: 'Market', price: 25_000, stopLoss: 24_988 }), followers: [] }, 2);
    expect(risk.estimate).toBe(true);
    expect(risk.usd).toBe(-48);
    expect(risk.text).toMatch(/^Ztráta při SL ≈ −\$48\.00 · odhad/);
  });

  it('holý Market: ztráta nemá strop, žádné číslo', () => {
    const risk = livePreviewRisk({ leader: leader({ orderType: 'Market', stopLoss: null, takeProfit: null }), followers: [] }, 2);
    expect(risk).toEqual({ usd: null, estimate: true, unbounded: true, text: 'Bez SL — ztráta nemá strop (jen Flatten).' });
  });

  it('view nese riziko leadera', () => {
    expect(view().risk?.usd).toBe(-48);
  });
});

describe('Odeslat po náhledu (PC) a tlačítko náhledu', () => {
  it('jen čerstvý výsledek bez blokací, bez blokace desku, s id odeslání a s odesláním z náhledu', () => {
    expect(view().canSend).toBe(true);
    expect(view({ blockedReason: 'Kopírka je vypnutá.' })).toMatchObject({ canSend: false, sendHint: 'Kopírka je vypnutá.' });
    expect(view({ operationId: null })).toMatchObject({ canSend: false, sendHint: 'Odeslat teď nejde — zkontroluj znovu.' });
    expect(view({ result: result({ blockers: [{ code: 'x', text: 'Blok.' }] }) })).toMatchObject({ canSend: false, sendHint: 'Odeslat nejde: náhled má blokace.' });
  });

  it('telefon (odesílá zvlášť) z náhledu nikdy neodesílá a nic nenapovídá', () => {
    expect(view({ placeSupported: false })).toMatchObject({ canSend: false, sendHint: null });
  });

  it('tlačítko náhledu: vypnuté bez návrhu, s blokací nebo během ověřování', () => {
    expect(livePreviewButton({ hasDraft: true, blockedReason: null, busy: false })).toEqual({
      label: 'Zkontrolovat u workeru (nic se neodešle)', disabled: false,
      title: 'Worker projde všechna pravidla kopírky a ukáže, co by poslal. Nic se neodešle.',
    });
    expect(livePreviewButton({ hasDraft: false, blockedReason: null, busy: false }).disabled).toBe(true);
    expect(livePreviewButton({ hasDraft: true, blockedReason: 'Cena grafu je zastaralá.', busy: false })).toMatchObject({ disabled: true, title: 'Cena grafu je zastaralá.' });
    expect(livePreviewButton({ hasDraft: true, blockedReason: null, busy: true })).toMatchObject({ disabled: true, label: 'Ověřuji u workeru…' });
  });
});

describe('statická pojistka: zobrazení nic neodesílá', () => {
  const source = readFileSync(new URL('../lib/livePreviewView.ts', import.meta.url), 'utf8');
  it('importuje jen typy a nevolá relay ani síť', () => {
    const imports = [...source.matchAll(/^import (type )?.*from '([^']+)'/gm)].map(match => [Boolean(match[1]), match[2]]);
    expect(imports).toEqual([[true, './leaderEntryPreview']]);
    expect(source).not.toMatch(/fetch\(|executeTradovateCopierRelayCommand|localStorage/);
  });
});
