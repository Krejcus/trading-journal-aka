import { describe, expect, it } from 'vitest';
import {
  applyLiveBracketTemplate,
  createLiveBracketTemplate,
  defaultLiveBracketTemplate,
  emptyLiveBracketTemplateLibrary,
  findLiveBracketTemplate,
  LIVE_BUILTIN_BRACKET_TEMPLATE,
  LIVE_BUILTIN_TEMPLATE_ID,
  LIVE_TEMPLATE_MARKET_MIN_BRACKET_TICKS,
  LIVE_TEMPLATE_MAX_COUNT,
  liveBracketTemplateChoices,
  liveMarketBracketDistanceProblem,
  liveTemplateBracketPrices,
  liveTemplateFromDraft,
  liveTemplateMarketWarning,
  liveTemplateSummary,
  liveTemplateTicketDraft,
  removeLiveBracketTemplate,
  sanitizeLiveBracketTemplate,
  sanitizeLiveBracketTemplateLibrary,
  setDefaultLiveBracketTemplate,
  upsertLiveBracketTemplate,
  validateLiveBracketTemplate,
  type LiveBracketTemplate,
  type LiveBracketTemplateInput,
  type LiveBracketTemplateLibrary,
} from '../lib/liveBracketTemplates';
import { newTicketDraft, type TicketDraft } from '../lib/liveOrderTicket';
import { MANUAL_ENTRY_MARKET_MIN_BRACKET_TICKS } from '../services/manualEntryPreview';

const MNQ = { symbol: 'MNQZ6', tickSize: 0.25, pointValue: 2 };
const quote = { bid: 100, ask: 100.25 };
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

const draft = (patch: Partial<TicketDraft> = {}): TicketDraft => ({
  side: 'buy', type: 'limit', price: 95, sizing: 'qty', quantity: 2, riskUsd: 200, stopLoss: null, takeProfit: null, ...patch,
});

const onTick = (price: number, tick = 0.25) => Math.abs(price / tick - Math.round(price / tick)) < 1e-9;

describe('vestavěná šablona = dosavadní 12 b / 2R', () => {
  it('nový návrh s vestavěnou šablonou je přesně newTicketDraft (long i short, limit i market)', () => {
    for (const side of ['buy', 'sell'] as const) {
      for (const type of ['limit', 'market'] as const) {
        const base = { sizing: 'risk' as const, quantity: 3, riskUsd: 150 };
        const expected = newTicketDraft(side, type, 95, MNQ, quote, base);
        const result = liveTemplateTicketDraft(side, type, 95, MNQ, quote, LIVE_BUILTIN_BRACKET_TEMPLATE, base);
        expect(result.draft).toEqual(expected);
        expect(result.skipped).toBeNull();
      }
    }
    // Konkrétní čísla: long limit 95 → SL 83, TP 119; velikost zůstala z panelu.
    const long = liveTemplateTicketDraft('buy', 'limit', 95, MNQ, quote, LIVE_BUILTIN_BRACKET_TEMPLATE).draft;
    expect(long).toMatchObject({ stopLoss: 83, takeProfit: 119, sizing: 'qty', quantity: 1 });
  });

  it('bez ★ je výchozí vestavěná; ★ na smazanou šablonu spadne zpět na vestavěnou', () => {
    expect(defaultLiveBracketTemplate(emptyLiveBracketTemplateLibrary()).id).toBe(LIVE_BUILTIN_TEMPLATE_ID);
    const lib: LiveBracketTemplateLibrary = { templates: [template()], defaultId: 'tpl-scalp' };
    expect(defaultLiveBracketTemplate(lib).id).toBe('tpl-scalp');
    expect(defaultLiveBracketTemplate({ templates: [], defaultId: 'tpl-scalp' }).id).toBe(LIVE_BUILTIN_TEMPLATE_ID);
    expect(liveTemplateSummary(LIVE_BUILTIN_BRACKET_TEMPLATE)).toBe('12 b / 2R');
  });
});

