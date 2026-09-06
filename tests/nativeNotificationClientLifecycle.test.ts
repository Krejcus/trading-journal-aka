import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pending: new Map<number, any>(),
  listeners: new Map<string, (value: any) => void>(),
  check: vi.fn(), request: vi.fn(), register: vi.fn(), unregister: vi.fn(),
  localSchedule: vi.fn(), localCancel: vi.fn(), removeDelivered: vi.fn(),
  clearBadge: vi.fn(), setBadge: vi.fn(), navigate: vi.fn(), capture: vi.fn(),
  fetch: vi.fn(), session: vi.fn(),
}));

vi.mock('../utils/runtimeConfig', () => ({isNativeBuild:true, apiUrl:(path:string) => `https://review.invalid${path}`}));
vi.mock('../utils/nativeShell', () => ({navigateNativeShell:mocks.navigate, openNativeTradeCapture:mocks.capture}));
vi.mock('../services/nativeCapabilities', () => ({clearNativeBadgeCount:mocks.clearBadge, setNativeBadgeCount:mocks.setBadge}));
vi.mock('../services/supabase', () => ({supabase:{auth:{getSession:mocks.session}}}));
vi.mock('../services/alphaTradeNativePlugin', () => ({alphaTradeNativePlugin:{getPushEnvironment:async () => ({environment:'development'})}}));
vi.mock('@capacitor/push-notifications', () => ({PushNotifications:{
  checkPermissions:mocks.check, requestPermissions:mocks.request,
  register:mocks.register, unregister:mocks.unregister,
  addListener:async (name:string, callback:(value:any)=>void) => {
    mocks.listeners.set(name, callback);
    return {remove:async () => {if(mocks.listeners.get(name) === callback) mocks.listeners.delete(name);}};
  },
}}));
vi.mock('@capacitor/local-notifications', () => ({
  Weekday:{Sunday:1,Monday:2,Tuesday:3,Wednesday:4,Thursday:5,Friday:6,Saturday:7},
  LocalNotifications:{
    checkPermissions:async () => ({display:'granted'}), requestPermissions:async () => ({display:'granted'}),
    getPending:async () => ({notifications:[...mocks.pending.values()]}),
    schedule:mocks.localSchedule, cancel:mocks.localCancel,
    removeAllDeliveredNotifications:mocks.removeDelivered,
    registerActionTypes:async () => undefined,
    addListener:async () => ({remove:async () => undefined}),
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.pending.clear(); mocks.listeners.clear();
  const storage = new Map<string,string>();
  vi.stubGlobal('localStorage', {getItem:(key:string)=>storage.get(key)??null, setItem:(key:string,value:string)=>storage.set(key,value), removeItem:(key:string)=>storage.delete(key)});
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.clearBadge.mockResolvedValue(undefined); mocks.setBadge.mockResolvedValue(undefined);
  mocks.removeDelivered.mockResolvedValue(undefined);
  mocks.check.mockResolvedValue({receive:'granted'}); mocks.request.mockResolvedValue({receive:'granted'});
  mocks.unregister.mockResolvedValue(undefined);
  mocks.session.mockResolvedValue({data:{session:{user:{id:'user-a'},access_token:'test-token'}}});
  mocks.fetch.mockResolvedValue({ok:true});
  mocks.register.mockImplementation(async () => {mocks.listeners.get('registration')?.({value:'ab'.repeat(32)});});
  mocks.localSchedule.mockImplementation(async ({notifications}) => {notifications.forEach((item:any)=>mocks.pending.set(item.id,item));});
  mocks.localCancel.mockImplementation(async ({notifications}) => {notifications.forEach((item:any)=>mocks.pending.delete(item.id));});
});
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});

