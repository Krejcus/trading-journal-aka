import { appendFile, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Diagnostický záznam notifikací příkazů od Rithmicu (JSON řádky, soubor na den, jen pro majitele Macu).
 * Nic neřídí: zápis je asynchronní, v pořadí volání, a chyba zápisu se jen jednou vypíše.
 * Důvod (19. 11. 2026): `fill-missing` na Lucidu nešlo doložit — surový výpis zmizel s terminálem.
 */
export interface OrderJournal {
  write(kind: string, payload: unknown): void;
  /** Soubor pro dnešní den (pro výpis při startu). */
  file(): string;
}

const KEEP_DAYS = 14;

const day = (at: number): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** JSON bez pádu na bigint / cyklech (raw pole z protobufu). */
export function journalLine(at: number, kind: string, payload: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify({ at, iso: new Date(at).toISOString(), kind, payload }, (_key, value: unknown) => {
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[cyklus]';
      seen.add(value);
    }
    return value;
  }) + '\n';
}

export function createOrderJournal(dir: string, slug: string, now: () => number = Date.now): OrderJournal {
  const prefix = `orders-${slug}-`;
  const pathFor = (at: number) => join(dir, `${prefix}${day(at)}.jsonl`);
  // Starší záznamy než 14 dní pryč (disk sdílí i worker a zálohy).
  try {
    const cutoff = day(now() - KEEP_DAYS * 86_400_000);
    for (const name of readdirSync(dir)) {
      const date = name.startsWith(prefix) && name.endsWith('.jsonl') ? name.slice(prefix.length, -'.jsonl'.length) : '';
      // Jen vlastní soubory: za předponou přesně datum (jiný systém se stejným začátkem názvu se nesmaže).
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date < cutoff) rmSync(join(dir, name), { force: true });
    }
  } catch { /* úklid není podmínkou */ }
  let chain: Promise<void> = Promise.resolve();
  let warned = false;
  return {
    file: () => pathFor(now()),
    write(kind, payload) {
      let line: string;
      const at = now();
      try { line = journalLine(at, kind, payload); } catch { return; }
      const path = pathFor(at);
      const warn = (error: unknown) => {
        if (!warned) { warned = true; console.error(`[záznam] Notifikace příkazů nejde zapisovat (${error instanceof Error ? error.message : String(error)}; ${path}).`); }
      };
      chain = chain.then(() => new Promise<void>((resolve) => {
        try {
          appendFile(path, line, { mode: 0o600 }, (error) => { if (error) warn(error); resolve(); });
        } catch (error) { warn(error); resolve(); }
      })).catch(() => undefined);
    },
  };
}