describe('vzdálenost → ceny podle strany a vstupu', () => {
  it('ticky: long SL pod vstupem a TP nad, short obráceně', () => {
    expect(liveTemplateBracketPrices(template(), 'buy', 100, 0.25)).toEqual({ stopLoss: 97, takeProfit: 106, stopTicks: 12, targetTicks: 24 });
    expect(liveTemplateBracketPrices(template(), 'sell', 100, 0.25)).toEqual({ stopLoss: 103, takeProfit: 94, stopTicks: 12, targetTicks: 24 });
  });

  it('R = násobek vzdálenosti SL', () => {
    const swing = template({ stopLoss: { unit: 'ticks', value: 40 }, takeProfit: { unit: 'r', value: 2 } });
    expect(liveTemplateBracketPrices(swing, 'buy', 100, 0.25)).toMatchObject({ stopLoss: 90, takeProfit: 120, targetTicks: 80 });
    expect(liveTemplateBracketPrices(swing, 'sell', 100, 0.25)).toMatchObject({ stopLoss: 110, takeProfit: 80 });
    const odd = template({ stopLoss: { unit: 'ticks', value: 13 }, takeProfit: { unit: 'r', value: 1.5 } });
    // 13 × 1,5 = 19,5 → 20 ticků (celé ticky, nikdy mezi nimi).
    expect(liveTemplateBracketPrices(odd, 'buy', 100, 0.25)?.targetTicks).toBe(20);
  });

  it('body se převedou na celé ticky a výsledek je vždy na ticku', () => {
    const pts = template({ stopLoss: { unit: 'pts', value: 10.1 }, takeProfit: { unit: 'pts', value: 20 } });
    expect(liveTemplateBracketPrices(pts, 'buy', 100.25, 0.25)).toMatchObject({ stopLoss: 90.25, takeProfit: 120.25, stopTicks: 40 });
    // Vstup mimo tick (kotace) — ceny se zarovnají.
    const off = liveTemplateBracketPrices(template(), 'buy', 100.13, 0.25)!;
    expect(onTick(off.stopLoss)).toBe(true);
    expect(onTick(off.takeProfit!)).toBe(true);
    // Drobná vzdálenost v bodech dá aspoň 1 tick — SL nikdy na vstupu.
    const tiny = liveTemplateBracketPrices(template({ stopLoss: { unit: 'pts', value: 0.05 } }), 'buy', 100, 0.25)!;
    expect(tiny.stopLoss).toBe(99.75);
  });

  it('neplatný vstup nebo tick = žádné ceny', () => {
    expect(liveTemplateBracketPrices(template(), 'buy', Number.NaN, 0.25)).toBeNull();
    expect(liveTemplateBracketPrices(template(), 'buy', 100, 0)).toBeNull();
  });

  it('Market bere vstup ze strany trhu panelu (ask u nákupu, bid u prodeje)', () => {
    const buy = applyLiveBracketTemplate(draft({ type: 'market' }), template(), MNQ, quote).draft;
    expect(buy).toMatchObject({ stopLoss: 97.25, takeProfit: 106.25 });
    const sell = applyLiveBracketTemplate(draft({ type: 'market', side: 'sell' }), template(), MNQ, quote).draft;
    expect(sell).toMatchObject({ stopLoss: 103, takeProfit: 94 });
  });
});

describe('kdy se šablona nepoužije', () => {
  it('přikoupení na stranu otevřené pozice šablonu ignoruje (platí SL/TP pozice)', () => {
    const base = draft({ stopLoss: 80, takeProfit: 130 });
    const result = applyLiveBracketTemplate(base, template({ sizing: { mode: 'qty', quantity: 3 } }), MNQ, quote, { scaleIn: { side: 'buy' } });
    expect(result.skipped).toBe('scale-in');
    expect(result.applied).toBe(false);
    expect(result.draft).toBe(base);
    // Opačná strana není přikoupení — šablona platí (worker vstup proti pozici stejně zastaví).
    const opposite = applyLiveBracketTemplate(base, template(), MNQ, quote, { scaleIn: { side: 'sell' } });
    expect(opposite.skipped).toBeNull();
    expect(opposite.draft).toMatchObject({ stopLoss: 92, takeProfit: 101 });
  });

  it('⚡ z position boxu bere SL/TP z boxu, ne ze šablony', () => {
    const base = draft({ stopLoss: 80, takeProfit: 130 });
    const result = applyLiveBracketTemplate(base, template(), MNQ, quote, { fromPositionBox: true });
    expect(result).toMatchObject({ skipped: 'position-box', applied: false });
    expect(result.draft).toBe(base);
  });

  it('nový návrh při přikoupení nechá výchozí závorky pro livePhoneScaleInDraft', () => {
    const result = liveTemplateTicketDraft('buy', 'limit', 95, MNQ, quote, template(), undefined, { scaleIn: { side: 'buy' } });
    expect(result.skipped).toBe('scale-in');
    expect(result.draft).toEqual(newTicketDraft('buy', 'limit', 95, MNQ, quote));
  });
});

