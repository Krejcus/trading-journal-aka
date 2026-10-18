import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { dayJournalForMcp, dayJournalLines, notePhase, type DayJournalMcpRow } from '../supabase/functions/mcp-server/dayJournal';

const DAY = '2026-10-13';
const PIN = '3f2a8c1e-4b5d-4e6f-8a7b-9c0d1e2f3a4b';
// Praha = UTC+2 v říjnu před změnou času.
const rows: DayJournalMcpRow[] = [
  { day: DAY, session: 'london', kind: 'prep', entry_key: 'prep:london', written_at: '2026-10-13T05:55:00Z', data: { bias: 'long', scenario: 'Sweep Asia low, long z FVG.', rules: ['2 ztráty v řadě'], durationSec: 52 } },
  { day: DAY, session: 'london', kind: 'note', entry_key: `note:${PIN}`, written_at: '2026-10-13T05:53:00Z', data: { text: 'Tady čekám reakci ve FVG.', time: Date.parse('2026-10-13T08:00:00Z') / 1000, price: 31388.25, voice: true, origin: 'prep' } },
  { day: DAY, session: 'london', kind: 'note', entry_key: 'note:11111111-2222-4333-8444-555555555555', written_at: '2026-10-13T09:47:00Z', data: { text: 'Nudím se.', voice: true, origin: 'chart', time: Date.parse('2026-10-13T09:46:00Z') / 1000, price: 31470 } },
  { day: DAY, session: 'london', kind: 'note', entry_key: 'note:21111111-2222-4333-8444-555555555555', written_at: '2026-10-14T06:10:00Z', data: { text: 'Zpětně: stop moc těsně.', origin: 'feed' } },
  { day: DAY, session: 'london', kind: 'close', entry_key: 'close:london', written_at: '2026-10-13T11:10:00Z', data: { summary: 'Ráno čisté. Po TP odejít.', execution: 'partial', verdicts: { [PIN]: 'ok', unknown: 'bad' } } },
];

describe('MCP deník dne', () => {
  it('derives the phase from when the note was written (Prague session windows)', () => {
    expect(notePhase(DAY, 'london', '2026-10-13T05:53:00Z')).toBe('příprava');
    expect(notePhase(DAY, 'london', '2026-10-13T09:47:00Z')).toBe('živě');
    expect(notePhase(DAY, 'london', '2026-10-14T06:10:00Z')).toBe('dopsáno zpětně');
  });

  it('returns sessions with prep, close and plan-vs-reality, and notes with written time', () => {
    const view = dayJournalForMcp(rows, DAY)!;
    expect(view.sessions).toHaveLength(1);
    expect(view.sessions[0]).toMatchObject({
      session: 'London',
      priprava: { zapsano: '07:55', bias: 'Long', neobchoduju_pokud: ['2 ztráty v řadě'], trvala_s: 52 },
      uzavreni: { zapsano: '13:10', exekuce: 'částečně', plan_vs_realita: [{ plan: 'Tady čekám reakci ve FVG.', verdikt: 'vyšlo' }] },
    });
    expect(view.poznamky.map(note => [note.zapsano, note.faze, note.ukazuje_na])).toEqual([
      ['07:53', 'příprava', '10:00 @ 31388.25'],
      ['11:47', 'živě', '11:46 @ 31470'],
      ['08:10', 'dopsáno zpětně', null],
    ]);
    expect(view.poznamky[2].zapsano_den).toBe('2026-10-14');
    expect(dayJournalForMcp(rows, '2026-10-12')).toBeNull();
  });

  it('labels Hlava as a personal note with areas and keeps the week plan apart', () => {
    const extra: DayJournalMcpRow[] = [
      ...rows,
      { day: DAY, session: 'day', kind: 'note', entry_key: 'note:31111111-2222-4333-8444-555555555555', written_at: '2026-10-13T13:58:00Z', data: { text: 'Doma napětí.', origin: 'mind', areas: ['rodina'] } },
      { day: DAY, session: 'day', kind: 'note', entry_key: 'note:41111111-2222-4333-8444-555555555555', written_at: '2026-10-13T14:00:00Z', data: { text: 'Jen NY.', origin: 'week' } },
    ];
    const view = dayJournalForMcp(extra, DAY)!;
    expect(view.poznamky.find(note => note.text === 'Doma napětí.')).toMatchObject({ hlava_osobni: true, oblasti: ['rodina'] });
    const lines = dayJournalLines(extra, DAY);
    expect(lines).toContain('   · HLAVA (osobní) zapsáno 15:58 [rodina]: Doma napětí.');
    expect(lines).toContain('   · plán na další týden (zapsáno 16:00): Jen NY.');
  });

  it('renders compact load_journal lines only for the window', () => {
    const lines = dayJournalLines(rows, DAY);
    expect(lines[0]).toBe(`${DAY}:`);
    expect(lines[1]).toContain('London: příprava 07:55 · bias Long');
    expect(lines[1]).toContain('uzavřeno 13:10 · exekuce částečně');
    expect(lines.some(line => line.includes('[dopsáno zpětně]'))).toBe(true);
    expect(dayJournalLines(rows, '2026-10-14')).toEqual([]);
  });
});

describe('MCP mapTrade', () => {
  const source = readFileSync(new URL('../supabase/functions/mcp-server/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function mapTrade(');
  const end = source.indexOf('\n}\n', start) + 3;
  const mapTrade = new Function(`${ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 })}; return mapTrade;`)() as (row: unknown) => { isValid?: boolean };

  it('does not mark trades without an isValid flag as invalid', () => {
    expect(mapTrade({ id: 't', data: {} }).isValid).toBeUndefined();
    expect(mapTrade({ id: 't', data: { isValid: false } }).isValid).toBe(false);
    expect(mapTrade({ id: 't', data: { isValid: true } }).isValid).toBe(true);
  });
});

describe('MCP session clocks and edits', () => {
  it('uses the user session times and labels later edits', async () => {
    const { sessionClocksFrom } = await import('../supabase/functions/mcp-server/dayJournal');
    const clocks = sessionClocksFrom({ sessions: [{ id: 'london', startTime: '08:00', endTime: '12:00' }, { id: 'ny', startTime: 'nope', endTime: '22:00' }] });
    expect(clocks.london).toEqual(['08:00', '12:00']);
    expect(clocks.ny).toEqual(['15:30', '22:00']);
    // 13:30 Praha je po konci uživatelského Londýna (12:00) → zpětně.
    expect(notePhase(DAY, 'london', '2026-10-13T11:30:00Z', clocks)).toBe('dopsáno zpětně');
    const edited = dayJournalForMcp([{ ...rows[2], updated_at: '2026-10-13T18:00:00Z' }], DAY)!;
    expect(edited.poznamky[0].upraveno).toBe('20:00');
    expect(dayJournalLines([{ ...rows[2], updated_at: '2026-10-13T18:00:00Z' }], DAY)[1]).toContain('upraveno 20:00');
  });
});
