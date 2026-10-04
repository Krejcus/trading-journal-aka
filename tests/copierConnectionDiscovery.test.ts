import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectionDiscoveryBackoffMs,
  connectionsToLoadAtStartup,
  emptyConnectionDiscoveryState,
  evaluateConnectionPoll,
  loadConnectionDiscoveryState,
  recordConnectionDiscoveryFailure,
  recordConnectionDiscoverySuccess,
  saveConnectionDiscoveryState,
} from '../scripts/copier/connectionDiscovery';

describe('načítání nových propfirem do Mac workeru', () => {
  let root: string | null = null;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = null; });

  it('při startu načte jen připojení navíc k manifestu a mimo cooldown', () => {
    const now = 1_000_000;
    let state = emptyConnectionDiscoveryState();
    state = recordConnectionDiscoveryFailure(state, 'broken', new Error('lease 502'), now);
    expect(connectionsToLoadAtStartup({
      serverConnectionIds: ['manifest-a', 'fundednext', 'broken', 'fundednext'],
      manifestConnectionIds: ['manifest-a'],
      state,
      now,
    })).toEqual(['fundednext']);
  });

  it('selhání se zkouší znovu s rostoucím odstupem, ne smyčkou restartů', () => {
    expect(connectionDiscoveryBackoffMs(1)).toBe(5 * 60_000);
    expect(connectionDiscoveryBackoffMs(2)).toBe(15 * 60_000);
    expect(connectionDiscoveryBackoffMs(10)).toBe(6 * 60 * 60_000);
    let state = emptyConnectionDiscoveryState();
    state = recordConnectionDiscoveryFailure(state, 'x', new Error('a'), 0);
    state = recordConnectionDiscoveryFailure(state, 'x', new Error('b'), 0);
    expect(state.failures.x).toMatchObject({ attempts: 2, nextAttemptAt: 15 * 60_000, lastError: 'b' });
    const poll = (now: number) => evaluateConnectionPoll({
      serverConnectionIds: ['x'], loadedConnectionIds: [], manifestConnectionIds: [], scope: 'owner', state, now,
    }).added;
    expect(poll(10 * 60_000)).toEqual([]);
    expect(poll(16 * 60_000)).toEqual(['x']);
    expect(recordConnectionDiscoverySuccess(state, 'x').failures).toEqual({});
  });

  it('za běhu hlásí nová i odpojená připojení; manifestová jen s úplným seznamem (scope owner)', () => {
    const poll = (scope: 'owner' | 'connection') => evaluateConnectionPoll({
      serverConnectionIds: ['a', 'new'],
      loadedConnectionIds: ['a', 'discovered-gone', 'manifest-gone'],
      manifestConnectionIds: ['a', 'manifest-gone'],
      scope,
      state: emptyConnectionDiscoveryState(),
      now: 0,
    });
    expect(poll('owner')).toEqual({ added: ['new'], removed: ['discovered-gone', 'manifest-gone'] });
    expect(poll('connection')).toEqual({ added: ['new'], removed: ['discovered-gone'] });
  });

  it('stav cooldownu přežije restart workeru a poškozený soubor znamená čistý stav', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'alphatrade-discovery-'));
    const path = resolve(root, 'connection-discovery.json');
    const state = recordConnectionDiscoveryFailure(emptyConnectionDiscoveryState(), 'x', new Error('boom'), 5);
    await saveConnectionDiscoveryState(path, state);
    expect(await loadConnectionDiscoveryState(path)).toEqual(state);
    expect(await loadConnectionDiscoveryState(resolve(root, 'missing.json'))).toEqual(emptyConnectionDiscoveryState());
  });
});