describe('Přidat SL/TP (jen chybějící)', () => {
  it('existující SL se nemění a TP v R se počítá ke skutečnému SL', () => {
    const base = draft({ price: 100, stopLoss: 95 }); // 20 ticků riziko
    const result = applyLiveBracketTemplate(base, template({ takeProfit: { unit: 'r', value: 2 } }), MNQ, quote, { onlyMissing: true });
    expect(result.draft.stopLoss).toBe(95);
    expect(result.draft.takeProfit).toBe(110);
  });

  it('nic nechybí = nic se nezmění; velikost se s onlyMissing nikdy nepřebírá', () => {
    const full = draft({ stopLoss: 90, takeProfit: 100 });
    expect(applyLiveBracketTemplate(full, template(), MNQ, quote, { onlyMissing: true })).toMatchObject({ applied: false, draft: full });
    const sized = applyLiveBracketTemplate(draft(), template({ sizing: { mode: 'qty', quantity: 4 } }), MNQ, quote, { onlyMissing: true }).draft;
    expect(sized.quantity).toBe(2);
    expect(sized).toMatchObject({ stopLoss: 92, takeProfit: 101 });
  });
});

describe('velikost ze šablony', () => {
  it('kontrakty se nad strop účtu nezvednou (jen dolů, s poznámkou)', () => {
    const result = applyLiveBracketTemplate(draft(), template({ sizing: { mode: 'qty', quantity: 3 } }), MNQ, quote, { maxContracts: 1 });
    expect(result.draft).toMatchObject({ sizing: 'qty', quantity: 1 });
    expect(result.notes).toHaveLength(1);
    const within = applyLiveBracketTemplate(draft(), template({ sizing: { mode: 'qty', quantity: 3 } }), MNQ, quote, { maxContracts: 5 });
    expect(within.draft.quantity).toBe(3);
    expect(within.notes).toEqual([]);
  });

  it('riziko v $ přepne panel na velikost podle rizika; null nechá panel', () => {
    expect(applyLiveBracketTemplate(draft(), template({ sizing: { mode: 'risk', riskUsd: 120 } }), MNQ, quote).draft)
      .toMatchObject({ sizing: 'risk', riskUsd: 120, quantity: 2 });
    expect(applyLiveBracketTemplate(draft(), template(), MNQ, quote).draft).toMatchObject({ sizing: 'qty', quantity: 2, riskUsd: 200 });
    expect(applyLiveBracketTemplate(draft(), template({ sizing: { mode: 'qty', quantity: 3 } }), MNQ, quote, { applySizing: false }).draft.quantity).toBe(2);
  });
});

