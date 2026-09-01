import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import {
  finishAgentCommand,
  flushProcessOutput,
  resolveAgentLifetime,
  scheduleAgentRestart,
  startAgentShutdownWatchdog,
} from '../scripts/copier/agentLifecycle';
import {
  canSafelyRestartLocalCopierAgent,
  localCopierAgentRestartBlockers,
} from '../lib/localCopierAgentProtocol';
import type { CopierControllerStatus } from '../services/copierRuntimeController';

describe('Mac copier agent lifecycle', () => {
  afterEach(() => vi.useRealTimers());

  it('restarts only from a fresh connected, reconciled, DISARMED and flat status', () => {
    const safe: CopierControllerStatus = {
      started: true,
      armed: false,
      killSwitch: false,
      shadowMode: false,
      connected: true,
      reconciliationRequired: false,
      groupFlat: true,
      divergentAccounts: [],
      workingOrderAccounts: [],
      stuckOutbox: false,
      stuckOperations: [],
      lastError: null,
      revision: 1,
      lastSequence: 1,
    };
    expect(canSafelyRestartLocalCopierAgent(safe)).toBe(true);
    expect(canSafelyRestartLocalCopierAgent({ ...safe, armed: true })).toBe(false);
    expect(canSafelyRestartLocalCopierAgent({ ...safe, killSwitch: true })).toBe(false);
    expect(canSafelyRestartLocalCopierAgent({ ...safe, connected: false })).toBe(false);
    expect(canSafelyRestartLocalCopierAgent({ ...safe, reconciliationRequired: true })).toBe(false);
    expect(canSafelyRestartLocalCopierAgent({ ...safe, groupFlat: false })).toBe(false);
    expect(canSafelyRestartLocalCopierAgent({ ...safe, divergentAccounts: [1] })).toBe(false);
    expect(canSafelyRestartLocalCopierAgent({ ...safe, workingOrderAccounts: [1] })).toBe(false);
    expect(canSafelyRestartLocalCopierAgent({ ...safe, stuckOutbox: true })).toBe(false);
    expect(canSafelyRestartLocalCopierAgent({
      ...safe,
      stuckOperations: [{ kind: 'oso' as const, key: 'x', status: 'unknown' as const, leaderSequence: 1, updatedAt: 1 }],
    })).toBe(false);

    const cases: Array<[string, CopierControllerStatus | null]> = [
      ['status-unavailable', null],
      ['not-started', { ...safe, started: false }],
      ['armed', { ...safe, armed: true }],
      ['kill-switch', { ...safe, killSwitch: true }],
      ['disconnected', { ...safe, connected: false }],
      ['reconciliation-required', { ...safe, reconciliationRequired: true }],
      ['group-not-flat', { ...safe, groupFlat: false }],
      ['divergent-accounts', { ...safe, divergentAccounts: [1] }],
      ['working-orders', { ...safe, workingOrderAccounts: [1] }],
      ['stuck-outbox', { ...safe, stuckOutbox: true }],
      ['stuck-operations', {
        ...safe,
        stuckOperations: [{ kind: 'oso', key: 'x', status: 'unknown', leaderSequence: 1, updatedAt: 1 }],
      }],
    ];
    expect(localCopierAgentRestartBlockers(safe)).toEqual([]);
    for (const [expected, candidate] of cases) {
      expect(localCopierAgentRestartBlockers(candidate), expected).toContain(expected);
      expect(localCopierAgentRestartBlockers(candidate).length === 0, expected)
        .toBe(canSafelyRestartLocalCopierAgent(candidate));
    }
  });

  it('přidá read-only OAuth preflight detaily bez změny ekvivalence bezpečnostní brány', () => {
    const status: CopierControllerStatus = {
      started: true, armed: false, killSwitch: false, shadowMode: false,
      connected: true, reconciliationRequired: true, groupFlat: true,
      divergentAccounts: [], workingOrderAccounts: [], stuckOutbox: false,
      stuckOperations: [], lastError: null, revision: 1, lastSequence: 1,
      oauthPreflight: {
        missingAccounts: [11],
        inactiveAccounts: [22],
        readOnlyFollowerAccounts: [33],
      },
    };
    expect(localCopierAgentRestartBlockers(status)).toEqual([
      'reconciliation-required',
      'preflight-missing',
      'preflight-inactive',
      'preflight-read-only-followers',
    ]);
    expect(localCopierAgentRestartBlockers(status).length === 0)
      .toBe(canSafelyRestartLocalCopierAgent(status));
  });

  it('runs a fully paired renewable LaunchAgent without an arbitrary time limit', () => {
    expect(resolveAgentLifetime({
      requestedMinutes: 720,
      serviceLifetime: 'persistent',
      contexts: [
        { renewable: true, paired: true, relayAvailable: true },
        { renewable: true, paired: true, relayAvailable: true },
      ],
    })).toEqual({ kind: 'persistent' });
  });

  it('keeps the finite lease guard until every connection is paired and renewable', () => {
    expect(resolveAgentLifetime({
      requestedMinutes: 720,
      serviceLifetime: 'persistent',
      contexts: [
        { renewable: true, paired: true, relayAvailable: true },
        { renewable: true, paired: false, relayAvailable: false },
      ],
    })).toEqual({ kind: 'finite', minutes: 720 });
    expect(resolveAgentLifetime({
      requestedMinutes: 720,
      serviceLifetime: 'persistent',
      contexts: [{ renewable: false, paired: true, relayAvailable: true }],
    })).toEqual({ kind: 'finite', minutes: 720 });
    expect(resolveAgentLifetime({
      requestedMinutes: 720,
      serviceLifetime: 'persistent',
      contexts: [{ renewable: true, paired: true, relayAvailable: false }],
    })).toEqual({ kind: 'finite', minutes: 720 });
  });

  it('rejects an invalid lifetime instead of silently changing service semantics', () => {
    expect(() => resolveAgentLifetime({
      requestedMinutes: 720,
      serviceLifetime: 'forever',
      contexts: [{ renewable: true, paired: true, relayAvailable: true }],
    })).toThrow('--service-lifetime musí být finite nebo persistent');
  });

  it('exits only after the graceful agent command has completed', async () => {
    const order: string[] = [];
    await finishAgentCommand({
      run: async () => { order.push('cleanup-complete'); },
      flush: async () => { order.push('logs-flushed'); },
      exit: code => { order.push(`exit-${code}`); },
    });
    expect(order).toEqual(['cleanup-complete', 'logs-flushed', 'exit-0']);
  });

  it('really exits even when a foreign handle would otherwise keep Node alive', async () => {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'alphatrade-agent-lifecycle-'));
    try {
      const fixtureModule = resolve(fixtureRoot, 'agentLifecycle.mjs');
      await build({
        entryPoints: [resolve(projectRoot, 'scripts/copier/agentLifecycle.ts')],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: fixtureModule,
      });
      const child = spawn(process.execPath, ['--input-type=module', '--eval', `
        import { finishAgentCommand, flushProcessOutput } from ${JSON.stringify(pathToFileURL(fixtureModule).href)};
        setInterval(() => undefined, 60_000);
        await finishAgentCommand({
          run: async () => { console.log('cleanup-complete'); },
          flush: () => flushProcessOutput(),
          exit: code => process.exit(code),
        });
      `], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      const result = await Promise.race([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
          child.once('exit', (code, signal) => resolveExit({ code, signal }));
        }),
        new Promise<never>((_resolve, reject) => setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('agent lifecycle child did not exit'));
        }, 3_000)),
      ]);
      expect(result).toEqual({ code: 0, signal: null });
      expect(stdout).toContain('cleanup-complete');
      expect(stderr).toBe('');
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('does not report a clean exit when graceful cleanup fails', async () => {
    const exit = vi.fn();
    await expect(finishAgentCommand({
      run: async () => { throw new Error('cleanup-failed'); },
      exit,
    })).rejects.toThrow('cleanup-failed');
    expect(exit).not.toHaveBeenCalled();
  });

  it('forces the fail-closed exit only when shutdown exceeds its deadline', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const cancel = startAgentShutdownWatchdog({ timeoutMs: 20_000, onTimeout });
    vi.advanceTimersByTime(19_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    const cancelledTimeout = vi.fn();
    const cancelSecond = startAgentShutdownWatchdog({ timeoutMs: 20_000, onTimeout: cancelledTimeout });
    cancelSecond();
    vi.advanceTimersByTime(20_000);
    expect(cancelledTimeout).not.toHaveBeenCalled();
    cancel();
  });

  it('restarts a newly paired service only after the pairing response can complete', () => {
    vi.useFakeTimers();
    const restart = vi.fn();
    scheduleAgentRestart({ delayMs: 750, restart });
    vi.advanceTimersByTime(749);
    expect(restart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('bounds process-output flushing before a forced clean exit', async () => {
    vi.useFakeTimers();
    const neverFlushes = { write: vi.fn(() => true) } as unknown as NodeJS.WriteStream;
    const flushed = flushProcessOutput({ stdout: neverFlushes, stderr: neverFlushes, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(flushed).resolves.toBeUndefined();
  });

  it('keeps the installed LaunchAgent persistent while retaining launchd restart safety', async () => {
    const installer = await readFile(new URL('../scripts/copier/mac-install.ts', import.meta.url), 'utf8');
    expect(installer).toContain("'--service-lifetime', 'persistent'");
    expect(installer).toContain('<key>KeepAlive</key><true/>');
    expect(installer).toContain('<key>ThrottleInterval</key><integer>10</integer>');
    expect(installer).toContain('<key>ExitTimeOut</key><integer>25</integer>');
  });
});
