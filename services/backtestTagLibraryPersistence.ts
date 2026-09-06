import type { Trade } from '../types';
import { supabase } from './supabase';
import { getUserId } from './storageService';
import { tradeValuesEqual } from './tradePatch';
import { validateBacktestTagLibrary, type BacktestTagCommitPlan, type BacktestTagLibrary } from './backtestTagLibrary';

export const BACKTEST_TAG_LIBRARY_READ_RPC = 'get_backtest_tag_library_v1';
export const BACKTEST_TAG_LIBRARY_COMMIT_RPC = 'commit_backtest_tag_library_v1';
export const BACKTEST_TAG_LIBRARY_UNAVAILABLE = 'Bezpečná správa katalogu tagů zatím není aktivovaná v databázi. Rozepsané změny zůstávají zachované. Běžné zadávání tagů v review funguje dál.';
export const BACKTEST_TAG_TRANSACTION_MAX_BYTES = 2 * 1024 * 1024;
export interface BacktestTagCommitResult {
  library: BacktestTagLibrary; operationId: string; alreadyApplied: boolean;
  tradePatches: Array<{ tradeId: string; updates: Partial<Trade> }>;
}
interface RpcResult { data: unknown; error: { code?: string; message?: string } | null }
export interface BacktestTagPersistenceDependencies {
  rpc: (name: string, args?: Record<string, unknown>) => PromiseLike<RpcResult>;
  getOwnerId: () => Promise<string | null>;
  getAuthVersion: () => number;
}
const allowed = new Set(['tags', 'htfConfluence', 'ltfConfluence', 'autoConfluence']);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const fail = (message: string): never => { throw new Error(message); };
export class BacktestTagPersistenceError extends Error {
  readonly code?: string;
  readonly definitelyNotApplied: boolean;
  constructor(message: string, code?: string) {
    super(message); this.name = 'BacktestTagPersistenceError'; this.code = code;
    this.definitelyNotApplied = ['40001', '42501', '22023', '23514', 'PGRST202', '42883'].includes(String(code));
  }
}
const throwRpc = (error: NonNullable<RpcResult['error']>): never => {
  const reject = (message: string): never => { throw new BacktestTagPersistenceError(message, error.code); };
  if (['PGRST202', '42883'].includes(String(error.code))) return reject(BACKTEST_TAG_LIBRARY_UNAVAILABLE);
  if (String(error.code) === '40001') return reject('Katalog nebo tagy vybraného obchodu se od náhledu změnily. Nic z této změny se neuložilo; načti data a porovnej nový náhled.');
  return reject(error.message || 'Databáze nepotvrdila změnu tagů. Zachovej náhled pro opakování stejné operace.');
};
const validateUpdates = (updates: unknown) => {
  if (!object(updates) || Object.keys(updates).some(key => !allowed.has(key))) fail('Změna tagů obsahuje nepovolené pole.');
  for (const [key, value] of Object.entries(updates as Record<string, unknown>)) {
    if (value === null) continue; // A retry may return a field removed by a later review.
    if (key === 'autoConfluence') {
      if (!object(value) || Object.keys(value).some(part => !['htf', 'ltf'].includes(part))
        || !Array.isArray(value.htf) || !Array.isArray(value.ltf)
        || [...value.htf, ...value.ltf].some(item => typeof item !== 'string')) fail('Neplatná odpověď původu tagů.');
    } else if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail('Neplatná odpověď seznamu tagů.');
  }
};
/** JSON stays in the RPC POST body, never URL filters. No unrelated trade fields. */
export const backtestTagCommitRpcArgs = (plan: BacktestTagCommitPlan): Record<string, unknown> => {
  validateBacktestTagLibrary(plan.expectedLibrary); validateBacktestTagLibrary(plan.library);
  if (plan.ownerId !== plan.library.ownerId || plan.ownerId !== plan.expectedLibrary.ownerId
    || plan.library.revision !== plan.expectedLibrary.revision + 1
    || !/^[A-Za-z0-9_-]{1,160}$/.test(plan.operationId)) return fail('Náhled katalogu nemá platnou identitu nebo revizi.');
  if (plan.scope.tradeIds.length > 500 || plan.scopeSnapshots.length > 500 || plan.tradePatches.length > 500) return fail('Jedna operace může zahrnout nejvýše 500 vybraných obchodů.');
  const ids = new Set(plan.scope.tradeIds);
  if (ids.size !== plan.scope.tradeIds.length || plan.scopeSnapshots.length !== ids.size
    || new Set(plan.scopeSnapshots.map(item => item.tradeId)).size !== ids.size
    || new Set(plan.tradePatches.map(item => item.tradeId)).size !== plan.tradePatches.length
    || plan.scope.fields.some(field => !allowed.has(field) || field === ('autoConfluence' as string))) return fail('Rozsah náhledu není úplný nebo obsahuje duplicity.');
  const expectedFields = new Set<string>(['id', 'accountId', 'backtestRunId', ...plan.scope.fields,
    ...(plan.scope.fields.some(field => field !== 'tags') ? ['autoConfluence'] : [])]);
  for (const captured of plan.scopeSnapshots) {
    if (!ids.has(captured.tradeId) || String(captured.expected.id) !== captured.tradeId
      || !captured.expected.accountId || !captured.expected.backtestRunId
      || Object.keys(captured.expected).some(key => !expectedFields.has(key))) return fail('Náhled obsahuje neplatný obchod nebo data mimo rozsah tagů.');
  }
  for (const patch of plan.tradePatches) {
    const captured = plan.scopeSnapshots.find(item => item.tradeId === patch.tradeId);
    validateUpdates(patch.updates);
    if (!captured || !tradeValuesEqual(captured.expected, patch.expected)
      || Object.keys(patch.updates).some(key => !expectedFields.has(key))) return fail('Změna tagů není součástí zachyceného rozsahu.');
  }
  const args = { p_owner_id: plan.ownerId, p_operation_id: plan.operationId,
    p_expected_library: plan.expectedLibrary, p_library: plan.library, p_scope: plan.scope,
    p_scope_snapshots: plan.scopeSnapshots, p_trade_patches: plan.tradePatches };
  if (new TextEncoder().encode(JSON.stringify(args)).length > BACKTEST_TAG_TRANSACTION_MAX_BYTES) return fail('Náhled překračuje limit 2 MiB. Zmenši vybraný rozsah; původní data zůstávají zachovaná.');
  return structuredClone(args);
};
const parseResult = (value: unknown, plan: BacktestTagCommitPlan): BacktestTagCommitResult => {
  if (!object(value) || value.operationId !== plan.operationId || typeof value.alreadyApplied !== 'boolean'
    || !object(value.library) || value.library.ownerId !== plan.ownerId || !Array.isArray(value.tradePatches)) return fail('Server nepotvrdil správnou operaci a vlastníka katalogu.');
  const library = validateBacktestTagLibrary(value.library as unknown as BacktestTagLibrary);
  if (library.revision < plan.library.revision || (!value.alreadyApplied && !tradeValuesEqual(library, plan.library))) return fail('Server nepotvrdil očekávanou revizi katalogu.');
  const seen = new Set<string>();
  for (const item of value.tradePatches) {
    if (!object(item) || typeof item.tradeId !== 'string' || seen.has(item.tradeId)) return fail('Server vrátil neplatné potvrzení obchodů.');
    const expected = plan.tradePatches.find(patch => patch.tradeId === item.tradeId);
    if (!expected || !object(item.updates) || !tradeValuesEqual(Object.keys(item.updates).sort(), Object.keys(expected.updates).sort())) return fail('Server nepotvrdil přesný rozsah tagů.');
    validateUpdates(item.updates);
    if (!value.alreadyApplied && !tradeValuesEqual(item.updates, expected.updates)) return fail('Server nepotvrdil požadované hodnoty tagů.');
    seen.add(item.tradeId);
  }
  if (seen.size !== plan.tradePatches.length) return fail('Server nepotvrdil všechny dotčené obchody.');
  return structuredClone({ library, operationId: value.operationId, alreadyApplied: value.alreadyApplied, tradePatches: value.tradePatches.map(item => ({ tradeId: item.tradeId, updates: item.updates })) }) as BacktestTagCommitResult;
};
export const createBacktestTagLibraryPersistence = (dependencies: BacktestTagPersistenceDependencies) => {
  const current = async (ownerId: string, version: number) => {
    if (dependencies.getAuthVersion() !== version || await dependencies.getOwnerId() !== ownerId || dependencies.getAuthVersion() !== version) fail('Uživatel se během práce s katalogem změnil. Výsledek původního účtu nelze použít.');
  };
  return {
    load: async (ownerId: string): Promise<BacktestTagLibrary> => {
      const version = dependencies.getAuthVersion(); await current(ownerId, version);
      const result = await dependencies.rpc(BACKTEST_TAG_LIBRARY_READ_RPC);
      await current(ownerId, version);
      if (result.error) throwRpc(result.error);
      if (!object(result.data) || result.data.ownerId !== ownerId) return fail('Načtení katalogu nebylo potvrzeno pro aktuálního uživatele.');
      return structuredClone(validateBacktestTagLibrary(result.data as unknown as BacktestTagLibrary));
    },
    commit: async (plan: BacktestTagCommitPlan): Promise<BacktestTagCommitResult> => {
      const version = dependencies.getAuthVersion(), ownerId = plan.ownerId;
      await current(ownerId, version);
      const args = backtestTagCommitRpcArgs(plan); await current(ownerId, version);
      const result = await dependencies.rpc(BACKTEST_TAG_LIBRARY_COMMIT_RPC, args);
      await current(ownerId, version);
      if (result.error) throwRpc(result.error);
      return parseResult(result.data, plan);
    },
  };
};
let authVersion = 0;
supabase.auth.onAuthStateChange(() => { authVersion += 1; });
const persistence = createBacktestTagLibraryPersistence({ rpc: (name, args) => supabase.rpc(name, args), getOwnerId: getUserId, getAuthVersion: () => authVersion });
export const loadBacktestTagLibrary = persistence.load;
export const commitBacktestTagLibrary = persistence.commit;
