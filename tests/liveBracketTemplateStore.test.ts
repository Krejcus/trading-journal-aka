import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveBracketTemplate } from '../lib/liveBracketTemplates';
import {
  adoptLiveBracketTemplatesFromPreferences,
  deleteLiveBracketTemplate,
  LIVE_BRACKET_TEMPLATES_PREFERENCES_FIELD,
  LIVE_BRACKET_TEMPLATES_SCHEMA_VERSION,
  liveBracketTemplatesBackupKey,
  liveBracketTemplatesStorageKey,
  pushLiveBracketTemplatesToPreferences,
  readLiveBracketTemplates,
  saveLiveBracketTemplate,
  serializeLiveBracketTemplates,
  setDefaultLiveBracketTemplateId,
  subscribeLiveBracketTemplates,
  updateLiveBracketTemplates,
  type LiveBracketTemplateStorage,
} from '../services/liveBracketTemplateStore';

const USER = 'user-a';
const KEY = liveBracketTemplatesStorageKey(USER);
const NOW = new Date('2026-11-03T10:00:00.000Z');

const template = (patch: Partial<LiveBracketTemplate> = {}): LiveBracketTemplate => ({
  id: 'tpl-scalp',
  name: 'Scalp',
  stopLoss: { unit: 'ticks', value: 12 },
  takeProfit: { unit: 'ticks', value: 24 },
  sizing: null,
  updatedAt: NOW.toISOString(),
  ...patch,
});

const memory = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  const storage = {
    data,
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
  };
  return storage;
};

const stored = (storage: ReturnType<typeof memory>) => JSON.parse(storage.data.get(KEY)!);

describe('čtení šablon', () => {
  it('prázdné úložiště = jen vestavěná, zapisovat smí', () => {
    const read = readLiveBracketTemplates(USER, { storage: memory() });
    expect(read).toEqual({ status: 'empty', library: { templates: [], defaultId: null }, savedAt: null, writable: true });
  });

  it('bez uživatele nebo bez úložiště se nic nečte ani nezapisuje', () => {
    expect(readLiveBracketTemplates(null, { storage: memory() })).toMatchObject({ status: 'signed-out', writable: false });
    expect(readLiveBracketTemplates(USER, { storage: null })).toMatchObject({ status: 'unavailable', writable: false });
  });

  it('poškozené šablony uvnitř platné obálky vypadnou (sanitize)', () => {
    const storage = memory({
      [KEY]: JSON.stringify({
        version: 1,
        savedAt: NOW.toISOString(),
        library: { templates: [template(), { ...template({ id: 'tpl-bad', name: 'Bad' }), stopLoss: { unit: 'price', value: 21000 } }], defaultId: 'tpl-bad' },
      }),
    });
    const read = readLiveBracketTemplates(USER, { storage });
    expect(read.status).toBe('ok');
    expect(read.library.templates.map(t => t.id)).toEqual(['tpl-scalp']);
    expect(read.library.defaultId).toBeNull();
  });

  it('šablony jsou per uživatel', () => {
    const storage = memory();
    expect(saveLiveBracketTemplate(USER, template(), { storage, now: NOW }).ok).toBe(true);
    expect(readLiveBracketTemplates('user-b', { storage }).library.templates).toEqual([]);
    expect(readLiveBracketTemplates(USER, { storage }).library.templates).toHaveLength(1);
  });
});

