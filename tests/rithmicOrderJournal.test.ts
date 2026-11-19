import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOrderJournal, journalLine } from '../services/rithmic/orderJournal';

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('záznam notifikací příkazů Rithmicu', () => {
  it('JSON řádek snese bigint i cyklus', () => {
    const cyc: Record<string, unknown> = { a: 1n };
    cyc.self = cyc;
    const parsed = JSON.parse(journalLine(0, 'order', cyc));
    expect(parsed.payload.a).toBe('1');
    expect(parsed.payload.self).toBe('[cyklus]');
  });

  it('zapisuje v pořadí do souboru dne jen pro majitele a maže záznamy starší 14 dní', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orderjournal-'));
    writeFileSync(join(dir, 'orders-lucid-2026-10-01.jsonl'), 'old\n');
    writeFileSync(join(dir, 'orders-jiny-2026-10-01.jsonl'), 'keep\n');
    writeFileSync(join(dir, 'orders-lucid-01-2026-10-01.jsonl'), 'keep\n');
    const now = new Date(2026, 10, 19, 15, 0).getTime();
    const journal = createOrderJournal(dir, 'lucid', () => now);
    for (let i = 0; i < 5; i += 1) journal.write('order', { i });
    await settle();
    expect(readdirSync(dir).sort()).toEqual(['orders-jiny-2026-10-01.jsonl', 'orders-lucid-01-2026-10-01.jsonl', 'orders-lucid-2026-11-19.jsonl']);
    const file = journal.file();
    expect(readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line).payload.i)).toEqual([0, 1, 2, 3, 4]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('nezapisovatelná složka: nic nespadne', async () => {
    const journal = createOrderJournal('/neexistuje/nikde', 'lucid');
    expect(() => journal.write('order', { x: 1 })).not.toThrow();
    await settle();
  });
});
