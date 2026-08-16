import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHART_PANEL_ID,
  panelSettingsEnvelope,
  panelSettingsTargetMatches,
  readPanelSettings,
  writeAllPanelSettings,
  writePanelSettings,
} from '../services/chartPanelSettings';

describe('panelSettingsEnvelope', () => {
  it('starší plochý zápis bere jako sdílenou hodnotu', () => {
    const envelope = panelSettingsEnvelope<{ grid: string }>({ grid: 'both' });
    expect(envelope.shared).toEqual({ grid: 'both' });
    expect(envelope.panels).toEqual({});
  });

  it('chybějící nebo prázdná hodnota nevyrobí sdílené nastavení', () => {
    expect(panelSettingsEnvelope(undefined).shared).toBeUndefined();
    expect(panelSettingsEnvelope(null).shared).toBeUndefined();
  });

  it('novou obálku převezme beze změny', () => {
    const source = writePanelSettings(undefined, 'chart-1', { grid: 'vert' });
    expect(panelSettingsEnvelope(source)).toEqual(source);
  });
});

describe('readPanelSettings', () => {
  it('panel bez vlastní hodnoty dostane sdílenou', () => {
    const envelope = panelSettingsEnvelope({ grid: 'both' });
    expect(readPanelSettings(envelope, 'chart-2')).toEqual({ grid: 'both' });
  });

  it('vlastní hodnota panelu má přednost před sdílenou', () => {
    const envelope = writePanelSettings({ grid: 'both' }, 'chart-1', { grid: 'vert' });
    expect(readPanelSettings(envelope, 'chart-1')).toEqual({ grid: 'vert' });
    expect(readPanelSettings(envelope, 'chart-2')).toEqual({ grid: 'both' });
  });

  it('bez uloženého nastavení vrací undefined', () => {
    expect(readPanelSettings(undefined, DEFAULT_CHART_PANEL_ID)).toBeUndefined();
  });
});

describe('writePanelSettings', () => {
  it('zápis do jednoho panelu ostatní nezmění', () => {
    let envelope = panelSettingsEnvelope({ grid: 'both' });
    envelope = writePanelSettings(envelope, 'chart-1', { grid: 'vert' });
    envelope = writePanelSettings(envelope, 'chart-2', { grid: 'horz' });
    expect(readPanelSettings(envelope, 'chart-1')).toEqual({ grid: 'vert' });
    expect(readPanelSettings(envelope, 'chart-2')).toEqual({ grid: 'horz' });
    expect(readPanelSettings(envelope, 'chart-3')).toEqual({ grid: 'both' });
  });

  it('nemutuje vstupní obálku', () => {
    const original = panelSettingsEnvelope({ grid: 'both' });
    writePanelSettings(original, 'chart-1', { grid: 'vert' });
    expect(original.panels).toEqual({});
  });
});

describe('writeAllPanelSettings', () => {
  it('sjednotí všechny panely a zahodí odchylky', () => {
    let envelope = panelSettingsEnvelope({ grid: 'both' });
    envelope = writePanelSettings(envelope, 'chart-1', { grid: 'vert' });
    const unified = writeAllPanelSettings({ grid: 'none' });
    expect(unified.panels).toEqual({});
    expect(readPanelSettings(unified, 'chart-1')).toEqual({ grid: 'none' });
    expect(readPanelSettings(unified, 'chart-9')).toEqual({ grid: 'none' });
  });
});

describe('panelSettingsTargetMatches', () => {
  it('cíl na jeden panel ostatní panely míjí', () => {
    const target = { panelId: 'chart-1', allPanels: false };
    expect(panelSettingsTargetMatches(target, 'chart-1')).toBe(true);
    expect(panelSettingsTargetMatches(target, 'chart-2')).toBe(false);
  });

  it('cíl na všechny grafy platí pro každý panel', () => {
    const target = { panelId: 'chart-1', allPanels: true };
    expect(panelSettingsTargetMatches(target, 'chart-2')).toBe(true);
  });

  it('událost bez cíle zůstává celoplošná kvůli zpětné kompatibilitě', () => {
    expect(panelSettingsTargetMatches(undefined, 'chart-2')).toBe(true);
  });
});
