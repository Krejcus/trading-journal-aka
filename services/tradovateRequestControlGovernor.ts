import { TRADOVATE_REQUEST_CONTROL_POLICY as POLICY, isTradovateRequestGrant, monotonicGrantDeadline, isTradovateControlSnapshot, TradovateRemoteControlError, type TradovateRequestControlRemote, type TradovateRequestControlSnapshot,
  type TradovateRequestGrant, type TradovateRequestHealth, type TradovateRequestPenalty, type TradovateRequestPurpose } from '../lib/tradovateRequestControl';
import { createTradovateUsageMeter } from '../lib/tradovateUsageMeter';
import { BrokerRequestNotSentError } from './brokerPort';

export interface TradovateRequestControlDurableState {
  version: 1;
  brokerUserId: number;
  savedAt: number;
  blockedUntil: number | null;
  remainingMs: number;
  captchaRequired: boolean;
  evidence: TradovateRequestPenalty['evidence'] | null;
  reason: string | null;
}
export interface TradovateRequestControlStore {
  load(brokerUserId: number): Promise<TradovateRequestControlDurableState | null>;
  save(state: TradovateRequestControlDurableState): Promise<void>;
}
export class TradovateRequestControlError extends BrokerRequestNotSentError {
  constructor(readonly controlReason: 'budget' | 'cooldown' | 'captcha' | 'unavailable', message: string) { super(message); this.name = 'TradovateRequestControlError'; }
}
export interface TradovateRequestPermit { readonly owner: TradovateRequestGovernor; readonly epoch: number; readonly expiresMono: number; readonly purpose: TradovateRequestPurpose; consumed: boolean }
export interface TradovateRequestGovernor {
  readonly brokerUserId: number;
  initialize(): Promise<void>;
  sync(): Promise<void>;
  prepare(purpose: TradovateRequestPurpose): Promise<TradovateRequestPermit | null>;
  /** Synchronous final wire barrier. Returns a completion release, never queues a write. */
  dispatch(purpose: TradovateRequestPurpose, permit?: TradovateRequestPermit | null): () => void;
  response(): void;
  transportUnknown(): void;
  penalize(penalty: TradovateRequestPenalty): Promise<void>;
  /** Temporary local fence while423 body is inspected; does not invent a broker duration. */
  holdPenaltyInspection(reason: string): () => void;
  newRiskBlocker(): string | null;
  health(): TradovateRequestHealth;
}

