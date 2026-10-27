import { describe, expect, it } from 'vitest';
import {
  armOlderHistory,
  createOlderHistoryGate,
  markOlderHistoryRequested,
  olderHistoryDue,
  settleOlderHistory,
} from '../lib/olderHistoryGate';

const FIRST = 1_783_634_400;
const atEdge = (patch: Partial<Parameters<typeof olderHistoryDue>[1]> = {}) => ({
  fromLogical: -101, windowStart: 0, hasLoader: true, loading: false, firstTime: FIRST, ...patch,
});

describe('dotažení starší historie v grafu backtestu', () => {
  it('bez gesta uživatele se nic nestahuje (programový posun záběru)', () => {
    expect(olderHistoryDue(createOlderHistoryGate(), atEdge())).toBe(false);
  });

  it('gesto u levého okraje stačí, i když se záběr nepohnul (klik, kolečko na krajním přiblížení)', () => {
    const gate = createOlderHistoryGate();
    armOlderHistory(gate, FIRST);
    expect(olderHistoryDue(gate, atEdge())).toBe(true);
    expect(olderHistoryDue(gate, atEdge({ fromLogical: 400 }))).toBe(false);
    expect(olderHistoryDue(gate, atEdge({ loading: true }))).toBe(false);
    expect(olderHistoryDue(gate, atEdge({ hasLoader: false }))).toBe(false);
  });

  it('jeden dotaz na gesto; nové gesto během načítání nic nezdvojí', () => {
    const gate = createOlderHistoryGate();
    armOlderHistory(gate, FIRST);
    markOlderHistoryRequested(gate, FIRST);
    expect(olderHistoryDue(gate, atEdge())).toBe(false);
    armOlderHistory(gate, FIRST);
    expect(olderHistoryDue(gate, atEdge())).toBe(false);
  });

  it('po dotažení se smí ptát dál — s novou první svíčkou hned po dalším gestu', () => {
    const gate = createOlderHistoryGate();
    armOlderHistory(gate, FIRST);
    markOlderHistoryRequested(gate, FIRST);
    settleOlderHistory(gate);
    expect(olderHistoryDue(gate, atEdge({ firstTime: FIRST - 86_400 }))).toBe(false);
    armOlderHistory(gate, FIRST - 86_400);
    expect(olderHistoryDue(gate, atEdge({ firstTime: FIRST - 86_400 }))).toBe(true);
  });

  it('dotaz, který první svíčku nezměnil (chyba, kus session ve stejném dni), historii nezablokuje', () => {
    const gate = createOlderHistoryGate();
    armOlderHistory(gate, FIRST);
    markOlderHistoryRequested(gate, FIRST);
    settleOlderHistory(gate);
    armOlderHistory(gate, FIRST);
    expect(olderHistoryDue(gate, atEdge())).toBe(true);
  });
});
