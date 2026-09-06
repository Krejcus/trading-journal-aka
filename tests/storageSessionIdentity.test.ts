import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../services/storageService.ts', import.meta.url), 'utf8');
function authFixture() {
  let authChanged!: (event: string, session: any) => void;
  let resolve!: (session: any) => void;
  const supabase = { auth: {
    onAuthStateChange: (cb: typeof authChanged) => { authChanged = cb; },
    getSession: vi.fn(() => new Promise<any>(r => { resolve = session => r({ data: { session } }); })),
  } };
  const snippet = source.slice(source.indexOf('// Helper to get current user ID with caching'), source.indexOf('// Safe LocalStorage helper')).replace('export const getUserId', 'const getUserId');
  const js = ts.transpile(snippet, { target: ts.ScriptTarget.ES2022 });
  const getUserId = new Function('supabase', `${js}; return getUserId;`)(supabase) as () => Promise<string | null>;
  return { getUserId, authChanged: (event: string, session: any) => authChanged(event, session), resolve: (session: any) => resolve(session), supabase };
}
it('a stale getSession cannot reinstall A identity after B authenticates', async () => {
  const f = authFixture(); const old = f.getUserId();
  f.authChanged('SIGNED_IN', { user: { id: 'B' } });
  f.resolve({ user: { id: 'A' } });
  expect(await old).toBeNull();
  expect(await f.getUserId()).toBe('B');
});
it('a stale getSession cannot reinstall A identity after logout', async () => {
  const f = authFixture(); const old = f.getUserId();
  f.authChanged('SIGNED_OUT', null); f.resolve({ user: { id: 'A' } });
  expect(await old).toBeNull();
  const next = f.getUserId(); f.resolve(null);
  expect(await next).toBeNull();
  expect(f.supabase.auth.getSession).toHaveBeenCalledTimes(2);
});
it('actual autosave refuses A accounts if identity switches while resolving auth', async () => {
  const start = source.indexOf('  async saveAccounts('); const end = source.indexOf('  async deleteAccount(', start);
  const js = ts.transpile(`const service = {${source.slice(start, end)}};`, { target: ts.ScriptTarget.ES2022 });
  const mutation = vi.fn();
  const service = new Function('getUserId', 'supabase', 'authStateVersion', `${js}; return service;`)(async () => 'B', { from: mutation }, 1);
  await expect(service.saveAccounts([{ id: 'A-account' }], 'A')).rejects.toThrow('Session changed');
  expect(mutation).not.toHaveBeenCalled();
});
