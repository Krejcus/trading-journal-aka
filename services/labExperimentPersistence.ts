import type { LabExperiment } from '../types';
import { canonicalBacktestEvidence } from './backtestEvidenceIdentity';
import { validateResearchCase } from './backtestResearchCases';
type Client = { from: (table: string) => any };
type IdentityGuard = () => boolean | Promise<boolean>;
const assertOwner = async (stillOwner: IdentityGuard) => { if (!await stillOwner()) throw new Error('Účet se změnil během ukládání experimentu. Návrh zůstal zachovaný.'); };
const payload = (experiment: LabExperiment): Omit<LabExperiment,'storageToken'> => {
  const { storageToken: _token, ...data } = experiment; return data;
};
const hydrate = (row: any, ownerId: string): LabExperiment => {
  if (!row || typeof row.id !== 'string' || row.user_id !== ownerId || !row.data || typeof row.data !== 'object' || Array.isArray(row.data)) throw new Error('Server nepotvrdil experiment a jeho vlastníka.');
  return { ...row.data, id: row.id, storageToken: { ownerId, updatedAt: row.updated_at ?? null } };
};
export async function loadLabExperiments(client: Client, ownerId: string, stillOwner: IdentityGuard): Promise<LabExperiment[]> {
  await assertOwner(stillOwner);
  const { data, error } = await client.from('lab_experiments').select('id,user_id,data,updated_at').eq('user_id',ownerId).order('created_at',{ascending:true});
  await assertOwner(stillOwner); if (error) throw error;
  const items: LabExperiment[] = (data ?? []).map((row: any) => hydrate(row,ownerId));
  await Promise.all(items.map(item => item.research ? validateResearchCase(item.research) : undefined));
  await assertOwner(stillOwner);
  return items;
}
/** Exact server timestamp CAS + monotonic replacement timestamp. New IDs are insert-only. */
export async function persistLabExperiment(client: Client, experiment: LabExperiment, ownerId: string, stillOwner: IdentityGuard): Promise<LabExperiment> {
  await assertOwner(stillOwner);
  if (experiment.storageToken && experiment.storageToken.ownerId !== ownerId) throw new Error('Experiment patří jinému účtu.');
  if (experiment.research) await validateResearchCase(experiment.research);
  await assertOwner(stillOwner);
  const data = payload(experiment); const token = experiment.storageToken;
  const previousTime = token?.updatedAt == null ? 0 : Date.parse(token.updatedAt);
  if (!Number.isFinite(previousTime)) throw new Error('Experiment nemá platnou uloženou revizi. Načti ho znovu.');
  const updatedAt = new Date(Math.max(Date.now(),previousTime+1)).toISOString();
  let query = token
    ? client.from('lab_experiments').update({ data,updated_at:updatedAt }).eq('user_id',ownerId).eq('id',experiment.id)
    : client.from('lab_experiments').insert({ id:experiment.id,user_id:ownerId,data,updated_at:updatedAt });
  if (token) query = token.updatedAt === null ? query.is('updated_at',null) : query.eq('updated_at',token.updatedAt);
  let result: { data?: any; error?: any };
  try { result = await query.select('id,user_id,data,updated_at').maybeSingle(); }
  catch (error) { result = { error }; }
  await assertOwner(stillOwner);
  if (!result.error && result.data && result.data.id === experiment.id && result.data.user_id === ownerId
    && canonicalBacktestEvidence(result.data.data) === canonicalBacktestEvidence(data)) return hydrate(result.data,ownerId);
  // An uncertain success is acknowledged only by a fresh identical server body.
  const retry = await client.from('lab_experiments').select('id,user_id,data,updated_at').eq('user_id',ownerId).eq('id',experiment.id).maybeSingle();
  await assertOwner(stillOwner);
  if (!retry.error && retry.data && retry.data.id === experiment.id && retry.data.user_id === ownerId && canonicalBacktestEvidence(retry.data.data) === canonicalBacktestEvidence(data)) return hydrate(retry.data,ownerId);
  if (result.error && String(result.error.code) !== '23505') throw new Error(result.error.message || 'Experiment se nepodařilo uložit.');
  throw new Error('Experiment mezitím změnilo jiné okno nebo zařízení. Návrh zůstal otevřený; načti aktuální verzi a porovnej změny.');
}
export async function removeLabExperiment(client: Client, experiment: LabExperiment, ownerId: string, stillOwner: IdentityGuard): Promise<void> {
  await assertOwner(stillOwner);
  if (experiment.research) throw new Error('Výzkumný případ s historií se nemaže. Ukonči jej; verze zůstanou dohledatelné.');
  const token=experiment.storageToken;
  if (!token || token.ownerId !== ownerId) throw new Error('Před odstraněním znovu načti experiment.');
  let query=client.from('lab_experiments').delete().eq('user_id',ownerId).eq('id',experiment.id);
  query=token.updatedAt === null ? query.is('updated_at',null) : query.eq('updated_at',token.updatedAt);
  const {data,error}=await query.select('id'); await assertOwner(stillOwner);
  if (error) throw error;
  if (data?.length !== 1 || data[0].id !== experiment.id) throw new Error('Experiment se mezitím změnil nebo byl odstraněn. Obnov seznam.');
}
