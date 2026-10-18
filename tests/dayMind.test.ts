import { describe, expect, it } from 'vitest';
import { detectMindAreas, mergeMindAreas } from '../lib/dayMind';

describe('detectMindAreas', () => {
  it('pozná oblasti bez ohledu na diakritiku a velikost písmen', () => {
    expect(detectMindAreas('Před NY open mě rozhodila zpráva z domu')).toEqual(['rodina', 'trading']);
    expect(detectMindAreas('Špatně jsem SPAL, ráno jen kafe a nic k jídlu')).toEqual(['jidlo', 'spanek']);
    expect(detectMindAreas('Po tréninku v gymu je hlava čistá')).toEqual(['pohyb']);
    expect(detectMindAreas('Hádka s kamarádem kvůli penězům')).toEqual(['vztahy', 'prace']);
  });

  it('nechytá běžná slova se stejným začátkem', () => {
    expect(detectMindAreas('Mám to jistě během dne, tato věc')).toEqual([]);
    expect(detectMindAreas('Synchronizace brát')).toEqual([]);
    // Slova z trhu, ne ze života.
    expect(detectMindAreas('Špatný den, špatná nálada')).toEqual([]);
    expect(detectMindAreas('Spatřil jsem pivot, hladina 24500, kdo je vinovat')).toEqual([]);
    expect(detectMindAreas('Silný pohyb ceny')).toEqual([]);
    expect(detectMindAreas('Nevyspal jsem se, spal jsem 4 hodiny')).toEqual(['spanek']);
    expect(detectMindAreas('Mám hlad, dám si kávu')).toEqual(['jidlo']);
  });

  it('prázdný nebo neznámý text nemá oblast', () => {
    expect(detectMindAreas('')).toEqual([]);
    expect(detectMindAreas('Jen tak')).toEqual([]);
  });
});

describe('mergeMindAreas', () => {
  it('ruční oblasti zůstanou, rozpoznané se přepočítají, neznámé se zahodí', () => {
    expect(mergeMindAreas('Doma klid', ['pohyb', 'xyz'])).toEqual(['rodina', 'pohyb']);
  });
});
