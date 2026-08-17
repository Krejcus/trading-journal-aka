import type { Drawing } from '@getcandlekit/charts';

interface DrawingSyncEngine {
  getDrawings: () => readonly Drawing[];
  import: (json: string) => void;
  onChange: (listener: () => void) => () => void;
  /** Rozkreslená kresba, dokud ji uživatel nedokončí. */
  getDraft?: () => Drawing | null;
  getById?: (id: string) => Drawing | undefined;
  setPoints?: (id: string, points: Drawing['points']) => void;
  remove?: (id: string) => void;
}

/**
 * Náhled cizí rozkreslené kresby. Prefix `auto-` ho drží mimo synchronizaci
 * manuálních kreseb i mimo snapshot workspace, takže se nikdy neuloží jako
 * skutečná kresba uživatele.
 */
export const DRAFT_PREVIEW_ID = 'auto-draft-preview';

const isManualDrawing = (drawing: Drawing) => !drawing.id.startsWith('auto-');
const manualDrawings = (engine: DrawingSyncEngine) => engine.getDrawings().filter(isManualDrawing);
const automaticDrawings = (engine: DrawingSyncEngine) => engine.getDrawings().filter(drawing => !isManualDrawing(drawing));
/**
 * Otisk kresby je rozdělený na body a zbytek: tažení mění jen body, a přesně
 * to rozhoduje mezi levným `setPoints` a plným importem. `intervalSeconds`
 * u pozic je vlastnost panelu, ne kresby — každý si ji srovnává na svůj
 * timeframe (viz `applyPositionRuntimeInterval`). Kdyby ji otisk zahrnoval,
 * panely by si tu úpravu donekonečna přeposílaly a přepisovaly jeden druhému.
 */
interface DrawingSignature {
  points: string;
  rest: string;
}

type SignatureMap = Map<string, DrawingSignature>;

const signatureOf = (drawing: Drawing): DrawingSignature => {
  const { points, ...rest } = drawing;
  return {
    points: JSON.stringify(points),
    rest: JSON.stringify(rest, (key, value) => key === 'intervalSeconds' ? undefined : value),
  };
};

const signaturesOf = (drawings: readonly Drawing[]): SignatureMap =>
  new Map(drawings.map(drawing => [drawing.id, signatureOf(drawing)]));

const sameSignatures = (left: SignatureMap, right: SignatureMap): boolean =>
  left.size === right.size && [...left].every(([id, signature]) => {
    const other = right.get(id);
    return Boolean(other) && other!.points === signature.points && other!.rest === signature.rest;
  });

const cloneDrawings = (drawings: readonly Drawing[]): Drawing[] => JSON.parse(JSON.stringify(drawings)) as Drawing[];

const mergedInitialManualDrawings = (engines: readonly DrawingSyncEngine[]) => {
  const byId = new Map<string, Drawing>();
  engines.forEach(engine => {
    manualDrawings(engine).forEach(drawing => {
      if (!byId.has(drawing.id)) byId.set(drawing.id, drawing);
    });
  });
  return cloneDrawings([...byId.values()]);
};

/**
 * Keeps manual drawings identical across every chart in a workspace while
 * leaving per-chart generated overlays (`auto-*`) untouched.
 *
 * Drawing points are stored in timestamp/price space, so the same drawing can
 * be rendered correctly on panels with different timeframes or symbols.
 */
/**
 * Plánovač sync reakce. Pointer generuje až 120 událostí za sekundu, ale
 * obrazovka jich zobrazí nejvýš 60 — zrcadlit každou znamená platit celý
 * řetěz posluchačů na cílových enginech dvakrát častěji, než je vidět.
 * V prohlížeči se proto reakce koalescuje na jeden snímek (zrcadlí se vždy
 * poslední stav); bez `requestAnimationFrame` (testy v node) běží hned.
 *
 * Samotný rAF ale nestačí: Chromium ho v zakrytém či pozadovém okně škrtí
 * klidně na nulu, a protože další flush se plánuje až po doběhnutí toho
 * předchozího, jediný nevyřízený rAF držel celé zrcadlení zamrzlé — náhled
 * kresby na ostatních panelech zůstal viset v bodě prvního kliknutí.
 * Časovač je pojistka, která flush pustí, i když snímky nechodí.
 */
