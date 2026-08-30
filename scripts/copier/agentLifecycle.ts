export interface AgentLifetimeContext {
  renewable: boolean;
  paired: boolean;
  relayAvailable: boolean;
}

export type AgentLifetime =
  | { kind: 'finite'; minutes: number }
  | { kind: 'persistent' };

export function resolveAgentLifetime(options: {
  requestedMinutes: number;
  serviceLifetime?: string;
  contexts: readonly AgentLifetimeContext[];
}): AgentLifetime {
  if (!Number.isFinite(options.requestedMinutes)
    || options.requestedMinutes < 1
    || options.requestedMinutes > 720) {
    throw new Error('--minutes musí být v rozsahu 1–720');
  }
  const requested = options.serviceLifetime?.trim().toLowerCase() || 'finite';
  if (requested !== 'finite' && requested !== 'persistent') {
    throw new Error('--service-lifetime musí být finite nebo persistent');
  }
  const allPairedAndRenewable = options.contexts.length > 0
    && options.contexts.every(context => context.renewable && context.paired && context.relayAvailable);
  if (requested === 'persistent' && allPairedAndRenewable) return { kind: 'persistent' };
  return { kind: 'finite', minutes: options.requestedMinutes };
}

export function startAgentShutdownWatchdog(options: {
  timeoutMs: number;
  onTimeout: () => void;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}): () => void {
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  const timer = setTimeoutImpl(options.onTimeout, Math.max(1, options.timeoutMs));
  return () => clearTimeoutImpl(timer);
}

export function scheduleAgentRestart(options: {
  delayMs: number;
  restart: () => void;
  setTimeoutImpl?: typeof setTimeout;
}): void {
  const timer = (options.setTimeoutImpl ?? setTimeout)(options.restart, Math.max(1, options.delayMs));
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
}

export async function flushProcessOutput(options: {
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  timeoutMs?: number;
} = {}): Promise<void> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 1_000);
  const flush = (stream: NodeJS.WriteStream) => new Promise<void>(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    try {
      stream.write('', done);
    } catch {
      done();
    }
  });
  await Promise.all([flush(options.stdout ?? process.stdout), flush(options.stderr ?? process.stderr)]);
}

export async function finishAgentCommand(options: {
  run: () => Promise<void>;
  flush?: () => Promise<void>;
  exit: (code: number) => void;
}): Promise<void> {
  await options.run();
  await options.flush?.();
  options.exit(0);
}
