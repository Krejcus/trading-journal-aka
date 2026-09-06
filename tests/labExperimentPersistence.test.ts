import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LabExperiment } from '../types';
import { loadLabExperiments, persistLabExperiment, removeLabExperiment } from '../services/labExperimentPersistence';

const OWNER = 'owner-a';
const WALL = Date.UTC(2026, 8, 5, 12);
const TOKEN = '2026-09-05T11:59:59.123456+00:00';
function experiment(patch: Partial<LabExperiment> = {}): LabExperiment {
  return { id: 'experiment', createdAt: WALL - 60_000, world: 'backtest', title: 'Retest', hypothesis: 'Fewer impulsive entries', rule: 'Wait for retest',
    targetTrades: 20, startTs: WALL - 60_000, clock: 'recorded', baselineTradeIds: ['baseline'], status: 'running', ...patch };
}
const saved = (patch: Partial<LabExperiment> = {}) => experiment({ storageToken: { ownerId: OWNER, updatedAt: TOKEN }, ...patch });
const body = (value: LabExperiment) => { const { storageToken: _token, ...data } = value; return data; };
const row = (value = experiment(), patch: Record<string, unknown> = {}) => ({ id: value.id, user_id: OWNER, data: body(value), updated_at: TOKEN, ...patch });
type Request = { table: string; operation: 'read' | 'insert' | 'update' | 'delete'; payload?: any; filters: Array<[string, string, unknown]>; select?: string; order?: [string, unknown] };
type Reply = { data: any; error: any };
type Response = Reply | Error | ((request: Request) => Reply | Promise<Reply>);
function harness(responses: Response[]) {
  const requests: Request[] = [];
  let index = 0;
  const from = vi.fn((table: string) => {
    const request: Request = { table, operation: 'read', filters: [] };
    const execute = async () => {
      requests.push(structuredClone(request));
      const response = responses[index++];
      if (response === undefined) throw new Error('Unexpected extra database query');
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(request) : response;
    };
    const query: any = {
      insert(payload: unknown) { request.operation = 'insert'; request.payload = payload; return query; },
      update(payload: unknown) { request.operation = 'update'; request.payload = payload; return query; },
      delete() { request.operation = 'delete'; return query; },
      eq(column: string, value: unknown) { request.filters.push(['eq', column, value]); return query; },
      is(column: string, value: unknown) { request.filters.push(['is', column, value]); return query; },
      select(fields: string) { request.select = fields; return query; },
      order(column: string, value: unknown) { request.order = [column, value]; return query; },
      maybeSingle: execute,
      then(resolve: (value: Reply) => unknown, reject: (error: unknown) => unknown) { return execute().then(resolve, reject); },
    };
    return query;
  });
  return { client: { from }, requests, from };
}
const ack = (request: Request): Reply => ({ data: { id: request.payload.id ?? 'experiment', user_id: OWNER, data: request.payload.data, updated_at: request.payload.updated_at }, error: null });
const matchingRead = (value = experiment()): Reply => ({ data: row(value), error: null });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(WALL); });
afterEach(() => { vi.useRealTimers(); });

describe('owner-scoped experiment loading', () => {
  it('uses an exact owner filter, retains the raw server CAS token and overrides untrusted embedded identity', async () => {
    const api = harness([{ data: [row(experiment(), { data: { ...body(experiment()), id: 'embedded-other', storageToken: { ownerId: 'forged' } } })], error: null }]);
    const result = await loadLabExperiments(api.client, OWNER, () => true);
    expect(api.requests[0]).toMatchObject({ table: 'lab_experiments', operation: 'read', filters: [['eq', 'user_id', OWNER]], order: ['created_at', { ascending: true }] });
    expect(result[0]).toMatchObject({ id: 'experiment', storageToken: { ownerId: OWNER, updatedAt: TOKEN } });
  });
  it('does not query when ownership has already changed, or expose rows when it changes in flight', async () => {
    const stopped = harness([]);
    await expect(loadLabExperiments(stopped.client, OWNER, () => false)).rejects.toThrow(/Účet/);
    expect(stopped.from).not.toHaveBeenCalled();
    let owner = true;
    const inFlight = harness([() => { owner = false; return { data: [row()], error: null }; }]);
    await expect(loadLabExperiments(inFlight.client, OWNER, () => owner)).rejects.toThrow(/Účet/);
  });
  it('rejects a partially successful list or one malformed/foreign row instead of returning a partial baseline', async () => {
    for (const reply of [
      { data: [row()], error: new Error('partial read failed') },
      { data: [row(), row(experiment(), { id: 'foreign', user_id: 'owner-b' })], error: null },
      { data: [row(), row(experiment(), { id: 'malformed', data: [] })], error: null },
    ]) await expect(loadLabExperiments(harness([reply]).client, OWNER, () => true)).rejects.toThrow();
  });
});

