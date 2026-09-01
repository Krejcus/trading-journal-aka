import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TRADINGVIEW_BINARY = '/Applications/TradingView.app/Contents/MacOS/TradingView';
const CDP_ORIGIN = 'http://127.0.0.1:9222';

export type TradingViewCdpEnsureResult =
  | 'ready'
  | 'auto-launch-disabled'
  | 'running-without-cdp'
  | 'launched'
  | 'launch-failed';

interface TradingViewCdpLifecycleDeps {
  fetchImpl?: typeof fetch;
  processRunning?: () => Promise<boolean>;
  launch?: () => Promise<void> | void;
  quit?: () => Promise<void> | void;
  sleep?: (milliseconds: number) => Promise<void>;
  quitTimeoutMs?: number;
  cdpTimeoutMs?: number;
  pollIntervalMs?: number;
}

const cdpReachable = async (fetchImpl: typeof fetch): Promise<boolean> => {
  try {
    const response = await fetchImpl(`${CDP_ORIGIN}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const tradingViewRunning = async (): Promise<boolean> => {
  try {
    await execFileAsync('/usr/bin/pgrep', ['-x', 'TradingView']);
    return true;
  } catch {
    return false;
  }
};

const launchTradingViewWithCdp = (): void => {
  const child = spawn(TRADINGVIEW_BINARY, [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9222',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
};

const quitTradingView = async (): Promise<void> => {
  await execFileAsync('/usr/bin/osascript', [
    '-e', 'tell application "TradingView" to quit',
  ], {
    timeout: 5_000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024,
  });
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const waitUntil = async (
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) return true;
    await wait(intervalMs);
  } while (Date.now() < deadline);
  return predicate();
};

/**
 * Bezpečný lifecycle: existující TradingView nikdy nezabíjí ani nerestartuje.
 * Automaticky ho spustí jen tehdy, když neběží, a pouze po opt-inu instalace.
 */
export async function ensureTradingViewCdp(
  autoLaunch: boolean,
  deps: TradingViewCdpLifecycleDeps = {},
): Promise<TradingViewCdpEnsureResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (await cdpReachable(fetchImpl)) return 'ready';
  if (!autoLaunch) return 'auto-launch-disabled';
  if (await (deps.processRunning ?? tradingViewRunning)()) return 'running-without-cdp';
  try {
    await (deps.launch ?? launchTradingViewWithCdp)();
    return 'launched';
  } catch {
    return 'launch-failed';
  }
}

export type TradingViewCdpRestartResult =
  | 'ready'
  | 'restarted'
  | 'quit-timeout'
  | 'launch-failed'
  | 'cdp-timeout';

/**
 * Výslovná maintenance akce z UI. Nejdřív požádá TradingView o standardní
 * ukončení (žádný SIGKILL), počká na konec procesu a teprve potom jej spustí
 * s loopback-only CDP. Volající musí zvlášť vynutit flat/DISARMED gate.
 */
export async function restartTradingViewWithCdp(
  deps: TradingViewCdpLifecycleDeps = {},
): Promise<TradingViewCdpRestartResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const processRunning = deps.processRunning ?? tradingViewRunning;
  const wait = deps.sleep ?? sleep;
  const pollIntervalMs = Math.max(10, deps.pollIntervalMs ?? 250);
  if (await cdpReachable(fetchImpl)) return 'ready';

  if (await processRunning()) {
    try {
      await (deps.quit ?? quitTradingView)();
    } catch {
      return 'quit-timeout';
    }
    const stopped = await waitUntil(
      async () => !(await processRunning()),
      Math.max(500, deps.quitTimeoutMs ?? 10_000),
      pollIntervalMs,
      wait,
    );
    if (!stopped) return 'quit-timeout';
  }

  try {
    await (deps.launch ?? launchTradingViewWithCdp)();
  } catch {
    return 'launch-failed';
  }
  const reachable = await waitUntil(
    () => cdpReachable(fetchImpl),
    Math.max(500, deps.cdpTimeoutMs ?? 15_000),
    pollIntervalMs,
    wait,
  );
  return reachable ? 'restarted' : 'cdp-timeout';
}