export function createTradovateRequestGovernor(options: {
  brokerUserId: number;
  remote: TradovateRequestControlRemote;
  store: TradovateRequestControlStore;
  clock?: () => number;
  monotonic?: () => number;
  uuid?: () => string;
  wait?: (ms: number) => Promise<void>;
}): TradovateRequestGovernor {
  if (!Number.isSafeInteger(options.brokerUserId) || options.brokerUserId <= 0) throw new Error('request-control-broker-identity-missing');
  const clock = options.clock ?? Date.now, mono = options.monotonic ?? (() => performance.now());
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const management = createTradovateUsageMeter(clock);
  let initialized = false, initializePromise: Promise<void> | null = null, syncPromise: Promise<void> | null = null;
  let persistence: Promise<void> = Promise.resolve(), persistPending = 0, failed: string | null = null;
  let snapshot: TradovateRequestControlSnapshot | null = null, controlDeadline = -Infinity;
  let blockMono = -Infinity, blockWall: number | null = null, captcha = false;
  let evidence: TradovateRequestPenalty['evidence'] | null = null, reason: string | null = null;
  let penaltyInspections = 0;
  let authorityReconciliationRequired = false, authorityRevision = 0;
  let inspectionReason = 'Tradovate penalty is being inspected';
  let grant: { value: TradovateRequestGrant; available: number; deadline: number } | null = null;
  let reservation: Promise<void> | null = null, reservationStarted = -Infinity, activeBackground = 0, pendingBackground = 0;
  const burst: number[] = [];
  const preparedBackground = new Set<TradovateRequestPermit>();
  const preparedPriority = new Set<TradovateRequestPermit>();
  const prioritySlots = { risk: 0, control: 0 };
  const hasBackgroundCapacity = () => {
    for (const permit of preparedBackground) if (mono() >= permit.expiresMono) preparedBackground.delete(permit);
    while (burst.length && mono() - burst[0] >= 1_000) burst.shift();
    return activeBackground + preparedBackground.size < POLICY.backgroundConcurrency
      && burst.length + preparedBackground.size < POLICY.backgroundBurst;
  };
  const counts = { dispatchAttempts: 0, blockedBeforeDispatch: 0, responses: 0, transportUnknown: 0 };
  const deny = (kind: TradovateRequestControlError['controlReason'], message: string): never => { counts.blockedBeforeDispatch += 1; throw new TradovateRequestControlError(kind, message); };
  const retireExpiredCooldown = (): Promise<void> | null => {
    if (!initialized || failed || captcha || blockWall == null || mono() < blockMono) return null;
    // Persist the completed monotonic wait once; later restarts must not revive an old remaining duration.
    blockWall = null; blockMono = -Infinity;
    return save(false);
  };
  const hardProblem = (): TradovateRequestControlError | null => {
    void retireExpiredCooldown()?.catch(() => {});
    return !initialized || failed || persistPending > 0 || penaltyInspections > 0 || authorityReconciliationRequired
    ? new TradovateRequestControlError('unavailable', failed ?? (authorityReconciliationRequired ? 'A hard broker refusal needs a fresh authority reconciliation' : penaltyInspections > 0 ? inspectionReason : 'Request control is not durably ready'))
    : captcha ? new TradovateRequestControlError('captcha', reason ?? 'Tradovate captcha requires manual intervention')
      : mono() < blockMono ? new TradovateRequestControlError('cooldown', reason ?? 'Tradovate cooldown active') : null;
  };
  const admissionProblem = (newRisk = false): string | null => {
    const hard = hardProblem(); if (hard) return hard.message;
    if (!snapshot || mono() >= controlDeadline) return 'Shared request-control state is stale or unavailable';
    if (snapshot.backgroundReservedHour >= POLICY.backgroundHour || snapshot.backgroundReservedMinute >= POLICY.backgroundMinute
      || newRisk && ((snapshot.riskReservedHour ?? 0) >= POLICY.riskHour || (snapshot.riskReservedMinute ?? 0) >= POLICY.riskMinute
        || (snapshot.controlReservedHour ?? 0) >= POLICY.controlHour || (snapshot.controlReservedMinute ?? 0) >= POLICY.controlMinute)
      || snapshot.totalReservedHour != null && snapshot.totalReservedHour >= POLICY.totalSoftHour
      || snapshot.backgroundReservedHour + management.snapshot().hour >= POLICY.totalSoftHour) return 'Application request budget exhausted; accepted management remains available';
    return null;
  };
  const applyRemote = (value: TradovateRequestControlSnapshot, started: number) => {
    if (!isTradovateControlSnapshot(value) || value.brokerUserId !== options.brokerUserId) throw new Error('request-control-identity-or-snapshot-invalid');
    // Equal timestamps cannot establish a newer authority observation. Merge only
    // conservative counters and never renew freshness from a reordered response.
    if (snapshot && (value.epoch < snapshot.epoch || value.epoch === snapshot.epoch && value.serverNow <= snapshot.serverNow)) {
      if (value.epoch === snapshot.epoch && value.serverNow === snapshot.serverNow) {
        for (const key of ['backgroundReservedHour', 'backgroundReservedMinute', 'riskReservedHour', 'riskReservedMinute',
          'controlReservedHour', 'controlReservedMinute', 'totalReservedHour'] as const) {
          const incoming = value[key]; if (incoming != null) snapshot[key] = Math.max(snapshot[key] ?? 0, incoming);
        }
      }
      return false;
    }
    snapshot = { ...value };
    controlDeadline = started + POLICY.maxControlAgeMs;
    // A cooldown is conservative from response arrival; grant expiry separately subtracts RTT.
    if (value.blockedUntil != null) {
      const remaining = Math.max(0, value.blockedUntil - value.serverNow);
      if (remaining > 0 && mono() + remaining > blockMono) { blockMono = mono() + remaining; blockWall = clock() + Math.max(0, blockMono - mono()); evidence = value.evidence; reason = value.reason; }
    }
    captcha ||= value.captchaRequired;
    return true;
  };
  const save = (blockDispatch = true) => {
    if (blockDispatch) persistPending += 1;
    const run = persistence.then(() => options.store.save({ version: 1, brokerUserId: options.brokerUserId, savedAt: clock(), blockedUntil: blockWall,
      remainingMs: Math.max(0, blockMono - mono()), captchaRequired: captcha, evidence, reason }));
    persistence = run.catch(error => { failed = `Request cooldown persistence failed: ${error instanceof Error ? error.message : String(error)}`; });
    return run.finally(() => { if (blockDispatch) persistPending -= 1; });
  };
  const self: TradovateRequestGovernor = {
    brokerUserId: options.brokerUserId,
    initialize() {
      if (initializePromise) return initializePromise;
      initializePromise = (async () => {
        const saved = await options.store.load(options.brokerUserId);
        if (saved) {
          if (saved.version !== 1 || saved.brokerUserId !== options.brokerUserId || !Number.isFinite(saved.savedAt) || !Number.isFinite(saved.remainingMs) || saved.remainingMs < 0
            || saved.blockedUntil != null && !Number.isFinite(saved.blockedUntil)) throw new Error('request-control-durable-state-invalid');
          captcha = saved.captchaRequired; evidence = saved.evidence; reason = saved.reason; blockWall = saved.blockedUntil;
          // Restart may conservatively extend a wait. Neither a forward nor backward clock jump may shorten it.
          const remaining = Math.max(saved.remainingMs, (saved.blockedUntil ?? 0) - clock(), 0);
          blockMono = mono() + remaining;
        }
        initialized = true;
        await self.sync();
      })().catch(error => { failed = error instanceof Error ? error.message : String(error); throw error; });
      return initializePromise;
    },
    sync() {
      if (syncPromise) return syncPromise;
      const started = mono();
      const revision = authorityRevision;
      syncPromise = options.remote.read().then(async value => {
        const old = blockMono, oldCaptcha = captcha;
        const accepted = applyRemote(value, started);
        if (blockMono > old || captcha !== oldCaptcha) await save();
        if (accepted && revision === authorityRevision && mono() < controlDeadline) authorityReconciliationRequired = false;
        await retireExpiredCooldown();
      }).finally(() => { syncPromise = null; });
      return syncPromise;
    },
    async prepare(purpose) {
      const hard = hardProblem(); if (hard) return deny(hard.controlReason, hard.message);
      if (purpose === 'management' || purpose === 'entry') return null;
      if (purpose === 'risk' || purpose === 'control') {
        if (!snapshot || snapshot.policyVersion !== POLICY.capacityVersion || mono() >= controlDeadline) return deny('unavailable', 'Priority read capacity requires the current shared authority');
        for (const permit of preparedPriority) if (mono() >= permit.expiresMono) { preparedPriority.delete(permit); prioritySlots[permit.purpose as 'risk' | 'control'] -= 1; }
        const capacityDeadline = mono() + POLICY.grantTtlMs;
        while (prioritySlots[purpose] >= 4) {
          if (mono() >= capacityDeadline) return deny('budget', 'Priority read concurrency wait expired');
          await wait(25);
          const blocked = hardProblem(); if (blocked) return deny(blocked.controlReason, blocked.message);
          if (!snapshot || mono() >= controlDeadline) return deny('unavailable', 'Priority read authority is stale');
        }
        prioritySlots[purpose] += 1;
        const started = mono(), grantId = uuid();
        try {
          const value = await options.remote.reserve({ grantId, purpose, units: 1, ttlMs: POLICY.grantTtlMs });
          if (!isTradovateRequestGrant(value) || value.brokerUserId !== options.brokerUserId || value.grantId !== grantId
            || value.purpose !== purpose || value.units !== 1 || value.epoch !== snapshot?.epoch || value.validUntil - value.serverNow > POLICY.grantTtlMs) throw new Error('request-control-grant-invalid');
          const permit = { owner: self, epoch: value.epoch, expiresMono: monotonicGrantDeadline(started, value.serverNow, value.validUntil), purpose, consumed: false };
          const blocked = hardProblem(); if (blocked) return deny(blocked.controlReason, blocked.message);
          if (mono() >= permit.expiresMono || mono() >= controlDeadline) return deny('unavailable', 'Priority read authority or grant expired');
          preparedPriority.add(permit); return permit;
        } catch (error) {
          prioritySlots[purpose] -= 1;
          // The same typed refusal path must latch a broker penalty for every lane.
          if (error instanceof TradovateRemoteControlError) {
            if ((error.kind === 'cooldown' || error.kind === 'captcha')
              && (!isTradovateControlSnapshot(error.snapshot) || error.snapshot.brokerUserId !== options.brokerUserId)) { authorityRevision += 1; authorityReconciliationRequired = true; }
            if (error.snapshot) {
              const old = blockMono, oldCaptcha = captcha; applyRemote(error.snapshot, started);
              if (blockMono > old || captcha !== oldCaptcha) await save();
            } else if (error.kind === 'cooldown' || error.kind === 'captcha') { authorityRevision += 1; authorityReconciliationRequired = true; }
            const hard = hardProblem(); if (hard) return deny(hard.controlReason, hard.message);
            if (error.kind === 'budget') return deny('budget', 'Priority read budget exhausted');
          }
          controlDeadline = -Infinity;
          if (error instanceof TradovateRequestControlError) throw error;
          return deny('unavailable', `Priority reservation unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      pendingBackground += 1;
      try {
      const deadline = mono() + POLICY.grantTtlMs;
      let waitedMs = 0;
      // Only background readers wait. A prepared permit reserves a short capacity slot, so
      // concurrent token awaits cannot all pass the same empty concurrency observation.
      for (;;) {
        const blocked = hardProblem(); if (blocked) return deny(blocked.controlReason, blocked.message);
        if (waitedMs > 0 && (mono() >= deadline || waitedMs >= POLICY.grantTtlMs)) return deny('budget', 'Background capacity wait expired');
        const problem = admissionProblem(); if (problem) return deny(snapshot && mono() < controlDeadline ? 'budget' : 'unavailable', problem);
        if (!hasBackgroundCapacity()) {
          if (mono() >= deadline || waitedMs >= POLICY.grantTtlMs) return deny('budget', 'Background capacity wait expired');
          const delay = Math.min(25, Math.max(1, deadline - mono()));
          waitedMs += delay; await wait(delay); continue;
        }
        if (!grant || grant.available <= 0 || mono() >= grant.deadline || grant.value.epoch !== snapshot!.epoch) {
          if (!reservation) {
            const started = mono(), grantId = uuid();
            reservationStarted = started;
            // Reserve only work already waiting, never a speculative future pool.
            const units = Math.max(1, Math.min(POLICY.grantPool, pendingBackground,
              POLICY.backgroundConcurrency - activeBackground - preparedBackground.size,
              POLICY.backgroundHour - snapshot!.backgroundReservedHour,
              POLICY.backgroundMinute - snapshot!.backgroundReservedMinute));
            reservation = options.remote.reserve({ grantId, purpose: 'background', units, ttlMs: POLICY.grantTtlMs }).then(value => {
              if (!isTradovateRequestGrant(value) || value.grantId !== grantId || value.brokerUserId !== options.brokerUserId || value.purpose !== 'background' || value.units !== units
                || value.epoch !== snapshot?.epoch || value.validUntil - value.serverNow > POLICY.grantTtlMs) throw new Error('request-control-grant-invalid');
              grant = { value, available: value.units, deadline: monotonicGrantDeadline(started, value.serverNow, value.validUntil) };
            }).finally(() => { reservation = null; });
          }
          try { await reservation; } catch (error) {
            if (error instanceof TradovateRemoteControlError && (error.kind === 'cooldown' || error.kind === 'captcha') && (!isTradovateControlSnapshot(error.snapshot) || error.snapshot.brokerUserId !== options.brokerUserId)) {
              authorityRevision += 1;
              authorityReconciliationRequired = true;
            }
            if (error instanceof TradovateRemoteControlError && error.snapshot) {
              // A refusal carries a fresh authority snapshot. Persist its hard fence
              // before exposing the error; never use HTTP503 as a substitute for it.
              const old = blockMono, oldCaptcha = captcha;
              applyRemote(error.snapshot, reservationStarted);
              if (blockMono > old || captcha !== oldCaptcha) await save();
              const hard = hardProblem();
              if (hard) return deny(hard.controlReason, hard.message);
              if (error.kind === 'budget') return deny('budget', 'Application request budget exhausted; accepted management remains available');
            }
            controlDeadline = -Infinity;
            return deny('unavailable', `Background reservation unavailable: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        // Reservation is an await boundary. Recheck all local/shared/capacity fences afterwards.
        const after = hardProblem(); if (after) return deny(after.controlReason, after.message);
        const changed = admissionProblem(); if (changed) return deny(snapshot && mono() < controlDeadline ? 'budget' : 'unavailable', changed);
        if (!hasBackgroundCapacity()) continue;
        if (!grant || mono() >= grant.deadline || grant.value.epoch !== snapshot!.epoch) return deny('budget', 'Background grant expired or exhausted');
        if (grant.available <= 0) continue; // Another waiter consumed the pool; reserve a fresh pool next iteration.
        grant.available -= 1;
        const permit: TradovateRequestPermit = { owner: self, epoch: grant.value.epoch, expiresMono: grant.deadline, purpose, consumed: false };
        preparedBackground.add(permit);
        return permit;
      }
      } finally { pendingBackground -= 1; }
    },
    dispatch(purpose, permit) {
      const hard = hardProblem(); if (hard) return deny(hard.controlReason, hard.message);
      if (purpose === 'risk' || purpose === 'control') {
        if (!snapshot || snapshot.policyVersion !== POLICY.capacityVersion || mono() >= controlDeadline) return deny('unavailable', 'Priority read authority is stale');
        if (!permit || permit.owner !== self || permit.purpose !== purpose || permit.consumed || !preparedPriority.has(permit)
          || permit.epoch !== snapshot.epoch || mono() >= permit.expiresMono) return deny('budget', 'Invalid or expired priority permit');
        permit.consumed = true; preparedPriority.delete(permit); counts.dispatchAttempts += 1;
        let released = false;
        return () => { if (!released) { released = true; prioritySlots[purpose] -= 1; } };
      }
      const background = purpose !== 'management' && purpose !== 'entry';
      if (background) {
        const problem = admissionProblem(); if (problem) return deny(snapshot && mono() < controlDeadline ? 'budget' : 'unavailable', problem);
        if (!permit || permit.owner !== self || permit.purpose !== purpose || permit.consumed || !preparedBackground.has(permit) || permit.epoch !== snapshot!.epoch || mono() >= permit.expiresMono) return deny('budget', 'Invalid or expired background permit');
      } else if (permit != null) return deny('budget', 'A read permit cannot authorize a write');
      if (background) {
        while (burst.length && mono() - burst[0] >= 1_000) burst.shift();
        if (activeBackground >= POLICY.backgroundConcurrency || burst.length >= POLICY.backgroundBurst) return deny('budget', 'Background concurrency/burst limit reached');
        permit.consumed = true; preparedBackground.delete(permit); activeBackground += 1; burst.push(mono());
      } else management.record();
      counts.dispatchAttempts += 1;
      let released = false;
      return () => { if (!released) { released = true; if (background) activeBackground -= 1; } };
    },
    response() { counts.responses += 1; },
    transportUnknown() { counts.transportUnknown += 1; },
    holdPenaltyInspection(reason) {
      penaltyInspections += 1; inspectionReason = reason.slice(0, 200);
      let released = false;
      return () => { if (!released) { released = true; penaltyInspections -= 1; } };
    },
    async penalize(penalty) {
      const duration = Math.max(0, penalty.retryAfterMs);
      if (!Number.isFinite(duration)) { failed = 'request-control-penalty-invalid'; grant = null; controlDeadline = -Infinity; throw new Error(failed); }
      captcha ||= penalty.captchaRequired === true;
      if (mono() + duration > blockMono || penalty.captchaRequired) { blockMono = Math.max(blockMono, mono() + duration); blockWall = clock() + Math.max(0, blockMono - mono()); evidence = penalty.evidence; reason = penalty.reason; }
      grant = null;
      // Apply local stop synchronously before the first persistence/network await.
      await save();
      const started = mono();
      try { const result = await options.remote.penalize(penalty); applyRemote(result, started); await save(); }
      catch { controlDeadline = -Infinity; /* local durable stop remains; sync retries do not probe broker */ }
    },
    newRiskBlocker: () => admissionProblem(true) ?? (snapshot?.policyVersion !== POLICY.capacityVersion ? 'Shared request authority needs the current capacity policy' : null),
    health() {
      const hard = hardProblem(), admission = admissionProblem();
      return { version: 1, brokerUserId: options.brokerUserId, state: hard?.controlReason === 'captcha' ? 'captcha' : hard?.controlReason === 'cooldown' ? 'cooldown'
        : hard || !snapshot || mono() >= controlDeadline ? 'unavailable' : admission ? 'budget-limited' : 'ready',
      observedAt: clock(), blockedUntil: mono() < blockMono ? clock() + Math.max(0, blockMono - mono()) : null, reason: hard?.message ?? admission ?? null,
      evidence, controlFreshUntil: snapshot ? clock() + Math.max(0, controlDeadline - mono()) : null, cooldownIsLocalEstimate: true, counts: { ...counts } };
    },
  };
  return self;
}

/** Callers must share this registry for adapters, directory probes and raw display. */
export function createTradovateRequestControlRegistry() {
  const governors = new Map<number, TradovateRequestGovernor>();
  return { get(brokerUserId: number, create: () => TradovateRequestGovernor) {
    const existing = governors.get(brokerUserId); if (existing) return existing;
    const value = create(); if (value.brokerUserId !== brokerUserId) throw new Error('request-control-registry-identity-mismatch');
    governors.set(brokerUserId, value); return value;
  }, values: () => [...governors.values()] };
}
