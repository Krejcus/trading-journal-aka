import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createTradovateAdminClient, readTradovateServerConfig } from '../../../server/tradovateOAuthStore.js';
import { authorizeTradovateCopierDevice } from '../../../server/tradovateCopierDevice.js';
import { createServerTradovateRequestControl, TradovateRequestControlError } from '../../../server/tradovateServerRequestControl.js';
import { handleNativeCors } from '../../../server/nativeCors.js';
import type { TradovateRequestPenalty, TradovateRequestPurpose } from '../../../lib/tradovateRequestControl.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export default async function handler(req: VercelRequest,res: VercelResponse) {
  if(handleNativeCors(req,res,['POST']))return;
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({error:'method-not-allowed'});
  try {
    const config=readTradovateServerConfig(); const db=createTradovateAdminClient(config);
    const device=await authorizeTradovateCopierDevice({db,authorization:req.headers.authorization,touchLastUsed:false});
    const connectionId=typeof req.body?.connectionId==='string'?req.body.connectionId:device.connectionId;
    if(!UUID.test(connectionId))return res.status(400).json({error:'invalid-request-control-connection'});
    if(connectionId!==device.connectionId&&device.scope!=='owner')return res.status(403).json({error:'copier-device-scope-required'});
    const {data:connection,error}=await db.from('tradovate_oauth_connections').select('id,tradovate_user_id')
      .eq('id',connectionId).eq('user_id',device.userId).eq('environment',config.environment).eq('connection_status','connected')
      .maybeSingle<{id:string;tradovate_user_id:number|null}>();
    if(error)throw new TradovateRequestControlError('tradovate-request-control-unavailable');
    if(!connection)return res.status(404).json({error:'tradovate-connection-not-found'});
    const control=createServerTradovateRequestControl({db,userId:device.userId,connectionId,brokerUserId:connection.tradovate_user_id});
    if(req.body?.mode==='read')return res.status(200).json({snapshot:await control.read()});
    if(req.body?.mode==='reserve'){
      const {grantId,purpose,units,ttlMs}=req.body;
      if(typeof grantId!=='string'||!UUID.test(grantId)||!['background','risk','entry','control'].includes(purpose)
        ||!Number.isSafeInteger(units)||units<1||units>64||!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>15000)
        return res.status(400).json({error:'invalid-request-control-reservation'});
      return res.status(200).json({grant:await control.reserve({grantId,purpose:purpose as TradovateRequestPurpose,units,ttlMs})});
    }
    if(req.body?.mode==='penalize'){
      const p=req.body.penalty as TradovateRequestPenalty|undefined;
      if(!p||!['raw-429','retry-after','p-time','captcha'].includes(p.evidence)||!Number.isSafeInteger(p.retryAfterMs)||p.retryAfterMs<0
        ||p.retryAfterMs>8e15||typeof p.reason!=='string'||p.reason.length>200||p.evidence==='captcha'&&p.captchaRequired!==true)
        return res.status(400).json({error:'invalid-request-control-penalty'});
      return res.status(200).json({snapshot:await control.penalize(p)});
    }
    return res.status(400).json({error:'invalid-request-control-mode'});
  }catch(error){
    if(error instanceof TradovateRequestControlError)return res.status(503).json({error:error.code,retryAfterMs:error.retryAfterMs,snapshot:error.snapshot});
    if(error instanceof Error&&error.message==='invalid-copier-device-auth')return res.status(401).json({error:error.message});
    return res.status(503).json({error:'tradovate-request-control-unavailable'});
  }
}
