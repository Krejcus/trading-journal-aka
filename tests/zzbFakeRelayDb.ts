// Review-only helper (agentb-kompat). In-memory PostgREST/SQL model of the
// relay tables + v2 RPCs, faithful to supabase/migrations/20260913154140.
import { randomUUID } from 'node:crypto';

type Row = Record<string, any>;
type Filter = (row: Row) => boolean;

const asTime = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const compare = (left: unknown, right: unknown): number => {
  const l = asTime(left); const r = asTime(right);
  if (l != null && r != null) return l - r;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
};
const contains = (value: unknown, pattern: unknown): boolean => {
  if (pattern && typeof pattern === 'object' && !Array.isArray(pattern)) {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(pattern as Row).every(([key, entry]) => contains((value as Row)[key], entry));
  }
  return value === pattern;
};
const splitTop = (expr: string): string[] => {
  const out: string[] = []; let depth = 0; let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    if (expr[i] === '(') depth += 1;
    else if (expr[i] === ')') depth -= 1;
    else if (expr[i] === ',' && depth === 0) { out.push(expr.slice(start, i)); start = i + 1; }
  }
  out.push(expr.slice(start));
  return out;
};
const parseTerm = (term: string): Filter => {
  if (term.startsWith('and(') && term.endsWith(')')) {
    const parts = splitTop(term.slice(4, -1)).map(parseTerm);
    return row => parts.every(part => part(row));
  }
  const first = term.indexOf('.');
  const second = term.indexOf('.', first + 1);
  const column = term.slice(0, first);
  const op = term.slice(first + 1, second);
  const value = term.slice(second + 1);
  switch (op) {
    case 'eq': return row => String(row[column]) === value;
    case 'gt': return row => compare(row[column], value) > 0;
    case 'gte': return row => compare(row[column], value) >= 0;
    case 'lt': return row => compare(row[column], value) < 0;
    case 'lte': return row => compare(row[column], value) <= 0;
    default: throw new Error(`fake-db unsupported or-op ${op}`);
  }
};

export class FakeRelayDb {
  tables: Record<string, Row[]> = {
    tradovate_copier_devices: [],
    tradovate_copier_device_runtime: [],
    tradovate_copier_commands: [],
  };
  /** DB clock (now()) – can be skewed relative to the worker. */
  dbNow: () => number = () => Date.now();
  failNext: Record<string, string> = {};
  /** Optional fault hook: return an error message to fail this operation. */
  hook: ((mode: string, table: string) => string | null) | null = null;
  calls: string[] = [];

  from(table: string) { return new FakeQuery(this, table); }

  async rpc(name: string, args: Row): Promise<{ data: unknown; error: { message: string } | null }> {
    this.calls.push(`rpc:${name}`);
    const now = this.dbNow();
    const nowIso = new Date(now).toISOString();
    const commands = this.tables.tradovate_copier_commands;
    if (name === 'claim_tradovate_copier_command_v2') {
      const own = commands.filter(row => row.device_id === args.target_device_id && row.delivery_id === args.target_delivery_id);
      if (own.length) return { data: own.map(row => ({ ...row })), error: null };
      for (const row of commands) {
        if (row.device_id === args.target_device_id && row.status === 'pending' && Date.parse(row.expires_at) <= now) {
          Object.assign(row, { status: 'expired', completed_at: nowIso, error: 'command-expired' });
        }
      }
      const candidate = commands
        .filter(row => row.device_id === args.target_device_id && row.status === 'pending' && Date.parse(row.expires_at) > now)
        .sort((a, b) => compare(a.created_at, b.created_at) || String(a.id).localeCompare(String(b.id)))[0];
      if (!candidate) return { data: [], error: null };
      Object.assign(candidate, { status: 'claimed', claimed_at: nowIso, delivery_id: args.target_delivery_id });
      return { data: [{ ...candidate }], error: null };
    }
    if (name === 'heartbeat_tradovate_copier_v2') {
      const snapshot = args.snapshot as Row;
      const device = this.tables.tradovate_copier_devices.find(row => row.id === args.target_device_id && row.revoked_at == null);
      if (!device) return { data: null, error: { message: 'invalid-copier-device-auth' } };
      const startedAt = snapshot.startedAt as string;
      const runtime = this.tables.tradovate_copier_device_runtime.find(row => row.device_id === args.target_device_id);
      if (!runtime) {
        this.tables.tradovate_copier_device_runtime.push({
          device_id: args.target_device_id, user_id: device.user_id, connection_id: device.connection_id,
          status: { ...snapshot, nonce: '' }, last_seen_at: nowIso, started_at: startedAt, relay_revision: args.revision,
        });
        return { data: true, error: null };
      }
      if (compare(runtime.started_at, startedAt) < 0
        || (compare(runtime.started_at, startedAt) === 0 && runtime.relay_revision < args.revision)) {
        Object.assign(runtime, { status: { ...snapshot, nonce: '' }, last_seen_at: nowIso, started_at: startedAt, relay_revision: args.revision });
        return { data: true, error: null };
      }
      return { data: false, error: null };
    }
    if (name === 'complete_tradovate_copier_command_v2') {
      const cmd = commands.find(row => row.id === args.target_command_id && row.device_id === args.target_device_id
        && row.delivery_id === args.target_delivery_id);
      if (!cmd) return { data: false, error: null };
      const terminal = args.command_error == null ? 'succeeded' : 'rejected';
      if (cmd.status === 'succeeded' || cmd.status === 'rejected') {
        return { data: cmd.status === terminal
          && JSON.stringify(cmd.result ?? null) === JSON.stringify(args.command_result ?? null)
          && (cmd.error ?? null) === (args.command_error ?? null), error: null };
      }
      if (cmd.status !== 'claimed') return { data: false, error: null };
      await this.rpc('heartbeat_tradovate_copier_v2', { target_device_id: args.target_device_id, snapshot: args.snapshot, revision: args.revision });
      Object.assign(cmd, { status: terminal, result: args.command_result ?? null, error: args.command_error ?? null, completed_at: nowIso });
      return { data: true, error: null };
    }
    throw new Error(`fake-db unsupported rpc ${name}`);
  }
}