describe('exact CAS and insert-only persistence', () => {
  it('updates only the owner, requested experiment and exact unrounded updated_at token', async () => {
    const draft = saved({ title: 'Revised draft' }); const before = structuredClone(draft); const api = harness([ack]);
    const result = await persistLabExperiment(api.client, draft, OWNER, () => true);
    expect(api.requests[0]).toMatchObject({ operation: 'update', filters: [['eq', 'user_id', OWNER], ['eq', 'id', 'experiment'], ['eq', 'updated_at', TOKEN]] });
    expect(api.requests[0].payload.data).toEqual(body(draft));
    expect(api.requests[0].payload.data.storageToken).toBeUndefined();
    expect(result).toMatchObject({ title: 'Revised draft', storageToken: { ownerId: OWNER, updatedAt: new Date(WALL).toISOString() } });
    expect(draft).toEqual(before); expect(api.requests).toHaveLength(1);
  });
  it('uses IS NULL for a known legacy null token and never drops the concurrency predicate', async () => {
    const api = harness([ack]);
    await persistLabExperiment(api.client, saved({ storageToken: { ownerId: OWNER, updatedAt: null } }), OWNER, () => true);
    expect(api.requests[0].filters).toContainEqual(['is', 'updated_at', null]);
    expect(api.requests[0].filters).not.toContainEqual(['eq', 'updated_at', null]);
  });
  it('chooses a timestamp newer than a future server token even when the device clock is behind', async () => {
    const future = '2027-01-01T10:00:00.123456Z'; const api = harness([ack]);
    const result = await persistLabExperiment(api.client, saved({ storageToken: { ownerId: OWNER, updatedAt: future } }), OWNER, () => true);
    expect(Date.parse(result.storageToken!.updatedAt!)).toBeGreaterThan(Date.parse(future));
    expect(api.requests[0].filters).toContainEqual(['eq', 'updated_at', future]);
  });
  it('creates new IDs by insert only, with explicit owner and no read-only token in stored JSON', async () => {
    const api = harness([ack]); const draft = experiment();
    await persistLabExperiment(api.client, draft, OWNER, () => true);
    expect(api.requests[0]).toMatchObject({ operation: 'insert', payload: { id: 'experiment', user_id: OWNER, data: body(draft) } });
    expect(api.requests[0].payload.data).not.toHaveProperty('storageToken');
    expect(api.requests).toHaveLength(1);
  });
  it('refuses foreign tokens, invalid CAS clocks and corrupt research before any database write', async () => {
    for (const value of [saved({ storageToken: { ownerId: 'owner-b', updatedAt: TOKEN } }), saved({ storageToken: { ownerId: OWNER, updatedAt: 'invalid' } }),
      experiment({ research: { version: 1, revisions: [] } })]) {
      const api = harness([]);
      await expect(persistLabExperiment(api.client, value, OWNER, () => true)).rejects.toThrow();
      expect(api.from).not.toHaveBeenCalled();
    }
  });
  it('refuses a save after a mid-flight identity switch without a retry or optimistic result', async () => {
    let owner = true; const draft = saved(); const before = structuredClone(draft);
    const api = harness([request => { owner = false; return ack(request); }]);
    await expect(persistLabExperiment(api.client, draft, OWNER, () => owner)).rejects.toThrow(/Účet/);
    expect(api.requests).toHaveLength(1); expect(draft).toEqual(before);
  });
});

