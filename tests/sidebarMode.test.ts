import { describe, expect, it } from 'vitest';
import { isSidebarToggleShortcut } from '../lib/sidebarMode';

const key = (patch: Partial<Parameters<typeof isSidebarToggleShortcut>[0]> = {}) => ({
  key: 'b', code: 'KeyB', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, repeat: false, target: null, ...patch,
});
const field = (selector: string) => ({ closest: (query: string) => (query.includes(selector) ? {} : null) }) as unknown as EventTarget;

describe('isSidebarToggleShortcut', () => {
  it('⌘B a Ctrl+B přepnou, i na jiném rozložení klávesnice podle kódu klávesy', () => {
    expect(isSidebarToggleShortcut(key())).toBe(true);
    expect(isSidebarToggleShortcut(key({ metaKey: false, ctrlKey: true }))).toBe(true);
    expect(isSidebarToggleShortcut(key({ key: 'ů' }))).toBe(true);
  });
  it('nepřepne bez modifikátoru, s dalšími modifikátory, při opakování ani v textovém poli', () => {
    expect(isSidebarToggleShortcut(key({ metaKey: false }))).toBe(false);
    expect(isSidebarToggleShortcut(key({ shiftKey: true }))).toBe(false);
    expect(isSidebarToggleShortcut(key({ altKey: true }))).toBe(false);
    expect(isSidebarToggleShortcut(key({ repeat: true }))).toBe(false);
    expect(isSidebarToggleShortcut(key({ defaultPrevented: true }))).toBe(false);
    expect(isSidebarToggleShortcut(key({ code: 'KeyN', key: 'n' }))).toBe(false);
    expect(isSidebarToggleShortcut(key({ target: field('textarea') }))).toBe(false);
    expect(isSidebarToggleShortcut(key({ target: { isContentEditable: true } as unknown as EventTarget }))).toBe(false);
  });
});