class FakeQuery implements PromiseLike<{ data: any; error: any }> {
  private filters: Filter[] = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private limitCount: number | null = null;
  private mode: 'select' | 'update' | 'upsert' = 'select';
  private patch: Row | null = null;
  private upsertRow: Row | null = null;
  private upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private returning = false;
  constructor(private db: FakeRelayDb, private table: string) {}

  select(_columns?: string) { if (this.mode !== 'select') this.returning = true; return this; }
  eq(column: string, value: unknown) { this.filters.push(row => row[column] === value); return this; }
  is(column: string, value: unknown) { this.filters.push(row => (row[column] ?? null) === value); return this; }
  in(column: string, values: unknown[]) { this.filters.push(row => values.includes(row[column])); return this; }
  gt(column: string, value: unknown) { this.filters.push(row => compare(row[column], value) > 0); return this; }
  gte(column: string, value: unknown) { this.filters.push(row => compare(row[column], value) >= 0); return this; }
  lt(column: string, value: unknown) { this.filters.push(row => compare(row[column], value) < 0); return this; }
  lte(column: string, value: unknown) { this.filters.push(row => compare(row[column], value) <= 0); return this; }
  contains(column: string, value: unknown) { this.filters.push(row => contains(row[column], value)); return this; }
  or(expression: string) {
    const parts = splitTop(expression).map(parseTerm);
    this.filters.push(row => parts.some(part => part(row)));
    return this;
  }
  order(column: string, options: { ascending?: boolean } = {}) {
    this.orders.push({ column, ascending: options.ascending !== false }); return this;
  }
  limit(count: number) { this.limitCount = count; return this; }
  update(patch: Row) { this.mode = 'update'; this.patch = patch; return this; }
  upsert(row: Row, options: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.mode = 'upsert'; this.upsertRow = row; this.upsertOptions = options; return this;
  }

  private execute(): { data: Row[]; error: { message: string } | null } {
    this.db.calls.push(`${this.mode}:${this.table}`);
    const hooked = this.db.hook?.(this.mode, this.table);
    if (hooked) return { data: [], error: { message: hooked } };
    const failure = this.db.failNext[`${this.mode}:${this.table}`];
    if (failure) {
      delete this.db.failNext[`${this.mode}:${this.table}`];
      return { data: [], error: { message: failure } };
    }
    const rows = this.db.tables[this.table];
    if (!rows) throw new Error(`fake-db unknown table ${this.table}`);
    if (this.mode === 'upsert') {
      const keys = (this.upsertOptions.onConflict ?? 'id').split(',');
      const existing = rows.find(row => keys.every(key => row[key] === this.upsertRow![key]));
      if (existing) {
        if (this.upsertOptions.ignoreDuplicates) return { data: [], error: null };
        Object.assign(existing, this.upsertRow);
        return { data: [{ ...existing }], error: null };
      }
      const inserted = { id: randomUUID(), status: 'pending', result: null, error: null, delivery_id: null, ...this.upsertRow };
      rows.push(inserted);
      return { data: [{ ...inserted }], error: null };
    }
    let matched = rows.filter(row => this.filters.every(filter => filter(row)));
    if (this.mode === 'update') {
      for (const row of matched) Object.assign(row, this.patch);
      return { data: matched.map(row => ({ ...row })), error: null };
    }
    for (const order of [...this.orders].reverse()) {
      matched = [...matched].sort((a, b) => {
        const l = a[order.column]; const r = b[order.column];
        if (l == null && r == null) return 0;
        if (l == null) return 1;
        if (r == null) return -1;
        return order.ascending ? compare(l, r) : compare(r, l);
      });
    }
    if (this.limitCount != null) matched = matched.slice(0, this.limitCount);
    return { data: matched.map(row => ({ ...row })), error: null };
  }

  async maybeSingle() {
    const { data, error } = this.execute();
    if (error) return { data: null, error };
    if (data.length > 1) return { data: null, error: { message: 'multiple rows' } };
    return { data: data[0] ?? null, error: null };
  }
  async single() {
    const { data, error } = this.execute();
    if (error) return { data: null, error };
    if (data.length !== 1) return { data: null, error: { message: 'not exactly one row' } };
    return { data: data[0], error: null };
  }
  then<T1 = { data: any; error: any }, T2 = never>(
    onfulfilled?: ((value: { data: any; error: any }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve().then(() => this.execute()).then(onfulfilled, onrejected);
  }
}