const defaultSyncSchedule = (flush: () => void): (() => void) => {
  if (typeof requestAnimationFrame !== 'function') {
    flush();
    return () => undefined;
  }
  let settled = false;
  let frame = 0;
  let timer = 0;
  const run = () => {
    if (settled) return;
    settled = true;
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    flush();
  };
  frame = requestAnimationFrame(run);
  timer = window.setTimeout(run, 32);
  return () => {
    settled = true;
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
};

export const installWorkspaceDrawingSync = (
  sourceEngines: readonly DrawingSyncEngine[],
  schedule: (flush: () => void) => (() => void) = defaultSyncSchedule,
): (() => void) => {
  const engines = [...new Set(sourceEngines)];
  if (engines.length < 2) return () => undefined;

  let synchronizing = false;
  const previous = new Map<DrawingSyncEngine, SignatureMap>();

  const applyManualDrawings = (target: DrawingSyncEngine, drawings: readonly Drawing[], sourceSignatures: SignatureMap) => {
    if (sameSignatures(signaturesOf(manualDrawings(target)), sourceSignatures)) return;
    target.import(JSON.stringify([
      ...cloneDrawings(automaticDrawings(target)),
      ...cloneDrawings(drawings),
    ]));
  };

  const clearDraftPreview = (target: DrawingSyncEngine) => {
    if (target.getById?.(DRAFT_PREVIEW_ID)) target.remove?.(DRAFT_PREVIEW_ID);
  };

  /**
   * Zrcadlí rozkreslenou kresbu do ostatních panelů, aby uživatel viděl průběh,
   * ne až hotový výsledek. Náhled se přidává přes `import` (aby si cílový panel
   * udržel svůj výběr) a dál se posouvá jen po bodech.
   */
  const applyDraftPreview = (target: DrawingSyncEngine, draft: Drawing) => {
    const existing = target.getById?.(DRAFT_PREVIEW_ID);
    if (existing && existing.tool === draft.tool) {
      target.setPoints?.(DRAFT_PREVIEW_ID, cloneDrawings([draft])[0].points);
      return;
    }
    const preview = { ...cloneDrawings([draft])[0], id: DRAFT_PREVIEW_ID };
    target.import(JSON.stringify([
      ...cloneDrawings(target.getDrawings()).filter(item => item.id !== DRAFT_PREVIEW_ID),
      preview,
    ]));
  };

  // Enabling sync must not silently discard drawings that were created while
  // panels were independent. Merge every unique id once, then switch to exact
  // source-of-change mirroring for edits and deletes.
  // Náhled po přerušeném kreslení (zavřená záložka, remount) nesmí přežít:
  // je to `auto-` kresba, takže by ji jinak žádná další synchronizace neuklidila.
  engines.forEach(clearDraftPreview);
  const initial = mergedInitialManualDrawings(engines);
  const initialSignatures = signaturesOf(initial);
  synchronizing = true;
  try {
    engines.forEach(engine => applyManualDrawings(engine, initial, initialSignatures));
  } finally {
    synchronizing = false;
  }
  engines.forEach(engine => previous.set(engine, signaturesOf(manualDrawings(engine))));

  // Kdo právě kreslí. Bez toho by panel s náhledem sám hlásil „žádný draft"
  // a náhledy by si panely navzájem mazaly.
  let draftOwner: DrawingSyncEngine | null = null;

  let cancelScheduled: (() => void) | null = null;
  const queued = new Set<DrawingSyncEngine>();

  const handleChange = (source: DrawingSyncEngine) => {
    const draft = source.getDraft?.() ?? null;
    if (draft || draftOwner === source) {
      synchronizing = true;
      try {
        draftOwner = draft ? source : null;
        engines.forEach(target => {
          if (target === source) return;
          if (draft) applyDraftPreview(target, draft);
          else clearDraftPreview(target);
        });
      } finally {
        synchronizing = false;
      }
    }

    const sourceDrawings = manualDrawings(source);
    const nextSignatures = signaturesOf(sourceDrawings);
    const previousSignatures = previous.get(source);
    if (previousSignatures && sameSignatures(previousSignatures, nextSignatures)) return;

    // Tažení kresby emituje change na každý pohyb myši a mění JEN body.
    // Plný import do všech ostatních panelů (serializace kompletní sady +
    // rebuild engine) na každý pohyb byl hlavní zdroj sekání — `setPoints`
    // je O(kresba), nechá cílovému panelu výběr i pořadí a stojí zlomek.
    if (previousSignatures && previousSignatures.size === nextSignatures.size) {
      const restUnchanged = [...nextSignatures]
        .every(([id, signature]) => previousSignatures.get(id)?.rest === signature.rest);
      if (restUnchanged) {
        const changed = sourceDrawings
          .filter(item => previousSignatures.get(item.id)!.points !== nextSignatures.get(item.id)!.points);
        const applicable = changed.length > 0 && engines.every(target => target === source
          || (Boolean(target.setPoints) && Boolean(target.getById)
            && changed.every(item => target.getById!(item.id))));
        if (applicable) {
          synchronizing = true;
          try {
            changed.forEach(item => {
              const points = cloneDrawings([item])[0].points;
              engines.forEach(target => {
                if (target !== source) target.setPoints!(item.id, points);
              });
            });
          } finally {
            synchronizing = false;
          }
          engines.forEach(engine => previous.set(engine, new Map(nextSignatures)));
          return;
        }
      }
    }

    synchronizing = true;
    try {
      engines.forEach(target => {
        if (target !== source) applyManualDrawings(target, sourceDrawings, nextSignatures);
      });
      engines.forEach(engine => previous.set(engine, signaturesOf(manualDrawings(engine))));
    } finally {
      synchronizing = false;
    }
  };

  const cleanups = engines.map(source => source.onChange(() => {
    if (synchronizing) return;
    queued.add(source);
    if (cancelScheduled !== null) return;
    // Synchronní plánovač (testy) spustí flush ještě před přiřazením —
    // příznak drží rozlišení, jestli se cancel má vůbec uložit.
    let finished = false;
    const cancel = schedule(() => {
      finished = true;
      cancelScheduled = null;
      const sources = [...queued];
      queued.clear();
      sources.forEach(item => {
        // Výjimka z jednoho zdroje nesmí zabít zrcadlení ostatních ani celou
        // instanci — bez záchytu by zůstala synchronizace navždy mrtvá.
        try {
          handleChange(item);
        } catch (error) {
          console.error('[DrawingSync] zrcadlení selhalo', error);
        }
      });
    });
    cancelScheduled = finished ? null : cancel;
  }));

  return () => {
    cancelScheduled?.();
    cancelScheduled = null;
    queued.clear();
    cleanups.forEach(cleanup => cleanup());
    engines.forEach(clearDraftPreview);
  };
};
