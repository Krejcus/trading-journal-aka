import { describe, expect, it } from 'vitest';
import { backtestResearchRecordedAt } from '../services/backtestResearchClock';
import type { BacktestOrderEvent } from '../services/backtestTypes';
const WALL = Date.UTC(2026,8,5,19);
const closed = {positionId:'opening',runId:'run',instrument:'MNQ' as const,entryTime:1000};
const created:BacktestOrderEvent={id:'created',orderId:'opening',runId:'run',instrument:'MNQ',kind:'created',marketTime:900,recordedAt:WALL};
describe('research decision wall clock',()=>{
 it('uses the actual opening intent time, including after partial closes and scale-ins',()=>{
  const scaled={...created,id:'scale',orderId:'scale-order',marketTime:1000,recordedAt:WALL+5000};
  expect(backtestResearchRecordedAt(closed,[created,scaled])).toBe(WALL);
 });
 it('reversal uses its own new position identity',()=>{
  const reversal={...created,id:'reversal',orderId:'reversal-order',marketTime:1000,recordedAt:WALL+5000};
  expect(backtestResearchRecordedAt({...closed,positionId:'reversal-order'},[created,reversal])).toBe(WALL+5000);
 });
 it('never guesses from historical market time or a same-symbol legacy order',()=>{
  expect(backtestResearchRecordedAt({...closed,positionId:undefined},[created])).toBeUndefined();
  expect(backtestResearchRecordedAt(closed,[{...created,recordedAt:undefined}])).toBeUndefined();
  expect(backtestResearchRecordedAt(closed,[])).toBeUndefined();
 });
 it('rejects wrong scope, future creation, generated fill time, and invalid clocks',()=>{
  for(const event of [{...created,runId:'other'},{...created,instrument:'NQ' as const},{...created,marketTime:1001},{...created,kind:'filled' as const},...[-1,0,NaN,Infinity].map(recordedAt=>({...created,recordedAt}))]){
   expect(backtestResearchRecordedAt(closed,[event])).toBeUndefined();
  }
 });
 it('deduplicates equal evidence but rejects conflicting timestamps',()=>{
  expect(backtestResearchRecordedAt(closed,[created,{...created,id:'duplicate'}])).toBe(WALL);
  expect(backtestResearchRecordedAt(closed,[created,{...created,id:'conflict',recordedAt:WALL+1}])).toBeUndefined();
 });
});