describe('uncertain acknowledgement and conflict handling', () => {
  it.each([
    { data: null, error: { code: '23505', message: 'duplicate insert' } },
    { data: null, error: { code: '503', message: 'network timeout' } },
    { data: null, error: null },
    new Error('transport lost ACK'),
  ])('acknowledges a committed identical body using a fresh scoped read, without a second write %#', async initialReply => {
    const draft = experiment(); const api = harness([initialReply, matchingRead(draft)]);
    const result = await persistLabExperiment(api.client, draft, OWNER, () => true);
    expect(result).toMatchObject({ id: draft.id, storageToken: { ownerId: OWNER, updatedAt: TOKEN } });
    expect(api.requests.map(request => request.operation)).toEqual(['insert', 'read']);
    expect(api.requests[1].filters).toEqual([['eq', 'user_id', OWNER], ['eq', 'id', draft.id]]);
  });
  it('requires exact requested identity and body for both direct ACK and uncertainty readback', async () => {
    const draft = saved();
    for (const patch of [{ id: 'other' }, { user_id: 'owner-b' }, { data: body({ ...draft, title: 'Concurrent draft' }) }]) {
      const bad = { data: row(draft, patch), error: null };
      await expect(persistLabExperiment(harness([bad, bad]).client, draft, OWNER, () => true)).rejects.toThrow();
      await expect(persistLabExperiment(harness([{ data: null, error: { code: '503' } }, bad]).client, draft, OWNER, () => true)).rejects.toThrow();
    }
  });
  it('accepts canonical-equivalent content after uncertainty but not a different body with the same title', async () => {
    const draft = experiment(); const reversed = Object.fromEntries(Object.entries(body(draft)).reverse());
    const api = harness([{ data: null, error: { code: '23505' } }, { data: row(draft, { data: reversed }), error: null }]);
    await expect(persistLabExperiment(api.client, draft, OWNER, () => true)).resolves.toMatchObject({ id: 'experiment' });
    const conflict = harness([{ data: null, error: null }, { data: row(draft, { data: { ...body(draft), rule: 'Different rule' } }), error: null }]);
    await expect(persistLabExperiment(conflict.client, draft, OWNER, () => true)).rejects.toThrow(/jiné okno/);
  });
  it('does not lose a local draft after stale CAS, failed readback or a partial response containing an error', async () => {
    const draft = saved({ title: 'Unsaved draft' }); const before = structuredClone(draft);
    const cases: Response[][] = [
      [{ data: null, error: null }, { data: row(saved({ title: 'Other window' })), error: null }],
      [{ data: null, error: { code: '503', message: 'write uncertain' } }, { data: null, error: new Error('readback failed') }],
      [{ data: row(draft), error: new Error('partial response') }, { data: null, error: null }],
    ];
    for (const replies of cases) {
      const api = harness(replies);
      await expect(persistLabExperiment(api.client, draft, OWNER, () => true)).rejects.toThrow();
      expect(api.requests.filter(request => request.operation === 'update')).toHaveLength(1);
      expect(draft).toEqual(before);
    }
  });
  it('rechecks identity after uncertain readback before exposing the acknowledged result', async () => {
    let owner = true;
    const api = harness([{ data: null, error: { code: '503' } }, () => { owner = false; return matchingRead(); }]);
    await expect(persistLabExperiment(api.client, experiment(), OWNER, () => owner)).rejects.toThrow(/Účet/);
    expect(api.requests.map(request => request.operation)).toEqual(['insert', 'read']);
  });
});

describe('deletion preserves research history and uses owner CAS', () => {
  it('deletes only the exact owner/id/token and requires the matching returned row', async () => {
    const draft = saved(); const before = structuredClone(draft); const api = harness([{ data: [{ id: draft.id }], error: null }]);
    await expect(removeLabExperiment(api.client, draft, OWNER, () => true)).resolves.toBeUndefined();
    expect(api.requests[0]).toMatchObject({ operation: 'delete', filters: [['eq', 'user_id', OWNER], ['eq', 'id', draft.id], ['eq', 'updated_at', TOKEN]], select: 'id' });
    expect(draft).toEqual(before);
  });
  it('uses IS NULL when the stored timestamp is explicitly null', async () => {
    const api = harness([{ data: [{ id: 'experiment' }], error: null }]);
    await removeLabExperiment(api.client, saved({ storageToken: { ownerId: OWNER, updatedAt: null } }), OWNER, () => true);
    expect(api.requests[0].filters).toContainEqual(['is', 'updated_at', null]);
  });
  it('never deletes a research case, a foreign token or an unhydrated draft', async () => {
    for (const value of [saved({ research: { version: 1, revisions: [] } }), saved({ storageToken: { ownerId: 'owner-b', updatedAt: TOKEN } }), experiment()]) {
      const api = harness([]);
      await expect(removeLabExperiment(api.client, value, OWNER, () => true)).rejects.toThrow();
      expect(api.from).not.toHaveBeenCalled();
    }
  });
  it.each([
    { data: [], error: null }, { data: [{ id: 'other' }], error: null },
    { data: [{ id: 'experiment' }, { id: 'other' }], error: null }, { data: [{ id: 'experiment' }], error: new Error('delete not confirmed') },
  ])('does not claim deletion on stale/mismatched/partial ACK %#', async reply => {
    const api = harness([reply]); await expect(removeLabExperiment(api.client, saved(), OWNER, () => true)).rejects.toThrow();
    expect(api.requests).toHaveLength(1);
  });
  it('does not acknowledge deletion to a different account after the request resolves', async () => {
    let owner = true; const api = harness([() => { owner = false; return { data: [{ id: 'experiment' }], error: null }; }]);
    await expect(removeLabExperiment(api.client, saved(), OWNER, () => owner)).rejects.toThrow(/Účet/);
  });
});