describe('bez úspěšného čtení se nezapisuje', () => {
  it('nečitelné úložiště: změna se nezavolá a setItem ani jednou', () => {
    const storage = memory();
    storage.getItem.mockImplementation(() => { throw new Error('SecurityError'); });
    const change = vi.fn();
    const result = updateLiveBracketTemplates(USER, change, { storage });
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(change).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(saveLiveBracketTemplate(USER, template(), { storage }).ok).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('data novější verze appky se nepřečtou ani nepřepíšou', () => {
    const newer = JSON.stringify({ version: LIVE_BRACKET_TEMPLATES_SCHEMA_VERSION + 1, savedAt: NOW.toISOString(), library: { templates: [template()], defaultId: 'tpl-scalp' } });
    const storage = memory({ [KEY]: newer });
    const read = readLiveBracketTemplates(USER, { storage });
    expect(read).toMatchObject({ status: 'newer-version', writable: false, library: { templates: [], defaultId: null } });
    expect(saveLiveBracketTemplate(USER, template({ id: 'tpl-x', name: 'X' }), { storage })).toMatchObject({ ok: false, reason: 'newer-version' });
    expect(deleteLiveBracketTemplate(USER, 'tpl-scalp', { storage }).ok).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.data.get(KEY)).toBe(newer);
  });

  it('odhlášený uživatel nic neuloží', () => {
    const storage = memory();
    expect(saveLiveBracketTemplate(null, template(), { storage })).toMatchObject({ ok: false, reason: 'signed-out' });
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});

describe('zápis šablon', () => {
  it('uloží obálku s verzí a časem; čtení vrátí totéž', () => {
    const storage = memory();
    const result = saveLiveBracketTemplate(USER, template(), { storage, now: NOW });
    expect(result.ok).toBe(true);
    expect(stored(storage)).toEqual({ version: 1, savedAt: NOW.toISOString(), library: { templates: [template()], defaultId: null } });
    expect(readLiveBracketTemplates(USER, { storage })).toMatchObject({ status: 'ok', writable: true, savedAt: NOW.toISOString() });
  });

  it('každá změna čte čerstvá data — druhý panel nesmaže šablonu prvního', () => {
    const storage = memory();
    saveLiveBracketTemplate(USER, template(), { storage, now: NOW });
    saveLiveBracketTemplate(USER, template({ id: 'tpl-swing', name: 'Swing' }), { storage, now: NOW });
    setDefaultLiveBracketTemplateId(USER, 'tpl-swing', { storage, now: NOW });
    expect(stored(storage).library).toMatchObject({ templates: [{ id: 'tpl-scalp' }, { id: 'tpl-swing' }], defaultId: 'tpl-swing' });
    deleteLiveBracketTemplate(USER, 'tpl-swing', { storage, now: NOW });
    expect(stored(storage).library).toMatchObject({ templates: [{ id: 'tpl-scalp' }], defaultId: null });
  });

  it('neplatná šablona ani odmítnutá změna nic nezapíše', () => {
    const storage = memory();
    const bad = { ...template(), stopLoss: { unit: 'price', value: 21000 } } as unknown as LiveBracketTemplate;
    expect(saveLiveBracketTemplate(USER, bad, { storage })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(setDefaultLiveBracketTemplateId(USER, 'tpl-missing', { storage })).toMatchObject({ ok: false, reason: 'invalid' });
    // Změna, která obejde knihovní funkce, neprojde druhou sítí (sanitize před zápisem).
    const sneaky = updateLiveBracketTemplates(USER, () => ({ ok: true, library: { templates: [bad], defaultId: null } }), { storage });
    expect(sneaky).toMatchObject({ ok: false, reason: 'invalid' });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('poškozený text se před prvním přepisem zazálohuje', () => {
    const storage = memory({ [KEY]: '{not json' });
    expect(readLiveBracketTemplates(USER, { storage })).toMatchObject({ status: 'corrupt', writable: true });
    expect(saveLiveBracketTemplate(USER, template(), { storage, now: NOW }).ok).toBe(true);
    expect(storage.data.get(liveBracketTemplatesBackupKey(USER))).toBe('{not json');
    expect(stored(storage).library.templates).toHaveLength(1);
  });

  it('nejde-li poškozený text zazálohovat, nepřepíše se', () => {
    const storage = memory({ [KEY]: '[]' });
    storage.setItem.mockImplementation((key: string) => {
      if (key === liveBracketTemplatesBackupKey(USER)) throw new Error('QuotaExceededError');
    });
    expect(saveLiveBracketTemplate(USER, template(), { storage })).toMatchObject({ ok: false, reason: 'write-failed' });
    expect(storage.data.get(KEY)).toBe('[]');
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it('selhaný zápis vrátí chybu, ne úspěch', () => {
    const storage = memory();
    storage.setItem.mockImplementation(() => { throw new Error('QuotaExceededError'); });
    expect(saveLiveBracketTemplate(USER, template(), { storage })).toMatchObject({ ok: false, reason: 'write-failed' });
  });
});

describe('preference účtu (volitelné zrcadlo)', () => {
  const library = { templates: [template()], defaultId: 'tpl-scalp' };

  it('selhané nebo prázdné čtení preferencí = žádný zápis', async () => {
    const write = vi.fn();
    expect(await pushLiveBracketTemplatesToPreferences({ read: async () => { throw new Error('preferences-read-failed'); }, write }, library))
      .toMatchObject({ ok: false, reason: 'read-failed' });
    expect(await pushLiveBracketTemplatesToPreferences({ read: async () => null, write }, library))
      .toMatchObject({ ok: false, reason: 'read-empty' });
    expect(write).not.toHaveBeenCalled();
  });

  it('novější verzi šablon v účtu nepřepíše', async () => {
    const write = vi.fn();
    const prefs = { theme: 'dark', [LIVE_BRACKET_TEMPLATES_PREFERENCES_FIELD]: { version: 99, savedAt: NOW.toISOString(), library: {} } };
    expect(await pushLiveBracketTemplatesToPreferences({ read: async () => prefs, write }, library)).toMatchObject({ ok: false, reason: 'newer-version' });
    expect(write).not.toHaveBeenCalled();
  });

  it('zapíše jen svoje pole a ostatní preference zachová', async () => {
    const write = vi.fn(async () => undefined);
    const prefs = { theme: 'dark', emotions: [1, 2] };
    expect(await pushLiveBracketTemplatesToPreferences({ read: async () => prefs, write }, library, NOW)).toEqual({ ok: true });
    expect(write).toHaveBeenCalledWith({ theme: 'dark', emotions: [1, 2], [LIVE_BRACKET_TEMPLATES_PREFERENCES_FIELD]: serializeLiveBracketTemplates(library, NOW) });
  });

  it('převezme novější šablony z účtu, starší ne; nečitelné místní úložiště nemění', () => {
    const remoteAt = new Date('2026-11-03T12:00:00.000Z');
    const prefs = { [LIVE_BRACKET_TEMPLATES_PREFERENCES_FIELD]: serializeLiveBracketTemplates(library, remoteAt) };
    const storage = memory();
    saveLiveBracketTemplate(USER, template({ id: 'tpl-local', name: 'Local' }), { storage, now: NOW });
    expect(adoptLiveBracketTemplatesFromPreferences(USER, prefs, { storage })).toBe('adopted');
    expect(readLiveBracketTemplates(USER, { storage })).toMatchObject({ savedAt: remoteAt.toISOString(), library: { defaultId: 'tpl-scalp' } });
    const older = { [LIVE_BRACKET_TEMPLATES_PREFERENCES_FIELD]: serializeLiveBracketTemplates({ templates: [], defaultId: null }, NOW) };
    expect(adoptLiveBracketTemplatesFromPreferences(USER, older, { storage })).toBe('kept-local');
    expect(readLiveBracketTemplates(USER, { storage }).library.templates).toHaveLength(1);
    const broken = memory();
    broken.getItem.mockImplementation(() => { throw new Error('SecurityError'); });
    expect(adoptLiveBracketTemplatesFromPreferences(USER, prefs, { storage: broken })).toBe('skipped');
    expect(broken.setItem).not.toHaveBeenCalled();
    expect(adoptLiveBracketTemplatesFromPreferences(USER, {}, { storage })).toBe('skipped');
  });
});

describe('oznámení o změně', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uložení v této kartě i zápis jiné karty pošle posluchači čerstvé čtení', () => {
    const target = new EventTarget();
    vi.stubGlobal('window', {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    });
    const storage: LiveBracketTemplateStorage & ReturnType<typeof memory> = memory();
    const listener = vi.fn();
    const unsubscribe = subscribeLiveBracketTemplates(USER, listener, { storage });
    saveLiveBracketTemplate(USER, template(), { storage, now: NOW });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].library.templates).toHaveLength(1);
    // Jiný uživatel ani jiný klíč posluchače nebudí.
    saveLiveBracketTemplate('user-b', template(), { storage, now: NOW });
    const storageEvent = Object.assign(new Event('storage'), { key: KEY });
    target.dispatchEvent(storageEvent);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    saveLiveBracketTemplate(USER, template({ id: 'tpl-2', name: 'Two' }), { storage, now: NOW });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
