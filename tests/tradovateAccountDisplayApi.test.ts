import { beforeEach,describe,expect,it,vi } from 'vitest';
import type { VercelRequest,VercelResponse } from '@vercel/node';
const mocks=vi.hoisted(()=>({auth:vi.fn(),token:vi.fn(),read:vi.fn()}));
vi.mock('../server/tradovateOAuthStore.js',()=>({createTradovateAdminClient:()=>({}),getValidTradovateAccessToken:mocks.token,readTradovateServerConfig:()=>({environment:'demo'}),requireSupabaseUserId:mocks.auth}));
vi.mock('../server/nativeCors.js',()=>({handleNativeCors:()=>false}));
vi.mock('../server/tradovateAccountDisplayRead.js',()=>({readTradovateAccountDisplay:mocks.read}));
import handler from '../api/tradovate/oauth/live-pnl';
const request=(body:Record<string,unknown>)=>({method:'POST',headers:{authorization:'Bearer app-session'},body}) as VercelRequest;
const response=()=>{const res={setHeader:vi.fn(),status:vi.fn(),json:vi.fn()};res.status.mockReturnValue(res);return res;};
describe('authenticated cash display mode',()=>{
 beforeEach(()=>{vi.clearAllMocks();mocks.auth.mockResolvedValue('owner');mocks.token.mockResolvedValue({accessToken:'broker-test'});mocks.read.mockResolvedValue({totalCashValue:0,dailyRealizedPnL:0});});
 it('binds the read to the authenticated owner and returns the explicit versioned envelope',async()=>{
  const res=response();await handler(request({connectionId:'c',mode:'cash',accountId:10}),res as unknown as VercelResponse);
  expect(mocks.token).toHaveBeenCalledWith(expect.objectContaining({userId:'owner',connectionId:'c'}));
  expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({accountId:10,accessToken:'broker-test',baseUrl:'https://demo.tradovateapi.com/v1'}));
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({kind:'account-display-v1',snapshot:expect.objectContaining({connectionId:'c',environment:'demo',accountId:10,fields:{totalCashValue:0,dailyRealizedPnL:0}})}));
 });
 it('cannot read without a valid app identity or an owned connection',async()=>{
  const res=response();mocks.auth.mockRejectedValue(new Error('invalid-auth-token'));
  await handler(request({connectionId:'c',mode:'cash',accountId:10}),res as unknown as VercelResponse);
  expect(res.status).toHaveBeenCalledWith(401);expect(mocks.read).not.toHaveBeenCalled();
  mocks.auth.mockResolvedValue('owner');mocks.token.mockRejectedValue(new Error('tradovate-not-connected'));
  await handler(request({connectionId:'other',mode:'cash',accountId:10}),res as unknown as VercelResponse);
  expect(res.status).toHaveBeenCalledWith(409);expect(mocks.read).not.toHaveBeenCalled();
 });
 it('rejects invalid account IDs and propagates broker backoff',async()=>{
  const res=response();await handler(request({connectionId:'c',mode:'cash',accountId:-1}),res as unknown as VercelResponse);
  expect(res.status).toHaveBeenCalledWith(400);expect(mocks.read).not.toHaveBeenCalled();
  mocks.read.mockRejectedValue(Object.assign(new Error('limited'),{status:429,retryAfterMs:90000}));
  await handler(request({connectionId:'c',mode:'cash',accountId:10}),res as unknown as VercelResponse);
  expect(res.status).toHaveBeenCalledWith(429);expect(res.json).toHaveBeenCalledWith({error:'tradovate-rate-limited',retryAfterMs:90000});
 });
});
