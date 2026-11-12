import { sharedReadDb, OWNER, CONNECTION } from './helpers/tradovateSharedReadDb';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import type { VercelRequest,VercelResponse } from '@vercel/node';
const database=vi.hoisted(()=>({client:null as any}));
let localDb:Awaited<ReturnType<typeof sharedReadDb>>;
beforeAll(async()=>{localDb=await sharedReadDb();database.client=localDb.client();},30_000);
afterAll(async()=>{await localDb?.pg.close();});
const mocks=vi.hoisted(()=>({auth:vi.fn(),token:vi.fn(),read:vi.fn()}));
vi.mock('../server/tradovateOAuthStore.js',()=>({createTradovateAdminClient:()=>database.client,getValidTradovateAccessToken:mocks.token,readTradovateServerConfig:()=>({environment:'demo'}),requireSupabaseUserId:mocks.auth}));
vi.mock('../server/tradovateSharedWorkerRead.js',()=>({readWorkerSharedCash:async()=>null}));
vi.mock('../server/nativeCors.js',()=>({handleNativeCors:()=>false}));
vi.mock('../server/tradovateAccountDisplayRead.js',()=>({readTradovateAccountDisplay:mocks.read}));
import handler, { resetTradovateLivePnlCoalescingForTests } from '../api/tradovate/oauth/live-pnl';
const request=(body:Record<string,unknown>)=>({method:'POST',headers:{authorization:'Bearer app-session'},body}) as VercelRequest;
const response=()=>{const res={setHeader:vi.fn(),status:vi.fn(),json:vi.fn()};res.status.mockReturnValue(res);return res;};
describe('authenticated cash display mode',()=>{
 beforeEach(async()=>{await localDb.pg.exec('truncate public.tradovate_shared_reads');vi.clearAllMocks();resetTradovateLivePnlCoalescingForTests();mocks.auth.mockResolvedValue(OWNER);mocks.token.mockResolvedValue({accessToken:'broker-test'});mocks.read.mockResolvedValue({totalCashValue:0,dailyRealizedPnL:0});});
 it('binds the read to the authenticated owner and returns the explicit versioned envelope',async()=>{
  const res=response();await handler(request({connectionId:CONNECTION,mode:'cash',accountId:10}),res as unknown as VercelResponse);
  expect(mocks.token).toHaveBeenCalledWith(expect.objectContaining({userId:OWNER,connectionId:CONNECTION}));
  expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({accountId:10,accessToken:'broker-test',baseUrl:'https://demo.tradovateapi.com/v1'}));
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({kind:'account-display-v1',snapshot:expect.objectContaining({connectionId:CONNECTION,environment:'demo',accountId:10,fields:{totalCashValue:0,dailyRealizedPnL:0}})}));
 });
 it('cannot read without a valid app identity or an owned connection',async()=>{
  const res=response();mocks.auth.mockRejectedValue(new Error('invalid-auth-token'));
  await handler(request({connectionId:CONNECTION,mode:'cash',accountId:10}),res as unknown as VercelResponse);
  expect(res.status).toHaveBeenCalledWith(401);expect(mocks.read).not.toHaveBeenCalled();
  mocks.auth.mockResolvedValue(OWNER);mocks.token.mockRejectedValue(new Error('tradovate-not-connected'));
  await handler(request({connectionId:'other',mode:'cash',accountId:10}),res as unknown as VercelResponse);
  expect(res.status).toHaveBeenCalledWith(409);expect(mocks.read).not.toHaveBeenCalled();
 });
 it('preserves the broker reconnect code for the web instead of returning a generic gateway error',async()=>{
  const res=response();mocks.token.mockRejectedValue(new Error('tradovate-reauthorization-required'));
  await handler(request({connectionId:CONNECTION,mode:'cash',accountId:10}),res as unknown as VercelResponse);
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith({error:'tradovate-reauthorization-required'});
  expect(mocks.read).not.toHaveBeenCalled();
 });
 it('sdílí čerstvé čtení stejného účtu mezi klienty a po selhání sdílí odklad bez dalších broker dotazů',async()=>{
  const res=response();
  await handler(request({connectionId:CONNECTION,mode:'cash',accountId:10}),res as unknown as VercelResponse);
  await handler(request({connectionId:CONNECTION,mode:'cash',accountId:10}),res as unknown as VercelResponse);
  await handler(request({connectionId:CONNECTION,mode:'cash',accountId:11}),res as unknown as VercelResponse);
  expect(mocks.read).toHaveBeenCalledTimes(2);
  await localDb.pg.exec('truncate public.tradovate_shared_reads');
  mocks.read.mockRejectedValueOnce(new Error('boom'));
  await handler(request({connectionId:CONNECTION,mode:'cash',accountId:10}),res as unknown as VercelResponse);
  await handler(request({connectionId:CONNECTION,mode:'cash',accountId:10}),res as unknown as VercelResponse);
  expect(mocks.read).toHaveBeenCalledTimes(3);
  expect(res.status).toHaveBeenLastCalledWith(503);
  await localDb.pg.exec("update public.tradovate_shared_reads set retry_at='-infinity'");
  await handler(request({connectionId:CONNECTION,mode:'cash',accountId:10}),res as unknown as VercelResponse);
  expect(mocks.read).toHaveBeenCalledTimes(4);
  expect(res.status).toHaveBeenLastCalledWith(200);
 });
 it('rejects invalid account IDs and propagates broker backoff',async()=>{
  const res=response();await handler(request({connectionId:CONNECTION,mode:'cash',accountId:-1}),res as unknown as VercelResponse);
  expect(res.status).toHaveBeenCalledWith(400);expect(mocks.read).not.toHaveBeenCalled();
  mocks.read.mockRejectedValue(Object.assign(new Error('limited'),{status:429,retryAfterMs:90000}));
  await handler(request({connectionId:CONNECTION,mode:'cash',accountId:10}),res as unknown as VercelResponse);
  expect(res.status).toHaveBeenCalledWith(429);expect(res.json).toHaveBeenCalledWith({error:'tradovate-rate-limited',retryAfterMs:90000});
 });
});
