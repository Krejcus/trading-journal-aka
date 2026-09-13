import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { journalPositionChunks, persistStagedJournalPositions } from '../server/journalStagedImport';
import { journalAccountsFixture } from './fixtures/journalAccounts';
import { projectJournalAccounts } from '../lib/journalAccountProjection';
import { journalPositionWrite } from '../lib/journalTradeFacts';

const fixture = journalAccountsFixture();
const position = projectJournalAccounts(fixture.events,fixture.accounts).ready.map(journalPositionWrite)[0];
const positions = Array.from({ length: 205 }, (_, i) => ({ ...position, positionId: `position-${i}` }));
const scope = { ownerId: '11111111-1111-4111-8111-111111111111', connectionId: fixture.events[0].connectionId, environment: 'demo' as const };
const runId = '77777777-7777-4777-8777-777777777777';
const rpc = vi.fn(); const db = { rpc } as unknown as SupabaseClient;
const ok = (data: unknown) => ({ data,error:null });
beforeEach(() => { vi.resetAllMocks(); rpc.mockImplementation(async (name, args) => {
  if (name==='begin_journal_position_stage') return ok({ accepted:true,runId,completedChunks:[] });
  if (name==='write_journal_position_stage') return ok({ accepted:true,chunkIndex:args.p_chunk_index,positionCount:args.p_positions.length });
  return ok({ accepted:true,through:42,positionCount:positions.length });
}); });

