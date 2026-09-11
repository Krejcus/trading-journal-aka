import type { TradovateAccountDisplayFeedState, TradovateAccountDisplaySnapshot } from './tradovateAccountDisplayTypes';
export type DisplayMembership = ReadonlyMap<string, {environment:'demo'|'live';accountIds:ReadonlySet<number>}>;
export interface DisplayPollState {
 userId:string;
 membership:DisplayMembership;
 worker:{userId:string;receivedAt:number;feeds:TradovateAccountDisplayFeedState[]}|null;
 publish:(userId:string,feeds:TradovateAccountDisplayFeedState[])=>void;
}
/** One sequential poller per mounted identity; timers never act as confirmations. */
export function createTradovateDisplayPoller(options:{
 current:()=>DisplayPollState;
 visible:()=>boolean;
 pausedUntil?:()=>number;
 failure:(active:boolean)=>void;
 read:(connectionId:string,environment:'demo'|'live',accountId:number)=>Promise<{snapshots:TradovateAccountDisplaySnapshot[];legacy:boolean}>;
}) {
 const owner=options.current().userId;
 const read=options.read;
    const due = new Map<string,number>();
    const cursors = new Map<string,number>();
    const failed = new Set<string>();
    const attempts = new Map<string,number>();
    let stopped = false;
    let busy = false;
    let blockedUntil = 0;
    let timer: ReturnType<typeof setTimeout>;
    for (const id of options.current().membership.keys()) due.set(id, Date.now() + 30_000);
    const poll = async () => {
      if (stopped || busy || options.current().userId !== owner) return;
      busy = true;
      try {
        if (!options.visible()) return;
        if (Date.now() < Math.max(blockedUntil, options.pausedUntil?.() ?? 0)) { options.failure(true); return; }
        for (const [id, connection] of options.current().membership) {
          if ((due.get(id) ?? 0) > Date.now()) continue;
          const worker = options.current().worker;
          const feed = worker?.userId === owner && Date.now() - worker.receivedAt < 15_000
            ? worker.feeds.find(item => item.connectionId === id && item.environment === connection.environment) : null;
          const workerRetryAt = Date.parse(feed?.retryAt ?? '');
          if (Number.isFinite(workerRetryAt) && workerRetryAt > Date.now()) {
            due.set(id, workerRetryAt); failed.add(id); continue;
          }
          if (feed && feed.streamConnected === true && !feed.lastErrorAt && [...connection.accountIds].every(accountId => feed.snapshots.some(s => s.accountId === accountId && typeof s.fields?.dailyRealizedPnL === 'number' && Date.now() - Date.parse(s.confirmedAt) < 11 * 60_000))) {
            failed.delete(id); due.set(id, Date.now() + 10_000); continue;
          }
          const ids = [...connection.accountIds];
          if (!ids.length) continue;
          const cursor = cursors.get(id) ?? 0;
          try {
            const result = await read(id, connection.environment, ids[cursor % ids.length]);
            if (stopped || options.current().userId !== owner) return;
            options.current().publish(owner, [{ connectionId:id, environment:connection.environment, snapshots:result.snapshots, pendingAccountIds:[], lastErrorAt:null, retryAt:null }]);
            cursors.set(id, cursor + 1); failed.delete(id); attempts.delete(id);
            due.set(id, Date.now() + (result.legacy ? 60_000 : Math.max(5_000, 60_000 / ids.length)));
          } catch (error) {
            if (stopped) return;
            failed.add(id);
            const count = (attempts.get(id) ?? 0) + 1; attempts.set(id,count);
            const e = error as {status?:number;retryAfterMs?:number};
            const delay = e.status === 429 ? Math.max(1_000,e.retryAfterMs ?? 60_000) : Math.min(60_000, 5_000 * 2 ** Math.min(count-1,4));
            due.set(id, Date.now() + delay);
            if (e.status === 429) blockedUntil = Date.now() + delay;
          }
          break; // At most one connection/account read per cycle.
        }
        options.failure(failed.size > 0);
      } finally {
        busy = false;
        if (!stopped) timer = setTimeout(() => void poll(), 5_000);
      }
    };
    const resume = () => {
      if (options.visible() && !busy) {
        clearTimeout(timer); void poll();
      }
    };
    timer = setTimeout(() => void poll(), 5_000);
    return { resume, stop() { stopped=true; clearTimeout(timer); } };
}
