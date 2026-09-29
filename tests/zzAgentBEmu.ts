/* In-memory PostgREST/RPC emulator for tradovate_copier_* tables (review PoC only). */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, any>;

const cmp = (a: unknown, b: unknown): number => {
  if (typeof a === 'string' && typeof b === 'string' && /\d{4}-\d{2}-\d{2}T/.test(a) && /\d{4}-\d{2}-\d{2}T/.test(b)) {
    return Date.parse(a) - Date.parse(b);
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

const splitTop = (expr: string): string[] => {
  const out: string[] = []; let depth = 0; let cur = '';
  for (const ch of expr) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
};

const termPredicate = (term: string): ((r: Row) => boolean) => {
  if (term.startsWith('and(')) {
    const parts = splitTop(term.slice(4, -1)).map(termPredicate);
    return r => parts.every(p => p(r));
  }
  const [col, op, ...rest] = term.split('.');
  const value = rest.join('.');
  return r => {
    const c = cmp(r[col], value);
    if (op === 'eq') return String(r[col]) === value;
    if (op === 'gt') return c > 0;
    if (op === 'gte') return c >= 0;
    if (op === 'lt') return c < 0;
    if (op === 'lte') return c <= 0;
    throw new Error(`unsupported op ${op}`);
  };
};

const containsDeep = (hay: unknown, needle: unknown): boolean => {
  if (needle === null || typeof needle !== 'object') return hay === needle;
  if (!hay || typeof hay !== 'object') return false;
  return Object.entries(needle as Record<string, unknown>).every(([k, v]) => containsDeep((hay as Record<string, unknown>)[k], v));
};

export function createEmu(clock: () => number = Date.now) {
  const tables: Record<string, Row[]> = {
    tradovate_copier_commands: [],
    tradovate_copier_devices: [],
    tradovate_copier_device_runtime: [],
  };
  const nowIso = () => new Date(clock()).toISOString();

  const query = (table: string, mode: 'select' | 'update', patch?: Row) => {
    const filters: Array<(r: Row) => boolean> = [];
    const orders: Array<[string, boolean]> = [];
    let lim = Infinity;
    const q: any = {
      eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return q; },
      is: (c: string, v: unknown) => { filters.push(r => (r[c] ?? null) === v); return q; },
      in: (c: string, vs: unknown[]) => { filters.push(r => vs.includes(r[c])); return q; },
      lte: (c: string, v: unknown) => { filters.push(r => cmp(r[c], v) <= 0); return q; },
      gt: (c: string, v: unknown) => { filters.push(r => cmp(r[c], v) > 0); return q; },
      gte: (c: string, v: unknown) => { filters.push(r => cmp(r[c], v) >= 0); return q; },
      or: (expr: string) => { const ps = splitTop(expr).map(termPredicate); filters.push(r => ps.some(p => p(r))); return q; },
      contains: (c: string, v: unknown) => { filters.push(r => containsDeep(r[c], v)); return q; },
      order: (c: string, o: { ascending?: boolean } = {}) => { orders.push([c, o.ascending !== false]); return q; },
      limit: (n: number) => { lim = n; return q; },
      select: () => q,
      run: () => {
        let rows = tables[table].filter(r => filters.every(f => f(r)));
        rows = [...rows].sort((a, b) => {
          for (const [c, asc] of orders) { const d = cmp(a[c], b[c]); if (d !== 0) return asc ? d : -d; }
          return 0;
        }).slice(0, lim);
        if (mode === 'update') for (const r of rows) Object.assign(r, patch);
        return rows;
      },
      maybeSingle: async () => {
        const rows = q.run();
        return { data: rows[0] ? structuredClone(rows[0]) : null, error: null };
      },
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        try { resolve({ data: structuredClone(q.run()), error: null }); } catch (e) { reject(e); }
      },
    };
    return q;
  };

  const db = {
    from: (table: string) => ({
      select: () => query(table, 'select'),
      update: (patch: Row) => query(table, 'update', patch),
      upsert: (row: Row, _opts: unknown) => {
        const out: any = {
          select: () => out,
          maybeSingle: async () => {
            const dup = tables[table].find(r => r.user_id === row.user_id && r.device_id === row.device_id
              && r.idempotency_key === row.idempotency_key);
            if (dup) return { data: null, error: null };
            const inserted = { id: randomUUID(), delivery_id: null, result: null, error: null, claimed_at: null,
              completed_at: null, ...structuredClone(row) };
            tables[table].push(inserted);
            return { data: structuredClone(inserted), error: null };
          },
        };
        return out;
      },
    }),
    rpc: async (name: string, args: Record<string, any>) => {
      const cmds = tables.tradovate_copier_commands;
      if (name === 'claim_tradovate_copier_command_v2') {
        const own = cmds.filter(r => r.device_id === args.target_device_id && r.delivery_id === args.target_delivery_id);
        if (own.length) return { data: structuredClone(own), error: null };
        for (const r of cmds) {
          if (r.device_id === args.target_device_id && r.status === 'pending' && cmp(r.expires_at, nowIso()) <= 0) {
            Object.assign(r, { status: 'expired', completed_at: nowIso(), error: 'command-expired' });
          }
        }
        const candidate = cmds.filter(r => r.device_id === args.target_device_id && r.status === 'pending'
          && cmp(r.expires_at, nowIso()) > 0)
          .sort((a, b) => cmp(a.created_at, b.created_at) || cmp(a.id, b.id))[0];
        if (!candidate) return { data: [], error: null };
        Object.assign(candidate, { status: 'claimed', claimed_at: nowIso(), delivery_id: args.target_delivery_id });
        return { data: [structuredClone(candidate)], error: null };
      }
      if (name === 'complete_tradovate_copier_command_v2') {
        const cmd = cmds.find(r => r.id === args.target_command_id && r.device_id === args.target_device_id
          && r.delivery_id === args.target_delivery_id);
        if (!cmd) return { data: false, error: null };
        const terminal = args.command_error == null ? 'succeeded' : 'rejected';
        if (cmd.status === 'succeeded' || cmd.status === 'rejected') {
          return { data: cmd.status === terminal && JSON.stringify(cmd.result) === JSON.stringify(args.command_result)
            && (cmd.error ?? null) === (args.command_error ?? null), error: null };
        }
        if (cmd.status !== 'claimed') return { data: false, error: null };
        Object.assign(cmd, { status: terminal, result: args.command_result, error: args.command_error, completed_at: nowIso() });
        return { data: true, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  } as unknown as SupabaseClient;
  return { db, tables };
}