describe('bounded staged projection transport', () => {
  it('splits complete positions into bounded chunks without losing order or contents', () => {
    const chunks = journalPositionChunks(positions);
    expect(chunks.map(rows=>rows.length)).toEqual([100,100,5]);
    expect(chunks.flat()).toEqual(positions);
    for (const rows of chunks) expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(1_000_000);
  });
  it('honors UTF-8 byte size and refuses a single oversized position', () => {
    const large = { ...position, history: { ...position.history,issues:['ž'.repeat(200_000)] } };
    const chunks = journalPositionChunks([large,large,large]);
    expect(chunks.map(rows=>rows.length)).toEqual([2,1]);
    expect(()=>journalPositionChunks([{ ...large,history:{ ...large.history,issues:['ž'.repeat(500_000)] } }])).toThrow('journal-import-partition-required');
    expect(()=>journalPositionChunks(Array(50_001).fill(position))).toThrow('journal-import-partition-required');
  });
  it('publishes only after each chunk was acknowledged with its exact index and count', async () => {
    expect(await persistStagedJournalPositions(db,scope,42,positions,{ version:1 })).toEqual({ accepted:true,staged:true });
    expect(rpc.mock.calls.map(call=>call[0])).toEqual(['begin_journal_position_stage',...Array(3).fill('write_journal_position_stage'),'publish_journal_position_stage']);
    for (const [,args] of rpc.mock.calls) expect(args).toMatchObject({ p_user_id:scope.ownerId,p_connection_id:scope.connectionId });
    expect(rpc.mock.calls[0][1].p_run_key).toMatch(/^[a-f0-9]{64}$/);
  });
  it('resumes from confirmed chunks and uses the same content key on retry', async () => {
    await persistStagedJournalPositions(db,scope,42,positions,{ version:1 });
    const key = rpc.mock.calls[0][1].p_run_key;
    rpc.mockClear(); rpc.mockResolvedValueOnce(ok({ accepted:true,runId,completedChunks:[0,1] }));
    await persistStagedJournalPositions(db,scope,42,positions,{ version:1 });
    expect(rpc.mock.calls[0][1].p_run_key).toBe(key);
    expect(rpc.mock.calls.filter(call=>call[0]==='write_journal_position_stage').map(call=>call[1].p_chunk_index)).toEqual([2]);
  });
  it('yields after a bounded number of writes and resumes without republishing a prefix', async () => {
    const completed = new Set<number>();
    rpc.mockImplementation(async (name, args) => {
      if (name === 'begin_journal_position_stage') return ok({accepted:true,runId,completedChunks:[...completed]});
      if (name === 'write_journal_position_stage') {
        completed.add(args.p_chunk_index);
        return ok({accepted:true,chunkIndex:args.p_chunk_index,positionCount:args.p_positions.length});
      }
      expect(completed.size).toBe(3);
      return ok({accepted:true,through:42,positionCount:205});
    });
    for (let i=0;i<2;i++) {
      expect(await persistStagedJournalPositions(db,scope,42,positions,{}, {maxChunks:1})).toEqual({accepted:false,processing:true});
      expect(rpc.mock.calls.some(call=>call[0]==='publish_journal_position_stage')).toBe(false);
    }
    expect(await persistStagedJournalPositions(db,scope,42,positions,{}, {maxChunks:1})).toEqual({accepted:true,staged:true});
    expect(rpc.mock.calls.filter(call=>call[0]==='write_journal_position_stage').map(call=>call[1].p_chunk_index)).toEqual([0,1,2]);
    expect(new Set(rpc.mock.calls.filter(call=>call[0]==='begin_journal_position_stage').map(call=>call[1].p_run_key)).size).toBe(1);
  });
  it('yields after a slow acknowledged write, including before final publication', async () => {
    let now=1000;
    const clock=vi.spyOn(Date,'now').mockImplementation(()=>now);
    try {
      rpc.mockImplementation(async (name,args)=>{
        if(name==='begin_journal_position_stage')return ok({accepted:true,runId,completedChunks:[0,1]});
        now+=6000;
        return ok({accepted:true,chunkIndex:args.p_chunk_index,positionCount:args.p_positions.length});
      });
      expect(await persistStagedJournalPositions(db,scope,42,positions,{})).toEqual({accepted:false,processing:true});
      expect(rpc.mock.calls.map(call=>call[0])).toEqual(['begin_journal_position_stage','write_journal_position_stage']);
    } finally {clock.mockRestore();}
  });
  it('rejects invalid budgets before any database call', async () => {
    for(const options of [{maxChunks:0},{maxChunks:65},{maxChunks:1.5},{maxMs:0},{maxMs:Infinity}]) {
      await expect(persistStagedJournalPositions(db,scope,42,positions,{},options)).rejects.toThrow('invalid-journal-stage-budget');
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it('changes the content key for corrected financial evidence or account bindings', async () => {
    await persistStagedJournalPositions(db,scope,42,positions,{ accounts:['a'] });
    const first = rpc.mock.calls[0][1].p_run_key;
    rpc.mockClear(); await persistStagedJournalPositions(db,scope,42,positions,{ accounts:['b'] });
    expect(rpc.mock.calls[0][1].p_run_key).not.toBe(first);
    rpc.mockClear(); await persistStagedJournalPositions(db,scope,42,positions.map((p,i)=>i ? p : { ...p,facts:{ ...p.facts,pnl:99 } }),{ accounts:['a'] });
    expect(rpc.mock.calls[0][1].p_run_key).not.toBe(first);
  });
  it('does not publish after an interrupted or falsely acknowledged write', async () => {
    for (const response of [ok({ accepted:true,chunkIndex:1,positionCount:100 }),ok({ accepted:true,chunkIndex:0,positionCount:99 }),{ data:null,error:{ message:'offline' } }]) {
      rpc.mockClear(); rpc.mockResolvedValueOnce(ok({ accepted:true,runId,completedChunks:[] })).mockResolvedValueOnce(response);
      await expect(persistStagedJournalPositions(db,scope,42,positions,{})).rejects.toThrow();
      expect(rpc.mock.calls.some(call=>call[0]==='publish_journal_position_stage')).toBe(false);
    }
  });
  it.each([[0,0],[-1],[3],['0'],null].map(completedChunks=>({ completedChunks })))('rejects malformed resume indexes $completedChunks', async ({ completedChunks }) => {
    rpc.mockResolvedValueOnce(ok({ accepted:true,runId,completedChunks }));
    await expect(persistStagedJournalPositions(db,scope,42,positions,{})).rejects.toThrow('journal-stage-not-confirmed');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('does not stage when a newer revision already won', async () => {
    rpc.mockResolvedValueOnce(ok({ accepted:false,stale:true }));
    expect(await persistStagedJournalPositions(db,scope,42,positions,{})).toEqual({ accepted:false,stale:true });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('rejects an unconfirmed final publication after valid chunk acknowledgements', async () => {
    rpc.mockResolvedValueOnce(ok({ accepted:true,runId,completedChunks:[0,1,2] }))
      .mockResolvedValueOnce(ok({ accepted:true,through:41,positionCount:positions.length }));
    await expect(persistStagedJournalPositions(db,scope,42,positions,{})).rejects.toThrow('journal-position-write-not-confirmed');
  });
});