describe('notification source and shared actions', () => {
  it('test cleanup retains real and legacy copier timers, delivered alerts and badge', async () => {
    const service = await import('../services/nativeNotifications');
    const real = await service.scheduleNativeNotification({title:'ARM deadline',body:'Verify status',source:'copierTimer',actionType:'risk'});
    const generic = await service.scheduleNativeNotification({title:'App reminder',body:'Real'});
    const test = await service.scheduleNativeNotification({title:'Test',body:'Only test',source:'test'});
    mocks.pending.set(42,{id:42,title:'Legacy timer',body:'',extra:{source:'test'}});
    localStorage.setItem('alphatrade-copier-notification-slots',JSON.stringify([{key:'arm-expiry',at:Date.now()+60_000,id:42}]));
    expect(await service.cancelPendingNativeTestNotifications()).toBe(1);
    expect([...mocks.pending.keys()].sort()).toEqual([real,generic,42].sort());
    expect(mocks.pending.has(test)).toBe(false);
    expect(mocks.removeDelivered).not.toHaveBeenCalled();
    expect(mocks.clearBadge).not.toHaveBeenCalled();
  });

  it('remote actions override route and retain typed notes plus the draft', async () => {
    const push = await import('../services/nativePushNotifications');
    expect(await push.initializeNativeRemoteNotifications('user-a')).toBe(true);
    const callback = mocks.listeners.get('pushNotificationActionPerformed')!;
    callback({actionId:'OPEN_JOURNAL',notification:{data:{route:'live'}}});
    expect(mocks.navigate).toHaveBeenLastCalledWith('journal');
    callback({actionId:'ADD_TRADE_NOTE',inputValue:'  Avoid chasing  ',notification:{data:{route:'live',draft:{instrument:'MNQ',entryPrice:'20000',notes:'Existing'}}}});
    expect(mocks.capture).toHaveBeenLastCalledWith({instrument:'MNQ',entryPrice:'20000',notes:'Existing\n\nPoznámka z iOS notifikace:\nAvoid chasing'});
    callback({actionId:'OPEN_COACH',notification:{data:{route:'live'}}});
    expect(mocks.navigate).toHaveBeenLastCalledWith('ai');
    callback({actionId:'CAPTURE_TRADE',notification:{data:{draft:{instrument:'NQ',positionSize:'2'}}}});
    expect(mocks.capture).toHaveBeenLastCalledWith({instrument:'NQ',positionSize:'2'});
    expect(mocks.clearBadge).toHaveBeenCalledTimes(4);
    callback({actionId:'dismiss',notification:{data:{route:'live'}}});
    expect(mocks.clearBadge).toHaveBeenCalledTimes(4);
  });

  it('logout removes a notification that finishes scheduling after cleanup', async () => {
    const service = await import('../services/nativeNotifications');
    let finish!:()=>void;
    mocks.localSchedule.mockImplementationOnce(async ({notifications}) => {
      await new Promise<void>(resolve=>{finish=resolve;});
      notifications.forEach((item:any)=>mocks.pending.set(item.id,item));
    });
    const scheduling = service.scheduleNativeNotification({title:'old user',body:'private'});
    const rejected = expect(scheduling).rejects.toThrow('odhlášením');
    await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
    await service.cancelAllNativeNotifications();
    finish();
    await rejected;
    expect(mocks.pending.size).toBe(0);
    expect(mocks.removeDelivered).toHaveBeenCalledOnce();
  });
});

