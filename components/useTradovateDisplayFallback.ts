import { getTradovateApiTelemetrySnapshot } from '../lib/tradovateApiTelemetry';
import { useEffect, useRef, useState } from 'react';
import { createTradovateDisplayFallback } from '../lib/tradovateDisplayFallback';
import { createTradovateDisplayPoller, type DisplayPollState } from '../lib/tradovateDisplayPoller';
import { runTradovateAccountDisplayRead, runTradovateReadOnlyPreflight } from '../services/tradovateOAuthConnection';

export function useTradovateDisplayFallback(options: DisplayPollState) {
  const latest = useRef(options);
  latest.current = options;
  const [failure, setFailure] = useState<{userId:string;active:boolean}>({userId:options.userId,active:false});
  const membershipKey = JSON.stringify([...options.membership].map(([id,c]) => [id,c.environment,[...c.accountIds].sort()]).sort());
  useEffect(() => {
    const owner=options.userId;
    const poller=createTradovateDisplayPoller({
      current:()=>latest.current,
      visible:()=>document.visibilityState !== 'hidden',
      pausedUntil:()=>getTradovateApiTelemetrySnapshot().rateLimitedUntil ?? 0,
      failure:active=>setFailure({userId:owner,active}),
      read:createTradovateDisplayFallback({targeted:runTradovateAccountDisplayRead,legacy:id=>runTradovateReadOnlyPreflight(id,'full',AbortSignal.timeout(60_000))}),
    });
    document.addEventListener('visibilitychange',poller.resume);
    window.addEventListener('online',poller.resume);
    return ()=>{poller.stop();document.removeEventListener('visibilitychange',poller.resume);window.removeEventListener('online',poller.resume);};
  },[options.userId,membershipKey]);
  return failure.userId === options.userId && failure.active;
}