describe('varování Marketu pod 16 ticků', () => {
  it('limit je stejný jako brána workeru', () => {
    expect(LIVE_TEMPLATE_MARKET_MIN_BRACKET_TICKS).toBe(MANUAL_ENTRY_MARKET_MIN_BRACKET_TICKS);
    expect(LIVE_TEMPLATE_MARKET_MIN_BRACKET_TICKS).toBe(16);
  });

  it('šablona: SL nebo TP pod 16 ticků varuje, přesně 16 ne', () => {
    expect(liveTemplateMarketWarning(template(), 0.25)).toMatch(/16 ticků/);
    expect(liveTemplateMarketWarning(template({ stopLoss: { unit: 'ticks', value: 16 }, takeProfit: { unit: 'ticks', value: 16 } }), 0.25)).toBeNull();
    expect(liveTemplateMarketWarning(template({ stopLoss: { unit: 'ticks', value: 40 }, takeProfit: { unit: 'r', value: 0.25 } }), 0.25)).not.toBeNull();
    expect(liveTemplateMarketWarning(template({ stopLoss: { unit: 'ticks', value: 15 }, takeProfit: null }), 0.25)).not.toBeNull();
    expect(liveTemplateMarketWarning(LIVE_BUILTIN_BRACKET_TEMPLATE, 0.25)).toBeNull();
  });

  it('návrh: jen Market se SL/TP; hranice 16 ticků od ceny trhu', () => {
    // ask 100.25: SL 96.50 = 15 ticků → varování; 96.25 = 16 ticků → ne.
    const market = (stopLoss: number | null, takeProfit: number | null) => draft({ type: 'market', stopLoss, takeProfit });
    expect(liveMarketBracketDistanceProblem(market(96.5, 110), MNQ, quote)).toMatchObject({ level: 'warning' });
    expect(liveMarketBracketDistanceProblem(market(96.25, 104.25), MNQ, quote)).toBeNull();
    expect(liveMarketBracketDistanceProblem(market(90, 104), MNQ, quote)).not.toBeNull();
    expect(liveMarketBracketDistanceProblem(market(null, null), MNQ, quote)).toBeNull();
    expect(liveMarketBracketDistanceProblem(draft({ stopLoss: 94, takeProfit: 96 }), MNQ, quote)).toBeNull();
  });
});

