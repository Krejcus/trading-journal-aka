import { createBacktestRuntime } from '../../services/backtestEngine';
import { DEFAULT_BACKTEST_CONFIG } from '../../services/backtestTypes';
import type { BacktestRun } from '../../services/backtestTypes';
import { qaState, notifyQa } from './state';
const clone = <T,>(value: T): T => structuredClone(value);
export class BacktestRunConflictError extends Error {
  constructor(message = 'QA conflict') { super(message); this.name = 'BacktestRunConflictError'; }
}
export class BacktestRunSyncError extends Error {
  constructor(message: string, public readonly confirmedRun: BacktestRun) { super(message); this.name = 'BacktestRunSyncError'; }
}
export const withBacktestCloudRevision = (run: BacktestRun, cloudRevision: number | null): BacktestRun => ({
  ...run, persistence: { userId: 'qa-local-user', cloudRevision },
} as BacktestRun);
export const getBacktestRunOwnerId = () => 'qa-local-user';
export const createBacktestLedgerCursor = () => ({ fillIds: new Set<string>(), orderStamps: new Map<string, string>() });
export const getBacktestCloudRevision = () => qaState.cloudRun?.revision ?? 0;
export const saveBacktestRunLocal = async (run: BacktestRun, changes: Partial<BacktestRun>): Promise<BacktestRun> => {
  if (qaState.failLocalSaves > 0) { qaState.failLocalSaves--; notifyQa(); throw new Error('QA injected local save failure; retry is safe'); }
  const next = clone({ ...run, ...changes, revision: run.revision + 1, updatedAt: Date.now() });
  qaState.localSaves++; qaState.savedRun = next; notifyQa(); return next;
};
export const syncBacktestRunToCloud = async (run: BacktestRun): Promise<BacktestRun> => {
  qaState.cloudSaves++; qaState.cloudRun = clone(run); notifyQa(); return clone(run);
};
export const loadBacktestRunFromCloud = async (): Promise<BacktestRun> => {
  if (!qaState.cloudRun) throw new Error('QA has no cloud checkpoint');
  return clone(qaState.cloudRun);
};
export const listBacktestRunConflictCopies = async () => [];

export const listBacktestRuns = async () => qaState.savedRun ? [clone(qaState.savedRun)] : [];
export const getBacktestRun = async (id: string) => qaState.savedRun?.id === id ? clone(qaState.savedRun) : null;
export const saveBacktestRun = async (run: BacktestRun, changes: Partial<BacktestRun>) => syncBacktestRunToCloud(await saveBacktestRunLocal(run, changes));
export const archiveBacktestRun = async (run: BacktestRun) => saveBacktestRun(run, { status: 'archived' });
export const deleteBacktestRun = async (id: string) => {
  if (qaState.savedRun?.id === id) qaState.savedRun = null;
  if (qaState.cloudRun?.id === id) qaState.cloudRun = null;
  notifyQa();
};
export const updateBacktestWorkspaceState = async (run: BacktestRun, workspaceState: BacktestRun['workspaceState']) => saveBacktestRun(run, { workspaceState });
export const createBacktestRun = async (input: { accountId:string; name:string; initialCapital:number; startAt:number; endAt:number; config?:Partial<BacktestRun['config']>; workspaceState?:BacktestRun['workspaceState'] }): Promise<BacktestRun> => {
  const now=Date.now(); const config={...DEFAULT_BACKTEST_CONFIG,...input.config};
  const run:BacktestRun={id:crypto.randomUUID(),accountId:input.accountId,name:input.name,status:'paused',initialCapital:input.initialCapital,baseCurrency:'USD',startAt:input.startAt,endAt:input.endAt,executionSymbol:config.executionInstrument,replayInterval:'1m',cursorAt:null,config,workspaceState:input.workspaceState??{},runtimeState:createBacktestRuntime(input.initialCapital),revision:0,schemaVersion:1,createdAt:now,updatedAt:now,lastOpenedAt:now};
  qaState.savedRun=clone(run);notifyQa();return run;
};