describe('recoverable APNs registration', () => {
  it('rechecks a denied permission when it becomes granted in Settings', async () => {
    const service = await import('../services/nativePushNotifications');
    mocks.check.mockResolvedValueOnce({receive:'denied'});
    mocks.request.mockResolvedValueOnce({receive:'denied'});
    expect(await service.initializeNativeRemoteNotifications('user-a')).toBe(false);
    expect(await service.initializeNativeRemoteNotifications('user-a')).toBe(true);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(mocks.register).toHaveBeenCalledOnce();
  });

  it('retries HTTP failure and coalesces only overlapping callers', async () => {
    const service = await import('../services/nativePushNotifications');
    mocks.fetch.mockResolvedValueOnce({ok:false});
    const a = service.initializeNativeRemoteNotifications('user-a');
    const b = service.initializeNativeRemoteNotifications('user-a');
    expect(a).toBe(b);
    expect(await a).toBe(false);
    expect(await service.initializeNativeRemoteNotifications('user-a')).toBe(true);
    expect(mocks.register).toHaveBeenCalledTimes(2);
  });

  it('retries after a token callback timeout', async () => {
    vi.useFakeTimers();
    const service = await import('../services/nativePushNotifications');
    mocks.register.mockResolvedValueOnce(undefined);
    const first = service.initializeNativeRemoteNotifications('user-a');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await first).toBe(false);
    expect(await service.initializeNativeRemoteNotifications('user-a')).toBe(true);
  });

  it('disables local APNs and drops old callbacks even when remote revoke fails', async () => {
    const service = await import('../services/nativePushNotifications');
    await service.initializeNativeRemoteNotifications('user-a');
    const oldCallback = mocks.listeners.get('registration')!;
    mocks.fetch.mockResolvedValueOnce({ok:false});
    await expect(service.deactivateNativeRemoteNotifications('user-a')).rejects.toThrow('nebylo potvrzené');
    oldCallback({value:'cd'.repeat(32)});
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.unregister).toHaveBeenCalledOnce();
    expect(mocks.listeners.size).toBe(0);
  });

  it('bounds a hung revoke and still disables local APNs', async () => {
    vi.useFakeTimers();
    const service = await import('../services/nativePushNotifications');
    await service.initializeNativeRemoteNotifications('user-a');
    mocks.fetch.mockImplementationOnce(()=>new Promise(()=>{}));
    const result = service.deactivateNativeRemoteNotifications('user-a');
    const failure = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(12_000);
    await failure;
    expect(mocks.unregister).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight token POST before revoking it', async () => {
    const service = await import('../services/nativePushNotifications');
    let finishPost!:(result:{ok:boolean})=>void;
    mocks.fetch.mockImplementationOnce(()=>new Promise(resolve=>{finishPost=resolve;}));
    const initializing = service.initializeNativeRemoteNotifications('user-a');
    await vi.waitFor(()=>expect(finishPost).toBeTypeOf('function'));
    const logout = service.deactivateNativeRemoteNotifications('user-a');
    await Promise.resolve();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    finishPost({ok:true});
    expect(await initializing).toBe(false);
    await logout;
    expect(mocks.fetch.mock.calls.map(call=>call[1].method)).toEqual(['POST','DELETE']);
  });
});

describe('copier timer reconciliation', () => {
  const controller = () => ({armed:true,shadowMode:false,killSwitch:false,stuckOutbox:false,connected:true,reconciliationRequired:false,divergentAccounts:[],lastError:null,armExpiresAt:Date.now()+60_000,entryCooldownUntil:0,dayLockUntil:0,dayLockReason:null,resumeOffer:null,autoClose:null,recentCopyEvents:[]});

  it('recreates a persisted timer missing from iOS and serializes overlapping polls', async () => {
    const service = await import('../services/nativeCopierNotifications');
    const status = controller();
    localStorage.setItem('alphatrade-copier-notification-slots',JSON.stringify([{key:'arm-expiry',at:status.armExpiresAt,id:42}]));
    await Promise.all([service.syncCopierNativeNotifications(status as any),service.syncCopierNativeNotifications(status as any)]);
    expect(mocks.localSchedule).toHaveBeenCalledOnce();
    expect([...mocks.pending.values()][0].extra.source).toBe('copierTimer');
    expect(JSON.parse(localStorage.getItem('alphatrade-copier-notification-slots')!)[0].id).not.toBe(42);
  });

  it('invalidates queued copier polls on logout', async () => {
    const service = await import('../services/nativeCopierNotifications');
    const pending = service.syncCopierNativeNotifications(controller() as any);
    service.clearCopierNativeNotificationState();
    await pending;
    expect(mocks.localSchedule).not.toHaveBeenCalled();
    expect(localStorage.getItem('alphatrade-copier-notification-slots')).toBeNull();
  });
});

describe('session reminder lifecycle', () => {
  it('reserves existing pending slots and reports omitted audit reminders', async () => {
    const service = await import('../services/nativeSessionReminders');
    for (let id=1;id<=59;id++) mocks.pending.set(id,{id,title:'Other',body:'',extra:{source:'app'}});
    const result = await service.syncNativeSessionReminders([], {eveningAuditAlertEnabled:true,eveningAuditAlertTime:'21:00',sessionAlertsEnabled:false} as any);
    expect(result).toEqual({status:'scheduled',scheduledCount:1,omittedCount:4});
    expect(mocks.pending.size).toBe(60);
  });

  it('invalidates a queued reminder sync during logout', async () => {
    const service = await import('../services/nativeSessionReminders');
    const result = service.syncNativeSessionReminders([], {eveningAuditAlertEnabled:true,eveningAuditAlertTime:'21:00',sessionAlertsEnabled:false} as any);
    service.clearNativeSessionReminderState();
    expect(await result).toEqual({status:'disabled',scheduledCount:0,omittedCount:0});
    expect(mocks.localSchedule).not.toHaveBeenCalled();
  });
});
