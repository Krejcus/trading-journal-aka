import { chartAppearanceUserId, onChartAppearanceScopeBroadcast } from './chartAppearanceScope';
import { createChartWorkspaceDocument, parseChartWorkspaceDocument, type ChartWorkspaceDocument, type CompleteChartWorkspaceState } from './chartWorkspaceDocument';

export type WorkspaceLibraryOwner = string | null | undefined;
export interface WorkspaceTemplate {
  id: string;
  name: string;
  updatedAt: number;
  document: ChartWorkspaceDocument;
  previous?: ChartWorkspaceDocument;
}
export interface WorkspaceLibrary { version: 1; defaultId: string | null; templates: WorkspaceTemplate[] }
export type WorkspaceLibraryStorage = Pick<Storage, 'getItem' | 'setItem'>;
const CHANGE = 'alphatrade:workspace-library-changed';
export const workspaceLibraryKey = (owner: WorkspaceLibraryOwner): string => {
  if (owner === undefined) throw new Error('Počkej na ověření přihlášeného účtu.');
  return `alphatrade:workspace-library:v1:${owner === null ? 'guest' : `user:${owner}`}`;
};
const empty = (): WorkspaceLibrary => ({ version: 1, defaultId: null, templates: [] });
const storage = () => window.localStorage;
export const readWorkspaceLibrary = (owner: WorkspaceLibraryOwner, target: WorkspaceLibraryStorage = storage()): WorkspaceLibrary => {
  if (owner === undefined) return empty();
  const raw = target.getItem(workspaceLibraryKey(owner));
  if (!raw) return empty();
  const value = JSON.parse(raw) as WorkspaceLibrary;
  if (!value || value.version !== 1 || !Array.isArray(value.templates)) throw new Error('Knihovna šablon je poškozená. Existující kopie zůstala zachována; použij exportovaný workspace.');
  const ids = new Set<string>();
  const templates = value.templates.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || !Number.isFinite(item.updatedAt)) throw new Error('Neplatná šablona v knihovně.');
    ids.add(item.id);
    const parsed = parseChartWorkspaceDocument(item.document);
    if (parsed.kind !== 'complete') throw new Error('Šablona neobsahuje úplný workspace.');
    return { ...item, document: parsed.document };
  });
  return { version: 1, templates, defaultId: typeof value.defaultId === 'string' && ids.has(value.defaultId) ? value.defaultId : null };
};
const commit = (owner: WorkspaceLibraryOwner, next: WorkspaceLibrary, target: WorkspaceLibraryStorage) => {
  // One atomic setItem: a quota failure cannot delete the last good version.
  target.setItem(workspaceLibraryKey(owner), JSON.stringify(next));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE));
};
export const saveWorkspaceTemplate = (owner: WorkspaceLibraryOwner, input: { id?: string; name: string; state: CompleteChartWorkspaceState; makeDefault?: boolean }, target: WorkspaceLibraryStorage = storage()): WorkspaceTemplate => {
  const name = input.name.trim();
  if (!name || name.length > 100) throw new Error('Název šablony musí mít 1–100 znaků.');
  const document = createChartWorkspaceDocument(input.state);
  const library = readWorkspaceLibrary(owner, target);
  const previous = input.id ? library.templates.find(item => item.id === input.id) : undefined;
  if (input.id && !previous) throw new Error('Šablona byla odstraněna. Ulož ji pod novým názvem.');
  if (library.templates.some(item => item.id !== input.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('Tento název už existuje. Vyber šablonu k přepsání nebo jiný název.');
  const template: WorkspaceTemplate = { id: previous?.id ?? crypto.randomUUID(), name, updatedAt: Date.now(), document, ...(previous ? { previous: previous.document } : {}) };
  const templates = [template, ...library.templates.filter(item => item.id !== template.id)];
  commit(owner, { version: 1, templates, defaultId: input.makeDefault ? template.id : library.defaultId === template.id ? null : library.defaultId }, target);
  return structuredClone(template);
};
export const setDefaultWorkspaceTemplate = (owner: WorkspaceLibraryOwner, id: string | null, target: WorkspaceLibraryStorage = storage()): void => {
  const library = readWorkspaceLibrary(owner, target);
  if (id && !library.templates.some(item => item.id === id)) throw new Error('Šablona už není dostupná.');
  commit(owner, { ...library, defaultId: id }, target);
};
export const deleteWorkspaceTemplate = (owner: WorkspaceLibraryOwner, id: string, target: WorkspaceLibraryStorage = storage()): void => {
  const library = readWorkspaceLibrary(owner, target);
  commit(owner, { ...library, defaultId: library.defaultId === id ? null : library.defaultId, templates: library.templates.filter(item => item.id !== id) }, target);
};
export const subscribeWorkspaceLibrary = (listener: () => void): (() => void) => {
  const offOwner = onChartAppearanceScopeBroadcast(listener);
  const onStorage = (event: StorageEvent) => { const owner = chartAppearanceUserId(); if (!event.key || owner === undefined || event.key === workspaceLibraryKey(owner)) listener(); };
  window.addEventListener(CHANGE, listener);
  window.addEventListener('storage', onStorage);
  window.addEventListener('focus', listener);
  return () => { offOwner(); window.removeEventListener(CHANGE, listener); window.removeEventListener('storage', onStorage); window.removeEventListener('focus', listener); };
};

/** Resolve at click time, never from a manager's stale mount-time availability flag. */
export const workspaceTemplateForNewSession = (owner: WorkspaceLibraryOwner, selection: string, allowedRoots: readonly string[], target: WorkspaceLibraryStorage = storage()): CompleteChartWorkspaceState | null => {
  if (selection !== 'default' && !selection.startsWith('template:')) return null;
  const library = readWorkspaceLibrary(owner, target);
  const id = selection === 'default' ? library.defaultId : selection.startsWith('template:') ? selection.slice(9) : null;
  if (!id) return null;
  const template = library.templates.find(item => item.id === id);
  if (!template) throw new Error('Vybraná šablona už není dostupná. Zvol jinou.');
  const parsed = parseChartWorkspaceDocument(template.document, { allowedRoots });
  if (parsed.kind !== 'complete') throw new Error('Šablona neobsahuje úplný workspace.');
  return parsed.document.state;
};