describe('Uložit jako šablonu', () => {
  it('ukládá jen vzdálenosti v ticích — žádnou cenu (INV-UI-04)', () => {
    const result = liveTemplateFromDraft(draft({ price: 100, stopLoss: 97, takeProfit: 106 }), MNQ, quote, { name: ' Scalp ', id: 'tpl-a', now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template).toEqual({
      id: 'tpl-a', name: 'Scalp', stopLoss: { unit: 'ticks', value: 12 }, takeProfit: { unit: 'ticks', value: 24 },
      sizing: { mode: 'qty', quantity: 2 }, updatedAt: NOW.toISOString(),
    });
    expect(JSON.stringify(result.template)).not.toMatch(/97|106|100/);
  });

  it('TP v R a body; zpětné použití dá stejné ceny i zrcadlově pro short', () => {
    const long = draft({ price: 100, stopLoss: 90, takeProfit: 120 });
    const r = liveTemplateFromDraft(long, MNQ, quote, { name: 'Swing', targetUnit: 'r', stopUnit: 'pts', includeSizing: false, id: 'tpl-s', now: NOW });
    expect(r.ok && r.template).toMatchObject({ stopLoss: { unit: 'pts', value: 10 }, takeProfit: { unit: 'r', value: 2 }, sizing: null });
    if (!r.ok) return;
    expect(applyLiveBracketTemplate({ ...long, stopLoss: null, takeProfit: null }, r.template, MNQ, quote).draft).toMatchObject({ stopLoss: 90, takeProfit: 120 });
    expect(applyLiveBracketTemplate(draft({ side: 'sell', price: 100 }), r.template, MNQ, quote).draft).toMatchObject({ stopLoss: 110, takeProfit: 80 });
  });

  it('Market měří vzdálenost od strany trhu panelu', () => {
    const result = liveTemplateFromDraft(draft({ type: 'market', stopLoss: 97.25, takeProfit: 106.25 }), MNQ, quote, { name: 'M', id: 'tpl-m', now: NOW });
    expect(result.ok && result.template.stopLoss).toEqual({ unit: 'ticks', value: 12 });
  });

  it('bez SL nebo se závorkou na špatné straně se šablona neuloží', () => {
    expect(liveTemplateFromDraft(draft({ stopLoss: null, takeProfit: 110 }), MNQ, quote, { name: 'X' }).ok).toBe(false);
    expect(liveTemplateFromDraft(draft({ stopLoss: 96, takeProfit: 110 }), MNQ, quote, { name: 'X' }).ok).toBe(false);
    expect(liveTemplateFromDraft(draft({ stopLoss: 90, takeProfit: 94 }), MNQ, quote, { name: 'X' }).ok).toBe(false);
    expect(liveTemplateFromDraft(draft({ stopLoss: 90, takeProfit: 100 }), MNQ, quote, { name: '  ' }).ok).toBe(false);
  });
});

describe('sanitize a validace', () => {
  const valid = { id: 'tpl-1', name: 'Scalp', stopLoss: { unit: 'ticks', value: 12 }, takeProfit: { unit: 'r', value: 2 }, sizing: null, updatedAt: NOW.toISOString() };

  it('platnou šablonu převezme beze změny čísel', () => {
    expect(sanitizeLiveBracketTemplate(valid)).toEqual(valid);
  });

  it('cena ani $ do šablony nesmí (INV-UI-04) a SL je povinný', () => {
    expect(sanitizeLiveBracketTemplate({ ...valid, stopLoss: { unit: 'price', value: 21000 } })).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, takeProfit: { unit: 'price', value: 21050 } })).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, stopLoss: { unit: 'usd', value: 50 } })).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, stopLoss: { unit: 'r', value: 1 } })).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, stopLoss: null })).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, stopLoss: undefined })).toBeNull();
  });

  it('poškozená čísla šablonu celou odmítnou (nic se „neopraví“ na jiné SL)', () => {
    expect(sanitizeLiveBracketTemplate({ ...valid, stopLoss: { unit: 'ticks', value: 12.5 } })).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, stopLoss: { unit: 'ticks', value: 0 } })).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, stopLoss: { unit: 'ticks', value: '12' } })).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, stopLoss: { unit: 'pts', value: -3 } })).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, stopLoss: { unit: 'pts', value: Number.POSITIVE_INFINITY } })).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, takeProfit: { unit: 'r', value: 0 } })).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, sizing: { mode: 'qty', quantity: 1.5 } })).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, sizing: { mode: 'qty', quantity: 500 } })).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, sizing: { mode: 'risk', riskUsd: 0 } })).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, sizing: { mode: 'contracts', value: 1 } })).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, id: LIVE_BUILTIN_TEMPLATE_ID })).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, id: 'a b' })).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, name: '' })).toBeNull();
    expect(sanitizeLiveBracketTemplate('nonsense')).toBeNull();
    expect(sanitizeLiveBracketTemplate({ ...valid, takeProfit: null })).toMatchObject({ takeProfit: null });
  });

  it('knihovna: neplatné vypadnou, duplicitní id/název bere první, ★ jen na existující, nejvýš 12', () => {
    const lib = sanitizeLiveBracketTemplateLibrary({
      templates: [valid, { ...valid, name: 'Jiná' }, { ...valid, id: 'tpl-2', name: 'scalp' }, { ...valid, id: 'tpl-3', stopLoss: { unit: 'price', value: 1 } }, 42],
      defaultId: 'tpl-3',
    });
    expect(lib.templates.map(t => t.id)).toEqual(['tpl-1']);
    expect(lib.defaultId).toBeNull();
    const many = sanitizeLiveBracketTemplateLibrary({
      templates: Array.from({ length: 20 }, (_, i) => ({ ...valid, id: `tpl-${i}`, name: `T${i}` })),
      defaultId: 'tpl-3',
    });
    expect(many.templates).toHaveLength(LIVE_TEMPLATE_MAX_COUNT);
    expect(many.defaultId).toBe('tpl-3');
    expect(sanitizeLiveBracketTemplateLibrary(null)).toEqual({ templates: [], defaultId: null });
  });

  it('formulář vrací české chyby', () => {
    const input: LiveBracketTemplateInput = { name: '', stopLoss: { unit: 'ticks', value: 0 }, takeProfit: { unit: 'r', value: 50 }, sizing: { mode: 'qty', quantity: 0 } };
    expect(validateLiveBracketTemplate(input)).toHaveLength(4);
    expect(createLiveBracketTemplate(input).ok).toBe(false);
    const ok = createLiveBracketTemplate({ ...input, name: 'A', stopLoss: { unit: 'ticks', value: 20 }, takeProfit: { unit: 'r', value: 2 }, sizing: null }, { id: 'tpl-x', now: NOW });
    expect(ok).toEqual({ ok: true, template: expect.objectContaining({ id: 'tpl-x', name: 'A' }) });
  });
});

describe('knihovna šablon', () => {
  const scalp = template();
  const swing = template({ id: 'tpl-swing', name: 'Swing', stopLoss: { unit: 'ticks', value: 40 }, takeProfit: { unit: 'r', value: 2 } });

  it('uloží novou, přepíše stejný název (id i ★ zůstanou) a nedovolí přejmenovat na cizí název', () => {
    let lib: LiveBracketTemplateLibrary = { templates: [scalp], defaultId: 'tpl-scalp' };
    const added = upsertLiveBracketTemplate(lib, swing);
    expect(added.ok && added.library.templates.map(t => t.id)).toEqual(['tpl-scalp', 'tpl-swing']);
    if (!added.ok) return;
    lib = added.library;
    const overwrite = upsertLiveBracketTemplate(lib, template({ id: 'tpl-new', name: 'SCALP', stopLoss: { unit: 'ticks', value: 20 } }));
    expect(overwrite.ok && overwrite.library.templates[0]).toMatchObject({ id: 'tpl-scalp', name: 'SCALP', stopLoss: { value: 20 } });
    expect(overwrite.ok && overwrite.library.defaultId).toBe('tpl-scalp');
    expect(upsertLiveBracketTemplate(lib, { ...swing, name: 'scalp' }).ok).toBe(false);
    expect(upsertLiveBracketTemplate(lib, { ...swing, stopLoss: { unit: 'price' as never, value: 1 } }).ok).toBe(false);
  });

  it('víc než 12 šablon nejde', () => {
    const full: LiveBracketTemplateLibrary = {
      templates: Array.from({ length: LIVE_TEMPLATE_MAX_COUNT }, (_, i) => template({ id: `tpl-${i}`, name: `T${i}` })),
      defaultId: null,
    };
    expect(upsertLiveBracketTemplate(full, template({ id: 'tpl-extra', name: 'Extra' })).ok).toBe(false);
    expect(upsertLiveBracketTemplate(full, template({ id: 'tpl-3', name: 'T3', stopLoss: { unit: 'ticks', value: 30 } })).ok).toBe(true);
  });

  it('smazání výchozí vrátí ★ na vestavěnou; vestavěnou smazat nejde', () => {
    const lib: LiveBracketTemplateLibrary = { templates: [scalp, swing], defaultId: 'tpl-swing' };
    const removed = removeLiveBracketTemplate(lib, 'tpl-swing');
    expect(removed.ok && removed.library).toEqual({ templates: [scalp], defaultId: null });
    expect(removeLiveBracketTemplate(lib, LIVE_BUILTIN_TEMPLATE_ID).ok).toBe(false);
    expect(removeLiveBracketTemplate(lib, 'tpl-missing').ok).toBe(false);
  });

  it('★ jen na existující šablonu nebo vestavěnou', () => {
    const lib: LiveBracketTemplateLibrary = { templates: [scalp], defaultId: null };
    expect(setDefaultLiveBracketTemplate(lib, 'tpl-scalp')).toEqual({ ok: true, library: { templates: [scalp], defaultId: 'tpl-scalp' } });
    expect(setDefaultLiveBracketTemplate(lib, 'tpl-missing').ok).toBe(false);
    expect(setDefaultLiveBracketTemplate({ ...lib, defaultId: 'tpl-scalp' }, LIVE_BUILTIN_TEMPLATE_ID)).toEqual({ ok: true, library: { templates: [scalp], defaultId: null } });
    expect(findLiveBracketTemplate(lib, LIVE_BUILTIN_TEMPLATE_ID)).toBe(LIVE_BUILTIN_BRACKET_TEMPLATE);
  });

  it('čipy: vestavěná první, ★ u výchozí, popisky a varování Marketu', () => {
    const choices = liveBracketTemplateChoices({ templates: [scalp, swing], defaultId: 'tpl-swing' }, 0.25);
    expect(choices.map(c => [c.label, c.isDefault, c.builtIn, c.marketWarning != null])).toEqual([
      ['Výchozí 12 b / 2R', false, true, false],
      ['Scalp 12/24 t', false, false, true],
      ['Swing 40 t / 2R', true, false, false],
    ]);
    expect(liveTemplateSummary(template({ takeProfit: null }))).toBe('12 t / bez TP');
    expect(liveTemplateSummary(template({ takeProfit: { unit: 'pts', value: 6 } }))).toBe('12 t / 6 b');
  });
});
